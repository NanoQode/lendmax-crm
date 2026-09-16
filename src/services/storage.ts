/**
 * Document storage.
 *
 * Two drivers: local disk and S3-compatible. Whichever is in use, three rules
 * hold and are the reason this is a module rather than a few `fs` calls:
 *
 *   NOTHING IS PUBLICLY READABLE. There is no permanent URL for a document
 *   anywhere in this system. Access is a short-lived signed grant, and every
 *   grant is recorded — "who looked at this client's bank statements" has to
 *   have an answer.
 *
 *   THE STORED NAME IS NOT THE DISPLAY NAME. Uploads are stored under a
 *   generated key. A filename from a browser is attacker-controlled input, and
 *   `../../etc/passwd` is a filename.
 *
 *   AN UNSCANNED FILE IS NOT A CLEAN FILE. `scan_status` starts `pending` and
 *   a download is refused until it is `clean` or explicitly `skipped` — where
 *   skipped is a visible state for a deployment with no scanner, not a quiet
 *   default that reads as safe.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { env } from '../config/env.ts';
import { log } from '../lib/logger.ts';

export type StoredObject = {
  driver: 'local' | 's3';
  key: string;
  bytes: number;
  sha256: string;
};

// What is accepted is a pure rule, kept in the domain layer so the required-
// documents module can be tested against it without a database.
import { MAX_BYTES } from '../domain/uploads.ts';
export { checkUpload, MAX_BYTES, type UploadCheck } from '../domain/uploads.ts';

/**
 * A storage key the caller does not choose.
 *
 * Sharded by date so a directory never holds a hundred thousand entries, and
 * random rather than derived from anything — a key that can be guessed from a
 * client's name is a key that can be enumerated.
 */
function generateKey(extension: string): string {
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${yyyymm}/${randomUUID()}${extension}`;
}

function localRoot(): string {
  return path.resolve(env.STORAGE_LOCAL_DIR);
}

/** Resolve a key under the storage root, refusing anything that escapes it. */
function localPathFor(key: string): string {
  const root = localRoot();
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('That storage key points outside the storage directory.');
  }
  return resolved;
}

export async function putObject(
  source: Readable,
  options: { filename: string; mimeType: string },
): Promise<StoredObject> {
  const extension = path.extname(options.filename).toLowerCase() || '.bin';
  const key = generateKey(extension);

  if (env.STORAGE_DRIVER === 's3') {
    // Intentionally not implemented rather than half-implemented: an S3 path
    // that silently no-ops would lose documents. The driver is selectable so
    // this is the one function to write when a bucket exists.
    throw new Error(
      'The S3 storage driver is selected but not implemented. Use STORAGE_DRIVER=local, ' +
        'or implement putObject/getObject for S3 before switching.',
    );
  }

  const destination = localPathFor(key);
  await mkdir(path.dirname(destination), { recursive: true });

  const hash = createHash('sha256');
  let bytes = 0;
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    hash.update(chunk);
  });

  await pipeline(source, createWriteStream(destination, { mode: 0o600 }));

  if (bytes > MAX_BYTES) {
    // The limit is enforced again here: a multipart parser can be told a size
    // and be lied to, and the only number that is true is the one counted.
    await rm(destination, { force: true });
    throw new Error(`That file exceeded the ${MAX_BYTES / 1024 / 1024} MB limit.`);
  }

  return { driver: 'local', key, bytes, sha256: hash.digest('hex') };
}

export function getObjectStream(key: string): Readable {
  if (env.STORAGE_DRIVER === 's3') throw new Error('The S3 storage driver is not implemented.');
  return createReadStream(localPathFor(key));
}

export async function objectExists(key: string): Promise<boolean> {
  if (env.STORAGE_DRIVER === 's3') return false;
  try {
    const info = await stat(localPathFor(key));
    return info.isFile();
  } catch {
    return false;
  }
}

export async function deleteObject(key: string): Promise<void> {
  if (env.STORAGE_DRIVER === 's3') throw new Error('The S3 storage driver is not implemented.');
  await rm(localPathFor(key), { force: true });
}

// ── Signed access ──────────────────────────────────────────────────────────

/**
 * A short-lived grant to read one document.
 *
 * HMAC over the document id, the user and an expiry. Nothing about the file
 * is encoded in the URL beyond its id, the grant cannot be extended by editing
 * it, and it stops working on its own.
 *
 * The user is part of the signature deliberately: a link forwarded to a
 * colleague does not work for them, so a document cannot leave the system by
 * being pasted into a chat.
 */
export function signDownload(documentId: string, userId: string, ttlSeconds?: number): string {
  const expires = Math.floor(Date.now() / 1000) + (ttlSeconds ?? env.DOCUMENT_URL_TTL_SECONDS);
  const payload = `${documentId}.${userId}.${expires}`;
  const signature = createHmac('sha256', env.SESSION_SECRET).update(payload).digest('base64url');
  return `${expires}.${signature}`;
}

export function verifyDownload(documentId: string, userId: string, token: string): boolean {
  const [expiresRaw, signature] = token.split('.');
  if (!expiresRaw || !signature) return false;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;

  const expected = createHmac('sha256', env.SESSION_SECRET)
    .update(`${documentId}.${userId}.${expires}`)
    .digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Virus scanning.
 *
 * Not implemented, and that is recorded rather than assumed: the status is set
 * to `skipped`, which is a visible state on the document row and on screen. A
 * deployment that has a scanner replaces this function; one that does not can
 * see that it does not, which is the whole point.
 */
export async function scanObject(key: string): Promise<{
  status: 'clean' | 'infected' | 'failed' | 'skipped'; detail?: string;
}> {
  log.debug('no virus scanner configured', { key });
  return {
    status: 'skipped',
    detail: 'No virus scanner is configured on this deployment.',
  };
}
