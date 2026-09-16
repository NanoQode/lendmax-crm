/**
 * Reading an automation's facts from the database. What the facts are, and
 * the field list the builder offers, is `domain/automation-facts.ts`.
 */
import type pg from 'pg';
import { pool } from '../db/pool.ts';
import type { Facts } from '../domain/automation.ts';
import { mergeAnswers } from '../domain/application-form.ts';
import { applicationFacts } from '../domain/automation-facts.ts';

export { applicationFacts, applicationFactFields, factFields, type FactField } from '../domain/automation-facts.ts';

/**
 * Everything a condition or a merge field can read about a file.
 *
 * Two queries per enrollment per step. The alternative — a query per
 * condition — is what makes an engine that works at fifty enrollments
 * unusable at five thousand.
 */
export async function gatherFacts(
  client: Pick<pg.PoolClient, 'query'> | typeof pool,
  customerId: string,
  applicationId: string | null,
): Promise<Facts> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT
       c.id AS customer_id, c.first_name, c.last_name, c.email, c.phone_e164,
       c.last_contacted_at, c.awaiting_reply_since, c.tags, c.lead_source, c.referral_source,
       c.preferred_language, (c.awaiting_reply_since IS NOT NULL) AS awaiting_reply,
       app.id AS application_id, app.portal_reference, app.stage_key, app.status_key,
       app.percent_complete, app.amount_requested, app.closing_date, app.maturity_date,
       app.transaction_type_key, app.purpose, app.documents_outstanding,
       app.scarlett_deal_id, app.property_city, app.property_province,
       app.lost_disposition_key, app.submitted_at, (app.submitted_at IS NOT NULL) AS application_submitted,
       app.next_appointment_at, app.last_activity_at, app.gds, app.tds, app.ltv,
       app.portal_data,
       COALESCE(ps.category, 'open') AS stage_category,
       ps.label AS stage_label,
       (SELECT key FROM pipelines WHERE id = app.pipeline_id) AS pipeline_key,
       broker.user_id AS broker_user_id, (broker.user_id IS NOT NULL) AS has_broker,
       COALESCE(cond.outstanding, 0) AS conditions_outstanding,
       COALESCE(appt.future, 0) AS future_appointments,
       COALESCE(appt.no_show, false) AS last_appointment_no_show,
       COALESCE(f.confirmed, false) AS funding_confirmed,
       (app.closing_date - CURRENT_DATE) AS days_to_close,
       (app.maturity_date - CURRENT_DATE) AS days_to_maturity,
       floor(extract(epoch FROM now() - COALESCE(app.last_activity_at, app.created_at)) / 86400)::int
         AS days_since_activity,
       COALESCE(edits.list, '[]'::json) AS field_edits
     FROM customers c
     LEFT JOIN applications app ON app.id = $2::uuid
     LEFT JOIN pipeline_stages ps
            ON ps.organization_id = app.organization_id AND ps.key = app.stage_key
     LEFT JOIN funding_records f ON f.application_id = app.id
     LEFT JOIN LATERAL (
       SELECT a.user_id FROM assignments a
        WHERE a.application_id = app.id AND a.role = 'broker' AND a.is_primary AND a.unassigned_at IS NULL
        LIMIT 1
     ) broker ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS outstanding FROM lender_conditions lc
        WHERE lc.application_id = app.id AND lc.status = 'outstanding'
     ) cond ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE a.starts_at > now() AND a.status IN ('booked','confirmed'))::int AS future,
              bool_or(a.status = 'no_show') AS no_show
         FROM appointments a WHERE a.application_id = app.id
     ) appt ON TRUE
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object('path', e.path, 'value', e.value)) AS list
         FROM application_field_edits e WHERE e.application_id = app.id
     ) edits ON TRUE
     WHERE c.id = $1`,
    [customerId, applicationId],
  );
  const row = rows[0];
  if (!row) return {};
  const { portal_data: portalData, field_edits: edits, ...file } = row;
  const answers = mergeAnswers((portalData ?? {}) as Record<string, any>,
    (edits ?? []) as Array<{ path: string; value: unknown }>);
  return { ...file, ...applicationFacts(answers) } as Facts;
}
