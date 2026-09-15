/**
 * Tracked calculator links.
 *
 * In the database suite rather than the unit suite only because
 * link-tracking.ts reads the environment at import for its signing secret.
 * The logic under test is pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db/pool.ts';
import {
  calculatorMergeValues, trackedCalculatorUrl, verifyTrackedLink,
} from '../../src/services/link-tracking.ts';
import { CALCULATORS_BY_TRANSACTION } from '../../src/domain/calculators.ts';

const ORG = '11111111-1111-1111-1111-111111111111';
const CUST = '22222222-2222-2222-2222-222222222222';

test('every render path gets a usable calculator link and name', () => {
  // The bug this pins down: the link was wired into the automation engine
  // only, so a broker composing by hand and a campaign both produced a
  // {calculator_link} that could not resolve — and the renderer correctly
  // dropped the whole line, silently. The safety mechanism working perfectly
  // on a value that should never have been missing.
  for (const key of [...Object.keys(CALCULATORS_BY_TRANSACTION), 'unmapped-nonsense', null]) {
    const v = calculatorMergeValues(ORG, CUST, key);
    assert.ok(v.calculator_name, `${key} produced no calculator name`);
    assert.ok(v.calculator_link, `${key} produced no calculator link`);
    assert.match(
      v.calculator_link!, /\/r\/[0-9a-f-]+\.[a-z0-9-]+\.[A-Za-z0-9_-]+$/,
      'a tracked redirect, not a bare rateshop URL',
    );
  }
});

test('a customer with no id gets no link rather than a broken one', () => {
  const v = calculatorMergeValues(ORG, '', 'renewal');
  assert.equal(v.calculator_link, null, 'null drops the line; a broken URL would not');
  assert.ok(v.calculator_name);
});

test('a token round-trips, and a tampered one is refused', () => {
  const url = trackedCalculatorUrl(ORG, CUST, 'heloc-calculator');
  const token = url.split('/r/')[1]!;

  const ok = verifyTrackedLink(token, ORG);
  assert.equal(ok?.customerId, CUST);
  assert.equal(ok?.destination, 'https://rateshop.ca/mortgage-calculator/heloc-calculator/');

  assert.equal(verifyTrackedLink(token.slice(0, -2) + 'xx', ORG), null, 'signature checked');
  assert.equal(verifyTrackedLink(token, '33333333-3333-3333-3333-333333333333'), null,
    'a token from another organisation does not verify');
});

test('the destination is never taken from the token', () => {
  // The open-redirect guard: swap the slug for something that is not on our
  // list and the link is refused rather than followed.
  const url = trackedCalculatorUrl(ORG, CUST, 'heloc-calculator');
  const [id, , sig] = url.split('/r/')[1]!.split('.');
  assert.equal(verifyTrackedLink(`${id}.evil-site-com.${sig}`, ORG), null);
});

test.after(async () => { await pool.end(); });
