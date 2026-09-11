/**
 * The internal API — what other Lendmax services call.
 *
 * Not behind a user session: these are service-to-service calls authenticated
 * with a shared secret, compared in constant time. They return applicant data,
 * so in production they should be firewalled or bound to localhost as well.
 */
import { Router } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { queryOne } from '../../db/pool.ts';
import { log } from '../../lib/logger.ts';
import { safeEqual } from '../../lib/secrets.ts';
import { resolveIntegration } from '../../services/integrations.ts';
import {
  importMirrorPayload, logMirrorFailure, type MirrorPayload,
} from '../../services/portal-import.ts';
import { asyncRoute } from '../middleware/errors.ts';

export const internalRoutes: Router = Router();

/**
 * Generous, because the portal legitimately pushes on every save across every
 * application it holds, plus a reconciliation sweep every thirty seconds. A
 * limit tuned for a browser would throttle a busy morning's intake.
 */
const internalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many internal requests.' },
});

/** The single organization this deployment serves. */
async function currentOrganizationId(): Promise<string | null> {
  const row = await queryOne<{ id: string }>('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
  return row?.id ?? null;
}

/**
 * The mirror endpoint.
 *
 * Deliberately the same shape as the one already running on lendmax.ca, so the
 * portal can be pointed here by changing one environment variable and nothing
 * on that side needs to be touched:
 *
 *   POST /api/internal/mirror
 *   x-internal-key: <shared secret>
 *   → 200 { ok: true, created, changed, id }
 *   → 400 { ok: false, error }   payload not usable
 *   → 401 { ok: false, error }   wrong key
 *   → 500 { ok: false, error }   our fault; the portal will retry
 *
 * The status codes matter to the caller's retry logic: the portal backs off and
 * re-sends on a non-2xx, so a 400 for a payload that will never be valid stops
 * it retrying forever, and a 500 for a transient fault keeps it trying.
 */
internalRoutes.post(
  '/mirror',
  internalLimiter,
  express.json({ limit: '4mb' }),
  asyncRoute(async (req, res) => {
    const started = performance.now();
    const organizationId = await currentOrganizationId();
    if (!organizationId) {
      res.status(503).json({ ok: false, error: 'The CRM has no organization configured yet.' });
      return;
    }

    const integration = await resolveIntegration(organizationId, 'portal');
    const expected = String(integration.values.webhook_secret ?? '');
    const presented = req.get('x-internal-key');

    if (!expected) {
      // Refusing is the safe default. An endpoint that accepts anything
      // because nobody configured a key is an open door to applicant data.
      log.error('mirror push refused: no inbound key configured');
      res.status(503).json({
        ok: false,
        error: 'No inbound mirror key is configured on the CRM. Set one under Settings → Integrations.',
      });
      return;
    }
    if (!safeEqual(presented, expected)) {
      log.warn('mirror push rejected: bad key', { ip: req.ip });
      res.status(401).json({ ok: false, error: 'Not authorised.' });
      return;
    }

    const payload = (req.body ?? {}) as MirrorPayload;
    const reference = typeof payload.reference === 'string' ? payload.reference.trim() : '';
    if (!reference) {
      await logMirrorFailure(organizationId, '', 'rejected', 'No reference on the payload.');
      res.status(400).json({ ok: false, error: 'A mirrored application needs a reference.' });
      return;
    }

    try {
      const result = await importMirrorPayload(payload, { organizationId });
      const ms = Math.round(performance.now() - started);
      if (result.changed) {
        log.info('mirror accepted', {
          reference, created: result.created,
          changed: Object.keys(result.changedFields), ms,
        });
      }
      if (result.duplicates) {
        log.warn('possible duplicate customer flagged for review', {
          reference, duplicates: result.duplicates,
        });
      }
      res.json({
        ok: true,
        created: result.created,
        changed: result.changed,
        id: result.id,
        // Extra, ignored by the portal, useful when testing by hand.
        unchanged: Boolean(result.unchanged),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('mirror import failed', { reference, error: err });
      await logMirrorFailure(organizationId, reference, 'failed', message);
      // 500 on purpose: the portal retries with backoff, and a transient fault
      // here must not silently lose an application.
      res.status(500).json({ ok: false, error: 'Could not store the mirrored application.' });
    }
  }),
);

/**
 * The portal asks whether the CRM is up before it starts a sweep. Cheap, and it
 * confirms the key as well as the process, which is what the operator actually
 * wants to know.
 */
internalRoutes.get(
  '/ping',
  internalLimiter,
  asyncRoute(async (req, res) => {
    const organizationId = await currentOrganizationId();
    if (!organizationId) {
      res.status(503).json({ ok: false, error: 'No organization configured.' });
      return;
    }
    const integration = await resolveIntegration(organizationId, 'portal');
    const expected = String(integration.values.webhook_secret ?? '');
    if (!expected || !safeEqual(req.get('x-internal-key'), expected)) {
      res.status(401).json({ ok: false, error: 'Not authorised.' });
      return;
    }
    res.json({ ok: true, service: 'lendmax-crm', accepts: 'mirror' });
  }),
);
