/**
 * Sign in, sign out, who am I, and the first-login profile.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { query, queryOne, withTransaction } from '../../db/pool.ts';
import {
  createSession, hashPassword, revokeAllSessions, revokeSession, signIn, verifyPassword,
  MIN_PASSWORD_LENGTH,
} from '../../services/auth.ts';
import { recordAudit, recordAuditSafely } from '../../services/audit.ts';
import { ROLES } from '../../domain/permissions.ts';
import { AppError, asyncRoute } from '../middleware/errors.ts';
import { attachUser, permissionsOf, requireAuth, SESSION_COOKIE } from '../middleware/auth.ts';
import { toE164 } from '../../lib/phone.ts';

export const authRoutes: Router = Router();

/**
 * Sign-in is rate limited per IP as a blunt first line; the per-account lockout
 * in services/auth.ts is the one that actually protects a targeted account,
 * since an attacker with many IPs walks straight through this.
 */
const signInLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, code: 'rate_limited', error: 'Too many sign-in attempts. Wait a few minutes.' },
});

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.isProduction,
  path: env.BASE_PATH || '/',
};

authRoutes.post(
  '/login',
  signInLimiter,
  asyncRoute(async (req, res) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .parse(req.body);

    const result = await signIn(body.email, body.password);
    if (!result.ok) {
      // Failures are audited too. A burst of them against one account is the
      // signal, and it is invisible if only successes are recorded.
      recordAuditSafely({
        organizationId: '00000000-0000-0000-0000-000000000000',
        actor: { kind: 'user', name: body.email, ip: req.ip },
        action: 'auth.sign_in_failed',
        entityType: 'user',
        summary: `Failed sign-in for ${body.email} (${result.reason})`,
      });
      res.status(result.reason === 'locked' ? 429 : 401).json({
        ok: false, code: result.reason, error: result.message,
        retryAfterMinutes: result.reason === 'locked' ? result.retryAfterMinutes : undefined,
      });
      return;
    }

    const session = await createSession(result.user.id, {
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    res.cookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });

    await recordAudit({
      organizationId: result.user.organization_id,
      actor: {
        userId: result.user.id, name: result.user.name, role: result.user.role,
        ip: req.ip, sessionId: session.sessionId,
      },
      action: 'auth.sign_in',
      entityType: 'user',
      entityId: result.user.id,
      summary: `${result.user.name} signed in`,
    });

    res.json({
      ok: true,
      user: publicUser(result.user),
      permissions: permissionsOf(result.user),
    });
  }),
);

authRoutes.post(
  '/logout',
  attachUser,
  asyncRoute(async (req, res) => {
    if (req.sessionId) await revokeSession(req.sessionId);
    if (req.user) {
      recordAuditSafely({
        organizationId: req.user.organization_id,
        actor: { userId: req.user.id, name: req.user.name, role: req.user.role, ip: req.ip },
        action: 'auth.sign_out',
        entityType: 'user',
        entityId: req.user.id,
        summary: `${req.user.name} signed out`,
      });
    }
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.json({ ok: true });
  }),
);

/** The session bootstrap the client calls on load. */
authRoutes.get(
  '/me',
  attachUser,
  asyncRoute(async (req, res) => {
    if (!req.user) {
      res.status(401).json({ ok: false, code: 'unauthenticated', error: 'Not signed in.' });
      return;
    }
    const profile = await queryOne(
      `SELECT display_name, title, licence_number, licence_province, mobile_phone,
              direct_phone, office_phone, booking_url, photo_url, signature_html, signature_text
         FROM user_profiles WHERE user_id = $1`,
      [req.user.id],
    );
    const org = await queryOne(
      `SELECT id, name, home_province, timezone, logo_url FROM organizations WHERE id = $1`,
      [req.user.organization_id],
    );
    res.json({
      ok: true,
      user: publicUser(req.user),
      profile,
      organization: org,
      permissions: permissionsOf(req.user),
      roleName: ROLES[req.user.role]?.name ?? req.user.role,
    });
  }),
);

/**
 * The first-login profile. This is what produces the signature, which is why
 * `profile_complete` gates sending rather than gating access — a broker can
 * read the CRM before they have filled it in, and cannot email a client.
 */
const ProfileInput = z.object({
  name: z.string().min(1, 'Your name is required.'),
  display_name: z.string().optional(),
  title: z.string().optional(),
  licence_number: z.string().optional(),
  licence_province: z.string().length(2).optional().or(z.literal('')),
  mobile_phone: z.string().optional(),
  direct_phone: z.string().optional(),
  office_phone: z.string().optional(),
  booking_url: z.string().url('Booking link must be a full URL.').optional().or(z.literal('')),
  timezone: z.string().optional(),
});

authRoutes.put(
  '/profile',
  attachUser,
  requireAuth,
  asyncRoute(async (req, res) => {
    const input = ProfileInput.parse(req.body);
    const user = req.user!;

    // Numbers are normalised here so the signature and any click-to-call read
    // the same string the rest of the system stores.
    const mobile = input.mobile_phone ? toE164(input.mobile_phone) : null;
    if (input.mobile_phone && !mobile) {
      throw new AppError('That mobile number is not a valid Canadian number.', 422, 'validation_failed');
    }

    const before = await queryOne(
      `SELECT display_name, title, mobile_phone FROM user_profiles WHERE user_id = $1`,
      [user.id],
    );

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE users SET name = $2, timezone = COALESCE(NULLIF($3,''), timezone),
                          profile_complete = true
          WHERE id = $1`,
        [user.id, input.name, input.timezone ?? ''],
      );
      await client.query(
        `INSERT INTO user_profiles (user_id, display_name, title, licence_number, licence_province,
                                    mobile_phone, direct_phone, office_phone, booking_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id) DO UPDATE SET
           display_name = EXCLUDED.display_name, title = EXCLUDED.title,
           licence_number = EXCLUDED.licence_number, licence_province = EXCLUDED.licence_province,
           mobile_phone = EXCLUDED.mobile_phone, direct_phone = EXCLUDED.direct_phone,
           office_phone = EXCLUDED.office_phone, booking_url = EXCLUDED.booking_url`,
        [
          user.id, input.display_name || input.name, input.title ?? null,
          input.licence_number ?? null, input.licence_province || null,
          mobile, input.direct_phone ? toE164(input.direct_phone) : null,
          input.office_phone ? toE164(input.office_phone) : null,
          input.booking_url || null,
        ],
      );
      await recordAudit(
        {
          organizationId: user.organization_id,
          actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
          action: 'user.profile_updated',
          entityType: 'user',
          entityId: user.id,
          summary: `${input.name} updated their profile`,
          before,
          after: { display_name: input.display_name, title: input.title, mobile_phone: mobile },
        },
        client,
      );
    });

    res.json({ ok: true });
  }),
);

authRoutes.post(
  '/password',
  attachUser,
  requireAuth,
  asyncRoute(async (req, res) => {
    const input = z
      .object({
        current_password: z.string().min(1),
        new_password: z.string().min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters.`),
      })
      .parse(req.body);

    const user = req.user!;
    const row = await queryOne<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    if (!(await verifyPassword(input.current_password, row?.password_hash ?? null))) {
      throw new AppError('Your current password is not correct.', 403, 'invalid_password');
    }

    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      user.id, await hashPassword(input.new_password),
    ]);

    // Every other session is ended. A password change is usually a response to
    // a suspicion, and leaving the other sessions alive answers nothing.
    const revoked = await revokeAllSessions(user.id, 'password changed');
    const session = await createSession(user.id, { ip: req.ip, userAgent: req.get('user-agent') });
    res.cookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'user.password_changed',
      entityType: 'user',
      entityId: user.id,
      summary: `${user.name} changed their password; ${revoked} other session(s) ended`,
    });

    res.json({ ok: true, otherSessionsEnded: Math.max(0, revoked - 1) });
  }),
);

function publicUser(u: {
  id: string; name: string; email: string; role: string;
  organization_id: string; profile_complete: boolean; timezone: string | null;
}) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    role_name: ROLES[u.role as keyof typeof ROLES]?.name ?? u.role,
    organization_id: u.organization_id,
    profile_complete: u.profile_complete,
    timezone: u.timezone,
  };
}
