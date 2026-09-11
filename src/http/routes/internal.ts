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
import { query, queryOne } from '../../db/pool.ts';
import { log } from '../../lib/logger.ts';
import { safeEqual } from '../../lib/secrets.ts';
import { resolveIntegration } from '../../services/integrations.ts';
import {
  importMirrorPayload, logMirrorFailure, type MirrorPayload,
} from '../../services/portal-import.ts';
import { parseInboundCallback } from '../../integrations/voipms.ts';
import { receiveInbound } from '../../services/messaging.ts';
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

/**
 * VoIP.ms inbound SMS/MMS.
 *
 * VoIP.ms calls a URL you paste into their portal, as a GET with query
 * parameters, and it has no signing mechanism. The only thing available is a
 * secret in the URL, compared in constant time — so the URL itself is the
 * credential and must be treated as one.
 *
 * It answers 200 to almost everything on purpose. VoIP.ms retries on a
 * non-2xx, and a message we have decided to hold for a person is not a message
 * we want re-delivered every few minutes.
 */
internalRoutes.get(
  '/voipms/inbound',
  internalLimiter,
  asyncRoute(async (req, res) => {
    const organizationId = await currentOrganizationId();
    if (!organizationId) {
      res.status(503).send('no organization');
      return;
    }

    const integration = await resolveIntegration(organizationId, 'voipms');
    const expected = String(integration.values.webhook_secret ?? '');
    if (!expected) {
      log.error('voip.ms callback refused: no inbound key configured');
      res.status(503).send('not configured');
      return;
    }
    const presented = String(req.query.key ?? req.get('x-webhook-key') ?? '');
    if (!safeEqual(presented, expected)) {
      log.warn('voip.ms callback rejected: bad key', { ip: req.ip });
      res.status(401).send('unauthorised');
      return;
    }

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      params.set(k, String(Array.isArray(v) ? v[0] : v));
    }
    const inbound = parseInboundCallback(params);

    // Stored before it is acted on. A callback that arrives and cannot be
    // processed is a bug to fix, not an event to lose.
    await query(
      `INSERT INTO webhook_events (provider, event_type, external_id, payload, signature_ok)
       VALUES ('voipms','inbound_sms',$1,$2::jsonb,true)
       ON CONFLICT (provider, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
      [inbound.providerMessageId, JSON.stringify(Object.fromEntries(params))],
    );

    if (!inbound.from) {
      log.warn('voip.ms callback had no usable sender', { raw: params.get('from') });
      res.status(200).send('ok');
      return;
    }

    try {
      const result = await receiveInbound({
        organizationId,
        channel: inbound.mediaUrls.length ? 'mms' : 'sms',
        from: inbound.from,
        to: inbound.to,
        body: inbound.body,
        mediaUrls: inbound.mediaUrls,
        provider: 'voipms',
        providerMessageId: inbound.providerMessageId,
        receivedAt: inbound.receivedAt,
      });
      await query(
        `UPDATE webhook_events SET processed_at = now()
          WHERE provider = 'voipms' AND external_id = $1`,
        [inbound.providerMessageId],
      );
      log.info('inbound sms', { status: result.status, from: inbound.from });
    } catch (err) {
      await query(
        `UPDATE webhook_events SET process_error = $2, attempts = attempts + 1
          WHERE provider = 'voipms' AND external_id = $1`,
        [inbound.providerMessageId, err instanceof Error ? err.message : String(err)],
      ).catch(() => {});
      log.error('could not process an inbound sms', { error: err });
    }

    // 200 regardless: the event is stored either way, and a retry would
    // duplicate rather than repair.
    res.status(200).send('ok');
  }),
);
