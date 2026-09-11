import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fieldsUsedBy, previewTemplate, renderTemplate, validateTemplate,
} from '../src/domain/merge-fields.ts';

const values = {
  first_name: 'Sarah', user_first_name: 'Michael', user_cell: '(416) 555-0142',
  amount_requested: 785000, closing_date: '2026-10-15', days_to_close: 34,
  documents_outstanding: 2, maturity_date: null, schedule_link: null,
};

test('a complete template renders', () => {
  const result = renderTemplate(
    'Hi {first_name},\nYour {amount_requested} mortgage closes on {closing_date}.\n{user_first_name}',
    { values },
  );
  assert.equal(
    result.text,
    'Hi Sarah,\nYour $785,000 mortgage closes on October 15, 2026.\nMichael',
  );
  assert.deepEqual(result.missing, []);
  assert.equal(result.empty, false);
});

test('a line with a missing value is DROPPED, not rendered blank', () => {
  // The rule the module exists for. "your mortgage matures on ." is
  // embarrassing; "I noticed your rate of 0%" is a false statement about
  // somebody's mortgage sent in a broker's name.
  const result = renderTemplate(
    'Hi {first_name},\nYour mortgage matures on {maturity_date}.\nSpeak soon.',
    { values },
  );
  assert.equal(result.text, 'Hi Sarah,\nSpeak soon.');
  assert.deepEqual(result.missing, ['maturity_date']);
  assert.deepEqual(result.dropped, ['Your mortgage matures on {maturity_date}.']);
});

test('a template whose every line drops reports empty so the send is refused', () => {
  const result = renderTemplate('Your mortgage matures on {maturity_date}.', { values });
  assert.equal(result.text, '');
  assert.equal(result.empty, true);
});

test('dropping a line does not leave a hole where a paragraph was', () => {
  const result = renderTemplate(
    'Hi {first_name},\n\n{maturity_date}\n\nSpeak soon.', { values },
  );
  assert.equal(result.text, 'Hi Sarah,\n\nSpeak soon.');
});

test('zero is a value, not a missing one', () => {
  // "0 documents outstanding" is true and worth saying. Treating 0 as absent
  // would silently drop every sentence about a number that happens to be nil.
  const result = renderTemplate('You have {documents_outstanding} documents outstanding.',
                                { values: { documents_outstanding: 0 } });
  assert.equal(result.text, 'You have 0 documents outstanding.');
  assert.deepEqual(result.missing, []);
});

test('an unknown field is left visible rather than silently deleted', () => {
  // A broker seeing {clietn_name} in a preview fixes the typo. A blank
  // teaches them nothing.
  const result = renderTemplate('Hi {clietn_name},\nAll good.', { values });
  assert.equal(result.text, 'All good.');
  assert.deepEqual(result.missing, ['clietn_name']);
  assert.deepEqual(result.dropped, ['Hi {clietn_name},']);
});

test('validation catches a typo at save time and suggests the field', () => {
  const issues = validateTemplate('Hi {frist_name}, closing {closing_date}');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.field, 'frist_name');
  assert.match(issues[0]!.message, /Did you mean \{first_name\}\?/);
});

test('validation passes a template that only uses real fields', () => {
  assert.deepEqual(
    validateTemplate('Hi {first_name}, call me at {user_cell}. {schedule_link}'),
    [],
  );
});

test('a sensitive field is simply not a merge field', () => {
  // The registry is closed, so nothing can put a date of birth or an income
  // into a message by naming it.
  for (const field of ['date_of_birth', 'sin', 'annual_income', 'password_hash', 'credit_score']) {
    const issues = validateTemplate(`{${field}}`);
    assert.equal(issues.length, 1, `${field} must not be a merge field`);
  }
});

test('fieldsUsedBy finds each field once', () => {
  assert.deepEqual(
    fieldsUsedBy('{first_name} {first_name} {user_cell}').sort(),
    ['first_name', 'user_cell'],
  );
});

test('the preview renders every field through the real code path', () => {
  const preview = previewTemplate(
    'Hi {first_name}, your {amount_requested} closes in {days_to_close} days ({closing_date}).',
  );
  assert.equal(preview.empty, false);
  assert.deepEqual(preview.missing, []);
  assert.match(preview.text, /\$785,000/);
  assert.match(preview.text, /34 days/);
});

test('money and dates are formatted, not printed raw', () => {
  const result = renderTemplate('{amount_requested} on {closing_date}', { values });
  assert.equal(result.text, '$785,000 on October 15, 2026');
  assert.equal(result.text.includes('785000'), false);
  assert.equal(result.text.includes('2026-10-15'), false);
});

test('a malformed date is missing rather than rendered wrong', () => {
  const result = renderTemplate('Closing {closing_date}.', { values: { closing_date: 'soon' } });
  assert.equal(result.empty, true);
  assert.deepEqual(result.missing, ['closing_date']);
});
