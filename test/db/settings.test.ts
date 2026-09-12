/**
 * The administration screens, against a real database.
 *
 * These tests are about the guards, not the CRUD. Every one of them stops a
 * brokerage doing something to itself that is hard to undo: a pipeline with
 * nothing to fund into, a deactivated last administrator, a disposition
 * deleted out from under last year's lost files.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { createSession } from '../../src/services/auth.ts';

let orgId: string;
let adminId: string;
let secondAdminId: string;
let brokerId: string;
let cookies: Record<string, string> = {};
const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;

before(async () => {
  await migrate();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/crm/api`;
});

after(async () => { server.close(); await pool.end(); });

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');

  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Test','ON') RETURNING id`)
  ).rows[0]!.id;

  adminId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, profile_complete)
     VALUES ($1,'admin@example.com','Alex Admin','technical_admin',true,true) RETURNING id`,
    [orgId])).rows[0]!.id;
  secondAdminId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, profile_complete)
     VALUES ($1,'admin2@example.com','Blair Admin','technical_admin',true,true) RETURNING id`,
    [orgId])).rows[0]!.id;
  brokerId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, profile_complete)
     VALUES ($1,'broker@example.com','Dana Broker','broker',true,true) RETURNING id`,
    [orgId])).rows[0]!.id;

  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
     VALUES ($1,'lead','Lead',10,'open',true),
            ($1,'funded','Funded',90,'won',true),
            ($1,'lost','Lost',99,'lost',true)`, [orgId]);
  await query(
    `INSERT INTO lost_dispositions (organization_id, key, label, position)
     VALUES ($1,'rate','Rate',10), ($1,'went_elsewhere','Went elsewhere',20)`, [orgId]);

  cookies = {
    admin: `lmx_crm_session=${(await createSession(adminId, {})).token}`,
    broker: `lmx_crm_session=${(await createSession(brokerId, {})).token}`,
  };
});

async function call(
  who: 'admin' | 'broker', method: string, path: string, body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { cookie: cookies[who]!, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const STAGES = [
  { key: 'lead', label: 'Lead', category: 'open', active: true },
  { key: 'funded', label: 'Funded', category: 'won', active: true },
  { key: 'lost', label: 'Lost', category: 'lost', active: true },
];

// ── Vocabularies ───────────────────────────────────────────────────────────

test('a pipeline with nothing to fund into is refused', async () => {
  // The failure it prevents shows up weeks later at the first funding, by
  // which time nobody connects it to a settings change.
  const result = await call('admin', 'PUT', '/admin/vocabularies/stages',
    { items: STAGES.filter((s) => s.category !== 'won') });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /has to be the one that means funded/);

  const stages = await query(`SELECT 1 FROM pipeline_stages WHERE category = 'won' AND active`);
  assert.equal(stages.rows.length, 1, 'and nothing was changed');
});

test('an entry left off the list is deactivated, never deleted', async () => {
  await query(
    `INSERT INTO customers (organization_id, first_name, last_name) VALUES ($1,'A','B')`,
    [orgId]);
  const customer = await queryOne<{ id: string }>('SELECT id FROM customers');
  await query(
    `INSERT INTO applications (organization_id, customer_id, property_province, stage_key,
                               lost_disposition_key)
     VALUES ($1,$2,'ON','lost','rate')`, [orgId, customer!.id]);

  const result = await call('admin', 'PUT', '/admin/vocabularies/dispositions',
    { items: [{ key: 'went_elsewhere', label: 'Went elsewhere', active: true }] });
  assert.equal(result.status, 200);

  const rate = await queryOne<{ active: boolean }>(
    `SELECT active FROM lost_dispositions WHERE key = 'rate'`);
  assert.equal(rate!.active, false, 'deactivated');
  assert.ok(rate, 'not deleted — last year’s lost files still read as having a reason');

  const application = await queryOne<{ lost_disposition_key: string }>(
    'SELECT lost_disposition_key FROM applications');
  assert.equal(application!.lost_disposition_key, 'rate');
});

test('the usage count tells an admin what a change would affect', async () => {
  await query(
    `INSERT INTO customers (organization_id, first_name, last_name) VALUES ($1,'A','B')`,
    [orgId]);
  const customer = await queryOne<{ id: string }>('SELECT id FROM customers');
  for (let i = 0; i < 3; i++) {
    await query(
      `INSERT INTO applications (organization_id, customer_id, property_province, stage_key)
       VALUES ($1,$2,'ON','lead')`, [orgId, customer!.id]);
  }
  const result = await call('admin', 'GET', '/admin/vocabularies/stages');
  assert.equal((result.body.usage as Record<string, number>).lead, 3);
});

test('two entries sharing a key are refused before anything is written', async () => {
  const result = await call('admin', 'PUT', '/admin/vocabularies/dispositions',
    { items: [{ key: 'rate', label: 'Rate' }, { key: 'rate', label: 'Also rate' }] });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /share the key "rate"/);
});

test('a key that is not a key is refused with what a key looks like', async () => {
  const result = await call('admin', 'PUT', '/admin/vocabularies/dispositions',
    { items: [{ key: 'Went Elsewhere!', label: 'Went elsewhere' }] });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /lower case, digits and underscores/);
});

test('a broker cannot change the brokerage’s settings', async () => {
  const result = await call('broker', 'PUT', '/admin/vocabularies/stages', { items: STAGES });
  assert.equal(result.status, 403);
});

// ── Users ──────────────────────────────────────────────────────────────────

test('the last technical admin cannot be deactivated or demoted', async () => {
  await query(`UPDATE users SET active = false WHERE id = $1`, [secondAdminId]);

  const deactivate = await call('admin', 'PUT', `/admin/users/${adminId}`, { active: false });
  assert.equal(deactivate.status, 400);
  assert.match(String(deactivate.body.error), /cannot deactivate your own account/);

  // And not by another administrator either, once they are the only one.
  await query(`UPDATE users SET active = true, role = 'technical_admin' WHERE id = $1`,
    [secondAdminId]);
  await query(`UPDATE users SET role = 'manager' WHERE id = $1`, [adminId]);
  cookies.admin = `lmx_crm_session=${(await createSession(secondAdminId, {})).token}`;
  await query(`UPDATE users SET role = 'technical_admin' WHERE id = $1`, [adminId]);
  await query(`UPDATE users SET active = false WHERE id = $1`, [secondAdminId]);

  cookies.admin = `lmx_crm_session=${(await createSession(adminId, {})).token}`;
  const demote = await call('admin', 'PUT', `/admin/users/${brokerId}`, { role: 'broker' });
  assert.equal(demote.status, 200, 'an ordinary change still works');
});

test('a lone technical admin cannot be demoted by another admin', async () => {
  // Two admins: demoting one is fine. Demoting the second is not.
  const first = await call('admin', 'PUT', `/admin/users/${secondAdminId}`,
    { role: 'manager' });
  assert.equal(first.status, 200);

  const second = await call('admin', 'PUT', `/admin/users/${adminId}`, { role: 'manager' });
  assert.equal(second.status, 400);
  assert.match(String(second.body.error), /cannot change your own role/);
});

test('deactivating somebody signs them out everywhere', async () => {
  const session = await createSession(brokerId, {});
  const before = await queryOne<{ revoked_at: string | null }>(
    'SELECT revoked_at FROM sessions WHERE user_id = $1 ORDER BY issued_at DESC LIMIT 1',
    [brokerId]);
  assert.equal(before!.revoked_at, null);

  await call('admin', 'PUT', `/admin/users/${brokerId}`, { active: false });

  const after = await query<{ revoked_at: string | null }>(
    'SELECT revoked_at FROM sessions WHERE user_id = $1', [brokerId]);
  assert.ok(after.rows.every((r) => r.revoked_at), `session ${session.sessionId} revoked`);
});

test('a permission exception has to say why', async () => {
  const without = await call('admin', 'PUT', `/admin/users/${brokerId}`,
    { permission_overrides: { 'document.download': true } });
  assert.equal(without.status, 400);
  assert.match(String(without.body.error), /Say why this account needs an exception/);

  const with_reason = await call('admin', 'PUT', `/admin/users/${brokerId}`, {
    permission_overrides: { 'document.download': true },
    override_reason: 'Covering for the underwriter while they are on leave until 30 October.',
  });
  assert.equal(with_reason.status, 200);

  const audit = await queryOne<{ summary: string }>(
    `SELECT summary FROM audit_log WHERE action = 'user.update' ORDER BY at DESC LIMIT 1`);
  assert.match(audit!.summary, /Covering for the underwriter/);
});

// ── Templates ──────────────────────────────────────────────────────────────

test('a template with a merge field that does not exist is refused at save', async () => {
  const result = await call('admin', 'PUT', '/admin/templates/welcome', {
    name: 'Welcome', channel: 'email', subject: 'Hello {first_name}',
    body_text: 'Hi {clietn_name}, welcome.',
  });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /no merge field called \{clietn_name\}/);
});

test('a saved template records which merge fields it uses', async () => {
  const result = await call('admin', 'PUT', '/admin/templates/welcome', {
    name: 'Welcome', channel: 'email', subject: 'Hello {first_name}',
    body_text: 'Hi {first_name}, your reference is {portal_reference}.',
  });
  assert.equal(result.status, 200);

  const stored = await queryOne<{ merge_fields: string[] }>(
    `SELECT merge_fields FROM templates WHERE key = 'welcome'`);
  assert.deepEqual([...stored!.merge_fields].sort(), ['first_name', 'portal_reference']);
});

test('an email template with no subject is refused', async () => {
  const result = await call('admin', 'PUT', '/admin/templates/x', {
    name: 'X', channel: 'email', body_text: 'Hi {first_name}.',
  });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /needs a subject/);
});

// ── Retention and the risk model ───────────────────────────────────────────

test('a retention policy that destroys records needs acknowledgement and a source', async () => {
  const unacknowledged = await call('admin', 'PUT', '/admin/retention/applications', {
    name: 'Applications', entity_type: 'application', anchor: 'funded_at',
    retain_months: 84, action: 'delete', source_note: 'FINTRAC five-year rule.',
  });
  assert.equal(unacknowledged.status, 409);
  assert.match(String(unacknowledged.body.error), /without anybody looking at them first/);

  const unsourced = await call('admin', 'PUT', '/admin/retention/applications', {
    name: 'Applications', entity_type: 'application', anchor: 'funded_at',
    retain_months: 84, action: 'delete', acknowledge_destructive: true,
  });
  assert.equal(unsourced.status, 400);
  assert.match(String(unsourced.body.error), /where the retention period came from/);

  // A review policy is the safe default and needs neither.
  const review = await call('admin', 'PUT', '/admin/retention/applications', {
    name: 'Applications', entity_type: 'application', anchor: 'funded_at',
    retain_months: 84, action: 'review',
  });
  assert.equal(review.status, 200);
});

test('a risk factor naming an evaluator that does not exist is refused', async () => {
  const result = await call('admin', 'PUT', '/admin/risk-factors', {
    factors: [{ factor_key: 'vibes', label: 'Vibes', weight: 5, evaluator: 'gut_feel' }],
  });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /no evaluator called "gut_feel"/);
});

test('a new model version leaves the old one readable', async () => {
  await call('admin', 'PUT', '/admin/risk-factors', {
    factors: [{ factor_key: 'pep', label: 'PEP', weight: 4, evaluator: 'fintrac_pep' }],
  });
  const second = await call('admin', 'PUT', '/admin/risk-factors', {
    factors: [{ factor_key: 'pep', label: 'PEP', weight: 9, evaluator: 'fintrac_pep' }],
    new_version: true, source_note: 'Reweighted after the annual review.',
  });
  assert.equal(second.body.model_version, 2);

  const versions = await query<{ model_version: number; weight: string }>(
    `SELECT model_version, weight FROM risk_factor_definitions
      WHERE factor_key = 'pep' ORDER BY model_version`);
  assert.deepEqual(versions.rows.map((v) => v.weight), ['4.00', '9.00'],
    'an assessment records the version that produced it, so version 1 has to survive');
});
