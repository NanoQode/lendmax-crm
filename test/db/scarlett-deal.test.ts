/**
 * The deal pushed to Scarlett, built from a real imported application.
 *
 * These cover the three things a live push was rejected for: a date that was
 * not a date, the subject property arriving twice, and a request Scarlett had
 * no amount or rank for.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { importMirrorPayload, type MirrorPayload } from '../../src/services/portal-import.ts';
import { buildDeal } from '../../src/integrations/scarlett.ts';

let orgId: string;

before(async () => {
  await migrate();
});

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Test Brokerage','ON') RETURNING id`,
  );
  orgId = rows[0]!.id;
  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, probability)
     VALUES ($1,'lead','Lead',1,'open',5), ($1,'application','Application',2,'open',20)`,
    [orgId],
  );
  await query(
    `INSERT INTO transaction_types (organization_id, key, label, position, portal_purpose)
     VALUES ($1,'refinance','Refinance',1,'Refinance')`,
    [orgId],
  );
});

after(async () => {
  await pool.end();
});

const push = (over: Record<string, unknown> = {}): MirrorPayload => ({
  portal_id: 5150,
  reference: 'LMX-A-202609-5150',
  status: 'submitted',
  percent: 100,
  first_name: 'Dana',
  last_name: 'Whitfield',
  email: 'dana@example.com',
  phone: '(416) 555-0199',
  purpose: 'Refinance',
  amount_requested: 325000,
  property_city: 'Calgary',
  property_province: 'AB',
  applicant_count: 1,
  document_count: 0,
  documents: [],
  // 01:30 UTC is still the previous evening in Toronto. The calendar date has
  // to be the brokerage's, not the server's.
  created_at: '2026-09-14T01:30:00Z',
  updated_at: '2026-09-14T01:30:00Z',
  data: {
    purpose: {
      purpose: 'Refinance', amount_requested: 325000, request_position: '1',
    },
    property: {
      is_subject: true, street_number: '48', street_name: 'Sora Terrace',
      city: 'Calgary', province: 'AB', postal_code: 'T3S 0M5',
      property_value: 500000,
      mortgages: [{ lender: 'Home Trust', balance: 324000, rate: 6.2, position: 1 }],
    },
    applicants: [{ first_name: 'Dana', last_name: 'Whitfield', email: 'dana@example.com' }],
  },
  ...over,
}) as MirrorPayload;

async function build(payload: MirrorPayload) {
  const imported = await importMirrorPayload(payload, { organizationId: orgId });
  return buildDeal(orgId, imported.id);
}

test('ApplicationDate is a calendar date in the brokerage timezone', async () => {
  const { deal } = await build(push());
  const date = (deal.MortgageApplication as Record<string, unknown>).ApplicationDate;
  assert.match(
    String(date), /^\d{4}-\d{2}-\d{2}$/,
    `ApplicationDate must be YYYY-MM-DD, got ${JSON.stringify(date)}`,
  );
  // 2026-09-14T01:30Z is 2026-09-13 21:30 in Toronto.
  assert.equal(date, '2026-09-13', 'the brokerage’s calendar date, not the server’s');
});

test('the requested mortgage travels with an amount and a rank', async () => {
  const { deal } = await build(push());
  const subject = deal.SubjectProperty as Record<string, any>;
  const requested = subject.PropertyMortgage?.RequestedMortgages;
  assert.ok(Array.isArray(requested) && requested.length === 1, 'one requested mortgage');
  assert.equal(requested[0].TotalLoanAmount, 325000);
  assert.equal(requested[0].MortgageTypeDD, 1);
  assert.equal(
    requested[0].OriginalMortgageAmount, undefined,
    'a mortgage that does not exist yet has no original amount',
  );
});

test('a second mortgage asks for MortgageTypeDD 2', async () => {
  const { deal } = await build(push({
    data: { ...(push().data as any), purpose: { purpose: 'Refinance', amount_requested: 325000, request_position: '2' } },
  }));
  const subject = deal.SubjectProperty as Record<string, any>;
  assert.equal(subject.PropertyMortgage.RequestedMortgages[0].MortgageTypeDD, 2);
});

test('a rank Scarlett will not accept is left out, and said out loud', async () => {
  const built = await build(push({
    data: { ...(push().data as any), purpose: { purpose: 'Refinance', amount_requested: 325000, request_position: '4' } },
  }));
  const subject = built.deal.SubjectProperty as Record<string, any>;
  assert.equal(
    subject.PropertyMortgage.RequestedMortgages[0].MortgageTypeDD, undefined,
    'never guess an enum',
  );
  assert.equal(subject.PropertyMortgage.RequestedMortgages[0].TotalLoanAmount, 325000);
  assert.ok(
    built.warnings.some((w) => /MortgageTypeDD/.test(w)),
    `the omission is reported; got ${JSON.stringify(built.warnings)}`,
  );
});

test('the subject property is not also sent as one of the applicant’s properties', async () => {
  // The client answered "do you own other properties" with the property they
  // are refinancing — the same address, entered again.
  const base = push();
  const built = await build(push({
    data: {
      ...(base.data as any),
      other_properties: [{
        street: '48 Sora Terrace', city: 'Calgary', province: 'AB', postal_code: 'T3S 0M5',
        value: 500000, has_mortgage: true,
        mortgages: [{ lender: 'Home Trust', balance: 324000, position: 1 }],
      }],
    },
  }));

  const group = (built.deal.ApplicantGroups as any[])[0];
  assert.equal(
    group.OtherProperties, undefined,
    'the duplicate is removed, leaving no other properties at all',
  );
  const subject = built.deal.SubjectProperty as Record<string, any>;
  assert.ok(subject.Address, 'the subject property is still sent, once');
  assert.ok(
    built.warnings.some((w) => /also listed under/.test(w)),
    `the removal is reported; got ${JSON.stringify(built.warnings)}`,
  );
  // The mortgage recorded on the duplicate row must survive the removal.
  assert.ok(
    (subject.Mortgages ?? []).some((m: any) => m.LenderName === 'Home Trust'),
    `the existing charge is kept; got ${JSON.stringify(subject.Mortgages)}`,
  );
});

test('a genuinely different property is still sent as an other property', async () => {
  const base = push();
  const built = await build(push({
    data: {
      ...(base.data as any),
      other_properties: [{
        street: '900 Riverbend Drive', city: 'Edmonton', province: 'AB', postal_code: 'T6C 1A1',
        value: 410000, has_mortgage: false, mortgages: [],
      }],
    },
  }));
  const group = (built.deal.ApplicantGroups as any[])[0];
  assert.equal(group.OtherProperties?.length, 1, 'a real second property is not swallowed');
  assert.equal(built.warnings.filter((w) => /also listed under/.test(w)).length, 0);
});
