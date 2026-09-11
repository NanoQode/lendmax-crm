import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  decryptSecrets, encryptSecrets, mergeSecrets, previewOf, safeEqual, SecretsUnavailable,
} from '../src/lib/secrets.ts';

const KEY = randomBytes(32);
const OTHER = randomBytes(32);

test('a secret round-trips', () => {
  const value = { api_key: 'sk-live-abcdef123456', api_password: 'hunter2-but-longer' };
  assert.deepEqual(decryptSecrets(encryptSecrets(value, KEY), KEY), value);
});

test('the same plaintext encrypts differently every time', () => {
  // A deterministic ciphertext would let anybody with read access tell that two
  // integrations share a password without decrypting either.
  const a = encryptSecrets({ k: 'same' }, KEY);
  const b = encryptSecrets({ k: 'same' }, KEY);
  assert.notEqual(a.toString('base64'), b.toString('base64'));
  assert.deepEqual(decryptSecrets(a, KEY), decryptSecrets(b, KEY));
});

test('the wrong key fails loudly rather than returning nothing', () => {
  // Returning {} here would look exactly like "not configured" and send
  // somebody to re-enter credentials that are in fact still there.
  const blob = encryptSecrets({ api_key: 'secret' }, KEY);
  assert.throws(() => decryptSecrets(blob, OTHER), SecretsUnavailable);
  assert.throws(() => decryptSecrets(blob, OTHER), /CREDENTIALS_KEY has changed/);
});

test('a tampered ciphertext is rejected, not silently different', () => {
  const blob = encryptSecrets({ api_key: 'secret-value-here' }, KEY);
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decryptSecrets(tampered, KEY), SecretsUnavailable);
});

test('an empty or truncated blob is handled, not crashed on', () => {
  assert.deepEqual(decryptSecrets(null, KEY), {});
  assert.deepEqual(decryptSecrets(Buffer.alloc(0), KEY), {});
  assert.throws(() => decryptSecrets(Buffer.alloc(8), KEY), /truncated or corrupt/);
});

test('a preview reveals whether a secret is set, and no more', () => {
  const preview = previewOf({ api_key: 'sk-live-abcdef8f2c', short: 'abc', empty: '' });
  assert.deepEqual(preview.api_key, { set: true, last4: '8f2c' });
  // A short secret reveals proportionally more of itself, so it reveals none.
  assert.deepEqual(preview.short, { set: true, last4: '' });
  assert.deepEqual(preview.empty, { set: false, last4: '' });
  assert.equal(JSON.stringify(preview).includes('sk-live-abcdef'), false);
});

test('a blank submission keeps the stored secret', () => {
  // The form renders secret fields empty so the browser never holds the real
  // value. An empty field therefore has to mean "leave alone" — treating it as
  // "clear" would wipe credentials every time somebody edited the DID.
  const stored = { api_key: 'keep-me', api_password: 'keep-me-too' };
  assert.deepEqual(
    mergeSecrets(stored, { api_key: '', api_password: undefined }),
    stored,
  );
});

test('a submitted value replaces, and __clear__ removes', () => {
  const stored = { api_key: 'old', other: 'stays' };
  assert.deepEqual(mergeSecrets(stored, { api_key: 'new' }), { api_key: 'new', other: 'stays' });
  assert.deepEqual(mergeSecrets(stored, { api_key: '__clear__' }), { other: 'stays' });
});

test('safeEqual compares without leaking length through a throw', () => {
  assert.equal(safeEqual('abc123', 'abc123'), true);
  assert.equal(safeEqual('abc123', 'abc124'), false);
  assert.equal(safeEqual('short', 'much-longer-string'), false, 'must not throw');
  assert.equal(safeEqual('', ''), false, 'an empty shared secret never matches');
  assert.equal(safeEqual(undefined, 'x'), false);
  assert.equal(safeEqual('x', null), false);
});
