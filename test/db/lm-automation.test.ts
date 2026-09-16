/**
 * LM Automation, end to end against a real database: a portal application
 * fires a trigger, the workflow tests the client's own answers (purpose and
 * income), takes a branch, moves the stage through the stage machine, tags
 * the client, assigns a broker and tells them — and the parts that must not
 * happen don't.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { createSession } from '../../src/services/auth.ts';
import { createApiKey } from '../../src/services/api-keys.ts';
import { importMirrorPayload, type MirrorPayload } from '../../src/services/portal-import.ts';
import {
  dryRun, emitTimeEvents, gatherFacts, processEvents, runStep,
} from '../../src/services/automation-engine.ts';
import { DefinitionSchema } from '../../src/domain/automation.ts';

const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;
let orgId: string;
let brokerId: string;
let managerCookie: string;

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
  await query('TRUNCATE jobs');
  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Lendmax','ON') RETURNING id`)).rows[0]!.id;
  brokerId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete, round_robin_enabled)
     VALUES ($1,'dana@example.com','Dana Broker','broker',true,now(),true,true) RETURNING id`, [orgId])).rows[0]!.id;
  const managerId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete)
     VALUES ($1,'mia@example.com','Mia Manager','manager',true,now(),true) RETURNING id`, [orgId])).rows[0]!.id;
  managerCookie = `lmx_crm_session=${(await createSession(managerId, {})).token}`;
  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
     VALUES ($1,'lead','Lead',1,'open',true), ($1,'application','Application',2,'open',true),
            ($1,'fast_track','Fast track',3,'open',true), ($1,'funded','Funded',4,'won',true)`, [orgId]);
});

const portalFile = (purpose: string, income: number, reference: string, email: string): MirrorPayload => ({
  portal_id: Math.floor(Math.random() * 1e6), reference, status: 'submitted', percent: 100,
  first_name: 'Sarah', last_name: 'Chen', email, phone: `(416) 555-${String(1000 + Math.floor(Math.random() * 8999))}`,
  purpose, amount_requested: 520000, property_city: 'Toronto', property_province: 'ON',
  applicant_count: 1, document_count: 0, documents: [],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), submitted_at: new Date().toISOString(),
  data: {
    purpose: { purpose, amount_requested: 520000, request_position: '1' },
    property: { city: 'Toronto', province: 'ON', purchase_price: 650000, down_payment: 130000 },
    applicants: [{ first_name: 'Sarah', last_name: 'Chen', email, annual_income: income }],
  },
} as MirrorPayload);

async function publish(name: string, definition: unknown) {
  const a = (await query<{ id: string }>(
    `INSERT INTO automations (organization_id, key, name, status, published_version)
     VALUES ($1,$2,$3,'active',1) RETURNING id`, [orgId, name.toLowerCase().replace(/\W+/g, '_'), name])).rows[0]!.id;
  await query(
    `INSERT INTO automation_versions (automation_id, version, definition, published_at)
     VALUES ($1,1,$2::jsonb, now())`, [a, JSON.stringify(DefinitionSchema.parse(definition))]);
  return a;
}

/** Drain the event bus, then run every enrollment until it rests. */
async function runAll() {
  await processEvents(orgId);
  for (let round = 0; round < 20; round++) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM automation_enrollments WHERE organization_id = $1 AND status = 'active'
          AND (next_run_at IS NULL OR next_run_at <= now())`, [orgId]);
    if (!rows.length) break;
    let moved = false;
    for (const r of rows) {
      const out = await runStep(r.id);
      if (out.status === 'advanced' || out.status === 'completed' || out.status === 'stopped') moved = true;
    }
    await processEvents(orgId);
    if (!moved) break;
  }
}

const FAST_TRACK = {
  triggers: [{ type: 'application.submitted', filters: [] }],
  stop_conditions: [{ field: 'stage_category', op: 'eq', value: 'lost', reason: 'Lost' }],
  start_node: 'split',
  nodes: [
    { key: 'split', type: 'if_else', else_next: 'standard', branches: [{
      key: 'b1', name: 'Fast track', next: 'stage',
      conditions: [{ field: 'purpose.purpose', op: 'eq', value: 'Purchase' },
                   { field: 'calc.total_income', op: 'gt', value: 150000 }] }] },
    { key: 'stage', type: 'set_stage', stage_key: 'fast_track', next: 'tag' },
    { key: 'tag', type: 'add_tag', tag: 'fast-track', next: 'assign' },
    { key: 'assign', type: 'assign_user', mode: 'round_robin', role: 'broker', only_if_unassigned: true, next: 'notify' },
    { key: 'notify', type: 'notify_user', role: 'broker', title: 'Fast track: {first_name}', next: null },
    { key: 'standard', type: 'add_tag', tag: 'standard', next: null },
  ],
};

test('purpose and income on the application decide the branch, and every step does its work', async () => {
  await publish('Fast track', FAST_TRACK);
  const big = await importMirrorPayload(portalFile('Purchase', 180000, 'LMX-1', 'big@example.com'), { organizationId: orgId });
  const small = await importMirrorPayload(portalFile('Purchase', 60000, 'LMX-2', 'small@example.com'), { organizationId: orgId });
  const refi = await importMirrorPayload(portalFile('Refinance', 400000, 'LMX-3', 'refi@example.com'), { organizationId: orgId });
  await runAll();

  const file = async (id: string) => queryOne<{ stage_key: string; tags: string[]; broker: string | null }>(
    `SELECT app.stage_key, c.tags,
            (SELECT a.user_id FROM assignments a WHERE a.application_id = app.id AND a.role = 'broker'
                AND a.is_primary AND a.unassigned_at IS NULL LIMIT 1) AS broker
       FROM applications app JOIN customers c ON c.id = app.customer_id WHERE app.id = $1`, [id]);

  const bigFile = await file(big.id);
  assert.equal(bigFile!.stage_key, 'fast_track', 'moved through the stage machine');
  assert.deepEqual(bigFile!.tags, ['fast-track']);
  assert.equal(bigFile!.broker, brokerId, 'assigned by round robin');
  const note = await queryOne<{ title: string }>(`SELECT title FROM notifications WHERE kind = 'workflow'`);
  assert.equal(note!.title, 'Fast track: Sarah');
  const transition = await queryOne<{ reason: string }>(
    `SELECT reason FROM stage_transitions WHERE application_id = $1 AND to_stage_key = 'fast_track'`, [big.id]);
  assert.match(transition!.reason ?? '', /Automation: Fast track/);

  for (const other of [small, refi]) {
    const f = await file(other.id);
    assert.deepEqual(f!.tags, ['standard'], 'None path');
    assert.notEqual(f!.stage_key, 'fast_track');
  }

  const executions = await query<{ outcome: string; reason: string }>(
    `SELECT x.outcome, x.reason FROM automation_executions x JOIN automation_enrollments e ON e.id = x.enrollment_id
      WHERE e.application_id = $1 AND x.node_type = 'if_else'`, [big.id]);
  assert.equal(executions.rows[0]!.reason, 'Matched "Fast track"');
});

test('a trigger filter on the event, several triggers, and a workflow not starting itself', async () => {
  const id = await publish('VIP', {
    triggers: [
      { type: 'tag.added', filters: [{ field: 'event.tag', op: 'eq', value: 'vip' }] },
      { type: 'lead.assigned', filters: [] },
    ],
    start_node: 'tag', nodes: [{ key: 'tag', type: 'add_tag', tag: 'vip', next: 'note' }, { key: 'note', type: 'add_note', body: 'VIP handling', next: null }],
  });
  const customer = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, email) VALUES ($1,'Omar','o@example.com') RETURNING id`, [orgId])).rows[0]!.id;
  await query(
    `INSERT INTO domain_events (organization_id, event_type, customer_id, payload, dedupe_key)
     VALUES ($1,'tag.added',$2,'{"tag":"other"}','t1'), ($1,'tag.added',$2,'{"tag":"vip"}','t2')`, [orgId, customer]);
  // Re-entry allowed, so only the self-trigger guard stands between its own
  // "tag added" and a loop.
  await query(`UPDATE automations SET allow_reenrollment = true WHERE id = $1`, [id]);
  await runAll();
  await runAll();
  const own = await query(`SELECT 1 FROM domain_events WHERE event_type = 'tag.added' AND payload->>'by_automation' = $1`, [id]);
  assert.equal(own.rowCount, 1, 'its step tagged the client and said so');
  const enrollments = await query(`SELECT id FROM automation_enrollments WHERE automation_id = $1`, [id]);
  assert.equal(enrollments.rowCount, 1, '"other" did not match the filter, "vip" did, and its own tag did not start it again');
});

test('time triggers only count from the moment the workflow went live', async () => {
  const id = await publish('Quiet files', {
    triggers: [{ type: 'no_activity', after_hours: 24, filters: [] }],
    start_node: 'tag', nodes: [{ key: 'tag', type: 'add_tag', tag: 'quiet', next: null }],
  });
  const customer = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, email) VALUES ($1,'Old','old@example.com') RETURNING id`, [orgId])).rows[0]!.id;
  // Quiet for a year: it went quiet long before the workflow existed.
  await query(
    `INSERT INTO applications (organization_id, customer_id, stage_key, last_activity_at, created_at)
     VALUES ($1,$2,'lead', now() - interval '365 days', now() - interval '400 days')`, [orgId, customer]);
  // Quiet for 30 hours, against a workflow published 12 hours ago: crossed the line after it went live.
  const recent = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, email) VALUES ($1,'Recent','r@example.com') RETURNING id`, [orgId])).rows[0]!.id;
  await query(
    `INSERT INTO applications (organization_id, customer_id, stage_key, last_activity_at)
     VALUES ($1,$2,'lead', now() - interval '30 hours')`, [orgId, recent]);
  await query(`UPDATE automation_versions SET published_at = now() - interval '12 hours' WHERE automation_id = $1`, [id]);

  const raised = await emitTimeEvents(orgId, { force: true });
  assert.equal(raised, 1);
  assert.equal(await emitTimeEvents(orgId, { force: true }), 1, 'the same spell raises the same key again…');
  await runAll();
  const tagged = await query<{ first_name: string }>(`SELECT first_name FROM customers WHERE 'quiet' = ANY(tags)`);
  assert.deepEqual(tagged.rows.map((r) => r.first_name), ['Recent'], '…and enrols once');
});

test('the dry run walks the path against a real file and changes nothing', async () => {
  const big = await importMirrorPayload(portalFile('Purchase', 180000, 'LMX-9', 'dry@example.com'), { organizationId: orgId });
  const customerId = (await queryOne<{ customer_id: string }>('SELECT customer_id FROM applications WHERE id = $1', [big.id]))!.customer_id;
  const result = await dryRun(DefinitionSchema.parse(FAST_TRACK), orgId, customerId, big.id);
  assert.deepEqual(result.steps.map((s) => s.key), ['split', 'stage', 'tag', 'assign', 'notify']);
  assert.equal(result.steps[0]!.detail, 'Takes "Fast track"');
  assert.equal(result.facts['calc.total_income'], 180000);
  const facts = await gatherFacts(pool, customerId, big.id);
  assert.equal(facts.stage_key, 'lead', 'nothing moved');
});

test('the builder API: catalogue, test, duplicate, and the log', async () => {
  const headers = { cookie: managerCookie, 'content-type': 'application/json' };
  const catalogue = await (await fetch(`${base}/automations/catalogue`, { headers })).json() as Record<string, any>;
  assert.ok(catalogue.fields.some((f: { field: string }) => f.field === 'calc.total_income'));
  assert.ok(catalogue.actions.some((a: { type: string }) => a.type === 'if_else'));

  const created = await (await fetch(`${base}/automations`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'From the builder', definition: { triggers: [], start_node: '', nodes: [] } }),
  })).json() as { id: string };
  const saved = await (await fetch(`${base}/automations/${created.id}`, {
    method: 'PUT', headers, body: JSON.stringify({ definition: FAST_TRACK }),
  })).json() as { issues: Array<{ level: string }> };
  assert.deepEqual(saved.issues.filter((i) => i.level === 'error'), []);

  const big = await importMirrorPayload(portalFile('Purchase', 200000, 'LMX-10', 'api@example.com'), { organizationId: orgId });
  const customerId = (await queryOne<{ customer_id: string }>('SELECT customer_id FROM applications WHERE id = $1', [big.id]))!.customer_id;
  const tested = await (await fetch(`${base}/automations/${created.id}/test`, {
    method: 'POST', headers, body: JSON.stringify({ customer_id: customerId }),
  })).json() as { steps: Array<{ key: string }>; entry_pass: boolean };
  assert.equal(tested.entry_pass, true);
  assert.equal(tested.steps[1]!.key, 'stage');

  const copy = await fetch(`${base}/automations/${created.id}/duplicate`, { method: 'POST', headers });
  assert.equal(copy.status, 201);
  const logs = await fetch(`${base}/automations/${created.id}/executions`, { headers });
  assert.equal(logs.status, 200);
});

test('two workflows can share a name, a half-built step still saves, and a malformed id is not found', async () => {
  const headers = { cookie: managerCookie, 'content-type': 'application/json' };
  const create = () => fetch(`${base}/automations`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'New workflow', definition: { triggers: [], start_node: '', nodes: [] } }),
  });
  const first = await create();
  const second = await create();
  assert.equal(first.status, 201);
  assert.equal(second.status, 201, 'starting from scratch twice must not clash');
  const { id } = await first.json() as { id: string };

  const saved = await fetch(`${base}/automations/${id}`, {
    method: 'PUT', headers, body: JSON.stringify({ definition: {
      triggers: [{ type: 'manual' }], start_node: 'enrol', nodes: [
        { key: 'enrol', type: 'enroll_automation', automation_id: '', next: 'hook' },
        { key: 'hook', type: 'webhook', url: 'https://', next: null },
      ] } }),
  });
  assert.equal(saved.status, 200);
  const { issues } = await saved.json() as { issues: Array<{ level: string; node?: string }> };
  assert.deepEqual(issues.filter((i) => i.level === 'error').map((i) => i.node), ['enrol', 'hook']);
  const published = await fetch(`${base}/automations/${id}/publish`, { method: 'POST', headers, body: '{}' });
  assert.equal(published.status, 400, 'and it cannot go live that way');

  assert.equal((await fetch(`${base}/automations/undefined`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/enrollments/nope/pause`, { method: 'POST', headers, body: '{}' })).status, 404);
});

test('an inbound webhook starts only the workflow it was sent to', async () => {
  const listening = await publish('Website score', {
    triggers: [{ type: 'webhook.received', filters: [{ field: 'event.score', op: 'gt', value: 70 }] }],
    start_node: 'tag', nodes: [{ key: 'tag', type: 'add_tag', tag: 'hot', next: null }],
  });
  const other = await publish('Other hook', {
    triggers: [{ type: 'webhook.received', filters: [] }],
    start_node: 'tag', nodes: [{ key: 'tag', type: 'add_tag', tag: 'other', next: null }],
  });
  await query(`INSERT INTO customers (organization_id, first_name, email) VALUES ($1,'Web','web@example.com')`, [orgId]);
  const key = await createApiKey(
    { organizationId: orgId, kind: 'user', userId: brokerId, name: 'Dana Broker', role: 'broker' } as never,
    { name: 'Website', permissions: ['automation.control'] });
  const call = (body: unknown) => fetch(`${base}/v1/automations/${listening}/webhook`, {
    method: 'POST', headers: { authorization: `Bearer ${(key as { key: string }).key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal((await call({ email: 'nobody@example.com' })).status, 404);
  assert.equal((await call({ email: 'web@example.com', data: { score: 40 } })).status, 202);
  assert.equal((await call({ email: 'web@example.com', data: { score: 90 } })).status, 202);
  await runAll();
  const tags = await queryOne<{ tags: string[] }>(`SELECT tags FROM customers WHERE email = 'web@example.com'`);
  assert.deepEqual(tags!.tags, ['hot'], 'score 40 filtered out, 90 let in, and the other workflow never ran');
  assert.equal((await query('SELECT 1 FROM automation_enrollments WHERE automation_id = $1', [other])).rowCount, 0);
});
