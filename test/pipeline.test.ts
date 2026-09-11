import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateTransition, stalledFiles, summarisePipeline, transitionEffects,
  type FileSnapshot, type StageDefinition,
} from '../src/domain/pipeline.ts';

const NOW = new Date('2026-09-11T15:00:00Z');

const file = (over: Partial<FileSnapshot> = {}): FileSnapshot => ({
  stage_key: 'application', stage_changed_at: '2026-09-01T15:00:00Z',
  percent_complete: 100, amount_requested: 785000, closing_date: '2026-10-15',
  property_province: 'ON', transaction_type_key: 'purchase',
  scarlett_deal_id: null, lost_disposition_key: null,
  funding_confirmed: false, funded_amount: null, lender_name: null,
  compliance_outstanding_required: 0, appointment_count: 1, ...over,
});

const stage = (over: Partial<StageDefinition> = {}): StageDefinition => ({
  key: 'scarlett', label: 'Pushed to Scarlett', position: 4,
  category: 'open', probability: 65, active: true, ...over,
});

test('a move with no rules is allowed and measures time in the old stage', () => {
  const d = evaluateTransition(file(), stage(), { now: NOW });
  assert.equal(d.allowed, true);
  assert.ok(d.allowed);
  assert.equal(d.from, 'application');
  assert.equal(d.to, 'scarlett');
  assert.equal(d.secondsInFromStage, 10 * 86400, 'ten days');
  assert.deepEqual(d.warnings, []);
});

test('a refusal names every missing thing, not just the first', () => {
  // "Cannot move to Funded" is useless. A to-do list is not.
  const d = evaluateTransition(
    file({ compliance_outstanding_required: 2 }),
    stage({
      key: 'funded', label: 'Funded', category: 'won',
      entry_rules: { requireFundingConfirmed: true, requireComplianceComplete: true },
    }),
    { now: NOW },
  );
  assert.equal(d.allowed, false);
  assert.ok(!d.allowed);
  assert.equal(d.blockers.length, 4, 'funding confirmed, funded amount, lender, compliance');
  assert.match(d.message, /Cannot move to Funded/);
  assert.match(d.message, /Funding has not been confirmed/);
  assert.match(d.message, /amount that actually advanced is not recorded/);
  assert.match(d.message, /No lender is recorded/);
  assert.match(d.message, /2 required compliance items are still outstanding/);
});

test('the compliance blocker is singular for one item', () => {
  const d = evaluateTransition(
    file({ compliance_outstanding_required: 1 }),
    stage({ key: 'funded', label: 'Funded', entry_rules: { requireComplianceComplete: true } }),
    { now: NOW },
  );
  assert.ok(!d.allowed);
  assert.match(d.message, /1 required compliance item is still outstanding/);
});

test('a funded move succeeds once everything is recorded', () => {
  const d = evaluateTransition(
    file({ funding_confirmed: true, funded_amount: 780000, lender_name: 'MCAP' }),
    stage({ key: 'funded', label: 'Funded', category: 'won',
            entry_rules: { requireFundingConfirmed: true, requireComplianceComplete: true } }),
    { now: NOW },
  );
  assert.equal(d.allowed, true);
});

test('required fields are checked by name and reported by label', () => {
  const d = evaluateTransition(
    file({ closing_date: null, property_province: '  ' }),
    stage({ entry_rules: { requireFields: [
      { field: 'closing_date', label: 'Closing date' },
      { field: 'property_province', label: 'Property province' },
      { field: 'amount_requested', label: 'Mortgage requested' },
    ] } }),
    { now: NOW },
  );
  assert.ok(!d.allowed);
  assert.deepEqual(d.blockers.map((b) => b.field), ['closing_date', 'property_province']);
  assert.match(d.blockers[1]!.message, /Property province is not recorded/,
    'whitespace is blank, not a value');
});

test('completeness and Scarlett rules quote the actual numbers', () => {
  const d = evaluateTransition(
    file({ percent_complete: 62 }),
    stage({ entry_rules: { minPercentComplete: 80, requireScarlettDeal: true } }),
    { now: NOW },
  );
  assert.ok(!d.allowed);
  assert.match(d.message, /62% complete.*needs at least 80%/);
  assert.match(d.message, /not been pushed to Scarlett/);
});

test('a lost stage demands a disposition', () => {
  const lost = stage({ key: 'lost_ni', label: 'Cancelled NI', category: 'lost',
                       entry_rules: { requireLostDisposition: true } });
  assert.equal(evaluateTransition(file(), lost, { now: NOW }).allowed, false);
  assert.equal(
    evaluateTransition(file({ lost_disposition_key: 'not_interested' }), lost, { now: NOW }).allowed,
    true,
  );
});

test('an inactive stage cannot be entered', () => {
  const d = evaluateTransition(file(), stage({ active: false }), { now: NOW });
  assert.ok(!d.allowed);
  assert.match(d.message, /no longer an active stage/);
});

test('force overrides but reports what it overrode', () => {
  // A rule that cannot be overridden is a rule people route around by lying to
  // the board. An override is allowed, recorded, and never silent.
  const d = evaluateTransition(
    file({ compliance_outstanding_required: 3 }),
    stage({ key: 'funded', label: 'Funded', entry_rules: { requireComplianceComplete: true } }),
    { now: NOW, force: true },
  );
  assert.equal(d.allowed, true);
  assert.ok(d.allowed);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0]!.message, /3 required compliance items/);
});

test('a file with no previous stage change reports null rather than zero', () => {
  const d = evaluateTransition(file({ stage_changed_at: null }), stage(), { now: NOW });
  assert.ok(d.allowed);
  assert.equal(d.secondsInFromStage, null, 'unknown is not "no time at all"');
});

test('leaving a lost stage clears the disposition', () => {
  // Otherwise a reactivated client keeps appearing in the lost-reasons report.
  const e = transitionEffects(
    stage({ key: 'lost_ni', category: 'lost' }),
    stage({ key: 'application', category: 'open' }),
    NOW,
  );
  assert.deepEqual(e.clearFields,
    ['lost_disposition_key', 'lost_reason_note', 'lost_at', 'lost_to_competitor']);
  assert.match(e.stopAutomationReasons.join(' '), /reactivated/);
});

test('funding and losing both stop automations', () => {
  // The single most common automation failure is chasing a lead that already
  // funded.
  const funded = transitionEffects(stage({ category: 'open' }), stage({ key: 'funded', category: 'won' }), NOW);
  assert.match(funded.stopAutomationReasons.join(' '), /funded/);
  assert.ok(funded.events.includes('file.funded'));

  const lost = transitionEffects(stage({ category: 'open' }), stage({ key: 'lost', category: 'lost' }), NOW);
  assert.match(lost.stopAutomationReasons.join(' '), /lost/);
  assert.equal(lost.setFields.lost_at, NOW);
});

test('summarisePipeline leaves a null-probability stage out of the forecast, not at zero', () => {
  const stages = [
    stage({ key: 'lead', label: 'Lead', position: 1, probability: 5 }),
    stage({ key: 'scarlett', label: 'Scarlett', position: 2, probability: 65 }),
    stage({ key: 'nurture', label: 'Nurture', position: 3, probability: null, category: 'parked' }),
  ];
  const files = [
    { stage_key: 'lead', amount_requested: 100000 },
    { stage_key: 'lead', amount_requested: 200000 },
    { stage_key: 'scarlett', amount_requested: 400000 },
    { stage_key: 'nurture', amount_requested: 900000 },
    { stage_key: null, amount_requested: 500000 },
    { stage_key: 'retired_stage', amount_requested: 500000 },
  ];
  const summary = summarisePipeline(files, stages);
  assert.equal(summary.length, 3);
  assert.deepEqual(summary.map((s) => s.stage.key), ['lead', 'scarlett', 'nurture'], 'ordered by position');
  assert.equal(summary[0]!.count, 2);
  assert.equal(summary[0]!.value, 300000);
  assert.equal(summary[0]!.weighted, 15000);
  assert.equal(summary[1]!.weighted, 260000);
  assert.equal(summary[2]!.count, 1, 'counted');
  assert.equal(summary[2]!.weighted, 0, 'but not forecast');
});

test('stalledFiles reports only stages with a configured threshold, worst first', () => {
  const files = [
    { id: 'a', stage_key: 'lead', stage_changed_at: '2026-08-01T00:00:00Z' },   // 41 days
    { id: 'b', stage_key: 'lead', stage_changed_at: '2026-09-05T00:00:00Z' },   // 6 days
    { id: 'c', stage_key: 'scarlett', stage_changed_at: '2026-07-01T00:00:00Z' },
    { id: 'd', stage_key: 'lead', stage_changed_at: null },
  ];
  const stalled = stalledFiles(files, { lead: 14 }, '2026-09-11');
  assert.deepEqual(stalled.map((s) => s.file.id), ['a'],
    'b is inside the threshold, c has no threshold, d has no date');
  assert.equal(stalled[0]!.days, 41);
  assert.equal(stalled[0]!.threshold, 14);
});
