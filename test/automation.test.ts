import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCondition, evaluateConditions, firstStopReason, nextKey, nodeByKey,
  validateDefinition, waitMs, DefinitionSchema, type AutomationDefinition,
} from '../src/domain/automation.ts';

const base: AutomationDefinition = DefinitionSchema.parse({
  trigger: { type: 'application.created' },
  entry_conditions: [],
  stop_conditions: [
    { field: 'percent_complete', op: 'gte', value: 100, reason: 'The application was completed' },
    { field: 'stage_category', op: 'in', value: ['won', 'lost'], reason: 'The file was resolved' },
  ],
  start_node: 'first',
  nodes: [
    { key: 'first', type: 'send_email', subject: 'Hello', body: 'Hi', next: 'wait1' },
    { key: 'wait1', type: 'wait', hours: 24, next: 'check' },
    { key: 'check', type: 'branch', conditions: [{ field: 'documents_outstanding', op: 'gt', value: 0 }],
      if_true: 'chase', if_false: 'done' },
    { key: 'chase', type: 'send_sms', body: 'Still need those docs', next: 'done' },
    { key: 'done', type: 'stop', reason: 'Sequence finished' },
  ],
});

test('a sound definition publishes with no errors', () => {
  const issues = validateDefinition(base);
  assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
});

test('a step pointing at nothing is an error', () => {
  const broken = { ...base, nodes: base.nodes.map((n) =>
    n.key === 'first' ? { ...n, next: 'nowhere' } : n) } as AutomationDefinition;
  const errors = validateDefinition(broken).filter((i) => i.level === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /"nowhere", which does not exist/);
});

test('a loop with no wait in it is refused', () => {
  // The one that spins rather than running slowly: it would execute forever
  // inside a single tick.
  const spinning = DefinitionSchema.parse({
    trigger: { type: 'manual' },
    start_node: 'a',
    nodes: [
      { key: 'a', type: 'add_tag', tag: 'x', next: 'b' },
      { key: 'b', type: 'add_tag', tag: 'y', next: 'a' },
    ],
  });
  const errors = validateDefinition(spinning).filter((i) => i.level === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /loop with no wait/);
});

test('a loop WITH a wait is allowed — that is a nurture sequence', () => {
  const cycling = DefinitionSchema.parse({
    trigger: { type: 'manual' },
    stop_conditions: [{ field: 'stage_category', op: 'eq', value: 'won', reason: 'Funded' }],
    start_node: 'a',
    nodes: [
      { key: 'a', type: 'send_email', subject: 'x', body: 'y', next: 'w' },
      { key: 'w', type: 'wait', days: 30, next: 'a' },
    ],
  });
  assert.deepEqual(validateDefinition(cycling).filter((i) => i.level === 'error'), []);
});

test('a send with nothing to send, and a subject-less email, are errors', () => {
  const empty = DefinitionSchema.parse({
    trigger: { type: 'manual' },
    start_node: 'a',
    nodes: [
      { key: 'a', type: 'send_email', next: 'b' },
      { key: 'b', type: 'send_sms', next: null },
    ],
  });
  const messages = validateDefinition(empty).filter((i) => i.level === 'error').map((i) => i.message);
  assert.ok(messages.some((m) => m.includes('"a" has nothing to send')));
  assert.ok(messages.some((m) => m.includes('"b" has nothing to send')));
});

test('no stop conditions is a warning that says what it costs', () => {
  const unstoppable = { ...base, stop_conditions: [] } as AutomationDefinition;
  const warning = validateDefinition(unstoppable).find((i) => i.level === 'warning');
  assert.ok(warning);
  assert.match(warning!.message, /even if the client funds, is lost/);
});

test('an unreachable step warns rather than blocking the publish', () => {
  const orphaned = {
    ...base,
    nodes: [...base.nodes, { key: 'orphan', type: 'stop' as const }],
  } as AutomationDefinition;
  const issues = validateDefinition(orphaned);
  assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
  assert.ok(issues.some((i) => i.level === 'warning' && i.message.includes('cannot be reached')));
});

test('a comparison against a missing value is false, never true', () => {
  // The rule that stops a client with no data being chased for not finishing
  // a form they never started.
  assert.equal(evaluateCondition({ field: 'percent_complete', op: 'lt', value: 100 }, {}), false);
  assert.equal(
    evaluateCondition({ field: 'percent_complete', op: 'lt', value: 100 }, { percent_complete: null }),
    false,
  );
  assert.equal(
    evaluateCondition({ field: 'percent_complete', op: 'lt', value: 100 }, { percent_complete: 'soon' }),
    false,
  );
  assert.equal(
    evaluateCondition({ field: 'percent_complete', op: 'lt', value: 100 }, { percent_complete: 42 }),
    true,
  );
});

test('the other operators behave', () => {
  const facts = { stage: 'lead', docs: 3, name: 'Sarah Johnson', empty: '' };
  assert.equal(evaluateCondition({ field: 'stage', op: 'eq', value: 'lead' }, facts), true);
  assert.equal(evaluateCondition({ field: 'stage', op: 'ne', value: 'lead' }, facts), false);
  assert.equal(evaluateCondition({ field: 'stage', op: 'in', value: ['lead', 'funded'] }, facts), true);
  assert.equal(evaluateCondition({ field: 'stage', op: 'not_in', value: ['lead'] }, facts), false);
  assert.equal(evaluateCondition({ field: 'docs', op: 'gte', value: 3 }, facts), true);
  assert.equal(evaluateCondition({ field: 'name', op: 'contains', value: 'johnson' }, facts), true);
  assert.equal(evaluateCondition({ field: 'docs', op: 'is_set' }, facts), true);
  assert.equal(evaluateCondition({ field: 'empty', op: 'is_empty' }, facts), true);
  assert.equal(evaluateCondition({ field: 'missing', op: 'is_empty' }, facts), true);
});

test('all versus any', () => {
  const conditions = [
    { field: 'a', op: 'eq' as const, value: 1 },
    { field: 'b', op: 'eq' as const, value: 2 },
  ];
  assert.equal(evaluateConditions(conditions, { a: 1, b: 2 }, 'all'), true);
  assert.equal(evaluateConditions(conditions, { a: 1, b: 9 }, 'all'), false);
  assert.equal(evaluateConditions(conditions, { a: 1, b: 9 }, 'any'), true);
  assert.equal(evaluateConditions([], {}, 'all'), true, 'no conditions means yes');
});

test('a stop condition names its own reason', () => {
  assert.equal(firstStopReason(base, { percent_complete: 40, stage_category: 'open' }), null);
  assert.equal(
    firstStopReason(base, { percent_complete: 100, stage_category: 'open' }),
    'The application was completed',
  );
  assert.equal(
    firstStopReason(base, { percent_complete: 40, stage_category: 'won' }),
    'The file was resolved',
  );
});

test('the branch decides where the enrollment goes next', () => {
  const branch = nodeByKey(base, 'check')!;
  assert.equal(nextKey(branch, { documents_outstanding: 2 }), 'chase');
  assert.equal(nextKey(branch, { documents_outstanding: 0 }), 'done');
  // Unknown is not "outstanding". A file we know nothing about is not chased.
  assert.equal(nextKey(branch, {}), 'done');
});

test('a stop node ends the sequence', () => {
  assert.equal(nextKey(nodeByKey(base, 'done')!, {}), null);
});

test('wait durations add up', () => {
  assert.equal(waitMs({ key: 'w', type: 'wait', minutes: 30, hours: 0, days: 0, business_hours_only: false }), 1_800_000);
  assert.equal(waitMs({ key: 'w', type: 'wait', minutes: 0, hours: 0, days: 1, business_hours_only: false }), 86_400_000);
  assert.equal(waitMs({ key: 'w', type: 'wait', minutes: 30, hours: 2, days: 1, business_hours_only: false }), 95_400_000);
});

test('a definition with a duplicate step key is refused', () => {
  const dupe = DefinitionSchema.parse({
    trigger: { type: 'manual' },
    start_node: 'a',
    nodes: [
      { key: 'a', type: 'stop' },
      { key: 'a', type: 'stop' },
    ],
  });
  assert.ok(validateDefinition(dupe).some((i) =>
    i.level === 'error' && i.message.includes('share the key')));
});
