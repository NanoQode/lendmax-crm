/**
 * Appointments — booking, rescheduling, cancelling and recording outcomes.
 *
 * Both doors call this: the admin panel and the v1 API. What a person may do
 * is decided here from their scope, not in the route:
 *   · appointment.view / .manage — meetings with their own clients (files
 *     assigned to them) and meetings they host;
 *   · appointment.view_all / .manage_all — everyone's, and booking on behalf
 *     of another staff member, whose clients are then the only ones offered.
 *
 * Every change keeps the rest of the CRM in step:
 *   · the file moves along its pipeline (booked / attended / missed stages
 *     set per pipeline), through the one stage-move path;
 *   · the host's Google Calendar is updated (services/google-calendar.ts);
 *   · the client is emailed from an editable template, and reminded 15
 *     minutes before, as is the host;
 *   · the automations hear appointment.booked / .completed / .no_show;
 *   · the audit trail, the activity log and the file's timeline record it.
 */
import type pg from 'pg';
import { z } from 'zod';
import { env } from '../config/env.ts';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import {
  APPOINTMENT_TYPE_KEYS, APPOINTMENT_TYPES, bookingMove, DEFAULT_TEMPLATES, DURATIONS, formatDay, formatDuration,
  formatTime, isValidZone, localToInstant, MODE_KEYS, MODES, modeLabel, OPEN_STATUSES, outcomeMove,
  PROMPT_SNOOZE_MINUTES, PROMPT_WINDOW_HOURS, promptPhase, REMINDER_MINUTES, STATUSES, statusLabel,
  typeLabel, whereText, type StageRef, type TemplateKey,
} from '../domain/appointments.ts';
import { renderTemplate } from '../domain/merge-fields.ts';
import { can, type Role } from '../domain/permissions.ts';
import { textToHtml } from '../domain/signature.ts';
import { AppError, fieldError, notFound } from '../http/middleware/errors.ts';
import { sendEmail } from '../integrations/email.ts';
import { log } from '../lib/logger.ts';
import { recordAudit } from './audit.ts';
import {
  busyFor, changesFor, connectedAccounts, connectedUsers, googleStatus, pushAppointment, type PushTarget,
} from './google-calendar.ts';
import { enqueue } from '../jobs/queue.ts';
import type { EventInput } from '../integrations/google-calendar.ts';
import { send } from './messaging.ts';
import { signatureFor } from './signature.ts';
import type { Actor } from './staff.ts';
import { loadStages, moveFileToStage } from './stage-moves.ts';

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

async function orgZone(organizationId: string): Promise<string> {
  const org = await queryOne<{ timezone: string | null }>('SELECT timezone FROM organizations WHERE id = $1', [organizationId]);
  return org?.timezone && isValidZone(org.timezone) ? org.timezone : env.BROKERAGE_TIMEZONE;
}

const zoneOf = async (scope: Scope) =>
  scope.timezone && isValidZone(scope.timezone) ? scope.timezone : orgZone(scope.actor.organizationId);

// ── Reading ────────────────────────────────────────────────────────────────

const SELECT = `
  SELECT a.id, a.starts_at, a.ends_at, a.timezone, a.appointment_type, a.mode, a.status,
         a.location, a.meeting_url, a.notes, a.outcome,
         a.customer_id, c.first_name, c.last_name, c.email AS client_email, c.phone_e164 AS client_phone,
         a.application_id, app.portal_reference, app.stage_key, ps.label AS stage_label,
         pl.name AS pipeline_name,
         a.user_id AS host_id, h.name AS host_name, h.email AS host_email,
         a.created_by, b.name AS booked_by_name, a.created_at, a.updated_at,
         a.confirmed_at, a.cancelled_at, a.cancelled_reason, a.no_show_at,
         a.outcome_at, ob.name AS outcome_by_name, a.outcome_stage_key, os.label AS outcome_stage_label,
         a.outcome_stage_note, a.reminder_sent_at, a.reschedule_count, a.rescheduled_from_id,
         a.google_event_id, a.google_synced_at, a.google_sync_error, a.google_html_link,
         (gca.user_id IS NOT NULL) AS host_google_connected
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN applications app ON app.id = a.application_id
    LEFT JOIN pipeline_stages ps ON ps.organization_id = a.organization_id AND ps.key = app.stage_key
    LEFT JOIN pipelines pl ON pl.id = app.pipeline_id
    LEFT JOIN users h ON h.id = a.user_id
    LEFT JOIN users b ON b.id = a.created_by
    LEFT JOIN users ob ON ob.id = a.outcome_by
    LEFT JOIN pipeline_stages os ON os.organization_id = a.organization_id AND os.key = a.outcome_stage_key
    LEFT JOIN google_calendar_accounts gca ON gca.user_id = a.user_id`;

type Row = {
  id: string; starts_at: Date; ends_at: Date; timezone: string; appointment_type: string; mode: string;
  status: string; location: string | null; meeting_url: string | null; notes: string | null; outcome: string | null;
  customer_id: string; first_name: string | null; last_name: string | null;
  client_email: string | null; client_phone: string | null;
  application_id: string | null; portal_reference: string | null; stage_key: string | null;
  stage_label: string | null; pipeline_name: string | null;
  host_id: string | null; host_name: string | null; host_email: string | null;
  created_by: string | null; booked_by_name: string | null; created_at: Date; updated_at: Date;
  confirmed_at: Date | null; cancelled_at: Date | null; cancelled_reason: string | null; no_show_at: Date | null;
  outcome_at: Date | null; outcome_by_name: string | null; outcome_stage_key: string | null;
  outcome_stage_label: string | null; outcome_stage_note: string | null; reminder_sent_at: Date | null;
  reschedule_count: number; rescheduled_from_id: string | null;
  google_event_id: string | null; google_synced_at: Date | null; google_sync_error: string | null;
  google_html_link: string | null; host_google_connected: boolean;
};

export type Appointment = ReturnType<typeof shape>;

const clientName = (r: { first_name: string | null; last_name: string | null }) =>
  `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Unnamed client';

function phaseOf(r: Row, now = new Date()) {
  if (r.status === 'cancelled' || r.status === 'rescheduled') return 'cancelled';
  if (r.status === 'completed' || r.status === 'no_show') return 'done';
  if (new Date(r.starts_at) > now) return 'upcoming';
  return new Date(r.ends_at) > now ? 'live' : 'needs_outcome';
}

function shape(r: Row, scope?: Scope) {
  const minutes = Math.round((new Date(r.ends_at).getTime() - new Date(r.starts_at).getTime()) / 60_000);
  return {
    ...r,
    starts_at: new Date(r.starts_at).toISOString(),
    ends_at: new Date(r.ends_at).toISOString(),
    duration_minutes: minutes,
    client_name: clientName(r),
    type_label: typeLabel(r.appointment_type),
    mode_label: modeLabel(r.mode),
    status_label: statusLabel(r.status),
    phase: phaseOf(r),
    google: r.google_event_id && !r.google_sync_error ? 'synced'
      : r.google_sync_error ? 'error' : r.host_google_connected ? 'pending' : 'off',
    can_manage: scope ? mayManageRow(scope, r) : false,
  };
}

/** May this scope see appointments on this file / hosted by this person? SQL, for lists. */
function visibleSql(scope: Scope, params: unknown[]): string {
  if (scope.viewAll) return 'TRUE';
  if (!scope.actor.userId) return 'FALSE';
  params.push(scope.actor.userId);
  const me = `$${params.length}`;
  return `(a.user_id = ${me} OR EXISTS (SELECT 1 FROM assignments x WHERE x.application_id = a.application_id
             AND x.user_id = ${me} AND x.unassigned_at IS NULL))`;
}

function mayManageRow(scope: Scope, r: Row & { assigned_to_me?: boolean }): boolean {
  if (scope.manageAll) return true;
  if (!scope.manage || !scope.actor.userId) return false;
  return r.host_id === scope.actor.userId || !!r.assigned_to_me;
}

const SORTS: Record<string, string> = {
  starts_at: 'a.starts_at',
  client: "lower(concat_ws(' ', c.first_name, c.last_name))",
  host: 'lower(h.name)',
  type: 'a.appointment_type',
  mode: 'a.mode',
  status: 'a.status',
  booked_by: 'lower(b.name)',
  created_at: 'a.created_at',
};

const TABS = {
  upcoming: `a.status IN ('booked','confirmed') AND a.starts_at > now()`,
  needs_outcome: `a.status IN ('booked','confirmed') AND a.starts_at <= now()`,
  attended: `a.status = 'completed'`,
  missed: `a.status = 'no_show'`,
  cancelled: `a.status IN ('cancelled','rescheduled')`,
  all: 'TRUE',
} as const;
type Tab = keyof typeof TABS;

export const ListQuery = z.object({
  tab: z.enum(Object.keys(TABS) as [Tab, ...Tab[]]).default('all'),
  q: z.string().trim().max(100).optional(),
  client: z.string().trim().max(100).optional(),
  host: z.string().trim().max(40).optional(),
  booked_by: z.string().trim().max(40).optional(),
  type: z.enum(APPOINTMENT_TYPE_KEYS).optional(),
  mode: z.enum(MODE_KEYS).optional(),
  status: z.enum(STATUSES.map((s) => s.key) as [string, ...string[]]).optional(),
  when: z.enum(['today', 'tomorrow', 'this_week', 'next_7', 'last_7', 'last_30', 'future', 'past']).optional(),
  from: z.string().date().or(z.string().datetime({ offset: true })).optional(),
  to: z.string().date().or(z.string().datetime({ offset: true })).optional(),
  google: z.enum(['synced', 'error', 'off']).optional(),
  application_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).default('starts_at'),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(25),
});

export async function listAppointments(scope: Scope, raw: unknown) {
  const q = ListQuery.parse(raw ?? {});
  const zone = await zoneOf(scope);
  const params: unknown[] = [scope.actor.organizationId];
  const base = ['a.organization_id = $1', visibleSql(scope, params)];
  const where: string[] = [];
  const add = (sql: (p: string) => string, value: unknown) => { params.push(value); where.push(sql(`$${params.length}`)); };
  const person = (value: string, column: string, field: string) => {
    if (value === 'me') add((p) => `${column} = ${p}`, scope.actor.userId);
    else if (value === '__none') where.push(`${column} IS NULL`);
    else if (UUID.test(value)) add((p) => `${column} = ${p}`, value);
    else throw fieldError(field, 'Choose somebody from the list.');
  };

  if (q.q) {
    add((p) => `(concat_ws(' ', c.first_name, c.last_name, c.email, c.phone_e164, app.portal_reference, h.name, a.notes, a.location) ILIKE ${p})`, `%${q.q}%`);
  }
  if (q.client) add((p) => `concat_ws(' ', c.first_name, c.last_name, app.portal_reference) ILIKE ${p}`, `%${q.client}%`);
  if (q.host) person(q.host, 'a.user_id', 'host');
  if (q.booked_by) person(q.booked_by, 'a.created_by', 'booked_by');
  if (q.type) add((p) => `a.appointment_type = ${p}`, q.type);
  if (q.mode) add((p) => `a.mode = ${p}`, q.mode);
  if (q.status) add((p) => `a.status = ${p}`, q.status);
  if (q.application_id) add((p) => `a.application_id = ${p}`, q.application_id);
  if (q.customer_id) add((p) => `a.customer_id = ${p}`, q.customer_id);
  if (q.google) {
    where.push({
      synced: 'a.google_event_id IS NOT NULL AND a.google_sync_error IS NULL',
      error: 'a.google_sync_error IS NOT NULL',
      off: 'a.google_event_id IS NULL AND a.google_sync_error IS NULL',
    }[q.google]);
  }
  if (q.when) {
    params.push(zone);
    const z0 = `$${params.length}::text`;
    const day = `(date_trunc('day', now() AT TIME ZONE ${z0}) AT TIME ZONE ${z0})`;
    const week = `(date_trunc('week', now() AT TIME ZONE ${z0}) AT TIME ZONE ${z0})`;
    where.push({
      today: `a.starts_at >= ${day} AND a.starts_at < ${day} + interval '1 day'`,
      tomorrow: `a.starts_at >= ${day} + interval '1 day' AND a.starts_at < ${day} + interval '2 days'`,
      this_week: `a.starts_at >= ${week} AND a.starts_at < ${week} + interval '7 days'`,
      next_7: `a.starts_at >= now() AND a.starts_at < now() + interval '7 days'`,
      last_7: `a.starts_at < now() AND a.starts_at >= now() - interval '7 days'`,
      last_30: `a.starts_at < now() AND a.starts_at >= now() - interval '30 days'`,
      future: 'a.starts_at >= now()',
      past: 'a.starts_at < now()',
    }[q.when]);
  }
  if (q.from) add((p) => `a.starts_at >= ${p}::timestamptz`, q.from);
  if (q.to) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to)) add((p) => `a.starts_at < (${p}::date + 1)::timestamptz`, q.to);
    else add((p) => `a.starts_at <= ${p}::timestamptz`, q.to);
  }

  // Counts per tab: everything the filters allow, whichever tab is showing.
  const filtered = [...base, ...where].join(' AND ');
  const tabCounts = await queryOne<Record<Tab, number>>(
    `SELECT ${Object.entries(TABS).map(([k, sql]) => `count(*) FILTER (WHERE ${sql})::int AS ${k}`).join(', ')}
       FROM appointments a JOIN customers c ON c.id = a.customer_id
       LEFT JOIN applications app ON app.id = a.application_id LEFT JOIN users h ON h.id = a.user_id
       LEFT JOIN users b ON b.id = a.created_by
      WHERE ${filtered}`, params);

  // Upcoming reads soonest first; everything else, latest first.
  const dir = (q.dir ?? (q.tab === 'upcoming' && q.sort === 'starts_at' ? 'asc' : 'desc')) === 'asc' ? 'ASC' : 'DESC';
  const listParams = [...params, scope.actor.userId, q.page_size, (q.page - 1) * q.page_size];
  const meParam = `$${params.length + 1}::uuid`;
  const { rows } = await query<Row & { assigned_to_me: boolean }>(
    `${SELECT.replace('SELECT a.id,', `SELECT EXISTS (SELECT 1 FROM assignments x WHERE x.application_id = a.application_id
               AND x.user_id = ${meParam} AND x.unassigned_at IS NULL) AS assigned_to_me, a.id,`)}
      WHERE ${filtered} AND ${TABS[q.tab]}
      ORDER BY ${SORTS[q.sort]} ${dir} NULLS LAST, a.starts_at ${dir}, a.id
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams);

  return {
    appointments: rows.map((r) => shape(r, scope)),
    total: tabCounts?.[q.tab] ?? 0,
    tabs: tabCounts,
    timezone: zone,
  };
}

async function loadRow(organizationId: string, id: string, db: pg.Pool | pg.PoolClient | null = null): Promise<Row | null> {
  if (!UUID.test(id)) return null;
  const sql = `${SELECT} WHERE a.id = $1 AND a.organization_id = $2`;
  if (db) return (await db.query<Row>(sql, [id, organizationId])).rows[0] ?? null;
  return queryOne<Row>(sql, [id, organizationId]);
}

async function isAssigned(applicationId: string | null, userId: string | null): Promise<boolean> {
  if (!applicationId || !userId) return false;
  return !!(await queryOne(
    'SELECT 1 FROM assignments WHERE application_id = $1 AND user_id = $2 AND unassigned_at IS NULL',
    [applicationId, userId]));
}

/** Load one the scope may see; 404 otherwise — saying it exists is itself a disclosure. */
async function visible(scope: Scope, id: string): Promise<Row & { assigned_to_me: boolean }> {
  const row = await loadRow(scope.actor.organizationId, id);
  if (!row) throw notFound('That appointment');
  const assigned = await isAssigned(row.application_id, scope.actor.userId);
  if (!scope.viewAll && row.host_id !== scope.actor.userId && !assigned) throw notFound('That appointment');
  return { ...row, assigned_to_me: assigned };
}

async function manageable(scope: Scope, id: string) {
  const row = await visible(scope, id);
  if (!mayManageRow(scope, row)) {
    throw new AppError('You can see this appointment but not change it. Ask whoever hosts it, or an admin.', 403, 'forbidden');
  }
  return row;
}

export async function getAppointment(scope: Scope, id: string) {
  const row = await visible(scope, id);
  return shape(row, scope);
}

// ── What the booking form offers ───────────────────────────────────────────

export async function appointmentMeta(scope: Scope) {
  await ensureTemplates(scope.actor.organizationId);
  return {
    types: APPOINTMENT_TYPES,
    modes: MODES,
    statuses: STATUSES,
    durations: DURATIONS,
    reminder_minutes: REMINDER_MINUTES,
    timezone: await zoneOf(scope),
    can: { view_all: scope.viewAll, manage: scope.manage || scope.manageAll, manage_all: scope.manageAll },
    google: scope.actor.userId ? await googleStatus(scope.actor.organizationId, scope.actor.userId) : null,
    people: scope.viewAll ? await staffList(scope.actor.organizationId) : [],
  };
}

async function staffList(organizationId: string) {
  const { rows } = await query<{ id: string; name: string; active: boolean; archived: boolean }>(
    `SELECT id, name, active AND activated_at IS NOT NULL AS active, archived_at IS NOT NULL AS archived
       FROM users WHERE organization_id = $1 ORDER BY archived_at IS NULL DESC, active DESC, lower(name)`, [organizationId]);
  return rows;
}

type HostRow = {
  id: string; name: string; email: string; role: Role; permission_overrides: Record<string, boolean>;
  active: boolean; activated_at: Date | null; archived_at: Date | null; timezone: string | null;
};

const canHost = (u: HostRow) => u.active && !!u.activated_at && !u.archived_at
  && (can(u, 'appointment.manage') || can(u, 'appointment.manage_all'));

/** Who may be booked as the host: active staff who hold appointments. */
export async function bookableHosts(scope: Scope) {
  const { rows } = await query<HostRow>(
    `SELECT id, name, email, role, permission_overrides, active, activated_at, archived_at, timezone
       FROM users WHERE organization_id = $1 ORDER BY lower(name)`, [scope.actor.organizationId]);
  const hosts = rows.filter(canHost).filter((u) => scope.manageAll || u.id === scope.actor.userId);
  const google = await connectedUsers(hosts.map((h) => h.id));
  const { rows: open } = await query<{ user_id: string; n: number }>(
    `SELECT x.user_id, count(*)::int AS n FROM assignments x
       JOIN applications app ON app.id = x.application_id AND app.archived_at IS NULL
      WHERE x.unassigned_at IS NULL AND x.user_id = ANY($1::uuid[]) GROUP BY x.user_id`, [hosts.map((h) => h.id)]);
  return hosts.map((h) => ({
    id: h.id, name: h.name, role: h.role, timezone: h.timezone,
    google_connected: google.has(h.id), clients: open.find((o) => o.user_id === h.id)?.n ?? 0,
  }));
}

/**
 * The client files a meeting can be booked on for this host: their own
 * clients. An admin booking for themselves sees every file.
 */
export async function bookableFiles(scope: Scope, raw: unknown) {
  const q = z.object({
    host: z.string().uuid().optional(),
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  }).parse(raw ?? {});
  const host = q.host ?? scope.actor.userId;
  if (host !== scope.actor.userId && !scope.manageAll) {
    throw new AppError('Booking for somebody else needs the "Book & manage for anyone" permission.', 403, 'forbidden');
  }
  const everything = scope.manageAll && host === scope.actor.userId;
  const params: unknown[] = [scope.actor.organizationId, q.limit];
  let filter = '';
  if (!everything) {
    if (!host) return [];
    params.push(host);
    filter = `AND EXISTS (SELECT 1 FROM assignments x WHERE x.application_id = app.id AND x.user_id = $${params.length}
                            AND x.unassigned_at IS NULL)`;
  }
  if (q.q) {
    params.push(`%${q.q}%`);
    filter += ` AND concat_ws(' ', c.first_name, c.last_name, c.email, app.portal_reference) ILIKE $${params.length}`;
  }
  const { rows } = await query<{
    id: string; first_name: string | null; last_name: string | null; email: string | null; phone_e164: string | null;
    portal_reference: string | null; stage_label: string | null; category: string | null; pipeline_name: string | null;
  }>(
    `SELECT app.id, c.first_name, c.last_name, c.email, c.phone_e164, app.portal_reference,
            s.label AS stage_label, s.category, p.name AS pipeline_name
       FROM applications app JOIN customers c ON c.id = app.customer_id
       LEFT JOIN pipeline_stages s ON s.organization_id = app.organization_id AND s.key = app.stage_key
       LEFT JOIN pipelines p ON p.id = app.pipeline_id
      WHERE app.organization_id = $1 AND app.archived_at IS NULL AND c.merged_into_id IS NULL ${filter}
      ORDER BY (s.category IN ('won','lost')) NULLS FIRST, app.last_activity_at DESC NULLS LAST
      LIMIT $2`, params);
  return rows.map((r) => ({
    id: r.id, name: clientName(r), email: r.email, phone: r.phone_e164, reference: r.portal_reference,
    stage_label: r.stage_label, pipeline_name: r.pipeline_name, settled: r.category === 'won' || r.category === 'lost',
  }));
}

/** The host's day: CRM meetings and Google busy times, for the booking form. */
export async function availability(scope: Scope, raw: unknown) {
  const q = z.object({
    host: z.string().uuid().optional(),
    date: z.string().date(),
    timezone: z.string().max(60).optional(),
    exclude: z.string().uuid().optional(),
  }).parse(raw ?? {});
  const host = q.host ?? scope.actor.userId;
  if (!host) throw fieldError('host', 'Choose who the meeting is with.');
  if (host !== scope.actor.userId && !scope.manageAll) {
    throw new AppError('Only people who book for others can see their calendars.', 403, 'forbidden');
  }
  const zone = q.timezone && isValidZone(q.timezone) ? q.timezone : await zoneOf(scope);
  const from = localToInstant(q.date, '00:00', zone) ?? new Date(`${q.date}T00:00:00Z`);
  const to = new Date(from.getTime() + 86_400_000);
  const { rows } = await query<{ id: string; starts_at: Date; ends_at: Date; first_name: string | null; last_name: string | null; appointment_type: string; google_event_id: string | null }>(
    `SELECT a.id, a.starts_at, a.ends_at, c.first_name, c.last_name, a.appointment_type, a.google_event_id
       FROM appointments a JOIN customers c ON c.id = a.customer_id
      WHERE a.organization_id = $1 AND a.user_id = $2 AND a.status IN ('booked','confirmed')
        AND a.starts_at < $4 AND a.ends_at > $3 AND ($5::uuid IS NULL OR a.id <> $5)
      ORDER BY a.starts_at`, [scope.actor.organizationId, host, from, to, q.exclude ?? null]);
  const google = await busyFor(host, from, to);
  const crm = rows.map((r) => ({
    start: new Date(r.starts_at).toISOString(), end: new Date(r.ends_at).toISOString(),
    label: `${typeLabel(r.appointment_type)} — ${clientName(r)}`,
  }));
  // Google's busy list includes the CRM's own meetings; show each once.
  const others = (google ?? []).filter((b) => !rows.some((r) =>
    new Date(r.starts_at).getTime() === b.start.getTime() && new Date(r.ends_at).getTime() === b.end.getTime()));
  return {
    timezone: zone,
    crm,
    google: google === null ? null : others.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString(), label: 'Busy in Google Calendar' })),
    google_connected: google !== null,
  };
}

// ── Booking ────────────────────────────────────────────────────────────────

const optionalText = (max: number) => z.preprocess((v) => (typeof v === 'string' && !v.trim() ? null : v),
  z.string().trim().max(max, `At most ${max} characters.`).nullable().optional());

const TimeFields = {
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.').optional(),
  time: z.string().regex(/^\d{1,2}:\d{2}$/, 'Choose a time.').optional(),
  starts_at: z.string().datetime({ offset: true, message: 'An ISO date and time with its offset.' }).optional(),
  timezone: z.string().max(60).optional(),
  duration_minutes: z.coerce.number().int().min(5, 'At least 5 minutes.').max(480, 'At most 8 hours.').optional(),
};

const BookInput = z.object({
  application_id: z.string({ required_error: 'Choose the client file.' }).uuid('Choose the client file.'),
  user_id: z.string().uuid('Choose who the meeting is with.').nullable().optional(),
  appointment_type: z.enum(APPOINTMENT_TYPE_KEYS).default('discovery'),
  mode: z.enum(MODE_KEYS).default('video'),
  ...TimeFields,
  location: optionalText(300),
  meeting_url: z.preprocess((v) => (typeof v === 'string' && !v.trim() ? null : v),
    z.string().trim().url('A full link, starting https://').max(500).nullable().optional()),
  notes: optionalText(2000),
  notify_client: z.boolean().default(true),
  allow_conflict: z.boolean().default(false),
  follow_up_of: z.string().uuid().nullable().optional(),
}).strict();

const EditInput = BookInput.omit({ application_id: true, follow_up_of: true }).partial()
  .extend({ notify_client: z.boolean().default(true), allow_conflict: z.boolean().default(false) }).strict();

function startFrom(input: { date?: string; time?: string; starts_at?: string }, zone: string): Date {
  if (input.starts_at) return new Date(input.starts_at);
  if (!input.date) throw fieldError('date', 'Choose a date.');
  if (!input.time) throw fieldError('time', 'Choose a time.');
  const at = localToInstant(input.date, input.time, zone);
  if (!at) throw fieldError('time', 'That time does not exist on that day — the clocks change. Choose another.');
  return at;
}

async function loadHost(organizationId: string, id: string): Promise<HostRow> {
  const host = await queryOne<HostRow>(
    `SELECT id, name, email, role, permission_overrides, active, activated_at, archived_at, timezone
       FROM users WHERE id = $1 AND organization_id = $2`, [id, organizationId]);
  if (!host) throw fieldError('user_id', 'Choose who the meeting is with.');
  if (!canHost(host)) {
    throw fieldError('user_id', `${host.name} can't host appointments — they are inactive or don't have the appointments permission.`);
  }
  return host;
}

/**
 * Nothing overlapping in the CRM, and — unless the person booking says to
 * go ahead — nothing overlapping in the host's Google Calendar.
 */
async function checkClashes(organizationId: string, host: HostRow, startsAt: Date, endsAt: Date,
                            allowConflict: boolean, exceptId: string | null, exceptWindow?: { start: Date; end: Date }) {
  const clash = await queryOne<{ id: string; starts_at: Date; first_name: string | null; last_name: string | null }>(
    `SELECT a.id, a.starts_at, c.first_name, c.last_name FROM appointments a JOIN customers c ON c.id = a.customer_id
      WHERE a.organization_id = $1 AND a.user_id = $2 AND a.status IN ('booked','confirmed')
        AND a.starts_at < $4 AND a.ends_at > $3 AND ($5::uuid IS NULL OR a.id <> $5) LIMIT 1`,
    [organizationId, host.id, startsAt, endsAt, exceptId]);
  if (clash) {
    const zone = host.timezone && isValidZone(host.timezone) ? host.timezone : await orgZone(organizationId);
    throw new AppError(
      `${host.name} already has a meeting with ${clientName(clash)} at ${formatTime(new Date(clash.starts_at), zone)}. ` +
      'Choose another time, or move that one first.', 409, 'double_booked', { appointment_id: clash.id });
  }
  if (allowConflict) return;
  const busy = (await busyFor(host.id, startsAt, endsAt))?.filter((b) => !(exceptWindow
    && b.start.getTime() === exceptWindow.start.getTime() && b.end.getTime() === exceptWindow.end.getTime())) ?? [];
  if (busy.length) {
    const zone = host.timezone && isValidZone(host.timezone) ? host.timezone : await orgZone(organizationId);
    const b = busy[0]!;
    throw new AppError(
      `${host.name} is busy in Google Calendar from ${formatTime(b.start, zone)} to ${formatTime(b.end, zone)}. ` +
      'Book anyway, or choose another time.', 409, 'calendar_busy',
      { busy: busy.map((x) => ({ start: x.start.toISOString(), end: x.end.toISOString() })) });
  }
}

async function notify(organizationId: string, userId: string | null, title: string, body: string, appointmentId: string, key: string) {
  if (!userId) return;
  await query(
    `INSERT INTO notifications (organization_id, user_id, kind, title, body, link, entity_type, entity_id, dedupe_key)
     VALUES ($1,$2,'appointment',$3,$4,$5,'appointment',$6,$7) ON CONFLICT DO NOTHING`,
    [organizationId, userId, title, body, `/appointments?open=${appointmentId}`, appointmentId, key]);
}

async function timeline(client: pg.PoolClient, organizationId: string, row: { application_id: string | null; customer_id: string },
                        actor: Actor, summary: string, appointmentId: string) {
  if (!row.application_id) return;
  await client.query(
    `INSERT INTO activity (organization_id, application_id, customer_id, kind, actor_user_id, actor_name,
                           actor_kind, summary, entity_type, entity_id)
     VALUES ($1,$2,$3,'appointment',$4,$5,$6,$7,'appointment',$8)`,
    [organizationId, row.application_id, row.customer_id, actor.userId, actor.name,
     actor.kind === 'integration' ? 'integration' : 'user', summary, appointmentId]);
  await client.query('UPDATE applications SET last_activity_at = now() WHERE id = $1', [row.application_id]);
}

async function domainEvent(client: pg.PoolClient, organizationId: string, eventType: string,
                           row: { customer_id: string; application_id: string | null }, actor: Actor,
                           payload: Record<string, unknown>, dedupeKey: string) {
  await client.query(
    `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id, actor_user_id, payload, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (dedupe_key) DO NOTHING`,
    [organizationId, eventType, row.customer_id, row.application_id, actor.userId, JSON.stringify(payload), dedupeKey]);
}

export async function refreshNextAppointment(applicationId: string | null): Promise<void> {
  if (!applicationId) return;
  await query(
    `UPDATE applications SET next_appointment_at = (
        SELECT min(starts_at) FROM appointments
         WHERE application_id = $1 AND status IN ('booked','confirmed') AND starts_at > now())
      WHERE id = $1`, [applicationId]);
}

const whenText = (at: Date, zone: string) => `${formatDay(at, zone)} at ${formatTime(at, zone)}`;

export async function bookAppointment(scope: Scope, raw: unknown) {
  if (!scope.manage && !scope.manageAll) {
    throw new AppError('Booking appointments needs the appointments permission.', 403, 'forbidden');
  }
  const input = BookInput.parse(raw);
  const org = scope.actor.organizationId;

  const file = await queryOne<{ id: string; customer_id: string; primary_broker: string | null; archived_at: Date | null }>(
    `SELECT app.id, app.customer_id, app.archived_at,
            (SELECT user_id FROM assignments x WHERE x.application_id = app.id AND x.unassigned_at IS NULL
              ORDER BY (x.role = 'broker') DESC, x.is_primary DESC LIMIT 1) AS primary_broker
       FROM applications app WHERE app.id = $1 AND app.organization_id = $2`, [input.application_id, org]);
  if (!file || file.archived_at) throw fieldError('application_id', 'Choose the client file.');
  if (!scope.manageAll && !(await isAssigned(file.id, scope.actor.userId))) {
    throw fieldError('application_id', 'You can only book meetings with your own clients.');
  }

  const hostId = input.user_id ?? (scope.actor.kind === 'user' ? scope.actor.userId : file.primary_broker);
  if (!hostId) throw fieldError('user_id', 'Choose who the meeting is with — this file has nobody assigned.');
  if (hostId !== scope.actor.userId && !scope.manageAll) {
    throw new AppError('Booking for somebody else needs the "Book & manage for anyone" permission.', 403, 'forbidden');
  }
  const host = await loadHost(org, hostId);
  if (hostId !== scope.actor.userId && !(await isAssigned(file.id, hostId))) {
    throw fieldError('application_id', `That file isn't assigned to ${host.name}. Assign it to them first, or choose another host.`);
  }

  const zone = input.timezone && isValidZone(input.timezone) ? input.timezone
    : host.timezone && isValidZone(host.timezone) ? host.timezone : await orgZone(org);
  const startsAt = startFrom(input, zone);
  if (startsAt.getTime() < Date.now() - 60_000) throw fieldError('time', 'That time has already passed.');
  const minutes = input.duration_minutes ?? APPOINTMENT_TYPES.find((t) => t.key === input.appointment_type)?.minutes ?? 30;
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);

  if (input.mode === 'in_person' && !input.location) throw fieldError('location', 'Where are you meeting? Add the address.');
  const hostGoogle = (await connectedUsers([host.id])).has(host.id);
  if (input.mode === 'video' && !input.meeting_url && !hostGoogle) {
    throw fieldError('meeting_url', `Add the video link. ${host.name} hasn't connected Google Calendar, so no Meet link can be made.`);
  }

  await checkClashes(org, host, startsAt, endsAt, input.allow_conflict, null);

  let followUp: { id: string } | null = null;
  if (input.follow_up_of) {
    followUp = await queryOne<{ id: string }>(
      'SELECT id FROM appointments WHERE id = $1 AND organization_id = $2 AND application_id = $3',
      [input.follow_up_of, org, file.id]);
  }

  const id = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO appointments (organization_id, application_id, customer_id, user_id, appointment_type, mode,
                                 starts_at, ends_at, timezone, location, meeting_url, notes, status,
                                 rescheduled_from_id, created_by, updated_by, time_set_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'booked',$13,$14,$14,now()) RETURNING id`,
      [org, file.id, file.customer_id, host.id, input.appointment_type, input.mode, startsAt, endsAt, zone,
       input.location ?? null, input.meeting_url ?? null, input.notes ?? null, followUp?.id ?? null, scope.actor.userId]);
    const newId = rows[0]!.id;
    const row = { customer_id: file.customer_id, application_id: file.id };
    await domainEvent(client, org, 'appointment.booked', row, scope.actor,
                      { appointment_id: newId, starts_at: startsAt.toISOString(), rebooked_from: followUp?.id ?? null },
                      `appointment.booked:${newId}`);
    const summary = `${typeLabel(input.appointment_type)} booked with ${host.name} for ${whenText(startsAt, zone)}`;
    await timeline(client, org, row, scope.actor, summary, newId);
    await recordAudit({
      organizationId: org, actor: auditActor(scope.actor),
      action: followUp ? 'appointment.rebook' : 'appointment.book',
      entityType: 'appointment', entityId: newId, applicationId: file.id,
      summary, after: { ...input, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), timezone: zone },
    }, client);
    return newId;
  });

  if (host.id !== scope.actor.userId) {
    await notify(org, host.id, `${scope.actor.name} booked a meeting for you`,
                 `${typeLabel(input.appointment_type)}, ${whenText(startsAt, zone)}`, id, `appointment.booked:${id}`);
  }
  return afterChange(scope, id, { stage: 'booked', email: input.notify_client ? 'appointment_confirmation' : null });
}

/**
 * What every change is followed by, outside the transaction: the file's
 * stage, Google, the client's email, the file's next-appointment date.
 * Each reports what it did, so the screen can say it.
 */
async function afterChange(scope: Scope, id: string, what: { stage?: 'booked' | 'attended' | 'missed'; email: TemplateKey | null }) {
  const org = scope.actor.organizationId;
  let row = (await loadRow(org, id))!;
  const result: {
    stage: { moved_to: string | null; moved_key: string | null; note: string | null } | null;
    google: { synced: boolean; error: string | null } | null;
    email: { status: string; reason: string | null } | null;
  } = { stage: null, google: null, email: null };

  if (what.stage) result.stage = await moveForAppointment(scope.actor, row, what.stage);

  result.google = await syncToGoogle(row);
  row = (await loadRow(org, id))!;

  if (what.email) result.email = await emailClient(row, what.email, scope.actor);
  await refreshNextAppointment(row.application_id);
  return { appointment: shape((await loadRow(org, id))!, scope), ...result };
}

async function eventInput(row: Row, organizationId: string): Promise<EventInput> {
  const org = await queryOne<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [organizationId]);
  return {
    appointmentId: row.id,
    summary: `${typeLabel(row.appointment_type)} — ${clientName(row)}${org?.name ? ` (${org.name})` : ''}`,
    description: [
      `${typeLabel(row.appointment_type)} with ${clientName(row)}.`,
      row.client_phone ? `Client phone: ${row.client_phone}` : null,
      row.mode === 'phone' ? `Phone call${row.location ? ` — ${row.location}` : ''}.` : null,
      row.meeting_url && !row.meeting_url.startsWith('https://meet.google.com/') ? `Video link: ${row.meeting_url}` : null,
      row.application_id ? `Client file: ${env.PUBLIC_URL.replace(/\/$/, '')}/applications/${row.application_id}` : null,
      'Booked in Lendmax CRM.',
    ].filter(Boolean).join('\n'),
    location: row.mode === 'in_person' ? row.location : row.mode === 'phone' ? (row.location ?? row.client_phone) : null,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    timezone: row.timezone,
    attendees: row.client_email ? [{ email: row.client_email, name: clientName(row) }] : [],
    // A link somebody typed (Zoom, Teams) is kept; otherwise Google makes a Meet.
    meet: row.mode === 'video' && (!row.meeting_url || row.meeting_url.startsWith('https://meet.google.com/')),
  };
}

async function pushRow(row: Row) {
  const target = await queryOne<PushTarget>(
    `SELECT id, organization_id, status, user_id, google_event_id, google_owner_id, google_calendar_id, meeting_url, mode
       FROM appointments WHERE id = $1`, [row.id]);
  if (!target) return { synced: false, error: null };
  const pushed = await pushAppointment(target, await eventInput(row, target.organization_id));
  return { synced: pushed.synced, error: pushed.error, organizationId: target.organization_id };
}

async function syncToGoogle(row: Row): Promise<{ synced: boolean; error: string | null } | null> {
  if (!row.host_google_connected && !row.google_event_id) return null;
  const pushed = await pushRow(row);
  if (pushed.error) {
    // Retried in the background; the booking itself stands.
    await enqueue('google.push', { appointmentId: row.id }, {
      organizationId: pushed.organizationId, runAfter: new Date(Date.now() + 60_000),
      dedupeKey: `google.push:${row.id}`, maxAttempts: 6,
    });
  }
  return { synced: pushed.synced, error: pushed.error };
}

/** Push again after a failure. The google.push job and the "Retry" button. */
export async function retryGooglePush(appointmentId: string): Promise<{ synced: boolean; error: string | null } | null> {
  const row = await queryOne<Row>(`${SELECT} WHERE a.id = $1`, [appointmentId]);
  if (!row) return null;
  const pushed = await pushRow(row);
  return { synced: pushed.synced, error: pushed.error };
}

export async function retryGoogle(scope: Scope, id: string) {
  const row = await manageable(scope, id);
  const result = await retryGooglePush(row.id);
  return { appointment: shape((await loadRow(scope.actor.organizationId, id))!, scope), google: result };
}

// ── Moving the file ────────────────────────────────────────────────────────

async function moveForAppointment(actor: Actor, row: Row, event: 'booked' | 'attended' | 'missed') {
  if (!row.application_id) return { moved_to: null, moved_key: null, note: null };
  const settings = await queryOne<{ stage_key: string; booked: string | null; attended: string | null; missed: string | null }>(
    `SELECT app.stage_key, p.appointment_booked_stage_key AS booked, p.appointment_attended_stage_key AS attended,
            p.appointment_missed_stage_key AS missed
       FROM applications app JOIN pipelines p ON p.id = app.pipeline_id WHERE app.id = $1`, [row.application_id]);
  if (!settings) return { moved_to: null, moved_key: null, note: null };
  const stages = await loadStages(actor.organizationId);
  const ref = (key: string | null): StageRef | null => {
    const s = key ? stages.find((x) => x.key === key) : null;
    return s ? { key: s.key, label: s.label, position: s.position, category: s.category, pipeline_id: s.pipeline_id } : null;
  };
  const current = ref(settings.stage_key);
  const booked = ref(settings.booked);
  const decision = event === 'booked'
    ? bookingMove({ current, booked, missedKey: settings.missed })
    : outcomeMove({ current, target: ref(event === 'attended' ? settings.attended : settings.missed), booked, outcome: event });
  if ('skip' in decision) return { moved_to: null, moved_key: null, note: decision.skip };

  const target = stages.find((s) => s.key === decision.move.key)!;
  if (!target.active) return { moved_to: null, moved_key: null, note: `${target.label} is switched off, so the file stays where it is.` };
  const when = whenText(new Date(row.starts_at), row.timezone);
  const reason = event === 'booked' ? `Appointment booked for ${when}`
    : event === 'attended' ? `Attended the appointment on ${when}` : `Missed the appointment on ${when}`;
  try {
    const moved = await moveFileToStage(actor, row.application_id, { stage_key: target.key, reason }, { mayForce: false });
    return moved.ok ? { moved_to: target.label, moved_key: target.key, note: null }
      : { moved_to: null, moved_key: null, note: moved.message };
  } catch (err) {
    return { moved_to: null, moved_key: null, note: `The file couldn't move to ${target.label}: ${(err as Error).message}` };
  }
}

// ── Changing ───────────────────────────────────────────────────────────────

export async function updateAppointment(scope: Scope, id: string, raw: unknown) {
  const input = EditInput.parse(raw ?? {});
  const org = scope.actor.organizationId;
  const row = await manageable(scope, id);
  const open = OPEN_STATUSES.includes(row.status as never);
  const onlyNotes = Object.keys(input).every((k) => ['notes', 'notify_client', 'allow_conflict'].includes(k));
  if (!open && !onlyNotes) {
    throw new AppError(`This appointment is ${statusLabel(row.status).toLowerCase()}, so only its notes can change. Book a new one instead.`,
                       409, 'not_open');
  }

  const hostId = input.user_id ?? row.host_id!;
  if (hostId !== row.host_id && !scope.manageAll) {
    throw new AppError('Changing who hosts a meeting needs the "Book & manage for anyone" permission.', 403, 'forbidden');
  }
  const host = await loadHost(org, hostId);
  if (hostId !== row.host_id && !(await isAssigned(row.application_id, hostId))) {
    throw fieldError('user_id', `That file isn't assigned to ${host.name}. Assign it to them first.`);
  }

  const zone = input.timezone && isValidZone(input.timezone) ? input.timezone : row.timezone;
  const timeGiven = input.starts_at || input.date || input.time;
  const current = { start: new Date(row.starts_at), end: new Date(row.ends_at) };
  const startsAt = timeGiven
    ? startFrom({
        starts_at: input.starts_at,
        date: input.date ?? (input.time ? localDate(current.start, zone) : undefined),
        time: input.time ?? (input.date ? localTime(current.start, zone) : undefined),
      }, zone)
    : current.start;
  const minutes = input.duration_minutes ?? Math.round((current.end.getTime() - current.start.getTime()) / 60_000);
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
  const moved = startsAt.getTime() !== current.start.getTime() || endsAt.getTime() !== current.end.getTime()
    || zone !== row.timezone;
  if (moved && startsAt.getTime() < Date.now() - 60_000) throw fieldError('time', 'That time has already passed.');

  const mode = input.mode ?? row.mode;
  const location = input.location !== undefined ? input.location : row.location;
  const meetingUrl = input.meeting_url !== undefined ? input.meeting_url : row.meeting_url;
  if (mode === 'in_person' && !location) throw fieldError('location', 'Where are you meeting? Add the address.');
  if (mode === 'video' && !meetingUrl && !(await connectedUsers([host.id])).has(host.id)) {
    throw fieldError('meeting_url', `Add the video link. ${host.name} hasn't connected Google Calendar, so no Meet link can be made.`);
  }
  if (moved || hostId !== row.host_id) {
    await checkClashes(org, host, startsAt, endsAt, input.allow_conflict, id, hostId === row.host_id ? current : undefined);
  }

  const changed: string[] = [];
  if (moved) changed.push(`moved to ${whenText(startsAt, zone)}`);
  if (hostId !== row.host_id) changed.push(`now with ${host.name}`);
  if (input.appointment_type && input.appointment_type !== row.appointment_type) changed.push(`now a ${typeLabel(input.appointment_type).toLowerCase()}`);
  if (mode !== row.mode) changed.push(`now a ${modeLabel(mode).toLowerCase()}`);
  if (location !== row.location) changed.push('place changed');
  if (meetingUrl !== row.meeting_url) changed.push('video link changed');
  if (input.notes !== undefined && input.notes !== row.notes) changed.push('notes changed');
  if (!changed.length) return { appointment: shape(row, scope), stage: null, google: null, email: null };

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE appointments SET user_id = $2, appointment_type = $3, mode = $4, starts_at = $5, ends_at = $6,
              timezone = $7, location = $8, meeting_url = $9, notes = $10, updated_by = $11,
              time_set_at = CASE WHEN $12 THEN now() ELSE time_set_at END,
              reminder_sent_at = CASE WHEN $12 THEN NULL ELSE reminder_sent_at END,
              reschedule_count = reschedule_count + CASE WHEN $12 THEN 1 ELSE 0 END,
              status = CASE WHEN $12 THEN 'booked' ELSE status END,
              confirmed_at = CASE WHEN $12 THEN NULL ELSE confirmed_at END
        WHERE id = $1`,
      [id, host.id, input.appointment_type ?? row.appointment_type, mode, startsAt, endsAt, zone,
       location, mode === 'video' ? meetingUrl : (input.meeting_url !== undefined ? input.meeting_url : null),
       input.notes !== undefined ? input.notes : row.notes, scope.actor.userId, moved]);
    if (moved) await client.query('DELETE FROM appointment_prompt_snoozes WHERE appointment_id = $1', [id]);
    const summary = `${typeLabel(input.appointment_type ?? row.appointment_type)} with ${clientName(row)} — ${changed.join(', ')}`;
    await timeline(client, org, row, scope.actor, summary, id);
    await recordAudit({
      organizationId: org, actor: auditActor(scope.actor),
      action: moved ? 'appointment.reschedule' : 'appointment.update',
      entityType: 'appointment', entityId: id, applicationId: row.application_id, summary,
      before: { starts_at: row.starts_at, ends_at: row.ends_at, host: row.host_id, mode: row.mode, type: row.appointment_type },
      after: { starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), host: host.id, mode, type: input.appointment_type },
    }, client);
  });

  if (hostId !== row.host_id) {
    await notify(org, host.id, `${scope.actor.name} gave you a meeting`, `${clientName(row)}, ${whenText(startsAt, zone)}`, id, `appointment.host:${id}:${Date.now()}`);
  } else if (moved && row.host_id !== scope.actor.userId) {
    await notify(org, row.host_id, `${scope.actor.name} moved your meeting`, `${clientName(row)} — now ${whenText(startsAt, zone)}`, id, `appointment.moved:${id}:${Date.now()}`);
  }
  const clientVisible = moved || mode !== row.mode || location !== row.location || meetingUrl !== row.meeting_url || hostId !== row.host_id;
  if (!clientVisible) return afterChange(scope, id, { email: null });
  return afterChange(scope, id, { email: input.notify_client && moved ? 'appointment_rescheduled' : null });
}

const localDate = (at: Date, zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const localTime = (at: Date, zone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

export async function cancelAppointment(scope: Scope, id: string, raw: unknown) {
  const input = z.object({
    reason: z.string({ required_error: 'Say why it was cancelled.' }).trim().min(2, 'Say why it was cancelled.').max(500),
    notify_client: z.boolean().default(true),
  }).strict().parse(raw ?? {});
  const org = scope.actor.organizationId;
  const row = await manageable(scope, id);
  if (!OPEN_STATUSES.includes(row.status as never)) {
    throw new AppError(`This appointment is already ${statusLabel(row.status).toLowerCase()}.`, 409, 'not_open');
  }
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = now(), cancelled_reason = $2, updated_by = $3 WHERE id = $1`,
      [id, input.reason, scope.actor.userId]);
    const summary = `${typeLabel(row.appointment_type)} with ${clientName(row)} on ${whenText(new Date(row.starts_at), row.timezone)} cancelled — ${input.reason}`;
    await timeline(client, org, row, scope.actor, summary, id);
    await recordAudit({
      organizationId: org, actor: auditActor(scope.actor), action: 'appointment.cancel',
      entityType: 'appointment', entityId: id, applicationId: row.application_id, summary,
    }, client);
  });
  if (row.host_id && row.host_id !== scope.actor.userId) {
    await notify(org, row.host_id, `${scope.actor.name} cancelled your meeting`,
                 `${clientName(row)}, ${whenText(new Date(row.starts_at), row.timezone)}`, id, `appointment.cancelled:${id}`);
  }
  return afterChange(scope, id, { email: input.notify_client ? 'appointment_cancelled' : null });
}

export async function confirmAppointment(scope: Scope, id: string) {
  const row = await manageable(scope, id);
  if (row.status !== 'booked') throw new AppError(`This appointment is ${statusLabel(row.status).toLowerCase()}.`, 409, 'not_open');
  await withTransaction(async (client) => {
    await client.query(`UPDATE appointments SET status = 'confirmed', confirmed_at = now(), updated_by = $2 WHERE id = $1`,
                       [id, scope.actor.userId]);
    await recordAudit({
      organizationId: scope.actor.organizationId, actor: auditActor(scope.actor), action: 'appointment.confirmed',
      entityType: 'appointment', entityId: id, applicationId: row.application_id,
      summary: `${clientName(row)} confirmed the ${typeLabel(row.appointment_type).toLowerCase()} on ${whenText(new Date(row.starts_at), row.timezone)}`,
    }, client);
  });
  return getAppointment(scope, id);
}

/**
 * Attended or missed. Only once the meeting has started; a mistake can be
 * corrected by recording the other outcome, which moves the file again.
 */
export async function recordOutcome(scope: Scope, id: string, raw: unknown) {
  const input = z.object({
    outcome: z.enum(['attended', 'missed'], { required_error: 'Did they attend?' }),
    note: z.string().trim().max(2000).optional(),
  }).strict().parse(raw ?? {});
  const org = scope.actor.organizationId;
  const row = await manageable(scope, id);
  const status = input.outcome === 'attended' ? 'completed' : 'no_show';
  if (row.status === status) return { appointment: shape(row, scope), stage: null, google: null, email: null };
  if (!['booked', 'confirmed', 'completed', 'no_show'].includes(row.status)) {
    throw new AppError(`This appointment was ${statusLabel(row.status).toLowerCase()}, so it has no outcome.`, 409, 'not_open');
  }
  if (new Date(row.starts_at).getTime() > Date.now()) {
    throw new AppError("This meeting hasn't started yet, so there's no outcome to record.", 409, 'not_started');
  }
  const eventType = status === 'completed' ? 'appointment.completed' : 'appointment.no_show';
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE appointments SET status = $2, outcome = COALESCE($3, outcome), outcome_at = now(), outcome_by = $4,
              no_show_at = CASE WHEN $2 = 'no_show' THEN now() ELSE NULL END, updated_by = $4
        WHERE id = $1`, [id, status, input.note ?? null, scope.actor.userId]);
    await client.query('DELETE FROM appointment_prompt_snoozes WHERE appointment_id = $1', [id]);
    await domainEvent(client, org, eventType, row, scope.actor, { appointment_id: id }, `${eventType}:${id}`);
    const summary = `${clientName(row)} ${input.outcome === 'attended' ? 'attended' : 'missed'} the ${typeLabel(row.appointment_type).toLowerCase()} on ${whenText(new Date(row.starts_at), row.timezone)}`
      + (input.note ? ` — ${input.note}` : '');
    await timeline(client, org, row, scope.actor, summary, id);
    await recordAudit({
      organizationId: org, actor: auditActor(scope.actor),
      action: input.outcome === 'attended' ? 'appointment.attended' : 'appointment.missed',
      entityType: 'appointment', entityId: id, applicationId: row.application_id, summary,
    }, client);
  });
  const result = await afterChange(scope, id, { stage: input.outcome, email: null });
  await query('UPDATE appointments SET outcome_stage_key = $2, outcome_stage_note = $3 WHERE id = $1',
              [id, result.stage?.moved_key ?? null, result.stage?.note ?? null]);
  return { ...result, appointment: shape((await loadRow(org, id))!, scope) };
}

// ── The popup ──────────────────────────────────────────────────────────────

/** Meetings this person is running or booked that have started and have no outcome yet. */
export async function promptsFor(scope: Scope) {
  if (!scope.actor.userId) return [];
  const { rows } = await query<Row & { snoozed_until: Date | null; booked_by_me: boolean }>(
    `${SELECT.replace('SELECT a.id,', 'SELECT s.until AS snoozed_until, (a.created_by = $2 AND a.user_id <> $2) AS booked_by_me, a.id,')}
      LEFT JOIN appointment_prompt_snoozes s ON s.appointment_id = a.id AND s.user_id = $2
      WHERE a.organization_id = $1 AND a.status IN ('booked','confirmed')
        AND (a.user_id = $2 OR a.created_by = $2)
        AND a.starts_at <= now() AND a.starts_at > now() - make_interval(hours => $3)
      ORDER BY a.starts_at`,
    [scope.actor.organizationId, scope.actor.userId, PROMPT_WINDOW_HOURS]);
  const now = new Date();
  return rows
    .map((r) => ({ row: r, phase: promptPhase({ status: r.status, starts_at: new Date(r.starts_at), ends_at: new Date(r.ends_at) }, now, r.snoozed_until) }))
    .filter((p) => p.phase)
    .map(({ row, phase }) => ({ ...shape(row, { ...scope, manage: true }), prompt: phase, booked_by_me: row.booked_by_me }));
}

export async function snoozePrompt(scope: Scope, id: string, raw: unknown) {
  const { until } = z.object({ until: z.enum(['end', 'later']) }).strict().parse(raw ?? {});
  const row = await visible(scope, id);
  const at = until === 'end' && new Date(row.ends_at) > new Date()
    ? new Date(row.ends_at) : new Date(Date.now() + PROMPT_SNOOZE_MINUTES * 60_000);
  await query(
    `INSERT INTO appointment_prompt_snoozes (appointment_id, user_id, until) VALUES ($1,$2,$3)
     ON CONFLICT (appointment_id, user_id) DO UPDATE SET until = EXCLUDED.until`, [id, scope.actor.userId, at]);
  return { until: at.toISOString() };
}

// ── Emails ─────────────────────────────────────────────────────────────────

/** The four client emails exist as templates for every organization. */
export async function ensureTemplates(organizationId?: string): Promise<void> {
  for (const t of DEFAULT_TEMPLATES) {
    const fields = [...new Set([...`${t.subject} ${t.body}`.matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]!))];
    await query(
      `INSERT INTO templates (organization_id, key, name, channel, kind, purpose, subject, body_text, merge_fields)
       SELECT o.id, $1, $2, 'email', 'appointment', 'transactional', $3, $4, $5 FROM organizations o
        WHERE $6::uuid IS NULL OR o.id = $6
       ON CONFLICT (organization_id, key) DO NOTHING`,
      [t.key, t.name, t.subject, t.body, fields, organizationId ?? null]);
  }
}

const SIGNATURE_MARK = '[[LMX-SIGNATURE]]';

async function emailClient(row: Row, key: TemplateKey, actor: Actor | null): Promise<{ status: string; reason: string | null }> {
  const org = (await queryOne<{ organization_id: string }>('SELECT organization_id FROM appointments WHERE id = $1', [row.id]))!.organization_id;
  await ensureTemplates(org);
  const template = await queryOne<{ subject: string | null; body_text: string | null; active: boolean }>(
    'SELECT subject, body_text, active FROM templates WHERE organization_id = $1 AND key = $2', [org, key]);
  if (!template?.active) return { status: 'skipped', reason: 'That email template is switched off under Settings → Templates.' };
  if (!row.client_email) return { status: 'skipped', reason: 'The client has no email address.' };

  const at = new Date(row.starts_at);
  const orgRow = await queryOne<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [org]);
  const signature = await signatureFor(row.host_id);
  const values: Record<string, unknown> = {
    first_name: row.first_name, last_name: row.last_name,
    user_name: row.host_name, user_first_name: row.host_name?.split(' ')[0] ?? null,
    organization_name: orgRow?.name ?? null,
    portal_reference: row.portal_reference,
    appointment_date: formatDay(at, row.timezone),
    appointment_time: formatTime(at, row.timezone),
    appointment_type: typeLabel(row.appointment_type).toLowerCase(),
    appointment_duration: formatDuration(Math.round((new Date(row.ends_at).getTime() - at.getTime()) / 60_000)),
    appointment_where: whereText({ mode: row.mode, location: row.location, meeting_url: row.meeting_url, host_name: row.host_name, client_phone: row.client_phone }),
    appointment_link: row.meeting_url,
    appointment_host: row.host_name,
    signature: SIGNATURE_MARK,
  };
  const subject = template.subject ? renderTemplate(template.subject, { values }).text : typeLabel(row.appointment_type);
  const body = renderTemplate(template.body_text ?? '', { values });
  if (body.empty) return { status: 'skipped', reason: 'The template rendered nothing.' };
  const text = body.text.replace(SIGNATURE_MARK, signature?.text ?? '').trim();
  const html = textToHtml(body.text)
    .replace(new RegExp(`<p[^>]*>${SIGNATURE_MARK.replace(/[[\]]/g, '\\$&')}</p>`), signature?.html ?? '')
    .replace(SIGNATURE_MARK, signature?.html ?? '');
  const dedupe = key === 'appointment_reminder' ? `${key}:${row.id}:${at.getTime()}`
    : key === 'appointment_rescheduled' ? `${key}:${row.id}:${row.reschedule_count}` : `${key}:${row.id}`;
  try {
    const outcome = await send({
      organizationId: org, customerId: row.customer_id, applicationId: row.application_id,
      channel: 'email', purpose: 'transactional', subject, bodyText: text, bodyHtml: html,
      origin: 'system', sentBy: actor?.userId ?? row.host_id, templateKey: key,
      mergeSnapshot: { ...values, signature: signature ? '(signature)' : null }, dedupeKey: dedupe, urgent: true,
    });
    return { status: outcome.status, reason: outcome.ok ? null : outcome.error ?? outcome.decision.reason ?? null };
  } catch (err) {
    log.error('appointment email failed', { appointmentId: row.id, key, error: err });
    return { status: 'failed', reason: (err as Error).message };
  }
}

async function remindHost(row: Row): Promise<void> {
  if (!row.host_id || !row.host_email) return;
  const org = (await queryOne<{ organization_id: string }>('SELECT organization_id FROM appointments WHERE id = $1', [row.id]))!.organization_id;
  const hostZone = (await queryOne<{ timezone: string | null }>('SELECT timezone FROM users WHERE id = $1', [row.host_id]))?.timezone;
  const zone = hostZone && isValidZone(hostZone) ? hostZone : row.timezone;
  const at = new Date(row.starts_at);
  const link = row.application_id ? `${env.PUBLIC_URL.replace(/\/$/, '')}/applications/${row.application_id}` : null;
  const text = [
    `Your ${typeLabel(row.appointment_type).toLowerCase()} with ${clientName(row)} starts at ${formatTime(at, zone)} (in ${REMINDER_MINUTES} minutes).`,
    '',
    row.mode === 'video' ? (row.meeting_url ? `Video call: ${row.meeting_url}` : 'Video call — no link on the appointment.')
      : row.mode === 'phone' ? `Phone call: ${row.location ?? row.client_phone ?? 'no number on file'}`
        : `In person: ${row.location ?? 'no address on the appointment'}`,
    row.client_phone ? `Client phone: ${row.client_phone}` : null,
    row.client_email ? `Client email: ${row.client_email}` : null,
    row.notes ? `Notes: ${row.notes}` : null,
    link ? `\nClient file: ${link}` : null,
  ].filter((l) => l !== null).join('\n');
  const result = await sendEmail(org, {
    to: row.host_email, subject: `In ${REMINDER_MINUTES} minutes: ${typeLabel(row.appointment_type)} with ${clientName(row)}`,
    text, html: textToHtml(text), idempotencyKey: `appointment.host_reminder:${row.id}:${at.getTime()}`,
  });
  if (!result.ok) log.warn('host reminder not sent', { appointmentId: row.id, error: result.error });
  await notify(org, row.host_id, `In ${REMINDER_MINUTES} minutes: ${clientName(row)}`,
               `${typeLabel(row.appointment_type)} at ${formatTime(at, zone)}`, row.id, `appointment.reminder:${row.id}:${at.getTime()}`);
}

// ── The clock ──────────────────────────────────────────────────────────────

/**
 * Every minute: the 15-minute reminders, to the client and the host, once per
 * time the meeting is set for — and only if it was set before the reminder
 * was due, so a meeting booked for ten minutes from now is not "reminded"
 * seconds after its confirmation.
 */
export async function runAppointmentTick(): Promise<{ reminded: number }> {
  const { rows } = await query<{ id: string; organization_id: string }>(
    `UPDATE appointments SET reminder_sent_at = now()
      WHERE status IN ('booked','confirmed') AND reminder_sent_at IS NULL
        AND starts_at > now() AND starts_at <= now() + make_interval(mins => $1)
        AND time_set_at <= starts_at - make_interval(mins => $1)
      RETURNING id, organization_id`, [REMINDER_MINUTES]);
  for (const { id, organization_id } of rows) {
    const row = await loadRow(organization_id, id);
    if (!row) continue;
    await emailClient(row, 'appointment_reminder', null).catch((err) =>
      log.error('client reminder failed', { appointmentId: id, error: err }));
    await remindHost(row).catch((err) => log.error('host reminder failed', { appointmentId: id, error: err }));
  }
  // A file's "next appointment" that has passed moves on to the one after.
  await query(
    `UPDATE applications app SET next_appointment_at = (
        SELECT min(starts_at) FROM appointments a
         WHERE a.application_id = app.id AND a.status IN ('booked','confirmed') AND a.starts_at > now())
      WHERE app.next_appointment_at IS NOT NULL AND app.next_appointment_at <= now()`);
  return { reminded: rows.length };
}

/**
 * Apply what changed in each connected Google Calendar: a meeting deleted
 * there is cancelled here; a meeting moved there is moved here, and its
 * reminder re-armed. Google has already told the client, so no email.
 */
export async function syncGoogleCalendars(): Promise<{ applied: number }> {
  let applied = 0;
  for (const account of await connectedAccounts()) {
    try {
      applied += await syncOne(account.user_id, account.organization_id, account.name);
    } catch (err) {
      log.warn('google sync failed', { userId: account.user_id, error: (err as Error).message });
    }
  }
  return { applied };
}

export async function syncOne(userId: string, organizationId: string, name: string): Promise<number> {
  const changes = await changesFor(userId);
  if (!changes) return 0;
  let applied = 0;
  const actor: Actor = { organizationId, kind: 'integration', userId: null, name: `Google Calendar (${name})` };
  for (const event of changes.events) {
    const row = await queryOne<Row>(
      `${SELECT} WHERE a.organization_id = $1 AND a.google_event_id = $2 AND a.google_owner_id = $3
         AND a.status IN ('booked','confirmed')`, [organizationId, event.id, userId]);
    if (!row) continue;
    if (event.status === 'cancelled') {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE appointments SET status = 'cancelled', cancelled_at = now(),
                  cancelled_reason = 'Cancelled in Google Calendar' WHERE id = $1`, [row.id]);
        const summary = `${typeLabel(row.appointment_type)} with ${clientName(row)} on ${whenText(new Date(row.starts_at), row.timezone)} cancelled in Google Calendar`;
        await timeline(client, organizationId, row, actor, summary, row.id);
        await recordAudit({ organizationId, actor: auditActor(actor), action: 'appointment.google_sync',
                            entityType: 'appointment', entityId: row.id, applicationId: row.application_id, summary }, client);
      });
      await refreshNextAppointment(row.application_id);
      applied++;
      continue;
    }
    if (!event.startsAt || !event.endsAt) continue;
    const same = event.startsAt.getTime() === new Date(row.starts_at).getTime()
      && event.endsAt.getTime() === new Date(row.ends_at).getTime();
    if (same) continue;
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE appointments SET starts_at = $2, ends_at = $3, time_set_at = now(), reminder_sent_at = NULL,
                reschedule_count = reschedule_count + 1, status = 'booked', confirmed_at = NULL,
                google_synced_at = now() WHERE id = $1`, [row.id, event.startsAt, event.endsAt]);
      const summary = `${typeLabel(row.appointment_type)} with ${clientName(row)} moved in Google Calendar to ${whenText(event.startsAt!, row.timezone)}`;
      await timeline(client, organizationId, row, actor, summary, row.id);
      await recordAudit({ organizationId, actor: auditActor(actor), action: 'appointment.google_sync',
                          entityType: 'appointment', entityId: row.id, applicationId: row.application_id, summary }, client);
    });
    await refreshNextAppointment(row.application_id);
    applied++;
  }
  await changes.commit();
  return applied;
}
