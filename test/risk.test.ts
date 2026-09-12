/**
 * The risk model.
 *
 * The property worth testing is not the arithmetic — it is that the score can
 * always be read back as its factors, and that an unanswered question never
 * scores as a clean answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessRisk, EVALUATORS, DEFAULT_BANDS,
  type FactorDefinition, type RiskFacts,
} from '../src/domain/risk.ts';

const baseFacts: RiskFacts = {
  transactionTypeKey: 'purchase',
  amountRequested: 500_000,
  propertyProvince: 'ON',
  propertyCity: 'Toronto',
  applicants: [{ citizenship: 'Canadian citizen' }],
  documentCategories: ['notice_of_assessment', 'pay_stubs'],
  downPaymentSource: 'Savings',
  fintrac: {
    third_party_present: false, entity_borrower: false,
    pep_result: 'none', source_of_funds: 'Savings',
  },
  priorFundings: [],
  today: '2026-09-12',
};

const definition = (
  key: string, evaluator: string, parameters: Record<string, unknown>, weight = 2,
): FactorDefinition => ({
  factor_key: key, label: key.replace(/_/g, ' '), weight, evaluator, parameters,
});

test('a clean file with every question answered scores low', () => {
  const result = assessRisk([
    definition('private_lender', 'transaction_type_in', { values: ['private'] }),
    definition('third_party', 'fintrac_flag', { flag: 'third_party_present' }),
    definition('pep', 'fintrac_pep', {}),
  ], baseFacts);

  assert.equal(result.score, 0);
  assert.equal(result.rating, 'low');
  assert.equal(result.unanswered.length, 0);
  assert.equal(result.summary, 'No risk factor applies to this file.');
});

test('every factor carries its evidence, whether it fired or not', () => {
  const result = assessRisk([
    definition('private_lender', 'transaction_type_in', { values: ['private'] }),
  ], baseFacts);

  const factor = result.factors[0]!;
  assert.equal(factor.triggered, false);
  assert.equal(factor.value, 'purchase');
  assert.ok(factor.note.length > 0, 'a factor that did not fire still explains itself');
});

test('an unanswered determination is review_required, never low', () => {
  // The exact failure this guards: a file where nobody has done the PEP
  // screening scores zero on that factor and would otherwise read "low risk".
  const result = assessRisk([
    definition('pep', 'fintrac_pep', {}, 4),
  ], { ...baseFacts, fintrac: { pep_result: null } });

  assert.equal(result.score, 0);
  assert.equal(result.rating, 'review_required');
  assert.deepEqual(result.unanswered, ['pep']);
  assert.match(result.summary, /have not been made/);
});

test('a file with no FINTRAC assessment at all is review_required', () => {
  const result = assessRisk([
    definition('third_party', 'fintrac_flag', { flag: 'third_party_present' }),
    definition('entity', 'fintrac_flag', { flag: 'entity_borrower' }),
  ], { ...baseFacts, fintrac: null });

  assert.equal(result.rating, 'review_required');
  assert.equal(result.unanswered.length, 2);
});

test('the bands are configuration, and the score is the sum of the weights', () => {
  const definitions = [
    definition('private_lender', 'transaction_type_in', { values: ['private'] }, 2),
    definition('pep', 'fintrac_pep', {}, 4),
  ];
  const facts: RiskFacts = {
    ...baseFacts,
    transactionTypeKey: 'private',
    fintrac: { ...baseFacts.fintrac, pep_result: 'domestic' },
  };

  assert.equal(assessRisk(definitions, facts).score, 6);
  assert.equal(assessRisk(definitions, facts, DEFAULT_BANDS).rating, 'medium');
  assert.equal(assessRisk(definitions, facts, { medium: 2, high: 5 }).rating, 'high');
  assert.equal(assessRisk(definitions, facts, { medium: 20, high: 40 }).rating, 'low');
});

test('the summary names the largest contributors, not a number', () => {
  const result = assessRisk([
    definition('politically exposed person', 'fintrac_pep', {}, 4),
    definition('private mortgage', 'transaction_type_in', { values: ['private'] }, 2),
  ], {
    ...baseFacts,
    transactionTypeKey: 'private',
    fintrac: { ...baseFacts.fintrac, pep_result: 'foreign' },
  });
  assert.match(result.summary, /politically exposed person/);
  assert.ok(result.summary.indexOf('politically exposed person')
    < result.summary.indexOf('private mortgage'), 'ordered by contribution');
});

test('a factor naming an evaluator that does not exist is surfaced, not skipped', () => {
  const result = assessRisk([
    definition('mystery', 'no_such_evaluator', {}),
  ], baseFacts);
  assert.equal(result.rating, 'review_required');
  assert.match(result.factors[0]!.note, /no evaluator called/);
});

// ── The individual evaluators ──────────────────────────────────────────────

test('documents_missing fires only when NONE of the categories is present', () => {
  const run = (categories: string[]) =>
    EVALUATORS.documents_missing!(
      { ...baseFacts, documentCategories: categories },
      { categories: ['notice_of_assessment', 't4', 'pay_stubs'] });

  assert.equal(run(['notice_of_assessment']).triggered, false, 'one is enough');
  assert.equal(run(['void_cheque']).triggered, true);
  assert.equal(run([]).triggered, true);
});

test('repeat_refinance counts only fundings inside the window', () => {
  const run = (dates: string[]) =>
    EVALUATORS.repeat_refinance!(
      { ...baseFacts, priorFundings: dates.map((d) => ({ funding_date: d, final_transaction_type: 'refinance' })) },
      { months: 12 });

  assert.equal(run([]).triggered, false);
  assert.equal(run(['2026-03-01']).triggered, true);
  assert.equal(run(['2024-01-01']).triggered, false);
  // The boundary: exactly twelve months back is inside the window.
  assert.equal(run(['2025-09-12']).triggered, true);
  assert.equal(run(['2025-09-11']).triggered, false);
});

test('a month-end boundary does not roll into the next month', () => {
  // 31 March minus one month is 28 February, not 3 March — the naive
  // date arithmetic that produces the latter makes the window wrong by days.
  const result = EVALUATORS.repeat_refinance!(
    { ...baseFacts, today: '2026-03-31',
      priorFundings: [{ funding_date: '2026-03-01', final_transaction_type: 'refinance' }] },
    { months: 1 });
  assert.equal(result.triggered, true, '1 March is after 28 February');
});

test('applicant_field_in reads every applicant, not only the first', () => {
  const result = EVALUATORS.applicant_field_in!({
    ...baseFacts,
    applicants: [{ citizenship: 'Canadian citizen' }, { citizenship: 'Non-resident' }],
  }, { field: 'citizenship', values: ['Non-resident'] });
  assert.equal(result.triggered, true);
  assert.match(result.note, /Non-resident/);
});

test('an applicant who has not answered is unknown, not a clean answer', () => {
  const result = EVALUATORS.applicant_field_in!(
    { ...baseFacts, applicants: [{}] },
    { field: 'citizenship', values: ['Non-resident'] });
  assert.equal(result.triggered, false);
  assert.equal(result.unknown, true);
});

test('a vague source of funds fires; a specific one does not', () => {
  const run = (source: string | null) =>
    EVALUATORS.fintrac_source_unclear!(
      { ...baseFacts, fintrac: { source_of_funds: source }, downPaymentSource: null }, {});

  assert.equal(run('Cash').triggered, true);
  assert.equal(run('Gift from a parent').triggered, true);
  assert.equal(run('Sale of principal residence').triggered, false);
  assert.equal(run(null).unknown, true);
  assert.equal(run('').unknown, true, 'an empty string is not an answer');
});

test('amount_at_least does not treat a missing amount as zero', () => {
  const result = EVALUATORS.amount_at_least!(
    { ...baseFacts, amountRequested: null }, { amount: 100_000 });
  assert.equal(result.triggered, false);
  assert.equal(result.unknown, true);
});
