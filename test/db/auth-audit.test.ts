/**
 * A failed sign-in must actually reach the audit log.
 *
 * This is the regression it guards: the route recorded failures against an
 * all-zero organization UUID, which violates audit_log's foreign key. The write
 * was made through recordAuditSafely, so it was caught, logged as "audit write
 * failed", and dropped — the brute-force signal the block exists to capture was
 * the one thing it never captured, and nothing failed loudly enough to notice.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { recordAudit } from '../../src/services/audit.ts';

let orgId: string;

before(async () => { await migrate(); });

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Test Brokerage','ON') RETURNING id`);
  orgId = rows[0]!.id;
});

after(async () => { await pool.end(); });

/** The resolution the route performs before auditing a failure. */
async function resolveFailOrg(email: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `SELECT COALESCE(
              (SELECT organization_id FROM users WHERE lower(email) = lower($1) LIMIT 1),
              (SELECT id FROM organizations ORDER BY created_at LIMIT 1)
            ) AS id`,
    [email],
  );
  return row?.id ?? null;
}

test('a failure against a real account lands on that account’s organization', async () => {
  await query(
    `INSERT INTO users (organization_id, email, name, role, active)
     VALUES ($1,'someone@lendmax.ca','Someone','broker',true)`, [orgId]);

  const resolved = await resolveFailOrg('SOMEONE@lendmax.ca');
  assert.equal(resolved, orgId, 'matched case-insensitively');

  await recordAudit({
    organizationId: resolved!,
    actor: { kind: 'user', name: 'someone@lendmax.ca' },
    action: 'auth.sign_in_failed',
    entityType: 'user',
    summary: 'Failed sign-in for someone@lendmax.ca (bad_password)',
  });

  const { rows } = await query(
    `SELECT action FROM audit_log WHERE action = 'auth.sign_in_failed'`);
  assert.equal(rows.length, 1, 'the failure was actually written, not silently dropped');
});

test('a failure against an unknown address still gets recorded', async () => {
  // Somebody guessing addresses is worth seeing.
  const resolved = await resolveFailOrg('nobody@example.com');
  assert.equal(resolved, orgId, 'falls back to the deployment’s organization');

  await recordAudit({
    organizationId: resolved!,
    actor: { kind: 'user', name: 'nobody@example.com' },
    action: 'auth.sign_in_failed',
    entityType: 'user',
    summary: 'Failed sign-in for nobody@example.com (no_such_user)',
  });
  const { rows } = await query(`SELECT 1 FROM audit_log WHERE action = 'auth.sign_in_failed'`);
  assert.equal(rows.length, 1);
});

test('the all-zero organization the bug used is rejected by the database', async () => {
  // Proves the foreign key is what was dropping these, so the fix is the
  // resolution above rather than a looser constraint.
  await assert.rejects(
    () => recordAudit({
      organizationId: '00000000-0000-0000-0000-000000000000',
      actor: { kind: 'user', name: 'x@y.z' },
      action: 'auth.sign_in_failed',
      summary: 'should not be writable',
    }),
    /foreign key|violates/i,
  );
});
