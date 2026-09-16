/**
 * Send to Scarlett from the file, against a real database and a stand-in for
 * Scarlett's API: nothing here leaves the machine.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { createSession } from '../../src/services/auth.ts';
import { saveIntegration } from '../../src/services/integrations.ts';
import { importMirrorPayload, type MirrorPayload } from '../../src/services/portal-import.ts';
import { SCARLETT_HOST } from '../../src/integrations/scarlett.ts';

const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;
let orgId: string;
let applicationId: string;
let cookies: Record<'admin' | 'owner' | 'other', string>;

/** Calls that were meant for Scarlett, and what the stand-in answers. */
let scarlettCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
let scarlettReply: () => Promise<{ status: number; body: unknown }>;
const realFetch = globalThis.fetch;

before(async () => {
  await migrate();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(SCARLETT_HOST)) return realFetch(input, init);
    scarlettCalls.push({ path: url.slice(SCARLETT_HOST.length + 1), body: JSON.parse(String(init?.body)) });
    const reply = await scarlettReply();
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/crm/api`;
});
after(async () => { globalThis.fetch = realFetch; server.close(); await pool.end(); });

const user = async (email: string, role: string, overrides: Record<string, boolean> = {}) => {
  const id = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete, permission_overrides)
     VALUES ($1,$2,$2,$3,true,now(),true,$4) RETURNING id`, [orgId, email, role, JSON.stringify(overrides)])).rows[0]!.id;
  return { id, cookie: `lmx_crm_session=${(await createSession(id, {})).token}` };
};

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  scarlettCalls = [];
  scarlettReply = async () => ({ status: 200, body: { ReturnCode: 0, Data: { DealID: 'SC-777' } } });
  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Lendmax','ON') RETURNING id`)).rows[0]!.id;
  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category)
     VALUES ($1,'lead','Lead',1,'open'), ($1,'application','Application',2,'open')`, [orgId]);
  await query(
    `INSERT INTO transaction_types (organization_id, key, label, position, portal_purpose)
     VALUES ($1,'refinance','Refinance',1,'Refinance')`, [orgId]);

  applicationId = (await importMirrorPayload({
    portal_id: 5150, reference: 'LMX-A-202609-5150', status: 'submitted', percent: 100,
    first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com', phone: '(416) 555-0199',
    purpose: 'Refinance', amount_requested: 325000, property_city: 'Calgary', property_province: 'AB',
    applicant_count: 1, document_count: 0, documents: [],
    created_at: '2026-09-14T01:30:00Z', updated_at: '2026-09-14T01:30:00Z',
    data: {
      purpose: { purpose: 'Refinance', amount_requested: 325000, request_position: '1' },
      property: { is_subject: true, street_number: '48', street_name: 'Sora Terrace', city: 'Calgary',
                  province: 'AB', postal_code: 'T3S 0M5', property_value: 500000 },
      applicants: [{ first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com' }],
    },
  } as MirrorPayload, { organizationId: orgId })).id;

  const admin = await user('admin@example.com', 'technical_admin');
  // Brokers do not send to Scarlett by default; these two have been granted it.
  const owner = await user('owner@example.com', 'broker', { 'scarlett.push': true });
  const other = await user('other@example.com', 'broker', { 'scarlett.push': true });
  await query(`INSERT INTO assignments (application_id, user_id, role, is_primary) VALUES ($1,$2,'broker',true)`,
    [applicationId, owner.id]);
  cookies = { admin: admin.cookie, owner: owner.cookie, other: other.cookie };
});

const connect = async (mode: 'live' | 'sandbox' = 'live', codes = true) => {
  await saveIntegration(orgId, 'scarlett', {
    enabled: true, config: { mode, firm_code: 'LMX', expert_login: 'ali' }, secrets: { api_key: 'sk-test' },
  }, null as unknown as string);
  // As if "Pull code tables" had been pressed once.
  if (codes) {
    await query(
      `INSERT INTO scarlett_codes (organization_id, menu_code, item_value, item_label, normalised)
       VALUES ($1,'ProvinceDD','1','Alberta','alberta') ON CONFLICT DO NOTHING`, [orgId]);
  }
};

const call = async (who: keyof typeof cookies, path: string, body?: unknown) => {
  const res = await fetch(`${base}/applications/${applicationId}/scarlett/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: cookies[who], 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
};

test('before Scarlett is connected, the check says so and nothing is sent', async () => {
  const preview = await call('admin', 'preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.configured, false);
  const push = await call('admin', 'push', { accept_unmapped: true });
  assert.equal(push.status, 422);
  assert.equal(push.body.code, 'not_configured');
  assert.equal(scarlettCalls.length, 0);
});

test('until the code tables are pulled, the check blocks the send and says why', async () => {
  await connect('live', false);
  const preview = await call('owner', 'preview');
  assert.equal(preview.body.codesPulled, false);
  assert.equal(preview.body.ready, false);
  assert.match(preview.body.blockers.join(' '), /code tables/);
  assert.equal((await call('owner', 'push', { accept_unmapped: true })).status, 422);
  assert.equal(scarlettCalls.length, 0);
});

test('one confirmed click sends the deal, links it, and a second send is refused', async () => {
  await connect();
  const preview = await call('owner', 'preview');
  assert.equal(preview.body.ready, true, JSON.stringify(preview.body.blockers));
  assert.equal(preview.body.alreadyPushed, null);

  const push = await call('owner', 'push', { accept_unmapped: true });
  assert.equal(push.status, 200, JSON.stringify(push.body));
  assert.equal(push.body.dealId, 'SC-777');
  assert.equal(scarlettCalls.length, 1);
  assert.equal(scarlettCalls[0]!.path, 'dosconnect/deal-push');
  assert.equal(scarlettCalls[0]!.body.APIKey, 'sk-test', 'the key travels in the body');

  const file = await queryOne<{ scarlett_deal_id: string; scarlett_sync_state: string }>(
    'SELECT scarlett_deal_id, scarlett_sync_state FROM applications WHERE id = $1', [applicationId]);
  assert.deepEqual(file, { scarlett_deal_id: 'SC-777', scarlett_sync_state: 'ok' });
  const audit = await queryOne<{ summary: string }>(`SELECT summary FROM audit_log WHERE action = 'scarlett.push'`);
  assert.equal(audit!.summary, 'Sent LMX-A-202609-5150 to Scarlett as SC-777');

  assert.equal((await call('owner', 'preview')).body.alreadyPushed, 'SC-777');
  const again = await call('owner', 'push', { accept_unmapped: true });
  assert.equal(again.status, 422);
  assert.match(again.body.error, /already in Scarlett/);
  assert.equal(scarlettCalls.length, 1, 'no second deal');

  const overwrite = await call('owner', 'push', { accept_unmapped: true, overwrite: true });
  assert.equal(overwrite.status, 200);
  assert.equal(scarlettCalls[1]!.body.OverwriteIfExist, true);
});

test('a double click sends once', async () => {
  await connect();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  scarlettReply = async () => { await gate; return { status: 200, body: { DealID: 'SC-1' } }; };

  const first = call('owner', 'push', { accept_unmapped: true });
  await new Promise((r) => setTimeout(r, 150));
  const second = await call('owner', 'push', { accept_unmapped: true });
  release();
  assert.equal(second.status, 409);
  assert.equal((await first).status, 200);
  assert.equal(scarlettCalls.length, 1);
});

test('a failure from Scarlett is reported and marked on the file', async () => {
  await connect();
  scarlettReply = async () => ({ status: 400, body: { ReturnMessage: 'Invalid FirmCode' } });
  const push = await call('owner', 'push', { accept_unmapped: true });
  assert.equal(push.status, 422);
  assert.match(push.body.error, /Invalid FirmCode/);
  const file = await queryOne<{ scarlett_sync_state: string }>(
    'SELECT scarlett_sync_state FROM applications WHERE id = $1', [applicationId]);
  assert.equal(file!.scarlett_sync_state, 'error');
});

test('sandbox sends nothing; a broker cannot send a file that is not theirs', async () => {
  await connect('sandbox');
  const sandbox = await call('owner', 'push', { accept_unmapped: true });
  assert.equal(sandbox.body.code, 'sandbox');
  assert.equal(scarlettCalls.length, 0);

  await connect('live');
  assert.equal((await call('other', 'preview')).status, 404);
  assert.equal((await call('other', 'push', { accept_unmapped: true })).status, 404);
  assert.equal(scarlettCalls.length, 0);
});

test('the admin can send, but the check does not show them the financial payload', async () => {
  await connect();
  const preview = await call('admin', 'preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.deal, null);
  assert.equal((await call('owner', 'preview')).body.deal !== null, true);
  assert.equal((await call('admin', 'push', { accept_unmapped: true })).status, 200);
});
