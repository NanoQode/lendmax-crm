import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/lib/canonical-json.ts';

test('canonicalJson is stable under key reordering', () => {
  // The bug this guards against, exactly: before_json and after_json are
  // stored as jsonb, which reorders keys. JSON.stringify at write time and
  // JSON.stringify of the row read back are then different strings for the
  // same data, and the audit chain reports tampering on every entry that
  // carries a payload with more than one key.
  const written = { stage_key: 'nurture', forced: false, overridden: [] };
  const readBackFromJsonb = { forced: false, overridden: [], stage_key: 'nurture' };
  assert.notEqual(JSON.stringify(written), JSON.stringify(readBackFromJsonb),
    'the naive form really does differ — this is the trap');
  assert.equal(canonicalJson(written), canonicalJson(readBackFromJsonb));
});

test('canonicalJson sorts at every depth', () => {
  const a = { b: { z: 1, a: 2 }, a: [{ y: 1, x: 2 }] };
  const b = { a: [{ x: 2, y: 1 }], b: { a: 2, z: 1 } };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":[{"x":2,"y":1}],"b":{"a":2,"z":1}}');
});

test('canonicalJson preserves array order, which is data', () => {
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
  assert.equal(canonicalJson([1, 2, 3]), '[1,2,3]');
});

test('canonicalJson handles the edges without throwing', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson({}), '{}');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson('text'), '"text"');
  assert.equal(canonicalJson(42), '42');
  assert.equal(canonicalJson(false), 'false');
  // undefined members are dropped, matching what JSON storage does to them,
  // so a key that was never really stored cannot change the digest.
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test('canonicalJson distinguishes values that must not collide', () => {
  // A digest that cannot tell these apart is a digest that lets an edit through.
  assert.notEqual(canonicalJson({ a: '1' }), canonicalJson({ a: 1 }));
  assert.notEqual(canonicalJson({ ab: 1 }), canonicalJson({ a: 'b1' }));
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({}));
});
