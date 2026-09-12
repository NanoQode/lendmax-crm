/**
 * Database-backed audit tests.
 *
 * These run against a real PostgreSQL (see .env.test) because what they check
 * is the interaction between the code and the database — the append-only
 * triggers, and whether a payload survives a jsonb round trip with its digest
 * intact. A mocked database would pass while the real one broke.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { recordAudit, verifyChain } from '../../src/services/audit.ts';

let orgId: string;

before(async () => {
  await migrate();
  await query('TRUNCATE audit_log, organizations CASCADE');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Test Brokerage','ON') RETURNING id`,
  );
  orgId = rows[0]!.id;
});

after(async () => {
  await pool.end();
});

test('a chain of entries verifies, including multi-key payloads', async () => {
  await recordAudit({
    organizationId: orgId,
    actor: { name: 'Tester', kind: 'user' },
    action: 'test.simple',
    summary: 'No payload at all',
  });
  await recordAudit({
    organizationId: orgId,
    actor: { name: 'Tester', kind: 'user' },
    action: 'test.payload',
    entityType: 'application',
    entityId: 'abc-123',
    summary: 'A payload whose keys jsonb will reorder',
    // Deliberately in an order jsonb will not preserve: it sorts by key length
    // first, so these come back in a different order than they went in.
    before: { stage_key: 'lead', zzz: 1, a: 2 },
    after: { stage_key: 'application', forced: false, overridden: [], nested: { z: 1, a: 2 } },
  });
  await recordAudit({
    organizationId: orgId,
    actor: { name: 'Tester', kind: 'system' },
    action: 'test.array',
    summary: 'Arrays keep their order',
    after: { items: [3, 1, 2], note: null },
  });

  const result = await verifyChain(orgId);
  assert.equal(result.ok, true, JSON.stringify(result.brokenAt));
  assert.equal(result.checked, 3);
});

test('a null payload does not break the chain', async () => {
  // The shape that broke it in production: a first-time profile save reads the
  // previous row with queryOne, which returns null — not undefined — when there
  // is nothing there yet. `before: null` then hashed as the string "null" on
  // write and as "" on verify, because a jsonb JSON-null and a SQL NULL are the
  // same JS null coming back out of the driver. Every entry with a null payload
  // reported itself as tampering.
  await recordAudit({
    organizationId: orgId,
    actor: { name: 'Tester', kind: 'user' },
    action: 'test.null_before',
    summary: 'Nothing existed before this',
    before: null,
    after: { display_name: 'Someone', title: null },
  });
  await recordAudit({
    organizationId: orgId,
    actor: { name: 'Tester', kind: 'user' },
    action: 'test.null_after',
    summary: 'And nothing after',
    before: { display_name: 'Someone' },
    after: null,
  });
  await recordAudit({
    organizationId: orgId,
    actor: { name: 'Tester', kind: 'user' },
    action: 'test.both_null',
    summary: 'Neither side carries a payload',
    before: null,
    after: null,
  });

  const result = await verifyChain(orgId);
  assert.equal(result.ok, true, JSON.stringify(result.brokenAt));
});

test('the database refuses to update an audit row', async () => {
  await assert.rejects(
    () => query(`UPDATE audit_log SET summary = 'rewritten' WHERE organization_id = $1`, [orgId]),
    /append-only/,
  );
});

test('the database refuses to delete an audit row', async () => {
  await assert.rejects(
    () => query(`DELETE FROM audit_log WHERE organization_id = $1`, [orgId]),
    /append-only/,
  );
});

test('tampering that goes around the triggers is detected, and located', async () => {
  // Triggers are dropped for the length of this test to simulate somebody with
  // direct database access — which is the threat the chain exists for. The
  // table's own protection is tested above.
  const { rows: before } = await query<{ id: string | number }>(
    'SELECT id FROM audit_log WHERE organization_id = $1 ORDER BY id LIMIT 1 OFFSET 1',
    [orgId],
  );
  // The API reports ids as strings — a bigserial outgrows a JS number
  // eventually, and a chain that silently rounds an id is worse than useless.
  const victim = String(before[0]!.id);

  await query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
  try {
    await query('UPDATE audit_log SET summary = $2 WHERE id = $1', [victim, 'quietly rewritten']);
    const result = await verifyChain(orgId);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt?.id, victim, 'names the row that was changed');
    assert.equal(result.checked, 2, 'and stops at the first break');
  } finally {
    await query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
  }
});
