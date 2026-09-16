/**
 * Automations: the list, the editor's save/publish cycle, and the controls a
 * broker uses on one client's enrollment.
 *
 * Two decisions shape the whole file.
 *
 * PUBLISHING IS A SEPARATE ACT FROM SAVING. A draft may be half-finished and
 * saves without complaint. Publishing runs the validator and refuses on any
 * error, because a published version runs against real clients unattended.
 * Publishing also writes a NEW version rather than mutating the live one, so
 * an enrollment already running keeps running the version it started on.
 *
 * AN ENROLLMENT IS SOMETHING A PERSON CAN STOP. Pause, resume, skip the next
 * step, end it — each records who did it and why. An automation a broker
 * cannot interrupt is one they will ask to have switched off entirely the
 * first time it embarrasses them in front of a client.
 */
import { Router } from 'express';
import { pipelineOptions } from '../../services/pipelines.ts';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../db/pool.ts';
import { recordAudit } from '../../services/audit.ts';
import { asyncRoute, AppError, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';
import {
  DefinitionSchema, validateDefinition, nodeByKey,
  type AutomationDefinition,
} from '../../domain/automation.ts';
import { ACTION_CATALOGUE, OPERATORS, TRIGGER_CATALOGUE } from '../../domain/automation-catalogue.ts';
import { factFields } from '../../services/automation-facts.ts';
import { MERGE_FIELDS, previewTemplate, validateTemplate } from '../../domain/merge-fields.ts';
import { dryRun, enrol, runStep } from '../../services/automation-engine.ts';
import { enqueue } from '../../jobs/queue.ts';

export const automationRoutes: Router = Router();
automationRoutes.use(requireAuth);

// Every `:id` here is a uuid. Anything else cannot match a row, and is a
// "not found" rather than the database refusing to compare it.
automationRoutes.param('id', (_req, _res, next, id: string) => {
  next(z.string().uuid().safeParse(id).success ? undefined : notFound('That record'));
});

// ── The catalogue the builder needs to draw itself ─────────────────────────

/**
 * What the builder offers, served rather than duplicated in the client.
 *
 * The alternative is a list of triggers hard-coded in TypeScript on the
 * server and again in the UI, which drift the first time somebody adds one.
 */
automationRoutes.get(
  '/automations/catalogue',
  requirePermission('automation.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    // Stages carry their pipeline's name, so a stage called "New" in two
    // pipelines is not two identical entries in a dropdown.
    const { pipelines, stages } = await pipelineOptions(user.organization_id);
    const [users, automations, templates, tags, requiredDocuments] = await Promise.all([
      query<{ id: string; name: string; role: string }>(
        `SELECT id, name, role FROM users WHERE organization_id = $1 AND active AND archived_at IS NULL ORDER BY name`,
        [user.organization_id]),
      query<{ id: string; name: string; status: string }>(
        `SELECT id, name, status FROM automations WHERE organization_id = $1 AND status <> 'archived' ORDER BY name`,
        [user.organization_id]),
      query<{ key: string; name: string; channel: string }>(
        `SELECT key, name, channel FROM templates WHERE organization_id = $1 AND active ORDER BY name`,
        [user.organization_id]),
      query<{ tag: string }>(
        `SELECT DISTINCT unnest(tags) AS tag FROM customers WHERE organization_id = $1 ORDER BY 1 LIMIT 500`,
        [user.organization_id]),
      query<{ id: string; name: string; purpose: string; required: boolean }>(
        `SELECT id, name, purpose, required FROM required_documents
          WHERE organization_id = $1 AND active AND archived_at IS NULL ORDER BY purpose, position`,
        [user.organization_id]),
    ]);
    res.json({
      triggers: TRIGGER_CATALOGUE,
      actions: ACTION_CATALOGUE,
      // Kept for the client file's automation tab, which reads these names.
      node_types: ACTION_CATALOGUE.map((a) => ({ type: a.type, label: a.label, icon: a.icon })),
      operators: OPERATORS,
      fields: factFields(),
      merge_fields: MERGE_FIELDS,
      stages,
      pipelines,
      users: users.rows,
      automations: automations.rows,
      templates: templates.rows,
      tags: tags.rows.map((r) => r.tag),
      required_documents: requiredDocuments.rows,
    });
  }),
);

const TRIGGER_LABELS: Record<string, string> =
  Object.fromEntries(TRIGGER_CATALOGUE.map((t) => [t.type, t.label]));

// ── The list ───────────────────────────────────────────────────────────────

automationRoutes.get(
  '/automations',
  requirePermission('automation.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const { rows } = await query(
      `SELECT a.id, a.key, a.name, a.description, a.status, a.purpose,
              a.published_version, a.allow_reenrollment, a.reenrollment_cooldown_days,
              a.updated_at,
              (SELECT max(version) FROM automation_versions v WHERE v.automation_id = a.id)
                AS latest_version,
              (SELECT v.definition->'trigger'->>'type' FROM automation_versions v
                WHERE v.automation_id = a.id
                ORDER BY v.version DESC LIMIT 1) AS trigger_type,
              (SELECT COALESCE(
                        (SELECT array_agg(t->>'type') FROM jsonb_array_elements(v.definition->'triggers') t),
                        ARRAY[v.definition->'trigger'->>'type'])
                 FROM automation_versions v WHERE v.automation_id = a.id
                ORDER BY v.version DESC LIMIT 1) AS trigger_types,
              (SELECT count(*)::int FROM automation_enrollments en WHERE en.automation_id = a.id)
                AS total_enrollments,
              (SELECT max(en.enrolled_at) FROM automation_enrollments en WHERE en.automation_id = a.id)
                AS last_enrolled_at,
              COALESCE(e.active, 0) AS active_enrollments,
              COALESCE(e.completed, 0) AS completed_enrollments,
              COALESCE(e.stopped, 0) AS stopped_enrollments,
              COALESCE(m.sent, 0) AS messages_sent
         FROM automations a
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
                  count(*) FILTER (WHERE status = 'completed')::int AS completed,
                  count(*) FILTER (WHERE status = 'stopped')::int AS stopped
             FROM automation_enrollments en WHERE en.automation_id = a.id
         ) e ON TRUE
         LEFT JOIN LATERAL (
           SELECT sum(en.messages_sent)::int AS sent
             FROM automation_enrollments en WHERE en.automation_id = a.id
         ) m ON TRUE
        WHERE a.organization_id = $1 AND a.status <> 'archived'
        ORDER BY (a.status = 'active') DESC, a.name`,
      [user.organization_id],
    );
    res.json({
      automations: rows,
      trigger_labels: TRIGGER_LABELS,
    });
  }),
);

// ── One automation, with its versions ──────────────────────────────────────

automationRoutes.get(
  '/automations/:id',
  requirePermission('automation.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const automation = await queryOne(
      `SELECT a.*,
              COALESCE(e.active, 0) AS active_enrollments,
              COALESCE(e.completed, 0) AS completed_enrollments,
              COALESCE(e.stopped, 0) AS stopped_enrollments
         FROM automations a
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
                  count(*) FILTER (WHERE status = 'completed')::int AS completed,
                  count(*) FILTER (WHERE status = 'stopped')::int AS stopped
             FROM automation_enrollments en WHERE en.automation_id = a.id
         ) e ON TRUE
        WHERE a.id = $1 AND a.organization_id = $2`,
      [req.params.id, user.organization_id],
    );
    if (!automation) throw notFound('That automation');

    const versions = await query(
      `SELECT v.version, v.published_at, v.notes, v.validation, u.name AS published_by_name,
              (SELECT count(*)::int FROM automation_enrollments e
                WHERE e.automation_id = v.automation_id AND e.automation_version = v.version
                  AND e.status = 'active') AS running
         FROM automation_versions v
         LEFT JOIN users u ON u.id = v.published_by
        WHERE v.automation_id = $1 ORDER BY v.version DESC`,
      [req.params.id],
    );

    // The working copy is the highest version; the live one is whatever is
    // published. They are usually the same and the editor must show when
    // they are not, because "I changed that last week" against a live
    // version that never got published is a support call.
    const draft = await queryOne<{ version: number; definition: unknown }>(
      `SELECT version, definition FROM automation_versions
        WHERE automation_id = $1 ORDER BY version DESC LIMIT 1`,
      [req.params.id],
    );

    const parsed = draft ? DefinitionSchema.safeParse(draft.definition) : null;
    res.json({
      automation,
      versions: versions.rows,
      draft_version: draft?.version ?? null,
      // Normalised (a single old `trigger` comes back as `triggers` too), so
      // the builder only ever reads one shape.
      definition: parsed?.success ? parsed.data : draft?.definition ?? null,
      issues: parsed?.success ? validateDefinition(parsed.data) : parsed
        ? [{ level: 'error', message: 'This draft is not a valid definition.' }] : [],
    });
  }),
);

// ── Creating and saving ────────────────────────────────────────────────────

const CreateInput = z.object({
  name: z.string().trim().min(1, 'An automation needs a name.'),
  key: z.string().trim().regex(/^[a-z0-9_]+$/, 'Use lower case, digits and underscores.')
    .optional(),
  description: z.string().trim().optional(),
  purpose: z.enum(['transactional', 'marketing', 'service']).default('transactional'),
  definition: z.unknown().optional(),
});

automationRoutes.post(
  '/automations',
  requirePermission('automation.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = CreateInput.parse(req.body);
    // Two workflows may share a name (two "New workflow"s, or a recipe used
    // twice), so a derived key is made unique. A key the caller chose is kept
    // as given, and a clash with it is a real conflict.
    const key = body.key ?? await freeKey(user.organization_id, slug(body.name));

    const definition: AutomationDefinition = body.definition
      ? DefinitionSchema.parse(body.definition)
      : DefinitionSchema.parse({
        trigger: { type: 'manual', filters: [] },
        entry_conditions: [],
        stop_conditions: [],
        start_node: 'step_1',
        nodes: [{ key: 'step_1', type: 'stop', reason: 'Not built yet' }],
      });

    const id = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO automations (organization_id, key, name, description, purpose,
                                  status, created_by)
         VALUES ($1,$2,$3,$4,$5,'draft',$6) RETURNING id`,
        [user.organization_id, key, body.name, body.description ?? null, body.purpose, user.id],
      );
      const automationId = rows[0]!.id;
      await client.query(
        `INSERT INTO automation_versions (automation_id, version, definition)
         VALUES ($1,1,$2::jsonb)`,
        [automationId, JSON.stringify(definition)],
      );
      return automationId;
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'automation.create',
      entityType: 'automation',
      entityId: id,
      summary: `Automation "${body.name}" created as a draft`,
    });

    res.status(201).json({ id, key });
  }),
);

const SaveInput = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().nullable().optional(),
  purpose: z.enum(['transactional', 'marketing', 'service']).optional(),
  allow_reenrollment: z.boolean().optional(),
  reenrollment_cooldown_days: z.number().int().min(0).nullable().optional(),
  definition: z.unknown().optional(),
});

/**
 * Saving a draft.
 *
 * The definition is parsed (so a structurally broken document never reaches
 * the database) but NOT validated (so a half-built one still saves). The
 * unpublished top version is edited in place; once a version is published it
 * is frozen and the next save opens a new one.
 */
automationRoutes.put(
  '/automations/:id',
  requirePermission('automation.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = SaveInput.parse(req.body);
    const automation = await queryOne<{ id: string; name: string; published_version: number | null }>(
      `SELECT id, name, published_version FROM automations
        WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id],
    );
    if (!automation) throw notFound('That automation');

    const fields: string[] = [];
    const params: unknown[] = [automation.id];
    for (const [column, value] of Object.entries({
      name: body.name,
      description: body.description,
      purpose: body.purpose,
      allow_reenrollment: body.allow_reenrollment,
      reenrollment_cooldown_days: body.reenrollment_cooldown_days,
    })) {
      if (value === undefined) continue;
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    }
    if (fields.length) {
      await query(`UPDATE automations SET ${fields.join(', ')} WHERE id = $1`, params);
    }

    let version: number | null = null;
    if (body.definition !== undefined) {
      const definition = DefinitionSchema.parse(body.definition);
      version = await withTransaction(async (client) => {
        const { rows } = await client.query<{ version: number; published_at: string | null }>(
          `SELECT version, published_at FROM automation_versions
            WHERE automation_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE`,
          [automation.id],
        );
        const top = rows[0];
        if (top && !top.published_at) {
          await client.query(
            `UPDATE automation_versions SET definition = $2::jsonb
              WHERE automation_id = $1 AND version = $3`,
            [automation.id, JSON.stringify(definition), top.version],
          );
          return top.version;
        }
        const next = (top?.version ?? 0) + 1;
        await client.query(
          `INSERT INTO automation_versions (automation_id, version, definition)
           VALUES ($1,$2,$3::jsonb)`,
          [automation.id, next, JSON.stringify(definition)],
        );
        return next;
      });
    }

    res.json({
      ok: true,
      draft_version: version,
      issues: body.definition !== undefined
        ? validateDefinition(DefinitionSchema.parse(body.definition))
        : [],
    });
  }),
);

// ── Publishing ─────────────────────────────────────────────────────────────

/**
 * Publish the top version.
 *
 * Refuses on any validation error. The warnings — an unreachable step, no
 * stop conditions — are returned and must be acknowledged with
 * `?acknowledge=1`, because "this sequence will run to the end even if the
 * client funds" is something somebody should have to read before saying yes.
 */
automationRoutes.post(
  '/automations/:id/publish',
  requirePermission('automation.publish'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const acknowledge = req.body?.acknowledge === true;
    const automation = await queryOne<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM automations WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id],
    );
    if (!automation) throw notFound('That automation');

    const top = await queryOne<{ version: number; definition: unknown; published_at: string | null }>(
      `SELECT version, definition, published_at FROM automation_versions
        WHERE automation_id = $1 ORDER BY version DESC LIMIT 1`,
      [automation.id],
    );
    if (!top) throw new AppError('There is nothing to publish.', 400);

    const parsed = DefinitionSchema.safeParse(top.definition);
    if (!parsed.success) {
      throw new AppError('This automation is not a valid definition.', 400,
        'invalid_definition', parsed.error.issues);
    }
    const issues = validateDefinition(parsed.data);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
      throw new AppError(
        errors.length === 1 ? errors[0]!.message
          : `This automation cannot be published yet — ${errors.length} problems.`,
        400, 'validation_failed', issues,
      );
    }
    const warnings = issues.filter((i) => i.level === 'warning');
    if (warnings.length && !acknowledge) {
      res.status(409).json({
        ok: false,
        needs_acknowledgement: true,
        issues: warnings,
      });
      return;
    }

    // Every send in the definition is rendered against the example values
    // before anything goes live, so a template with a typo in a merge field
    // is caught here rather than by a client reading "{clietn_name}".
    const templateProblems: Array<{ node: string; message: string }> = [];
    for (const node of parsed.data.nodes) {
      if (node.type !== 'send_email' && node.type !== 'send_sms') continue;
      for (const text of [node.body, node.type === 'send_email' ? node.subject : undefined]) {
        if (!text) continue;
        for (const issue of validateTemplate(text)) {
          templateProblems.push({ node: node.key, message: issue.message });
        }
      }
    }
    if (templateProblems.length) {
      throw new AppError(
        templateProblems[0]!.message, 400, 'template_invalid', templateProblems,
      );
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE automation_versions
            SET published_at = now(), published_by = $3, validation = $4::jsonb
          WHERE automation_id = $1 AND version = $2`,
        [automation.id, top.version, user.id, JSON.stringify({ issues })],
      );
      await client.query(
        `UPDATE automations SET status = 'active', published_version = $2 WHERE id = $1`,
        [automation.id, top.version],
      );
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'automation.publish',
      entityType: 'automation',
      entityId: automation.id,
      summary: `"${automation.name}" version ${top.version} published and running`,
      after: { version: top.version, warnings: warnings.map((w) => w.message) },
    });

    res.json({ ok: true, version: top.version, issues });
  }),
);

/**
 * Pause or resume the automation itself.
 *
 * Pausing stops NEW enrollments. It deliberately does not touch the ones
 * already running: silently abandoning fifty clients mid-sequence is a
 * bigger surprise than letting them finish. `?stop_running=1` ends them, and
 * says so in the response.
 */
automationRoutes.post(
  '/automations/:id/status',
  requirePermission('automation.publish'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      status: z.enum(['active', 'paused', 'archived']),
      stop_running: z.boolean().default(false),
      reason: z.string().trim().optional(),
    }).parse(req.body);

    const automation = await queryOne<{ id: string; name: string; published_version: number | null }>(
      `SELECT id, name, published_version FROM automations
        WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id],
    );
    if (!automation) throw notFound('That automation');
    if (body.status === 'active' && !automation.published_version) {
      throw new AppError('Publish this automation before setting it running.', 400);
    }

    await query(`UPDATE automations SET status = $2 WHERE id = $1`, [automation.id, body.status]);

    let stopped = 0;
    if (body.stop_running || body.status === 'archived') {
      const { rowCount } = await query(
        `UPDATE automation_enrollments
            SET status = 'stopped', stopped_at = now(), stopped_by = $2,
                stopped_reason = $3
          WHERE automation_id = $1 AND status IN ('active','paused')`,
        [automation.id, user.id,
         body.reason ?? `The automation was ${body.status === 'archived' ? 'archived' : 'stopped'}`],
      );
      stopped = rowCount ?? 0;
    }

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'automation.status',
      entityType: 'automation',
      entityId: automation.id,
      summary: `"${automation.name}" set to ${body.status}` +
        (stopped ? `, ending ${stopped} running enrollment(s)` : ''),
    });

    res.json({ ok: true, status: body.status, enrollments_stopped: stopped });
  }),
);

// ── Previewing a template ──────────────────────────────────────────────────

automationRoutes.post(
  '/automations/preview',
  requirePermission('automation.view'),
  asyncRoute(async (req, res) => {
    const body = z.object({ body: z.string(), subject: z.string().optional() }).parse(req.body);
    res.json({
      body: previewTemplate(body.body),
      subject: body.subject ? previewTemplate(body.subject) : null,
      issues: [...validateTemplate(body.body),
               ...(body.subject ? validateTemplate(body.subject) : [])],
    });
  }),
);

// ── Enrollments ────────────────────────────────────────────────────────────

automationRoutes.get(
  '/automations/:id/enrollments',
  requirePermission('automation.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = z.object({
      status: z.enum(['active', 'paused', 'completed', 'stopped', 'failed', 'all']).default('active'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);

    const params: unknown[] = [req.params.id, user.organization_id, q.limit];
    const filter = q.status === 'all' ? '' : `AND e.status = $4`;
    if (q.status !== 'all') params.push(q.status);

    const { rows } = await query(
      `SELECT e.id, e.status, e.current_node_key, e.next_run_at, e.enrolled_at,
              e.steps_completed, e.messages_sent, e.stopped_reason, e.last_error,
              c.id AS customer_id, c.first_name, c.last_name,
              app.id AS application_id, app.portal_reference
         FROM automation_enrollments e
         JOIN customers c ON c.id = e.customer_id
         LEFT JOIN applications app ON app.id = e.application_id
        WHERE e.automation_id = $1 AND e.organization_id = $2 ${filter}
        ORDER BY e.enrolled_at DESC LIMIT $3`,
      params,
    );
    res.json({ enrollments: rows });
  }),
);

/**
 * Every automation touching one client, with every step it has taken.
 *
 * This is the tab a broker opens before a call, and the reason the engine
 * records a reason on every execution: "why did my client get that text" has
 * to be answerable in one screen.
 */
automationRoutes.get(
  '/customers/:id/automations',
  requirePermission('automation.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const { rows: enrollments } = await query<{ id: string }>(
      `SELECT e.id, e.status, e.current_node_key, e.next_run_at, e.enrolled_at,
              e.enrolled_reason, e.steps_completed, e.messages_sent,
              e.stopped_reason, e.stopped_at, e.completed_at, e.last_error,
              e.automation_version,
              a.id AS automation_id, a.name AS automation_name, a.purpose,
              v.definition
         FROM automation_enrollments e
         JOIN automations a ON a.id = e.automation_id
         LEFT JOIN automation_versions v
                ON v.automation_id = a.id AND v.version = e.automation_version
        WHERE e.customer_id = $1 AND e.organization_id = $2
        ORDER BY (e.status = 'active') DESC, e.enrolled_at DESC`,
      [req.params.id, user.organization_id],
    );

    const ids = enrollments.map((e) => e.id);
    const { rows: executions } = ids.length
      ? await query(
        `SELECT enrollment_id, node_key, node_type, at, outcome, reason, message_id, task_id
           FROM automation_executions WHERE enrollment_id = ANY($1::uuid[])
          ORDER BY at`,
        [ids],
      )
      : { rows: [] as Record<string, unknown>[] };

    res.json({
      enrollments: enrollments.map((e) => {
        const row = e as Record<string, unknown>;
        const parsed = DefinitionSchema.safeParse(row.definition);
        const definition = parsed.success ? parsed.data : null;
        const current = definition
          ? nodeByKey(definition, row.current_node_key as string | null)
          : null;
        return {
          ...row,
          // The client-facing tab never needs the whole graph, only where
          // this person is in it and what is left.
          definition: undefined,
          total_steps: definition?.nodes.length ?? null,
          current_step_label: current
            ? current.label ?? describeNode(current)
            : null,
          // Each step carries the label a person reads, not the internal
          // key. "a (send_email)" is meaningless to the broker on the phone
          // to the client asking why they got that email.
          steps: executions
            .filter((x) => x.enrollment_id === row.id)
            .map((x) => {
              const step = definition
                ? nodeByKey(definition, x.node_key as string)
                : null;
              return {
                ...x,
                label: step
                  ? step.label ?? describeNode(step as never)
                  : String(x.node_key),
              };
            }),
        };
      }),
    });
  }),
);

function describeNode(node: { type: string } & Record<string, unknown>): string {
  switch (node.type) {
    case 'send_email': return `Email: ${String(node.subject ?? 'no subject')}`;
    case 'send_sms': return 'Text message';
    case 'wait': return `Wait ${[
      node.days ? `${node.days}d` : '', node.hours ? `${node.hours}h` : '',
      node.minutes ? `${node.minutes}m` : '',
    ].filter(Boolean).join(' ') || 'no time'}`;
    case 'branch': return 'Branch';
    case 'create_task': return `Task: ${String(node.title ?? '')}`;
    case 'notify_user': return `Notify the ${String(node.role ?? 'broker')}`;
    case 'add_note': return 'Add a note';
    case 'add_tag': return `Tag "${String(node.tag ?? '')}"`;
    case 'set_stage': return `Move to ${String(node.stage_key ?? '')}`;
    case 'if_else': return 'If / Else';
    case 'goto': return 'Go to';
    case 'remove_tag': return `Remove tag "${String(node.tag ?? '')}"`;
    case 'update_contact': return `Update ${String(node.field ?? '').replace(/_/g, ' ')}`;
    case 'assign_user': return node.mode === 'round_robin' ? 'Assign by round robin' : 'Assign to a user';
    case 'request_documents': return 'Request documents';
    case 'internal_email': return `Internal email: ${String(node.subject ?? '')}`;
    case 'enroll_automation': return 'Add to another workflow';
    case 'stop_automation': return 'Remove from other workflows';
    case 'webhook': return 'Webhook';
    case 'stop': return 'End';
    default: return node.type;
  }
}

/**
 * The controls, all four of them, on one enrollment.
 *
 * Every one records who did it. "Skip" advances past the step the enrollment
 * is sitting on without running it — the escape hatch for the reminder that
 * is about to go out to somebody the broker has just spoken to.
 */
automationRoutes.post(
  '/enrollments/:id/:action',
  requirePermission('automation.control'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const action = z.enum(['pause', 'resume', 'skip', 'end', 'run']).parse(req.params.action);
    const reason = z.object({ reason: z.string().trim().optional() })
      .parse(req.body ?? {}).reason;

    const enrollment = await queryOne<{
      id: string; status: string; automation_id: string; automation_version: number;
      current_node_key: string | null; customer_id: string; next_run_at: string | null;
    }>(
      `SELECT e.id, e.status, e.automation_id, e.automation_version, e.current_node_key,
              e.customer_id, e.next_run_at
         FROM automation_enrollments e
        WHERE e.id = $1 AND e.organization_id = $2`,
      [req.params.id, user.organization_id],
    );
    if (!enrollment) throw notFound('That enrollment');

    const finished = enrollment.status === 'completed' || enrollment.status === 'stopped';
    if (finished && action !== 'end') {
      throw new AppError(
        `This sequence has already ${enrollment.status === 'completed' ? 'finished' : 'been stopped'}.`,
        409,
      );
    }

    let summary: string;
    let detail: Record<string, unknown> = {};

    switch (action) {
      case 'pause':
        // `next_run_at` is deliberately left alone. The due index only looks
        // at active rows, so a paused enrollment runs nothing — and keeping
        // the time means resuming puts the client back where they were
        // rather than firing the rest of the sequence at them at once, which
        // is the exact opposite of what somebody clicking "pause" wants.
        await query(
          `UPDATE automation_enrollments SET status = 'paused' WHERE id = $1`,
          [enrollment.id]);
        summary = 'Enrollment paused';
        detail = { was_due: enrollment.next_run_at };
        break;

      case 'resume': {
        // A step whose time passed while it was paused runs now; one still in
        // the future keeps its appointment.
        const due = enrollment.next_run_at ? new Date(enrollment.next_run_at) : new Date();
        const runAt = due.getTime() > Date.now() ? due : new Date();
        await query(
          `UPDATE automation_enrollments SET status = 'active', next_run_at = $2 WHERE id = $1`,
          [enrollment.id, runAt]);
        await enqueue('automation.step', { enrollmentId: enrollment.id }, {
          organizationId: user.organization_id,
          runAfter: runAt,
          dedupeKey: `automation.step:${enrollment.id}:resume:${runAt.getTime()}`,
        });
        summary = runAt.getTime() > Date.now() + 60_000
          ? `Enrollment resumed — the next step is still due ${due.toISOString()}`
          : 'Enrollment resumed';
        detail = { next_run_at: runAt.toISOString() };
        break;
      }

      case 'skip': {
        const version = await queryOne<{ definition: unknown }>(
          `SELECT definition FROM automation_versions
            WHERE automation_id = $1 AND version = $2`,
          [enrollment.automation_id, enrollment.automation_version]);
        const parsed = DefinitionSchema.safeParse(version?.definition);
        if (!parsed.success) throw new AppError('That automation version is not readable.', 500);
        const node = nodeByKey(parsed.data, enrollment.current_node_key);
        if (!node) throw new AppError('There is no step left to skip.', 400);
        // A branch has two possible nexts and skipping one would be choosing
        // for the engine, which is not what "skip" means.
        if (node.type === 'branch' || node.type === 'if_else') {
          throw new AppError('A branch cannot be skipped — pause or end the sequence instead.', 400);
        }
        const next = node.type === 'stop' ? null : node.next ?? null;
        await query(
          `UPDATE automation_enrollments
              SET current_node_key = $2, next_run_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
                  status = CASE WHEN $2::text IS NULL THEN 'completed' ELSE status END,
                  completed_at = CASE WHEN $2::text IS NULL THEN now() ELSE completed_at END
            WHERE id = $1`,
          [enrollment.id, next]);
        await query(
          `INSERT INTO automation_executions (enrollment_id, node_key, node_type, outcome, reason)
           VALUES ($1,$2,$3,'skipped',$4)`,
          [enrollment.id, node.key, node.type,
           reason ? `Skipped by ${user.name}: ${reason}` : `Skipped by ${user.name}`]);
        if (next) {
          await enqueue('automation.step', { enrollmentId: enrollment.id }, {
            organizationId: user.organization_id,
            dedupeKey: `automation.step:${enrollment.id}:${next}:skip:${Date.now()}`,
          });
        }
        summary = `Skipped "${node.label ?? node.key}"`;
        detail = { skipped: node.key, now_at: next };
        break;
      }

      case 'end':
        await query(
          `UPDATE automation_enrollments
              SET status = 'stopped', stopped_at = now(), stopped_by = $2, stopped_reason = $3,
                  next_run_at = NULL
            WHERE id = $1 AND status IN ('active','paused')`,
          [enrollment.id, user.id, reason ?? `Ended by ${user.name}`]);
        summary = 'Enrollment ended';
        break;

      case 'run': {
        // Running a step by hand, for a broker who does not want to wait for
        // the queue. It goes through `runStep`, so the stop check still runs.
        const outcome = await runStep(enrollment.id);
        summary = `Step run by hand — ${outcome.status}`;
        detail = outcome as unknown as Record<string, unknown>;
        break;
      }
    }

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: `automation.enrollment.${action}`,
      entityType: 'automation_enrollment',
      entityId: enrollment.id,
      summary: reason ? `${summary} — ${reason}` : summary,
      after: detail,
    });

    const updated = await queryOne(
      `SELECT status, current_node_key, next_run_at, stopped_reason
         FROM automation_enrollments WHERE id = $1`, [enrollment.id]);
    res.json({ ok: true, ...updated, detail });
  }),
);

/** Enrolling somebody by hand, for a `manual` automation. */
automationRoutes.post(
  '/automations/:id/enrol',
  requirePermission('automation.control'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      customer_id: z.string().uuid(),
      application_id: z.string().uuid().optional(),
      reason: z.string().trim().optional(),
    }).parse(req.body);

    const automation = await queryOne<{
      id: string; key: string; name: string; status: string;
      purpose: 'transactional' | 'marketing' | 'service';
      allow_reenrollment: boolean; reenrollment_cooldown_days: number | null;
      published_version: number | null; definition: unknown; version: number;
    }>(
      `SELECT a.id, a.key, a.name, a.purpose, a.status, a.allow_reenrollment,
              a.reenrollment_cooldown_days, a.published_version, v.definition, v.version
         FROM automations a
         JOIN automation_versions v ON v.automation_id = a.id AND v.version = a.published_version
        WHERE a.id = $1 AND a.organization_id = $2`,
      [req.params.id, user.organization_id],
    );
    if (!automation) throw notFound('A published version of that automation');
    if (automation.status !== 'active') {
      throw new AppError('That automation is not running. Set it active first.', 400);
    }

    const parsed = DefinitionSchema.safeParse(automation.definition);
    if (!parsed.success) throw new AppError('That automation version is not readable.', 500);

    const enrollmentId = await enrol(
      { ...automation, definition: parsed.data },
      user.organization_id, body.customer_id, body.application_id ?? null,
      body.reason ?? `Enrolled by ${user.name}`, user.id,
    );
    if (!enrollmentId) {
      // Say which of the two guards refused, not whichever one is more
      // likely: "inside the cooldown" when the truth is "already running"
      // sends somebody to wait for a date that will never help them.
      const existing = await queryOne<{ id: string; status: string; enrolled_at: string }>(
        `SELECT id, status, enrolled_at FROM automation_enrollments
          WHERE automation_id = $1 AND customer_id = $2
          ORDER BY (status IN ('active','paused')) DESC, enrolled_at DESC LIMIT 1`,
        [automation.id, body.customer_id],
      );
      const live = existing && (existing.status === 'active' || existing.status === 'paused');
      throw new AppError(
        live
          ? `This client is already ${existing.status === 'paused' ? 'enrolled (paused)' : 'part way through'} this automation.`
          : automation.allow_reenrollment
            ? `This client finished this automation on ` +
              `${new Date(existing?.enrolled_at ?? Date.now()).toLocaleDateString('en-CA')}, ` +
              `inside the ${automation.reenrollment_cooldown_days}-day re-enrolment cooldown.`
            : 'This client has already been through this automation, which does not allow re-enrolment.',
        409, 'already_enrolled', existing ? { enrollment_id: existing.id, status: existing.status } : undefined,
      );
    }

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'automation.enrol',
      entityType: 'automation_enrollment',
      entityId: enrollmentId,
      summary: `Enrolled a client into "${automation.name}" by hand`,
    });

    res.status(201).json({ id: enrollmentId });
  }),
);

// ── Duplicating ───────────────────────────────────────────────────────────

/** A copy of the latest version, as a new draft nobody is enrolled in. */
automationRoutes.post(
  '/automations/:id/duplicate',
  requirePermission('automation.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const source = await queryOne<{ id: string; name: string; description: string | null; purpose: string;
                                    allow_reenrollment: boolean; reenrollment_cooldown_days: number | null;
                                    definition: unknown }>(
      `SELECT a.id, a.name, a.description, a.purpose, a.allow_reenrollment, a.reenrollment_cooldown_days,
              (SELECT v.definition FROM automation_versions v WHERE v.automation_id = a.id
                ORDER BY v.version DESC LIMIT 1) AS definition
         FROM automations a WHERE a.id = $1 AND a.organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!source) throw notFound('That automation');
    const name = `${source.name} (copy)`;
    const id = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO automations (organization_id, key, name, description, purpose, status, created_by,
                                  allow_reenrollment, reenrollment_cooldown_days)
         VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8) RETURNING id`,
        [user.organization_id, `${slug(name)}_${Date.now().toString(36)}`, name, source.description,
         source.purpose, user.id, source.allow_reenrollment, source.reenrollment_cooldown_days]);
      await client.query(
        `INSERT INTO automation_versions (automation_id, version, definition) VALUES ($1,1,$2::jsonb)`,
        [rows[0]!.id, JSON.stringify(source.definition)]);
      return rows[0]!.id;
    });
    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'automation.create', entityType: 'automation', entityId: id,
      summary: `Automation "${name}" created as a copy of "${source.name}"`,
    });
    res.status(201).json({ id });
  }),
);

// ── Testing ────────────────────────────────────────────────────────────────

/**
 * Walk the workflow against one real client without doing anything: which
 * triggers' filters pass, whether they would be let in, and the path the
 * steps would take today. The draft on screen is tested if it is sent, so a
 * change can be checked before it is saved.
 */
automationRoutes.post(
  '/automations/:id/test',
  requirePermission('automation.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      customer_id: z.string().uuid(),
      application_id: z.string().uuid().optional(),
      definition: z.unknown().optional(),
    }).parse(req.body);
    const exists = await queryOne('SELECT 1 FROM automations WHERE id = $1 AND organization_id = $2',
      [req.params.id, user.organization_id]);
    if (!exists) throw notFound('That automation');
    const customer = await queryOne('SELECT 1 FROM customers WHERE id = $1 AND organization_id = $2',
      [body.customer_id, user.organization_id]);
    if (!customer) throw notFound('That client');
    let raw = body.definition;
    if (raw === undefined) {
      raw = (await queryOne<{ definition: unknown }>(
        `SELECT definition FROM automation_versions WHERE automation_id = $1 ORDER BY version DESC LIMIT 1`,
        [req.params.id]))?.definition;
    }
    const definition = DefinitionSchema.parse(raw);
    const result = await dryRun(definition, user.organization_id, body.customer_id, body.application_id ?? null);
    // The facts are what the conditions were tested against — shown so a
    // surprising branch can be explained — minus anything empty.
    const facts = Object.fromEntries(Object.entries(result.facts)
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object'));
    res.json({ ...result, facts });
  }),
);

// ── The execution log ──────────────────────────────────────────────────────

automationRoutes.get(
  '/automations/:id/executions',
  requirePermission('automation.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = z.object({
      outcome: z.enum(['executed', 'skipped', 'failed', 'branched', 'waiting', 'suppressed', 'all']).default('all'),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);
    const params: unknown[] = [req.params.id, user.organization_id, q.limit];
    const filter = q.outcome === 'all' ? '' : 'AND x.outcome = $4';
    if (q.outcome !== 'all') params.push(q.outcome);
    const { rows } = await query(
      `SELECT x.id, x.at, x.node_key, x.node_type, x.outcome, x.reason, x.message_id, x.task_id,
              e.id AS enrollment_id, e.automation_version, c.id AS customer_id, c.first_name, c.last_name,
              e.application_id, v.definition
         FROM automation_executions x
         JOIN automation_enrollments e ON e.id = x.enrollment_id
         JOIN customers c ON c.id = e.customer_id
         LEFT JOIN automation_versions v ON v.automation_id = e.automation_id AND v.version = e.automation_version
        WHERE e.automation_id = $1 AND e.organization_id = $2 ${filter}
        ORDER BY x.at DESC, x.id DESC LIMIT $3`,
      params);
    res.json({
      executions: rows.map((row) => {
        const r = row as Record<string, unknown>;
        const parsed = DefinitionSchema.safeParse(r.definition);
        const step = parsed.success ? nodeByKey(parsed.data, String(r.node_key)) : null;
        return { ...r, definition: undefined, label: step ? step.label ?? describeNode(step as never) : r.node_key };
      }),
    });
  }),
);

async function freeKey(organizationId: string, base: string): Promise<string> {
  const taken = await queryOne(
    'SELECT 1 FROM automations WHERE organization_id = $1 AND key = $2', [organizationId, base]);
  return taken ? `${base}_${Date.now().toString(36)}` : base;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48)
    || `automation_${Date.now()}`;
}
