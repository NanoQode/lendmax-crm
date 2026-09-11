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
        if (!base) { result = { ok: false, message: 'No portal URL is set.' }; break; }
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          const response = await fetch(`${base.replace(/\/+$/, '')}/api/status`, {
            signal: controller.signal,
          }).finally(() => clearTimeout(timer));
          result = {
            ok: response.ok,
            message: response.ok
              ? `The portal answered (HTTP ${response.status}). Inbound pushes are accepted at ` +
                `${env.PUBLIC_URL}/api/internal/mirror.`
              : `The portal answered HTTP ${response.status}.`,
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
    const app = await queryOne<{ scarlett_deal_id: string | null }>(
      'SELECT scarlett_deal_id FROM applications WHERE id = $1 AND organization_id = $2',
      [id, user.organization_id],
    );
    if (!app) throw notFound('That application');

    const build = await buildDeal(user.organization_id, id);
    const resolved = await resolveIntegration(user.organization_id, 'scarlett');
    res.json({
      ok: true,
      ready: build.blockers.length === 0,
      blockers: build.blockers,
      warnings: build.warnings,
      unmapped: build.unmapped,
      alreadyPushed: app.scarlett_deal_id,
      mode: resolved.values.mode ?? 'sandbox',
      configured: resolved.configured,
      // The payload itself, so an admin can see exactly what would go.
      deal: build.deal,
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

    const resolved = await resolveIntegration(user.organization_id, 'scarlett');
    if (resolved.values.mode === 'sandbox') {
      // Sandbox means nothing is sent. Said plainly rather than pretending to
      // succeed, so nobody believes a deal is in Scarlett when it is not.
      const build = await buildDeal(user.organization_id, id);
      res.json({
        ok: false, sandbox: true,
        error: 'Scarlett is in sandbox mode, so nothing was sent. Switch it to live under ' +
               'Settings → Integrations when you are ready.',
        blockers: build.blockers, unmapped: build.unmapped, deal: build.deal,
      });
      return;
    }

    const result = await pushDeal(user.organization_id, id, {
      actorUserId: user.id,
      acceptUnmapped: body.accept_unmapped,
      overwrite: body.overwrite,
    });

    if (!result.ok) {
      res.status(422).json({
        ok: false, error: result.error, blockers: result.blockers, unmapped: result.unmapped,
      });
      return;
    }

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'scarlett.push',
      entityType: 'application',
      entityId: id,
      summary: `Pushed to Scarlett as ${result.dealId}`,
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
