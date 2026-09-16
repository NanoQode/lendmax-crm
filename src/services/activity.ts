/**
 * Activity logs — what each person did in the last 30 days.
 *
 * The working view of the audit trail. Every audit entry made by a person or
 * a connected website is mirrored here as it is written (recordAudit calls
 * `mirrorAudit`), and opening a client file is recorded too — once per person
 * per file per half hour, so a morning spent in one file is one line.
 *
 * Nobody deletes an entry. There is no endpoint for it, and the database
 * refuses (migration 0020); `purgeActivity` removes what is past 30 days and
 * nothing else. The compliance audit trail is a separate table with its own
 * retention and is never touched from here.
 *
 * Everyone reads their own. Reading anybody else's needs `activity.view_all`.
 */
import type pg from 'pg';
import { z } from 'zod';
import { pool, query, queryOne } from '../db/pool.ts';
import {
  ACTIVITY_MODULES, actionLabel, FILE_VIEW_ACTION, FILE_VIEW_WINDOW_MINUTES, isStaffActivity,
  KNOWN_ACTIONS, moduleLabel, moduleOf, RETENTION_DAYS,
} from '../domain/activity.ts';
import { ROLES, type Role } from '../domain/permissions.ts';
import { fieldError } from '../http/middleware/errors.ts';
import { log } from '../lib/logger.ts';
import type { AuditEntry } from './audit.ts';

const roleName = (role: string | null) => (role ? ROLES[role as Role]?.name ?? role : null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Writing ────────────────────────────────────────────────────────────────

/**
 * Mirror one audit entry. Called by recordAudit, inside its transaction when
 * it has one — so an action that rolls back leaves no activity behind — but
 * behind a savepoint, so a failure here can never undo the action itself.
 */
export async function mirrorAudit(entry: AuditEntry, auditId: string, client?: pg.PoolClient): Promise<void> {
  if (!isStaffActivity(entry.actor)) return;
  const applicationId = entry.applicationId && UUID.test(entry.applicationId) ? entry.applicationId
    : entry.entityType === 'application' && entry.entityId && UUID.test(entry.entityId) ? entry.entityId : null;
  const values = [
    entry.organizationId, entry.actor.userId ?? null, entry.actor.name ?? null,
    entry.actor.role ?? null, entry.actor.kind ?? 'user', entry.action, moduleOf(entry.action),
    entry.entityType ?? null, entry.entityId ?? null, applicationId, entry.summary,
    entry.actor.ip ?? null, auditId,
  ];
  const sql = `INSERT INTO activity_logs (organization_id, actor_user_id, actor_name, actor_role,
                                          actor_kind, action, module, entity_type, entity_id,
                                          application_id, summary, ip, audit_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`;
  if (!client) {
    await pool.query(sql, values).catch((error) =>
      log.error('activity log write failed', { action: entry.action, error }));
    return;
  }
  await client.query('SAVEPOINT activity_log');
  try {
    await client.query(sql, values);
    await client.query('RELEASE SAVEPOINT activity_log');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT activity_log');
    log.error('activity log write failed', { action: entry.action, error });
  }
}

export type Viewer = {
  organizationId: string;
  userId: string | null;
  name: string;
  role?: string | null;
  kind: 'user' | 'integration';
  ip?: string | null;
};

/**
 * "Opened a client file" — once per person per file per half hour.
 *
 * Not an audit event (the compliance trail records what was changed and what
 * sensitive detail was read, not every glance), so it lives here only.
 * Never throws: a view that could not be logged is still a view.
 */
export async function recordFileView(viewer: Viewer, applicationId: string): Promise<boolean> {
  if (!isStaffActivity(viewer)) return false;
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO activity_logs (organization_id, actor_user_id, actor_name, actor_role, actor_kind,
                                  action, module, entity_type, entity_id, application_id, summary, ip)
       SELECT $1, $2, $3, $4, $5, $6, 'customers', 'application', a.id::text, a.id,
              'Opened the file of ' || coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), 'an unnamed client')
                || coalesce(' (' || a.portal_reference || ')', ''),
              $8
         FROM applications a JOIN customers c ON c.id = a.customer_id
        WHERE a.id = $7 AND a.organization_id = $1
          AND NOT EXISTS (
                SELECT 1 FROM activity_logs l
                 WHERE l.organization_id = $1 AND l.action = $6 AND l.application_id = $7
                   AND l.actor_user_id IS NOT DISTINCT FROM $2
                   AND l.actor_name IS NOT DISTINCT FROM $3
                   AND l.at > now() - make_interval(mins => $9))
       RETURNING id`,
      [viewer.organizationId, viewer.userId, viewer.name, viewer.role ?? null, viewer.kind,
       FILE_VIEW_ACTION, applicationId, viewer.ip ?? null, FILE_VIEW_WINDOW_MINUTES],
    );
    return !!row;
  } catch (error) {
    log.error('file view log failed', { applicationId, error });
    return false;
  }
}

/**
 * Remove what has aged out. The only delete this table ever sees, and the
 * database would refuse it for anything younger.
 */
export async function purgeActivity(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM activity_logs WHERE at < now() - make_interval(days => $1)`, [RETENTION_DAYS],
  );
  return rowCount ?? 0;
}

// ── Reading ────────────────────────────────────────────────────────────────

export type ActivityEntry = {
  id: string;
  at: string;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  actor_role_name: string | null;
  actor_kind: 'user' | 'integration';
  action: string;
  action_label: string;
  module: string;
  module_label: string;
  entity_type: string | null;
  entity_id: string | null;
  application_id: string | null;
  client_name: string | null;
  summary: string;
  ip: string | null;
};

/** Everyone's, or only their own. Decided by the caller from the permission. */
export type Scope = { organizationId: string; userId: string | null; seeAll: boolean; timezone?: string | null };

const SORTS: Record<string, string> = {
  at: 'l.at',
  actor: 'lower(l.actor_name)',
  module: 'l.module',
  action: 'l.action',
  client: 'lower(concat_ws(\' \', c.first_name, c.last_name))',
};

const PERIODS = ['today', 'yesterday', '7d', '30d'] as const;

const validZone = (tz: string) => {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
};

export const ActivityQuery = z.object({
  q: z.string().trim().max(100).optional(),
  // A staff member's id, `me`, or `__integrations` for connected websites.
  user: z.string().trim().max(40).optional(),
  module: z.string().trim().max(40).optional(),
  action: z.string().trim().max(60).optional(),
  client: z.string().trim().max(100).optional(),
  summary: z.string().trim().max(100).optional(),
  application_id: z.string().uuid().optional(),
  period: z.enum(PERIODS).optional(),
  from: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).default('at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

export async function listActivity(scope: Scope, raw: unknown): Promise<{ entries: ActivityEntry[]; total: number }> {
  const q = ActivityQuery.parse(raw ?? {});
  const tz = scope.timezone && validZone(scope.timezone) ? scope.timezone : 'America/Toronto';
  const params: unknown[] = [scope.organizationId, RETENTION_DAYS];
  const where = ['l.organization_id = $1', 'l.at > now() - make_interval(days => $2)'];
  const add = (sql: (p: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };

  // Somebody without the permission sees their own, whatever they asked for.
  if (!scope.seeAll) {
    if (!scope.userId) return { entries: [], total: 0 };
    add((p) => `l.actor_user_id = ${p}`, scope.userId);
  } else if (q.user) {
    if (q.user === '__integrations') where.push(`l.actor_kind = 'integration'`);
    else if (q.user === 'me') add((p) => `l.actor_user_id = ${p}`, scope.userId);
    else if (UUID.test(q.user)) add((p) => `l.actor_user_id = ${p}`, q.user);
    else throw fieldError('user', 'Choose a staff member from the list.');
  }

  if (q.module) add((p) => `l.module = ${p}`, q.module);
  if (q.action) add((p) => `l.action = ${p}`, q.action);
  if (q.application_id) add((p) => `l.application_id = ${p}`, q.application_id);
  if (q.summary) add((p) => `l.summary ILIKE ${p}`, `%${q.summary}%`);
  if (q.client) add((p) => `concat_ws(' ', c.first_name, c.last_name, a.portal_reference) ILIKE ${p}`, `%${q.client}%`);
  if (q.q) {
    add((p) => `(l.summary ILIKE ${p} OR l.actor_name ILIKE ${p} OR l.action ILIKE ${p}
                 OR concat_ws(' ', c.first_name, c.last_name, a.portal_reference) ILIKE ${p})`, `%${q.q}%`);
  }
  if (q.period === 'today' || q.period === 'yesterday') {
    // "Today" is the viewer's day, not the server's.
    params.push(tz);
    const zone = `$${params.length}::text`;
    const today = `(date_trunc('day', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone})`;
    where.push(q.period === 'today'
      ? `l.at >= ${today}`
      : `l.at >= ${today} - interval '1 day' AND l.at < ${today}`);
  } else if (q.period === '7d') {
    where.push(`l.at >= now() - interval '7 days'`);
  }
  if (q.from) add((p) => `l.at >= ${p}::timestamptz`, q.from);
  if (q.to) {
    // A bare date means "through the end of that day".
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to)) add((p) => `l.at < ${p}::date + 1`, q.to);
    else add((p) => `l.at <= ${p}::timestamptz`, q.to);
  }

  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  params.push(q.page_size, (q.page - 1) * q.page_size);
  const { rows } = await query<Omit<ActivityEntry, 'action_label' | 'module_label' | 'actor_role_name'> & { total: number }>(
    `SELECT COUNT(*) OVER ()::int AS total,
            l.id::text, l.at, l.actor_user_id, l.actor_name, l.actor_role, l.actor_kind,
            l.action, l.module, l.entity_type, l.entity_id, l.application_id,
            nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), '') AS client_name,
            l.summary, host(l.ip) AS ip
       FROM activity_logs l
       LEFT JOIN applications a ON a.id = l.application_id AND a.organization_id = l.organization_id
       LEFT JOIN customers c ON c.id = a.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${SORTS[q.sort]} ${dir} NULLS LAST, l.id ${dir}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  let total = rows[0]?.total ?? 0;
  if (!rows.length && q.page > 1) {
    // Past the last page: still say how many there are.
    const count = await queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM activity_logs l
         LEFT JOIN applications a ON a.id = l.application_id AND a.organization_id = l.organization_id
         LEFT JOIN customers c ON c.id = a.customer_id
        WHERE ${where.join(' AND ')}`,
      params.slice(0, -2),
    );
    total = count?.n ?? 0;
  }

  return {
    total,
    entries: rows.map(({ total: _t, ...r }) => ({
      ...r,
      at: new Date(r.at).toISOString(),
      actor_role_name: r.actor_kind === 'integration' ? 'Connected website' : roleName(r.actor_role),
      action_label: actionLabel(r.action),
      module_label: moduleLabel(r.module),
    })),
  };
}

/**
 * What the filters offer: modules, actions, and — for somebody who may see
 * everyone's — the people. Former staff stay in the list while they still
 * have entries, because their last 30 days are exactly what gets asked about.
 */
export async function activityOptions(scope: Scope) {
  const present = await query<{ action: string; module: string }>(
    `SELECT DISTINCT action, module FROM activity_logs
      WHERE organization_id = $1 AND at > now() - make_interval(days => $2)
        ${scope.seeAll ? '' : 'AND actor_user_id = $3'}`,
    scope.seeAll ? [scope.organizationId, RETENTION_DAYS] : [scope.organizationId, RETENTION_DAYS, scope.userId],
  );
  const actions = new Map(KNOWN_ACTIONS.map((a) => [a.key, a]));
  for (const row of present.rows) {
    if (!actions.has(row.action)) actions.set(row.action, { key: row.action, label: actionLabel(row.action), module: row.module });
  }

  let people: Array<{ id: string; name: string; role: string | null; role_name: string | null; status: string }> = [];
  let integrations = false;
  if (scope.seeAll) {
    const { rows } = await query<{ id: string; name: string; role: string | null; status: string }>(
      `SELECT u.id, u.name, u.role,
              CASE WHEN u.archived_at IS NOT NULL THEN 'deleted'
                   WHEN NOT u.active THEN 'inactive'
                   WHEN u.activated_at IS NULL THEN 'invited'
                   ELSE 'active' END AS status
         FROM users u
        WHERE u.organization_id = $1
          AND (u.archived_at IS NULL OR EXISTS (
                SELECT 1 FROM activity_logs l WHERE l.actor_user_id = u.id
                   AND l.at > now() - make_interval(days => $2)))
        ORDER BY (u.archived_at IS NULL AND u.active) DESC, lower(u.name)`,
      [scope.organizationId, RETENTION_DAYS],
    );
    people = rows.map((r) => ({ ...r, role_name: roleName(r.role) }));
    integrations = !!(await queryOne(
      `SELECT 1 FROM activity_logs WHERE organization_id = $1 AND actor_kind = 'integration'
          AND at > now() - make_interval(days => $2) LIMIT 1`,
      [scope.organizationId, RETENTION_DAYS],
    ));
  }

  return {
    retention_days: RETENTION_DAYS,
    can_view_all: scope.seeAll,
    modules: ACTIVITY_MODULES,
    actions: [...actions.values()].sort((a, b) => a.label.localeCompare(b.label)),
    people,
    integrations,
  };
}
