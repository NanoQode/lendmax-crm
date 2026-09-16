/**
 * The application form — the rules, against the real vendored schema.
 *
 * These assert behaviour the portal has, not behaviour invented here: if a
 * refreshed `vendor/portal-schema.js` changes which questions apply or what
 * they accept, these are what say so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changedPaths, checkField, fieldsOf, flatRoot, isActive, mergeAnswers, money, readPath,
  repeatGroupsOf, SECTION_IDS, sectionById, sectionPath, validateSection, writePath,
} from '../src/domain/application-form.ts';

// ── The schema itself ──────────────────────────────────────────────────────

test('the form is the portal’s, section for section', () => {
  assert.deepEqual(SECTION_IDS, [
    'purpose', 'property', 'applicants', 'income', 'assets',
    'liabilities', 'other_properties', 'review', 'documents',
  ]);
  // The lists, and their limits, are the portal's too.
  assert.equal(sectionById('applicants')!.repeat!.max, 4);
  assert.equal(sectionById('liabilities')!.repeat!.max, 40);
  assert.equal(sectionById('other_properties')!.gate!.n, 'owns_other');
  assert.equal(sectionById('assets')!.declare!.n, 'none');
});

test('a nested list belongs to the row, not to the section', () => {
  // An applicant's other jobs are per applicant. Flattened into the section's
  // own fields they would be demanded once, at the wrong level.
  const applicants = sectionById('applicants')!;
  const nested = repeatGroupsOf(applicants);
  assert.ok(nested.some((g) => g.repeat!.key === 'employments'));
  assert.equal(fieldsOf(applicants).some((f) => f.group === 'app_more_jobs'), false);
});

// ── When a question applies ────────────────────────────────────────────────

test('what the client is here for decides what they are asked', () => {
  const property = sectionById('property')!;
  const field = (n: string) => fieldsOf(property).find((f) => f.n === n)!;

  const purchase = { purpose: 'Purchase' };
  const renew = { purpose: 'Renew' };

  assert.equal(isActive(field('purchase_price'), {}, purchase), true);
  assert.equal(isActive(field('purchase_price'), {}, renew), false);
  assert.equal(isActive(field('down_payment'), {}, purchase), true);
  assert.equal(isActive(field('down_payment'), {}, renew), false);
  assert.equal(isActive(field('down_source'), {}, renew), false);
  assert.equal(isActive(field('property_value'), {}, renew), true);
  assert.equal(isActive(field('found_property'), {}, purchase), true,
    'only a buyer is asked whether they have found one');
});

test('the charges already on the property are asked for on anything but a purchase', () => {
  // …and on a purchase too, when the money being asked for sits behind
  // somebody else's charge. Two reasons, one group — which is why the
  // condition is an `any`.
  const group = sectionById('property')!.groups.find((g) => g.id === 'prop_mortgages')!;
  const live = (root: Record<string, unknown>) => isActive({ when: group.when }, {}, root);

  assert.equal(live({ purpose: 'Renew' }), true);
  assert.equal(live({ purpose: 'Refinance' }), true);
  assert.equal(live({ purpose: 'Purchase' }), false);
  assert.equal(live({ purpose: 'Purchase', request_position: '2' }), true,
    'a second behind somebody else’s first');
  assert.equal(group.repeat!.key, 'mortgages');
});

test('a condo is asked its fee; a detached house is not', () => {
  const field = fieldsOf(sectionById('property')!).find((f) => f.n === 'condo_fee')!;
  assert.equal(isActive(field, { home_type: 'Condo apartment' }), true);
  assert.equal(isActive(field, { home_type: 'Condo townhouse' }), true);
  assert.equal(isActive(field, { home_type: 'Detached' }), false);
});

test('a renter is asked their rent, an owner is not', () => {
  const field = fieldsOf(sectionById('applicants')!).find((f) => f.n === 'monthly_rent')!;
  assert.equal(isActive(field, { residential_status: 'Rent' }), true);
  assert.equal(isActive(field, { residential_status: 'Own' }), false);
});

test('a short time at an address asks for the previous one', () => {
  const field = fieldsOf(sectionById('applicants')!).find((f) => f.n === 'prev_address')!;
  assert.equal(isActive(field, { years_at_address: 1 }), true);
  assert.equal(isActive(field, { years_at_address: 5 }), false);
  assert.equal(isActive(field, {}), false, 'unanswered is not "under two years"');
});

test('somebody retired is not asked who employs them', () => {
  const field = fieldsOf(sectionById('applicants')!).find((f) => f.n === 'employer')!;
  assert.equal(isActive(field, { employment_type: 'Employed — salaried' }), true);
  assert.equal(isActive(field, { employment_type: 'Retired / pension' }), false);
  assert.equal(isActive(field, { employment_type: 'Student' }), false);
  assert.equal(isActive(field, { employment_type: 'Not employed' }), false);
});

test('a field in a conditional group is only live when the group is', () => {
  const field = { when: { field: 'a', in: ['x'] }, groupWhen: { field: 'g', in: ['on'] } };
  assert.equal(isActive(field, { a: 'x', g: 'on' }), true);
  assert.equal(isActive(field, { a: 'x', g: 'off' }), false, 'the group is closed');
});

test('a condition can read the whole application, not just the entry', () => {
  // "Paying this out with the mortgage?" on a liability depends on the purpose,
  // which lives in another section entirely.
  const field = fieldsOf(sectionById('liabilities')!).find((f) => f.n === 'payoff')!;
  assert.equal(isActive(field, {}, { purpose: 'Refinance' }), true);
  assert.equal(isActive(field, {}, { purpose: 'Purchase' }), false);
  assert.deepEqual(flatRoot({ purpose: { purpose: 'Refinance' }, property: { city: 'Barrie' } }),
    { purpose: 'Refinance', city: 'Barrie' });
});

// ── What a question accepts ────────────────────────────────────────────────

const f = (over: Record<string, unknown>) => ({ n: 'x', l: 'Field', t: 'text', ...over } as any);

test('the validators are the portal’s, word for word', () => {
  assert.equal(checkField(f({ t: 'email' }), 'not-an-email'), 'That does not look like an email address.');
  assert.equal(checkField(f({ t: 'email' }), 'rena@example.com'), null);

  assert.equal(checkField(f({ t: 'phone' }), '416555'), 'Enter a 10-digit phone number.');
  assert.equal(checkField(f({ t: 'phone' }), '(416) 555-0142'), null);
  assert.equal(checkField(f({ t: 'phone' }), '1 416 555 0142'), null);

  assert.equal(checkField(f({ t: 'postal' }), 'M5V2T6'), null);
  assert.equal(checkField(f({ t: 'postal' }), 'M5V 2T6'), null);
  assert.match(checkField(f({ t: 'postal' }), '90210')!, /Canadian postal code/);

  assert.equal(checkField(f({ t: 'money' }), '$450,000'), null);
  assert.equal(checkField(f({ t: 'money' }), '-5'), 'This cannot be negative.');
  assert.equal(checkField(f({ t: 'money' }), '200000000'), 'Please check that figure.');

  assert.equal(checkField(f({ t: 'percent' }), '5.29'), null);
  assert.match(checkField(f({ t: 'percent' }), '45')!, /between 0 and 30/);

  assert.match(checkField(f({ t: 'year' }), '1700')!, /between 1800 and/);
  assert.equal(checkField(f({ t: 'year' }), '1998'), null);
});

test('a date of birth is held to an age, not just a format', () => {
  const dob = f({ t: 'date', n: 'dob' });
  const yearsAgo = (n: number) =>
    new Date(Date.now() - n * 31_557_600_000).toISOString().slice(0, 10);
  assert.equal(checkField(dob, yearsAgo(30)), null);
  assert.equal(checkField(dob, yearsAgo(10)), 'Applicants must be 18 or older.');
  assert.equal(checkField(dob, yearsAgo(150)), 'Please check the year.');
  assert.equal(checkField(dob, 'sometime in 1990'), 'Enter a date.');
});

test('a required field says which one it is; a tickbox asks to be ticked', () => {
  assert.equal(checkField(f({ req: true, l: 'City' }), ''), 'City is required.');
  assert.equal(checkField(f({ req: true, t: 'checkbox' }), false), 'Please tick this to continue.');
  assert.equal(checkField(f({ req: false }), ''), null);
});

test('a choice must be one of the choices', () => {
  const select = f({ t: 'select', o: ['Own', 'Rent'] });
  assert.equal(checkField(select, 'Rent'), null);
  assert.equal(checkField(select, 'Squatting'), 'Choose one of the options.');
});

test('money reads what people actually type', () => {
  assert.equal(money('$1,200.50'), 1200.5);
  assert.equal(money(''), null);
  assert.equal(money(0), 0, 'nothing is not the same as no answer');
  // The portal's own quirk, kept rather than corrected: stripping the
  // non-numerics out of "abc" leaves "", and Number('') is 0. Diverging here
  // would mean the CRM accepted a figure the portal rejected, or the reverse.
  assert.equal(money('abc'), 0);
});

// ── A whole section ────────────────────────────────────────────────────────

test('a section is checked only on the questions that apply to it', () => {
  // A renewal is never asked its purchase price, so not having one is fine.
  const renewal = validateSection('property', {
    city: 'Barrie', province: 'ON', home_type: 'Detached', occupancy: 'Owner occupied',
    sqft: 1800, heat_type: 'Forced air gas', property_value: 600_000,
    annual_taxes: 4200, monthly_heat: 150, street_number: '12', street_name: 'Bay',
    mortgages: [{ position: '1', loan_type: 'Mortgage', lender: 'RBC',
                  balance: 310_000, payment: 1640 }],
  }, { purpose: 'Renew' });
  assert.deepEqual(renewal.errors, {});
  assert.equal(renewal.ok, true);

  // The same answers on a purchase are missing two things that now apply.
  const purchase = validateSection('property', {
    city: 'Barrie', province: 'ON', home_type: 'Detached', occupancy: 'Owner occupied',
    sqft: 1800, heat_type: 'Forced air gas', annual_taxes: 4200, monthly_heat: 150,
    street_number: '12', street_name: 'Bay', found_property: 'Yes',
  }, { purpose: 'Purchase' });
  assert.equal(purchase.ok, false);
  assert.ok(purchase.errors.purchase_price);
  assert.ok(purchase.errors.down_payment);
});

test('errors in a list are keyed by row', () => {
  const result = validateSection('liabilities', [
    { liability_type: 'Credit Card', lender: 'RBC', balance: 4000, payment: 200 },
    { liability_type: 'Car Loan', lender: '', balance: -1, payment: 400 },
  ], { purpose: 'Refinance' });
  assert.equal(result.ok, false);
  assert.equal(result.errors['1.lender'], 'Creditor name is required.');
  assert.equal(result.errors['1.balance'], 'This cannot be negative.');
  assert.equal(result.errors['0.lender'], undefined);
});

test('a declaration is an answer; silence is not', () => {
  assert.equal(validateSection('assets', [], {}, { none: true }).declared, true);
  const contradiction = validateSection('assets', [{ asset_type: 'TFSA', value: 100 }], {}, { none: true });
  assert.equal(contradiction.ok, false);
  assert.match(contradiction.errors._section!, /declared none, but 1 entry is still listed/);

  // The gate on other properties works the same way.
  assert.equal(validateSection('other_properties', [], {}, { owns_other: 'no' }).declared, true);
  assert.equal(validateSection('other_properties', [], {}, {}).ok, false);
});

test('a broker correcting one field is not made to finish the client’s section', () => {
  // The whole reason `partial` exists: a wrong postal code must be fixable on a
  // file the client left half-done, without demanding the other forty answers.
  const half = { city: 'Barrie', postal_code: 'M5V 2T6' };
  assert.equal(validateSection('property', half, { purpose: 'Renew' }).ok, false);
  assert.equal(validateSection('property', half, { purpose: 'Renew' }, {}, { partial: true }).ok, true);

  // It relaxes what is required, never what is valid.
  const wrong = { city: 'Barrie', postal_code: 'nonsense' };
  const result = validateSection('property', wrong, { purpose: 'Renew' }, {}, { partial: true });
  assert.equal(result.ok, false);
  assert.match(result.errors.postal_code!, /Canadian postal code/);
});

// ── Whose answer wins ──────────────────────────────────────────────────────

test('a correction lies over the client’s answer without destroying it', () => {
  const portal = {
    purpose: { purpose: 'Renew', amount_requested: 300_000 },
    property: { city: 'Barrie', postal_code: 'L4M 1A1' },
  };
  const merged = mergeAnswers(portal, [{ path: 'property.postal_code', value: 'L4N 7L3' }]);

  assert.equal(merged.property.postal_code, 'L4N 7L3');
  assert.equal(merged.property.city, 'Barrie', 'everything else is untouched');
  assert.equal(portal.property.postal_code, 'L4M 1A1', 'and the client’s answer still stands');
});

test('a scalar is pinned by itself; a list is pinned as a list', () => {
  // A broker changing one field must not stop the portal updating the forty
  // beside it — but rows in a list have no stable identity, so a list is one
  // unit or a correction silently reattaches to the wrong row.
  assert.deepEqual(
    changedPaths('property', { city: 'Barrie', postal_code: 'L4M 1A1' },
                             { city: 'Barrie', postal_code: 'L4N 7L3' }),
    ['property.postal_code']);
  assert.deepEqual(
    changedPaths('liabilities', [{ balance: 1 }], [{ balance: 2 }]),
    ['liabilities']);
  assert.deepEqual(changedPaths('property', { city: 'Barrie' }, { city: 'Barrie' }), [],
    'opening a section and saving it unchanged pins nothing');
  assert.equal(sectionPath('liabilities'), 'liabilities');
  assert.equal(sectionPath('property'), 'property');
});

test('an empty string and no answer at all are the same non-answer', () => {
  assert.deepEqual(changedPaths('property', { unit: null }, { unit: '' }), []);
  assert.deepEqual(changedPaths('property', {}, { unit: '4B' }), ['property.unit']);
});

test('paths are read and written where the form addresses them', () => {
  const data: Record<string, any> = {};
  writePath(data, 'property.mortgages', [{ lender: 'RBC' }]);
  writePath(data, 'purpose.amount_requested', 300_000);
  assert.deepEqual(data, {
    property: { mortgages: [{ lender: 'RBC' }] },
    purpose: { amount_requested: 300_000 },
  });
  assert.equal(readPath(data, 'purpose.amount_requested'), 300_000);
  assert.equal(readPath(data, 'nothing.here'), undefined);
});
