/**
 * Passwords and sessions.
 *
 * scrypt from node:crypto rather than a native bcrypt binding: no compiler on
 * the deploy box, no ABI to break on a Node upgrade, and it is memory-hard,
 * which bcrypt at a default cost is not.
 *
 * Sessions are rows. The cookie holds a random token; the database holds only
 * its SHA-256. A database disclosure therefore does not hand over live
 * sessions, and a session can be revoked — which a self-contained signed token
 * cannot be.
 */
import { randomBytes, createHash, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../config/env.ts';
import { query, queryOne } from '../db/pool.ts';
import type { Role } from '../domain/permissions.ts';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: object,
) => Promise<Buffer>;

// N=2^15 is roughly 50ms on the target hardware: slow enough to make offline
// guessing expensive, fast enough that a broker signing in does not notice.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN, SCRYPT);
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // An account with no password still costs the same time to "check", so that
    // response timing does not tell an attacker which accounts exist.
    await scrypt(password, randomBytes(16), KEYLEN, SCRYPT);
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, salt, expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export type SessionUser = {
  id: string;
  organization_id: string;
  email: string;
  name: string;
  role: Role;
  permission_overrides: Record<string, boolean>;
  active: boolean;
  profile_complete: boolean;
  timezone: string | null;
};

export type CreatedSession = { token: string; sessionId: string; expiresAt: Date };

export async function createSession(
  userId: string,
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<CreatedSession> {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = new Date(now + env.SESSION_TTL_HOURS * 3_600_000);
  const absolute = new Date(now + env.SESSION_ABSOLUTE_TTL_HOURS * 3_600_000);

  const row = await queryOne<{ id: string }>(
    `INSERT INTO sessions (token_hash, user_id, expires_at, absolute_expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [hashToken(token), userId, expiresAt, absolute, context.ip ?? null, context.userAgent ?? null],
  );
  return { token, sessionId: row!.id, expiresAt };
}

/**
 * Resolve a cookie to a user, sliding the idle expiry forward.
 *
 * The ABSOLUTE expiry is not slid. An idle timeout on its own means a session
 * used once an hour lives forever, which is not a session policy.
 */
export async function resolveSession(
  token: string | undefined,
): Promise<{ user: SessionUser; sessionId: string } | null> {
  if (!token) return null;

  const row = await queryOne<SessionUser & { session_id: string }>(
    `SELECT s.id AS session_id, u.id, u.organization_id, u.email, u.name, u.role,
            u.permission_overrides, u.active, u.profile_complete, u.timezone
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.absolute_expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) return null;

  // A deactivated account's live sessions stop working immediately, rather than
  // lasting until their cookie happens to expire.
  if (!row.active) {
    await query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'account deactivated' WHERE id = $1`,
      [row.session_id],
    );
    return null;
  }

  await query(
    `UPDATE sessions
        SET last_seen_at = now(),
            expires_at = LEAST(now() + ($2 || ' hours')::interval, absolute_expires_at)
      WHERE id = $1`,
    [row.session_id, String(env.SESSION_TTL_HOURS)],
  );

  const { session_id, ...user } = row;
  return { user: user as SessionUser, sessionId: session_id };
}

export async function revokeSession(sessionId: string, reason = 'signed out'): Promise<void> {
  await query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
}

export async function revokeAllSessions(userId: string, reason: string): Promise<number> {
  const res = await query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return res.rowCount ?? 0;
}

// ── Sign-in throttling ─────────────────────────────────────────────────────
// Per account, not only per IP: an attacker with a botnet defeats an IP limit,
// and a per-account lockout is what protects the one account they are after.

export const MAX_FAILURES = 8;
export const LOCK_MINUTES = 15;

export type SignInResult =
  | { ok: true; user: SessionUser }
  | {
      ok: false;
      reason: 'invalid' | 'locked' | 'inactive' | 'not_activated';
      message: string;
      retryAfterMinutes?: number;
    };

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const user = await queryOne<
    SessionUser & {
      password_hash: string | null;
      locked_until: Date | null;
      failed_login_count: number;
      activated_at: Date | null;
    }
  >(
    `SELECT id, organization_id, email, name, role, permission_overrides, active,
            profile_complete, timezone, password_hash, locked_until, failed_login_count,
            activated_at
       FROM users WHERE lower(email) = lower($1) AND archived_at IS NULL`,
    [email],
  );

  // The same message, and comparable timing, whether the account exists or not.
  const invalid: SignInResult = {
    ok: false,
    reason: 'invalid',
    message: 'That email and password do not match an account.',
  };

  if (!user) {
    await verifyPassword(password, null);
    return invalid;
  }
  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    const minutes = Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000);
    return {
      ok: false,
      reason: 'locked',
      retryAfterMinutes: minutes,
      message: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    };
  }
  if (!user.active) {
    await verifyPassword(password, null);
    return {
      ok: false,
      reason: 'inactive',
      message: 'That account is not active. Ask a technical admin.',
    };
  }
  // Only a person who has proved they hold the mailbox — by using the link
  // sent to it — can sign in. An admin cannot create a working login for
  // somebody else's address.
  if (!user.activated_at) {
    await verifyPassword(password, null);
    return {
      ok: false,
      reason: 'not_activated',
      message: 'This account has not been activated yet. Use the link in your invitation email, or ask an admin to send a new one.',
    };
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const failures = user.failed_login_count + 1;
    const lock = failures >= MAX_FAILURES;
    await query(
      `UPDATE users
          SET failed_login_count = $2,
              locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval
                                  ELSE locked_until END
        WHERE id = $1`,
      [user.id, lock ? 0 : failures, lock, String(LOCK_MINUTES)],
    );
    return invalid;
  }

  await query(
    `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
      WHERE id = $1`,
    [user.id],
  );
  const { password_hash, locked_until, failed_login_count, activated_at, ...clean } = user;
  return { ok: true, user: clean as SessionUser };
}

/** Housekeeping: long-expired sessions are deleted rather than kept forever. */
export async function purgeExpiredSessions(): Promise<number> {
  const res = await query(
    `DELETE FROM sessions WHERE absolute_expires_at < now() - interval '30 days'`,
  );
  return res.rowCount ?? 0;
}
