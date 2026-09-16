/**
 * Tasks — creating, moving, finishing, and the reminder before one starts.
 *
 * Both doors call this: the admin panel and the v1 API. What a person may do
 * comes from their scope, not from the route:
 *   · task.view / .manage   — their own work, on files assigned to them;
 *   · task.view_all         — everybody's;
 *   · task.manage_all       — making work for somebody else, which is what an
 *     admin does when they pick a client and the task lands with whoever that
 *     client belongs to.
 *
 * Every change keeps the rest of the CRM in step:
 *   · the file's `next_task_at` — what the pipeline and the staleness rules
 *     read — is recomputed by the same statement that changed the task;
 *   · the owner is told: the bell, the live event stream, and an email
 *     fifteen minutes before it starts;
 *   · the audit trail and therefore the activity log record who made work for
 *     whom, and who finished it.
 */
import { z } from 'zod';
import { env } from '../config/env.ts';
import { query, queryOne, withTransaction, type Queryable } from '../db/pool.ts';
import {
  CATEGORY_KEYS, categoryLabel, dueBucket, dueInstant, isOpen, isValidZone,
  MAX_DESCRIPTION, MAX_TITLE, ownerFor, PRIORITY_KEYS, priorityLabel,
  REMINDER_MINUTES, reminderInstant, reminderSubject, scheduleRefusal, shouldRemind, STATUS_KEYS,
  statusLabel, titleRefusal, transitionRefusal, type DueBucket, type FileOwner,
} from '../domain/tasks.ts';
import { formatDay, formatTime } from '../domain/appointments.ts';
import { textToHtml } from '../domain/signature.ts';
import { AppError, fieldError, notFound } from '../http/middleware/errors.ts';
import { sendEmail } from '../integrations/email.ts';
import { log } from '../lib/logger.ts';
import { recordAudit } from './audit.ts';
import { publish } from './realtime.ts';
import type { Actor } from './staff.ts';

export type Scope = {
  actor: Actor;
  viewAll: boolean;
  manage: boolean;
  manageAll: boolean;
  timezone?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const auditActor = (a: Actor) => ({
  userId: a.userId, name: a.name, role: a.role ?? null, kind: a.kind, ip: a.ip ?? null,
});

const me = (scope: Scope): string => {
  if (!scope.actor.userId) throw new AppError('Tasks belong to people, so this needs a signed-in user.', 403, 'forbidden');
  return scope.actor.userId;
};

async function orgZone(organizationId: string): Promise<string> {
  const org = await queryOne<{ timezone: string | null }>(
    'SELECT timezone FROM organizations WHERE id = $1', [organizationId]);
  return org?.timezone && isValidZone(org.timezone) ? org.timezone : env.BROKERAGE_TIMEZONE;
}

/** A person's own zone wins over the brokerage's — 4:30 means their 4:30. */
const zoneOf = async (scope: Scope) =>
  (scope.timezone && isValidZone(scope.timezone) ? scope.timezone : orgZone(scope.actor.organizationId));

// ── Reading ────────────────────────────────────────────────────────────────

// Split rather than one string, so a caller can add a column (the window
// count) or change the leading clause without a `.replace()` that depends on
// the exact spelling of the first line.
const COLUMNS = `
         t.id, t.title, t.description, t.category, t.priority, t.status,
         t.due_on, t.due_time, t.due_at, t.timezone, t.reminder_minutes, t.reminder_sent_at,
         t.completed_at, t.cancelled_reason, t.created_at, t.updated_at, t.source_kind,
         t.application_id, t.customer_id,
         trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS client_name,
         app.portal_reference, app.stage_key, ps.label AS stage_label, pl.name AS pipeline_name,
         t.created_by, cb.name AS created_by_name,
         t.completed_by, fb.name AS completed_by_name,
         owner.user_id AS owner_id, owner.name AS owner_name, owner.email AS owner_email`;

const FROM = `
    FROM tasks t
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN applications app ON app.id = t.application_id
    LEFT JOIN pipeline_stages ps ON ps.organization_id = t.organization_id AND ps.key = app.stage_key
    LEFT JOIN pipelines pl ON pl.id = app.pipeline_id
    LEFT JOIN users cb ON cb.id = t.created_by
    LEFT JOIN users fb ON fb.id = t.completed_by
    LEFT JOIN LATERAL (
      SELECT u.id AS user_id, u.name, u.email
        FROM task_assignees ta JOIN users u ON u.id = ta.user_id
       WHERE ta.task_id = t.id
       ORDER BY ta.assigned_at LIMIT 1
    ) owner ON true`;

const SELECT = `SELECT ${COLUMNS} ${FROM}`;

type TaskRow = {
  id: string; title: string; description: string | null; category: string; priority: string;
  status: string; due_on: string | Date | null; due_time: string | null; due_at: Date | null;
  timezone: string | null; reminder_minutes: number | null; reminder_sent_at: Date | null;
  completed_at: Date | null; cancelled_reason: string | null; created_at: Date; updated_at: Date;
  source_kind: string; application_id: string | null; customer_id: string | null;
  client_name: string | null; portal_reference: string | null; stage_key: string | null;
  stage_label: string | null; pipeline_name: string | null;
  created_by: string | null; created_by_name: string | null;
  completed_by: string | null; completed_by_name: string | null;
  owner_id: string | null; owner_name: string | null; owner_email: string | null;
};

export type Task = ReturnType<typeof shape>;

/** Postgres hands a DATE back as a Date in this driver; the wire format is the calendar date. */
const isoDate = (value: string | Date | null): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};

const shape = (r: TaskRow, scope: Scope, zone: string, now = new Date()) => {
  const due_on = isoDate(r.due_on);
  const taskZone = r.timezone && isValidZone(r.timezone) ? r.timezone : zone;
  const bucket = dueBucket({ due_on, due_at: r.due_at, status: r.status }, now, taskZone);
  const mine = r.owner_id === scope.actor.userId;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    category_label: categoryLabel(r.category),
    priority: r.priority,
    priority_label: priorityLabel(r.priority),
    status: r.status,
    status_label: statusLabel(r.status),
    open: isOpen(r.status),
    due_on,
    due_time: r.due_time ? r.due_time.slice(0, 5) : null,
    due_at: r.due_at?.toISOString() ?? null,
    timezone: taskZone,
    /** "Thursday, September 18, 2026 at 4:30 p.m. EDT", or just the day. */
    due_label: due_on
      ? (r.due_at
          ? `${formatDay(r.due_at, taskZone)} at ${formatTime(r.due_at, taskZone)}`
          : formatDay(new Date(`${due_on}T12:00:00Z`), taskZone))
      : null,
    bucket: bucket as DueBucket,
    overdue: bucket === 'overdue',
    reminder_minutes: r.reminder_minutes,
    reminder_sent: !!r.reminder_sent_at,
    completed_at: r.completed_at?.toISOString() ?? null,
    completed_by_name: r.completed_by_name,
    cancelled_reason: r.cancelled_reason,
    created_at: r.created_at.toISOString(),
    created_by_name: r.created_by_name,
    source_kind: r.source_kind,
    application_id: r.application_id,
    customer_id: r.customer_id,
    client_name: r.client_name || null,
    portal_reference: r.portal_reference,
    stage_label: r.stage_label,
    pipeline_name: r.pipeline_name,
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name ?? 'Unknown', email: r.owner_email } : null,
    mine,
    // The UI hides what you cannot do; the service still refuses it.
    can_manage: scope.manageAll || (scope.manage && mine),
  };
};

/** What a person is allowed to see, as SQL. */
function visibleSql(scope: Scope, params: unknown[]): string {
  if (scope.viewAll) return 'TRUE';
  params.push(me(scope));
  const p = `$${params.length}`;
  // Their own work, and anything they made for somebody else — a manager who
  // has been given manage_all but not view_all still sees what they created.
  return `(EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${p})
           OR t.created_by = ${p})`;
}

const TABS = {
  open: `t.status IN ('open','in_progress','waiting')`,
  today: `t.status IN ('open','in_progress','waiting') AND t.due_on IS NOT NULL AND t.due_on <= CURRENT_DATE`,
  overdue: `t.status IN ('open','in_progress','waiting')
            AND ((t.due_at IS NOT NULL AND t.due_at < now())
                 OR (t.due_at IS NULL AND t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE))`,
  completed: `t.status = 'completed'`,
  cancelled: `t.status = 'cancelled'`,
  all: 'TRUE',
} as const;
export type Tab = keyof typeof TABS;

const SORTS: Record<string, string> = {
  due: `(t.due_on IS NULL), t.due_on {dir}, t.due_time NULLS LAST`,
  priority: `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END {dir}`,
  title: 'lower(t.title) {dir}',
  client: 'lower(coalesce(c.first_name,\'\') || coalesce(c.last_name,\'\')) {dir}',
  owner: 'lower(coalesce(owner.name, \'\')) {dir}',
  status: 't.status {dir}',
  created: 't.created_at {dir}',
};

export const ListQuery = z.object({
  tab: z.enum(Object.keys(TABS) as [Tab, ...Tab[]]).default('open'),
  q: z.string().trim().max(100).optional(),
  owner: z.string().trim().max(40).optional(),
  created_by: z.string().trim().max(40).optional(),
  category: z.enum(CATEGORY_KEYS).optional(),
  priority: z.enum(PRIORITY_KEYS).optional(),
  status: z.enum(STATUS_KEYS).optional(),
  bucket: z.enum(['overdue', 'today', 'tomorrow', 'this_week', 'later', 'someday']).optional(),
  application_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).default('due'),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(25),
});

export async function listTasks(scope: Scope, raw: unknown) {
  const q = ListQuery.parse(raw ?? {});
  const zone = await zoneOf(scope);
  const params: unknown[] = [scope.actor.organizationId];
  const base = ['t.organization_id = $1', visibleSql(scope, params)];
  const where: string[] = [];
  const add = (sql: (p: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  const person = (value: string, column: string, field: string) => {
    if (value === 'me') add((p) => `${column} = ${p}`, scope.actor.userId);
    else if (value === '__none') where.push(`${column} IS NULL`);
    else if (UUID.test(value)) add((p) => `${column} = ${p}`, value);
    else throw fieldError(field, 'Choose somebody from the list.');
  };

  if (q.q) {
    add((p) => `(concat_ws(' ', t.title, t.description, c.first_name, c.last_name, app.portal_reference, owner.name) ILIKE ${p})`,
      `%${q.q}%`);
  }
  if (q.owner) person(q.owner, 'owner.user_id', 'owner');
  if (q.created_by) person(q.created_by, 't.created_by', 'created_by');
  if (q.category) add((p) => `t.category = ${p}`, q.category);
  if (q.priority) add((p) => `t.priority = ${p}`, q.priority);
  if (q.status) add((p) => `t.status = ${p}`, q.status);
  if (q.application_id) add((p) => `t.application_id = ${p}`, q.application_id);
  if (q.customer_id) add((p) => `t.customer_id = ${p}`, q.customer_id);
  if (q.from) add((p) => `t.due_on >= ${p}::date`, q.from);
  if (q.to) add((p) => `t.due_on <= ${p}::date`, q.to);
  if (q.bucket === 'someday') {
    where.push('t.due_on IS NULL');
  } else if (q.bucket) {
    // The zone is only pushed for the buckets that compare against a day.
    // Pushing it unconditionally left an unused parameter, which Postgres
    // rejects outright rather than ignoring.
    params.push(zone);
    const z = `$${params.length}::text`;
    const today = `(now() AT TIME ZONE ${z})::date`;
    where.push({
      overdue: `((t.due_at IS NOT NULL AND t.due_at < now()) OR (t.due_at IS NULL AND t.due_on < ${today}))`,
      today: `t.due_on = ${today}`,
      tomorrow: `t.due_on = ${today} + 1`,
      this_week: `t.due_on > ${today} + 1 AND t.due_on <= ${today} + 7`,
      later: `t.due_on > ${today} + 7`,
    }[q.bucket]);
  }

  const filtered = [...base, ...where].join(' AND ');
  const direction = (q.dir ?? (q.sort === 'due' ? 'asc' : 'desc')).toUpperCase();
  const order = SORTS[q.sort]!.replaceAll('{dir}', direction);

  params.push(q.page_size, (q.page - 1) * q.page_size);
  const { rows } = await query<TaskRow & { total: string }>(
    `SELECT ${COLUMNS}, COUNT(*) OVER () AS total ${FROM}
      WHERE ${filtered} AND ${TABS[q.tab]}
      ORDER BY ${order}, t.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  // Every tab's count under the same filters, so switching tabs never shows a
  // number that disagrees with the rows underneath it.
  const counts = await query<Record<Tab, string>>(
    `SELECT ${Object.entries(TABS)
      .map(([key, sql]) => `(COUNT(*) FILTER (WHERE ${sql}))::int AS ${key}`)
      .join(', ')}
       FROM tasks t
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN applications app ON app.id = t.application_id
       LEFT JOIN LATERAL (
         SELECT u.id AS user_id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id
          WHERE ta.task_id = t.id ORDER BY ta.assigned_at LIMIT 1
       ) owner ON true
      WHERE ${filtered}`,
    params.slice(0, params.length - 2),
  );

  const now = new Date();
  return {
    tasks: rows.map((r) => shape(r, scope, zone, now)),
    total: Number(rows[0]?.total ?? 0),
    page: q.page,
    page_size: q.page_size,
    tabs: counts.rows[0] ?? {},
    timezone: zone,
  };
}

export async function getTask(scope: Scope, id: string): Promise<Task> {
  const zone = await zoneOf(scope);
  const params: unknown[] = [scope.actor.organizationId];
  const visible = visibleSql(scope, params);
  params.push(id);
  const { rows } = await query<TaskRow>(
    `${SELECT} WHERE t.organization_id = $1 AND ${visible} AND t.id = $${params.length}`, params);
  const row = rows[0];
  if (!row) throw notFound('That task');
  return shape(row, scope, zone);
}

/** The vocabularies the form needs, in one call. */
export async function taskMeta(scope: Scope) {
  const { CATEGORIES, PRIORITIES, STATUSES, REMINDER_CHOICES, BUCKETS } = await import('../domain/tasks.ts');
  return {
    categories: CATEGORIES,
    priorities: PRIORITIES,
    statuses: STATUSES,
    reminder_choices: REMINDER_CHOICES,
    buckets: BUCKETS,
    default_reminder_minutes: REMINDER_MINUTES,
    timezone: await zoneOf(scope),
    can_manage_all: scope.manageAll,
    view_all: scope.viewAll,
  };
}

// ── The files a task can sit on ────────────────────────────────────────────

/**
 * The client list the form offers.
 *
 * For a staff member that is the files assigned to them, and nothing else —
 * the rule made visible rather than a refusal after the fact. For an admin it
 * is every open file, each carrying the name of whoever it belongs to, which
 * is what the read-only field on the form then shows.
 */
export async function assignableFiles(scope: Scope, raw: unknown) {
  const q = z.object({
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  }).parse(raw ?? {});

  const params: unknown[] = [scope.actor.organizationId, q.limit];
  let filter = '';
  if (!scope.manageAll) {
    params.push(me(scope));
    filter = `AND EXISTS (SELECT 1 FROM assignments x
                           WHERE x.application_id = app.id AND x.user_id = $${params.length}
                             AND x.unassigned_at IS NULL)`;
  }
  if (q.q) {
    params.push(`%${q.q}%`);
    filter += ` AND concat_ws(' ', c.first_name, c.last_name, c.email, app.portal_reference) ILIKE $${params.length}`;
  }

  const { rows } = await query<{
    id: string; first_name: string | null; last_name: string | null; email: string | null;
    portal_reference: string | null; stage_label: string | null; category: string | null;
    pipeline_name: string | null; owner_id: string | null; owner_name: string | null;
    owner_role: string | null; open_tasks: number;
  }>(
    `SELECT app.id, c.first_name, c.last_name, c.email, app.portal_reference,
            s.label AS stage_label, s.category, p.name AS pipeline_name,
            owner.user_id AS owner_id, owner.name AS owner_name, owner.role AS owner_role,
            (SELECT COUNT(*)::int FROM tasks t
              WHERE t.application_id = app.id AND t.status IN ('open','in_progress','waiting')) AS open_tasks
       FROM applications app
       JOIN customers c ON c.id = app.customer_id
       LEFT JOIN pipeline_stages s ON s.organization_id = app.organization_id AND s.key = app.stage_key
       LEFT JOIN pipelines p ON p.id = app.pipeline_id
       LEFT JOIN LATERAL (
         SELECT u.id AS user_id, u.name, a.role
           FROM assignments a JOIN users u ON u.id = a.user_id
          WHERE a.application_id = app.id AND a.unassigned_at IS NULL
          ORDER BY a.is_primary DESC, (a.role = 'broker') DESC, a.assigned_at
          LIMIT 1
       ) owner ON true
      WHERE app.organization_id = $1 AND app.archived_at IS NULL AND c.merged_into_id IS NULL ${filter}
      ORDER BY (s.category IN ('won','lost')) NULLS FIRST, app.last_activity_at DESC NULLS LAST
      LIMIT $2`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unnamed client',
    email: r.email,
    reference: r.portal_reference,
    stage_label: r.stage_label,
    pipeline_name: r.pipeline_name,
    settled: r.category === 'won' || r.category === 'lost',
    open_tasks: r.open_tasks,
    // What the read-only "assigned to" field shows the moment a client is picked.
    owner: r.owner_id
      ? { id: r.owner_id, name: r.owner_name ?? 'Unknown', role: r.owner_role }
      : null,
  }));
}

/**
 * The file, and who it belongs to.
 *
 * `mustBeAssignedTo` is the access rule, not a filter: somebody without
 * `manage_all` may only put a task on a file they are actually on. It is the
 * same list `assignableFiles` offers them, enforced again here — a form that
 * offers the right choices is a courtesy, and a service that trusts the choice
 * it is sent is a hole.
 *
 * A file they are not on comes back as "not found" rather than "forbidden",
 * for the same reason a chat they are not in does: telling somebody a file
 * exists is telling them something they did not ask and cannot act on.
 */
async function fileOwner(
  applicationId: string,
  organizationId: string,
  mustBeAssignedTo?: string | null,
): Promise<{ customer_id: string; owner: FileOwner }> {
  const params: unknown[] = [applicationId, organizationId];
  let mine = '';
  if (mustBeAssignedTo) {
    params.push(mustBeAssignedTo);
    mine = `AND EXISTS (SELECT 1 FROM assignments x
                          WHERE x.application_id = app.id AND x.user_id = $${params.length}
                            AND x.unassigned_at IS NULL)`;
  }
  const row = await queryOne<{
    customer_id: string; owner_id: string | null; owner_name: string | null; owner_role: string | null;
  }>(
    `SELECT app.customer_id, owner.user_id AS owner_id, owner.name AS owner_name, owner.role AS owner_role
       FROM applications app
       LEFT JOIN LATERAL (
         SELECT u.id AS user_id, u.name, a.role
           FROM assignments a JOIN users u ON u.id = a.user_id
          WHERE a.application_id = app.id AND a.unassigned_at IS NULL AND u.active
          ORDER BY a.is_primary DESC, (a.role = 'broker') DESC, a.assigned_at
          LIMIT 1
       ) owner ON true
      WHERE app.id = $1 AND app.organization_id = $2 AND app.archived_at IS NULL ${mine}`,
    params,
  );
  if (!row) throw notFound('That application');
  return {
    customer_id: row.customer_id,
    owner: row.owner_id
      ? { user_id: row.owner_id, name: row.owner_name ?? 'Unknown', role: row.owner_role ?? 'broker' }
      : null,
  };
}

/**
 * Who a task on this file would belong to, before anything is written.
 *
 * The form asks this the moment a client is chosen and shows the answer in a
 * field nobody can type into — so an admin sees whose work they are making
 * before they make it, rather than after.
 */
export async function previewOwner(scope: Scope, applicationId: string) {
  const { owner } = await fileOwner(
    applicationId, scope.actor.organizationId, scope.manageAll ? null : me(scope));
  const decision = ownerFor({
    actorId: me(scope), manageAll: scope.manageAll, fileOwner: owner, hasFile: true,
  });
  if ('refusal' in decision) throw new AppError(decision.refusal, 422, 'validation_failed');
  const who = decision.assignee === scope.actor.userId
    ? { id: scope.actor.userId, name: scope.actor.name }
    : { id: owner!.user_id, name: owner!.name };
  return { owner: who, source: decision.source, note: decision.note };
}

// ── Writing ────────────────────────────────────────────────────────────────

export const TaskInput = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE + 1),
  description: z.string().trim().max(MAX_DESCRIPTION + 1).optional(),
  application_id: z.string().uuid().nullable().optional(),
  category: z.enum(CATEGORY_KEYS).default('follow_up'),
  priority: z.enum(PRIORITY_KEYS).default('normal'),
  due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  due_time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  /** Minutes before the start; null for no reminder. Ignored without a time. */
  reminder_minutes: z.coerce.number().int().min(0).max(10_080).nullable().optional(),
});

export async function createTask(scope: Scope, raw: unknown): Promise<Task> {
  if (!scope.manage && !scope.manageAll) {
    throw new AppError('Your account cannot create tasks.', 403, 'forbidden');
  }
  const input = TaskInput.parse(raw ?? {});
  const actorId = me(scope);
  const zone = await zoneOf(scope);

  const badTitle = titleRefusal(input.title);
  if (badTitle) throw fieldError('title', badTitle);
  const badSchedule = scheduleRefusal(input.due_on ?? null, input.due_time ?? null, zone);
  if (badSchedule) throw fieldError(input.due_on ? 'due_time' : 'due_on', badSchedule);

  let customerId: string | null = null;
  let owner: FileOwner = null;
  if (input.application_id) {
    const file = await fileOwner(
      input.application_id, scope.actor.organizationId, scope.manageAll ? null : actorId);
    customerId = file.customer_id;
    owner = file.owner;
  }

  const decision = ownerFor({
    actorId, manageAll: scope.manageAll, fileOwner: owner, hasFile: !!input.application_id,
  });
  if ('refusal' in decision) throw new AppError(decision.refusal, 422, 'validation_failed');
  const assignee = decision.assignee;

  const dueAt = dueInstant(input.due_on ?? null, input.due_time ?? null, zone);
  const minutes = input.due_time
    ? (input.reminder_minutes === undefined ? REMINDER_MINUTES : input.reminder_minutes)
    : null;
  const remindAt = reminderInstant(dueAt, minutes, 'open');

  const id = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tasks (organization_id, application_id, customer_id, title, description,
                          category, priority, due_on, due_time, due_at, timezone,
                          reminder_minutes, remind_at, created_by, source_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::time,$10,$11,$12,$13,$14,'manual')
       RETURNING id`,
      [scope.actor.organizationId, input.application_id ?? null, customerId, input.title.trim(),
       input.description?.trim() || null, input.category, input.priority,
       input.due_on ?? null, input.due_time ?? null, dueAt, zone, minutes, remindAt, actorId],
    );
    const taskId = rows[0]!.id;
    await client.query(
      'INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [taskId, assignee],
    );
    await refreshNextTask(input.application_id ?? null, client);
    await recordAudit({
      organizationId: scope.actor.organizationId,
      actor: auditActor(scope.actor),
      action: 'task.create',
      entityType: 'task',
      entityId: taskId,
      applicationId: input.application_id ?? null,
      summary: assignee === actorId
        ? `Created the task “${input.title.trim()}”`
        : `Created the task “${input.title.trim()}” for ${owner?.name ?? 'somebody else'}`,
      after: { due_on: input.due_on ?? null, due_time: input.due_time ?? null, assignee },
    }, client);
    return taskId;
  });

  // Somebody who has been given work is told at once; somebody who wrote
  // themselves a note is not notified about their own note.
  if (assignee !== actorId) await tellOwner(scope, id, assignee, 'assigned');
  publish([assignee], { type: 'task.changed', task_id: id });
  return getTask({ ...scope, viewAll: true }, id);
}

export const UpdateInput = TaskInput.partial().extend({
  status: z.enum(STATUS_KEYS).optional(),
  cancelled_reason: z.string().trim().max(500).optional(),
});

export async function updateTask(scope: Scope, id: string, raw: unknown): Promise<Task> {
  const input = UpdateInput.parse(raw ?? {});
  const actorId = me(scope);
  const existing = await getTask(scope, id);
  if (!existing.can_manage) {
    throw new AppError(
      existing.mine
        ? 'Your account cannot change tasks.'
        : `That task belongs to ${existing.owner?.name ?? 'somebody else'}.`,
      403, 'forbidden',
    );
  }
  const zone = existing.timezone;

  if (input.status) {
    const bad = transitionRefusal(existing.status, input.status);
    if (bad) throw new AppError(bad, 409, 'bad_transition');
  }
  if (input.title !== undefined) {
    const bad = titleRefusal(input.title);
    if (bad) throw fieldError('title', bad);
  }

  // The schedule is replaced as a pair: a new date with the old time, or a
  // time cleared to make it all-day, must both land coherently.
  const dueOn = input.due_on !== undefined ? input.due_on : existing.due_on;
  const dueTime = input.due_time !== undefined ? input.due_time : existing.due_time;
  const badSchedule = scheduleRefusal(dueOn, dueTime, zone);
  if (badSchedule) throw fieldError(dueOn ? 'due_time' : 'due_on', badSchedule);

  const rescheduled = input.due_on !== undefined || input.due_time !== undefined
    || input.reminder_minutes !== undefined;
  const dueAt = dueInstant(dueOn, dueTime, zone);
  const status = input.status ?? existing.status;
  const minutes = dueTime
    ? (input.reminder_minutes !== undefined ? input.reminder_minutes : existing.reminder_minutes ?? REMINDER_MINUTES)
    : null;
  const remindAt = reminderInstant(dueAt, minutes, status);

  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (column: string, value: unknown, cast = '') => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  if (input.title !== undefined) set('title', input.title.trim());
  if (input.description !== undefined) set('description', input.description?.trim() || null);
  if (input.category) set('category', input.category);
  if (input.priority) set('priority', input.priority);
  if (rescheduled) {
    set('due_on', dueOn, '::date');
    set('due_time', dueTime, '::time');
    set('due_at', dueAt);
    set('reminder_minutes', minutes);
    set('remind_at', remindAt);
    // A task moved to a new time is reminded about again. Without this,
    // rescheduling yesterday's 9am task to tomorrow would send nothing.
    sets.push('reminder_sent_at = NULL');
  }
  if (input.status) {
    set('status', input.status);
    if (input.status === 'completed') {
      set('completed_by', actorId);
      sets.push('completed_at = now()');
    } else {
      sets.push('completed_at = NULL, completed_by = NULL');
      if (isOpen(input.status) && !rescheduled) sets.push('reminder_sent_at = NULL');
    }
    if (input.status === 'cancelled') set('cancelled_reason', input.cancelled_reason ?? null);
  }
  set('updated_by', actorId);

  await withTransaction(async (client) => {
    await client.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, params);
    if (input.status === 'completed' && existing.status !== 'completed') {
      await client.query(
        `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id, payload,
                                    actor_user_id, dedupe_key)
         SELECT t.organization_id, 'task.completed', COALESCE(t.customer_id, app.customer_id), t.application_id,
                json_build_object('task_id', t.id, 'task_title', t.title, 'category', t.category)::jsonb,
                $2, 'task.completed:' || t.id || ':' || extract(epoch FROM clock_timestamp())
           FROM tasks t LEFT JOIN applications app ON app.id = t.application_id
          WHERE t.id = $1 AND COALESCE(t.customer_id, app.customer_id) IS NOT NULL
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [id, actorId]);
    }
    await refreshNextTask(existing.application_id, client);
    await recordAudit({
      organizationId: scope.actor.organizationId,
      actor: auditActor(scope.actor),
      action: input.status === 'completed' ? 'task.complete'
        : input.status === 'cancelled' ? 'task.cancel'
        : input.status && isOpen(input.status) && !existing.open ? 'task.reopen'
        : rescheduled ? 'task.reschedule' : 'task.update',
      entityType: 'task',
      entityId: id,
      applicationId: existing.application_id,
      summary: input.status
        ? `Task “${existing.title}” marked ${statusLabel(input.status).toLowerCase()}`
        : rescheduled
          ? `Task “${existing.title}” moved to ${dueOn ?? 'no date'}${dueTime ? ` at ${dueTime}` : ''}`
          : `Task “${existing.title}” edited`,
      before: { status: existing.status, due_on: existing.due_on, due_time: existing.due_time },
      after: { status, due_on: dueOn, due_time: dueTime },
    }, client);
  });

  const owner = existing.owner?.id;
  if (owner) {
    publish([owner], { type: 'task.changed', task_id: id });
    // Somebody else moving your work is worth a line in your bell.
    if (owner !== actorId && (rescheduled || input.status)) {
      await tellOwner(scope, id, owner, input.status ? 'status' : 'moved');
    }
  }
  return getTask({ ...scope, viewAll: true }, id);
}

/**
 * The stamp the pipeline board and the staleness rules read.
 *
 * Recomputed from the tasks themselves rather than incremented, for the same
 * reason the chat unread count is: a cached number that has to be right after
 * every insert, edit, completion and rollback is a number that will be wrong.
 */
export async function refreshNextTask(applicationId: string | null, client?: Queryable): Promise<void> {
  if (!applicationId) return;
  const runner = client ?? { query };
  await runner.query(
    `UPDATE applications
        SET next_task_at = (
              SELECT MIN(COALESCE(due_at, due_on::timestamptz)) FROM tasks
               WHERE application_id = $1 AND status IN ('open','in_progress','waiting')
                 AND due_on IS NOT NULL)
      WHERE id = $1`,
    [applicationId],
  );
}

// ── Telling the person whose task it is ────────────────────────────────────

async function tellOwner(
  scope: Scope,
  taskId: string,
  ownerId: string,
  what: 'assigned' | 'moved' | 'status',
): Promise<void> {
  const task = await getTask({ ...scope, viewAll: true }, taskId);
  const title = {
    assigned: 'New task assigned to you',
    moved: 'A task of yours was moved',
    status: 'A task of yours changed',
  }[what];
  try {
    await query(
      `INSERT INTO notifications (organization_id, user_id, kind, title, body, link,
                                  entity_type, entity_id, dedupe_key)
       VALUES ($1,$2,'task',$3,$4,'/tasks','task',$5,$6)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
       DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, at = now(), read_at = NULL`,
      [scope.actor.organizationId, ownerId, title,
       `${scope.actor.name}: ${task.title}${task.due_label ? ` — ${task.due_label}` : ''}`,
       taskId, `task:${taskId}`],
    );
  } catch (err) {
    log.warn('could not raise a task notification', { taskId, error: err });
  }
}

// ── The reminder ───────────────────────────────────────────────────────────

/**
 * Fifteen minutes before, by default.
 *
 * Runs every minute, so a reminder is never more than a minute late. The mark
 * is written BEFORE the email is sent: a send that fails costs one reminder,
 * where a mark that fails would cost one every minute until somebody noticed.
 */
export async function runTaskReminders(): Promise<{
  reminded: number;
  /** Who was told, and about what — the job log's answer to "did mine go out?". */
  sent: Array<{ task_id: string; to: string | null; subject: string }>;
}> {
  const now = new Date();
  const { rows } = await query<TaskRow & { remind_at: Date; organization_id: string }>(
    `SELECT t.organization_id, t.remind_at, ${COLUMNS} ${FROM}
      WHERE t.remind_at IS NOT NULL AND t.reminder_sent_at IS NULL
        -- A task with no instant cannot be reminded about, whatever a stray
        -- remind_at says: you cannot be fifteen minutes early for a day.
        AND t.due_at IS NOT NULL
        AND t.status IN ('open','in_progress','waiting')
        AND t.remind_at <= now()
      ORDER BY t.remind_at
      LIMIT 200`,
  );

  let reminded = 0;
  const sent: Array<{ task_id: string; to: string | null; subject: string }> = [];
  for (const row of rows) {
    if (!shouldRemind({ remind_at: row.remind_at, reminder_sent_at: null, status: row.status }, now)) {
      // Past its grace period: marked, not sent. "Your 9am task starts in 15
      // minutes" at four in the afternoon is worse than silence.
      await query('UPDATE tasks SET reminder_sent_at = now() WHERE id = $1', [row.id]);
      continue;
    }
    const marked = await query(
      `UPDATE tasks SET reminder_sent_at = now()
        WHERE id = $1 AND reminder_sent_at IS NULL RETURNING id`, [row.id]);
    if (!marked.rowCount) continue; // another worker got there first

    const zone = row.timezone && isValidZone(row.timezone) ? row.timezone : env.BROKERAGE_TIMEZONE;
    const minutes = row.reminder_minutes ?? REMINDER_MINUTES;
    const when = row.due_at ? `${formatDay(row.due_at, zone)} at ${formatTime(row.due_at, zone)}` : '';
    const lines = [
      `${reminderSubject({ title: row.title, minutes })}`,
      '',
      row.description ?? '',
      when ? `When: ${when}` : '',
      row.client_name ? `Client: ${row.client_name}${row.portal_reference ? ` (${row.portal_reference})` : ''}` : '',
      '',
      `Open it: ${env.PUBLIC_URL}/tasks`,
    ].filter((l) => l !== null);
    const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    try {
      await query(
        `INSERT INTO notifications (organization_id, user_id, kind, title, body, link,
                                    entity_type, entity_id, dedupe_key)
         VALUES ($1,$2,'task',$3,$4,'/tasks','task',$5,$6)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
         DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, at = now(), read_at = NULL`,
        [row.organization_id, row.owner_id, reminderSubject({ title: row.title, minutes }),
         when, row.id, `task-reminder:${row.id}`],
      );
    } catch (err) {
      log.warn('could not raise a task reminder notification', { taskId: row.id, error: err });
    }

    if (row.owner_id) {
      publish([row.owner_id], { type: 'task.reminder', task_id: row.id, title: row.title, when });
    }

    // The email is what reaches somebody who is not looking at the CRM, which
    // is most people fifteen minutes before a call.
    if (row.owner_email) {
      try {
        await sendEmail(row.organization_id, {
          to: row.owner_email,
          subject: reminderSubject({ title: row.title, minutes }),
          text: body,
          html: textToHtml(body),
        });
      } catch (err) {
        log.warn('could not email a task reminder', { taskId: row.id, error: err });
      }
    }
    reminded += 1;
    sent.push({
      task_id: row.id,
      to: row.owner_email,
      subject: reminderSubject({ title: row.title, minutes }),
    });
  }
  return { reminded, sent };
}
