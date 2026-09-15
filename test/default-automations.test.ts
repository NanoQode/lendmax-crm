/**
 * The shipped sequences have to survive the same publish check as one a user
 * drew in the builder. A default that cannot be published is worse than no
 * default: it looks like a working starting point until somebody tries it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AUTOMATIONS } from '../src/domain/default-automations.ts';
import { DefinitionSchema, validateDefinition } from '../src/domain/automation.ts';
import { MERGE_FIELD_NAMES } from '../src/domain/merge-fields.ts';
import {
  CALCULATORS_BY_TRANSACTION, calculatorFor, findCalculator,
} from '../src/domain/calculators.ts';

/** Mirrors TRANSACTION_TYPES in scripts/seed.ts. */
const SEEDED_TRANSACTION_TYPES = new Set([
  'purchase', 'first_time_buyer', 'renewal', 'refinance', 'switch_transfer',
  'equity_takeout', 'debt_consolidation', 'heloc', 'second_mortgage',
  'rental_investment', 'private', 'construction', 'other',
]);

test('every default automation parses and passes the publish check', () => {
  for (const auto of DEFAULT_AUTOMATIONS) {
    const parsed = DefinitionSchema.safeParse(auto.definition);
    assert.ok(parsed.success, `${auto.key} does not parse: ${JSON.stringify(parsed.error?.issues)}`);

    const issues = validateDefinition(parsed.data);
    const errors = issues.filter((i) => i.level === 'error');
    assert.deepEqual(errors, [], `${auto.key} cannot be published: ${JSON.stringify(errors)}`);
  }
});

test('every merge field used by a default is on the registry', () => {
  // A template referencing a field that does not exist loses the whole line
  // silently. Catching it here is the difference between a missing sentence in
  // a client's inbox and a failing test.
  for (const auto of DEFAULT_AUTOMATIONS) {
    const text = JSON.stringify(auto.definition);
    for (const [, name] of text.matchAll(/\{([a-z0-9_]+)\}/gi)) {
      assert.ok(
        MERGE_FIELD_NAMES.has(name),
        `${auto.key} uses {${name}}, which is not a merge field`,
      );
    }
  }
});

test('every client-facing sequence can stop', () => {
  for (const auto of DEFAULT_AUTOMATIONS) {
    assert.ok(
      auto.definition.stop_conditions.length > 0,
      `${auto.key} has no stop conditions — it would keep running past the reason for it`,
    );
    const stops = auto.definition.nodes.filter((n) => n.type === 'stop');
    assert.ok(stops.length > 0, `${auto.key} has no stop node`);
  }
});

test('no sequence runs past six client touches', () => {
  // ~93% of leads that ever convert are reached within six attempts
  // (MIT/InsideSales). Past that it is noise that earns unsubscribes.
  for (const auto of DEFAULT_AUTOMATIONS) {
    const sends = auto.definition.nodes.filter(
      (n) => n.type === 'send_email' || n.type === 'send_sms',
    );
    assert.ok(
      sends.length <= 6,
      `${auto.key} sends ${sends.length} messages; the researched ceiling is six`,
    );
  }
});

test('the voice rotates — the third and sixth touch are the underwriting desk', () => {
  const seq = DEFAULT_AUTOMATIONS.find((a) => a.key === 'incomplete_application');
  assert.ok(seq);
  const sends = seq.definition.nodes.filter((n) => n.type === 'send_email');
  const signedBy = (i: number) => String((sends[i] as { body?: string }).body ?? '');

  assert.match(signedBy(2), /The Underwriting Team/, 'third touch is the desk');
  assert.match(signedBy(5), /The Underwriting Team/, 'sixth touch is the desk');
  assert.match(signedBy(0), /\{user_first_name\}/, 'first touch is the broker');
  assert.doesNotMatch(signedBy(0), /The Underwriting Team/);
});

test('every seeded transaction type maps to a calculator that exists', () => {
  // The mapping is keyed on the transaction_type key as seeded. When those two
  // drift, nothing breaks loudly — every file just quietly falls back to the
  // generic payment calculator, which is the least useful one on the list.
  for (const key of Object.keys(CALCULATORS_BY_TRANSACTION)) {
    assert.ok(
      SEEDED_TRANSACTION_TYPES.has(key),
      `${key} is mapped to a calculator but is not a seeded transaction type`,
    );
  }
  for (const key of SEEDED_TRANSACTION_TYPES) {
    assert.ok(
      CALCULATORS_BY_TRANSACTION[key]?.length,
      `transaction type ${key} has no calculator mapping, so it falls back to the generic one`,
    );
    for (const slug of CALCULATORS_BY_TRANSACTION[key]!) {
      assert.ok(findCalculator(slug), `${key} maps to unknown calculator ${slug}`);
    }
  }
});

test('calculatorFor never throws and always returns a real calculator', () => {
  for (const key of [...SEEDED_TRANSACTION_TYPES, 'nonsense', '', null, undefined]) {
    const c = calculatorFor(key as string);
    assert.ok(findCalculator(c.slug), `${key} produced an unknown calculator`);
  }
});
