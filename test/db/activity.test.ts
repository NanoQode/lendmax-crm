/**
 * Activity logs, against a real database: what gets recorded, who can read
 * what, and that nothing leaves before its 30 days are up.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne, withTransaction } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { createSession } from '../../src/services/auth.ts';
import { recordAudit } from '../../src/services/audit.ts';
import { activityOptions, listActivity, purgeActivity, recordFileView } from '../../src/services/activity.ts';
import { createApiKey } from '../../src/services/api-keys.ts';
import { registerHandler, Worker } from '../../src/jobs/worker.ts';
import { enqueue } from '../../src/jobs/queue.ts';
import type { Actor } from '../../src/services/staff.ts';

const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;
let orgId: string;
let admin: Actor;
let broker: Actor;
let brokerCookie: string;
let adminCookie: string;
let applicationId: string;

before(async () => {
  await migrate();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/crm/api`;
});
after(async () => { server.close(); await pool.end(); });

const user = async (email: string, name: string, role: string) => (await query<{ id: string }>(
  `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete)
   VALUES ($1,$2,$3,$4,true,now(),true) RETURNING id`, [orgId, email, name, role])).rows[0]!.id;

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Lendmax','ON') RETURNING id`)).rows[0]!.id;
  const adminId = await user('admin@example.com', 'Alex Admin', 'technical_admin');
  const brokerId = await user('broker@example.com', 'Dana Broker', 'broker');
  admin = { organizationId: orgId, kind: 'user', userId: adminId, name: 'Alex Admin', role: 'technical_admin' };
  broker = { organizationId: orgId, kind: 'user', userId: brokerId, name: 'Dana Broker', role: 'broker' };
  adminCookie = `lmx_crm_session=${(await createSession(adminId, {})).token}`;
  brokerCookie = `lmx_crm_session=${(await createSession(brokerId, {})).token}`;
  await query(`INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
               VALUES ($1,'lead','Lead',1,'open',true)`, [orgId]);
  const customer = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name, email) VALUES ($1,'Rena','Wal','r@x.com') RETURNING id`,
    [orgId])).rows[0]!.id;
  applicationId = (await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, stage_key) VALUES ($1,$2,'lead') RETURNING id`,
    [orgId, customer])).rows[0]!.id;
  await query(`INSERT INTO assignments (application_id, user_id, role, is_primary)
               VALUES ($1,$2,'broker',true)`, [applicationId, brokerId]);
});

const audit = (actor: Actor | { kind: 'system'; name: string }, action: string, summary: string, extra = {}) =>
  recordAudit({
    organizationId: orgId,
    actor: 'userId' in actor ? { userId: actor.userId, name: actor.name, role: actor.role, kind: actor.kind } : actor,
    action, summary, ...extra,
  });

const all = { seeAll: true } as const;
const scopeOf = (a: Actor, seeAll = false) => ({ organizationId: orgId, userId: a.userId, seeAll });

// ── Recording ──────────────────────────────────────────────────────────────

test('what a person does is mirrored from the audit trail, with its module', async () => {
  await audit(admin, 'pipeline.create', 'Pipeline “Renewals” created');
  await audit({ kind: 'system', name: 'Automation' }, 'automation.step', 'The engine did something');
  const { entries, total } = await listActivity({ organizationId: orgId, userId: null, ...all }, {});
  assert.equal(total, 1, 'system actions are not anybody’s activity');
  assert.equal(entries[0]!.action_label, 'Created a pipeline');
  assert.equal(entries[0]!.module, 'pipeline');
  assert.equal(entries[0]!.actor_role_name, 'Technical Admin');
  const mirrored = await queryOne<{ audit_id: string }>('SELECT audit_id FROM activity_logs');
  assert.ok(mirrored!.audit_id, 'points back at the compliance entry');
});

test('an action that rolls back leaves no activity behind', async () => {
  await assert.rejects(withTransaction(async (client) => {
    await recordAudit({ organizationId: orgId, actor: { userId: admin.userId, name: admin.name, kind: 'user' },
                        action: 'user.create', summary: 'Added somebody' }, client);
    throw new Error('the change failed');
  }));
  assert.equal((await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM activity_logs'))!.n, 0);
});

test('opening a file is logged once per person per half hour', async () => {
  assert.equal(await recordFileView(broker, applicationId), true);
  assert.equal(await recordFileView(broker, applicationId), false, 'the second open within 30 minutes is the same visit');
  assert.equal(await recordFileView(admin, applicationId), true, 'somebody else opening it is their own entry');
  // Age the entry, stepping around the no-edit guard on one connection.
  await withTransaction(async (client) => {
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`UPDATE activity_logs SET at = now() - interval '31 minutes' WHERE actor_user_id = $1`,
                       [broker.userId]);
  });
  assert.equal(await recordFileView(broker, applicationId), true, 'after half an hour it is a new visit');

  const { entries } = await listActivity(scopeOf(broker), { action: 'customer.opened' });
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.client_name, 'Rena Wal');
  assert.equal(entries[0]!.application_id, applicationId);
});

test('opening a file in the admin panel records the view', async () => {
  const response = await fetch(`${base}/applications/${applicationId}`, { headers: { cookie: brokerCookie } });
  assert.equal(response.status, 200);
  await new Promise((r) => setTimeout(r, 100)); // logged without holding up the response
  const row = await queryOne<{ summary: string }>(
    `SELECT summary FROM activity_logs WHERE action = 'customer.opened' AND actor_user_id = $1`, [broker.userId]);
  assert.match(row!.summary, /Rena Wal/);
});

// ── Reading ────────────────────────────────────────────────────────────────

test('staff see their own activity only, whatever they ask for', async () => {
  await audit(admin, 'user.create', 'Added Dana');
  await audit(broker, 'message.send', 'Email sent to Rena');
  const own = await listActivity(scopeOf(broker), { user: admin.userId });
  assert.deepEqual(own.entries.map((e) => e.actor_name), ['Dana Broker']);

  const response = await fetch(`${base}/activity?user=${admin.userId}`, { headers: { cookie: brokerCookie } });
  const body = await response.json() as { entries: Array<{ actor_name: string }> };
  assert.equal(response.status, 200);
  assert.deepEqual(body.entries.map((e) => e.actor_name), ['Dana Broker']);

  const options = await activityOptions(scopeOf(broker));
  assert.equal(options.can_view_all, false);
  assert.deepEqual(options.people, [], 'no list of colleagues to pick from');
});

test('an admin sees everyone and can filter by person, module, action and text', async () => {
  await audit(admin, 'user.create', 'Added Dana');
  await audit(broker, 'message.send', 'Email sent to Rena');
  await audit(broker, 'pipeline.file_moved', 'Moved Rena to Lead', { entityType: 'application', entityId: applicationId });
  await recordAudit({ organizationId: orgId, actor: { kind: 'integration', name: 'API: website' },
                      action: 'customer.create', summary: 'Lead from the website' });

  const response = await fetch(`${base}/activity?page_size=10`, { headers: { cookie: adminCookie } });
  assert.equal(((await response.json()) as { total: number }).total, 4);

  const scope = scopeOf(admin, true);
  assert.equal((await listActivity(scope, { user: broker.userId })).total, 2);
  assert.equal((await listActivity(scope, { user: 'me' })).total, 1);
  assert.equal((await listActivity(scope, { user: '__integrations' })).total, 1);
  assert.equal((await listActivity(scope, { module: 'pipeline' })).total, 1);
  assert.equal((await listActivity(scope, { action: 'message.send' })).total, 1);
  assert.equal((await listActivity(scope, { q: 'rena' })).total, 2);
  assert.equal((await listActivity(scope, { client: 'wal' })).total, 1, 'the file link is searchable by client');
  assert.equal((await listActivity(scope, { period: 'today' })).total, 4);
  assert.equal((await listActivity(scope, { period: 'yesterday' })).total, 0);

  const sorted = await listActivity(scope, { sort: 'actor', dir: 'asc' });
  assert.equal(sorted.entries[0]!.actor_name, 'Alex Admin');
  const paged = await listActivity(scope, { page: 2, page_size: 3 });
  assert.equal(paged.entries.length, 1);
  assert.equal(paged.total, 4);

  const options = await activityOptions(scope);
  assert.deepEqual(options.people.map((p) => p.name).sort(), ['Alex Admin', 'Dana Broker']);
  assert.equal(options.integrations, true);
});

test('a website with the scope reads everyone’s activity through the API', async () => {
  await audit(broker, 'message.send', 'Email sent to Rena');
  const { key } = await createApiKey(admin, { name: 'dashboard', permissions: ['activity.view_all'] });
  const response = await fetch(`${base}/v1/activity?user=${broker.userId}`, { headers: { authorization: `Bearer ${key}` } });
  const body = await response.json() as { data: { total: number } };
  assert.equal(response.status, 200);
  assert.equal(body.data.total, 1);

  const { key: narrow } = await createApiKey(admin, { name: 'other', permissions: ['customer.view'] });
  assert.equal((await fetch(`${base}/v1/activity`, { headers: { authorization: `Bearer ${narrow}` } })).status, 403);
  assert.equal((await fetch(`${base}/v1/activity/1`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` } })).status, 404);
});

// ── Keeping 30 days ────────────────────────────────────────────────────────

test('entries cannot be edited or deleted by hand, and the purge removes only what is past 30 days', async () => {
  await audit(admin, 'user.create', 'Added Dana');
  await query(
    `INSERT INTO activity_logs (organization_id, at, actor_user_id, actor_name, action, module, summary)
     VALUES ($1, now() - interval '31 days', $2, 'Alex Admin', 'auth.sign_in', 'account', 'Old sign-in')`,
    [orgId, admin.userId]);

  await assert.rejects(query('DELETE FROM activity_logs WHERE summary = $1', ['Added Dana']), /cannot be deleted/);
  await assert.rejects(query(`UPDATE activity_logs SET summary = 'x'`), /cannot be edited/);
  assert.equal((await listActivity(scopeOf(admin, true), {})).total, 1, 'the screen never shows past 30 days');

  assert.equal(await purgeActivity(), 1);
  const left = await query<{ summary: string }>('SELECT summary FROM activity_logs');
  assert.deepEqual(left.rows.map((r) => r.summary), ['Added Dana']);
  assert.equal((await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM audit_log'))!.n, 1,
               'the compliance trail is untouched');
});

test('recurring jobs run again: a job that returns rerunAt is queued after it finishes', async () => {
  let runs = 0;
  registerHandler('test.recurring', async () => { runs++; return { rerunAt: new Date(Date.now() + 3_600_000) }; });
  await query(`DELETE FROM jobs WHERE kind = 'test.recurring'`);
  await enqueue('test.recurring', {}, { queue: 'test-recurring', dedupeKey: 'test.recurring' });
  const worker = new Worker({ queue: 'test-recurring', idleMs: 50 });
  worker.start();
  for (let i = 0; i < 60 && runs === 0; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
  await worker.stop();
  const jobs = await query<{ state: string }>(
    `SELECT state FROM jobs WHERE kind = 'test.recurring' ORDER BY created_at`);
  assert.equal(runs, 1);
  assert.deepEqual(jobs.rows.map((j) => j.state), ['succeeded', 'pending']);
  await query(`DELETE FROM jobs WHERE kind = 'test.recurring'`);
});
