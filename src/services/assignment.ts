/**
 * Who a new file belongs to.
 *
 * Called for every new lead — from the portal, from the website API, and from
 * a person creating one by hand — so a lead arriving at 2am lands with an
 * owner. Without it a file has nobody assigned, which means nobody is notified
 * when the client uploads a document, it appears on no priority list, and no
 * staleness rule watches it — a file with no owner is a file nobody is
 * watching.
 *
 * `unassigned` remains a legitimate configuration. Some brokerages triage by
 * hand and would rather see a queue than have files silently distributed. The
 * difference is that it is then a choice, and the unassigned-files count on
 * the dashboard is what makes it a visible one.
 *
 * ROUND ROBIN is "whoever was handed a lead longest ago", among staff who are
 * active, have activated their account, and have round robin switched on. An
 * index into a list would skip or repeat people every time somebody was
 * switched on or off; a timestamp per person cannot.
 */
import type pg from 'pg';
import { log } from '../lib/logger.ts';

export type AssignmentRole = 'broker' | 'underwriter' | 'manager' | 'compliance';

/** The role round robin fills: one owner per lead. */
export const OWNER_ROLE: AssignmentRole = 'broker';

type Rule = {
  id: string;
  role: AssignmentRole;
  mode: 'unassigned' | 'fixed' | 'round_robin' | 'team';
  fixed_user_id: string | null;
  candidates: string[];
  applies_when: Record<string, unknown>;
};

type FileFacts = {
  applicationId: string;
  province?: string | null;
  transactionType?: string | null;
  purpose?: string | null;
  /** Where the lead came from, for the notification. */
  source?: string;
};

/**
 * Who may be handed a file at all. Used by every path that assigns, so the
 * automatic one and the manual one cannot disagree about who is eligible.
 */
export const assignableSql = (alias = '') =>
  `${alias}active AND ${alias}archived_at IS NULL AND ${alias}activated_at IS NOT NULL`;
export const ASSIGNABLE_SQL = assignableSql();

/** Does this rule apply to this file? An empty condition applies to everything. */
function matches(rule: Rule, file: FileFacts): boolean {
  const when = rule.applies_when ?? {};
  if (!Object.keys(when).length) return true;

  const check = (key: string, value: string | null | undefined): boolean => {
    const expected = when[key];
    if (expected === undefined || expected === null) return true;
    const list = Array.isArray(expected) ? expected.map(String) : [String(expected)];
    return value !== null && value !== undefined && list.includes(String(value));
  };

  return check('province', file.province)
    && check('transaction_type', file.transactionType)
    && check('purpose', file.purpose);
}

/**
 * The next person in the rotation, claimed.
 *
 * `FOR UPDATE SKIP LOCKED` means two leads arriving in the same instant go to
 * two different people rather than both to whoever was next. If everybody is
 * locked (a rotation of one, say), the second waits for the first instead.
 * `clock_timestamp()` rather than `now()`: several leads handed out in one
 * transaction must still take turns.
 */
export async function claimNextInRotation(
  client: pg.PoolClient,
  organizationId: string,
  candidates: string[],
): Promise<string | null> {
  const restricted = candidates.length > 0;
  const sql = (lock: string) => `
    SELECT id FROM users
     WHERE organization_id = $1 AND ${ASSIGNABLE_SQL} AND round_robin_enabled
       ${restricted ? 'AND id = ANY($2::uuid[])' : ''}
     ORDER BY last_auto_assigned_at ASC NULLS FIRST,
              ${restricted ? 'array_position($2::uuid[], id)' : 'created_at, id'}
     LIMIT 1 ${lock}`;
  const params = restricted ? [organizationId, candidates] : [organizationId];

  let { rows } = await client.query<{ id: string }>(sql('FOR UPDATE SKIP LOCKED'), params);
  if (!rows.length) ({ rows } = await client.query<{ id: string }>(sql('FOR UPDATE'), params));
  const id = rows[0]?.id ?? null;
  if (id) {
    await client.query('UPDATE users SET last_auto_assigned_at = clock_timestamp() WHERE id = $1', [id]);
  }
  return id;
}

/**
 * Apply every active rule to one file.
 *
 * Runs inside the caller's transaction so an assignment and the import that
 * caused it commit together — a file that exists with no owner because the
 * second statement failed is the exact situation this function is for.
 *
 * `skipRoles` is for a lead somebody assigned by hand as it was created: their
 * choice fills that role, and the rules still fill the others.
 */
export async function applyAssignmentRules(
  client: pg.PoolClient,
  organizationId: string,
  file: FileFacts,
  options: { skipRoles?: AssignmentRole[] } = {},
): Promise<Array<{ role: AssignmentRole; userId: string }>> {
  const { rows: rules } = await client.query<Rule>(
    `SELECT id, role, mode, fixed_user_id, candidates, applies_when
       FROM assignment_rules
      WHERE organization_id = $1 AND active AND mode <> 'unassigned'
      ORDER BY role, position`,
    [organizationId],
  );

  const assigned: Array<{ role: AssignmentRole; userId: string }> = [];
  const done = new Set<AssignmentRole>(options.skipRoles ?? []);

  for (const rule of rules) {
    // First matching rule per role wins, so ordering is the tie-break rather
    // than the last write.
    if (done.has(rule.role) || !matches(rule, file)) continue;

    let userId: string | null = null;

    if (rule.mode === 'fixed') {
      userId = rule.fixed_user_id;
    } else if (rule.mode === 'round_robin') {
      userId = await claimNextInRotation(client, organizationId, rule.candidates ?? []);
    } else if (rule.mode === 'team') {
      const { rows } = await client.query<{ manager_user_id: string | null }>(
        `SELECT t.manager_user_id FROM teams t WHERE t.organization_id = $1 AND t.active
          ORDER BY t.created_at LIMIT 1`,
        [organizationId],
      );
      userId = rows[0]?.manager_user_id ?? null;
    }

    if (!userId) continue;

    // A deactivated, deleted or not-yet-activated account must never be
    // handed a file: they cannot sign in to see it.
    const { rows: check } = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND organization_id = $2 AND ${ASSIGNABLE_SQL}`,
      [userId, organizationId],
    );
    if (!check.length) {
      log.warn('assignment rule pointed at somebody who cannot take files', { rule: rule.id, userId });
      continue;
    }

    await assignInTransaction(client, organizationId, {
      applicationId: file.applicationId,
      userId,
      role: rule.role,
      title: 'A new lead was assigned to you',
      body: file.source ? `It arrived from ${file.source}.` : 'It arrived from apply.lendmax.ca.',
      dedupeKey: `assigned:${file.applicationId}:${rule.role}`,
    });

    assigned.push({ role: rule.role, userId });
    done.add(rule.role);
  }

  return assigned;
}

/**
 * Put one person on a file as the primary for a role, and tell them.
 *
 * The existing primary steps down first, or the partial unique index on
 * primaries rejects the write.
 */
export async function assignInTransaction(
  client: pg.PoolClient,
  organizationId: string,
  input: {
    applicationId: string; userId: string; role: string;
    assignedBy?: string | null; title: string; body: string; dedupeKey?: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE assignments SET is_primary = false
      WHERE application_id = $1 AND role = $2 AND unassigned_at IS NULL AND user_id <> $3`,
    [input.applicationId, input.role, input.userId],
  );
  await client.query(
    `INSERT INTO assignments (application_id, user_id, role, is_primary, assigned_by)
     VALUES ($1,$2,$3,true,$4)
     ON CONFLICT (application_id, user_id, role)
     DO UPDATE SET is_primary = true, unassigned_at = NULL,
                   assigned_at = now(), assigned_by = EXCLUDED.assigned_by`,
    [input.applicationId, input.userId, input.role, input.assignedBy ?? null],
  );
  await client.query(
    `INSERT INTO notifications (organization_id, user_id, kind, title, body, entity_type,
                                entity_id, dedupe_key)
     VALUES ($1,$2,'assignment',$3,$4,'application',$5::text,$6)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [organizationId, input.userId, input.title, input.body, input.applicationId,
     input.dedupeKey ?? null],
  );
  // For automations: "a lead is assigned". Keyed to this assignment, so the
  // same person put back on the same file later is a new event.
  await client.query(
    `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id, payload,
                                actor_user_id, dedupe_key)
     SELECT $1, 'lead.assigned', app.customer_id, app.id, $2::jsonb, $3,
            'lead.assigned:' || app.id || ':' || $4 || ':' || $5 || ':' || extract(epoch FROM clock_timestamp())
       FROM applications app WHERE app.id = $6
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [organizationId, JSON.stringify({ user_id: input.userId, role: input.role }),
     input.assignedBy ?? null, input.role, input.userId, input.applicationId],
  );
}

// ── The round robin switch ─────────────────────────────────────────────────

/**
 * Round robin is on when the organisation's general owner rule rotates.
 * Off means new leads wait, unassigned, for somebody to hand them out — the
 * staff list and the manual assign list are unaffected.
 */
export async function roundRobinStatus(
  client: pg.Pool | pg.PoolClient,
  organizationId: string,
): Promise<{ enabled: boolean; pool: Array<{ id: string; name: string; last_auto_assigned_at: string | null }> }> {
  const { rows: rule } = await client.query<{ mode: string }>(
    `SELECT mode FROM assignment_rules
      WHERE organization_id = $1 AND role = $2 AND active AND applies_when = '{}'::jsonb
      ORDER BY position LIMIT 1`,
    [organizationId, OWNER_ROLE],
  );
  const { rows: pool } = await client.query<{ id: string; name: string; last_auto_assigned_at: string | null }>(
    `SELECT id, name, last_auto_assigned_at FROM users
      WHERE organization_id = $1 AND ${ASSIGNABLE_SQL} AND round_robin_enabled
      ORDER BY last_auto_assigned_at ASC NULLS FIRST, created_at, id`,
    [organizationId],
  );
  return { enabled: rule[0]?.mode === 'round_robin', pool };
}

export async function setRoundRobin(
  client: pg.PoolClient,
  organizationId: string,
  enabled: boolean,
): Promise<void> {
  const mode = enabled ? 'round_robin' : 'unassigned';
  const { rowCount } = await client.query(
    `UPDATE assignment_rules SET mode = $3, candidates = '{}', fixed_user_id = NULL
      WHERE id = (SELECT id FROM assignment_rules
                   WHERE organization_id = $1 AND role = $2 AND active AND applies_when = '{}'::jsonb
                   ORDER BY position LIMIT 1)`,
    [organizationId, OWNER_ROLE, mode],
  );
  if (!rowCount) {
    await client.query(
      `INSERT INTO assignment_rules (organization_id, role, mode, position, active)
       VALUES ($1,$2,$3,1,true)`,
      [organizationId, OWNER_ROLE, mode],
    );
  }
}
