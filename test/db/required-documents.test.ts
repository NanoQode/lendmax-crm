/**
 * Required documents, against a real database — and the customers list's
 * table filters, which were added in the same change.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { createSession } from '../../src/services/auth.ts';
import {
  addSuggested, checklistFor, createRequiredDocument, deleteRequiredDocument, listRequiredDocuments,
  moveRequiredDocument, updateRequiredDocument,
} from '../../src/services/required-documents.ts';
import { createApiKey } from '../../src/services/api-keys.ts';
import { expandRequestItems } from '../../src/services/document-requests.ts';
import type { Actor } from '../../src/services/staff.ts';

const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;
let orgId: string;
let admin: Actor;
let brokerCookie: string;

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
  const brokerId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete)
     VALUES ($1,'broker@example.com','Dana Broker','broker',true,now(),true) RETURNING id`,
    [orgId])).rows[0]!.id;
  brokerCookie = `lmx_crm_session=${(await createSession(brokerId, {})).token}`;
  await query(
    `INSERT INTO document_categories (organization_id, key, label, position)
     VALUES ($1,'pay_stubs','Pay Stubs',1), ($1,'identification','Identification',2)`, [orgId]);
});

const doc = (over: Record<string, unknown> = {}) => ({
  purpose: 'purchase', name: 'Two most recent pay stubs', formats: ['png', 'pdf'], ...over,
});

const fieldsOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (err) {
    if (err instanceof ZodError) return err.issues.map((i) => i.path.join('.'));
    throw err;
  }
  throw new Error('expected a validation error');
};

// ── The module ─────────────────────────────────────────────────────────────

test('a document is created with its formats in the one canonical order', async () => {
  const created = await createRequiredDocument(admin, doc({ category_key: 'pay_stubs', per_applicant: true }));
  assert.deepEqual(created.formats, ['pdf', 'png']);
  assert.equal(created.formats_label, 'PDF or PNG');
  assert.equal(created.category_label, 'Pay Stubs');
  assert.equal(created.position, 1);
  assert.equal(created.required, true, 'required unless said otherwise');
});

test('every field problem is reported against its field', async () => {
  const fields = await fieldsOf(createRequiredDocument(admin, { purpose: 'mortgage', name: 'x', formats: [] }));
  assert.deepEqual(fields.sort(), ['formats', 'name', 'purpose']);
  assert.deepEqual(await fieldsOf(createRequiredDocument(admin, doc({ formats: ['exe'] }))), ['formats.0']);
  assert.deepEqual(await fieldsOf(createRequiredDocument(admin, doc({ category_key: 'nope' }))), ['category_key']);
});

test('the same document twice under one purpose is refused; under another purpose it is fine', async () => {
  await createRequiredDocument(admin, doc());
  assert.deepEqual(await fieldsOf(createRequiredDocument(admin, doc({ name: '  two MOST recent pay stubs ' }))), ['name']);
  const renew = await createRequiredDocument(admin, doc({ purpose: 'renew' }));
  assert.equal(renew.purpose_label, 'Renew');
});

test('the checklist is the active entries for that purpose, in order, whatever the purpose is called', async () => {
  const a = await createRequiredDocument(admin, doc({ name: 'Photo ID' }));
  const b = await createRequiredDocument(admin, doc({ name: 'Pay stubs' }));
  await createRequiredDocument(admin, doc({ name: 'Gift letter', active: false }));
  await createRequiredDocument(admin, doc({ purpose: 'home_equity_line', name: 'Mortgage statement' }));
  await moveRequiredDocument(admin, b.id, { direction: 'up' });

  const purchase = await checklistFor(orgId, 'Purchase');
  assert.deepEqual(purchase.documents.map((d) => d.name), ['Pay stubs', 'Photo ID'], 'moved, and the inactive one left out');
  assert.equal((await checklistFor(orgId, 'Home Equity Line')).documents.length, 1);
  assert.deepEqual((await checklistFor(orgId, 'Construction')).documents, [], 'an unknown purpose gets nothing, not a guess');
  void a;
});

test('moving past either end is refused, and a deleted entry leaves no gap in the order', async () => {
  const first = await createRequiredDocument(admin, doc({ name: 'One' }));
  const second = await createRequiredDocument(admin, doc({ name: 'Two' }));
  const third = await createRequiredDocument(admin, doc({ name: 'Three' }));
  await assert.rejects(moveRequiredDocument(admin, first.id, { direction: 'up' }), /already first/);
  await deleteRequiredDocument(admin, second.id);
  await moveRequiredDocument(admin, third.id, { direction: 'up' });
  const list = await listRequiredDocuments(orgId, { purpose: 'purchase' });
  assert.deepEqual(list.rows.map((r) => [r.name, r.position]), [['Three', 1], ['One', 2]]);
});

test('a deleted entry is archived, not erased, and its name can be used again', async () => {
  const d = await createRequiredDocument(admin, doc());
  await deleteRequiredDocument(admin, d.id);
  const row = await queryOne<{ archived_at: Date | null }>('SELECT archived_at FROM required_documents WHERE id = $1', [d.id]);
  assert.ok(row!.archived_at);
  await createRequiredDocument(admin, doc());
});

test('moving an entry to another purpose puts it at the end of that list', async () => {
  await createRequiredDocument(admin, doc({ purpose: 'renew', name: 'Renewal letter' }));
  const moved = await createRequiredDocument(admin, doc({ name: 'Void cheque' }));
  const updated = await updateRequiredDocument(admin, moved.id, { purpose: 'renew' });
  assert.equal(updated.purpose, 'renew');
  assert.equal(updated.position, 2);
});

test('the suggested list is added once, and only what is missing', async () => {
  await createRequiredDocument(admin, doc({ name: 'Government-issued photo ID' }));
  const first = await addSuggested(admin, { purpose: 'purchase' });
  const second = await addSuggested(admin, { purpose: 'purchase' });
  assert.equal(first.added, 7, 'eight suggestions, one already there');
  assert.equal(second.added, 0);
  const id = (await checklistFor(orgId, 'purchase')).documents.find((d) => d.name.startsWith('Two most recent'));
  assert.equal(id!.category_key, 'pay_stubs', 'a category this brokerage has is linked');
  const mls = (await checklistFor(orgId, 'purchase')).documents.find((d) => d.name === 'MLS listing');
  assert.equal(mls!.category_key, null, 'one it does not have is left off, not refused');
});

test('the list filters, sorts and pages on the server', async () => {
  await addSuggested(admin, { purpose: 'purchase' });
  await addSuggested(admin, { purpose: 'refinance' });

  const all = await listRequiredDocuments(orgId, {});
  assert.equal(all.total, 15);
  assert.deepEqual(all.purposes.map((p) => [p.key, p.total]),
    [['purchase', 8], ['renew', 0], ['refinance', 7], ['home_equity_line', 0]]);
  assert.equal(all.rows[0]!.purpose, 'purchase', 'purposes in the portal’s order');

  const heic = await listRequiredDocuments(orgId, { format: 'heic' });
  assert.equal(heic.total, 2, 'photo ID under both purposes');
  const optional = await listRequiredDocuments(orgId, { purpose: 'purchase', required: 'no' });
  assert.deepEqual(optional.rows.map((r) => r.name).sort(), ['Gift letter', 'MLS listing']);
  const perApplicant = await listRequiredDocuments(orgId, { per_applicant: 'yes', q: 'notice' });
  assert.equal(perApplicant.total, 2);

  const page2 = await listRequiredDocuments(orgId, { sort: 'name', dir: 'desc', page: 2, page_size: 5 });
  assert.equal(page2.rows.length, 5);
  assert.equal(page2.total, 15);
  const names = (await listRequiredDocuments(orgId, { sort: 'name', dir: 'asc', page_size: 100 })).rows.map((r) => r.name.toLowerCase());
  assert.deepEqual(names, [...names].sort());
});

test('every change is audited', async () => {
  const d = await createRequiredDocument(admin, doc());
  await updateRequiredDocument(admin, d.id, { active: false });
  await deleteRequiredDocument(admin, d.id);
  const { rows } = await query<{ action: string }>(
    `SELECT action FROM audit_log WHERE entity_type = 'required_document' ORDER BY id`);
  assert.deepEqual(rows.map((r) => r.action),
    ['required_document.create', 'required_document.update', 'required_document.delete']);
});

// ── Over HTTP ──────────────────────────────────────────────────────────────

test('a broker can read the list but not change it', async () => {
  await createRequiredDocument(admin, doc());
  const read = await fetch(`${base}/required-documents`, { headers: { cookie: brokerCookie } });
  assert.equal(read.status, 200);
  const write = await fetch(`${base}/required-documents`, {
    method: 'POST', headers: { cookie: brokerCookie, 'content-type': 'application/json' },
    body: JSON.stringify(doc({ name: 'Other' })),
  });
  assert.equal(write.status, 403);
});

test('a website reads the checklist for a purpose through the API', async () => {
  await addSuggested(admin, { purpose: 'renew' });
  const { key } = await createApiKey(admin, { name: 'apply.lendmax.ca', permissions: ['required_document.view'] });
  const response = await fetch(`${base}/v1/required-documents/checklist?purpose=Renew`,
                               { headers: { authorization: `Bearer ${key}` } });
  const body = await response.json() as { data: { documents: Array<{ name: string; formats: string[] }> } };
  assert.equal(response.status, 200);
  assert.equal(body.data.documents.length, 4);
  assert.ok(body.data.documents.every((d) => d.formats.length > 0));

  const write = await fetch(`${base}/v1/required-documents`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(doc()),
  });
  assert.equal(write.status, 403, 'view-only key');
});

test('the customers list pages and filters by column on the server', async () => {
  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category)
     VALUES ($1,'lead','Lead',1,'open'), ($1,'funded','Funded',9,'won')`, [orgId]);
  for (let i = 1; i <= 7; i++) {
    const c = (await query<{ id: string }>(
      `INSERT INTO customers (organization_id, first_name, last_name, email)
       VALUES ($1,'Client',$2,$3) RETURNING id`, [orgId, `Number${i}`, `c${i}@example.com`])).rows[0]!.id;
    await query(
      `INSERT INTO applications (organization_id, customer_id, stage_key, amount_requested, property_city)
       VALUES ($1,$2,$3,$4,$5)`,
      [orgId, c, i === 7 ? 'funded' : 'lead', i * 150000, i % 2 ? 'Toronto' : 'Ottawa']);
  }
  const managerId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at)
     VALUES ($1,'m@example.com','Mia Manager','manager',true,now()) RETURNING id`, [orgId])).rows[0]!.id;
  const cookie = `lmx_crm_session=${(await createSession(managerId, {})).token}`;
  const list = async (params: string) => (await (await fetch(`${base}/customers?${params}`,
    { headers: { cookie } })).json()) as { total: number; customers: Array<{ last_name: string }> };

  assert.equal((await list('page=2&page_size=3')).customers.length, 3);
  assert.equal((await list('page=3&page_size=3')).customers.length, 1);
  assert.equal((await list('stage=funded')).total, 1);
  assert.equal((await list('amount=500_1000')).total, 3, '$600k, $750k, $900k');
  assert.equal((await list('property=ottawa')).total, 3);
  assert.equal((await list('assignee=__none')).total, 7);
  assert.equal((await list('client=number3')).customers[0]!.last_name, 'Number3');
  const sorted = await list('sort=amount&dir=desc&page_size=2');
  assert.deepEqual(sorted.customers.map((c) => c.last_name), ['Number7', 'Number6']);
});

// ── Asking a client from the checklist ─────────────────────────────────────

test('a request from the checklist copies the entry and splits a per-borrower one', async () => {
  const id = await createRequiredDocument(admin, doc({ name: 'Photo ID', per_applicant: true, formats: ['pdf'] }));
  const stubs = await createRequiredDocument(admin, doc({ required: false }));
  const gone = await createRequiredDocument(admin, doc({ name: 'Old entry' }));
  await deleteRequiredDocument(admin, gone.id);

  const customer = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, email) VALUES ($1,'Sarah','s@example.com') RETURNING id`,
    [orgId])).rows[0]!.id;
  const application = (await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, stage_key) VALUES ($1,$2,'lead') RETURNING id`,
    [orgId, customer])).rows[0]!.id;
  await query(
    `INSERT INTO application_applicants (application_id, position, applicant_role, first_name)
     VALUES ($1,0,'applicant','Sarah'), ($1,1,'co_applicant','James')`, [application]);

  const items = await expandRequestItems(orgId, application, [
    { required_document_id: id.id }, { required_document_id: stubs.id },
    { required_document_id: gone.id }, { label: 'Void cheque', category_key: 'other' },
  ]);

  assert.deepEqual(items.map((i) => i.label),
    ['Photo ID — Sarah', 'Photo ID — James', 'Two most recent pay stubs', 'Void cheque']);
  assert.ok(items[0]!.applicant_id && items[0]!.applicant_id !== items[1]!.applicant_id);
  assert.deepEqual(items[0]!.formats, ['pdf']);
  assert.equal(items[2]!.required, false, 'the checklist decides, not the screen');
  assert.equal(items[3]!.required_document_id, null);
});

test('a broker cannot request documents on a file that is not theirs', async () => {
  const customer = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, email) VALUES ($1,'Sarah','s@example.com') RETURNING id`,
    [orgId])).rows[0]!.id;
  const application = (await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, stage_key) VALUES ($1,$2,'lead') RETURNING id`,
    [orgId, customer])).rows[0]!.id;
  const res = await fetch(`${base}/applications/${application}/document-requests`, {
    method: 'POST', headers: { cookie: brokerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ label: 'Void cheque' }] }),
  });
  assert.equal(res.status, 404);
});
