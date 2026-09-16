/**
 * The application form, against a real database: who may correct a client's
 * answers, what a correction does to the columns the rest of the CRM reads,
 * and what happens when the portal pushes again afterwards.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { AppError } from '../../src/http/middleware/errors.ts';
import { listActivity } from '../../src/services/activity.ts';
import {
  getApplicationForm, revertPath, saveSection, type Scope,
} from '../../src/services/applications.ts';
import { importMirrorPayload } from '../../src/services/portal-import.ts';
import type { Actor } from '../../src/services/staff.ts';

let orgId: string;
let dana: Actor, evan: Actor, alex: Actor;
let danaScope: Scope, evanScope: Scope, adminScope: Scope;
let applicationId: string;

before(async () => { await migrate(); });
after(async () => { await pool.end(); });

const person = async (email: string, name: string, role: string): Promise<Actor> => {
  const id = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete)
     VALUES ($1,$2,$3,$4,true,now(),true) RETURNING id`, [orgId, email, name, role])).rows[0]!.id;
  return { organizationId: orgId, kind: 'user', userId: id, name, role };
};

const scopeOf = (a: Actor, over: Partial<Scope> = {}): Scope =>
  ({ actor: a, viewAll: false, edit: true, viewFinancials: true, ...over });

/** What the portal would push for a renewal in Barrie. */
const payload = (over: Record<string, any> = {}) => ({
  reference: 'LMX-A-202609-0001',
  portal_id: 17,
  status: 'submitted',
  percent: 90,
  purpose: 'Renew',
  data: {
    purpose: { purpose: 'Renew', timing: 'Within 30 days', amount_requested: 310_000 },
    property: {
      street_number: '12', street_name: 'Bay', city: 'Barrie', province: 'ON',
      postal_code: 'L4M 1A1', home_type: 'Detached', occupancy: 'Owner occupied',
      property_value: 600_000, annual_taxes: 4200, monthly_heat: 150,
      mortgages: [{ position: '1', loan_type: 'Mortgage', lender: 'RBC', balance: 310_000, payment: 1640 }],
    },
    applicants: [{
      first_name: 'Rena', last_name: 'Walsh', email: 'rena@example.com',
      phone: '(647) 555-0142', annual_income: 96_000,
    }],
    liabilities: [{ liability_type: 'Credit Card', lender: 'RBC', balance: 4000, payment: 200 }],
    ...over,
  },
  ratios: { gds: 28.4, tds: 34.1, ltv: 51.7 },
});

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Lendmax','ON') RETURNING id`)).rows[0]!.id;
  alex = await person('alex@example.com', 'Alex Admin', 'technical_admin');
  dana = await person('dana@example.com', 'Dana Broker', 'broker');
  evan = await person('evan@example.com', 'Evan Broker', 'broker');
  danaScope = scopeOf(dana);
  evanScope = scopeOf(evan);
  adminScope = scopeOf(alex, { viewAll: true });
  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
     VALUES ($1,'lead','Lead',1,'open',true)`, [orgId]);

  const result = await importMirrorPayload(payload(), { organizationId: orgId });
  applicationId = result.id;
  await query(
    `INSERT INTO assignments (application_id, user_id, role, is_primary) VALUES ($1,$2,'broker',true)`,
    [applicationId, dana.userId]);
});

const columns = () => queryOne<Record<string, any>>(
  `SELECT property_postal_code, property_city, purpose, amount_requested, existing_balance
     FROM applications WHERE id = $1`, [applicationId]);

// ── Reading ────────────────────────────────────────────────────────────────

test('the file shows the portal’s own form, filled in with the client’s answers', async () => {
  const form = await getApplicationForm(danaScope, applicationId);
  assert.deepEqual(form.sections.map((s) => s.id), [
    'purpose', 'property', 'applicants', 'income', 'assets',
    'liabilities', 'other_properties', 'review', 'documents',
  ]);
  assert.equal(form.answers.property.city, 'Barrie');
  assert.equal(form.answers.applicants[0].first_name, 'Rena');
  assert.equal(form.can_edit, true);
  assert.deepEqual(form.edits, []);
});

test('money is behind its own permission, and the screen is told why', async () => {
  const form = await getApplicationForm(scopeOf(dana, { viewFinancials: false }), applicationId);
  assert.deepEqual(form.hidden_sections, ['income', 'assets', 'liabilities']);
  assert.equal(form.sections.some((s) => s.id === 'liabilities'), false);
  assert.equal(form.answers.liabilities, undefined, 'not merely hidden — not sent');
  assert.match(form.hidden_reason!, /View income, assets and liabilities/);
});

test('a broker cannot read a file they are not on; an admin can', async () => {
  await assert.rejects(getApplicationForm(evanScope, applicationId),
    (err: AppError) => err.status === 404);
  assert.equal((await getApplicationForm(adminScope, applicationId)).can_edit, true);
});

// ── Correcting ─────────────────────────────────────────────────────────────

test('a correction lies over the client’s answer and updates the columns', async () => {
  const before = await getApplicationForm(danaScope, applicationId);
  const result = await saveSection(danaScope, applicationId, 'property', {
    value: { ...before.answers.property, postal_code: 'L4N 7L3' },
  });

  assert.deepEqual(result.changed, ['property.postal_code'], 'one field pinned, not forty');
  assert.equal(result.form!.answers.property.postal_code, 'L4N 7L3');
  assert.equal((await columns())!.property_postal_code, 'L4N 7L3',
    'the column the board and the reports read follows');

  // The client's own answer is still there, and is offered back.
  const edit = result.form!.edits.find((e) => e.path === 'property.postal_code')!;
  assert.equal(edit.portal_value, 'L4M 1A1');
  const portal = await queryOne<{ portal_data: any }>(
    'SELECT portal_data FROM applications WHERE id = $1', [applicationId]);
  assert.equal(portal!.portal_data.property.postal_code, 'L4M 1A1',
    'portal_data is never written here');
});

test('the correction survives the next push, and everything else still follows it', async () => {
  await saveSection(danaScope, applicationId, 'property', {
    value: { ...(await getApplicationForm(danaScope, applicationId)).answers.property,
             postal_code: 'L4N 7L3' },
  });

  // The client goes back to the portal and changes their city — and leaves the
  // postal code they got wrong exactly as it was.
  await importMirrorPayload(payload({
    property: { ...payload().data.property, city: 'Innisfil' },
  }), { organizationId: orgId, force: true });

  const form = await getApplicationForm(danaScope, applicationId);
  assert.equal(form.answers.property.postal_code, 'L4N 7L3', 'the correction stands');
  assert.equal(form.answers.property.city, 'Innisfil', 'and the push still lands beside it');

  const after = await columns();
  assert.equal(after!.property_postal_code, 'L4N 7L3');
  assert.equal(after!.property_city, 'Innisfil');
});

test('a list is pinned as a list', async () => {
  const before = await getApplicationForm(danaScope, applicationId);
  const result = await saveSection(danaScope, applicationId, 'liabilities', {
    value: [
      ...before.answers.liabilities,
      { liability_type: 'Car Loan', lender: 'Scotiabank', balance: 18_000, payment: 420 },
    ],
  });
  assert.deepEqual(result.changed, ['liabilities']);
  assert.equal(result.form!.answers.liabilities.length, 2);

  // A push that still has one liability does not take the added one away.
  await importMirrorPayload(payload(), { organizationId: orgId, force: true });
  const form = await getApplicationForm(danaScope, applicationId);
  assert.equal(form.answers.liabilities.length, 2);
});

test('what a broker types is validated as the portal would validate it', async () => {
  const before = await getApplicationForm(danaScope, applicationId);
  await assert.rejects(
    saveSection(danaScope, applicationId, 'property', {
      value: { ...before.answers.property, postal_code: '90210' },
    }),
    (err: AppError) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, 'form_invalid');
      // Keyed the way the form addresses its inputs, so each message lands
      // under the question it is about.
      const errors = (err.detail as { errors: Record<string, string> }).errors;
      assert.match(errors.postal_code!, /Canadian postal code/);
      return true;
    });
  assert.equal((await columns())!.property_postal_code, 'L4M 1A1', 'and nothing was written');
});

test('a broker fixing one field is not made to finish the client’s section', async () => {
  // A half-finished file: the client stopped before the property details.
  const sparse = await importMirrorPayload({
    reference: 'LMX-A-202609-0002', portal_id: 18, status: 'draft', percent: 20,
    data: { purpose: { purpose: 'Purchase' }, property: { city: 'Barrie' } },
  }, { organizationId: orgId });
  await query(
    `INSERT INTO assignments (application_id, user_id, role, is_primary) VALUES ($1,$2,'broker',true)`,
    [sparse.id, dana.userId]);

  const result = await saveSection(danaScope, sparse.id, 'property', {
    value: { city: 'Innisfil' },
  });
  // The other forty questions are the client's business.
  assert.equal(result.form!.answers.property.city, 'Innisfil');
});

test('only the staff on the file, or an admin, may correct it', async () => {
  // The whole section, because a PUT replaces it — sending one key would clear
  // the rest, which is the semantic but not what this test is about.
  const value = { ...(await getApplicationForm(adminScope, applicationId)).answers.property,
                  city: 'Innisfil' };
  await assert.rejects(saveSection(evanScope, applicationId, 'property', { value }),
    (err: AppError) => err.status === 404, 'a file they cannot see is not there');

  await assert.rejects(
    saveSection(scopeOf(dana, { edit: false }), applicationId, 'property', { value }),
    (err: AppError) => err.status === 403);

  await assert.rejects(
    saveSection(scopeOf(dana, { viewFinancials: false }), applicationId, 'liabilities', { value: [] }),
    (err: AppError) => err.status === 403 && /View income, assets and liabilities/.test(err.message));

  assert.deepEqual((await saveSection(adminScope, applicationId, 'property', { value })).changed,
    ['property.city']);
});

test('undoing a correction puts the client’s answer back, and lets the portal move it again', async () => {
  const before = await getApplicationForm(danaScope, applicationId);
  await saveSection(danaScope, applicationId, 'property', {
    value: { ...before.answers.property, postal_code: 'L4N 7L3' },
  });
  const form = await revertPath(danaScope, applicationId, 'property.postal_code');

  assert.equal(form.answers.property.postal_code, 'L4M 1A1');
  assert.deepEqual(form.edits, []);
  assert.equal((await columns())!.property_postal_code, 'L4M 1A1');

  // And the field follows the portal again.
  await importMirrorPayload(payload({
    property: { ...payload().data.property, postal_code: 'L9S 1A1' },
  }), { organizationId: orgId, force: true });
  assert.equal((await getApplicationForm(danaScope, applicationId)).answers.property.postal_code,
    'L9S 1A1');
});

test('saving a section unchanged pins nothing', async () => {
  const before = await getApplicationForm(danaScope, applicationId);
  const result = await saveSection(danaScope, applicationId, 'property', {
    value: before.answers.property,
  });
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.form!.edits, [], 'opening a section does not freeze it');
});

test('a correction is in the activity log, with what it was', async () => {
  const before = await getApplicationForm(danaScope, applicationId);
  await saveSection(danaScope, applicationId, 'purpose', {
    value: { ...before.answers.purpose, amount_requested: 325_000 },
  });

  const { entries } = await listActivity(
    { organizationId: orgId, userId: dana.userId!, seeAll: true }, {});
  const entry = entries.find((e) => e.action === 'application.edit')!;
  assert.match(String(entry.summary), /Edited purpose/);
  assert.equal((await columns())!.amount_requested, '325000.00');
});

// ── The portal's controls ──────────────────────────────────────────────────

test('the purpose is one of the four cards, and a correction to it moves the column', async () => {
  const before = await getApplicationForm(danaScope, applicationId);
  const purpose = before.sections.find((s) => s.id === 'purpose')!;
  const card = purpose.groups[0]!.fields[0]!;
  assert.equal(card.t, 'choice');
  assert.deepEqual((card.o as Array<{ v: string }>).map((o) => o.v),
    ['Purchase', 'Renew', 'Refinance', 'Home Equity Line']);

  await assert.rejects(
    saveSection(danaScope, applicationId, 'purpose', { value: { ...before.answers.purpose, purpose: 'Mortgage' } }),
    (err: AppError) => err.status === 422);

  const result = await saveSection(danaScope, applicationId, 'purpose', {
    value: { ...before.answers.purpose, purpose: 'Refinance' },
  });
  assert.deepEqual(result.changed, ['purpose.purpose']);
  assert.equal((await columns())!.purpose, 'Refinance');
});

test('the renewal offer: the tick is written in words, and "no thanks" is kept', async () => {
  const before = await getApplicationForm(danaScope, applicationId);
  const offer = (before.sections.find((s) => s.id === 'purpose') as any).offer;
  const ticked = await saveSection(danaScope, applicationId, 'purpose', {
    value: { ...before.answers.purpose, [offer.field]: true, [offer.note_field]: offer.note },
  });
  assert.equal(ticked.form.answers.purpose.refi_compare, true);
  assert.equal(ticked.form.answers.purpose.refi_note, offer.note);

  const declined = await saveSection(danaScope, applicationId, 'purpose', {
    value: { ...ticked.form.answers.purpose, refi_compare: false, refi_note: '' },
    meta: { offer_declined: true },
  });
  assert.equal(declined.form.answers.meta.purpose.offer_declined, true);
});

test('"make this the subject property" and "belongs to" save as the portal saves them', async () => {
  const before = await getApplicationForm(danaScope, applicationId);
  const property = await saveSection(danaScope, applicationId, 'property', {
    value: { ...before.answers.property, is_subject: false },
  });
  assert.equal(property.form.answers.property.is_subject, false);

  const liabilities = await saveSection(danaScope, applicationId, 'liabilities', {
    value: [{ applicant: 'Applicant 1', liability_type: 'Credit Card', lender: 'RBC', balance: '4000', payment: '200' }],
  });
  assert.equal(liabilities.form.answers.liabilities[0].applicant, 'Applicant 1');
});
