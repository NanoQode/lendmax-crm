/**
 * Encryption for credentials held in the database.
 *
 * AES-256-GCM, keyed by CREDENTIALS_KEY from the environment. GCM authenticates
 * as well as encrypts, so a tampered row fails to decrypt rather than quietly
 * yielding different bytes — which for a set of API credentials is the
 * difference between a loud failure and calling somebody else's API.
 *
 * THE KEY STAYS IN THE ENVIRONMENT. Putting the key that protects the
 * credentials into the same database as the credentials protects nothing at
 * all; it just moves the problem somewhere it is harder to see.
 *
 * Format: a single buffer of [12-byte IV][16-byte auth tag][ciphertext]. One
 * column, no separate IV field to forget to migrate, and self-describing
 * enough that a future key rotation can read the old shape.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class SecretsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsUnavailable';
  }
}

let cachedKey: Buffer | null = null;

/**
 * The key, validated once.
 *
 * In development a missing key is generated per boot and the process says so:
 * credentials entered locally do not survive a restart, which is correct —
 * the alternative is a well-known default key, and well-known default keys
 * reach production.
 */
export function credentialsKey(
  raw: string | undefined = process.env.CREDENTIALS_KEY,
  isProduction = process.env.NODE_ENV === 'production',
): Buffer {
  if (cachedKey) return cachedKey;

  if (!raw || !raw.trim()) {
    if (isProduction) {
      throw new SecretsUnavailable(
        'CREDENTIALS_KEY is required in production. Generate one with: openssl rand -base64 32',
      );
    }
    cachedKey = randomBytes(KEY_BYTES);
    return cachedKey;
  }

  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new SecretsUnavailable(
      `CREDENTIALS_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  cachedKey = key;
  return cachedKey;
}

/** For tests, which need a fresh key per case. */
export function resetKeyCache(): void {
  cachedKey = null;
}

export function encryptSecrets(value: Record<string, string>, key = credentialsKey()): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecrets(
  blob: Buffer | null | undefined,
  key = credentialsKey(),
): Record<string, string> {
  if (!blob || blob.length === 0) return {};
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new SecretsUnavailable('Stored credentials are truncated or corrupt.');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as Record<string, string>;
  } catch {
    // Authentication failed: either the key changed or the row was altered.
    // Both mean "do not use these", and both need a person, so they get one
    // message rather than an empty object that looks like "not configured".
    throw new SecretsUnavailable(
      'Stored credentials could not be decrypted. Either CREDENTIALS_KEY has changed since they ' +
        'were saved, or the row has been altered. Re-enter them under Settings → Integrations.',
    );
  }
}

/**
 * What the screen is allowed to see: which secrets are set, and the last four
 * characters of each.
 *
 * Never the value. "API key ending 8f2c, set on 4 March" is enough for a person
 * to confirm they pasted the right one; the whole string is not needed to
 * render a page and so is never sent to one.
 */
export function previewOf(secrets: Record<string, string>): Record<string, { set: boolean; last4: string }> {
  const out: Record<string, { set: boolean; last4: string }> = {};
  for (const [name, value] of Object.entries(secrets)) {
    const trimmed = String(value ?? '');
    out[name] = {
      set: trimmed.length > 0,
      // Short secrets reveal proportionally more, so they reveal nothing.
      last4: trimmed.length >= 8 ? trimmed.slice(-4) : '',
    };
  }
  return out;
}

/**
 * Merge submitted values over stored ones, treating a blank as "leave alone".
 *
 * This is what lets the form round-trip without the browser ever holding the
 * real credentials: the field renders empty, and an empty field means "keep
 * what is there" rather than "clear it". Clearing is an explicit action
 * (`__clear__`), because a blanked field is far more often a user who did not
 * intend to change it.
 */
export function mergeSecrets(
  existing: Record<string, string>,
  submitted: Record<string, string | undefined>,
): Record<string, string> {
  const out = { ...existing };
  for (const [name, value] of Object.entries(submitted)) {
    if (value === undefined || value === '') continue;
    if (value === '__clear__') {
      delete out[name];
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Constant-time comparison for shared secrets arriving over the wire. */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Lengths differing is itself a mismatch, and comparing different-length
  // buffers throws — so it is answered first, without branching on content.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
