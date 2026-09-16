/**
 * The customer record, against a real database: correcting contact details,
 * merging a duplicate, archiving a file, and exporting the list.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { createSession } from '../../src/services/auth.ts';
import { gateFor } from '../../src/services/messaging.ts';
import {
  findDuplicates, mergeCustomers, setArchived, updateCustomer, type CustomerScope,
} from '../../src/services/customers.ts';
import type { Actor } from '../../src/services/staff.ts';

const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;
let orgId: string;
let manager: Actor, dana: Actor, evan: Actor, alex: Actor;
let managerCookie: string, adminCookie: string;

before(async () => {
  await migrate();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/crm/api`;
});
after(async () => { server.close(); await pool.end(); });

const person = async (email: string, name: string, role: string): Promise<Actor> => {
  const id = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete)
     VALUES ($1,$2,$3,$4,true,now(),true) RETURNING id`, [orgId, email, name, role])).rows[0]!.id;
  return { organizationId: orgId, kind: 'user', userId: id, name, role };
};

const all = (a: Actor): CustomerScope => ({ actor: a, viewAll: true });
const own = (a: Actor): CustomerScope => ({ actor: a, viewAll: false });

/** A customer with one file, assigned to `owner` when given. */
const client = async (first: string, email: string | null, phone: string | null, owner?: Actor) => {
  const customerId = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name, email, phone_e164)
     VALUES ($1,$2,'Walsh',$3,$4) RETURNING id`, [orgId, first, email, phone])).rows[0]!.id;
  const applicationId = (await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, stage_key, amount_requested, property_city)
     VALUES ($1,$2,'lead',400000,'=HYPERLINK("x")') RETURNING id`, [orgId, customerId])).rows[0]!.id;
  await query(
    `INSERT INTO application_applicants (application_id, customer_id, position, first_name, email)
     VALUES ($1,$2,0,$3,$4)`, [applicationId, customerId, first, email]);
  if (owner) {
    await query(`INSERT INTO assignments (application_id, user_id, role, is_primary) VALUES ($1,$2,'broker',true)`,
      [applicationId, owner.userId]);
  }
  return { customerId, applicationId };
};

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Lendmax','ON') RETURNING id`)).rows[0]!.id;
  manager = await person('mia@example.com', 'Mia Manager', 'manager');
  dana = await person('dana@example.com', 'Dana Broker', 'broker');
  evan = await person('evan@example.com', 'Evan Broker', 'broker');
  alex = await person('alex@example.com', 'Alex Admin', 'technical_admin');
  managerCookie = `lmx_crm_session=${(await createSession(manager.userId!, {})).token}`;
  adminCookie = `lmx_crm_session=${(await createSession(alex.userId!, {})).token}`;
  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
     VALUES ($1,'lead','Lead',1,'open',true)`, [orgId]);
});

// ── Contact details ────────────────────────────────────────────────────────

test('contact details are normalised, audited, and follow onto the file', async () => {
  const { customerId, applicationId } = await client('Rena', 'rena@example.com', null, dana);
  const result = await updateCustomer(own(dana), customerId, {
    email: 'Rena.Walsh@Example.com', phone: '(647) 555-0142', postal_code: 'l4m1a1', province: 'on',
  });
  assert.equal(result.customer.email, 'rena.walsh@example.com');
  assert.equal(result.customer.phone_e164, '+16475550142');
  assert.equal(result.customer.postal_code, 'L4M 1A1');
  assert.equal(result.customer.province, 'ON');

  const applicant = await queryOne<{ email: string; phone_e164: string }>(
    'SELECT email, phone_e164 FROM application_applicants WHERE application_id = $1', [applicationId]);
  assert.equal(applicant!.email, 'rena.walsh@example.com');
  assert.equal(applicant!.phone_e164, '+16475550142');

  const audit = await queryOne<{ summary: string }>(
    `SELECT summary FROM audit_log WHERE action = 'customer.edit'`);
  assert.match(audit!.summary, /email/);
});

test('a broker cannot change a customer who is not theirs, and a record needs a way to reach them', async () => {
  const { customerId } = await client('Rena', 'rena@example.com', null, dana);
  await assert.rejects(updateCustomer(own(evan), customerId, { first_name: 'X' }), { status: 404 });
  await assert.rejects(updateCustomer(own(dana), customerId, { email: '' }), /email address or a phone/);
  await assert.rejects(updateCustomer(own(dana), customerId, { phone: '12' }), /phone/);
});

// ── Duplicates and merging ─────────────────────────────────────────────────

test('a merge moves everything to the survivor and keeps the loser pointing at it', async () => {
  const keep = await client('Rena', 'rena@example.com', null, dana);
  const lose = await client('R.', 'rena@example.com', '+16475550142', dana);

  const found = await findDuplicates(all(manager), keep.customerId);
  assert.deepEqual(found.map((d) => [d.id, d.matched_on]), [[lose.customerId, ['email']]]);

  await query(
    `INSERT INTO suppressions (organization_id, customer_id, address, channel, scope, reason)
     VALUES ($1,$2,'+16475550142','sms','all','stop_keyword')`, [orgId, lose.customerId]);
  await query(
    `INSERT INTO consents (organization_id, customer_id, channel, purpose, basis, granted, source)
     VALUES ($1,$2,'email','marketing','express',true,'crm')`, [orgId, lose.customerId]);

  const beforeMerge = await gateFor(orgId, keep.customerId, 'email', 'marketing');
  assert.equal(beforeMerge.decision.allowed, false, 'no marketing consent of its own yet');

  const result = await mergeCustomers(all(manager), keep.customerId, lose.customerId);
  assert.equal(result.moved.applications, 1);

  const files = await query('SELECT id FROM applications WHERE customer_id = $1', [keep.customerId]);
  assert.equal(files.rowCount, 2);
  const survivor = await queryOne<{ phone_e164: string }>('SELECT phone_e164 FROM customers WHERE id = $1', [keep.customerId]);
  assert.equal(survivor!.phone_e164, '+16475550142', 'a blank on the survivor is filled from the duplicate');
  const loser = await queryOne<{ merged_into_id: string }>('SELECT merged_into_id FROM customers WHERE id = $1', [lose.customerId]);
  assert.equal(loser!.merged_into_id, keep.customerId);

  // The STOP followed the person, and so did their consent.
  const sms = await gateFor(orgId, keep.customerId, 'sms', 'transactional');
  assert.equal(sms.decision.allowed, false);
  const email = await gateFor(orgId, keep.customerId, 'email', 'marketing');
  assert.equal(email.decision.allowed, true, email.decision.reason);

  assert.deepEqual(await findDuplicates(all(manager), keep.customerId), []);
  await assert.rejects(mergeCustomers(all(manager), keep.customerId, lose.customerId), { status: 409 });
});

test('a merge refuses itself and a record under legal hold', async () => {
  const keep = await client('Rena', 'rena@example.com', null);
  const lose = await client('Rena', 'rena@example.com', null);
  await assert.rejects(mergeCustomers(all(manager), keep.customerId, keep.customerId), { status: 422 });
  await query(
    `INSERT INTO compliance_cases (organization_id, application_id, customer_id, legal_hold)
     VALUES ($1,$2,$3,true)`, [orgId, lose.applicationId, lose.customerId]);
  await assert.rejects(mergeCustomers(all(manager), keep.customerId, lose.customerId), { status: 409 });
});

// ── Archiving and the list ─────────────────────────────────────────────────

test('an archived file leaves the list, shows under archived, and comes back', async () => {
  const { applicationId } = await client('Rena', 'rena@example.com', null, dana);
  const list = async (extra = '') => (await (await fetch(`${base}/customers?${extra}`,
    { headers: { cookie: managerCookie } })).json()) as { total: number };

  assert.equal((await list()).total, 1);
  await assert.rejects(setArchived(own(evan), applicationId, true), { status: 404 });
  await setArchived(own(dana), applicationId, true, 'test file');
  assert.equal((await list()).total, 0);
  assert.equal((await list('archived=true')).total, 1);
  await setArchived(all(manager), applicationId, false);
  assert.equal((await list()).total, 1);

  const actions = await query<{ action: string }>(
    `SELECT action FROM audit_log WHERE action LIKE 'application.%' ORDER BY id`);
  assert.deepEqual(actions.rows.map((r) => r.action), ['application.archive', 'application.restore']);
});

test('the export is the filtered list as CSV, formula-safe, and audited', async () => {
  await client('Rena', 'rena@example.com', null, dana);
  await client('Omar', 'omar@example.com', null, dana);

  const res = await fetch(`${base}/customers/export?client=rena`, { headers: { cookie: managerCookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  const lines = (await res.text()).replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 2, 'the header and the one matching file');
  assert.match(lines[1]!, /rena@example\.com/);
  assert.match(lines[1]!, /"'=HYPERLINK\(""x""\)"/, 'a cell that starts a formula is defused');

  const audit = await queryOne<{ summary: string }>(`SELECT summary FROM audit_log WHERE action = 'customer.export'`);
  assert.equal(audit!.summary, 'Exported 1 customer file to CSV');

  // A broker has no export grant.
  const brokerCookie = `lmx_crm_session=${(await createSession(dana.userId!, {})).token}`;
  assert.equal((await fetch(`${base}/customers/export`, { headers: { cookie: brokerCookie } })).status, 403);
});

// ── The technical admin ────────────────────────────────────────────────────

test('the technical admin can correct the application and ask for documents', async () => {
  const { applicationId } = await client('Rena', 'rena@example.com', null, dana);
  const form = await (await fetch(`${base}/applications/${applicationId}/form`,
    { headers: { cookie: adminCookie } })).json() as { can_edit: boolean; edit_blocked_reason: string | null };
  assert.equal(form.can_edit, true);
  assert.equal(form.edit_blocked_reason, null);

  const res = await fetch(`${base}/applications/${applicationId}/document-requests`, {
    method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ label: 'Void cheque' }], channel: 'email' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as { items: number; sent: boolean };
  assert.equal(body.items, 1);
  assert.equal(typeof body.sent, 'boolean');
});
