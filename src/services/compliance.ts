/**
 * Compliance: the case, the checklist, the risk assessment.
 *
 * The shape of this module follows two rules from the schema, and they are
 * worth restating where the code is:
 *
 *   A PERSON MAKES THE DETERMINATION. The model computes and stores a
 *   suggestion; a compliance manager's rating sits beside it, never
 *   underneath it. An override records who disagreed and why.
 *
 *   UNUSUAL ACTIVITY IS ROUTED, NEVER ANNOUNCED. Nothing this module writes
 *   reaches a client-facing surface, and an escalated file carries no
 *   client-visible artefact of any kind. Tipping off is the one mistake here
 *   that cannot be corrected afterwards.
 *
 * Several checklist items answer themselves from data the CRM already holds —
 * identity verified, consent recorded, conditions satisfied. Those are
 * evaluated rather than ticked, because a checkbox somebody clicked is worse
 * evidence than the record it was claiming to represent. The evaluation runs
 * on read and the item stays "outstanding" until the underlying fact is true.
 */
import type pg from 'pg';
import { pool, query, queryOne, withTransaction } from '../db/pool.ts';
import {
  assessRisk, DEFAULT_BANDS,
  type FactorDefinition, type RiskFacts, type RiskResult,
} from '../domain/risk.ts';
import { todayIn } from '../domain/dates.ts';
import { env } from '../config/env.ts';

export type ComplianceCase = {
  id: string; application_id: string; customer_id: string; status: string;
  province: string; checklist_key: string | null; legal_hold: boolean;
};

/**
 * Open the case if it is not open already.
 *
 * The checklist template is chosen by province and stamped with its version,
 * so a template that gains an item next year does not make an approved file
 * retroactively incomplete.
 */
export async function openCase(
  client: pg.PoolClient | typeof pool,
  organizationId: string,
  applicationId: string,
): Promise<ComplianceCase> {
  const existing = await client.query<ComplianceCase>(
    `SELECT id, application_id, customer_id, status, province, checklist_key, legal_hold
       FROM compliance_cases WHERE application_id = $1`,
    [applicationId],
  );
  if (existing.rows[0]) return existing.rows[0];

  const app = await client.query<{ customer_id: string; property_province: string | null }>(
    `SELECT customer_id, property_province FROM applications WHERE id = $1`,
    [applicationId],
  );
  const row = app.rows[0];
  if (!row) throw new Error('No such application.');
  const province = row.property_province ?? 'ON';

  const template = await client.query<{ key: string; version: number; items: ChecklistItem[] }>(
    `SELECT key, version, items FROM compliance_checklist_templates
      WHERE organization_id = $1 AND active
        AND (province IS NULL OR province = $2)
        AND effective_from <= CURRENT_DATE
      ORDER BY (province = $2) DESC, effective_from DESC, version DESC
      LIMIT 1`,
    [organizationId, province],
  );
  const chosen = template.rows[0];

  const created = await client.query<ComplianceCase>(
    `INSERT INTO compliance_cases (organization_id, application_id, customer_id, province,
                                   checklist_key, status)
     VALUES ($1,$2,$3,$4,$5,'in_progress')
     RETURNING id, application_id, customer_id, status, province, checklist_key, legal_hold`,
    [organizationId, applicationId, row.customer_id, province, chosen?.key ?? null],
  );
  const complianceCase = created.rows[0]!;

  if (chosen) {
    for (const [position, item] of chosen.items.entries()) {
      await client.query(
        `INSERT INTO compliance_checklist_items
           (compliance_case_id, template_key, template_version, item_key, group_key,
            label, required, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (compliance_case_id, item_key) DO NOTHING`,
        [complianceCase.id, chosen.key, chosen.version, item.key, item.group ?? null,
         item.label, item.required !== false, position],
      );
    }
  }

  // The FINTRAC assessment row exists from the start, empty. A determination
  // that has not been made must read as "not made", and a missing row would
  // read as nothing at all.
  await client.query(
    `INSERT INTO fintrac_assessments (organization_id, compliance_case_id, application_id)
     VALUES ($1,$2,$3) ON CONFLICT (compliance_case_id) DO NOTHING`,
    [organizationId, complianceCase.id, applicationId],
  );

  return complianceCase;
}

type ChecklistItem = {
  key: string; group?: string; label: string; required?: boolean; evidence?: string;
};

// ── Items that answer themselves ───────────────────────────────────────────

/**
 * The evidence each derived item rests on, in one query.
 *
 * These are not ticked by a person. "Identity verified for every applicant"
 * is true when every applicant has a verified identity record, and false
 * otherwise — a checkbox claiming it while the records say otherwise is
 * exactly the evidence a review is trying to avoid.
 */
export type DerivedEvidence = {
  applicants: number;
  identities_verified: number;
  consent_recorded: boolean;
  conditions_total: number;
  conditions_outstanding: number;
  risk_rated: boolean;
  suitability_status: string | null;
  funding_confirmed: boolean;
  application_complete: boolean;
  documents_by_category: string[];
  fintrac: Record<string, unknown> | null;
};

export async function gatherEvidence(
  applicationId: string,
  complianceCaseId: string,
): Promise<DerivedEvidence> {
  const row = await queryOne<DerivedEvidence>(
    `SELECT
       (SELECT count(*)::int FROM application_applicants a WHERE a.application_id = $1)
         AS applicants,
       (SELECT count(DISTINCT iv.applicant_id)::int FROM identity_verifications iv
         WHERE iv.application_id = $1 AND iv.status = 'verified') AS identities_verified,
       EXISTS (SELECT 1 FROM consents c
                JOIN applications app ON app.id = $1
               WHERE (c.customer_id = app.customer_id
                      OR c.customer_id IN (SELECT m.id FROM customers m WHERE m.merged_into_id = app.customer_id))
                 AND c.granted AND c.basis <> 'withdrawn') AS consent_recorded,
       (SELECT count(*)::int FROM lender_conditions lc WHERE lc.application_id = $1)
         AS conditions_total,
       (SELECT count(*)::int FROM lender_conditions lc
         WHERE lc.application_id = $1 AND lc.status = 'outstanding') AS conditions_outstanding,
       EXISTS (SELECT 1 FROM risk_assessments ra
                WHERE ra.application_id = $1 AND ra.superseded_at IS NULL
                  AND (ra.rating IS NOT NULL OR ra.override_rating IS NOT NULL)) AS risk_rated,
       (SELECT sa.status FROM suitability_assessments sa
         WHERE sa.application_id = $1 ORDER BY sa.created_at DESC LIMIT 1) AS suitability_status,
       EXISTS (SELECT 1 FROM funding_records f
                WHERE f.application_id = $1 AND f.confirmed) AS funding_confirmed,
       (SELECT COALESCE(app.percent_complete, 0) >= 100 FROM applications app WHERE app.id = $1)
         AS application_complete,
       COALESCE((SELECT array_agg(DISTINCT d.category_key) FROM documents d
                  WHERE d.application_id = $1 AND d.review_status <> 'rejected'
                    AND d.archived_at IS NULL AND d.category_key IS NOT NULL), '{}') AS documents_by_category,
       (SELECT to_jsonb(fa) FROM fintrac_assessments fa
         WHERE fa.compliance_case_id = $2) AS fintrac`,
    [applicationId, complianceCaseId],
  );
  return row!;
}

/**
 * What a derived item's answer is, and the evidence for it.
 *
 * `null` means the item is not derived — a person completes it, and the
 * stored status stands.
 */
export function deriveItem(
  itemKey: string,
  evidence: DerivedEvidence,
): { complete: boolean; detail: string } | null {
  const fintrac = evidence.fintrac ?? {};
  switch (itemKey) {
    case 'application_complete':
      return {
        complete: evidence.application_complete,
        detail: evidence.application_complete
          ? 'The application reads as complete.'
          : 'The application is not yet complete.',
      };
    case 'client_consent':
      return {
        complete: evidence.consent_recorded,
        detail: evidence.consent_recorded
          ? 'A granted consent is on file with its evidence.'
          : 'No granted consent is recorded for this client.',
      };
    case 'identity_verified': {
      const complete = evidence.applicants > 0
        && evidence.identities_verified >= evidence.applicants;
      return {
        complete,
        detail: evidence.applicants === 0
          ? 'There are no applicants on this file.'
          : `${evidence.identities_verified} of ${evidence.applicants} applicant(s) verified.`,
      };
    }
    case 'third_party':
      return {
        complete: fintrac.third_party_checked === true,
        detail: fintrac.third_party_checked === true
          ? fintrac.third_party_present === true
            ? 'A third party is recorded, with detail.'
            : 'Checked; no third party involved.'
          : 'The third-party determination has not been made.',
      };
    case 'pep_screening':
      return {
        complete: fintrac.pep_screened === true && !!fintrac.pep_result
          // A PEP match without senior approval is not a completed item.
          && (fintrac.pep_result === 'none' || !!fintrac.pep_senior_approval_at),
        detail: !fintrac.pep_screened
          ? 'Screening has not been recorded.'
          : fintrac.pep_result === 'none'
            ? 'Screened, with no match.'
            : fintrac.pep_senior_approval_at
              ? `Screened as ${String(fintrac.pep_result)}, with senior approval.`
              : `Screened as ${String(fintrac.pep_result)} — senior approval is outstanding.`,
      };
    case 'source_of_funds':
      return {
        complete: !!fintrac.source_of_funds,
        detail: fintrac.source_of_funds
          ? `Recorded as "${String(fintrac.source_of_funds)}".`
          : 'No source of funds has been recorded.',
      };
    case 'risk_assessed':
      return {
        complete: evidence.risk_rated,
        detail: evidence.risk_rated
          ? 'A current risk assessment is on file.'
          : 'No risk rating has been recorded.',
      };
    case 'suitability':
      return {
        complete: evidence.suitability_status === 'approved'
          || evidence.suitability_status === 'submitted',
        detail: evidence.suitability_status
          ? `The rationale is ${evidence.suitability_status.replace(/_/g, ' ')}.`
          : 'No suitability rationale has been written.',
      };
    case 'conditions_satisfied':
      return {
        complete: evidence.conditions_total > 0 && evidence.conditions_outstanding === 0,
        detail: evidence.conditions_total === 0
          ? 'No lender conditions have been recorded.'
          : evidence.conditions_outstanding === 0
            ? `All ${evidence.conditions_total} condition(s) satisfied.`
            : `${evidence.conditions_outstanding} of ${evidence.conditions_total} outstanding.`,
      };
    case 'funding_confirmed':
      return {
        complete: evidence.funding_confirmed,
        detail: evidence.funding_confirmed
          ? 'Funding is confirmed with final figures.'
          : 'Funding has not been confirmed.',
      };
    default:
      return null;
  }
}

/**
 * Write a derived item's answer back onto the item.
 *
 * Without this the checklist screen and the review queue disagree: a derived
 * item is never ticked by anybody, so its stored status stays "outstanding"
 * for ever, and a queue counting stored statuses reports nine outstanding
 * items on a file that is complete. The derivation is the answer, so it is
 * also the stored answer — and it flips back if the evidence goes away, which
 * is the behaviour a reviewer wants from evidence that disappeared.
 *
 * `completed_by` is deliberately left null on these: nobody claimed it, the
 * file did.
 */
export async function syncDerivedItems(
  complianceCaseId: string,
  answers: Array<{ id: string; status: string; derived_complete: boolean | null }>,
): Promise<number> {
  const changed = answers.filter((a) =>
    a.derived_complete !== null
    && a.status !== 'not_applicable'
    && a.status !== (a.derived_complete ? 'complete' : 'outstanding'));
  if (!changed.length) return 0;

  await query(
    `UPDATE compliance_checklist_items AS i
        SET status = v.status,
            completed_at = CASE WHEN v.status = 'complete' THEN now() ELSE NULL END,
            completed_by = NULL
       FROM (SELECT unnest($2::uuid[]) AS id, unnest($3::text[]) AS status) AS v
      WHERE i.id = v.id AND i.compliance_case_id = $1`,
    [complianceCaseId, changed.map((c) => c.id),
     changed.map((c) => (c.derived_complete ? 'complete' : 'outstanding'))],
  );
  return changed.length;
}

/**
 * Bring the stored checklist into line with the evidence, and say what is
 * outstanding.
 *
 * One function, called from everywhere that shows a count, because the first
 * version of this computed the number in two places and the file header said
 * nine outstanding while the tab beneath it said eight. Two numbers for the
 * same fact is worse than either being wrong.
 */
export async function refreshChecklist(
  applicationId: string,
  complianceCaseId: string,
): Promise<{ outstanding_required: number; total_required: number; changed: number }> {
  const evidence = await gatherEvidence(applicationId, complianceCaseId);
  const { rows } = await query<{
    id: string; item_key: string; status: string; required: boolean;
  }>(
    `SELECT id, item_key, status, required FROM compliance_checklist_items
      WHERE compliance_case_id = $1`,
    [complianceCaseId],
  );
  const answers = rows.map((r) => ({
    ...r, derived_complete: deriveItem(r.item_key, evidence)?.complete ?? null,
  }));
  const changed = await syncDerivedItems(complianceCaseId, answers);

  const required = answers.filter((a) => a.required);
  const outstanding = required.filter((a) => {
    const complete = a.derived_complete ?? (a.status === 'complete');
    return !complete && a.status !== 'not_applicable';
  });
  return {
    outstanding_required: outstanding.length,
    total_required: required.length,
    changed,
  };
}

// ── The risk assessment ────────────────────────────────────────────────────

export async function gatherRiskFacts(
  organizationId: string,
  applicationId: string,
  complianceCaseId: string,
  timezone?: string,
): Promise<RiskFacts> {
  const row = await queryOne<{
    transaction_type_key: string | null; amount_requested: string | null;
    property_province: string | null; property_city: string | null;
    down_payment_source: string | null;
    applicants: Array<Record<string, unknown>>;
    document_categories: string[];
    fintrac: RiskFacts['fintrac'];
    prior_fundings: RiskFacts['priorFundings'];
  }>(
    `SELECT app.transaction_type_key, app.amount_requested, app.property_province,
            app.property_city, app.down_payment_source,
            COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM application_applicants a
                       WHERE a.application_id = app.id), '[]'::jsonb) AS applicants,
            COALESCE((SELECT array_agg(DISTINCT d.category_key) FROM documents d
                       WHERE d.application_id = app.id AND d.review_status <> 'rejected'
                         AND d.archived_at IS NULL AND d.category_key IS NOT NULL), '{}') AS document_categories,
            (SELECT jsonb_build_object(
                      'third_party_present', fa.third_party_present,
                      'third_party_checked', fa.third_party_checked,
                      'entity_borrower', fa.entity_borrower,
                      'ownership_confirmed_at', fa.ownership_confirmed_at,
                      'completed_at', fa.completed_at,
                      'pep_result', fa.pep_result,
                      'pep_screened', fa.pep_screened,
                      'source_of_funds', fa.source_of_funds)
               FROM fintrac_assessments fa WHERE fa.compliance_case_id = $2) AS fintrac,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
                               'funding_date', f.funding_date,
                               'final_transaction_type', f.final_transaction_type)
                               ORDER BY f.funding_date DESC)
                        FROM funding_records f
                        JOIN applications other ON other.id = f.application_id
                       WHERE other.customer_id = app.customer_id AND other.id <> app.id
                         AND f.confirmed), '[]'::jsonb) AS prior_fundings
       FROM applications app
      WHERE app.id = $1 AND app.organization_id = $3`,
    [applicationId, complianceCaseId, organizationId],
  );
  if (!row) throw new Error('No such application.');

  return {
    transactionTypeKey: row.transaction_type_key,
    amountRequested: row.amount_requested === null ? null : Number(row.amount_requested),
    propertyProvince: row.property_province,
    propertyCity: row.property_city,
    applicants: row.applicants ?? [],
    documentCategories: row.document_categories ?? [],
    downPaymentSource: row.down_payment_source,
    fintrac: row.fintrac,
    priorFundings: row.prior_fundings ?? [],
    today: todayIn(timezone ?? env.BROKERAGE_TIMEZONE),
  };
}

export async function factorDefinitions(
  organizationId: string,
  modelKey = 'standard',
): Promise<{ definitions: FactorDefinition[]; version: number }> {
  const { rows } = await query<FactorDefinition & { model_version: number }>(
    `SELECT factor_key, label, description, weight, evaluator, parameters, model_version
       FROM risk_factor_definitions
      WHERE organization_id = $1 AND model_key = $2 AND active
        AND effective_from <= CURRENT_DATE
      ORDER BY model_version DESC, factor_key`,
    [organizationId, modelKey],
  );
  // Only the newest effective version of the model runs; mixing versions
  // would produce a score that belongs to no model at all.
  const version = rows[0]?.model_version ?? 1;
  return {
    definitions: rows.filter((r) => r.model_version === version)
      .map((r) => ({ ...r, weight: Number(r.weight) })),
    version,
  };
}

/**
 * Compute and store a risk assessment, superseding the previous one.
 *
 * Superseded rather than replaced: "why was this file rated medium in March"
 * is a question somebody will ask, and the answer has to survive the
 * reassessment that happened in April.
 */
export async function reassess(
  organizationId: string,
  applicationId: string,
  complianceCaseId: string,
  timezone?: string,
): Promise<RiskResult & { assessmentId: string }> {
  const [facts, model] = await Promise.all([
    gatherRiskFacts(organizationId, applicationId, complianceCaseId, timezone),
    factorDefinitions(organizationId),
  ]);
  const result = assessRisk(model.definitions, facts, DEFAULT_BANDS);

  const assessmentId = await withTransaction(async (client) => {
    await client.query(
      `UPDATE risk_assessments SET superseded_at = now()
        WHERE application_id = $1 AND superseded_at IS NULL`,
      [applicationId],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO risk_assessments (organization_id, compliance_case_id, application_id,
                                     model_key, model_version, score, rating, factors)
       VALUES ($1,$2,$3,'standard',$4,$5,$6,$7::jsonb) RETURNING id`,
      [organizationId, complianceCaseId, applicationId, model.version,
       result.score, result.rating, JSON.stringify(result.factors)],
    );
    return rows[0]!.id;
  });

  return { ...result, assessmentId };
}

/**
 * Whether the case can be approved, and everything standing in the way.
 *
 * Names every blocker rather than the first: a reviewer told "identity is
 * outstanding", who fixes it and is then told "and so is the suitability
 * rationale", learns to distrust the screen.
 */
export function approvalBlockers(
  items: Array<{ label: string; required: boolean; status: string; derived_complete?: boolean | null }>,
  risk: { rating: string | null; override_rating: string | null } | null,
  fintracComplete: boolean,
): string[] {
  const blockers: string[] = [];
  for (const item of items) {
    if (!item.required) continue;
    const complete = item.derived_complete ?? (item.status === 'complete');
    if (!complete && item.status !== 'not_applicable') blockers.push(item.label);
  }
  if (!risk || (!risk.rating && !risk.override_rating)) {
    blockers.push('A risk rating has not been recorded');
  } else if ((risk.override_rating ?? risk.rating) === 'review_required') {
    blockers.push('The risk assessment is unresolved — a person must rate it');
  }
  if (!fintracComplete) blockers.push('The FINTRAC assessment has not been completed');
  return blockers;
}

/**
 * What is stopping commission being paid on this file.
 *
 * Answer 19: the checks confirm every requirement is complete before
 * commission is paid. That is a different question from "can this file be
 * approved" — approval is about the compliance case, this is about money
 * leaving the brokerage — so it is asked separately and answered by naming
 * every outstanding item rather than a yes/no.
 *
 * Returns an empty array when nothing is outstanding. Items marked
 * `not_applicable` are not blockers: a file with no appraisal requirement
 * should not be held for one.
 */
export async function commissionPayoutBlockers(
  applicationId: string,
): Promise<Array<{ item_key: string; label: string; group_key: string | null; status: string }>> {
  const { rows } = await query<{
    item_key: string; label: string; group_key: string | null; status: string;
  }>(
    `SELECT i.item_key, i.label, i.group_key, i.status
       FROM compliance_checklist_items i
       JOIN compliance_cases c ON c.id = i.compliance_case_id
      WHERE c.application_id = $1
        AND i.required
        AND i.status IN ('outstanding', 'rejected')
      ORDER BY i.position, i.label`,
    [applicationId],
  );
  return rows;
}
