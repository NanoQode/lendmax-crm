/**
 * Customers, applications, and the pipeline.
 *
 * Two things every list endpoint here does, because they are what keep the CRM
 * usable at a hundred thousand contacts rather than a hundred:
 *
 *   · Filtering, sorting and paging happen in Postgres. Nothing loads the
 *     customer table into Node and slices it there.
 *   · A broker without `customer.view_all` gets their own files, enforced by a
 *     clause in the query rather than by filtering the result afterwards —
 *     filtering afterwards still reads the rows, and still leaks the count.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../db/pool.ts';
import { recordAudit } from '../../services/audit.ts';
import { can } from '../../domain/permissions.ts';
import { evaluateTransition, transitionEffects, type FileSnapshot, type StageDefinition } from '../../domain/pipeline.ts';
import { daysToClose, todayIn } from '../../domain/dates.ts';
import { env } from '../../config/env.ts';
import { AppError, asyncRoute, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';
import { toE164 } from '../../lib/phone.ts';

export const customerRoutes: Router = Router();
customerRoutes.use(requireAuth);

// ── Helpers ────────────────────────────────────────────────────────────────

async function loadStages(organizationId: string): Promise<StageDefinition[]> {
  const { rows } = await query<StageDefinition>(
    `SELECT key, label, position, category, probability, active, entry_rules
       FROM pipeline_stages WHERE organization_id = $1 ORDER BY position`,
    [organizationId],
  );
  return rows.map((r) => ({ ...r, probability: r.probability === null ? null : Number(r.probability) }));
}

/**
 * The visibility clause. A broker sees files they are assigned to; anybody with
 * `customer.view_all` sees everything. Returned as SQL so it can be composed
 * into the query that does the paging, never applied to the rows afterwards.
 */
function visibilityClause(
  user: { id: string; role: string; permission_overrides: Record<string, boolean> },
  params: unknown[],
): string {
  if (can(user as never, 'customer.view_all')) return 'TRUE';
  params.push(user.id);
  return `EXISTS (
    SELECT 1 FROM assignments a
     WHERE a.application_id = app.id AND a.unassigned_at IS NULL AND a.user_id = $${params.length}
  )`;
}

const SORTABLE: Record<string, string> = {
  last_activity: 'app.last_activity_at',
  closing: 'app.closing_date',
  created: 'app.created_at',
  amount: 'app.amount_requested',
  name: 'c.last_name',
  stage: 'app.stage_key',
};

// ── The list ───────────────────────────────────────────────────────────────

const ListQuery = z.object({
  q: z.string().trim().optional(),
  stage: z.string().optional(),
  transaction_type: z.string().optional(),
  assigned_to: z.string().uuid().optional(),
  province: z.string().length(2).optional(),
  closing_before: z.string().optional(),
  closing_after: z.string().optional(),
  status: z.enum(['open', 'parked', 'won', 'lost', 'all']).default('all'),
  sort: z.enum(Object.keys(SORTABLE) as [string, ...string[]]).default('last_activity'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

customerRoutes.get(
  '/customers',
  requirePermission('customer.view'),
  asyncRoute(async (req, res) => {
    const q = ListQuery.parse(req.query);
    const user = req.user!;
    const params: unknown[] = [user.organization_id];
    const where: string[] = ['app.organization_id = $1', 'app.archived_at IS NULL'];

    where.push(visibilityClause(user, params));

    if (q.q) {
      // One parameter used across several columns. Searching the property
      // address as well as the name is what makes the box useful on the phone
      // when a client says "it's the Main Street one".
      params.push(`%${q.q.toLowerCase()}%`);
      const p = `$${params.length}`;
      const digits = q.q.replace(/\D/g, '');
      let phoneClause = '';
      if (digits.length >= 7) {
        params.push(`%${digits.slice(-10)}%`);
        phoneClause = ` OR regexp_replace(coalesce(c.phone_e164,''), '\\D', '', 'g') LIKE $${params.length}`;
      }
      where.push(`(
        lower(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) LIKE ${p}
        OR lower(coalesce(c.email,'')) LIKE ${p}
        OR lower(coalesce(app.portal_reference,'')) LIKE ${p}
        OR lower(coalesce(app.property_city,'')) LIKE ${p}
        OR lower(coalesce(app.property_street_name,'')) LIKE ${p}
        OR lower(coalesce(app.scarlett_deal_id,'')) LIKE ${p}
        ${phoneClause}
      )`);
    }
    if (q.stage) {
      params.push(q.stage);
      where.push(`app.stage_key = $${params.length}`);
    }
    if (q.transaction_type) {
      params.push(q.transaction_type);
      where.push(`app.transaction_type_key = $${params.length}`);
    }
    if (q.province) {
      params.push(q.province.toUpperCase());
      where.push(`app.property_province = $${params.length}`);
    }
    if (q.closing_before) {
      params.push(q.closing_before);
      where.push(`app.closing_date <= $${params.length}::date`);
    }
    if (q.closing_after) {
      params.push(q.closing_after);
      where.push(`app.closing_date >= $${params.length}::date`);
    }
    if (q.assigned_to) {
      params.push(q.assigned_to);
      where.push(`EXISTS (SELECT 1 FROM assignments a2 WHERE a2.application_id = app.id
                            AND a2.unassigned_at IS NULL AND a2.user_id = $${params.length})`);
    }
    if (q.status !== 'all') {
      params.push(q.status);
      where.push(`ps.category = $${params.length}`);
    }

    const orderColumn = SORTABLE[q.sort]!;
    params.push(q.limit, q.offset);

    const sql = `
      SELECT app.id, app.portal_reference, app.stage_key, app.status_key,
             app.transaction_type_key, app.amount_requested, app.closing_date,
             app.percent_complete, app.last_activity_at, app.next_task_at,
             app.next_appointment_at, app.documents_outstanding,
             app.scarlett_deal_id, app.scarlett_sync_state,
             app.property_street_number, app.property_street_name, app.property_city,
             app.property_province,
             c.id AS customer_id, c.first_name, c.last_name, c.email, c.phone_e164,
             c.awaiting_reply_since,
             ps.label AS stage_label, ps.category AS stage_category, ps.colour AS stage_colour,
             COALESCE(assignees.list, '[]'::json) AS assignees,
             COUNT(*) OVER () AS total_count
        FROM applications app
        JOIN customers c ON c.id = app.customer_id
        LEFT JOIN pipeline_stages ps
               ON ps.organization_id = app.organization_id AND ps.key = app.stage_key
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object('user_id', u.id, 'name', u.name,
                                            'role', a.role, 'primary', a.is_primary)
                          ORDER BY a.is_primary DESC, a.role) AS list
            FROM assignments a JOIN users u ON u.id = a.user_id
           WHERE a.application_id = app.id AND a.unassigned_at IS NULL
        ) assignees ON TRUE
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderColumn} ${q.direction === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS LAST'},
                app.id
       LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await query(sql, params);
    const today = todayIn(env.BROKERAGE_TIMEZONE);
    const total = rows.length ? Number((rows[0] as { total_count: number }).total_count) : 0;

    res.json({
      ok: true,
      total,
      limit: q.limit,
      offset: q.offset,
      customers: rows.map((r) => {
        const row = r as Record<string, unknown>;
        delete row.total_count;
        return {
          ...row,
          days_to_close: daysToClose(row.closing_date as string | null, today),
        };
      }),
    });
  }),
);

// ── The board ──────────────────────────────────────────────────────────────

customerRoutes.get(
  '/pipeline',
  requirePermission('customer.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const stages = await loadStages(user.organization_id);
    const params: unknown[] = [user.organization_id];
    const visibility = visibilityClause(user, params);

    // Capped per column. A board that renders four thousand cards in one
    // column is not a board; the count says what is there, the cards are the
    // top of it.
    const { rows } = await query(
      `SELECT * FROM (
         SELECT app.id, app.stage_key, app.amount_requested, app.closing_date,
                app.transaction_type_key, app.documents_outstanding,
                app.next_task_at, app.scarlett_sync_state, app.percent_complete,
                app.property_city, app.property_province,
                c.id AS customer_id, c.first_name, c.last_name, c.awaiting_reply_since,
                COALESCE(assignees.list, '[]'::json) AS assignees,
                ROW_NUMBER() OVER (PARTITION BY app.stage_key
                                   ORDER BY app.closing_date NULLS LAST, app.last_activity_at DESC) AS rn
           FROM applications app
           JOIN customers c ON c.id = app.customer_id
           LEFT JOIN LATERAL (
             SELECT json_agg(json_build_object('name', u.name, 'role', a.role)
                             ORDER BY a.is_primary DESC) AS list
               FROM assignments a JOIN users u ON u.id = a.user_id
              WHERE a.application_id = app.id AND a.unassigned_at IS NULL
           ) assignees ON TRUE
          WHERE app.organization_id = $1 AND app.archived_at IS NULL AND ${visibility}
       ) ranked WHERE rn <= 50`,
      params,
    );

    const counts = await query<{ stage_key: string; count: string; value: string }>(
      `SELECT app.stage_key, COUNT(*)::text AS count,
              COALESCE(SUM(app.amount_requested), 0)::text AS value
         FROM applications app
        WHERE app.organization_id = $1 AND app.archived_at IS NULL AND ${visibility}
        GROUP BY app.stage_key`,
      params,
    );
    const countBy = new Map(counts.rows.map((r) => [r.stage_key, r]));
    const today = todayIn(env.BROKERAGE_TIMEZONE);

    res.json({
      ok: true,
      columns: stages
        .filter((s) => s.active)
        .map((stage) => {
          const stat = countBy.get(stage.key);
          const value = Number(stat?.value ?? 0);
          return {
            stage,
            count: Number(stat?.count ?? 0),
            value,
            weighted:
              stage.probability === null || stage.probability === undefined
                ? null
                : (value * Number(stage.probability)) / 100,
            cards: rows
              .filter((r) => (r as { stage_key: string }).stage_key === stage.key)
              .map((r) => ({
                ...(r as Record<string, unknown>),
                days_to_close: daysToClose((r as { closing_date: string | null }).closing_date, today),
              })),
          };
        }),
    });
  }),
);

// ── One file ───────────────────────────────────────────────────────────────

customerRoutes.get(
  '/applications/:id',
  requirePermission('customer.view'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const user = req.user!;

    const app = await queryOne<Record<string, unknown>>(
      `SELECT app.*, c.first_name, c.last_name, c.email, c.phone_e164, c.phone_raw,
              c.lead_source, c.referral_source, c.tags, c.awaiting_reply_since,
              c.last_contacted_at, c.merged_into_id,
              ps.label AS stage_label, ps.category AS stage_category
         FROM applications app
         JOIN customers c ON c.id = app.customer_id
         LEFT JOIN pipeline_stages ps
                ON ps.organization_id = app.organization_id AND ps.key = app.stage_key
        WHERE app.id = $1 AND app.organization_id = $2`,
      [id, user.organization_id],
    );
    if (!app) throw notFound('That application');

    if (!can(user, 'customer.view_all')) {
      const mine = await queryOne(
        `SELECT 1 FROM assignments WHERE application_id = $1 AND user_id = $2 AND unassigned_at IS NULL`,
        [id, user.id],
      );
      // 404 rather than 403: telling somebody a file exists but is not theirs
      // is itself a disclosure.
      if (!mine) throw notFound('That application');
    }

    // Financial detail is a separate grant from the file it sits on.
    const showFinancials = can(user, 'pii.view_financials');

    const [applicants, assignments, conditions, compliance, documents] = await Promise.all([
      query(
        `SELECT id, position, applicant_role, first_name, last_name, email, phone_e164,
                marital_status, dependants, citizenship, residential_status,
                addr_city, addr_province, years_at_address
           FROM application_applicants WHERE application_id = $1 ORDER BY position`,
        [id],
      ),
      query(
        `SELECT a.role, a.is_primary, a.assigned_at, u.id AS user_id, u.name, u.email
           FROM assignments a JOIN users u ON u.id = a.user_id
          WHERE a.application_id = $1 AND a.unassigned_at IS NULL
          ORDER BY a.is_primary DESC, a.role`,
        [id],
      ),
      query(
        `SELECT id, label, detail, due_on, status FROM lender_conditions
          WHERE application_id = $1 ORDER BY status, due_on NULLS LAST, position`,
        [id],
      ),
      queryOne(
        `SELECT cc.id, cc.status, cc.approved_at, cc.legal_hold,
                (SELECT COUNT(*) FROM compliance_checklist_items i
                  WHERE i.compliance_case_id = cc.id AND i.required AND i.status = 'outstanding')
                  AS outstanding_required
           FROM compliance_cases cc WHERE cc.application_id = $1`,
        [id],
      ),
      query(
        `SELECT id, category_key, display_label, filename, review_status, uploaded_at, scan_status
           FROM documents WHERE application_id = $1 AND archived_at IS NULL
           ORDER BY uploaded_at DESC LIMIT 100`,
        [id],
      ),
    ]);

    const financials = showFinancials
      ? await Promise.all([
          query(
            `SELECT id, applicant_id, slot, status, employment_type, employer, job_title,
                    years, annual_income, income_frequency
               FROM application_employments WHERE application_id = $1 ORDER BY slot, position`,
            [id],
          ),
          query(
            `SELECT id, applicant_id, income_type, amount, frequency, source
               FROM application_incomes WHERE application_id = $1 ORDER BY position`,
            [id],
          ),
          query(
            `SELECT id, applicant_id, asset_type, value, institution, for_down_payment
               FROM application_assets WHERE application_id = $1 ORDER BY position`,
            [id],
          ),
          query(
            `SELECT id, applicant_id, liability_type, lender, balance, monthly_payment, payoff
               FROM application_liabilities WHERE application_id = $1 ORDER BY position`,
            [id],
          ),
          query(
            `SELECT id, street, city, province, occupancy, value, rental_income,
                    has_mortgage, mtg_lender, mtg_balance, mtg_payment, mtg_maturity, to_be_sold
               FROM application_properties WHERE application_id = $1 ORDER BY position`,
            [id],
          ),
        ])
      : null;

    const today = todayIn(user.timezone ?? env.BROKERAGE_TIMEZONE);

    res.json({
      ok: true,
      application: app,
      days_to_close: daysToClose(app.closing_date as string | null, today),
      applicants: applicants.rows,
      assignments: assignments.rows,
      conditions: conditions.rows,
      compliance,
      documents: documents.rows,
      financials: financials
        ? {
            employments: financials[0].rows,
            incomes: financials[1].rows,
            assets: financials[2].rows,
            liabilities: financials[3].rows,
            properties: financials[4].rows,
          }
        : null,
      // Said out loud rather than rendered as an empty section, so nobody
      // mistakes "you may not see this" for "there is nothing here".
      financials_hidden_reason: showFinancials
        ? null
        : 'Your role does not include financial detail on a client file.',
    });
  }),
);

// ── Stage changes ──────────────────────────────────────────────────────────

customerRoutes.post(
  '/applications/:id/stage',
  requirePermission('pipeline.move'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        stage_key: z.string().min(1),
        reason: z.string().optional(),
        force: z.boolean().default(false),
        lost_disposition_key: z.string().optional(),
        lost_reason_note: z.string().optional(),
      })
      .parse(req.body);
    const user = req.user!;

    const stages = await loadStages(user.organization_id);
    const target = stages.find((s) => s.key === body.stage_key);
    if (!target) throw new AppError(`No stage called "${body.stage_key}".`, 422, 'unknown_stage');

    // Forcing past an entry rule is a deliberate act with a permission of its
    // own; a broker cannot quietly skip the compliance gate on the way to
    // Funded.
    if (body.force && !can(user, 'pipeline.configure')) {
      throw new AppError(
        'Overriding a stage rule needs the pipeline configuration permission. ' +
          'Ask a manager, or complete what is outstanding.',
        403,
        'forbidden',
      );
    }

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<FileSnapshot & { id: string; organization_id: string }>(
        `SELECT app.id, app.organization_id, app.stage_key, app.stage_changed_at,
                app.percent_complete, app.amount_requested, app.closing_date,
                app.property_province, app.transaction_type_key, app.scarlett_deal_id,
                COALESCE($3, app.lost_disposition_key) AS lost_disposition_key,
                COALESCE(f.confirmed, false) AS funding_confirmed,
                f.funded_amount, f.lender_name,
                COALESCE((SELECT COUNT(*) FROM compliance_checklist_items i
                            JOIN compliance_cases cc ON cc.id = i.compliance_case_id
                           WHERE cc.application_id = app.id AND i.required
                             AND i.status = 'outstanding'), 0)::int AS compliance_outstanding_required,
                COALESCE((SELECT COUNT(*) FROM appointments ap
                           WHERE ap.application_id = app.id
                             AND ap.status <> 'cancelled'), 0)::int AS appointment_count
           FROM applications app
           LEFT JOIN funding_records f ON f.application_id = app.id
          WHERE app.id = $1 AND app.organization_id = $2
          FOR UPDATE OF app`,
        [id, user.organization_id, body.lost_disposition_key ?? null],
      );
      const file = rows[0];
      if (!file) throw notFound('That application');

      const decision = evaluateTransition(file, target, { force: body.force });
      if (!decision.allowed) return { decision };

      const from = stages.find((s) => s.key === file.stage_key) ?? null;
      const effects = transitionEffects(from, target);

      const sets: string[] = ['stage_key = $2', 'stage_changed_at = now()', 'last_activity_at = now()'];
      const params: unknown[] = [id, target.key];
      for (const field of effects.clearFields) sets.push(`${field} = NULL`);
      if (target.category === 'lost') {
        sets.push('lost_at = now()');
        if (body.lost_disposition_key) {
          params.push(body.lost_disposition_key);
          sets.push(`lost_disposition_key = $${params.length}`);
        }
        if (body.lost_reason_note) {
          params.push(body.lost_reason_note);
          sets.push(`lost_reason_note = $${params.length}`);
        }
      }
      await client.query(`UPDATE applications SET ${sets.join(', ')} WHERE id = $1`, params);

      await client.query(
        `INSERT INTO stage_transitions (application_id, from_stage_key, to_stage_key,
                                        actor_user_id, reason, seconds_in_from_stage)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, file.stage_key, target.key, user.id, body.reason ?? null, decision.secondsInFromStage],
      );

      // Automations that were about the old stage are ended here, inside the
      // same transaction as the move. A file that is funded with its nurture
      // sequence still running is the failure this prevents.
      let stoppedEnrollments = 0;
      for (const reason of effects.stopAutomationReasons) {
        const stopped = await client.query(
          `UPDATE automation_enrollments
              SET status = 'stopped', stopped_at = now(), stopped_reason = $2, next_run_at = NULL
            WHERE application_id = $1 AND status IN ('active','paused')`,
          [id, reason],
        );
        stoppedEnrollments += stopped.rowCount ?? 0;
      }

      for (const eventType of effects.events) {
        await client.query(
          `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id,
                                      payload, actor_user_id)
           SELECT $1, $2, customer_id, id, $3::jsonb, $4 FROM applications WHERE id = $5`,
          [user.organization_id, eventType,
           JSON.stringify({ from: file.stage_key, to: target.key }), user.id, id],
        );
      }

      const summary = `Stage changed from ${from?.label ?? 'none'} to ${target.label}` +
        (body.force ? ' (rules overridden)' : '');

      await client.query(
        `INSERT INTO activity (organization_id, application_id, customer_id, kind,
                               actor_user_id, actor_name, summary, detail)
         SELECT $1, id, customer_id, 'stage', $2, $3, $4, $5::jsonb FROM applications WHERE id = $6`,
        [user.organization_id, user.id, user.name, summary,
         JSON.stringify({ from: file.stage_key, to: target.key, forced: body.force,
                          overridden: decision.warnings }), id],
      );

      await recordAudit(
        {
          organizationId: user.organization_id,
          actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip, sessionId: req.sessionId },
          action: 'stage.change',
          entityType: 'application',
          entityId: id,
          summary,
          before: { stage_key: file.stage_key },
          after: { stage_key: target.key, forced: body.force, overridden: decision.warnings },
        },
        client,
      );

      return { decision, stoppedEnrollments, from, target };
    });

    if (!result.decision.allowed) {
      res.status(422).json({
        ok: false,
        code: 'stage_blocked',
        error: result.decision.message,
        blockers: result.decision.blockers,
      });
      return;
    }

    res.json({
      ok: true,
      stage: result.target,
      stopped_automations: result.stoppedEnrollments,
      overridden: result.decision.warnings,
    });
  }),
);

// ── Assignment ─────────────────────────────────────────────────────────────

customerRoutes.post(
  '/applications/:id/assign',
  requirePermission('pipeline.assign'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        user_id: z.string().uuid(),
        role: z.enum(['broker', 'underwriter', 'manager', 'compliance', 'assistant']),
        is_primary: z.boolean().default(true),
      })
      .parse(req.body);
    const user = req.user!;

    const assignee = await queryOne<{ id: string; name: string; active: boolean }>(
      'SELECT id, name, active FROM users WHERE id = $1 AND organization_id = $2',
      [body.user_id, user.organization_id],
    );
    if (!assignee) throw notFound('That user');
    if (!assignee.active) throw new AppError('That account is not active.', 422, 'inactive_user');

    await withTransaction(async (client) => {
      // The existing primary steps down before the new one steps up, or the
      // partial unique index rejects the write.
      if (body.is_primary) {
        await client.query(
          `UPDATE assignments SET is_primary = false
            WHERE application_id = $1 AND role = $2 AND unassigned_at IS NULL`,
          [id, body.role],
        );
      }
      await client.query(
        `INSERT INTO assignments (application_id, user_id, role, is_primary, assigned_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (application_id, user_id, role)
         DO UPDATE SET is_primary = EXCLUDED.is_primary, unassigned_at = NULL,
                       assigned_at = now(), assigned_by = EXCLUDED.assigned_by`,
        [id, body.user_id, body.role, body.is_primary, user.id],
      );
      await client.query(
        `INSERT INTO notifications (organization_id, user_id, kind, title, body, entity_type, entity_id, link)
         VALUES ($1,$2,'assignment',$3,$4,'application',$5,$6)`,
        [user.organization_id, body.user_id,
         `You were assigned as ${body.role}`,
         `${user.name} assigned you to a file.`, id, `${env.BASE_PATH}/applications/${id}`],
      );
      await recordAudit(
        {
          organizationId: user.organization_id,
          actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
          action: 'assignment.create',
          entityType: 'application',
          entityId: id,
          summary: `${assignee.name} assigned as ${body.role}${body.is_primary ? ' (primary)' : ''}`,
          after: { user_id: body.user_id, role: body.role, is_primary: body.is_primary },
        },
        client,
      );
    });

    res.json({ ok: true });
  }),
);

// ── Creating a customer by hand ────────────────────────────────────────────

customerRoutes.post(
  '/customers',
  requirePermission('customer.create'),
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        first_name: z.string().trim().min(1, 'A first name is required.'),
        last_name: z.string().trim().min(1, 'A last name is required.'),
        email: z.string().email('That is not a valid email address.').optional().or(z.literal('')),
        phone: z.string().optional(),
        lead_source: z.string().optional(),
        transaction_type_key: z.string().optional(),
        amount_requested: z.number().nonnegative().optional(),
      })
      .parse(req.body);
    const user = req.user!;

    const phone = body.phone ? toE164(body.phone) : null;
    if (body.phone && !phone) {
      throw new AppError('That is not a valid Canadian phone number.', 422, 'validation_failed');
    }
    if (!body.email && !phone) {
      throw new AppError('A customer needs at least an email address or a phone number.', 422, 'validation_failed');
    }

    // Possible duplicates are reported, never merged silently. Merging two
    // people's mortgage files because they share an address is not recoverable.
    const duplicates = await query<{ id: string; first_name: string; last_name: string; email: string }>(
      `SELECT id, first_name, last_name, email FROM customers
        WHERE organization_id = $1 AND merged_into_id IS NULL
          AND ((NULLIF($2,'') IS NOT NULL AND lower(email) = lower($2))
            OR ($3::text IS NOT NULL AND phone_e164 = $3))
        LIMIT 5`,
      [user.organization_id, body.email ?? '', phone],
    );

    const created = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO customers (organization_id, first_name, last_name, email, phone_e164,
                                phone_raw, lead_source, created_by)
         VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8) RETURNING id`,
        [user.organization_id, body.first_name, body.last_name, body.email ?? '',
         phone, body.phone ?? null, body.lead_source ?? 'manual', user.id],
      );
      const customerId = rows[0]!.id;

      const firstStage = await client.query<{ key: string }>(
        `SELECT key FROM pipeline_stages WHERE organization_id = $1 AND active
          ORDER BY position LIMIT 1`,
        [user.organization_id],
      );

      const app = await client.query<{ id: string }>(
        `INSERT INTO applications (organization_id, customer_id, transaction_type_key,
                                   amount_requested, stage_key, stage_changed_at, last_activity_at)
         VALUES ($1,$2,$3,$4,$5,now(),now()) RETURNING id`,
        [user.organization_id, customerId, body.transaction_type_key ?? null,
         body.amount_requested ?? null, firstStage.rows[0]?.key ?? null],
      );
      const applicationId = app.rows[0]!.id;

      await client.query(
        `INSERT INTO assignments (application_id, user_id, role, is_primary, assigned_by)
         VALUES ($1,$2,'broker',true,$2)`,
        [applicationId, user.id],
      );
      await client.query(
        `INSERT INTO activity (organization_id, application_id, customer_id, kind,
                               actor_user_id, actor_name, summary)
         VALUES ($1,$2,$3,'system',$4,$5,$6)`,
        [user.organization_id, applicationId, customerId, user.id, user.name,
         `File created by ${user.name}`],
      );
      await recordAudit(
        {
          organizationId: user.organization_id,
          actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
          action: 'customer.create',
          entityType: 'customer',
          entityId: customerId,
          summary: `Created ${body.first_name} ${body.last_name}`,
          after: { email: body.email, phone: phone },
        },
        client,
      );
      return { customerId, applicationId };
    });

    res.status(201).json({
      ok: true,
      customer_id: created.customerId,
      application_id: created.applicationId,
      possible_duplicates: duplicates.rows,
    });
  }),
);
