/**
 * The Express application.
 *
 * Everything is mounted under BASE_PATH so the CRM can live at
 * https://lendmax.ca/crm behind the existing site without owning the domain or
 * touching what is already there. The prefix is configuration, not a constant,
 * because a path that is hard-coded in fifty places is a path that cannot move.
 */
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.ts';
import { log } from '../lib/logger.ts';
import { attachUser } from './middleware/auth.ts';
import { errorHandler } from './middleware/errors.ts';
import { authRoutes } from './routes/auth.ts';
import { customerRoutes } from './routes/customers.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { workRoutes } from './routes/work.ts';
import { systemRoutes } from './routes/system.ts';
import { internalRoutes } from './routes/internal.ts';
import { integrationRoutes } from './routes/integrations.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '../../web/public');

/**
 * Hashes of the inline scripts in index.html, written by scripts/build-web.mjs.
 *
 * Read at boot rather than hard-coded, so editing the theme bootstrap cannot
 * leave a policy that silently blocks it — which is exactly what happened once
 * and only showed up in a browser console.
 */
function inlineScriptHashes(): string[] {
  try {
    const raw = readFileSync(path.join(WEB_ROOT, 'csp-hashes.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: string[] };
    return (parsed.scripts ?? []).map((h) => `'${h}'`);
  } catch {
    // No build yet (or a stale one). The policy stays strict; the theme
    // bootstrap is then blocked and the app still works, one flash the worse.
    log.warn('no csp-hashes.json found — inline theme script will be blocked');
    return [];
  }
}

export function createApp(): Express {
  const app = express();

  // Behind nginx on the production box. Without this, req.ip is the proxy and
  // every rate limit and every audited IP is wrong in the same way.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The app bundle is a file. The one inline script we ship — the
          // theme bootstrap that runs before first paint — is allowed by its
          // SHA-256, written by the build. Not 'unsafe-inline': that would
          // permit every injected script as well as ours, which is the whole
          // thing the policy is for.
          scriptSrc: ["'self'", ...inlineScriptHashes()],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'same-origin' },
      hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  // One request log line, after the response, with the status and the duration.
  app.use((req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      const ms = Math.round(performance.now() - started);
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      log[level]('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
        userId: req.user?.id,
      });
    });
    next();
  });

  const base = env.BASE_PATH.replace(/\/$/, '');
  const api = express.Router();

  // A blunt ceiling on the API as a whole. Per-route limits that matter
  // (sign-in, sending) sit on those routes.
  api.use(
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: true,
      legacyHeaders: false,
      message: { ok: false, code: 'rate_limited', error: 'Too many requests. Slow down.' },
    }),
  );

  // Service-to-service, authenticated by shared secret rather than a session.
  // Mounted before attachUser because there is no user behind these calls.
  api.use('/internal', internalRoutes);

  api.use('/auth', authRoutes);
  api.use(attachUser);
  api.use('/', systemRoutes);
  api.use('/', dashboardRoutes);
  api.use('/', customerRoutes);
  api.use('/', workRoutes);
  api.use('/', integrationRoutes);

  api.use((_req, res) => {
    res.status(404).json({ ok: false, code: 'not_found', error: 'No such endpoint.' });
  });

  app.use(`${base}/api`, api);

  // The client. Hashed asset filenames are immutable and cached hard; index.html
  // never is, or a deploy leaves people on yesterday's bundle.
  app.use(
    `${base}/assets`,
    express.static(path.join(WEB_ROOT, 'assets'), {
      immutable: true,
      maxAge: '1y',
      fallthrough: true,
    }),
  );
  app.use(base || '/', express.static(WEB_ROOT, { index: false, maxAge: '1h' }));

  // Client-side routing: every non-API path under the base serves the shell.
  app.get(`${base}/*splat`, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(WEB_ROOT, 'index.html'));
  });
  if (base) {
    app.get(base, (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(WEB_ROOT, 'index.html'));
    });
    // Anything outside the base belongs to the existing lendmax.ca site, which
    // this process does not serve and must not claim.
    app.use((req, res) => {
      res.status(404).json({
        ok: false,
        code: 'not_found',
        error: `This service serves ${base} only. ${req.path} belongs elsewhere.`,
      });
    });
  }

  app.use(errorHandler);
  return app;
}
