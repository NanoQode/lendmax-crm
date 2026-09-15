/**
 * Compliance, against a real database.
 *
 * Three properties, each of which was wrong at some point while this was
 * being built:
 *
 *   A derived checklist item is answered by the record it claims to
 *   represent, and cannot be ticked while that record says otherwise.
 *
 *   The queue's counts and the file's checklist agree — they read the same
 *   stored answer, because a derived item that is never ticked would
 *   otherwise sit "outstanding" for ever and the queue would overstate.
 *
 *   A determination nobody has made never scores as a clean answer. The
 *   FINTRAC columns default to false, so the value alone cannot tell
 *   "assessed, and no" from "nobody looked".
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import {
  approvalBlockers, deriveItem, gatherEvidence, openCase, reassess, syncDerivedItems,
  commissionPayoutBlockers,
} from '../../src/services/compliance.ts';

let orgId: string;
let userId: string;
let customerId: string;
let applicationId: string;
let applicantId: string;

before(async () => { await migrate(); });

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');

  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Test','ON') RETURNING id`)
  ).rows[0]!.id;

  userId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active)
     VALUES ($1,'ravi@example.com','Ravi','compliance_manager',true) RETURNING id`, [orgId])
  ).rows[0]!.id;

  customerId = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name)
     VALUES ($1,'Test','Client') RETURNING id`, [orgId])
  ).rows[0]!.id;

  applicationId = (await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, property_province,
                               transaction_type_key, amount_requested, percent_complete)
     VALUES ($1,$2,'ON','refinance',500000,100) RETURNING id`, [orgId, customerId])
  ).rows[0]!.id;

  applicantId = (await query<{ id: string }>(
    `INSERT INTO application_applicants (application_id, position, first_name, last_name)
     VALUES ($1,0,'Test','Client') RETURNING id`, [applicationId])
  ).rows[0]!.id;

  await query(
    `INSERT INTO compliance_checklist_templates (organization_id, key, name, version, province, items)
     VALUES ($1,'standard_on','Standard (ON)',1,'ON',$2::jsonb)`,
    [orgId, JSON.stringify([
      { key: 'identity_verified', group: 'fintrac', label: 'Identity verified', required: true },
      { key: 'third_party', group: 'fintrac', label: 'Third-party determination', required: true },
      { key: 'disclosures', group: 'disclosure', label: 'Disclosures provided', required: true },
      { key: 'appraisal', group: 'property', label: 'Appraisal where required', required: false },
    ])]);

  for (const [key, label, weight, evaluator, parameters] of [
    ['third_party', 'Third party involved', 3, 'fintrac_flag',
      { flag: 'third_party_present', determined_by: 'third_party_checked' }],
    ['entity_borrower', 'Corporate borrower', 3, 'fintrac_flag',
      { flag: 'entity_borrower', determined_by: 'completed_at' }],
    ['pep', 'Politically exposed person', 4, 'fintrac_pep', {}],
  ] as Array<[string, string, number, string, object]>) {
    await query(
      `INSERT INTO risk_factor_definitions (organization_id, model_key, model_version,
                                            factor_key, label, weight, evaluator, parameters)
       VALUES ($1,'standard',1,$2,$3,$4,$5,$6::jsonb)`,
      [orgId, key, label, weight, evaluator, JSON.stringify(parameters)]);
  }
});

after(async () => { await pool.end(); });

const openIt = () => openCase(pool, orgId, applicationId);

test('opening a case materialises the checklist and an empty FINTRAC row', async () => {
  const complianceCase = await openIt();
  assert.equal(complianceCase.checklist_key, 'standard_on');

  const items = await query('SELECT * FROM compliance_checklist_items WHERE compliance_case_id = $1',
    [complianceCase.id]);
  assert.equal(items.rows.length, 4);

  const fintrac = await queryOne('SELECT * FROM fintrac_assessments WHERE compliance_case_id = $1',
    [complianceCase.id]);
  assert.ok(fintrac, 'a determination not made must read as not made, not as a missing row');
});

test('opening it twice does not duplicate anything', async () => {
  const first = await openIt();
  const second = await openIt();
  assert.equal(first.id, second.id);
  const { rows } = await query('SELECT * FROM compliance_checklist_items');
  assert.equal(rows.length, 4);
});

test('a derived item reads the record, and follows it when the record changes', async () => {
  const complianceCase = await openIt();

  let evidence = await gatherEvidence(applicationId, complianceCase.id);
  let derived = deriveItem('identity_verified', evidence)!;
  assert.equal(derived.complete, false);
  assert.match(derived.detail, /0 of 1/);

  await query(
    `INSERT INTO identity_verifications (organization_id, customer_id, application_id,
                                         applicant_id, method, status, verified_on, verified_by)
     VALUES ($1,$2,$3,$4,'government_photo_id','verified',CURRENT_DATE,$5)`,
    [orgId, customerId, applicationId, applicantId, userId]);

  evidence = await gatherEvidence(applicationId, complianceCase.id);
  derived = deriveItem('identity_verified', evidence)!;
  assert.equal(derived.complete, true);
  assert.match(derived.detail, /1 of 1/);
});

test('a second applicant makes a complete identity item incomplete again', async () => {
  // The failure this catches: "every applicant" evaluated against the first.
  const complianceCase = await openIt();
  await query(
    `INSERT INTO identity_verifications (organization_id, customer_id, application_id,
                                         applicant_id, method, status, verified_on, verified_by)
     VALUES ($1,$2,$3,$4,'government_photo_id','verified',CURRENT_DATE,$5)`,
    [orgId, customerId, applicationId, applicantId, userId]);
  assert.equal(deriveItem('identity_verified',
    await gatherEvidence(applicationId, complianceCase.id))!.complete, true);

  await query(
    `INSERT INTO application_applicants (application_id, position, first_name, last_name)
     VALUES ($1,1,'Second','Applicant')`, [applicationId]);

  const derived = deriveItem('identity_verified',
    await gatherEvidence(applicationId, complianceCase.id))!;
  assert.equal(derived.complete, false);
  assert.match(derived.detail, /1 of 2/);
});

test('a PEP match with no senior approval is not a completed item', async () => {
  const complianceCase = await openIt();
  await query(
    `UPDATE fintrac_assessments SET pep_screened = true, pep_result = 'foreign'
      WHERE compliance_case_id = $1`, [complianceCase.id]);

  let derived = deriveItem('pep_screening',
    await gatherEvidence(applicationId, complianceCase.id))!;
  assert.equal(derived.complete, false);
  assert.match(derived.detail, /senior approval is outstanding/);

  await query(
    `UPDATE fintrac_assessments SET pep_senior_approval_at = now(), pep_senior_approval_by = $2
      WHERE compliance_case_id = $1`, [complianceCase.id, userId]);
  derived = deriveItem('pep_screening',
    await gatherEvidence(applicationId, complianceCase.id))!;
  assert.equal(derived.complete, true);
});

test('the stored answer follows the derivation, so the queue cannot overstate', async () => {
  const complianceCase = await openIt();
  await query(
    `INSERT INTO identity_verifications (organization_id, customer_id, application_id,
                                         applicant_id, method, status, verified_on, verified_by)
     VALUES ($1,$2,$3,$4,'government_photo_id','verified',CURRENT_DATE,$5)`,
    [orgId, customerId, applicationId, applicantId, userId]);

  const evidence = await gatherEvidence(applicationId, complianceCase.id);
  const { rows } = await query<{ id: string; item_key: string; status: string }>(
    'SELECT id, item_key, status FROM compliance_checklist_items WHERE compliance_case_id = $1',
    [complianceCase.id]);
  const answers = rows.map((r) => ({
    ...r, derived_complete: deriveItem(r.item_key, evidence)?.complete ?? null,
  }));

  assert.equal(await syncDerivedItems(complianceCase.id, answers), 1);

  const stored = await queryOne<{ status: string; completed_by: string | null }>(
    `SELECT status, completed_by FROM compliance_checklist_items
      WHERE compliance_case_id = $1 AND item_key = 'identity_verified'`, [complianceCase.id]);
  assert.equal(stored!.status, 'complete');
  assert.equal(stored!.completed_by, null, 'nobody claimed it — the file did');

  // Nothing left to change once the stored answers are read back — the route
  // reads fresh on every request, so a settled file writes nothing.
  const { rows: reread } = await query<{ id: string; item_key: string; status: string }>(
    'SELECT id, item_key, status FROM compliance_checklist_items WHERE compliance_case_id = $1',
    [complianceCase.id]);
  assert.equal(await syncDerivedItems(complianceCase.id, reread.map((r) => ({
    ...r, derived_complete: deriveItem(r.item_key, evidence)?.complete ?? null,
  }))), 0);
});

test('evidence that goes away takes the tick with it', async () => {
  const complianceCase = await openIt();
  const verification = await queryOne<{ id: string }>(
    `INSERT INTO identity_verifications (organization_id, customer_id, application_id,
                                         applicant_id, method, status, verified_on, verified_by)
     VALUES ($1,$2,$3,$4,'government_photo_id','verified',CURRENT_DATE,$5) RETURNING id`,
    [orgId, customerId, applicationId, applicantId, userId]);

  const sync = async () => {
    const evidence = await gatherEvidence(applicationId, complianceCase.id);
    const { rows } = await query<{ id: string; item_key: string; status: string }>(
      'SELECT id, item_key, status FROM compliance_checklist_items WHERE compliance_case_id = $1',
      [complianceCase.id]);
    await syncDerivedItems(complianceCase.id, rows.map((r) => ({
      ...r, derived_complete: deriveItem(r.item_key, evidence)?.complete ?? null,
    })));
  };

  await sync();
  await query('DELETE FROM identity_verifications WHERE id = $1', [verification!.id]);
  await sync();

  const stored = await queryOne<{ status: string }>(
    `SELECT status FROM compliance_checklist_items
      WHERE compliance_case_id = $1 AND item_key = 'identity_verified'`, [complianceCase.id]);
  assert.equal(stored!.status, 'outstanding');
});

test('a FINTRAC column defaulting to false is unknown, not a clean answer', async () => {
  const complianceCase = await openIt();
  const before = await reassess(orgId, applicationId, complianceCase.id);

  assert.equal(before.rating, 'review_required');
  const entity = before.factors.find((f) => f.key === 'entity_borrower')!;
  assert.equal(entity.unknown, true);
  assert.match(entity.note, /has not been made/);

  await query(
    `UPDATE fintrac_assessments
        SET third_party_checked = true, third_party_present = false,
            pep_screened = true, pep_result = 'none',
            entity_borrower = false, completed_at = now(), completed_by = $2
      WHERE compliance_case_id = $1`, [complianceCase.id, userId]);

  const after = await reassess(orgId, applicationId, complianceCase.id);
  assert.equal(after.rating, 'low');
  assert.equal(after.factors.find((f) => f.key === 'entity_borrower')!.unknown, false);
});

test('reassessing supersedes rather than overwrites', async () => {
  const complianceCase = await openIt();
  await reassess(orgId, applicationId, complianceCase.id);
  await reassess(orgId, applicationId, complianceCase.id);

  const all = await query('SELECT superseded_at FROM risk_assessments WHERE application_id = $1',
    [applicationId]);
  assert.equal(all.rows.length, 2, 'the March rating survives the April one');
  const current = await query(
    'SELECT id FROM risk_assessments WHERE application_id = $1 AND superseded_at IS NULL',
    [applicationId]);
  assert.equal(current.rows.length, 1);
});

test('approval blockers name everything, not the first thing', () => {
  const blockers = approvalBlockers(
    [
      { label: 'Identity verified', required: true, status: 'outstanding', derived_complete: false },
      { label: 'Disclosures provided', required: true, status: 'outstanding' },
      { label: 'Appraisal', required: false, status: 'outstanding' },
      { label: 'Third-party determination', required: true, status: 'not_applicable' },
    ],
    { rating: 'review_required', override_rating: null },
    false,
  );
  assert.deepEqual(blockers, [
    'Identity verified',
    'Disclosures provided',
    'The risk assessment is unresolved — a person must rate it',
    'The FINTRAC assessment has not been completed',
  ]);
});

test('a person’s override satisfies the rating blocker; the model’s review_required does not', () => {
  const items = [{ label: 'X', required: true, status: 'complete' }];
  assert.deepEqual(
    approvalBlockers(items, { rating: 'review_required', override_rating: 'medium' }, true), []);
  assert.deepEqual(
    approvalBlockers(items, { rating: 'low', override_rating: null }, true), []);
  assert.equal(
    approvalBlockers(items, null, true).length, 1);
});

test('commission payout is blocked while required items are outstanding, and names them', async () => {
  // Answer 19: the checks confirm every requirement is complete before
  // commission is paid.
  const complianceCase = await openIt();

  const outstanding = await commissionPayoutBlockers(applicationId);
  assert.ok(outstanding.length > 0, 'a fresh case has required items outstanding');
  assert.ok(
    outstanding.every((b) => typeof b.label === 'string' && b.label.length > 0),
    'every blocker carries a label a person can act on, not just a key',
  );

  // Complete every required item and the gate opens.
  await query(
    `UPDATE compliance_checklist_items SET status = 'complete', completed_at = now()
      WHERE compliance_case_id = $1 AND required`,
    [complianceCase.id],
  );
  assert.deepEqual(await commissionPayoutBlockers(applicationId), []);
});

test('an item marked not applicable does not hold up commission', async () => {
  // A file with no appraisal requirement must not be held for one.
  const complianceCase = await openIt();
  await query(
    `UPDATE compliance_checklist_items SET status = 'complete' WHERE compliance_case_id = $1 AND required`,
    [complianceCase.id],
  );
  await query(
    `UPDATE compliance_checklist_items SET status = 'not_applicable'
      WHERE compliance_case_id = $1 AND required
        AND item_key = (SELECT item_key FROM compliance_checklist_items
                         WHERE compliance_case_id = $1 AND required LIMIT 1)`,
    [complianceCase.id],
  );
  assert.deepEqual(await commissionPayoutBlockers(applicationId), []);
});

test('a rejected item blocks commission just as an outstanding one does', async () => {
  // Rejected means somebody looked at it and said no. That is not a reason to
  // let the money go.
  const complianceCase = await openIt();
  await query(
    `UPDATE compliance_checklist_items SET status = 'complete' WHERE compliance_case_id = $1 AND required`,
    [complianceCase.id],
  );
  const { rows } = await query<{ item_key: string }>(
    `UPDATE compliance_checklist_items SET status = 'rejected'
      WHERE compliance_case_id = $1 AND required
        AND ctid = (SELECT ctid FROM compliance_checklist_items
                     WHERE compliance_case_id = $1 AND required LIMIT 1)
      RETURNING item_key`,
    [complianceCase.id],
  );
  const blockers = await commissionPayoutBlockers(applicationId);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0]!.item_key, rows[0]!.item_key);
});
