/**
 * Settings → Integrations.
 *
 * Read, edit and test every integration from the dashboard. The rule running
 * through all of it: a secret goes IN but never comes back out. The screen is
 * told which secrets are set and their last four characters; the values
 * themselves never leave the server, so a browser cache, a screenshot or an
 * over-shared session cannot disclose them.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/pool.ts';
import { env } from '../../config/env.ts';
import { recordAudit } from '../../services/audit.ts';
import {
  describeForAdmin, INTEGRATION_KEYS, INTEGRATION_SPECS, recordTestResult, resolveIntegration,
  saveIntegration, type IntegrationKey,
} from '../../services/integrations.ts';
import { testEmail } from '../../integrations/email.ts';
import { testVoipms } from '../../integrations/voipms.ts';
import { pullCodes, pushDeal, testScarlett, buildDeal } from '../../integrations/scarlett.ts';
import { queueStats } from '../../jobs/queue.ts';
import { can } from '../../domain/permissions.ts';
import { AppError, asyncRoute, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';

export const integrationRoutes: Router = Router();
integrationRoutes.use(requireAuth);

const keyParam = z.enum(INTEGRATION_KEYS as [IntegrationKey, ...IntegrationKey[]]);

integrationRoutes.get(
  '/integrations',
  requirePermission('settings.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const [integrations, jobs] = await Promise.all([
      describeForAdmin(user.organization_id),
      queueStats(),
    ]);
    const codeCount = await queryOne<{ count: number; pulled: string | null }>(
      `SELECT COUNT(*)::int AS count, MAX(pulled_at)::text AS pulled
         FROM scarlett_codes WHERE organization_id = $1`,
      [user.organization_id],
    );
    res.json({
      ok: true,
      integrations,
      jobs,
      scarlettCodes: codeCount,
      // Editing needs a stronger permission than looking; the UI reads this
      // rather than inferring it from the role.
      canEdit: req.user!.role === 'technical_admin' ||
        Boolean((req.user!.permission_overrides ?? {})['integration.manage']),
    });
  }),
);

integrationRoutes.put(
  '/integrations/:key',
  requirePermission('integration.manage'),
  asyncRoute(async (req, res) => {
    const key = keyParam.parse(req.params.key);
    const body = z
      .object({
        enabled: z.boolean().optional(),
        config: z.record(z.unknown()).optional(),
        secrets: z.record(z.string()).optional(),
      })
      .parse(req.body);
    const user = req.user!;

    // The one setting that can do damage from the wrong machine.
    if (key === 'scarlett' && body.config?.mode === 'live' && !env.isProduction) {
      throw new AppError(
        `This server is running as ${env.NODE_ENV}, so it must not create live Scarlett deals. ` +
          'A test deal in a real broker network cannot be taken back from here.',
        422, 'refused',
      );
    }

    const before = await describeOne(user.organization_id, key);
    await saveIntegration(user.organization_id, key, body, user.id);
    const after = await describeOne(user.organization_id, key);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'integration.update',
      entityType: 'integration',
      entityId: key,
      summary:
        `${INTEGRATION_SPECS[key].name} settings changed` +
        (body.secrets && Object.keys(body.secrets).length
          ? ` (${Object.keys(body.secrets).length} credential(s) replaced)`
          : ''),
      // The audit records WHICH secrets changed and never their values — an
      // audit log that quotes a credential is a second place it can leak from.
      before, after,
    });

    res.json({ ok: true });
  }),
);

/** Enabled, configured and which secrets are set. Never a secret value. */
async function describeOne(organizationId: string, key: IntegrationKey) {
  const resolved = await resolveIntegration(organizationId, key);
  const secretNames = INTEGRATION_SPECS[key].fields.filter((f) => f.secret).map((f) => f.name);
  return {
    enabled: resolved.enabled,
    configured: resolved.configured,
    missing: resolved.missing,
    secretsSet: secretNames.filter((n) => Boolean(resolved.values[n])),
    config: Object.fromEntries(
      INTEGRATION_SPECS[key].fields
        .filter((f) => !f.secret)
        .map((f) => [f.name, resolved.values[f.name] ?? null]),
    ),
  };
}

integrationRoutes.post(
  '/integrations/:key/test',
  requirePermission('integration.manage'),
  asyncRoute(async (req, res) => {
    const key = keyParam.parse(req.params.key);
    const user = req.user!;

    let result: { ok: boolean; message: string };
    switch (key) {
      case 'email': {
        const to = z.string().email().parse(req.body?.to ?? user.email);
        const sent = await testEmail(user.organization_id, to);
        result = {
          ok: sent.ok,
          message: sent.ok
            ? `Sent to ${to} via ${sent.provider}. If it does not arrive, check SPF, DKIM and DMARC.`
            : (sent.error ?? 'The send failed.'),
        };
        break;
      }
      case 'voipms':
        result = await testVoipms(user.organization_id);
        break;
      case 'scarlett':
        result = await testScarlett(user.organization_id);
        break;
      case 'portal': {
        const resolved = await resolveIntegration(user.organization_id, 'portal');
        const base = String(resolved.values.base_url ?? '');
        const internalKey = String(resolved.values.internal_api_key ?? '');
        if (!base) { result = { ok: false, message: 'No portal URL is set.' }; break; }
        if (!internalKey) {
          result = { ok: false, message: 'No internal API key is set, so the portal cannot be tested.' };
          break;
        }
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          // Deliberately an endpoint the key guards, not /api/status. Reaching
          // an unauthenticated endpoint proves the portal is up and nothing
          // else; a wrong key would still have looked healthy. /api/status is
          // guarded by the portal's STATUS_API_KEY — a different secret — so
          // testing against it reported a 401 for a perfectly good key.
          const response = await fetch(
            `${base.replace(/\/+$/, '')}/api/internal/applications/count`,
            { headers: { 'x-internal-key': internalKey }, signal: controller.signal },
          ).finally(() => clearTimeout(timer));

          if (response.status === 401) {
            result = {
              ok: false,
              message: 'The portal is reachable but rejected the internal API key. It must match ' +
                'INTERNAL_API_KEY on the portal exactly.',
            };
            break;
          }
          if (!response.ok) {
            result = { ok: false, message: `The portal answered HTTP ${response.status}.` };
            break;
          }
          const body = (await response.json().catch(() => null)) as { count?: number } | null;
          const count = typeof body?.count === 'number' ? body.count : null;
          result = {
            ok: true,
            message:
              (count === null
                ? 'The portal accepted the internal API key.'
                : `The portal accepted the internal API key and reports ${count} application(s).`) +
              // The public URL is deliberately NOT advertised here: nginx returns
              // 404 for /crm/api/internal/ from the internet, by design. The
              // portal is on this machine and pushes over the loopback.
              ` Inbound pushes are accepted at http://127.0.0.1:${env.PORT}${env.BASE_PATH}/api/internal/mirror.`,
          };
        } catch (err) {
          result = {
            ok: false,
            message: `Could not reach the portal: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        break;
      }
      default:
        result = {
          ok: false,
          message: `There is no connection test for ${INTEGRATION_SPECS[key].name}.`,
        };
    }

    await recordTestResult(user.organization_id, key, result.ok, result.message);
    res.json({ ok: true, result });
  }),
);

/** Pull Scarlett's code tables. The thing that makes every enum mappable. */
integrationRoutes.post(
  '/integrations/scarlett/codes',
  requirePermission('integration.manage'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const result = await pullCodes(user.organization_id);
    await recordTestResult(user.organization_id, 'scarlett', result.ok, result.message);
    res.json({ ...result, ok: result.ok });
  }),
);

integrationRoutes.get(
  '/integrations/scarlett/codes',
  requirePermission('settings.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const { rows } = await query<{ menu_code: string; items: number }>(
      `SELECT menu_code, COUNT(*)::int AS items FROM scarlett_codes
        WHERE organization_id = $1 GROUP BY menu_code ORDER BY menu_code`,
      [user.organization_id],
    );
    const overrides = await query(
      `SELECT id, menu_code, our_value, their_value FROM scarlett_code_overrides
        WHERE organization_id = $1 ORDER BY menu_code, our_value`,
      [user.organization_id],
    );
    res.json({ ok: true, menus: rows, overrides: overrides.rows });
  }),
);

/**
 * A manual mapping, for the cases where our wording and theirs will never
 * normalise to the same string. The person who knows the right answer is a
 * broker looking at both lists, not a developer.
 */
integrationRoutes.post(
  '/integrations/scarlett/overrides',
  requirePermission('integration.manage'),
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        menu_code: z.string().min(1),
        our_value: z.string().min(1),
        their_value: z.string().min(1),
      })
      .parse(req.body);
    const user = req.user!;
    await query(
      `INSERT INTO scarlett_code_overrides (organization_id, menu_code, our_value, their_value, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_id, menu_code, our_value)
       DO UPDATE SET their_value = EXCLUDED.their_value, created_by = EXCLUDED.created_by`,
      [user.organization_id, body.menu_code, body.our_value, body.their_value, user.id],
    );
    res.json({ ok: true });
  }),
);

// ── Pushing a deal ─────────────────────────────────────────────────────────

/**
 * The file, if this person may send it: in the organisation, and theirs unless
 * they can see every file. A 404 otherwise, as everywhere else.
 */
async function scarlettFile(user: NonNullable<Express.Request['user']>, id: string) {
  const app = await queryOne<{
    scarlett_deal_id: string | null; scarlett_synced_at: Date | null; archived_at: Date | null;
    first_name: string | null; last_name: string | null; amount_requested: string | null;
    property_city: string | null; property_province: string | null; portal_reference: string | null;
  }>(
    `SELECT app.scarlett_deal_id, app.scarlett_synced_at, app.archived_at, c.first_name, c.last_name,
            app.amount_requested, app.property_city, app.property_province, app.portal_reference
       FROM applications app JOIN customers c ON c.id = app.customer_id
      WHERE app.id = $1 AND app.organization_id = $2
        AND ($3::boolean OR EXISTS (SELECT 1 FROM assignments a WHERE a.application_id = app.id
                                      AND a.unassigned_at IS NULL AND a.user_id = $4))`,
    [id, user.organization_id, can(user, 'customer.view_all'), user.id],
  );
  if (!app) throw notFound('That application');
  return app;
}

/**
 * Files being sent right now. A double-click, or two people pressing the
 * button together, would otherwise both pass the "already in Scarlett" check
 * before either had a deal id — and a second deal in a broker network is not
 * something this side can clean up. In memory, because this service runs as
 * one process (deploy/lendmax-brokerage-crm.service).
 */
const pushing = new Set<string>();

/**
 * What would be sent, and what is missing — before anything is sent.
 *
 * The screen shows this first. "Scarlett rejected the deal" after the fact is
 * an afternoon; "the subject property has no province" beforehand is a minute.
 */
integrationRoutes.get(
  '/applications/:id/scarlett/preview',
  requirePermission('scarlett.push'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const user = req.user!;
    const app = await scarlettFile(user, id);

    const build = await buildDeal(user.organization_id, id);
    const resolved = await resolveIntegration(user.organization_id, 'scarlett');
    res.json({
      ok: true,
      ready: build.blockers.length === 0,
      blockers: build.blockers,
      warnings: build.warnings,
      unmapped: build.unmapped,
      alreadyPushed: app.scarlett_deal_id,
      lastSyncedAt: app.scarlett_synced_at,
      archived: !!app.archived_at,
      file: {
        client: `${app.first_name ?? ''} ${app.last_name ?? ''}`.trim() || null,
        reference: app.portal_reference, amount_requested: app.amount_requested,
        property: [app.property_city, app.property_province].filter(Boolean).join(', ') || null,
      },
      mode: resolved.values.mode ?? 'sandbox',
      codesPulled: Boolean(await queryOne(
        'SELECT 1 FROM scarlett_codes WHERE organization_id = $1 LIMIT 1', [user.organization_id])),
      configured: resolved.configured && resolved.enabled,
      missing: resolved.enabled ? resolved.missing : [...resolved.missing, 'the integration is switched off'],
      // The payload itself, so whoever may read the income on it can see
      // exactly what would go. Sending a file is not a grant to read it.
      deal: can(user, 'pii.view_financials') ? build.deal : null,
    });
  }),
);

integrationRoutes.post(
  '/applications/:id/scarlett/push',
  requirePermission('scarlett.push'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({ accept_unmapped: z.boolean().default(false), overwrite: z.boolean().default(false) })
      .parse(req.body ?? {});
    const user = req.user!;
    const file = await scarlettFile(user, id);
    if (file.archived_at) throw new AppError('That file is archived. Restore it before sending it to Scarlett.', 409, 'archived');

    const resolved = await resolveIntegration(user.organization_id, 'scarlett');
    if (!resolved.configured || !resolved.enabled) {
      const missing = resolved.enabled ? resolved.missing : [...resolved.missing, 'the integration is switched off'];
      throw new AppError(
        `Scarlett is not connected yet${missing.length ? ` (missing: ${missing.join(', ')})` : ''}. ` +
        'Set it up under Settings → Integrations.', 422, 'not_configured');
    }
    if (resolved.values.mode === 'sandbox') {
      // Sandbox means nothing is sent. Said plainly rather than pretending to
      // succeed, so nobody believes a deal is in Scarlett when it is not.
      const build = await buildDeal(user.organization_id, id);
      res.json({
        ok: false, sandbox: true, code: 'sandbox',
        error: 'Scarlett is in sandbox mode, so nothing was sent. Switch it to live under ' +
               'Settings → Integrations when you are ready.',
        blockers: build.blockers, unmapped: build.unmapped, deal: build.deal,
      });
      return;
    }

    if (pushing.has(id)) {
      throw new AppError('This file is already being sent to Scarlett. Wait a moment and refresh.', 409, 'in_progress');
    }
    pushing.add(id);
    let result: Awaited<ReturnType<typeof pushDeal>>;
    try {
      result = await pushDeal(user.organization_id, id, {
        actorUserId: user.id,
        acceptUnmapped: body.accept_unmapped,
        overwrite: body.overwrite,
      });
    } finally {
      pushing.delete(id);
    }

    if (!result.ok) {
      res.status(422).json({
        ok: false, code: 'scarlett_refused', error: result.error, blockers: result.blockers,
        unmapped: result.unmapped, retryable: result.retryable ?? false,
      });
      return;
    }

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'scarlett.push',
      entityType: 'application',
      entityId: id,
      applicationId: id,
      summary: `${body.overwrite ? 'Re-sent' : 'Sent'} ${file.portal_reference ?? 'a file'} to Scarlett as ${result.dealId}`,
      after: { dealId: result.dealId, unmapped: result.unmapped },
    });

    res.json({ ok: true, dealId: result.dealId, unmapped: result.unmapped });
  }),
);

/** Every attempt, with what was sent. The first question after a failure. */
integrationRoutes.get(
  '/applications/:id/scarlett/log',
  requirePermission('scarlett.push'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await query(
      `SELECT id, at, operation, attempt, http_status, ok, error_message, scarlett_deal_id,
              duration_ms, request_payload, response_payload
         FROM scarlett_syncs WHERE application_id = $1 ORDER BY at DESC LIMIT 25`,
      [id],
    );
    res.json({ ok: true, attempts: rows });
  }),
);
