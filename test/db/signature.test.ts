/**
 * Email signatures, against a real database and over HTTP.
 *
 * The failure these prevent is quiet: a signature that shows the old phone
 * number, or an email that goes out with no signature at all, is not an error
 * anybody sees — only the client does.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { createSession } from '../../src/services/auth.ts';
import { saveSignature, signatureFor } from '../../src/services/signature.ts';
import { updateStaff, type Actor } from '../../src/services/staff.ts';

const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;
let orgId: string;
let brokerId: string;
let customerId: string;
let cookie: string;
let admin: Actor;

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
    `INSERT INTO organizations (name, home_province) VALUES ('Lendmax','ON') RETURNING id`)).rows[0]!.id;
  const adminId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete)
     VALUES ($1,'admin@example.com','Alex Admin','technical_admin',true,now(),true) RETURNING id`,
    [orgId])).rows[0]!.id;
  admin = { organizationId: orgId, kind: 'user', userId: adminId, name: 'Alex Admin', role: 'technical_admin' };
  brokerId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, first_name, last_name, role, active,
                        activated_at, profile_complete)
     VALUES ($1,'priya@example.com','Priya Sandhu','Priya','Sandhu','broker',true,now(),true) RETURNING id`,
    [orgId])).rows[0]!.id;
  await query(
    `INSERT INTO user_profiles (user_id, title, mobile_phone, licence_number, licence_province)
     VALUES ($1,'Mortgage Agent','+16475550110','M123','ON')`, [brokerId]);
  customerId = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name, email)
     VALUES ($1,'Sarah','Johnson','sarah@example.com') RETURNING id`, [orgId])).rows[0]!.id;
  cookie = `lmx_crm_session=${(await createSession(brokerId, {})).token}`;
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

const lastMessage = () => queryOne<{ body_text: string; body_html: string | null }>(
  'SELECT body_text, body_html FROM messages ORDER BY created_at DESC LIMIT 1');

test('everybody starts with a standard signature built from their profile', async () => {
  const sig = await signatureFor(brokerId);
  assert.equal(sig!.text, 'Priya Sandhu\nMortgage Agent\nLendmax\nLicence M123 (ON)\nMobile (647) 555-0110\npriya@example.com');
  assert.match(sig!.html, /<strong>Priya Sandhu<\/strong>/);
});

test('a standard signature follows the profile without anybody re-saving it', async () => {
  await signatureFor(brokerId);
  await updateStaff(admin, brokerId, { mobile_phone: '416-555-0199', title: 'Senior Agent' });
  const sig = await signatureFor(brokerId);
  assert.match(sig!.text, /Senior Agent/);
  assert.match(sig!.text, /\(416\) 555-0199/);
  assert.equal(sig!.text.includes('555-0110'), false, 'the old number is gone');
});

test('a person edits their own signature, and it is audited', async () => {
  const result = await call('PUT', '/auth/signature',
    { mode: 'custom', source: 'Cheers,\n**{first_name}**\n{mobile}' });
  assert.equal(result.status, 200);
  assert.equal(result.body.signature.text, 'Cheers,\nPriya\n(647) 555-0110');
  const audit = await queryOne<{ summary: string }>(
    `SELECT summary FROM audit_log WHERE action = 'user.signature_updated'`);
  assert.match(audit!.summary, /Priya Sandhu changed their email signature/);
});

test('a custom signature with an unknown field, or with nothing that would show, is refused', async () => {
  const unknown = await call('PUT', '/auth/signature', { mode: 'custom', source: '{name}\n{fax}' });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.fields[0].field, 'source');

  const empty = await call('PUT', '/auth/signature', { mode: 'custom', source: 'Direct {direct}' });
  assert.equal(empty.status, 422, 'Priya has no direct line, so nothing would show');
});

test('a broker cannot change somebody else’s signature', async () => {
  const result = await call('PUT', `/staff/${admin.userId}/signature`, { mode: 'standard' });
  assert.equal(result.status, 403);
});

test('an email from the composer carries the signature, in both parts', async () => {
  await saveSignature({ ...admin, userId: brokerId, name: 'Priya Sandhu' }, brokerId,
                      { mode: 'custom', source: 'Warm regards,\n**{name}**\nhttps://lendmax.ca' });
  const result = await call('POST', `/customers/${customerId}/messages`, {
    channel: 'email', subject: 'Documents', body_text: 'Hi {first_name},\n\nGot them, thank you.',
  });
  assert.equal(result.status, 200);
  const message = await lastMessage();
  assert.equal(message!.body_text,
    'Hi Sarah,\n\nGot them, thank you.\n\nWarm regards,\nPriya Sandhu\nhttps://lendmax.ca');
  assert.match(message!.body_html!, /<strong>Priya Sandhu<\/strong>/);
  assert.match(message!.body_html!, /href="https:\/\/lendmax\.ca"/);
});

test('the signature can be left off one email', async () => {
  await call('POST', `/customers/${customerId}/messages`, {
    channel: 'email', subject: 'Quick one', body_text: 'Hi Sarah', include_signature: false,
  });
  const message = await lastMessage();
  assert.equal(message!.body_text, 'Hi Sarah');
  assert.equal(message!.body_html!.includes('lmx-signature'), false);
});

test('{signature} places it where it is written, and it is not added twice', async () => {
  await call('POST', `/customers/${customerId}/messages`, {
    channel: 'email', subject: 'Placed', body_text: 'Hi Sarah\n\n{signature}\n\nP.S. Talk soon.',
  });
  const message = await lastMessage();
  assert.equal(message!.body_text.match(/Priya Sandhu/g)?.length, 1);
  assert.match(message!.body_text, /Priya Sandhu[\s\S]*P\.S\. Talk soon\.$/);
});

test('a text message never gets a signature', async () => {
  await query(`UPDATE customers SET phone_e164 = '+14165550142' WHERE id = $1`, [customerId]);
  await call('POST', `/customers/${customerId}/messages`, { channel: 'sms', body_text: 'Running 5 min late' });
  const message = await lastMessage();
  assert.equal(message!.body_text, 'Running 5 min late');
});

test('the service refuses a bad signature before storing anything', async () => {
  await assert.rejects(
    saveSignature(admin, brokerId, { mode: 'custom', source: 'x'.repeat(1001) }),
    (err: unknown) => err instanceof ZodError);
  const row = await queryOne<{ signature_mode: string }>(
    'SELECT signature_mode FROM user_profiles WHERE user_id = $1', [brokerId]);
  assert.equal(row!.signature_mode, 'standard');
});
