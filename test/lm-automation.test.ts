/**
 * LM Automation — the parts of the new builder that need no database: several
 * triggers, If / Else with many branches, conditions on application answers,
 * waiting for a date, and a catalogue that cannot drift from the engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chosenBranch, DefinitionSchema, evaluateCondition, nextKey, NodeSchema, TRIGGERS, validateDefinition, waitUntil,
} from '../src/domain/automation.ts';
import { ACTION_CATALOGUE, TRIGGER_CATALOGUE } from '../src/domain/automation-catalogue.ts';
import { applicationFacts, applicationFactFields, factFields } from '../src/domain/automation-facts.ts';

test('an old single trigger is read as a list, and several triggers are kept', () => {
  const old = DefinitionSchema.parse({ trigger: { type: 'file.funded' }, start_node: 'a', nodes: [{ key: 'a', type: 'stop' }] });
  assert.deepEqual(old.triggers.map((t) => t.type), ['file.funded']);
  const many = DefinitionSchema.parse({
    triggers: [{ type: 'customer.created' }, { type: 'tag.added', filters: [{ field: 'event.tag', op: 'eq', value: 'vip' }] }],
    start_node: 'a', nodes: [{ key: 'a', type: 'stop' }],
  });
  assert.deepEqual(many.triggers.map((t) => t.type), ['customer.created', 'tag.added']);
  assert.equal(many.trigger.type, 'customer.created', 'the first is still readable as `trigger`');
});

test('an empty workflow saves, but cannot be published', () => {
  const empty = DefinitionSchema.parse({ triggers: [{ type: 'manual' }] });
  assert.deepEqual(empty.nodes, []);
  assert.match(validateDefinition(empty).filter((i) => i.level === 'error')[0]!.message, /at least one action/);
});

test('a step dropped on the canvas and not filled in yet still saves, and is named in the publish errors', () => {
  const draft = DefinitionSchema.parse({
    triggers: [{ type: 'manual' }], start_node: 'enrol',
    nodes: [
      { key: 'enrol', type: 'enroll_automation', automation_id: '', next: 'hook' },
      { key: 'hook', type: 'webhook', url: 'https://', next: 'mail' },
      { key: 'mail', type: 'send_email', label: 'Welcome', body: 'Hi', next: null },
    ],
  });
  const errors = validateDefinition(draft).filter((i) => i.level === 'error').map((i) => i.message);
  assert.deepEqual(errors, [
    'The "Add to workflow" step has no workflow to add the client to.',
    'The "Webhook" step has no web address to call.',
    '"Welcome" has no subject.',
  ]);
});

const fastTrack = DefinitionSchema.parse({
  triggers: [{ type: 'application.submitted' }],
  stop_conditions: [{ field: 'stage_category', op: 'eq', value: 'won', reason: 'Funded' }],
  start_node: 'split',
  nodes: [
    { key: 'split', type: 'if_else', else_next: 'standard', branches: [
      { key: 'big', name: 'Big purchase', next: 'vip', conditions: [
        { field: 'purpose.purpose', op: 'eq', value: 'Purchase' },
        { field: 'calc.total_income', op: 'gt', value: 150000 }] },
      { key: 'refi', name: 'Refinance', next: 'refi_mail', conditions: [{ field: 'purpose.purpose', op: 'eq', value: 'Refinance' }] },
    ] },
    { key: 'vip', type: 'add_tag', tag: 'vip', next: null },
    { key: 'refi_mail', type: 'send_email', subject: 'Refi', body: 'Hi', next: null },
    { key: 'standard', type: 'set_stage', stage_key: 'application', next: null },
  ],
});

test('If / Else takes the first branch that matches, and None when nothing does', () => {
  const split = fastTrack.nodes[0]!;
  assert.equal(nextKey(split, { 'purpose.purpose': 'Purchase', 'calc.total_income': 180000 }), 'vip');
  assert.equal(nextKey(split, { 'purpose.purpose': 'Purchase', 'calc.total_income': 90000 }), 'standard');
  assert.equal(nextKey(split, { 'purpose.purpose': 'Refinance', 'calc.total_income': 500000 }), 'refi_mail');
  assert.equal(chosenBranch(split as never, { 'purpose.purpose': 'Renew' }), null);
  assert.deepEqual(validateDefinition(fastTrack).filter((i) => i.level === 'error'), []);
});

test('a branch with no conditions, and a step with nothing to do, are publish errors', () => {
  const broken = DefinitionSchema.parse({
    triggers: [{ type: 'manual' }], start_node: 'split',
    nodes: [
      { key: 'split', type: 'if_else', else_next: 'tag', branches: [{ key: 'b', name: 'Empty', conditions: [], next: null }] },
      { key: 'tag', type: 'add_tag', tag: ' ', next: 'hook' },
      { key: 'hook', type: 'webhook', url: 'http://example.com/x', next: null },
    ],
  });
  const errors = validateDefinition(broken).filter((i) => i.level === 'error').map((i) => i.message).join(' | ');
  assert.match(errors, /"Empty" branch .* has no conditions/);
  assert.match(errors, /has no tag/);
  assert.match(errors, /https/);
});

test('a loop through an If / Else with no wait is refused', () => {
  const spin = DefinitionSchema.parse({
    triggers: [{ type: 'manual' }], start_node: 'split',
    nodes: [
      { key: 'split', type: 'if_else', else_next: null, branches: [{ key: 'b', name: 'x', conditions: [{ field: 'x', op: 'is_set' }], next: 'tag' }] },
      { key: 'tag', type: 'add_tag', tag: 'a', next: 'back' },
      { key: 'back', type: 'goto', target: 'split' },
    ],
  });
  assert.ok(validateDefinition(spin).some((i) => /loop with no wait/.test(i.message)));
});

test('conditions read tags as a list, money with commas, and a missing number as false', () => {
  assert.equal(evaluateCondition({ field: 'tags', op: 'contains', value: 'VIP' }, { tags: ['vip', 'realtor'] }), true);
  assert.equal(evaluateCondition({ field: 'tags', op: 'not_contains', value: 'vip' }, { tags: ['realtor'] }), true);
  assert.equal(evaluateCondition({ field: 'calc.total_income', op: 'gt', value: '120,000' }, { 'calc.total_income': 125000 }), true);
  assert.equal(evaluateCondition({ field: 'calc.total_income', op: 'lt', value: 120000 }, {}), false);
  assert.equal(evaluateCondition({ field: 'purpose.purpose', op: 'eq', value: 'purchase' }, { 'purpose.purpose': 'Purchase' }), true);
});

test('a wait until a date on the file, and one whose date has passed', () => {
  const node = NodeSchema.parse({ key: 'w', type: 'wait', until_field: 'closing_date', until_offset_days: -3 }) as never;
  const now = new Date('2026-09-16T12:00:00');
  assert.equal(waitUntil(node, { closing_date: '2026-10-01' }, now).toISOString().slice(0, 10), '2026-09-28');
  assert.equal(waitUntil(node, { closing_date: '2026-09-17' }, now).getTime(), now.getTime(), 'already past: now');
  assert.equal(waitUntil(node, {}, now).getTime(), now.getTime(), 'no date: now');
});

test('the application answers become facts, with the household figures worked out', () => {
  const facts = applicationFacts({
    purpose: { purpose: 'Purchase', amount_requested: '480000' },
    property: { purchase_price: '600,000', down_payment: '120000', occupancy: 'Owner occupied' },
    applicants: [{ first_name: 'Sarah', annual_income: '95,000' }, { first_name: 'James', annual_income: 70000 }],
    income: [{ amount: 1000, frequency: 'Monthly' }],
    assets: [{ value: 50000 }, { value: '25,000' }],
    liabilities: [{ balance: 4000, payment: 200 }, { balance: 12000, payment: 350 }],
    other_properties: [{}],
  });
  assert.equal(facts['purpose.purpose'], 'Purchase');
  assert.equal(facts['property.occupancy'], 'Owner occupied');
  assert.equal(facts['applicant.first_name'], 'Sarah', 'the primary borrower');
  assert.equal(facts['calc.borrowers'], 2);
  assert.equal(facts['calc.employment_income'], 165000);
  assert.equal(facts['calc.other_income'], 12000);
  assert.equal(facts['calc.total_income'], 177000);
  assert.equal(facts['calc.total_assets'], 75000);
  assert.equal(facts['calc.total_debt'], 16000);
  assert.equal(facts['calc.monthly_debt_payments'], 550);
  assert.equal(facts['calc.down_payment_percent'], 20);
  assert.equal(facts['calc.other_properties'], 1);
});

test('every portal question is offered as a condition, with its options', () => {
  const fields = applicationFactFields();
  const purpose = fields.find((f) => f.field === 'purpose.purpose')!;
  assert.equal(purpose.type, 'enum');
  assert.deepEqual(purpose.options, ['Purchase', 'Renew', 'Refinance', 'Home Equity Line']);
  assert.equal(fields.find((f) => f.field === 'applicant.annual_income')?.type, 'number');
  assert.ok(factFields().some((f) => f.field === 'calc.total_income'));
  const names = factFields().map((f) => f.field);
  assert.equal(new Set(names).size, names.length, 'no field offered twice');
});

test('the builder offers every trigger and every step the engine runs, and nothing it does not', () => {
  assert.deepEqual(TRIGGER_CATALOGUE.map((t) => t.type).sort(), [...TRIGGERS].sort());
  const engineSteps = NodeSchema.options.map((o) => o.shape.type.value).filter((t) => t !== 'branch').sort();
  assert.deepEqual(ACTION_CATALOGUE.map((a) => a.type).sort(), engineSteps);
});
