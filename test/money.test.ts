/**
 * Money.
 *
 * The properties worth guarding are the ones that cost real money or real
 * trust: parsing, the splits adding up to the whole, and a term in months
 * landing on the right day.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commissionFromBps, describeVariance, divideCommission, fromCents,
  maturityFrom, milestonesFor, toCents, variance,
} from '../src/domain/money.ts';

test('a blank or unparseable amount is null, never zero', () => {
  // The failure: Number('') is 0, so a blank field becomes a zero-dollar
  // mortgage and every total built on it is wrong and looks deliberate.
  assert.equal(toCents(''), null);
  assert.equal(toCents(null), null);
  assert.equal(toCents(undefined), null);
  assert.equal(toCents('n/a'), null);
  assert.equal(toCents('   '), null);
  assert.equal(toCents(0), 0, 'but a real zero is a real zero');
});

test('money parses the way people type it', () => {
  assert.equal(toCents('$500,000'), 50_000_000);
  assert.equal(toCents('500000.55'), 50_000_055);
  assert.equal(toCents(4250.5), 425_050);
  assert.equal(toCents('  $1,234.56  '), 123_456);
  assert.equal(fromCents(425_050), '4250.50');
});

test('rounding at the cent is half-up, matching a lender statement', () => {
  // 85bps on $500,000 is exactly $4,250.
  assert.equal(commissionFromBps(50_000_000, 85), 425_000);
  // 87.5bps on $412,345.67 is $3,608.0246, so $3,608.02 — the kind of number
  // that exposes float drift. Computing it as 412345.67 * 0.00875 * 100 in
  // floats gives ...46125000005, which is the same answer here but is not
  // the same arithmetic.
  assert.equal(commissionFromBps(41_234_567, 87.5), 360_802);
  // A true half lands up, which is what a lender statement does.
  assert.equal(commissionFromBps(1_000, 5), 1, '0.5 cents rounds to 1');
});

test('splits always add up to the whole', () => {
  // A third each of $1,000.01 cannot divide evenly. The parts must still sum
  // to the total: a split table that does not is the first thing anybody
  // checks and the fastest way to lose their confidence.
  const gross = 100_001;
  const result = divideCommission(gross, [
    { party: 'broker', percent: 33.3333 },
    { party: 'brokerage', percent: 33.3333 },
    { party: 'house', percent: 33.3334 },
  ]);
  assert.equal(result.splits.reduce((s, x) => s + x.amount, 0), gross);
  assert.equal(result.remainder, 0);
  assert.deepEqual(result.problems, []);
});

test('a fixed referral fee comes out first, not out of a share', () => {
  const result = divideCommission(425_000, [
    { party: 'referrer', party_name: 'Kelly', amount: 50_000 },
    { party: 'broker', percent: 70 },
    { party: 'brokerage', percent: 30 },
  ]);
  const byParty = Object.fromEntries(result.splits.map((s) => [s.party, s.amount]));
  assert.equal(byParty.referrer, 50_000);
  assert.equal(byParty.broker, 297_500, '70% of the gross, not of what is left');
  assert.equal(byParty.brokerage, 127_500);
  // Which means the fixed fee is genuinely over-allocated, and that is said
  // out loud rather than absorbed.
  assert.equal(result.remainder, -50_000);
});

test('percentages that do not come to a hundred are named, not silently accepted', () => {
  const short = divideCommission(425_000, [
    { party: 'broker', percent: 70 },
    { party: 'brokerage', percent: 20 },
  ]);
  assert.equal(short.problems.length, 1);
  assert.match(short.problems[0]!, /10% unallocated/);
  assert.equal(short.remainder, 42_500, 'and the unallocated money stays visible');

  const over = divideCommission(425_000, [
    { party: 'broker', percent: 70 },
    { party: 'brokerage', percent: 50 },
  ]);
  assert.match(over.problems[0]!, /more than the whole/);
});

test('fixed amounts larger than the commission are refused in words', () => {
  const result = divideCommission(100_000, [
    { party: 'referrer', amount: 150_000 },
  ]);
  assert.match(result.problems[0]!, /more than the commission itself/);
  assert.match(result.problems[0]!, /\$1,500\.00 of \$1,000\.00/);
});

test('a variance is described the way somebody would say it', () => {
  assert.equal(describeVariance(425_000, 393_750).label, 'Short by $312.50');
  assert.equal(describeVariance(425_000, 425_000).label, 'Matches what was expected');
  assert.equal(describeVariance(425_000, 450_000).tone, 'warn');
  assert.equal(describeVariance(425_000, 393_750).tone, 'danger');
  assert.equal(describeVariance(425_000, null).tone, 'neutral');
  assert.equal(describeVariance(null, 425_000).tone, 'warn', 'money nobody expected is a question');
  assert.equal(variance(425_000, 393_750), -31_250);
  assert.equal(variance(null, 393_750), null, 'a variance against nothing is not zero');
});

test('a term in months lands on the right day at a month end', () => {
  assert.equal(maturityFrom('2026-09-15', 60), '2031-09-15');
  // 31 August plus six months is 28 February, not 3 March.
  assert.equal(maturityFrom('2026-08-31', 6), '2027-02-28');
  // And in a leap year, 29 February.
  assert.equal(maturityFrom('2027-08-31', 6), '2028-02-29');
  assert.equal(maturityFrom('2026-11-30', 3), '2027-02-28');
});

test('renewal milestones count back from maturity and know which have passed', () => {
  const milestones = milestonesFor('2027-03-31', '2026-09-12');
  assert.deepEqual(milestones.map((m) => m.key),
    ['t_minus_6m', 't_minus_3m', 't_minus_45d']);
  assert.equal(milestones[0]!.due_on, '2026-09-29');
  assert.equal(milestones[2]!.due_on, '2027-02-14');
  assert.equal(milestones[0]!.past, false);

  // A maturity already close by: the early milestones are behind us and say so
  // rather than being quietly dropped.
  const late = milestonesFor('2026-10-01', '2026-09-12');
  assert.equal(late[0]!.past, true);
  assert.equal(late[2]!.past, true);
});
