/**
 * Authentication and authorisation middleware.
 *
 * The rule this file exists to make unavoidable: every route asserts its own
 * permission. The UI hides what you cannot do as a courtesy; a hidden button is
 * not a permission, and a route that trusts the client to have hidden it is the
 * route that gets called directly.
 */
import type { NextFunction, Request, Response } from 'express';
import { resolveSession, type SessionUser } from '../../services/auth.ts';
import { can, denialMessage, permissionsFor, type Permission } from '../../domain/permissions.ts';

export const SESSION_COOKIE = 'lmx_crm_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      sessionId?: string;
    }
  }
}

/**
 * Attaches `req.user` when a valid session cookie is present. Never rejects —
 * that is `requireAuth`'s job, so that a route can be readable by both signed-in
 * and anonymous callers where that is genuinely intended (the health endpoint,
 * the client document-upload link).
 */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const resolved = await resolveSession(token);
    if (resolved) {
      req.user = resolved.user;
      req.sessionId = resolved.sessionId;
    }
  } catch {
    // A session lookup failure is an anonymous request, not a 500. The route
    // that needs a user will say so.
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ ok: false, error: 'Sign in to continue.', code: 'unauthenticated' });
    return;
  }
  next();
}

/**
 * A user who has not completed their first-login profile has no signature, and
 * nothing is sent to a client from an account without one. They may read the
 * CRM; they may not send.
 */
export function requireCompleteProfile(req: Request, res: Response, next: NextFunction): void {
  if (req.user && !req.user.profile_complete) {
    res.status(403).json({
      ok: false,
      code: 'profile_incomplete',
      error:
        'Complete your profile before sending anything to a client — your signature is built from it.',
    });
    return;
  }
  next();
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ ok: false, error: 'Sign in to continue.', code: 'unauthenticated' });
      return;
    }
    if (!can(req.user, permission)) {
      res.status(403).json({
        ok: false,
        code: 'forbidden',
        permission,
        error: denialMessage(req.user, permission),
      });
      return;
    }
    next();
  };
}

/** The permission set the client uses to decide what to render. */
export function permissionsOf(user: SessionUser): string[] {
  return [...permissionsFor(user)];
}
