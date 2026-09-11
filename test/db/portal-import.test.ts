/**
 * The portal importer, against a real database.
 *
 * The payloads below are shaped from the live portal's `buildPayload` and its
 * `lib/schema.js` — including the pieces the generated field dictionary is out
 * of date about (the `mortgages[]` repeater on the subject property, and
 * `purpose.request_position`).
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { importMirrorPayload, type MirrorPayload } from '../../src/services/portal-import.ts';

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
     VALUES ($1,'refinance','Refinance',1,'Refinance'), ($1,'purchase','Purchase',2,'Purchase')`,
    [orgId],
  );
});

after(async () => {
  await pool.end();
});

/** A partial application, as the portal pushes after the first section. */
const earlyPush = (over: Partial<MirrorPayload> = {}): MirrorPayload => ({
  portal_id: 4471,
  reference: 'LMX-A-202609-4471',
  status: 'in_progress',
  percent: 22,
  current_section: 'property',
  current_section_label: 'Subject property',
  first_name: 'Sarah',
  last_name: 'Johnson',
  email: 'Sarah.Johnson@example.com',
  phone: '(416) 555-0142',
  purpose: 'Refinance',
  amount_requested: 420000,
  property_city: 'Toronto',
  property_province: 'ON',
  applicant_count: 1,
  document_count: 0,
  lead_source: 'organic',
  lead_campaign: null,
  source_raw: { utm_source: 'google' },
  ratios: null,
  progress: { sections: {}, done: 2, total: 9, percent: 22 },
  documents: [],
  data: {
    purpose: {
      purpose: 'Refinance', timing: 'Within 30 days',
      request_position: '1', request_loan_type: 'Mortgage',
      amount_requested: 420000, existing_lender: 'TD',
      maturity_date: '2027-06-30',
    },
    property: { city: 'Toronto', province: 'ON', street_number: '123', street_name: 'Main Street' },
    applicants: [{ first_name: 'Sarah', last_name: 'Johnson', email: 'Sarah.Johnson@example.com',
                   phone: '(416) 555-0142' }],
  },
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:05:00Z',
  submitted_at: null,
  hash: 'hash-early',
  ...over,
});

/** The same file, complete, with everything the portal collects. */
const fullPush = (over: Partial<MirrorPayload> = {}): MirrorPayload => ({
  ...earlyPush(),
  status: 'submitted',
  percent: 100,
  current_section: 'review',
  current_section_label: 'Review & submit',
  document_count: 2,
  applicant_count: 2,
  submitted_at: '2026-09-03T14:00:00Z',
  hash: 'hash-full',
  ratios: {
    monthly_income: 11500, mortgage_payment: 2684.11, shelter_cost: 3410.5,
    other_debt: 780, loan_amount: 420000, qualifying_rate: 5.25,
    gds: 29.657, tds: 36.44, ltv: 64.615, charges_ahead: 0,
    net_worth: 410000, assets_total: 95000, debts_total: 452000,
    request_position: '1', property_value: 650000,
    breakdown: { income: [{ label: 'Salary', amount: 9500 }], shelter: [], debt: [] },
  },
  documents: [
    { id: 901, filename: 'sarah-johnson-notice-of-assessment.pdf', category: 'notice_of_assessment',
      size_bytes: 184320, content_type: 'application/pdf', uploaded_at: '2026-09-02T09:00:00Z' },
    { id: 902, filename: 'sarah-johnson-pay-stub.pdf', category: 'pay_stubs',
      size_bytes: 91234, content_type: 'application/pdf', uploaded_at: '2026-09-02T09:05:00Z' },
  ],
  data: {
    purpose: {
      purpose: 'Refinance', timing: 'Within 30 days',
      request_position: '2', request_loan_type: 'Mortgage',
      amount_requested: 420000, existing_lender: 'TD',
      maturity_date: '2027-06-30', refi_reason: 'Debt consolidation',
    },
    property: {
      is_subject: true, street_number: '123', street_name: 'Main Street', unit: '4B',
      city: 'Toronto', province: 'ON', postal_code: 'M5V 2T6',
      home_type: 'Condo apartment', occupancy: 'Owner occupied',
      property_value: 650000, annual_taxes: 4200, monthly_heat: 120, condo_fee: 640,
      closing_date: '2026-10-15',
      // The repeater the field dictionary does not know about.
      mortgages: [
        { position: '1', loan_type: 'Mortgage', lender: 'TD', balance: 380000,
          opening_balance: 450000, rate: 4.79, term: '5 years', maturity: '2027-06-30',
          payment: 2410, frequency: 'Monthly', rate_type: 'Fixed' },
        { position: '2', loan_type: 'Line of Credit', lender: 'Scotiabank', balance: 40000,
          opening_balance: 100000, rate: 7.2, payment: 260, frequency: 'Monthly',
          rate_type: 'Variable' },
        // A row the applicant opened and never filled in.
        { position: '3', loan_type: 'Mortgage' },
      ],
    },
    applicants: [
      {
        first_name: 'Sarah', last_name: 'Johnson', email: 'Sarah.Johnson@example.com',
        phone: '(416) 555-0142', dob: '1984-03-11', marital_status: 'Married',
        dependants: 2, citizenship: 'Canadian citizen', credit_self: 'Good (700–759)',
        addr_street_number: '123', addr_street_name: 'Main Street', addr_city: 'Toronto',
        addr_province: 'ON', addr_postal: 'M5V 2T6', residential_status: 'Own',
        years_at_address: 6, employment_type: 'Employed — salaried',
        employment_basis: 'Full-time', employer: 'Acme Health', job_title: 'Director',
        years_employed: 7, annual_income: 114000, income_frequency: 'Bi-weekly',
        employments: [
          { status: 'Previous', employment_type: 'Contract', employer: 'Beta Corp',
            years: 2, annual_income: 82000, ended: '2019-05-31' },
        ],
      },
      {
        first_name: 'Daniel', last_name: 'Johnson', email: 'daniel.j@example.com',
        phone: '416-555-0143', dob: '1982-11-02', marital_status: 'Married',
        employment_type: 'Self-employed — incorporated', employer: 'DJ Consulting',
        years_employed: 4, annual_income: 96000,
      },
    ],
    income: [
      { applicant: 0, income_type: 'Bonus', amount: 12000, frequency: 'Annual', source: 'Acme Health' },
      { applicant: 1, income_type: 'Rental', amount: 1800, frequency: 'Monthly' },
    ],
    assets: [
      { applicant: 0, asset_type: 'TFSA', value: 62000, institution: 'Questrade' },
      { applicant: 0, asset_type: 'Chequing account', value: 33000, institution: 'TD',
        for_down_payment: true },
    ],
    liabilities: [
      { applicant: 0, liability_type: 'Car Loan', lender: 'Honda Finance', balance: 22000,
        payment: 480 },
      { applicant: 1, liability_type: 'Credit Card', lender: 'Amex', balance: 6000,
        payment: 300, payoff: true },
    ],
    other_properties: [
      {
        applicant: 0, street: '88 Lakeshore Road', city: 'Mississauga', province: 'ON',
        home_type: 'Detached', occupancy: 'Rental / investment', value: 780000,
        annual_taxes: 5200, monthly_heat: 160, rental_income: 2900, has_mortgage: true,
        mortgages: [
          { position: '1', loan_type: 'Mortgage', lender: 'RBC', balance: 410000,
            payment: 2150, frequency: 'Monthly', rate: 5.14, maturity: '2028-02-01',
            rate_type: 'Variable' },
        ],
      },
    ],
    review: { consent: true, notes: 'Please call after 5pm.' },
    meta: { liabilities: { none: false } },
  },
  ...over,
});

test('an early partial push creates the file without complaining about missing fields', async () => {
  // The portal pushes from the first answer, not on submit. A file that stalls
  // at Income has to be visible while it is still worth a phone call.
  const result = await importMirrorPayload(earlyPush(), { organizationId: orgId });
  assert.equal(result.created, true);
  assert.equal(result.changed, true);

  const app = await queryOne<Record<string, any>>(
    'SELECT * FROM applications WHERE portal_reference = $1', ['LMX-A-202609-4471'],
  );
  assert.ok(app);
  assert.equal(app.percent_complete, 22);
  assert.equal(app.portal_status, 'in_progress');
  assert.equal(app.stage_key, 'lead', 'lands on the first active stage');
  assert.equal(app.transaction_type_key, 'refinance', 'classified from the portal purpose');
  assert.equal(app.property_city, 'Toronto');
  assert.equal(app.closing_date, null, 'absent, not guessed');
  assert.equal(Number(app.amount_requested), 420000);
});

test('the same payload twice is a no-op', async () => {
  // The portal pushes immediately AND sweeps every thirty seconds, so this is
  // the normal case rather than an edge case.
  await importMirrorPayload(earlyPush(), { organizationId: orgId });
  const second = await importMirrorPayload(earlyPush(), { organizationId: orgId });
  assert.equal(second.changed, false);
  assert.equal(second.unchanged, true);

  const { rows } = await query('SELECT id FROM applications');
  assert.equal(rows.length, 1, 'one application, not two');

  const events = await query('SELECT event_type FROM domain_events');
  assert.equal(events.rows.length, 1, 'and the created event is not emitted twice');
});

test('a customer is reused across pushes, and matched on phone or email', async () => {
  await importMirrorPayload(earlyPush(), { organizationId: orgId });
  // Same person, email capitalised differently, phone written differently.
  await importMirrorPayload(
    earlyPush({
      reference: 'LMX-A-202609-9999', portal_id: 9999, hash: 'other',
      email: 'sarah.johnson@EXAMPLE.com', phone: '+14165550142',
    }),
    { organizationId: orgId },
  );
  const { rows } = await query('SELECT id FROM customers');
  assert.equal(rows.length, 1, 'one person, two mortgages');
  const apps = await query('SELECT id FROM applications');
  assert.equal(apps.rows.length, 2);
});

test('a full push normalises every repeater', async () => {
  await importMirrorPayload(fullPush(), { organizationId: orgId });
  const app = await queryOne<Record<string, any>>(
    'SELECT * FROM applications WHERE portal_reference = $1', ['LMX-A-202609-4471'],
  );

  assert.equal(app!.percent_complete, 100);
  assert.equal(app!.closing_date, '2026-10-15', 'a calendar date, as a string');
  assert.equal(app!.property_unit, '4B');
  assert.equal(Number(app!.monthly_condo_fee), 640);

  // The request position — what decides whether LTV counts charges ahead.
  assert.equal(app!.request_position, '2');
  assert.equal(app!.request_loan_type, 'Mortgage');

  // Ratios are stored as received, never recomputed.
  assert.equal(Number(app!.gds), 29.657);
  assert.equal(Number(app!.tds), 36.44);
  assert.equal(Number(app!.ltv), 64.615);
  assert.equal(Number(app!.qualifying_rate), 5.25);
  assert.equal(Number(app!.monthly_income), 11500);
  assert.ok(app!.portal_ratios.breakdown, 'the line items travel with the ratio');

  const applicants = await query('SELECT * FROM application_applicants ORDER BY position');
  assert.equal(applicants.rows.length, 2);
  assert.equal(applicants.rows[0]!.applicant_role, 'applicant');
  assert.equal(applicants.rows[1]!.applicant_role, 'co_applicant');
  assert.equal(applicants.rows[0]!.phone_e164, '+14165550142', 'normalised to E.164');
  assert.equal(applicants.rows[0]!.email, 'sarah.johnson@example.com', 'lower-cased');
  assert.ok(applicants.rows[0]!.customer_id, 'the primary applicant is the customer');
  assert.equal(applicants.rows[1]!.customer_id, null, 'a co-applicant is not, yet');

  // The applicant's own employment and the "other employment" repeater share
  // one table — the question "what is this borrower's income" is one query.
  const employments = await query(
    `SELECT slot, status, employer FROM application_employments ORDER BY slot, position`,
  );
  assert.equal(employments.rows.length, 3);
  assert.deepEqual(employments.rows.map((r) => r.employer), ['Beta Corp', 'Acme Health', 'DJ Consulting']);
  assert.equal(employments.rows[0]!.status, 'Previous');

  const incomes = await query('SELECT * FROM application_incomes ORDER BY position');
  assert.equal(incomes.rows.length, 2);
  assert.ok(incomes.rows[0]!.applicant_id, 'the index is resolved to a real applicant');

  const liabilities = await query('SELECT * FROM application_liabilities ORDER BY position');
  assert.equal(liabilities.rows.length, 2);
  assert.equal(liabilities.rows[0]!.payoff, false);
  assert.equal(liabilities.rows[1]!.payoff, true, 'mirrored, never inferred');

  const properties = await query('SELECT * FROM application_properties');
  assert.equal(properties.rows.length, 1);
  assert.equal(properties.rows[0]!.city, 'Mississauga');
});

test('charges on the subject property are stored in position order, blanks dropped', async () => {
  await importMirrorPayload(fullPush(), { organizationId: orgId });

  const subject = await query(
    `SELECT * FROM application_mortgages WHERE property_id IS NULL ORDER BY seq`,
  );
  assert.equal(subject.rows.length, 2, 'the empty third row is not stored as a mortgage');
  assert.equal(subject.rows[0]!.lender, 'TD');
  assert.equal(subject.rows[0]!.position, '1');
  assert.equal(Number(subject.rows[0]!.balance), 380000);
  assert.equal(Number(subject.rows[0]!.opening_balance), 450000);
  assert.equal(Number(subject.rows[0]!.rate), 4.79, 'a percent, not a fraction');
  assert.equal(subject.rows[0]!.maturity, '2027-06-30');
  assert.equal(subject.rows[1]!.loan_type, 'Line of Credit');
  assert.equal(subject.rows[1]!.maturity, null, 'a line of credit has no maturity');

  // A charge on another property points at it.
  const other = await query(
    `SELECT m.*, p.city FROM application_mortgages m
       JOIN application_properties p ON p.id = m.property_id`,
  );
  assert.equal(other.rows.length, 1);
  assert.equal(other.rows[0]!.lender, 'RBC');
  assert.equal(other.rows[0]!.city, 'Mississauga');

  // The summary balance is the sum of the charges, since the portal no longer
  // sends a flat one.
  const app = await queryOne<Record<string, any>>('SELECT existing_balance FROM applications');
  assert.equal(Number(app!.existing_balance), 420000, '380k + 40k');
});

test('the portal consent is imported as transactional, never as marketing', async () => {
  // The single most consequential thing this importer could get wrong.
  await importMirrorPayload(fullPush(), { organizationId: orgId });
  const { rows } = await query('SELECT * FROM consents');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.purpose, 'transactional');
  assert.equal(rows[0]!.basis, 'express');
  assert.equal(rows[0]!.source, 'portal_application');

  const marketing = await query(`SELECT * FROM consents WHERE purpose = 'marketing'`);
  assert.equal(marketing.rows.length, 0);
});

test('consent is not duplicated by a re-push', async () => {
  await importMirrorPayload(fullPush(), { organizationId: orgId });
  await importMirrorPayload(fullPush({ hash: 'changed', percent: 100 }), { organizationId: orgId });
  const { rows } = await query('SELECT * FROM consents');
  assert.equal(rows.length, 1);
});

test('documents arrive as a manifest, not a copy', async () => {
  await importMirrorPayload(fullPush(), { organizationId: orgId });
  const { rows } = await query('SELECT * FROM documents ORDER BY storage_key');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.storage_driver, 'portal', 'the bytes stay at the portal');
  assert.equal(rows[0]!.storage_key, '901', "the portal's own id");
  assert.equal(rows[0]!.source, 'portal');
  assert.equal(rows[0]!.category_key, 'notice_of_assessment');
});

test('progressing from partial to complete emits the right events, once each', async () => {
  await importMirrorPayload(earlyPush(), { organizationId: orgId });
  const result = await importMirrorPayload(fullPush(), { organizationId: orgId });

  assert.equal(result.created, false);
  assert.equal(result.changed, true);
  assert.ok(result.changedFields.percent_complete);
  assert.ok(result.changedFields.submitted_at);
  assert.ok(result.changedFields.portal_status);

  const events = await query<{ event_type: string }>('SELECT event_type FROM domain_events ORDER BY id');
  const types = events.rows.map((r) => r.event_type);
  assert.ok(types.includes('application.created'));
  assert.ok(types.includes('application.submitted'));
  assert.ok(types.includes('application.completed'));
  assert.ok(types.includes('document.uploaded'));

  // And the whole thing again changes nothing and emits nothing new.
  const before = events.rows.length;
  await importMirrorPayload(fullPush(), { organizationId: orgId });
  const after = await query('SELECT id FROM domain_events');
  assert.equal(after.rows.length, before, 'a re-push enrols nobody twice');
});

test('a broker classification survives the next push', async () => {
  // A file a broker has called a first-time buyer must not be reset to a plain
  // purchase by the portal's next save.
  await importMirrorPayload(earlyPush(), { organizationId: orgId });
  await query(`UPDATE applications SET transaction_type_key = 'purchase', stage_key = 'application'`);
  await importMirrorPayload(fullPush(), { organizationId: orgId });

  const app = await queryOne<Record<string, any>>('SELECT * FROM applications');
  assert.equal(app!.transaction_type_key, 'purchase', 'not reset to refinance');
  assert.equal(app!.stage_key, 'application', 'and not dragged back to Lead');
});

test('a second person sharing a phone number is flagged, never merged', async () => {
  await importMirrorPayload(earlyPush(), { organizationId: orgId });
  // A different person already in the CRM on the same household number.
  await query(
    `INSERT INTO customers (organization_id, first_name, last_name, phone_e164)
     VALUES ($1,'Daniel','Johnson','+14165550142')`,
    [orgId],
  );
  await importMirrorPayload(
    earlyPush({ reference: 'LMX-A-202609-5000', portal_id: 5000, hash: 'x' }),
    { organizationId: orgId },
  );

  const candidates = await query('SELECT * FROM duplicate_candidates');
  assert.equal(candidates.rows.length, 1, 'flagged for a person to look at');
  assert.equal(candidates.rows[0]!.status, 'open');
  assert.deepEqual(candidates.rows[0]!.matched_on, ['phone']);

  const customers = await query('SELECT id FROM customers');
  assert.equal(customers.rows.length, 2, 'and both records still exist');
});

test('every push is logged, so a wrong-looking file can be explained', async () => {
  await importMirrorPayload(earlyPush(), { organizationId: orgId });
  await importMirrorPayload(earlyPush(), { organizationId: orgId });
  await importMirrorPayload(fullPush(), { organizationId: orgId });

  const { rows } = await query<{ outcome: string }>(
    'SELECT outcome FROM portal_mirror_log ORDER BY id',
  );
  assert.deepEqual(rows.map((r) => r.outcome), ['created', 'updated']);
});

test('a payload with no reference is refused', async () => {
  await assert.rejects(
    () => importMirrorPayload({ reference: '' } as MirrorPayload, { organizationId: orgId }),
    /needs a reference/,
  );
});

test('garbage in a numeric field becomes null, not zero', async () => {
  // Stripping the non-numerics out of "not a number" leaves an empty string,
  // and Number('') is 0 — so without a digit check this lands a real $0 in
  // the pipeline total. "We do not know" and "nothing" are different facts.
  const result = await importMirrorPayload(
    earlyPush({
      amount_requested: 'not a number' as unknown as number,
      hash: 'garbage',
      data: {
        purpose: { purpose: 'Refinance', amount_requested: 'unknown' },
        property: { city: 'Toronto', closing_date: '15/10/2026', annual_taxes: '$4,200.00' },
        applicants: [{ first_name: 'Sarah', last_name: 'Johnson', phone: '(416) 555-0142' }],
      },
    }),
    { organizationId: orgId },
  );
  assert.equal(result.created, true);
  const app = await queryOne<Record<string, any>>('SELECT * FROM applications');
  assert.equal(app!.amount_requested, null, 'null, not 0');
  assert.equal(app!.closing_date, null, 'a non-ISO date is absent rather than wrong');
  assert.equal(Number(app!.annual_taxes), 4200, 'but "$4,200.00" is money and parses');
});

test('the summary falls back to the underlying answer when it is unusable', async () => {
  // The portal sends a flat summary alongside the whole record. If the summary
  // is missing or unusable the answer itself is still there, and using it is
  // better than showing a broker a blank.
  await importMirrorPayload(
    earlyPush({ amount_requested: null, hash: 'fallback' }),
    { organizationId: orgId },
  );
  const app = await queryOne<Record<string, any>>('SELECT amount_requested FROM applications');
  assert.equal(Number(app!.amount_requested), 420000, 'taken from data.purpose');
});
