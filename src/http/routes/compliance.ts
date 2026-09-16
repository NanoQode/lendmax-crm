/**
 * Compliance: the file's case, the queue, and the package.
 *
 * The rule that shapes every handler here: NOTHING THIS FILE SERVES REACHES A
 * CLIENT. There is no client-facing route in this module, the escalation
 * fields are never included in any client export, and the word used in the
 * UI for an escalation is "escalated to compliance" rather than anything that
 * would tell a client what is being considered. Tipping off is the one
 * mistake a CRM can make here that cannot be corrected afterwards.
 *
 * The second rule: a person decides. The model's rating is computed and
 * stored, and a compliance manager's rating sits beside it. An override
 * records who disagreed and why, and the screen shows both.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool, query, queryOne, withTransaction } from '../../db/pool.ts';
import { recordAudit } from '../../services/audit.ts';
import { asyncRoute, AppError, notFound } from '../middleware/errors.ts';
import { actorOf, requireAuth, requirePermission } from '../middleware/auth.ts';
import { collectedFromClient } from '../../services/compliance-collected.ts';
import { can } from '../../domain/permissions.ts';
import {
  approvalBlockers, deriveItem, gatherEvidence, openCase, reassess, refreshChecklist,
  syncDerivedItems,
} from '../../services/compliance.ts';

export const complianceRoutes: Router = Router();
complianceRoutes.use(requireAuth);

// ── One file's compliance case ─────────────────────────────────────────────

complianceRoutes.get(
  '/applications/:id/compliance',
  requirePermission('compliance.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const applicationId = String(req.params.id);

    const app = await queryOne<{ id: string }>(
      `SELECT id FROM applications WHERE id = $1 AND organization_id = $2`,
      [applicationId, user.organization_id]);
    if (!app) throw notFound('That application');

    const complianceCase = await openCase(pool, user.organization_id, applicationId);
    const evidence = await gatherEvidence(applicationId, complianceCase.id);

    // A case with no assessment at all shows nothing where the meter should
    // be, which reads as "no risk" rather than "not looked at". So the first
    // read computes one — it is a suggestion either way, and one that says
    // "review required, three determinations are outstanding" is the honest
    // starting state.
    const assessed = await queryOne<{ id: string }>(
      `SELECT id FROM risk_assessments
        WHERE application_id = $1 AND superseded_at IS NULL LIMIT 1`, [applicationId]);
    if (!assessed) {
      await reassess(user.organization_id, applicationId, complianceCase.id,
                     user.timezone ?? undefined);
    }

    const items = await query<{
      id: string; item_key: string; group_key: string | null; label: string;
      required: boolean; status: string; note: string | null; position: number;
      completed_at: string | null; completed_by_name: string | null;
    }>(
      `SELECT i.id, i.item_key, i.group_key, i.label, i.required, i.status, i.note,
              i.position, i.completed_at, u.name AS completed_by_name
         FROM compliance_checklist_items i
         LEFT JOIN users u ON u.id = i.completed_by
        WHERE i.compliance_case_id = $1 ORDER BY i.position`,
      [complianceCase.id]);

    // Each item carries how it is answered. A derived item is not a checkbox:
    // it reads the record it claims to represent, and a person cannot tick it
    // while that record says otherwise.
    const checklist = items.rows.map((item) => {
      const derived = deriveItem(item.item_key, evidence);
      return {
        ...item,
        derived: derived !== null,
        derived_complete: derived?.complete ?? null,
        evidence: derived?.detail ?? null,
        complete: derived ? derived.complete : item.status === 'complete',
      };
    });

    // The derived answers are the stored answers, so the queue's counts and
    // this screen cannot disagree.
    await syncDerivedItems(complianceCase.id, checklist);

    const [risk, fintrac, suitability, identities] = await Promise.all([
      queryOne(
        `SELECT id, score, rating, factors, model_version, computed_at,
                overridden, override_rating, override_reason, overridden_at,
                (SELECT name FROM users WHERE id = overridden_by) AS overridden_by_name
           FROM risk_assessments
          WHERE application_id = $1 AND superseded_at IS NULL
          ORDER BY computed_at DESC LIMIT 1`, [applicationId]),
      queryOne(
        `SELECT * FROM fintrac_assessments WHERE compliance_case_id = $1`,
        [complianceCase.id]),
      queryOne(
        `SELECT s.*, p.name AS prepared_by_name, r.name AS reviewed_by_name
           FROM suitability_assessments s
           LEFT JOIN users p ON p.id = s.prepared_by
           LEFT JOIN users r ON r.id = s.reviewed_by
          WHERE s.application_id = $1 ORDER BY s.created_at DESC LIMIT 1`, [applicationId]),
      query(
        `SELECT iv.id, iv.applicant_id, iv.method, iv.method_detail, iv.document_type,
                iv.document_country, iv.document_province, iv.id_number_last4,
                iv.document_expiry, iv.verified_on, iv.status, iv.note,
                u.name AS verified_by_name,
                a.first_name, a.last_name
           FROM identity_verifications iv
           LEFT JOIN users u ON u.id = iv.verified_by
           LEFT JOIN application_applicants a ON a.id = iv.applicant_id
          WHERE iv.application_id = $1 ORDER BY a.position NULLS LAST, iv.created_at`,
        [applicationId]),
    ]);

    const applicants = await query<{ id: string; first_name: string; last_name: string }>(
      `SELECT id, first_name, last_name FROM application_applicants
        WHERE application_id = $1 ORDER BY position`, [applicationId]);

    const fintracComplete = !!(fintrac as { completed_at?: string } | null)?.completed_at;
    const blockers = approvalBlockers(
      checklist,
      risk as { rating: string | null; override_rating: string | null } | null,
      fintracComplete,
    );

    res.json({
      case: complianceCase,
      checklist,
      // Grouped the way a reviewer works through them, not alphabetically.
      groups: [...new Set(checklist.map((i) => i.group_key ?? 'other'))],
      risk,
      fintrac,
      suitability,
      identities: identities.rows,
      applicants: applicants.rows,
      blockers,
      can_approve: blockers.length === 0 && can(user, 'compliance.review'),
      can_edit: can(user, 'compliance.edit'),
    });
  }),
);

/**
 * Everything collected from the client so far: contact details, each
 * application section and its state, documents, consents and ID checks.
 * Read under the same rules as the Application tab.
 */
complianceRoutes.get(
  '/applications/:id/compliance/collected',
  requirePermission('compliance.view'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound('That application');
    res.json({ ok: true, ...(await collectedFromClient({
      actor: actorOf(req),
      viewAll: can(req.user!, 'customer.view_all'),
      edit: false,
      viewFinancials: can(req.user!, 'pii.view_financials'),
    }, id.data)) });
  }),
);

// ── The checklist ──────────────────────────────────────────────────────────

complianceRoutes.post(
  '/compliance/items/:id',
  requirePermission('compliance.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      status: z.enum(['outstanding', 'complete', 'not_applicable', 'rejected']),
      note: z.string().trim().optional(),
      document_id: z.string().uuid().nullable().optional(),
    }).parse(req.body);

    const item = await queryOne<{
      id: string; item_key: string; label: string; compliance_case_id: string;
      application_id: string;
    }>(
      `SELECT i.id, i.item_key, i.label, i.compliance_case_id, c.application_id
         FROM compliance_checklist_items i
         JOIN compliance_cases c ON c.id = i.compliance_case_id
        WHERE i.id = $1 AND c.organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!item) throw notFound('That checklist item');

    // A derived item is answered by the record, not by a person ticking it.
    // Marking it complete by hand would be recording evidence that does not
    // exist, so the refusal names what would actually make it true.
    const evidence = await gatherEvidence(item.application_id, item.compliance_case_id);
    const derived = deriveItem(item.item_key, evidence);
    if (derived && body.status === 'complete' && !derived.complete) {
      throw new AppError(
        `"${item.label}" is answered by the file itself, and the file does not support it yet. `
        + derived.detail,
        409, 'not_supported_by_evidence',
      );
    }

    await query(
      `UPDATE compliance_checklist_items
          SET status = $2, note = $3, document_id = $4,
              completed_by = CASE WHEN $2 IN ('complete','not_applicable') THEN $5::uuid ELSE NULL END,
              completed_at = CASE WHEN $2 IN ('complete','not_applicable') THEN now() ELSE NULL END
        WHERE id = $1`,
      [item.id, body.status, body.note ?? null, body.document_id ?? null, user.id]);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'compliance.item',
      entityType: 'application',
      entityId: item.application_id,
      summary: `"${item.label}" marked ${body.status.replace(/_/g, ' ')}`
        + (body.note ? ` — ${body.note}` : ''),
    });

    res.json({ ok: true });
  }),
);

// ── Identity verification ──────────────────────────────────────────────────

const IdentityInput = z.object({
  applicant_id: z.string().uuid().nullable().optional(),
  method: z.enum(['government_photo_id', 'credit_file', 'dual_process',
                  'affiliate_reliance', 'agent_mandate', 'other']),
  method_detail: z.string().trim().optional(),
  document_type: z.string().trim().optional(),
  document_country: z.string().trim().optional(),
  document_province: z.string().trim().optional(),
  // Four characters, and the schema will not take more. A CRM has no
  // operational need for a complete passport number, and holding one is a
  // breach waiting to happen.
  id_number_last4: z.string().regex(/^[A-Za-z0-9]{1,4}$/, 'Record the last four characters only.')
    .optional(),
  document_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  verified_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['pending', 'verified', 'failed', 'expired', 'waived']).default('verified'),
  evidence_document_id: z.string().uuid().optional(),
  note: z.string().trim().optional(),
});

complianceRoutes.post(
  '/applications/:id/identity',
  requirePermission('compliance.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = IdentityInput.parse(req.body);
    const app = await queryOne<{ id: string; customer_id: string }>(
      `SELECT id, customer_id FROM applications WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!app) throw notFound('That application');

    if (body.status === 'verified' && !body.verified_on) {
      throw new AppError('Record the date the identity was verified.', 400);
    }
    if (body.document_expiry && body.verified_on
        && body.document_expiry < body.verified_on) {
      throw new AppError(
        'That document had already expired on the date it was verified.', 400);
    }

    const created = await queryOne<{ id: string }>(
      `INSERT INTO identity_verifications
         (organization_id, customer_id, application_id, applicant_id, method, method_detail,
          document_type, document_country, document_province, id_number_last4,
          document_expiry, verified_on, verified_by, status, evidence_document_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12::date,$13,$14,$15,$16)
       RETURNING id`,
      [user.organization_id, app.customer_id, app.id, body.applicant_id ?? null,
       body.method, body.method_detail ?? null, body.document_type ?? null,
       body.document_country ?? null, body.document_province ?? null,
       body.id_number_last4 ?? null, body.document_expiry ?? null,
       body.verified_on ?? null, user.id, body.status,
       body.evidence_document_id ?? null, body.note ?? null]);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'compliance.identity',
      entityType: 'application',
      entityId: app.id,
      summary: `Identity recorded as ${body.status} by ${body.method.replace(/_/g, ' ')}`,
      // The method and its evidence are what has to be defensible; the
      // document number is not in the audit any more than it is in the table.
      after: { method: body.method, status: body.status, document_type: body.document_type },
    });

    res.status(201).json({ id: created!.id });
  }),
);

// ── The FINTRAC assessment ─────────────────────────────────────────────────

const FintracInput = z.object({
  relationship_purpose: z.string().trim().optional(),
  relationship_nature: z.string().trim().optional(),
  third_party_checked: z.boolean().optional(),
  third_party_present: z.boolean().nullable().optional(),
  third_party_detail: z.string().trim().optional(),
  entity_borrower: z.boolean().optional(),
  entity_name: z.string().trim().optional(),
  entity_registration: z.string().trim().optional(),
  beneficial_owners: z.array(z.object({
    name: z.string(), percent: z.number().optional(), role: z.string().optional(),
  })).optional(),
  pep_screened: z.boolean().optional(),
  pep_result: z.enum(['none', 'domestic', 'foreign', 'hio', 'family', 'associate'])
    .nullable().optional(),
  pep_detail: z.string().trim().optional(),
  source_of_funds: z.string().trim().optional(),
  source_of_funds_detail: z.string().trim().optional(),
  source_of_wealth: z.string().trim().optional(),
  monitoring_level: z.enum(['standard', 'enhanced']).nullable().optional(),
  monitoring_note: z.string().trim().optional(),
  complete: z.boolean().optional(),
});

complianceRoutes.put(
  '/applications/:id/fintrac',
  requirePermission('compliance.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = FintracInput.parse(req.body);
    const applicationId = String(req.params.id);
    const complianceCase = await queryOne<{ id: string }>(
      `SELECT c.id FROM compliance_cases c
        WHERE c.application_id = $1 AND c.organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!complianceCase) throw notFound('That compliance case');

    const fields: string[] = [];
    const params: unknown[] = [complianceCase.id];
    for (const [column, value] of Object.entries(body)) {
      if (column === 'complete' || value === undefined) continue;
      params.push(column === 'beneficial_owners' ? JSON.stringify(value) : value);
      fields.push(`${column} = $${params.length}${column === 'beneficial_owners' ? '::jsonb' : ''}`);
    }
    // Screening is an event with a time, and "screened" with no timestamp is
    // an assertion rather than a record.
    if (body.pep_screened === true) fields.push('pep_screened_at = now()');
    if ((body.beneficial_owners ?? []).length) fields.push('ownership_confirmed_at = now()');

    if (body.complete === true) {
      const blockers = fintracBlockers(body);
      if (blockers.length) {
        throw new AppError(
          `The assessment is not finished: ${blockers.join('; ')}.`, 400, 'incomplete', blockers);
      }
      params.push(user.id);
      fields.push(`completed_by = $${params.length}`, 'completed_at = now()');
    }

    if (fields.length) {
      await query(
        `UPDATE fintrac_assessments SET ${fields.join(', ')} WHERE compliance_case_id = $1`,
        params);
    }

    // A determination that changes the risk picture changes the risk score.
    await reassess(user.organization_id, applicationId, complianceCase.id, user.timezone ?? undefined);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'compliance.fintrac',
      entityType: 'application',
      entityId: applicationId,
      summary: body.complete
        ? 'FINTRAC assessment completed'
        : `FINTRAC assessment updated (${Object.keys(body).length} field(s))`,
    });

    res.json({ ok: true });
  }),
);

/** What is still missing before a FINTRAC assessment can be called complete. */
function fintracBlockers(body: z.infer<typeof FintracInput>): string[] {
  const missing: string[] = [];
  if (!body.relationship_purpose) missing.push('the purpose of the relationship is blank');
  if (body.third_party_checked !== true) missing.push('the third-party determination is not made');
  if (body.pep_screened !== true || !body.pep_result) missing.push('PEP screening is not recorded');
  if (!body.source_of_funds) missing.push('no source of funds is recorded');
  if (body.entity_borrower === true && !(body.beneficial_owners ?? []).length) {
    missing.push('the borrower is an entity and no beneficial owner is listed');
  }
  return missing;
}

// ── Risk ───────────────────────────────────────────────────────────────────

complianceRoutes.post(
  '/applications/:id/risk/reassess',
  requirePermission('compliance.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const applicationId = String(req.params.id);
    const complianceCase = await queryOne<{ id: string }>(
      `SELECT id FROM compliance_cases WHERE application_id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!complianceCase) throw notFound('That compliance case');

    const result = await reassess(
      user.organization_id, applicationId, complianceCase.id, user.timezone ?? undefined);
    res.json(result);
  }),
);

/**
 * A person's rating, recorded beside the model's.
 *
 * The override never edits the computed score. Both are kept, because the
 * question asked in a review is not "what is the rating" but "what did the
 * model say and what did a person decide".
 */
complianceRoutes.post(
  '/applications/:id/risk/override',
  requirePermission('compliance.review'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      rating: z.enum(['low', 'medium', 'high', 'review_required']),
      reason: z.string().trim().min(10, 'Say why, in a sentence somebody can read later.'),
    }).parse(req.body);
    const applicationId = String(req.params.id);

    const assessment = await queryOne<{ id: string; rating: string | null; score: string }>(
      `SELECT ra.id, ra.rating, ra.score FROM risk_assessments ra
         JOIN applications app ON app.id = ra.application_id
        WHERE ra.application_id = $1 AND ra.superseded_at IS NULL
          AND app.organization_id = $2
        ORDER BY ra.computed_at DESC LIMIT 1`,
      [req.params.id, user.organization_id]);
    if (!assessment) throw notFound('A current risk assessment');

    await query(
      `UPDATE risk_assessments
          SET overridden = true, override_rating = $2, override_reason = $3,
              overridden_by = $4, overridden_at = now()
        WHERE id = $1`,
      [assessment.id, body.rating, body.reason, user.id]);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'compliance.risk_override',
      entityType: 'application',
      entityId: applicationId,
      summary: `Risk rated ${body.rating} by hand (the model said `
        + `${assessment.rating ?? 'nothing'}) — ${body.reason}`,
      before: { model_rating: assessment.rating, score: assessment.score },
      after: { rating: body.rating },
    });

    res.json({ ok: true });
  }),
);

// ── Suitability ────────────────────────────────────────────────────────────

const SuitabilityInput = z.object({
  client_objective: z.string().trim().optional(),
  financial_circumstances: z.string().trim().optional(),
  client_priorities: z.string().trim().optional(),
  constraints: z.string().trim().optional(),
  products_considered: z.array(z.object({
    lender: z.string().optional(), product: z.string().optional(),
    rate: z.string().optional(), term: z.string().optional(),
    amortization: z.string().optional(), why_not: z.string().optional(),
  })).optional(),
  recommended_product: z.string().trim().optional(),
  recommended_lender: z.string().trim().optional(),
  why_appropriate: z.string().trim().optional(),
  material_costs: z.string().trim().optional(),
  material_risks: z.string().trim().optional(),
  alternatives_rejected: z.string().trim().optional(),
  exit_strategy: z.string().trim().optional(),
  special_considerations: z.string().trim().optional(),
  ai_assisted: z.boolean().optional(),
  submit: z.boolean().optional(),
});

/**
 * The suitability rationale.
 *
 * The test it is built to pass: another qualified reviewer, a year later, can
 * read it and follow what was known, what was considered, and why the
 * recommendation was made. So submitting it checks that the parts which carry
 * that story are actually there — a rationale with a recommended lender and
 * nothing else is a record of a decision, not of the reasoning.
 */
complianceRoutes.put(
  '/applications/:id/suitability',
  requirePermission('compliance.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = SuitabilityInput.parse(req.body);
    const applicationId = String(req.params.id);

    const app = await queryOne<{ id: string }>(
      `SELECT id FROM applications WHERE id = $1 AND organization_id = $2`,
      [applicationId, user.organization_id]);
    if (!app) throw notFound('That application');

    const complianceCase = await openCase(pool, user.organization_id, applicationId);

    if (body.submit) {
      const missing: string[] = [];
      if (!body.client_objective) missing.push('what the client is trying to achieve');
      if (!body.recommended_product && !body.recommended_lender) missing.push('what was recommended');
      if (!body.why_appropriate) missing.push('why it is appropriate for them');
      if (!body.material_costs) missing.push('the material costs');
      if (!body.material_risks) missing.push('the material risks');
      if (missing.length) {
        throw new AppError(
          `A rationale another reviewer can follow needs ${missing.join(', ')}.`,
          400, 'incomplete', missing);
      }
    }

    const columns: Record<string, unknown> = {
      client_objective: body.client_objective,
      financial_circumstances: body.financial_circumstances,
      client_priorities: body.client_priorities,
      constraints: body.constraints,
      products_considered: body.products_considered
        ? JSON.stringify(body.products_considered) : undefined,
      recommended_product: body.recommended_product,
      recommended_lender: body.recommended_lender,
      why_appropriate: body.why_appropriate,
      material_costs: body.material_costs,
      material_risks: body.material_risks,
      alternatives_rejected: body.alternatives_rejected,
      exit_strategy: body.exit_strategy,
      special_considerations: body.special_considerations,
      // An AI draft is a draft. This records that one was used and that a
      // named person adopted it; the system never signs a rationale.
      ai_assisted: body.ai_assisted,
    };

    const id = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM suitability_assessments
          WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [applicationId]);
      const existing = rows[0];

      const names = Object.keys(columns).filter((k) => columns[k] !== undefined);
      const values = names.map((k) => columns[k]);

      if (existing && existing.status !== 'approved') {
        const sets = names.map((n, i) =>
          `${n} = $${i + 2}${n === 'products_considered' ? '::jsonb' : ''}`);
        sets.push(`prepared_by = $${names.length + 2}`, 'prepared_at = now()');
        if (body.submit) sets.push(`status = 'submitted'`);
        await client.query(
          `UPDATE suitability_assessments SET ${sets.join(', ')} WHERE id = $1`,
          [existing.id, ...values, user.id]);
        return existing.id;
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO suitability_assessments
           (organization_id, application_id, compliance_case_id, prepared_by, prepared_at,
            status${names.length ? ', ' + names.join(', ') : ''})
         VALUES ($1,$2,$3,$4,now(),$5${
           names.map((n, i) => `,$${i + 6}${n === 'products_considered' ? '::jsonb' : ''}`).join('')})
         RETURNING id`,
        [user.organization_id, applicationId, complianceCase.id, user.id,
         body.submit ? 'submitted' : 'draft', ...values]);
      return inserted.rows[0]!.id;
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'compliance.suitability',
      entityType: 'application',
      entityId: applicationId,
      summary: body.submit
        ? `Suitability rationale submitted${body.ai_assisted ? ' (AI-assisted draft, adopted)' : ''}`
        : 'Suitability rationale saved as a draft',
    });

    res.json({ ok: true, id });
  }),
);

// ── The decision ───────────────────────────────────────────────────────────

/**
 * Approve, request changes, or reject.
 *
 * Approval re-reads the blockers rather than trusting what the screen was
 * showing: the file may have moved since the reviewer opened it, and
 * approving a case whose evidence has since gone missing is the specific
 * failure this re-check prevents.
 */
complianceRoutes.post(
  '/applications/:id/compliance/decision',
  requirePermission('compliance.review'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      decision: z.enum(['approved', 'changes_requested', 'rejected', 'on_hold']),
      note: z.string().trim().optional(),
    }).parse(req.body);
    const applicationId = String(req.params.id);

    const complianceCase = await queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM compliance_cases
        WHERE application_id = $1 AND organization_id = $2`,
      [applicationId, user.organization_id]);
    if (!complianceCase) throw notFound('That compliance case');

    if (body.decision !== 'approved' && !body.note) {
      throw new AppError(
        'Say what needs to change. A refusal with no reason cannot be acted on.', 400);
    }

    if (body.decision === 'approved') {
      const evidence = await gatherEvidence(applicationId, complianceCase.id);
      const { rows: items } = await query<{
        item_key: string; label: string; required: boolean; status: string;
      }>(
        `SELECT item_key, label, required, status FROM compliance_checklist_items
          WHERE compliance_case_id = $1`, [complianceCase.id]);
      const checklist = items.map((i) => {
        const derived = deriveItem(i.item_key, evidence);
        return { ...i, derived_complete: derived?.complete ?? null };
      });
      const risk = await queryOne<{ rating: string | null; override_rating: string | null }>(
        `SELECT rating, override_rating FROM risk_assessments
          WHERE application_id = $1 AND superseded_at IS NULL
          ORDER BY computed_at DESC LIMIT 1`, [applicationId]);
      const fintrac = await queryOne<{ completed_at: string | null }>(
        `SELECT completed_at FROM fintrac_assessments WHERE compliance_case_id = $1`,
        [complianceCase.id]);

      const blockers = approvalBlockers(checklist, risk, !!fintrac?.completed_at);
      if (blockers.length) {
        throw new AppError(
          blockers.length === 1
            ? `This file cannot be approved yet: ${blockers[0]}.`
            : `This file cannot be approved yet — ${blockers.length} things are outstanding.`,
          409, 'blocked', blockers);
      }
    }

    await query(
      `UPDATE compliance_cases
          SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4,
              approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE NULL END
        WHERE id = $1`,
      [complianceCase.id, body.decision, user.id, body.note ?? null]);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'compliance.decision',
      entityType: 'application',
      entityId: applicationId,
      summary: `Compliance ${body.decision.replace(/_/g, ' ')}`
        + (body.note ? ` — ${body.note}` : ''),
      before: { status: complianceCase.status },
      after: { status: body.decision },
    });

    res.json({ ok: true, status: body.decision });
  }),
);

/**
 * A legal hold stops the retention runner touching the file.
 *
 * Lifting one is a separate, audited act: a hold that anybody can clear on
 * the way past is not a hold.
 */
complianceRoutes.post(
  '/applications/:id/compliance/hold',
  requirePermission('compliance.legal_hold'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      hold: z.boolean(),
      reason: z.string().trim().min(5, 'Record why the hold is being placed or lifted.'),
    }).parse(req.body);
    const applicationId = String(req.params.id);

    const complianceCase = await queryOne<{ id: string; legal_hold: boolean }>(
      `SELECT id, legal_hold FROM compliance_cases
        WHERE application_id = $1 AND organization_id = $2`,
      [applicationId, user.organization_id]);
    if (!complianceCase) throw notFound('That compliance case');

    await query(
      `UPDATE compliance_cases
          SET legal_hold = $2,
              legal_hold_reason = $3,
              legal_hold_at = CASE WHEN $2 THEN now() ELSE legal_hold_at END,
              legal_hold_by = $4
        WHERE id = $1`,
      [complianceCase.id, body.hold, body.reason, user.id]);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: body.hold ? 'compliance.hold_placed' : 'compliance.hold_lifted',
      entityType: 'application',
      entityId: applicationId,
      summary: `Legal hold ${body.hold ? 'placed' : 'lifted'} — ${body.reason}`,
    });

    res.json({ ok: true, legal_hold: body.hold });
  }),
);

/**
 * Escalate to compliance.
 *
 * Deliberately neutral wording throughout, and nothing this writes is ever
 * rendered on a client-facing surface or included in a client export. The
 * system does not prepare, file, or draft a report; it routes the file to the
 * compliance manager, who decides what happens next off-system.
 */
complianceRoutes.post(
  '/applications/:id/compliance/escalate',
  requirePermission('compliance.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      note: z.string().trim().min(10, 'Describe what prompted the escalation.'),
    }).parse(req.body);
    const applicationId = String(req.params.id);

    const complianceCase = await queryOne<{ id: string }>(
      `SELECT id FROM compliance_cases WHERE application_id = $1 AND organization_id = $2`,
      [applicationId, user.organization_id]);
    if (!complianceCase) throw notFound('That compliance case');

    await query(
      `UPDATE fintrac_assessments
          SET escalated = true, escalated_at = now(), escalated_by = $2, escalation_note = $3
        WHERE compliance_case_id = $1`,
      [complianceCase.id, user.id, body.note]);

    // The compliance managers, and only them.
    await query(
      `INSERT INTO notifications (organization_id, user_id, kind, title, body, entity_type,
                                  entity_id, dedupe_key)
       SELECT $1, u.id, 'compliance', 'A file has been escalated to compliance', $2,
              'application', $3::text, $4
         FROM users u
        WHERE u.organization_id = $1 AND u.role = 'compliance_manager' AND u.active
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [user.organization_id, body.note, applicationId,
       `compliance-escalation:${complianceCase.id}`]);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'compliance.escalated',
      entityType: 'application',
      entityId: applicationId,
      summary: 'File escalated to compliance for review',
    });

    res.json({ ok: true });
  }),
);

// ── The queue ──────────────────────────────────────────────────────────────

complianceRoutes.get(
  '/compliance',
  requirePermission('compliance.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = z.object({
      status: z.enum(['awaiting_review', 'in_progress', 'changes_requested',
                      'approved', 'on_hold', 'all']).default('awaiting_review'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);

    const params: unknown[] = [user.organization_id, q.limit];
    let filter = '';
    if (q.status !== 'all') {
      params.push(q.status);
      filter = `AND c.status = $3`;
    }

    const { rows } = await query(
      `SELECT c.id, c.status, c.province, c.legal_hold, c.updated_at, c.approved_at,
              app.id AS application_id, app.portal_reference, app.stage_key,
              app.amount_requested, app.closing_date,
              cu.first_name, cu.last_name,
              ra.rating AS model_rating, ra.override_rating, ra.score,
              fa.escalated, fa.completed_at AS fintrac_completed_at,
              (SELECT count(*)::int FROM compliance_checklist_items i
                WHERE i.compliance_case_id = c.id AND i.required
                  AND i.status = 'outstanding') AS outstanding_items,
              u.name AS reviewer_name
         FROM compliance_cases c
         JOIN applications app ON app.id = c.application_id
         JOIN customers cu ON cu.id = c.customer_id
         LEFT JOIN risk_assessments ra
                ON ra.application_id = app.id AND ra.superseded_at IS NULL
         LEFT JOIN fintrac_assessments fa ON fa.compliance_case_id = c.id
         LEFT JOIN users u ON u.id = c.reviewed_by
        WHERE c.organization_id = $1 ${filter}
        ORDER BY fa.escalated DESC NULLS LAST, app.closing_date NULLS LAST, c.updated_at DESC
        LIMIT $2`,
      params);

    const counts = await queryOne(
      `SELECT count(*) FILTER (WHERE status = 'awaiting_review')::int AS awaiting_review,
              count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
              count(*) FILTER (WHERE status = 'changes_requested')::int AS changes_requested,
              count(*) FILTER (WHERE status = 'approved')::int AS approved,
              count(*) FILTER (WHERE legal_hold)::int AS legal_hold
         FROM compliance_cases WHERE organization_id = $1`,
      [user.organization_id]);

    res.json({ cases: rows, counts });
  }),
);
