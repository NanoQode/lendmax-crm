/**
 * Settings, integrations, health and the audit tools.
 *
 * The health endpoint answers the question an admin actually has at 9am, which
 * is not "is the process up" — they can see that — but "is anything failing
 * quietly": is email going out, is SMS going out, is Scarlett in step, is the
 * job queue draining, has anything dead-lettered.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, healthcheck } from '../../db/pool.ts';
import { env } from '../../config/env.ts';
import { verifyChain } from '../../services/audit.ts';
import {
  INTEGRATION_KEYS, INTEGRATION_SPECS, resolveIntegration,
} from '../../services/integrations.ts';
import { recordAudit } from '../../services/audit.ts';
import { ROLES, ROLE_IDS, PERMISSIONS } from '../../domain/permissions.ts';
import { asyncRoute, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';

export const systemRoutes: Router = Router();

/**
 * Unauthenticated and deliberately thin: it says whether the process can serve,
 * and nothing about the estate. The detailed view is behind a permission.
 */
systemRoutes.get(
  '/health',
  asyncRoute(async (_req, res) => {
    const db = await healthcheck();
    res.status(db.ok ? 200 : 503).json({
      ok: db.ok,
      service: 'lendmax-crm',
      database: db.ok ? 'ok' : 'unavailable',
      latency_ms: db.latencyMs,
      at: new Date().toISOString(),
    });
  }),
);

systemRoutes.use(requireAuth);

/** The operational picture. */
systemRoutes.get(
  '/status',
  requirePermission('settings.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const [db, jobs, messages, scarlett, webhooks, automations] = await Promise.all([
      healthcheck(),
      query<{ state: string; count: number }>(
        `SELECT state, COUNT(*)::int AS count FROM jobs
          WHERE created_at > now() - interval '7 days' GROUP BY state`,
      ),
      query(
        `SELECT channel,
                COUNT(*) FILTER (WHERE status IN ('failed','bounced'))::int AS failed,
                COUNT(*) FILTER (WHERE status IN ('sent','delivered'))::int AS sent,
                COUNT(*) FILTER (WHERE status = 'queued')::int AS queued
           FROM messages
          WHERE organization_id = $1 AND created_at > now() - interval '24 hours'
          GROUP BY channel`,
        [user.organization_id],
      ),
      queryOne(
        `SELECT COUNT(*) FILTER (WHERE NOT ok)::int AS failures,
                MAX(at) FILTER (WHERE ok) AS last_success,
                MAX(at) FILTER (WHERE NOT ok) AS last_failure
           FROM scarlett_syncs
          WHERE organization_id = $1 AND at > now() - interval '24 hours'`,
        [user.organization_id],
      ),
      queryOne(
        `SELECT COUNT(*) FILTER (WHERE processed_at IS NULL)::int AS unprocessed,
                COUNT(*) FILTER (WHERE process_error IS NOT NULL)::int AS errored
           FROM webhook_events WHERE received_at > now() - interval '24 hours'`,
      ),
      queryOne(
        `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active_enrollments,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_enrollments,
                COUNT(*) FILTER (WHERE status = 'active' AND next_run_at < now() - interval '1 hour')::int
                  AS overdue_steps
           FROM automation_enrollments WHERE organization_id = $1`,
        [user.organization_id],
      ),
    ]);

    const jobsByState = Object.fromEntries(jobs.rows.map((r) => [r.state, r.count]));

    // Resolved, not read from the environment. describeIntegrations() only ever
    // saw env vars, so an integration configured on the Integrations screen —
    // the documented way to configure one — reported itself unconfigured here,
    // while its own connection test passed against the same credentials.
    const integrationStatus = await Promise.all(
      INTEGRATION_KEYS.map(async (key) => {
        const resolved = await resolveIntegration(user.organization_id, key);
        return {
          id: key,
          name: INTEGRATION_SPECS[key].name,
          configured: resolved.configured,
          enabled: resolved.enabled,
          missing: resolved.missing,
          // Where each value came from, so "configured" is explainable rather
          // than a bare boolean an admin has to take on trust.
          source: resolved.source,
          ...(key === 'scarlett' ? { mode: resolved.values.mode ?? env.SCARLETT_MODE } : {}),
        };
      }),
    );

    res.json({
      ok: true,
      database: db,
      integrations: integrationStatus,
      jobs: {
        ...jobsByState,
        // The number that matters: work that gave up. Everything else recovers.
        dead: jobsByState.dead ?? 0,
      },
      messages: messages.rows,
      scarlett,
      webhooks,
      automations,
      environment: {
        node_env: env.NODE_ENV,
        timezone: env.BROKERAGE_TIMEZONE,
        scarlett_mode: env.SCARLETT_MODE,
        storage_driver: env.STORAGE_DRIVER,
        email_driver: env.EMAIL_DRIVER,
      },
    });
  }),
);

/** The vocabularies the UI renders from. One call on load. */
systemRoutes.get(
  '/config',
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const [stages, types, dispositions, categories, users, lenders] = await Promise.all([
      query(
        // Every stage not deleted, with its pipeline, default pipeline first.
        `SELECT s.key, s.label, s.position, s.category, s.probability, s.colour, s.entry_rules, s.active,
                s.pipeline_id, p.name AS pipeline_name, p.active AS pipeline_active
           FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
          WHERE s.organization_id = $1 AND s.archived_at IS NULL AND p.archived_at IS NULL
          ORDER BY p.is_default DESC, p.position, s.position`,
        [user.organization_id],
      ),
      query(
        `SELECT key, label, position, portal_purpose, required_documents, active
           FROM transaction_types WHERE organization_id = $1 AND active ORDER BY position`,
        [user.organization_id],
      ),
      query(
        `SELECT key, label, requires_note, reactivation_days, nurture_eligible
           FROM lost_dispositions WHERE organization_id = $1 AND active ORDER BY position`,
        [user.organization_id],
      ),
      query(
        `SELECT key, label, group_key, client_visible, sensitive
           FROM document_categories WHERE organization_id = $1 AND active ORDER BY position`,
        [user.organization_id],
      ),
      query(
        // Everyone a dropdown may offer: active, activated, not deleted.
        `SELECT id, name, email, role FROM users
          WHERE organization_id = $1 AND active AND activated_at IS NOT NULL
            AND archived_at IS NULL ORDER BY name`,
        [user.organization_id],
      ),
      query(
        `SELECT id, name, short_name FROM lenders
          WHERE organization_id = $1 AND active ORDER BY name`,
        [user.organization_id],
      ),
    ]);

    res.json({
      ok: true,
      stages: stages.rows,
      pipelines: (await query(
        `SELECT p.id, p.key, p.name, p.active, p.is_default,
                COALESCE(array_agg(pp.purpose) FILTER (WHERE pp.purpose IS NOT NULL), '{}') AS purposes
           FROM pipelines p LEFT JOIN pipeline_purposes pp ON pp.pipeline_id = p.id
          WHERE p.organization_id = $1 AND p.archived_at IS NULL
          GROUP BY p.id ORDER BY p.is_default DESC, p.position, lower(p.name)`,
        [user.organization_id])).rows,
      transaction_types: types.rows,
      lost_dispositions: dispositions.rows,
      document_categories: categories.rows,
      users: users.rows,
      lenders: lenders.rows,
      roles: ROLE_IDS.map((id) => ({ id, ...ROLES[id] })),
      base_path: env.BASE_PATH,
    });
  }),
);

/** The permission catalogue. The staff form uses /staff/meta, which groups it by module. */
systemRoutes.get(
  '/permissions',
  requirePermission('user.view'),
  asyncRoute(async (_req, res) => {
    res.json({
      ok: true,
      permissions: Object.entries(PERMISSIONS).map(([id, label]) => ({ id, label })),
      roles: ROLE_IDS.map((id) => ({ id, ...ROLES[id] })),
    });
  }),
);

/**
 * Verify the audit chain.
 *
 * Not scheduled here on purpose: this is the button a compliance manager
 * presses before an audit, and its answer has to be theirs rather than a green
 * tick somebody else's job wrote last night.
 */
systemRoutes.post(
  '/audit/verify',
  requirePermission('audit.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const result = await verifyChain(user.organization_id);
    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'audit.verify',
      summary: result.ok
        ? `Audit chain verified over ${result.checked} entries`
        : `Audit chain verification FAILED at entry ${result.brokenAt?.id}`,
      after: result,
    });
    res.json({
      ok: true,
      result,
      message: result.ok
        ? `Verified ${result.checked} entries. The chain is intact.`
        : `The chain breaks at entry ${result.brokenAt?.id} (${result.brokenAt?.action}). ` +
          'Entries before it are intact; everything after it should be treated as unverified.',
    });
  }),
);

systemRoutes.get(
  '/audit',
  requirePermission('audit.view'),
  asyncRoute(async (req, res) => {
    const q = z
      .object({
        action: z.string().optional(),
        entity_type: z.string().optional(),
        entity_id: z.string().optional(),
        user_id: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const user = req.user!;

    const params: unknown[] = [user.organization_id];
    const where = ['organization_id = $1'];
    for (const [column, value] of [
      ['action', q.action], ['entity_type', q.entity_type],
      ['entity_id', q.entity_id], ['actor_user_id', q.user_id],
    ] as const) {
      if (value) {
        params.push(value);
        where.push(`${column} = $${params.length}`);
      }
    }
    params.push(q.limit);

    const { rows } = await query(
      `SELECT id, at, actor_name, actor_role, actor_kind, action, entity_type, entity_id,
              summary, before_json, after_json, ip
         FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    res.json({ ok: true, entries: rows });
  }),
);

// ── Settings ───────────────────────────────────────────────────────────────

systemRoutes.get(
  '/settings/:key',
  requirePermission('settings.view'),
  asyncRoute(async (req, res) => {
    const key = z.string().min(1).parse(req.params.key);
    const user = req.user!;
    // The row in force today, not simply the newest: a setting can be written
    // with a future effective date.
    const row = await queryOne(
      `SELECT key, value, effective_from, source_note, updated_at
         FROM settings
        WHERE organization_id = $1 AND key = $2 AND effective_from <= CURRENT_DATE
        ORDER BY effective_from DESC LIMIT 1`,
      [user.organization_id, key],
    );
    if (!row) throw notFound(`Setting "${key}"`);
    res.json({ ok: true, setting: row });
  }),
);

systemRoutes.put(
  '/settings/:key',
  requirePermission('settings.manage'),
  asyncRoute(async (req, res) => {
    const key = z.string().min(1).parse(req.params.key);
    const body = z
      .object({
        value: z.unknown(),
        effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        source_note: z.string().optional(),
      })
      .parse(req.body);
    const user = req.user!;

    const before = await queryOne(
      `SELECT value FROM settings WHERE organization_id = $1 AND key = $2
        ORDER BY effective_from DESC LIMIT 1`,
      [user.organization_id, key],
    );

    await query(
      `INSERT INTO settings (organization_id, key, value, effective_from, source_note, updated_by)
       VALUES ($1,$2,$3::jsonb,COALESCE($4::date, CURRENT_DATE),$5,$6)
       ON CONFLICT (organization_id, key, effective_from)
       DO UPDATE SET value = EXCLUDED.value, source_note = EXCLUDED.source_note,
                     updated_by = EXCLUDED.updated_by`,
      [user.organization_id, key, JSON.stringify(body.value),
       body.effective_from ?? null, body.source_note ?? null, user.id],
    );

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'settings.update',
      entityType: 'setting',
      entityId: key,
      summary: `Setting "${key}" changed`,
      before,
      after: { value: body.value, source_note: body.source_note },
    });

    res.json({ ok: true });
  }),
);
