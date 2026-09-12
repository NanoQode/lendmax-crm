/**
 * The administration screens: users, the vocabularies, templates, and the
 * dated settings a person is accountable for.
 *
 * Mounted under `/admin` rather than `/settings`, because systemRoutes
 * already serves `/settings/:key` — the generic dated-setting accessor — and
 * a route parameter matches anything. Mounting this router first instead
 * would have worked for the paths and broken `/health`, since router-level
 * `requireAuth` runs for every request entering a router, matched or not.
 *
 * TWO KINDS OF THING LIVE HERE, AND THEY BEHAVE DIFFERENTLY.
 *
 * Vocabularies — stages, transaction types, dispositions, document
 * categories — are the brokerage's own language. They are edited freely, and
 * deactivated rather than deleted: a disposition removed from the list must
 * not make last year's lost files read as having no reason.
 *
 * Compliance-shaped settings — consent rules, quiet hours, retention
 * periods, the risk model — are DATED and SOURCED. Every one of them is a
 * legal or regulatory question with an answer that was true on a date, and
 * changing one writes a new row rather than overwriting the old. "What rule
 * were we applying in March" has to be answerable.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../db/pool.ts';
import { recordAudit } from '../../services/audit.ts';
import { asyncRoute, AppError, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';
import { can, PERMISSIONS, ROLES } from '../../domain/permissions.ts';
import { validateTemplate, fieldsUsedBy, MERGE_FIELDS } from '../../domain/merge-fields.ts';
import { EVALUATORS } from '../../domain/risk.ts';
import { DEFAULT_CONSENT_RULES } from '../../domain/consent.ts';

export const settingsRoutes: Router = Router();
settingsRoutes.use(requireAuth);

// ── Vocabularies ───────────────────────────────────────────────────────────

/**
 * The four lists, and what each is allowed to do.
 *
 * `category` on a stage is deliberately constrained: the pipeline machine
 * reads it, and a stage whose category is misspelled silently stops files
 * counting as won.
 */
const VOCABULARIES = {
  stages: {
    table: 'pipeline_stages',
    label: 'pipeline stage',
    columns: ['key', 'label', 'position', 'category', 'probability', 'colour',
              'entry_rules', 'active'],
    jsonColumns: ['entry_rules'],
    arrayColumns: [],
  },
  transaction_types: {
    table: 'transaction_types',
    label: 'transaction type',
    columns: ['key', 'label', 'position', 'portal_purpose', 'required_documents', 'active'],
    jsonColumns: [],
    arrayColumns: ['required_documents'],
  },
  dispositions: {
    table: 'lost_dispositions',
    label: 'disposition',
    columns: ['key', 'label', 'position', 'requires_note', 'reactivation_days',
              'nurture_eligible', 'active'],
    jsonColumns: [],
    arrayColumns: [],
  },
  document_categories: {
    table: 'document_categories',
    label: 'document category',
    columns: ['key', 'label', 'position', 'group_key', 'client_visible', 'sensitive', 'active'],
    jsonColumns: [],
    arrayColumns: [],
  },
} as const;

type VocabularyName = keyof typeof VOCABULARIES;

settingsRoutes.get(
  '/admin/vocabularies/:name',
  requirePermission('settings.view'),
  asyncRoute(async (req, res) => {
    const name = z.enum(['stages', 'transaction_types', 'dispositions', 'document_categories'])
      .parse(req.params.name) as VocabularyName;
    const spec = VOCABULARIES[name];
    const user = req.user!;

    const { rows } = await query(
      `SELECT * FROM ${spec.table} WHERE organization_id = $1
        ORDER BY position, label`, [user.organization_id]);

    // How many records use each entry. Deactivating one that is in use is
    // fine; the screen should say so rather than let somebody discover it.
    const usage = await usageCounts(name, user.organization_id);

    res.json({ items: rows, usage, can_edit: can(user, 'settings.manage') });
  }),
);

async function usageCounts(
  name: VocabularyName,
  organizationId: string,
): Promise<Record<string, number>> {
  const sql: Record<VocabularyName, string> = {
    stages: `SELECT stage_key AS key, count(*)::int AS count FROM applications
              WHERE organization_id = $1 GROUP BY 1`,
    transaction_types: `SELECT transaction_type_key AS key, count(*)::int AS count
                          FROM applications WHERE organization_id = $1
                           AND transaction_type_key IS NOT NULL GROUP BY 1`,
    dispositions: `SELECT lost_disposition_key AS key, count(*)::int AS count
                     FROM applications WHERE organization_id = $1
                      AND lost_disposition_key IS NOT NULL GROUP BY 1`,
    document_categories: `SELECT category_key AS key, count(*)::int AS count FROM documents
                            WHERE organization_id = $1 AND category_key IS NOT NULL GROUP BY 1`,
  };
  const { rows } = await query<{ key: string; count: number }>(sql[name], [organizationId]);
  return Object.fromEntries(rows.map((r) => [r.key, r.count]));
}

settingsRoutes.put(
  '/admin/vocabularies/:name',
  requirePermission('settings.manage'),
  asyncRoute(async (req, res) => {
    const name = z.enum(['stages', 'transaction_types', 'dispositions', 'document_categories'])
      .parse(req.params.name) as VocabularyName;
    const spec = VOCABULARIES[name];
    const user = req.user!;
    const body = z.object({
      items: z.array(z.record(z.string(), z.unknown())).min(1),
    }).parse(req.body);

    // A brokerage with no won stage has a pipeline nothing can ever be
    // funded into, and the failure appears weeks later at the first funding.
    if (name === 'stages') {
      const active = body.items.filter((i) => i.active !== false);
      if (!active.some((i) => i.category === 'won')) {
        throw new AppError(
          'At least one active stage has to be the one that means funded. Nothing can be '
          + 'funded otherwise.', 400);
      }
      if (!active.some((i) => i.category === 'lost')) {
        throw new AppError('At least one active stage has to mean lost.', 400);
      }
    }

    const before = await query(`SELECT * FROM ${spec.table} WHERE organization_id = $1`,
      [user.organization_id]);

    // Validated before anything is written, so a list with a mistake halfway
    // down does not leave the first half applied.
    const keys = new Set<string>();
    for (const item of body.items) {
      const key = String(item.key ?? '').trim();
      if (!/^[a-z0-9_]+$/.test(key)) {
        throw new AppError(
          `"${key || '(blank)'}" is not a usable key. Use lower case, digits and underscores.`,
          400);
      }
      if (keys.has(key)) throw new AppError(`Two entries share the key "${key}".`, 400);
      keys.add(key);
    }

    await withTransaction(async (client) => {
      for (const [position, item] of body.items.entries()) {
        const key = String(item.key ?? '').trim();

        // Only the columns this item actually carries. Sending NULL for the
        // rest would hit a NOT NULL constraint on columns that have perfectly
        // good defaults — a settings screen should not have to know every
        // column of every vocabulary table to add one entry.
        const columns = spec.columns.filter(
          (column) => column === 'key' || column === 'position'
            || item[column] !== undefined);
        const values = columns.map((column) => {
          if (column === 'position') return position * 10;
          const value = item[column];
          if ((spec.jsonColumns as readonly string[]).includes(column)) {
            return JSON.stringify(value ?? {});
          }
          if ((spec.arrayColumns as readonly string[]).includes(column)) {
            return Array.isArray(value) ? value : [];
          }
          return value;
        });

        await client.query(
          `INSERT INTO ${spec.table} (organization_id, ${columns.join(', ')})
           VALUES ($1, ${columns.map((c, i) =>
             `$${i + 2}${(spec.jsonColumns as readonly string[]).includes(c) ? '::jsonb' : ''}`
           ).join(', ')})
           ON CONFLICT (organization_id, key) DO UPDATE SET
             ${columns.filter((c) => c !== 'key')
               .map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
          [user.organization_id, ...values]);
      }

      // Anything left off the list is DEACTIVATED, never deleted. A
      // disposition removed from the list must not make last year's lost
      // files read as having no reason.
      await client.query(
        `UPDATE ${spec.table} SET active = false
          WHERE organization_id = $1 AND key <> ALL($2::text[])`,
        [user.organization_id, [...keys]]);
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'settings.vocabulary',
      entityType: 'vocabulary',
      entityId: name,
      summary: `The ${spec.label} list was changed (${body.items.length} entries)`,
      before: before.rows,
      after: body.items,
    });

    res.json({ ok: true });
  }),
);

// ── Users ──────────────────────────────────────────────────────────────────

settingsRoutes.get(
  '/admin/users',
  requirePermission('user.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const { rows } = await query(
      `SELECT u.id, u.email, u.name, u.role, u.active, u.mfa_enabled, u.last_login_at,
              u.permission_overrides, u.created_at, u.locked_until,
              p.mobile_phone, p.title, p.licence_number,
              (SELECT count(*)::int FROM assignments a
                WHERE a.user_id = u.id AND a.unassigned_at IS NULL) AS open_assignments
         FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.organization_id = $1
        ORDER BY u.active DESC, u.name`, [user.organization_id]);

    res.json({
      users: rows,
      roles: Object.entries(ROLES).map(([key, role]) => ({
        key, name: role.name, description: role.description, permissions: role.permissions,
      })),
      permissions: PERMISSIONS,
      can_edit: can(user, 'user.manage'),
    });
  }),
);

settingsRoutes.post(
  '/admin/users',
  requirePermission('user.manage'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      email: z.string().email('That is not an email address.'),
      name: z.string().trim().min(1),
      role: z.enum(['broker', 'underwriter', 'manager', 'compliance_manager', 'technical_admin']),
      title: z.string().trim().optional(),
      mobile_phone: z.string().trim().optional(),
      licence_number: z.string().trim().optional(),
    }).parse(req.body);

    const created = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, email, name, role, active, profile_complete,
                            created_by)
         VALUES ($1,$2,$3,$4,true,false,$5)
         RETURNING id`,
        [user.organization_id, body.email, body.name, body.role, user.id]);
      const id = rows[0]!.id;
      await client.query(
        `INSERT INTO user_profiles (user_id, title, mobile_phone, licence_number)
         VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO NOTHING`,
        [id, body.title ?? null, body.mobile_phone ?? null, body.licence_number ?? null]);
      return id;
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'user.create',
      entityType: 'user',
      entityId: created,
      summary: `${body.name} added as ${body.role.replace(/_/g, ' ')}`,
    });

    // No password is set here. The account is created inactive-until-invited
    // rather than with a password an administrator chose and emailed.
    res.status(201).json({ id: created, note: 'Send them an invitation to set a password.' });
  }),
);

settingsRoutes.put(
  '/admin/users/:id',
  requirePermission('user.manage'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      name: z.string().trim().min(1).optional(),
      role: z.enum(['broker', 'underwriter', 'manager', 'compliance_manager', 'technical_admin'])
        .optional(),
      active: z.boolean().optional(),
      title: z.string().trim().optional(),
      mobile_phone: z.string().trim().optional(),
      licence_number: z.string().trim().optional(),
      permission_overrides: z.record(z.string(), z.boolean()).optional(),
      override_reason: z.string().trim().optional(),
    }).parse(req.body);

    const target = await queryOne<{
      id: string; name: string; role: string; active: boolean;
      permission_overrides: Record<string, boolean>;
    }>(
      `SELECT id, name, role, active, permission_overrides FROM users
        WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!target) throw notFound('That user');

    // Nobody removes their own access, and nobody leaves the brokerage with
    // no technical admin — both are how an organisation locks itself out.
    if (target.id === user.id && body.active === false) {
      throw new AppError('You cannot deactivate your own account.', 400);
    }
    if (target.id === user.id && body.role && body.role !== target.role) {
      throw new AppError('You cannot change your own role.', 400);
    }
    if ((body.active === false || (body.role && body.role !== 'technical_admin'))
        && target.role === 'technical_admin') {
      const others = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM users
          WHERE organization_id = $1 AND role = 'technical_admin' AND active AND id <> $2`,
        [user.organization_id, target.id]);
      if (!others?.count) {
        throw new AppError(
          'That is the only technical admin. Appoint another one first, or the brokerage '
          + 'locks itself out of its own settings.', 400);
      }
    }
    if (body.permission_overrides && !can(user, 'user.manage')) {
      throw new AppError('You cannot grant permissions.', 403);
    }
    if (body.permission_overrides && Object.keys(body.permission_overrides).length
        && !body.override_reason) {
      // An override is an exception to the role model. It is auditable, and
      // an exception with no stated reason cannot be reviewed later.
      throw new AppError('Say why this account needs an exception to its role.', 400);
    }

    await withTransaction(async (client) => {
      const fields: string[] = [];
      const params: unknown[] = [target.id];
      for (const [column, value] of Object.entries({
        name: body.name, role: body.role, active: body.active,
      })) {
        if (value === undefined) continue;
        params.push(value);
        fields.push(`${column} = $${params.length}`);
      }
      if (body.permission_overrides) {
        params.push(JSON.stringify(body.permission_overrides));
        fields.push(`permission_overrides = $${params.length}::jsonb`);
      }
      if (fields.length) {
        await client.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $1`, params);
      }
      if (body.title !== undefined || body.mobile_phone !== undefined
          || body.licence_number !== undefined) {
        await client.query(
          `INSERT INTO user_profiles (user_id, title, mobile_phone, licence_number)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id) DO UPDATE SET
             title = COALESCE(EXCLUDED.title, user_profiles.title),
             mobile_phone = COALESCE(EXCLUDED.mobile_phone, user_profiles.mobile_phone),
             licence_number = COALESCE(EXCLUDED.licence_number, user_profiles.licence_number)`,
          [target.id, body.title ?? null, body.mobile_phone ?? null,
           body.licence_number ?? null]);
      }
      // Deactivating somebody leaves their files assigned to nobody, which
      // is worse than leaving them assigned to a deactivated person — so the
      // assignments are kept and the dashboard's "unassigned" count is what
      // surfaces it.
      if (body.active === false) {
        await client.query(
          `UPDATE sessions SET revoked_at = now()
            WHERE user_id = $1 AND revoked_at IS NULL`, [target.id]);
      }
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'user.update',
      entityType: 'user',
      entityId: target.id,
      summary: body.active === false ? `${target.name} deactivated and signed out`
        : body.role ? `${target.name} changed to ${body.role.replace(/_/g, ' ')}`
        : body.permission_overrides
          ? `${target.name} given a permission exception — ${body.override_reason}`
          : `${target.name} updated`,
      before: { role: target.role, active: target.active,
                permission_overrides: target.permission_overrides },
      after: body,
    });

    res.json({ ok: true });
  }),
);

// ── Templates ──────────────────────────────────────────────────────────────

settingsRoutes.get(
  '/admin/templates',
  requirePermission('settings.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const { rows } = await query(
      `SELECT t.*, u.name AS created_by_name,
              (SELECT count(*)::int FROM messages m WHERE m.template_key = t.key) AS sends
         FROM templates t LEFT JOIN users u ON u.id = t.created_by
        WHERE t.organization_id = $1 ORDER BY t.kind, t.name`, [user.organization_id]);
    res.json({ templates: rows, merge_fields: MERGE_FIELDS,
               can_edit: can(user, 'template.manage') });
  }),
);

settingsRoutes.put(
  '/admin/templates/:key',
  requirePermission('template.manage'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const key = z.string().regex(/^[a-z0-9_]+$/).parse(req.params.key);
    const body = z.object({
      name: z.string().trim().min(1),
      channel: z.enum(['email', 'sms']),
      kind: z.enum(['personal', 'campaign', 'system', 'document_request', 'appointment'])
        .default('personal'),
      purpose: z.enum(['transactional', 'marketing', 'service']).default('transactional'),
      subject: z.string().trim().nullable().optional(),
      body_text: z.string(),
      transaction_types: z.array(z.string()).default([]),
      active: z.boolean().default(true),
    }).parse(req.body);

    // Validated when it is written, not when it reaches a client.
    const issues = [
      ...validateTemplate(body.body_text),
      ...(body.subject ? validateTemplate(body.subject) : []),
    ];
    if (issues.length) {
      throw new AppError(issues[0]!.message, 400, 'invalid_template', issues);
    }
    if (body.channel === 'email' && !body.subject?.trim()) {
      throw new AppError('An email template needs a subject.', 400);
    }

    const fields = [...new Set([
      ...fieldsUsedBy(body.body_text),
      ...(body.subject ? fieldsUsedBy(body.subject) : []),
    ])];

    await query(
      `INSERT INTO templates (organization_id, key, name, channel, kind, purpose, subject,
                              body_text, merge_fields, transaction_types, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (organization_id, key) DO UPDATE SET
         name = EXCLUDED.name, channel = EXCLUDED.channel, kind = EXCLUDED.kind,
         purpose = EXCLUDED.purpose, subject = EXCLUDED.subject,
         body_text = EXCLUDED.body_text, merge_fields = EXCLUDED.merge_fields,
         transaction_types = EXCLUDED.transaction_types, active = EXCLUDED.active`,
      [user.organization_id, key, body.name, body.channel, body.kind, body.purpose,
       body.subject ?? null, body.body_text, fields, body.transaction_types,
       body.active, user.id]);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'template.update',
      entityType: 'template',
      entityId: key,
      summary: `Template "${body.name}" saved`,
    });

    res.json({ ok: true, merge_fields: fields });
  }),
);

// ── The dated settings ─────────────────────────────────────────────────────

/**
 * Every compliance-shaped setting, in one place, each with what it is and
 * what it costs to get wrong.
 *
 * The `caution` on each is not decoration. These are the values somebody
 * will change on a Friday afternoon without reading the schema, and the
 * screen is the last place to say what depends on them.
 */
const DATED_SETTINGS = [
  {
    key: 'consent_rules',
    name: 'Consent rules',
    description: 'How long an implied consent lasts, whether marketing texts need express '
      + 'consent, and which words mean stop.',
    caution: 'These are CASL and CRTC questions. Record where the answer came from — a value '
      + 'with no source is a guess somebody will rely on.',
    defaults: DEFAULT_CONSENT_RULES,
    shape: 'consent_rules',
  },
  {
    key: 'quiet_hours',
    name: 'Quiet hours',
    description: 'When the CRM will not send, and what it does with a message that falls '
      + 'inside them.',
    caution: 'A text at 6am costs a client. Provincial rules differ; the strictest that '
      + 'applies to where you send is the one to set.',
    defaults: { start: '21:00', end: '08:00', timezone: 'America/Toronto',
                appliesTo: ['sms', 'email'], behaviour: 'hold' },
    shape: 'quiet_hours',
  },
  {
    key: 'business_calendar',
    name: 'Business days and holidays',
    description: 'Which days count when the CRM says "three business days", and which '
      + 'holidays it observes.',
    caution: 'Closing-date arithmetic reads this. A missing statutory holiday makes a '
      + 'deadline look a day further away than it is.',
    defaults: { workingDays: [1, 2, 3, 4, 5], holidays: [] },
    shape: 'business_calendar',
  },
  {
    key: 'mailing_address',
    name: 'Brokerage mailing address',
    description: 'Printed in the footer of every commercial message.',
    caution: 'CASL requires it. A marketing campaign cannot be sent while this is blank.',
    defaults: { address: '' },
    shape: 'mailing_address',
  },
  {
    key: 'risk_bands',
    name: 'Risk bands',
    description: 'The score at which a file is rated medium, and the score at which it is '
      + 'rated high.',
    caution: 'Changing these re-rates nothing that was already assessed — an assessment '
      + 'records the model version that produced it.',
    defaults: { medium: 3, high: 7 },
    shape: 'risk_bands',
  },
] as const;

settingsRoutes.get(
  '/admin/settings',
  requirePermission('settings.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const { rows } = await query<{
      key: string; value: unknown; effective_from: string; source_note: string | null;
      updated_at: string; updated_by_name: string | null;
    }>(
      `SELECT DISTINCT ON (s.key) s.key, s.value, s.effective_from, s.source_note,
              s.updated_at, u.name AS updated_by_name
         FROM settings s LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.organization_id = $1 AND s.effective_from <= CURRENT_DATE
        ORDER BY s.key, s.effective_from DESC`,
      [user.organization_id]);
    const byKey = new Map(rows.map((r) => [r.key, r]));

    const history = await query(
      `SELECT s.key, s.value, s.effective_from, s.source_note, u.name AS updated_by_name
         FROM settings s LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.organization_id = $1 ORDER BY s.key, s.effective_from DESC`,
      [user.organization_id]);

    const retention = await query(
      `SELECT * FROM retention_policies WHERE organization_id = $1 ORDER BY entity_type`,
      [user.organization_id]);

    const riskFactors = await query(
      `SELECT * FROM risk_factor_definitions WHERE organization_id = $1
        ORDER BY model_version DESC, factor_key`, [user.organization_id]);

    const organization = await queryOne(
      `SELECT id, name, legal_name, regulator, licence_number, home_province, timezone,
              website, main_phone, support_email
         FROM organizations WHERE id = $1`, [user.organization_id]);

    res.json({
      organization,
      settings: DATED_SETTINGS.map((spec) => ({
        ...spec,
        current: byKey.get(spec.key)?.value ?? spec.defaults,
        is_default: !byKey.has(spec.key),
        effective_from: byKey.get(spec.key)?.effective_from ?? null,
        source_note: byKey.get(spec.key)?.source_note ?? null,
        updated_by_name: byKey.get(spec.key)?.updated_by_name ?? null,
        history: history.rows.filter((h) => h.key === spec.key),
      })),
      retention_policies: retention.rows,
      risk_factors: riskFactors.rows,
      risk_evaluators: Object.keys(EVALUATORS),
      can_edit: can(user, 'settings.manage'),
    });
  }),
);

/**
 * Retention.
 *
 * `action` is capped at 'review' unless somebody deliberately sets otherwise,
 * and the screen says what that means. Nothing in this system deletes a
 * mortgage record on a schedule nobody approved.
 */
settingsRoutes.put(
  '/admin/retention/:key',
  requirePermission('settings.manage'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const key = z.string().regex(/^[a-z0-9_]+$/).parse(req.params.key);
    const body = z.object({
      name: z.string().trim().min(1),
      entity_type: z.string().trim().min(1),
      anchor: z.enum(['funded_at', 'closed_at', 'last_activity_at', 'created_at',
                      'maturity_date']),
      retain_months: z.number().int().min(1).max(1200),
      action: z.enum(['review', 'anonymise', 'delete']).default('review'),
      source_note: z.string().trim().optional(),
      active: z.boolean().default(true),
      acknowledge_destructive: z.boolean().default(false),
    }).parse(req.body);

    if (body.action !== 'review' && !body.acknowledge_destructive) {
      throw new AppError(
        `Setting this to "${body.action}" means the retention runner will ${body.action} `
        + 'records without anybody looking at them first. Confirm that is what you intend.',
        409, 'needs_acknowledgement');
    }
    if (body.action !== 'review' && !body.source_note) {
      throw new AppError(
        'A policy that destroys records has to record where the retention period came from.',
        400);
    }

    const before = await queryOne(
      `SELECT * FROM retention_policies WHERE organization_id = $1 AND key = $2`,
      [user.organization_id, key]);

    await query(
      `INSERT INTO retention_policies (organization_id, key, name, entity_type, anchor,
                                       retain_months, action, source_note, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (organization_id, key) DO UPDATE SET
         name = EXCLUDED.name, entity_type = EXCLUDED.entity_type, anchor = EXCLUDED.anchor,
         retain_months = EXCLUDED.retain_months, action = EXCLUDED.action,
         source_note = EXCLUDED.source_note, active = EXCLUDED.active`,
      [user.organization_id, key, body.name, body.entity_type, body.anchor,
       body.retain_months, body.action, body.source_note ?? null, body.active]);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'settings.retention',
      entityType: 'retention_policy',
      entityId: key,
      summary: `Retention policy "${body.name}": ${body.retain_months} months from `
        + `${body.anchor.replace(/_/g, ' ')}, then ${body.action}`,
      before,
      after: body,
    });

    res.json({ ok: true });
  }),
);

/** The risk model's factors and weights. */
settingsRoutes.put(
  '/admin/risk-factors',
  requirePermission('settings.manage'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      model_key: z.string().default('standard'),
      factors: z.array(z.object({
        factor_key: z.string().regex(/^[a-z0-9_]+$/),
        label: z.string().trim().min(1),
        description: z.string().trim().optional(),
        weight: z.number().min(0).max(100),
        evaluator: z.string(),
        parameters: z.record(z.string(), z.unknown()).default({}),
        active: z.boolean().default(true),
      })).min(1),
      source_note: z.string().trim().optional(),
      new_version: z.boolean().default(false),
    }).parse(req.body);

    for (const factor of body.factors) {
      if (!(factor.evaluator in EVALUATORS)) {
        throw new AppError(
          `There is no evaluator called "${factor.evaluator}". A factor naming one that does `
          + 'not exist would not run, and the score would be missing it silently.', 400);
      }
    }

    const current = await queryOne<{ version: number }>(
      `SELECT max(model_version) AS version FROM risk_factor_definitions
        WHERE organization_id = $1 AND model_key = $2`,
      [user.organization_id, body.model_key]);
    // A new version rather than an edit, when asked: an assessment records
    // the model version that produced it, and rewriting a version in place
    // changes the meaning of every score recorded under it.
    const version = body.new_version ? (current?.version ?? 0) + 1 : (current?.version ?? 1);

    await withTransaction(async (client) => {
      for (const factor of body.factors) {
        await client.query(
          `INSERT INTO risk_factor_definitions (organization_id, model_key, model_version,
                                                factor_key, label, description, weight,
                                                evaluator, parameters, active, source_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
           ON CONFLICT (organization_id, model_key, model_version, factor_key) DO UPDATE SET
             label = EXCLUDED.label, description = EXCLUDED.description,
             weight = EXCLUDED.weight, evaluator = EXCLUDED.evaluator,
             parameters = EXCLUDED.parameters, active = EXCLUDED.active,
             source_note = EXCLUDED.source_note`,
          [user.organization_id, body.model_key, version, factor.factor_key, factor.label,
           factor.description ?? null, factor.weight, factor.evaluator,
           JSON.stringify(factor.parameters), factor.active, body.source_note ?? null]);
      }
      await client.query(
        `UPDATE risk_factor_definitions SET active = false
          WHERE organization_id = $1 AND model_key = $2 AND model_version = $3
            AND factor_key <> ALL($4::text[])`,
        [user.organization_id, body.model_key, version, body.factors.map((f) => f.factor_key)]);
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'settings.risk_model',
      entityType: 'risk_model',
      entityId: `${body.model_key}:${version}`,
      summary: body.new_version
        ? `Risk model ${body.model_key} version ${version} created with `
          + `${body.factors.length} factor(s)`
        : `Risk model ${body.model_key} version ${version} changed`,
      after: body.factors,
    });

    res.json({ ok: true, model_version: version });
  }),
);

/** The brokerage's own details. */
settingsRoutes.put(
  '/admin/organization',
  requirePermission('settings.manage'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      name: z.string().trim().min(1).optional(),
      legal_name: z.string().trim().optional(),
      regulator: z.string().trim().optional(),
      licence_number: z.string().trim().optional(),
      home_province: z.enum(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE',
                             'QC', 'SK', 'YT']).optional(),
      timezone: z.string().optional(),
      website: z.string().trim().optional(),
      main_phone: z.string().trim().optional(),
      support_email: z.string().trim().optional(),
    }).parse(req.body);

    const before = await queryOne('SELECT * FROM organizations WHERE id = $1',
      [user.organization_id]);

    const names = Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined);
    if (names.length) {
      await query(
        `UPDATE organizations SET ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')}
          WHERE id = $1`,
        [user.organization_id, ...names.map((n) => body[n as keyof typeof body])]);
    }

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'settings.organization',
      entityType: 'organization',
      entityId: user.organization_id,
      summary: 'Brokerage details changed',
      before,
      after: body,
    });

    res.json({ ok: true });
  }),
);
