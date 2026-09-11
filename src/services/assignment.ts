/**
 * Who a new file belongs to.
 *
 * Called by the importer, so an application arriving from the portal at 2am
 * lands with an owner. Without it a file has nobody assigned, which means
 * nobody is notified when the client uploads a document, it appears on no
 * priority list, and no staleness rule watches it — a file with no owner is a
 * file nobody is watching.
 *
 * `unassigned` remains a legitimate configuration. Some brokerages triage by
 * hand and would rather see a queue than have files silently distributed. The
 * difference is that it is then a choice, and the unassigned-files count on
 * the dashboard is what makes it a visible one.
 */
import type pg from 'pg';
import { log } from '../lib/logger.ts';

export type AssignmentRole = 'broker' | 'underwriter' | 'manager' | 'compliance';

type Rule = {
  id: string;
  role: AssignmentRole;
  mode: 'unassigned' | 'fixed' | 'round_robin' | 'team';
  fixed_user_id: string | null;
  candidates: string[];
  rotation_index: number;
  applies_when: Record<string, unknown>;
};

type FileFacts = {
  applicationId: string;
  province?: string | null;
  transactionType?: string | null;
  purpose?: string | null;
};

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
 * Apply every active rule to one file.
 *
 * Runs inside the caller's transaction so an assignment and the import that
 * caused it commit together — a file that exists with no owner because the
 * second statement failed is the exact situation this function is for.
 */
export async function applyAssignmentRules(
  client: pg.PoolClient,
  organizationId: string,
  file: FileFacts,
): Promise<Array<{ role: AssignmentRole; userId: string }>> {
  const { rows: rules } = await client.query<Rule>(
    `SELECT id, role, mode, fixed_user_id, candidates, rotation_index, applies_when
       FROM assignment_rules
      WHERE organization_id = $1 AND active AND mode <> 'unassigned'
      ORDER BY role, position`,
    [organizationId],
  );

  const assigned: Array<{ role: AssignmentRole; userId: string }> = [];
  const done = new Set<AssignmentRole>();

  for (const rule of rules) {
    // First matching rule per role wins, so ordering is the tie-break rather
    // than the last write.
    if (done.has(rule.role) || !matches(rule, file)) continue;

    let userId: string | null = null;

    if (rule.mode === 'fixed') {
      userId = rule.fixed_user_id;
    } else if (rule.mode === 'round_robin' && rule.candidates.length) {
      // Only people who can still be assigned. Somebody deactivated must not
      // hold a place in the rotation and swallow every fourth file.
      const { rows: active } = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND active AND organization_id = $2
          ORDER BY array_position($1::uuid[], id)`,
        [rule.candidates, organizationId],
      );
      if (active.length) {
        const index = rule.rotation_index % active.length;
        userId = active[index]!.id;
        await client.query(
          'UPDATE assignment_rules SET rotation_index = $2 WHERE id = $1',
          [rule.id, (rule.rotation_index + 1) % active.length],
        );
      }
    } else if (rule.mode === 'team') {
      const { rows } = await client.query<{ manager_user_id: string | null }>(
        `SELECT t.manager_user_id FROM teams t WHERE t.organization_id = $1 AND t.active
          ORDER BY t.created_at LIMIT 1`,
        [organizationId],
      );
      userId = rows[0]?.manager_user_id ?? null;
    }

    if (!userId) continue;

    // A deactivated account must never be handed a file.
    const { rows: check } = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE id = $1 AND active AND organization_id = $2',
      [userId, organizationId],
    );
    if (!check.length) {
      log.warn('assignment rule pointed at an inactive user', { rule: rule.id, userId });
      continue;
    }

    await client.query(
      `INSERT INTO assignments (application_id, user_id, role, is_primary)
       VALUES ($1,$2,$3,true)
       ON CONFLICT (application_id, user_id, role) DO NOTHING`,
      [file.applicationId, userId, rule.role],
    );
    await client.query(
      `INSERT INTO notifications (organization_id, user_id, kind, title, body, entity_type,
                                  entity_id, dedupe_key)
       VALUES ($1,$2,'assignment','A new file was assigned to you',
               'It arrived from apply.lendmax.ca.','application',$3::text,$4)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [organizationId, userId, file.applicationId, `assigned:${file.applicationId}:${rule.role}`],
    );

    assigned.push({ role: rule.role, userId });
    done.add(rule.role);
  }

  return assigned;
}
