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
import { refreshChecklist } from '../../services/compliance.ts';
import { can } from '../../domain/permissions.ts';
import { daysToClose, todayIn } from '../../domain/dates.ts';
import { env } from '../../config/env.ts';
import { AppError, asyncRoute, notFound } from '../middleware/errors.ts';
import { actorOf, requireAuth, requirePermission } from '../middleware/auth.ts';
import { assignLead, createLead } from '../../services/leads.ts';
import { loadStages, moveFileToStage } from '../../services/stage-moves.ts';
import { pipelineCatalogue } from '../../services/pipelines.ts';
import { recordFileView } from '../../services/activity.ts';
import { pool } from '../../db/pool.ts';
import {
  dismissDuplicate, findDuplicates, loadCustomer, mergeCustomers, searchCustomers, setArchived,
  updateCustomer, type CustomerScope,
} from '../../services/customers.ts';

export const customerRoutes: Router = Router();
customerRoutes.use(requireAuth);

// ── Helpers ────────────────────────────────────────────────────────────────


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
  name: 'lower(c.last_name || \' \' || c.first_name)',
  stage: 'ps.position',
  pipeline: 'lower(pl.name)',
  property: 'lower(app.property_city)',
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
  // The table's column filters and paging (web/src/components/data-table.tsx).
  client: z.string().trim().max(100).optional(),
  property: z.string().trim().max(100).optional(),
  amount: z.enum(['lt250', '250_500', '500_1000', 'gt1000', 'none']).optional(),
  closing: z.enum(['overdue', '14', '30', 'later', 'none']).optional(),
  assignee: z.union([z.string().uuid(), z.literal('__none')]).optional(),
  flag: z.enum(['awaiting_reply', 'documents', 'scarlett', 'incomplete']).optional(),
  activity: z.enum(['today', 'week', 'month', 'older']).optional(),
  pipeline: z.string().uuid().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  /** 'true' lists archived files instead of live ones. */
  archived: z.enum(['true', 'false']).optional(),
  page_size: z.coerce.number().int().min(1).max(200).optional(),
}).transform((q) => ({
  ...q,
  direction: q.dir ?? q.direction,
  limit: q.page_size ?? q.limit,
  offset: q.page ? (q.page - 1) * (q.page_size ?? q.limit) : q.offset,
}));

/**
 * The WHERE clause for the list, shared with the export so a CSV is exactly
 * the rows the screen was showing, filters and visibility included.
 */
function listWhere(
  q: z.infer<typeof ListQuery>,
  user: { id: string; organization_id: string; role: string; permission_overrides: Record<string, boolean> },
  params: unknown[],
): string[] {
  const where: string[] = ['app.organization_id = $1',
    q.archived === 'true' ? 'app.archived_at IS NOT NULL' : 'app.archived_at IS NULL'];

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
  if (q.pipeline) {
    params.push(q.pipeline);
    where.push(`app.pipeline_id = $${params.length}`);
  }
  if (q.client) {
    params.push(`%${q.client.toLowerCase()}%`);
    where.push(`(lower(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) LIKE $${params.length}
                 OR lower(coalesce(c.email,'')) LIKE $${params.length}
                 OR coalesce(c.phone_e164,'') LIKE $${params.length})`);
  }
  if (q.property) {
    params.push(`%${q.property.toLowerCase()}%`);
    where.push(`lower(concat_ws(' ', app.property_street_number, app.property_street_name,
                                app.property_city, app.property_province)) LIKE $${params.length}`);
  }
  if (q.amount) {
    where.push({
      lt250: 'app.amount_requested < 250000',
      '250_500': 'app.amount_requested >= 250000 AND app.amount_requested < 500000',
      '500_1000': 'app.amount_requested >= 500000 AND app.amount_requested < 1000000',
      gt1000: 'app.amount_requested >= 1000000',
      none: 'app.amount_requested IS NULL',
    }[q.amount]);
  }
  if (q.closing) {
    // Won and lost files have closed or never will; a window filter is about
    // the ones still in play.
    const open = `COALESCE(ps.category, 'open') NOT IN ('won','lost')`;
    where.push({
      overdue: `app.closing_date < CURRENT_DATE AND ${open}`,
      '14': `app.closing_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 14 AND ${open}`,
      '30': `app.closing_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30 AND ${open}`,
      later: `app.closing_date > CURRENT_DATE + 30`,
      none: 'app.closing_date IS NULL',
    }[q.closing]);
  }
  if (q.assignee === '__none') {
    where.push(`NOT EXISTS (SELECT 1 FROM assignments a3 WHERE a3.application_id = app.id
                              AND a3.unassigned_at IS NULL AND a3.role = 'broker')`);
  } else if (q.assignee) {
    params.push(q.assignee);
    where.push(`EXISTS (SELECT 1 FROM assignments a3 WHERE a3.application_id = app.id
                          AND a3.unassigned_at IS NULL AND a3.user_id = $${params.length})`);
  }
  if (q.flag) {
    where.push({
      awaiting_reply: 'c.awaiting_reply_since IS NOT NULL',
      documents: 'app.documents_outstanding > 0',
      scarlett: `app.scarlett_sync_state = 'error'`,
      incomplete: 'app.percent_complete < 100',
    }[q.flag]);
  }
  if (q.activity) {
    where.push({
      today: `app.last_activity_at >= date_trunc('day', now())`,
      week: `app.last_activity_at >= now() - interval '7 days'`,
      month: `app.last_activity_at >= now() - interval '31 days'`,
      older: `(app.last_activity_at < now() - interval '31 days' OR app.last_activity_at IS NULL)`,
    }[q.activity]);
  }
  return where;
}

// ── Export ─────────────────────────────────────────────────────────────────

/** A cell that a spreadsheet will not run as a formula. */
const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const EXPORT_LIMIT = 50_000;

/**
 * The list as CSV — the same filters, the same visibility, every page. Audited
 * with the filters used, because a spreadsheet of client contact details is
 * the easiest thing in this system to walk out of the door with.
 */
customerRoutes.get(
  '/customers/export',
  requirePermission('customer.export'),
  asyncRoute(async (req, res) => {
    const q = ListQuery.parse(req.query);
    const user = req.user!;
    const params: unknown[] = [user.organization_id];
    const where = listWhere(q, user, params);
    params.push(EXPORT_LIMIT);

    const { rows } = await query<Record<string, unknown>>(
      `SELECT app.portal_reference, c.first_name, c.last_name, c.email, c.phone_e164,
              pl.name AS pipeline, ps.label AS stage, tt.label AS transaction_type,
              app.amount_requested, app.closing_date,
              concat_ws(' ', app.property_street_number, app.property_street_name) AS property_street,
              app.property_city, app.property_province,
              (SELECT string_agg(u.name, '; ' ORDER BY a.is_primary DESC)
                 FROM assignments a JOIN users u ON u.id = a.user_id
                WHERE a.application_id = app.id AND a.unassigned_at IS NULL AND a.role = 'broker') AS broker,
              c.lead_source, app.documents_outstanding, app.percent_complete,
              app.created_at, app.last_activity_at, app.archived_at
         FROM applications app
         JOIN customers c ON c.id = app.customer_id
         LEFT JOIN pipeline_stages ps ON ps.organization_id = app.organization_id AND ps.key = app.stage_key
         LEFT JOIN pipelines pl ON pl.id = app.pipeline_id
         LEFT JOIN transaction_types tt
                ON tt.organization_id = app.organization_id AND tt.key = app.transaction_type_key
        WHERE ${where.join(' AND ')}
        ORDER BY ${SORTABLE[q.sort]!} ${q.direction === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS LAST'}, app.id
        LIMIT $${params.length}`,
      params,
    );

    const headers = ['Reference', 'First name', 'Last name', 'Email', 'Phone', 'Pipeline', 'Stage',
      'Transaction type', 'Amount requested', 'Closing date', 'Property street', 'Property city',
      'Province', 'Broker', 'Lead source', 'Documents outstanding', 'Application % complete',
      'Created', 'Last activity', 'Archived'];
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(Object.values(r).map(csvCell).join(','));

    const filters = Object.fromEntries(Object.entries(req.query).filter(([k]) => !['page', 'page_size', 'limit', 'offset'].includes(k)));
    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, kind: 'user', ip: req.ip },
      action: 'customer.export',
      entityType: 'customer',
      summary: `Exported ${rows.length} customer file${rows.length === 1 ? '' : 's'} to CSV`,
      after: { rows: rows.length, filters, truncated: rows.length === EXPORT_LIMIT },
    });

    const stamp = todayIn(user.timezone ?? env.BROKERAGE_TIMEZONE);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="lendmax-customers-${stamp}.csv"`);
    res.setHeader('cache-control', 'no-store');
    // A byte-order mark, so Excel reads accented names as UTF-8.
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  }),
);

customerRoutes.get(
  '/customers',
  requirePermission('customer.view'),
  asyncRoute(async (req, res) => {
    const q = ListQuery.parse(req.query);
    const user = req.user!;
    const params: unknown[] = [user.organization_id];
    const where = listWhere(q, user, params);

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
             app.pipeline_id, pl.name AS pipeline_name,
             COALESCE(assignees.list, '[]'::json) AS assignees,
             COUNT(*) OVER () AS total_count
        FROM applications app
        JOIN customers c ON c.id = app.customer_id
        LEFT JOIN pipeline_stages ps
               ON ps.organization_id = app.organization_id AND ps.key = app.stage_key
        LEFT JOIN pipelines pl ON pl.id = app.pipeline_id
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
    // One pipeline at a time: the one asked for, else the default.
    const { pipeline: asked } = z.object({ pipeline: z.string().max(60).optional() }).parse(req.query);
    const catalogue = await pipelineCatalogue(pool, user.organization_id);
    const pipeline = catalogue.find((p) => p.id === asked || p.key === asked)
      ?? catalogue.find((p) => p.is_default) ?? catalogue[0];
    if (!pipeline) throw notFound('A pipeline');
    const stages = (await loadStages(user.organization_id)).filter((s) => s.pipeline_id === pipeline.id);
    const params: unknown[] = [user.organization_id];
    const visibility = visibilityClause(user, params);
    params.push(pipeline.id);
    const inPipeline = `app.pipeline_id = $${params.length}`;

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
          WHERE app.organization_id = $1 AND app.archived_at IS NULL AND ${visibility} AND ${inPipeline}
       ) ranked WHERE rn <= 50`,
      params,
    );

    const counts = await query<{ stage_key: string; count: string; value: string }>(
      `SELECT app.stage_key, COUNT(*)::text AS count,
              COALESCE(SUM(app.amount_requested), 0)::text AS value
         FROM applications app
        WHERE app.organization_id = $1 AND app.archived_at IS NULL AND ${visibility} AND ${inPipeline}
        GROUP BY app.stage_key`,
      params,
    );
    const countBy = new Map(counts.rows.map((r) => [r.stage_key, r]));
    const today = todayIn(env.BROKERAGE_TIMEZONE);

    res.json({
      ok: true,
      pipeline: { id: pipeline.id, key: pipeline.key, name: pipeline.name, active: pipeline.active },
      pipelines: catalogue.map((p) => ({ id: p.id, key: p.key, name: p.name, active: p.active,
                                         is_default: p.is_default, files_open: p.files_open })),
      columns: stages
        // An inactive stage still shows while files sit on it, so they are
        // not hidden from the people who need to move them on.
        .filter((s) => s.active || countBy.has(s.key))
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

    // "Opened a client file", for the activity log — once per half hour, and
    // never in the way of the response.
    void recordFileView(actorOf(req), id);

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
                -- Refreshed below from the same derivation the compliance tab
                -- uses, so the header and the tab cannot disagree.
                0 AS outstanding_required
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
            // The flat mtg_* columns were replaced by application_mortgages in
            // 0011, because a property can carry a second and third charge and
            // the portal has always allowed that. The charges come back nested
            // under the property they sit on, in the order they were entered.
            `SELECT p.id, p.street, p.city, p.province, p.occupancy, p.value,
                    p.rental_income, p.has_mortgage, p.to_be_sold,
                    COALESCE(m.charges, '[]'::jsonb) AS mortgages
               FROM application_properties p
               LEFT JOIN LATERAL (
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', am.id, 'position', am.position, 'loan_type', am.loan_type,
                          'lender', am.lender, 'balance', am.balance, 'rate', am.rate,
                          'rate_type', am.rate_type, 'term', am.term, 'maturity', am.maturity,
                          'payment', am.payment, 'frequency', am.frequency)
                          ORDER BY am.seq) AS charges
                   FROM application_mortgages am WHERE am.property_id = p.id
               ) m ON TRUE
              WHERE p.application_id = $1 ORDER BY p.position`,
            [id],
          ),
        ])
      : null;

    const today = todayIn(user.timezone ?? env.BROKERAGE_TIMEZONE);

    // The header's compliance count comes from the same derivation the
    // compliance tab uses. Computed in two places, it disagreed with itself.
    if (compliance) {
      const refreshed = await refreshChecklist(id, String((compliance as { id: string }).id));
      (compliance as Record<string, unknown>).outstanding_required =
        refreshed.outstanding_required;
      (compliance as Record<string, unknown>).total_required = refreshed.total_required;
    }

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
    const result = await moveFileToStage(actorOf(req), String(req.params.id), req.body, {
      mayForce: can(req.user!, 'pipeline.configure'), sessionId: req.sessionId,
    });
    if (!result.ok) {
      res.status(422).json({ ok: false, code: 'stage_blocked', error: result.message, blockers: result.blockers });
      return;
    }
    res.json(result);
  }),
);

// ── Assignment ─────────────────────────────────────────────────────────────

customerRoutes.post(
  '/applications/:id/assign',
  requirePermission('pipeline.assign'),
  asyncRoute(async (req, res) => {
    const result = await assignLead(actorOf(req), String(req.params.id), req.body);
    res.json({ ok: true, ...result });
  }),
);

// ── Creating a customer by hand ────────────────────────────────────────────

customerRoutes.post(
  '/customers',
  requirePermission('customer.create'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    // A broker typing in their own referral keeps it; anybody else's default
    // is the rotation. The form shows the choice either way.
    const result = await createLead(actorOf(req), req.body, {
      defaultAssign: user.role === 'broker' ? 'me' : 'auto',
      mayAssignOthers: can(user, 'pipeline.assign'),
      source: 'manual',
    });
    res.status(201).json({ ok: true, ...result });
  }),
);

// ── The customer record ────────────────────────────────────────────────────

const scopeOf = (req: Parameters<typeof actorOf>[0]): CustomerScope => ({
  actor: actorOf(req),
  viewAll: can(req.user!, 'customer.view_all'),
});
const UUID = z.string().uuid();

/** Find a record to merge with, by name, email or phone. */
customerRoutes.get(
  '/customers/search',
  requirePermission('customer.view'),
  asyncRoute(async (req, res) => {
    const q = z.object({ q: z.string().max(100).default(''), exclude: UUID.optional() }).parse(req.query);
    res.json({ ok: true, customers: await searchCustomers(scopeOf(req), q.q, q.exclude) });
  }),
);

/** The contact record, every file on it, and anybody who looks like the same person. */
customerRoutes.get(
  '/customers/:id',
  requirePermission('customer.view'),
  asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const id = UUID.parse(req.params.id);
    const customer = await loadCustomer(scope, id);
    const { rows: files } = await query(
      `SELECT app.id, app.portal_reference, app.stage_key, ps.label AS stage_label,
              app.transaction_type_key, app.amount_requested, app.created_at, app.archived_at
         FROM applications app
         LEFT JOIN pipeline_stages ps ON ps.organization_id = app.organization_id AND ps.key = app.stage_key
        WHERE app.customer_id = $1
        ORDER BY app.archived_at NULLS FIRST, app.created_at DESC`,
      [id],
    );
    res.json({ ok: true, customer, files, duplicates: await findDuplicates(scope, id) });
  }),
);

customerRoutes.patch(
  '/customers/:id',
  requirePermission('customer.edit'),
  asyncRoute(async (req, res) => {
    res.json({ ok: true, ...(await updateCustomer(scopeOf(req), UUID.parse(req.params.id), req.body)) });
  }),
);

customerRoutes.get(
  '/customers/:id/duplicates',
  requirePermission('customer.view'),
  asyncRoute(async (req, res) => {
    res.json({ ok: true, duplicates: await findDuplicates(scopeOf(req), UUID.parse(req.params.id)) });
  }),
);

/** Fold `merge_id` into this customer. This one survives. */
customerRoutes.post(
  '/customers/:id/merge',
  requirePermission('customer.merge'),
  asyncRoute(async (req, res) => {
    const body = z.object({ merge_id: UUID }).parse(req.body);
    res.json({ ok: true, ...(await mergeCustomers(scopeOf(req), UUID.parse(req.params.id), body.merge_id)) });
  }),
);

customerRoutes.post(
  '/customers/:id/duplicates/:other/dismiss',
  requirePermission('customer.merge'),
  asyncRoute(async (req, res) => {
    await dismissDuplicate(scopeOf(req), UUID.parse(req.params.id), UUID.parse(req.params.other));
    res.json({ ok: true });
  }),
);

// ── Archiving a file ───────────────────────────────────────────────────────

for (const [path, archived] of [['archive', true], ['restore', false]] as const) {
  customerRoutes.post(
    `/applications/:id/${path}`,
    requirePermission('customer.delete'),
    asyncRoute(async (req, res) => {
      const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
      res.json({ ok: true, ...(await setArchived(scopeOf(req), UUID.parse(req.params.id), archived, body.reason)) });
    }),
  );
}
