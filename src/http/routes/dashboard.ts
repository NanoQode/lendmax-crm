/**
 * The dashboard: what is true right now, and what to do about it.
 *
 * The KPI cards are counts. The block that matters is "My priorities", which
 * runs the deterministic rules in domain/next-action.ts over the caller's own
 * files and returns each suggestion WITH the evidence for it. A broker who
 * cannot see why a file is at the top of their list stops believing the list.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.ts';
import { env } from '../../config/env.ts';
import { can } from '../../domain/permissions.ts';
import { prioritise, type FileFacts } from '../../domain/next-action.ts';
import { todayIn } from '../../domain/dates.ts';
import { asyncRoute } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';

export const dashboardRoutes: Router = Router();
dashboardRoutes.use(requireAuth);

dashboardRoutes.get(
  '/dashboard',
  requirePermission('customer.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const scope = z.enum(['mine', 'team', 'all']).default('mine').parse(req.query.scope ?? 'mine');
    const timezone = user.timezone ?? env.BROKERAGE_TIMEZONE;
    const today = todayIn(timezone);
    const now = new Date();

    // A scope the caller is not entitled to silently narrows rather than
    // erroring: the dashboard is the first screen after sign-in and it must
    // always render something true.
    const effectiveScope =
      scope !== 'mine' && !can(user, 'report.view_all') && !can(user, 'customer.view_all')
        ? 'mine'
        : scope;

    const params: unknown[] = [user.organization_id];
    let visibility = 'TRUE';
    if (effectiveScope === 'mine') {
      params.push(user.id);
      visibility = `EXISTS (SELECT 1 FROM assignments a WHERE a.application_id = app.id
                              AND a.unassigned_at IS NULL AND a.user_id = $${params.length})`;
    }

    // One query for the facts every rule reads. The alternative — a query per
    // file — is what makes a dashboard take four seconds at two hundred files.
    const { rows } = await query<Record<string, unknown>>(
      `SELECT app.id AS "applicationId", app.customer_id AS "customerId",
              trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS "clientName",
              app.stage_key AS "stageKey",
              COALESCE(ps.category, 'open') AS "stageCategory",
              app.closing_date AS "closingDate", app.maturity_date AS "maturityDate",
              app.percent_complete AS "percentComplete",
              COALESCE(cond.outstanding, 0) AS "conditionsOutstanding",
              COALESCE(comp.outstanding_required, 0) AS "complianceOutstandingRequired",
              COALESCE(comp.approved, false) AS "complianceApproved",
              app.documents_outstanding AS "documentsOutstanding",
              dr.oldest_days AS "oldestDocumentRequestDays",
              COALESCE(docrev.awaiting, 0) AS "documentsAwaitingReview",
              c.awaiting_reply_since AS "awaitingReplySince",
              c.last_contacted_at AS "lastContactedAt",
              app.created_at AS "createdAt",
              COALESCE(t.future_tasks, 0) > 0 AS "hasFutureTask",
              COALESCE(t.overdue, 0) AS "overdueTaskCount",
              app.next_appointment_at AS "nextAppointmentAt",
              COALESCE(ns.no_show, false) AS "lastAppointmentNoShow",
              app.scarlett_deal_id AS "scarlettDealId",
              app.scarlett_sync_state AS "scarlettSyncState"
         FROM applications app
         JOIN customers c ON c.id = app.customer_id
         LEFT JOIN pipeline_stages ps
                ON ps.organization_id = app.organization_id AND ps.key = app.stage_key
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS outstanding FROM lender_conditions lc
            WHERE lc.application_id = app.id AND lc.status = 'outstanding'
         ) cond ON TRUE
         LEFT JOIN LATERAL (
           SELECT (cc.status = 'approved') AS approved,
                  (SELECT COUNT(*)::int FROM compliance_checklist_items i
                    WHERE i.compliance_case_id = cc.id AND i.required
                      AND i.status = 'outstanding') AS outstanding_required
             FROM compliance_cases cc WHERE cc.application_id = app.id
         ) comp ON TRUE
         LEFT JOIN LATERAL (
           SELECT MAX(EXTRACT(DAY FROM now() - r.created_at))::int AS oldest_days
             FROM document_requests r
            WHERE r.application_id = app.id AND r.status IN ('open','partial')
         ) dr ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS awaiting FROM documents d
            WHERE d.application_id = app.id AND d.review_status = 'pending'
              AND d.archived_at IS NULL
         ) docrev ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE tk.status IN ('open','in_progress','waiting')
                                     AND (tk.due_on IS NULL OR tk.due_on >= CURRENT_DATE))::int AS future_tasks,
                  COUNT(*) FILTER (WHERE tk.status IN ('open','in_progress','waiting')
                                     AND tk.due_on < CURRENT_DATE)::int AS overdue
             FROM tasks tk WHERE tk.application_id = app.id
         ) t ON TRUE
         LEFT JOIN LATERAL (
           SELECT (ap.status = 'no_show') AS no_show FROM appointments ap
            WHERE ap.application_id = app.id ORDER BY ap.starts_at DESC LIMIT 1
         ) ns ON TRUE
        WHERE app.organization_id = $1 AND app.archived_at IS NULL AND ${visibility}
          AND COALESCE(ps.category, 'open') <> 'lost'
        LIMIT 2000`,
      params,
    );

    // DATE columns arrive as 'YYYY-MM-DD' strings (see the type parser in
    // db/pool.ts), which is the shape the rules already expect.
    const facts = rows as unknown as FileFacts[];

    const priorities = prioritise(facts, today, now, undefined, 12);

    // KPI cards, counted from the same visibility scope so the numbers agree
    // with the list the user can actually open.
    const kpiSql = `
      SELECT
        COUNT(*) FILTER (WHERE ps.category = 'open')::int AS active_files,
        COUNT(*) FILTER (WHERE app.created_at > now() - interval '7 days')::int AS new_this_week,
        COUNT(*) FILTER (WHERE app.closing_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int AS closing_7_days,
        COALESCE(SUM(app.amount_requested) FILTER (
          WHERE app.closing_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30), 0)::text AS volume_closing_30,
        COUNT(*) FILTER (WHERE c.awaiting_reply_since IS NOT NULL)::int AS awaiting_reply,
        COUNT(*) FILTER (WHERE app.documents_outstanding > 0)::int AS documents_outstanding,
        COUNT(*) FILTER (WHERE app.scarlett_sync_state = 'error')::int AS scarlett_errors,
        COUNT(*) FILTER (WHERE app.maturity_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 180)::int AS renewals_180
        FROM applications app
        JOIN customers c ON c.id = app.customer_id
        LEFT JOIN pipeline_stages ps
               ON ps.organization_id = app.organization_id AND ps.key = app.stage_key
       WHERE app.organization_id = $1 AND app.archived_at IS NULL AND ${visibility}`;

    const [kpis, tasks, appointments, funded] = await Promise.all([
      query(kpiSql, params),
      query(
        `SELECT COUNT(*) FILTER (WHERE t.due_on < CURRENT_DATE)::int AS overdue,
                COUNT(*) FILTER (WHERE t.due_on = CURRENT_DATE)::int AS due_today
           FROM tasks t
           JOIN task_assignees ta ON ta.task_id = t.id
          WHERE t.organization_id = $1 AND ta.user_id = $2
            AND t.status IN ('open','in_progress','waiting')`,
        [user.organization_id, user.id],
      ),
      query(
        `SELECT a.id, a.starts_at, a.appointment_type, a.meeting_url, a.status,
                trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS client_name,
                a.application_id
           FROM appointments a JOIN customers c ON c.id = a.customer_id
          WHERE a.organization_id = $1 AND a.status IN ('booked','confirmed')
            AND a.starts_at BETWEEN now() - interval '1 hour' AND now() + interval '7 days'
            AND ($2::uuid IS NULL OR a.user_id = $2)
          ORDER BY a.starts_at LIMIT 10`,
        [user.organization_id, effectiveScope === 'mine' ? user.id : null],
      ),
      query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(funded_amount),0)::text AS volume
           FROM funding_records
          WHERE organization_id = $1
            AND funding_date >= date_trunc('month', CURRENT_DATE)`,
        [user.organization_id],
      ),
    ]);

    res.json({
      ok: true,
      scope: effectiveScope,
      today,
      timezone,
      kpis: {
        ...(kpis.rows[0] ?? {}),
        tasks_overdue: tasks.rows[0]?.overdue ?? 0,
        tasks_due_today: tasks.rows[0]?.due_today ?? 0,
        funded_this_month: funded.rows[0]?.count ?? 0,
        funded_volume_this_month: funded.rows[0]?.volume ?? '0',
      },
      priorities,
      appointments: appointments.rows,
    });
  }),
);

/** The notification bell. */
dashboardRoutes.get(
  '/notifications',
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const { rows } = await query(
      `SELECT id, at, kind, title, body, link, entity_type, entity_id, read_at
         FROM notifications WHERE user_id = $1
        ORDER BY read_at NULLS FIRST, at DESC LIMIT 50`,
      [user.id],
    );
    const unread = await query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [user.id],
    );
    res.json({ ok: true, notifications: rows, unread: unread.rows[0]?.count ?? 0 });
  }),
);

dashboardRoutes.post(
  '/notifications/read',
  asyncRoute(async (req, res) => {
    const body = z.object({ ids: z.array(z.string().uuid()).optional() }).parse(req.body ?? {});
    const user = req.user!;
    if (body.ids?.length) {
      await query(
        'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL',
        [user.id, body.ids],
      );
    } else {
      await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
    }
    res.json({ ok: true });
  }),
);
