/**
 * Sending from a client's file, against a real database.
 *
 * This route exists because the alternative was a `mailto:` link, which goes
 * around the consent gate and records nothing. So the tests are about
 * exactly that: every send goes through the gate, a refusal is recorded
 * rather than thrown away, and an ad-hoc message cannot reach a client with
 * a placeholder in it.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { createSession } from '../../src/services/auth.ts';

let orgId: string;
let brokerId: string;
let customerId: string;
let applicationId: string;
let cookie: string;
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
  brokerId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, profile_complete)
     VALUES ($1,'dana@example.com','Dana Broker','broker',true,true) RETURNING id`, [orgId])
  ).rows[0]!.id;
  await query(
    `INSERT INTO user_profiles (user_id, mobile_phone) VALUES ($1,'+14165550142')`, [brokerId]);

  customerId = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name, email, phone_e164)
     VALUES ($1,'Renee','Okafor','renee@example.com','+14165550100') RETURNING id`, [orgId])
  ).rows[0]!.id;
  applicationId = (await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, property_province, portal_reference)
     VALUES ($1,$2,'ON','LMX-A-TEST-1') RETURNING id`, [orgId, customerId])
  ).rows[0]!.id;

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

const message = {
  channel: 'email', subject: 'About {portal_reference}',
  body_text: 'Hi {first_name},\n\nThe appraisal is back.',
};

test('the composer shows what the gate would say, before a word is written', async () => {
  const result = await call('GET', `/customers/${customerId}/messages`);
  assert.equal(result.status, 200);
  assert.equal(result.body.gates.email.allowed, true);
  assert.match(result.body.gates.email.reason, /own application/);
  // And separately for anything commercial, which is the answer that differs.
  assert.equal(result.body.gates.email.marketing.allowed, false);
  assert.match(result.body.gates.email.marketing.reason, /No marketing consent/);
});

test('a transactional message sends and lands on the file', async () => {
  const result = await call('POST', `/customers/${customerId}/messages`,
    { ...message, application_id: applicationId });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);

  const stored = await queryOne<{ subject: string; body_text: string; origin: string;
                                  sent_by: string; status: string }>(
    'SELECT subject, body_text, origin, sent_by, status FROM messages');
  assert.equal(stored!.subject, 'About LMX-A-TEST-1', 'the subject merged');
  assert.match(stored!.body_text, /Hi Renee/);
  assert.equal(stored!.origin, 'manual');
  assert.equal(stored!.sent_by, brokerId, 'attributed to whoever sent it');
});

test('a commercial message with no consent is recorded, not thrown away', async () => {
  // The broker did nothing wrong; the system declined on the client's behalf.
  // An absent row would leave "why was this client never told" unanswerable.
  const result = await call('POST', `/customers/${customerId}/messages`,
    { ...message, purpose: 'marketing' });
  assert.equal(result.status, 200, 'a refusal is not an error');
  assert.equal(result.body.ok, false);
  assert.match(String(result.body.reason), /No marketing consent/);

  const stored = await queryOne<{ status: string; gate_decision: { reason: string } }>(
    'SELECT status, gate_decision FROM messages');
  assert.equal(stored!.status, 'suppressed');
  assert.match(stored!.gate_decision.reason, /No marketing consent/);

  const audit = await queryOne<{ action: string; summary: string }>(
    `SELECT action, summary FROM audit_log WHERE action LIKE 'message%' ORDER BY at DESC LIMIT 1`);
  assert.equal(audit!.action, 'message.suppressed');
  assert.match(audit!.summary, /not sent/i);
});

test('an unsubscribed client stops receiving commercial mail and nothing else', async () => {
  await query(
    `INSERT INTO consents (organization_id, customer_id, channel, purpose, basis, granted, source)
     VALUES ($1,$2,'email','marketing','express',true,'crm')`, [orgId, customerId]);
  await query(
    `INSERT INTO suppressions (organization_id, customer_id, address, channel, scope, reason)
     VALUES ($1,$2,'renee@example.com','email','marketing','unsubscribe')`,
    [orgId, customerId]);

  const marketing = await call('POST', `/customers/${customerId}/messages`,
    { ...message, purpose: 'marketing' });
  assert.equal(marketing.body.ok, false);

  const transactional = await call('POST', `/customers/${customerId}/messages`, message);
  assert.equal(transactional.body.ok, true,
    'a marketing unsubscribe does not stop mail about their own mortgage');
});

test('a merge field that does not exist is refused at the composer', async () => {
  const result = await call('POST', `/customers/${customerId}/messages`,
    { ...message, body_text: 'Hi {clietn_name}.' });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /no merge field called \{clietn_name\}/);

  const stored = await query('SELECT 1 FROM messages');
  assert.equal(stored.rows.length, 0, 'and nothing was sent');
});

test('a line whose field has no value is dropped, and the sender is told', async () => {
  const result = await call('POST', `/customers/${customerId}/messages`, {
    ...message,
    body_text: 'Hi {first_name},\n\nYour mortgage matures on {maturity_date}.\n\nDana',
  });
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.dropped, ['Your mortgage matures on {maturity_date}.']);

  const stored = await queryOne<{ body_text: string }>('SELECT body_text FROM messages');
  assert.doesNotMatch(stored!.body_text, /matures/);
  assert.doesNotMatch(stored!.body_text, /\{maturity_date\}/);
});

test('a message that would be empty after the drops is refused, not sent blank', async () => {
  const result = await call('POST', `/customers/${customerId}/messages`,
    { ...message, body_text: 'Your rate is {maturity_date}.' });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /Nothing would be sent/);
});

test('a subject that cannot merge stops the send rather than showing a placeholder', async () => {
  const result = await call('POST', `/customers/${customerId}/messages`,
    { ...message, subject: 'Your renewal on {maturity_date}' });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /The subject needs maturity_date/);
});

test('an email with no subject is refused', async () => {
  const result = await call('POST', `/customers/${customerId}/messages`,
    { channel: 'email', body_text: 'Hi {first_name}.' });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /needs a subject/);
});

test('the preview counts SMS segments and names what made it two', async () => {
  const result = await call('POST', `/customers/${customerId}/messages/preview`, {
    channel: 'sms',
    body_text: 'Hi {first_name}, I’ve sent the documents over — have a look when you '
      + 'get a chance and let me know if anything looks wrong to you at all today.',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.segments.encoding, 'UCS-2');
  assert.ok(result.body.segments.offenders.length > 0,
    'and says which characters cost the extra segment');
});

test('the thread shows a suppressed message alongside the ones that went', async () => {
  await call('POST', `/customers/${customerId}/messages`, message);
  await call('POST', `/customers/${customerId}/messages`, { ...message, purpose: 'marketing' });

  const thread = await call('GET', `/customers/${customerId}/messages`);
  assert.equal(thread.body.messages.length, 2);
  const statuses = thread.body.messages.map((m: { status: string }) => m.status).sort();
  assert.deepEqual(statuses, ['sent', 'suppressed']);
});
