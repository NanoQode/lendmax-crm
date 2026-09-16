/**
 * Reports.
 *
 * Built on `stage_transitions`, not on the current state of each file. A
 * pipeline report computed from where files are now cannot answer "how long
 * does a file sit in Application" or "what did we lose in March and why",
 * because both questions are about a history the current state has thrown
 * away.
 *
 * Every figure here is derived from recorded events, and every one of them
 * says what it counted. A conversion rate with no denominator on screen is a
 * number somebody will quote in a meeting and nobody can check.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/pool.ts';
import { asyncRoute } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';
import { can } from '../../domain/permissions.ts';

export const reportRoutes: Router = Router();
reportRoutes.use(requireAuth);

const Range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  months: z.coerce.number().int().min(1).max(60).default(12),
  user_id: z.string().uuid().optional(),
});

/**
 * Who the caller may see.
 *
 * A broker sees their own files. Anything wider needs the permission, and
 * the response says which scope it is — a report that silently narrows is
 * one somebody will read as the brokerage's numbers.
 */
function scopeFor(user: { id: string; role: string }, requested?: string) {
  const canSeeAll = can(user as never, 'report.view_all');
  const canSeeTeam = can(user as never, 'report.view_team');
  if (requested && requested !== user.id && !canSeeAll && !canSeeTeam) {
    return { userId: user.id, scope: 'mine', forced: true };
  }
  if (!canSeeAll && !canSeeTeam) return { userId: user.id, scope: 'mine', forced: true };
  return { userId: requested ?? null, scope: requested ? 'one broker' : 'the brokerage',
           forced: false };
}

// ── The pipeline: how files move, and how long they take ───────────────────

reportRoutes.get(
  '/reports/pipeline',
  requirePermission('report.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = Range.parse(req.query);
    const scope = scopeFor(user, q.user_id);

    const params: unknown[] = [user.organization_id, q.months];
    let assignmentFilter = '';
    if (scope.userId) {
      params.push(scope.userId);
      assignmentFilter = `AND EXISTS (SELECT 1 FROM assignments a
                                       WHERE a.application_id = app.id AND a.user_id = $3
                                         AND a.unassigned_at IS NULL)`;
    }

    // How long a file sits in each stage, from the transitions themselves.
    // The median rather than the mean: one file stuck for two years makes a
    // mean meaningless and a brokerage plan around a number that describes
    // nothing.
    const dwell = await query<{
      stage_key: string; label: string; files: number;
      median_days: string | null; p90_days: string | null;
    }>(
      `WITH spans AS (
         SELECT t.to_stage_key AS stage_key,
                t.application_id,
                EXTRACT(EPOCH FROM (
                  COALESCE(LEAD(t.at) OVER (PARTITION BY t.application_id ORDER BY t.at), now())
                  - t.at)) / 86400 AS days
           FROM stage_transitions t
           JOIN applications app ON app.id = t.application_id
          WHERE app.organization_id = $1
            AND t.at >= now() - ($2 || ' months')::interval
            ${assignmentFilter}
       )
       SELECT s.stage_key, COALESCE(ps.label, s.stage_key) AS label,
              COALESCE(pl.name, '—') AS pipeline_name,
              count(DISTINCT s.application_id)::int AS files,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.days)::numeric, 1)::text
                AS median_days,
              round(percentile_cont(0.9) WITHIN GROUP (ORDER BY s.days)::numeric, 1)::text
                AS p90_days
         FROM spans s
         LEFT JOIN pipeline_stages ps
                ON ps.organization_id = $1 AND ps.key = s.stage_key
         LEFT JOIN pipelines pl ON pl.id = ps.pipeline_id
        GROUP BY s.stage_key, ps.label, ps.position, pl.name, pl.position
        ORDER BY pl.position NULLS LAST, ps.position NULLS LAST`,
      params);

    // The funnel: how many files ever reached each stage, not how many are
    // sitting in it now.
    const funnel = await query<{ stage_key: string; label: string; reached: number }>(
      `SELECT t.to_stage_key AS stage_key, COALESCE(ps.label, t.to_stage_key) AS label,
              count(DISTINCT t.application_id)::int AS reached
         FROM stage_transitions t
         JOIN applications app ON app.id = t.application_id
         LEFT JOIN pipeline_stages ps
                ON ps.organization_id = $1 AND ps.key = t.to_stage_key
        WHERE app.organization_id = $1
          AND t.at >= now() - ($2 || ' months')::interval
          ${assignmentFilter}
        GROUP BY t.to_stage_key, ps.label, ps.position
        ORDER BY ps.position NULLS LAST`,
      params);

    // Why files were lost. The disposition, which is the only part of this
    // report anybody can act on.
    const lost = await query<{ disposition: string; label: string; count: number }>(
      `SELECT COALESCE(app.lost_disposition_key, 'not recorded') AS disposition,
              COALESCE(d.label, 'Not recorded') AS label,
              count(*)::int AS count
         FROM applications app
         LEFT JOIN pipeline_stages ps
                ON ps.organization_id = app.organization_id AND ps.key = app.stage_key
         LEFT JOIN lost_dispositions d
                ON d.organization_id = app.organization_id AND d.key = app.lost_disposition_key
        WHERE app.organization_id = $1 AND ps.category = 'lost'
          AND app.stage_changed_at >= now() - ($2 || ' months')::interval
          ${assignmentFilter}
        GROUP BY 1, 2 ORDER BY 3 DESC`,
      params);

    res.json({ dwell: dwell.rows, funnel: funnel.rows, lost: lost.rows, scope });
  }),
);

// ── Volume and funding ─────────────────────────────────────────────────────

reportRoutes.get(
  '/reports/volume',
  requirePermission('report.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = Range.parse(req.query);
    const scope = scopeFor(user, q.user_id);

    const params: unknown[] = [user.organization_id, q.months];
    let assignmentFilter = '';
    if (scope.userId) {
      params.push(scope.userId);
      assignmentFilter = `AND EXISTS (SELECT 1 FROM assignments a
                                       WHERE a.application_id = app.id AND a.user_id = $3
                                         AND a.unassigned_at IS NULL)`;
    }

    const monthly = await query(
      `SELECT to_char(date_trunc('month', f.funding_date), 'YYYY-MM') AS month,
              count(*)::int AS files,
              sum(f.funded_amount)::text AS volume,
              round(avg(f.funded_amount)::numeric, 0)::text AS average,
              round(avg(f.rate)::numeric, 3)::text AS average_rate
         FROM funding_records f
         JOIN applications app ON app.id = f.application_id
        WHERE app.organization_id = $1 AND f.confirmed
          AND f.funding_date >= date_trunc('month', now() - ($2 || ' months')::interval)
          ${assignmentFilter}
        GROUP BY 1 ORDER BY 1`,
      params);

    const byLender = await query(
      `SELECT COALESCE(f.lender_name, 'Not recorded') AS lender,
              count(*)::int AS files, sum(f.funded_amount)::text AS volume
         FROM funding_records f
         JOIN applications app ON app.id = f.application_id
        WHERE app.organization_id = $1 AND f.confirmed
          AND f.funding_date >= now() - ($2 || ' months')::interval
          ${assignmentFilter}
        GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 15`,
      params);

    const byType = await query(
      `SELECT COALESCE(t.label, f.final_transaction_type, 'Not recorded') AS type,
              count(*)::int AS files, sum(f.funded_amount)::text AS volume
         FROM funding_records f
         JOIN applications app ON app.id = f.application_id
         LEFT JOIN transaction_types t
                ON t.organization_id = app.organization_id
               AND t.key = COALESCE(f.final_transaction_type, app.transaction_type_key)
        WHERE app.organization_id = $1 AND f.confirmed
          AND f.funding_date >= now() - ($2 || ' months')::interval
          ${assignmentFilter}
        GROUP BY 1 ORDER BY 3 DESC NULLS LAST`,
      params);

    const bySource = await query(
      `SELECT COALESCE(c.lead_source, 'Not recorded') AS source,
              count(*)::int AS files, sum(f.funded_amount)::text AS volume
         FROM funding_records f
         JOIN applications app ON app.id = f.application_id
         JOIN customers c ON c.id = app.customer_id
        WHERE app.organization_id = $1 AND f.confirmed
          AND f.funding_date >= now() - ($2 || ' months')::interval
          ${assignmentFilter}
        GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 15`,
      params);

    res.json({ monthly: monthly.rows, by_lender: byLender.rows, by_type: byType.rows,
               by_source: bySource.rows, scope });
  }),
);

// ── The brokerage's people ─────────────────────────────────────────────────

reportRoutes.get(
  '/reports/team',
  requirePermission('report.view_team'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = Range.parse(req.query);

    const { rows } = await query(
      `SELECT u.id, u.name, u.role,
              count(DISTINCT app.id) FILTER (
                WHERE ps.category NOT IN ('won','lost') OR ps.category IS NULL)::int AS open_files,
              count(DISTINCT f.application_id) FILTER (WHERE f.confirmed)::int AS funded,
              COALESCE(sum(f.funded_amount) FILTER (WHERE f.confirmed), 0)::text AS volume,
              count(DISTINCT app.id) FILTER (WHERE ps.category = 'lost')::int AS lost,
              round(avg(EXTRACT(EPOCH FROM (f.funding_date - app.created_at)) / 86400)
                      FILTER (WHERE f.confirmed)::numeric, 1)::text AS avg_days_to_fund
         FROM users u
         LEFT JOIN assignments a ON a.user_id = u.id AND a.role = 'broker'
                                AND a.unassigned_at IS NULL
         LEFT JOIN applications app ON app.id = a.application_id
                                   AND app.created_at >= now() - ($2 || ' months')::interval
         LEFT JOIN pipeline_stages ps
                ON ps.organization_id = app.organization_id AND ps.key = app.stage_key
         LEFT JOIN funding_records f ON f.application_id = app.id
        WHERE u.organization_id = $1 AND u.active AND u.role IN ('broker','manager')
        GROUP BY u.id, u.name, u.role
        ORDER BY 6 DESC NULLS LAST`,
      [user.organization_id, q.months]);

    res.json({ people: rows, months: q.months });
  }),
);

// ── Campaigns, led by outcomes rather than opens ───────────────────────────

reportRoutes.get(
  '/reports/campaigns',
  requirePermission('campaign.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = Range.parse(req.query);

    const { rows } = await query(
      `SELECT c.id, c.name, c.channel, c.purpose, c.send_started_at,
              count(cr.id)::int AS recipients,
              count(cr.id) FILTER (WHERE cr.status = 'suppressed')::int AS suppressed,
              count(cr.id) FILTER (
                WHERE cr.status IN ('sent','delivered','opened','clicked'))::int AS sent,
              count(cr.id) FILTER (WHERE cr.opened_at IS NOT NULL)::int AS opened,
              count(cr.id) FILTER (WHERE cr.clicked_at IS NOT NULL)::int AS clicked,
              count(cr.id) FILTER (WHERE cr.unsubscribed_at IS NOT NULL)::int AS unsubscribed,
              -- The column the reporting leads with. An open is a weak
              -- signal; an application that followed is not.
              (SELECT count(*)::int FROM campaign_attributions ca
                WHERE ca.campaign_id = c.id AND ca.outcome = 'application_started')
                AS applications,
              (SELECT count(*)::int FROM campaign_attributions ca
                WHERE ca.campaign_id = c.id AND ca.outcome = 'funded') AS funded,
              (SELECT COALESCE(sum(ca.value_amount), 0)::text FROM campaign_attributions ca
                WHERE ca.campaign_id = c.id AND ca.outcome = 'funded') AS funded_volume
         FROM campaigns c
         LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
        WHERE c.organization_id = $1 AND c.send_started_at IS NOT NULL
          AND c.send_started_at >= now() - ($2 || ' months')::interval
        GROUP BY c.id
        ORDER BY c.send_started_at DESC`,
      [user.organization_id, q.months]);

    res.json({ campaigns: rows });
  }),
);

// ── Compliance ─────────────────────────────────────────────────────────────

reportRoutes.get(
  '/reports/compliance',
  requirePermission('compliance.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;

    const [cases, identity, retention] = await Promise.all([
      queryOne(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'approved')::int AS approved,
                count(*) FILTER (WHERE status = 'awaiting_review')::int AS awaiting,
                count(*) FILTER (WHERE legal_hold)::int AS on_hold,
                count(*) FILTER (WHERE status = 'approved'
                                   AND approved_at >= now() - interval '30 days')::int
                  AS approved_30d
           FROM compliance_cases WHERE organization_id = $1`, [user.organization_id]),
      queryOne(
        `SELECT count(*) FILTER (WHERE status = 'verified')::int AS verified,
                count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE document_expiry < CURRENT_DATE)::int AS expired_documents
           FROM identity_verifications WHERE organization_id = $1`, [user.organization_id]),
      // What retention WOULD touch, never what it has deleted: nothing in
      // this system deletes a mortgage record on a schedule nobody approved.
      query(
        `SELECT p.key, p.name, p.entity_type, p.anchor, p.retain_months, p.action,
                p.source_note, p.effective_from
           FROM retention_policies p
          WHERE p.organization_id = $1 AND p.active
          ORDER BY p.entity_type`, [user.organization_id]),
    ]);

    const risk = await query(
      `SELECT COALESCE(ra.override_rating, ra.rating, 'not assessed') AS rating,
              count(*)::int AS count
         FROM applications app
         LEFT JOIN risk_assessments ra
                ON ra.application_id = app.id AND ra.superseded_at IS NULL
        WHERE app.organization_id = $1
        GROUP BY 1 ORDER BY 2 DESC`, [user.organization_id]);

    res.json({
      cases, identity, risk: risk.rows, retention_policies: retention.rows,
      retention_note:
        'These policies describe what the retention runner proposes. Nothing is deleted or '
        + 'anonymised automatically — a person reviews every proposal, and a legal hold '
        + 'stops the file being proposed at all.',
    });
  }),
);
