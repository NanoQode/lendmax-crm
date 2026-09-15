/**
 * Funding, commission and renewals.
 *
 * Funding is RECORDED, never derived from the application. A lender routinely
 * advances a different number from the one requested, and reporting the
 * request as the funding is the error that compounds quietly for a year and
 * then makes every historical figure and every commission calculation wrong.
 *
 * Confirming a funding is the moment several other things become true — the
 * file is funded, the commission is expected, the maturity date is known and
 * so is the renewal — so it happens in one transaction and every consequence
 * is created there rather than by whoever remembers to.
 */
import { Router } from 'express';
import { z } from 'zod';
import { pool, query, queryOne, withTransaction } from '../../db/pool.ts';
import { recordAudit } from '../../services/audit.ts';
import { asyncRoute, AppError, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';
import { can } from '../../domain/permissions.ts';
import {
  commissionFromBps, describeVariance, divideCommission, fromCents,
  maturityFrom, milestonesFor, toCents, variance,
} from '../../domain/money.ts';
import { todayIn } from '../../domain/dates.ts';
import { env } from '../../config/env.ts';
import { commissionPayoutBlockers } from '../../services/compliance.ts';

export const fundingRoutes: Router = Router();
fundingRoutes.use(requireAuth);

// ── One file's money ───────────────────────────────────────────────────────

fundingRoutes.get(
  '/applications/:id/funding',
  requirePermission('funding.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const applicationId = String(req.params.id);

    const app = await queryOne<{ id: string; customer_id: string; amount_requested: string | null }>(
      `SELECT id, customer_id, amount_requested FROM applications
        WHERE id = $1 AND organization_id = $2`,
      [applicationId, user.organization_id]);
    if (!app) throw notFound('That application');

    const [funding, submissions, lenders] = await Promise.all([
      queryOne(
        `SELECT f.*, u.name AS confirmed_by_name
           FROM funding_records f LEFT JOIN users u ON u.id = f.confirmed_by
          WHERE f.application_id = $1`, [applicationId]),
      query(
        `SELECT s.*, (SELECT count(*)::int FROM lender_conditions c
                       WHERE c.lender_submission_id = s.id AND c.status = 'outstanding')
                     AS conditions_outstanding
           FROM lender_submissions s
          WHERE s.application_id = $1 ORDER BY s.submitted_at DESC NULLS LAST`, [applicationId]),
      query(
        `SELECT id, name, short_name, lender_type, default_bps FROM lenders
          WHERE organization_id = $1 AND active ORDER BY name`, [user.organization_id]),
    ]);

    // Commission is behind its own permission: a broker sees their own file's
    // money, and who else's they see is a management decision.
    const showCommission = can(user, 'commission.view');
    const commissions = showCommission
      ? await query(
        `SELECT c.*, u.name AS reconciled_by_name,
                COALESCE((SELECT jsonb_agg(jsonb_build_object(
                            'id', s.id, 'party', s.party, 'user_id', s.user_id,
                            'party_name', COALESCE(s.party_name, su.name),
                            'percent', s.percent, 'amount', s.amount, 'paid_on', s.paid_on)
                            ORDER BY s.party)
                            FROM commission_splits s
                            LEFT JOIN users su ON su.id = s.user_id
                           WHERE s.commission_record_id = c.id), '[]'::jsonb) AS splits
           FROM commission_records c
           LEFT JOIN users u ON u.id = c.reconciled_by
          WHERE c.application_id = $1 ORDER BY c.created_at`, [applicationId])
      : { rows: [] as Array<Record<string, unknown>> };

    const renewal = await queryOne(
      `SELECT r.*, u.name AS assigned_to_name,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                          'key', m.milestone_key, 'due_on', m.due_on, 'status', m.status,
                          'completed_at', m.completed_at, 'skip_reason', m.skip_reason)
                          ORDER BY m.due_on)
                          FROM renewal_milestones m
                         WHERE m.renewal_record_id = r.id), '[]'::jsonb) AS milestones
         FROM renewal_records r LEFT JOIN users u ON u.id = r.assigned_to
        WHERE r.application_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [applicationId]);

    res.json({
      funding,
      submissions: submissions.rows,
      lenders: lenders.rows,
      commissions: commissions.rows.map((c) => {
        const row = c as Record<string, unknown>;
        return {
          ...row,
          variance_description: describeVariance(
            toCents(row.gross_expected), toCents(row.gross_received)),
        };
      }),
      commission_hidden: !showCommission,
      renewal,
      amount_requested: app.amount_requested,
      can_edit: can(user, 'funding.edit'),
      can_edit_commission: can(user, 'commission.edit'),
    });
  }),
);

// ── Recording the funding ──────────────────────────────────────────────────

const FundingInput = z.object({
  lender_id: z.string().uuid().nullable().optional(),
  lender_name: z.string().trim().optional(),
  product_name: z.string().trim().optional(),
  approved_amount: z.union([z.string(), z.number()]).nullable().optional(),
  funded_amount: z.union([z.string(), z.number()]).nullable().optional(),
  rate: z.union([z.string(), z.number()]).nullable().optional(),
  rate_type: z.enum(['fixed', 'variable', 'adjustable']).nullable().optional(),
  term_months: z.number().int().min(1).max(600).nullable().optional(),
  amortization_months: z.number().int().min(1).max(600).nullable().optional(),
  payment_frequency: z.string().trim().optional(),
  payment_amount: z.union([z.string(), z.number()]).nullable().optional(),
  insurance_status: z.enum(['insured', 'insurable', 'uninsured']).nullable().optional(),
  insurer: z.enum(['CMHC', 'Sagen', 'Canada Guaranty']).nullable().optional(),
  insurance_premium: z.union([z.string(), z.number()]).nullable().optional(),
  funding_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  maturity_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  first_payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  lender_fee: z.union([z.string(), z.number()]).nullable().optional(),
  brokerage_fee: z.union([z.string(), z.number()]).nullable().optional(),
  other_fees: z.union([z.string(), z.number()]).nullable().optional(),
  other_fees_note: z.string().trim().optional(),
  final_transaction_type: z.string().trim().optional(),
  note: z.string().trim().optional(),
});

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

const MONEY_FIELDS = ['approved_amount', 'funded_amount', 'payment_amount',
  'insurance_premium', 'lender_fee', 'brokerage_fee', 'other_fees'] as const;

fundingRoutes.put(
  '/applications/:id/funding',
  requirePermission('funding.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = FundingInput.parse(req.body);
    const applicationId = String(req.params.id);

    const app = await queryOne<{ id: string }>(
      `SELECT id FROM applications WHERE id = $1 AND organization_id = $2`,
      [applicationId, user.organization_id]);
    if (!app) throw notFound('That application');

    const existing = await queryOne<{ id: string; confirmed: boolean }>(
      `SELECT id, confirmed FROM funding_records WHERE application_id = $1`, [applicationId]);
    // A confirmed funding is what the commission, the reporting and the
    // renewal all rest on. Changing one is a deliberate act with its own
    // permission, not an edit that happens to go through.
    if (existing?.confirmed && !can(user, 'commission.edit')) {
      throw new AppError(
        'This funding is confirmed. A manager can amend it.', 403, 'confirmed');
    }

    const problems = fundingProblems(body);
    if (problems.length) {
      throw new AppError(problems[0]!, 400, 'invalid_funding', problems);
    }

    const columns: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      columns[key] = (MONEY_FIELDS as readonly string[]).includes(key)
        ? fromCents(toCents(value))
        : value;
    }

    // A maturity date that follows from the funding date and the term is
    // computed rather than asked for again — and only when it was not given,
    // because the lender's own number wins over arithmetic.
    if (!columns.maturity_date && body.funding_date && body.term_months) {
      columns.maturity_date = maturityFrom(body.funding_date, body.term_months);
    }

    const names = Object.keys(columns);
    const values = names.map((n) => columns[n]);

    const id = existing
      ? (await query(
        `UPDATE funding_records SET ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')}
          WHERE id = $1 RETURNING id`, [existing.id, ...values])).rows[0]!.id
      : (await query<{ id: string }>(
        `INSERT INTO funding_records (organization_id, application_id${names.length ? ', ' + names.join(', ') : ''})
         VALUES ($1,$2${names.map((_, i) => `,$${i + 3}`).join('')}) RETURNING id`,
        [user.organization_id, applicationId, ...values])).rows[0]!.id;

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'funding.record',
      entityType: 'application',
      entityId: applicationId,
      summary: existing ? 'Funding details amended' : 'Funding details recorded',
      after: columns,
    });

    res.json({ ok: true, id, maturity_date: columns.maturity_date ?? null });
  }),
);

/** Everything wrong with a funding record, named at once. */
function fundingProblems(body: z.infer<typeof FundingInput>): string[] {
  const problems: string[] = [];
  const funded = toCents(body.funded_amount);
  const approved = toCents(body.approved_amount);

  if (funded !== null && funded <= 0) {
    problems.push('A funded amount of zero is not a funding.');
  }
  if (funded !== null && approved !== null && funded > approved) {
    problems.push(
      'The funded amount is more than the approved amount. Check the figures, or '
      + 'amend the approval.');
  }
  const rate = body.rate === null || body.rate === undefined ? null : Number(body.rate);
  if (rate !== null && Number.isFinite(rate)) {
    // A rate entered as 0.0489 instead of 4.89 makes every payment and every
    // renewal comparison wrong, and looks entirely plausible until somebody
    // checks — so the bound that matters is the LOW one. No Canadian mortgage
    // is written under half a percent; a number below that is a decimal
    // fraction somebody typed into a percentage field.
    if (rate > 0 && rate < 0.5) {
      problems.push(
        `A rate of ${rate}% is almost certainly ${round4(rate * 100)}% typed as a decimal. `
        + 'Rates are recorded as a percentage — 4.89, not 0.0489.');
    } else if (rate <= 0) {
      problems.push('A rate of zero is not a rate.');
    } else if (rate > 30) {
      problems.push(`A rate of ${rate}% does not look right. Check the figure.`);
    }
  }
  if (body.insurer && body.insurance_status === 'uninsured') {
    problems.push('An uninsured mortgage has no insurer.');
  }
  if (body.funding_date && body.maturity_date && body.maturity_date <= body.funding_date) {
    problems.push('The maturity date is on or before the funding date.');
  }
  return problems;
}

/**
 * Confirm the funding.
 *
 * One transaction, because this is the moment several other things become
 * true at once. Doing them separately means a crash between two of them
 * leaves a funded file with no commission expected, and nobody finds out
 * until the month-end reconciliation.
 */
fundingRoutes.post(
  '/applications/:id/funding/confirm',
  requirePermission('funding.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const applicationId = String(req.params.id);
    const body = z.object({
      commission_bps: z.number().min(0).max(1000).nullable().optional(),
      gross_expected: z.union([z.string(), z.number()]).nullable().optional(),
      expected_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      splits: z.array(z.object({
        party: z.enum(['broker', 'brokerage', 'referrer', 'house', 'other']),
        user_id: z.string().uuid().nullable().optional(),
        party_name: z.string().trim().optional(),
        percent: z.number().min(0).max(100).nullable().optional(),
        amount: z.union([z.string(), z.number()]).nullable().optional(),
      })).default([]),
    }).parse(req.body ?? {});

    const funding = await queryOne<{
      id: string; confirmed: boolean; funded_amount: string | null;
      funding_date: string | null; maturity_date: string | null; term_months: number | null;
      lender_id: string | null; lender_name: string | null; rate: string | null;
    }>(
      `SELECT f.id, f.confirmed, f.funded_amount, f.funding_date, f.maturity_date,
              f.term_months, f.lender_id, f.lender_name, f.rate
         FROM funding_records f JOIN applications a ON a.id = f.application_id
        WHERE f.application_id = $1 AND a.organization_id = $2`,
      [applicationId, user.organization_id]);
    if (!funding) throw notFound('A funding record for that application');
    if (funding.confirmed) throw new AppError('This funding is already confirmed.', 409);

    const missing: string[] = [];
    if (!funding.funded_amount) missing.push('the funded amount');
    if (!funding.funding_date) missing.push('the funding date');
    if (!funding.lender_id && !funding.lender_name) missing.push('the lender');
    if (missing.length) {
      throw new AppError(
        `A funding cannot be confirmed without ${missing.join(', ')}.`, 400, 'incomplete', missing);
    }

    const fundedCents = toCents(funding.funded_amount)!;
    const grossCents = toCents(body.gross_expected)
      ?? (body.commission_bps ? commissionFromBps(fundedCents, body.commission_bps) : null);

    const splitResult = body.splits.length && grossCents !== null
      ? divideCommission(grossCents, body.splits.map((s) => ({
        ...s, amount: toCents(s.amount), percent: s.percent ?? null,
      })))
      : null;
    if (splitResult?.problems.length) {
      throw new AppError(splitResult.problems[0]!, 400, 'invalid_splits', splitResult.problems);
    }
    // A remainder that survived the rounding adjustment is money the splits
    // do not account for, and confirming would record a table that does not
    // add up to its own total.
    if (splitResult && splitResult.remainder !== 0) {
      throw new AppError(
        `The splits come to ${fromCents(grossCents! - splitResult.remainder)} `
        + `against a commission of ${fromCents(grossCents!)}.`,
        400, 'invalid_splits');
    }

    const maturity = funding.maturity_date
      ?? (funding.funding_date && funding.term_months
        ? maturityFrom(funding.funding_date, funding.term_months) : null);

    const created = await withTransaction(async (client) => {
      await client.query(
        `UPDATE funding_records
            SET confirmed = true, confirmed_by = $2, confirmed_at = now(),
                maturity_date = COALESCE(maturity_date, $3::date)
          WHERE id = $1`,
        [funding.id, user.id, maturity]);

      // The file is funded. The stage machine's own rules do not apply here:
      // this IS the event they gate on.
      const stage = await client.query<{ key: string }>(
        `SELECT key FROM pipeline_stages
          WHERE organization_id = $1 AND category = 'won' AND active
          ORDER BY position LIMIT 1`, [user.organization_id]);
      if (stage.rows[0]) {
        const previous = await client.query<{ stage_key: string }>(
          `SELECT stage_key FROM applications WHERE id = $1`, [applicationId]);
        await client.query(
          `UPDATE applications SET stage_key = $2, stage_changed_at = now() WHERE id = $1`,
          [applicationId, stage.rows[0].key]);
        await client.query(
          `INSERT INTO stage_transitions (application_id, from_stage_key, to_stage_key,
                                          actor_kind, actor_user_id, reason)
           VALUES ($1,$2,$3,'user',$4,'Funding confirmed')`,
          [applicationId, previous.rows[0]?.stage_key ?? null, stage.rows[0].key, user.id]);
      }

      let commissionId: string | null = null;
      if (grossCents !== null) {
        const commission = await client.query<{ id: string }>(
          `INSERT INTO commission_records
             (organization_id, application_id, funding_record_id, source, lender_id,
              lender_name, basis_bps, gross_expected, expected_on, status)
           VALUES ($1,$2,$3,'lender',$4,$5,$6,$7,$8::date,'expected') RETURNING id`,
          [user.organization_id, applicationId, funding.id, funding.lender_id,
           funding.lender_name, body.commission_bps ?? null, fromCents(grossCents),
           body.expected_on ?? null]);
        commissionId = commission.rows[0]!.id;

        for (const split of splitResult?.splits ?? []) {
          await client.query(
            `INSERT INTO commission_splits
               (commission_record_id, party, user_id, party_name, percent, amount)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [commissionId, split.party, split.user_id ?? null, split.party_name ?? null,
             split.percent ?? null, fromCents(split.amount)]);
        }
      }

      // A funded mortgage is a renewal opportunity with a known date, and
      // creating it here rather than in a nightly job means it exists from
      // the moment it is true.
      let renewalId: string | null = null;
      if (maturity) {
        const customer = await client.query<{ customer_id: string }>(
          `SELECT customer_id FROM applications WHERE id = $1`, [applicationId]);
        const renewal = await client.query<{ id: string }>(
          `INSERT INTO renewal_records
             (organization_id, customer_id, application_id, funding_record_id, maturity_date,
              maturity_source, lender_name, balance_estimate, rate, status, assigned_to)
           VALUES ($1,$2,$3,$4,$5::date,'confirmed',$6,$7,$8,'upcoming',
                   (SELECT user_id FROM assignments
                     WHERE application_id = $3 AND role = 'broker' AND unassigned_at IS NULL
                     ORDER BY is_primary DESC LIMIT 1))
           RETURNING id`,
          [user.organization_id, customer.rows[0]!.customer_id, applicationId, funding.id,
           maturity, funding.lender_name, funding.funded_amount, funding.rate]);
        renewalId = renewal.rows[0]!.id;

        const today = todayIn(user.timezone ?? env.BROKERAGE_TIMEZONE);
        for (const milestone of milestonesFor(maturity, today)) {
          await client.query(
            `INSERT INTO renewal_milestones (renewal_record_id, milestone_key, due_on, status,
                                             skip_reason)
             VALUES ($1,$2,$3::date,$4,$5)
             ON CONFLICT (renewal_record_id, milestone_key) DO NOTHING`,
            [renewalId, milestone.key, milestone.due_on,
             // A milestone already in the past is marked skipped with the
             // reason, rather than firing six months of messages at once.
             milestone.past ? 'skipped' : 'pending',
             milestone.past ? 'The maturity date was already inside this window.' : null]);
        }
      }

      await client.query(
        `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id,
                                    actor_user_id, dedupe_key)
         SELECT $1,'file.funded', a.customer_id, a.id, $3, 'file.funded:' || a.id::text
           FROM applications a WHERE a.id = $2
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [user.organization_id, applicationId, user.id]);

      return { commissionId, renewalId };
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'funding.confirm',
      entityType: 'application',
      entityId: applicationId,
      summary: `Funding confirmed at ${funding.funded_amount}`
        + (grossCents !== null ? `, commission of ${fromCents(grossCents)} expected` : '')
        + (maturity ? `, maturing ${maturity}` : ''),
    });

    res.json({
      ok: true,
      maturity_date: maturity,
      commission_id: created.commissionId,
      renewal_id: created.renewalId,
      splits: splitResult?.splits.map((s) => ({ ...s, amount: fromCents(s.amount) })) ?? [],
    });
  }),
);

// ── Commission ─────────────────────────────────────────────────────────────

/**
 * Record what actually arrived.
 *
 * The variance is stored rather than computed on read, so a variance report
 * is one index scan and so the number that was investigated is the number
 * that was recorded — recomputing it later against changed figures would
 * quietly rewrite the history of an investigation.
 */
fundingRoutes.put(
  '/commissions/:id',
  requirePermission('commission.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      gross_expected: z.union([z.string(), z.number()]).nullable().optional(),
      gross_received: z.union([z.string(), z.number()]).nullable().optional(),
      basis_bps: z.number().min(0).max(1000).nullable().optional(),
      expected_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      received_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      status: z.enum(['expected', 'submitted', 'awaiting_payment', 'received',
                      'reconciled', 'variance', 'closed']).optional(),
      variance_note: z.string().trim().optional(),
      document_id: z.string().uuid().nullable().optional(),
      note: z.string().trim().optional(),
      splits: z.array(z.object({
        party: z.enum(['broker', 'brokerage', 'referrer', 'house', 'other']),
        user_id: z.string().uuid().nullable().optional(),
        party_name: z.string().trim().optional(),
        percent: z.number().min(0).max(100).nullable().optional(),
        amount: z.union([z.string(), z.number()]).nullable().optional(),
      })).optional(),
    }).parse(req.body);

    const record = await queryOne<{
      id: string; application_id: string; gross_expected: string | null;
      gross_received: string | null; status: string;
    }>(
      `SELECT c.id, c.application_id, c.gross_expected, c.gross_received, c.status
         FROM commission_records c
        WHERE c.id = $1 AND c.organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!record) throw notFound('That commission record');

    const expected = body.gross_expected !== undefined
      ? toCents(body.gross_expected) : toCents(record.gross_expected);
    const received = body.gross_received !== undefined
      ? toCents(body.gross_received) : toCents(record.gross_received);
    const difference = variance(expected, received);

    // A variance somebody has not explained is not reconciled, whatever the
    // status field says. This is the whole point of the commission trace.
    let status = body.status ?? record.status;
    if (difference !== null && difference !== 0 && status === 'reconciled'
        && !body.variance_note) {
      throw new AppError(
        `${describeVariance(expected, received).label}. Record what happened before `
        + 'marking this reconciled.', 400, 'unexplained_variance');
    }
    if (difference !== null && difference !== 0 && status === 'received') {
      status = 'variance';
    }

    // Answer 19: the compliance package has to be complete before commission
    // is paid. Checked on the way IN to a paid state rather than continuously,
    // so a file that was legitimately paid does not become retroactively
    // invalid when somebody later adds a requirement to the template.
    //
    // It names every outstanding item rather than refusing flatly: "compliance
    // incomplete" sends somebody hunting, a list is a thing they can finish.
    const PAID_STATES = new Set(['received', 'reconciled', 'closed']);
    if (PAID_STATES.has(status) && !PAID_STATES.has(record.status)) {
      const blockers = await commissionPayoutBlockers(record.application_id);
      if (blockers.length) {
        throw new AppError(
          `Commission cannot be paid while ${blockers.length} required compliance item`
          + `${blockers.length === 1 ? ' is' : 's are'} outstanding: `
          + blockers.map((b) => b.label).join(', ') + '.',
          400, 'compliance_incomplete',
          blockers.map((b) => b.label),
        );
      }
    }

    if (body.splits) {
      const result = divideCommission(received ?? expected ?? 0, body.splits.map((s) => ({
        ...s, amount: toCents(s.amount), percent: s.percent ?? null,
      })));
      if (result.problems.length) {
        throw new AppError(result.problems[0]!, 400, 'invalid_splits', result.problems);
      }
      await withTransaction(async (client) => {
        await client.query('DELETE FROM commission_splits WHERE commission_record_id = $1',
          [record.id]);
        for (const split of result.splits) {
          await client.query(
            `INSERT INTO commission_splits
               (commission_record_id, party, user_id, party_name, percent, amount)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [record.id, split.party, split.user_id ?? null, split.party_name ?? null,
             split.percent ?? null, fromCents(split.amount)]);
        }
      });
    }

    await query(
      `UPDATE commission_records
          SET gross_expected = $2, gross_received = $3, basis_bps = COALESCE($4, basis_bps),
              expected_on = COALESCE($5::date, expected_on),
              received_on = COALESCE($6::date, received_on),
              status = $7, variance_amount = $8, variance_note = COALESCE($9, variance_note),
              document_id = COALESCE($10, document_id), note = COALESCE($11, note),
              reconciled_by = CASE WHEN $7 IN ('reconciled','closed') THEN $12::uuid
                                   ELSE reconciled_by END,
              reconciled_at = CASE WHEN $7 IN ('reconciled','closed') THEN now()
                                   ELSE reconciled_at END
        WHERE id = $1`,
      [record.id, fromCents(expected), fromCents(received), body.basis_bps ?? null,
       body.expected_on ?? null, body.received_on ?? null, status, fromCents(difference),
       body.variance_note ?? null, body.document_id ?? null, body.note ?? null, user.id]);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'commission.update',
      entityType: 'application',
      entityId: record.application_id,
      summary: `Commission ${status.replace(/_/g, ' ')}`
        + (difference ? ` — ${describeVariance(expected, received).label}` : ''),
      before: { expected: record.gross_expected, received: record.gross_received },
      after: { expected: fromCents(expected), received: fromCents(received), status },
    });

    res.json({
      ok: true, status,
      variance: describeVariance(expected, received),
    });
  }),
);

/** The reconciliation queue: what is owed, what is late, what does not match. */
fundingRoutes.get(
  '/commissions',
  requirePermission('commission.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = z.object({
      status: z.enum(['outstanding', 'variance', 'reconciled', 'all']).default('outstanding'),
      mine: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(req.query);

    // $3 is always the caller, so "my share" is a real comparison rather than
    // whichever parameter happened to be in that slot.
    const params: unknown[] = [user.organization_id, q.limit, user.id];
    const where = ['c.organization_id = $1'];

    if (q.status === 'outstanding') {
      where.push(`c.status IN ('expected','submitted','awaiting_payment')`);
    } else if (q.status === 'variance') {
      where.push(`(c.status = 'variance' OR (c.variance_amount IS NOT NULL AND c.variance_amount <> 0))`);
    } else if (q.status === 'reconciled') {
      where.push(`c.status IN ('reconciled','closed')`);
    }

    // A broker who cannot see the whole brokerage's commission sees their own,
    // and is told that is what they are looking at.
    const restricted = !can(user, 'commission.view_all');
    if (restricted || q.mine) {
      where.push(`EXISTS (SELECT 1 FROM commission_splits s
                           WHERE s.commission_record_id = c.id AND s.user_id = $3)`);
    }

    const { rows } = await query(
      `SELECT c.id, c.status, c.source, c.lender_name, c.basis_bps,
              c.gross_expected, c.gross_received, c.expected_on, c.received_on,
              c.variance_amount, c.variance_note,
              app.id AS application_id, app.portal_reference,
              cu.first_name, cu.last_name,
              f.funding_date, f.funded_amount,
              (SELECT s.amount FROM commission_splits s
                WHERE s.commission_record_id = c.id AND s.user_id = $3
                LIMIT 1) AS my_share
         FROM commission_records c
         JOIN applications app ON app.id = c.application_id
         JOIN customers cu ON cu.id = app.customer_id
         LEFT JOIN funding_records f ON f.id = c.funding_record_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.expected_on NULLS LAST, c.created_at
        LIMIT $2`,
      params);

    const totals = await queryOne(
      `SELECT
         COALESCE(sum(gross_expected) FILTER (
           WHERE status IN ('expected','submitted','awaiting_payment')), 0) AS outstanding,
         COALESCE(sum(gross_received) FILTER (
           WHERE received_on >= date_trunc('year', CURRENT_DATE)), 0) AS received_ytd,
         COALESCE(sum(variance_amount) FILTER (WHERE variance_amount <> 0), 0) AS variance_total,
         count(*) FILTER (WHERE status IN ('expected','submitted','awaiting_payment')
                            AND expected_on < CURRENT_DATE)::int AS overdue
         FROM commission_records WHERE organization_id = $1`,
      [user.organization_id]);

    res.json({
      commissions: rows.map((c) => {
        const row = c as Record<string, unknown>;
        return {
          ...row,
          variance_description: describeVariance(
            toCents(row.gross_expected), toCents(row.gross_received)),
        };
      }),
      totals,
      scope: restricted ? 'mine' : q.mine ? 'mine' : 'all',
      scope_reason: restricted
        ? 'You are seeing the files you are paid on. A manager sees the brokerage.'
        : null,
    });
  }),
);

// ── Renewals ───────────────────────────────────────────────────────────────

fundingRoutes.get(
  '/renewals',
  requirePermission('customer.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = z.object({
      window: z.enum(['90', '180', '365', 'all']).default('180'),
      status: z.enum(['open', 'upcoming', 'engaged', 'in_progress', 'resolved', 'all'])
        .default('open'),
      mine: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(300).default(150),
    }).parse(req.query);

    const params: unknown[] = [user.organization_id, q.limit];
    const where = ['r.organization_id = $1'];

    if (q.window !== 'all') {
      where.push(`r.maturity_date <= CURRENT_DATE + ${Number(q.window)}`);
    }
    if (q.status === 'open') where.push(`r.status IN ('upcoming','engaged','in_progress')`);
    else if (q.status === 'resolved') {
      where.push(`r.status IN ('renewed_with_us','lost_to_other','paid_out','declined','cancelled')`);
    } else if (q.status !== 'all') {
      params.push(q.status);
      where.push(`r.status = $${params.length}`);
    }
    if (q.mine) {
      params.push(user.id);
      where.push(`r.assigned_to = $${params.length}`);
    }

    const { rows } = await query(
      `SELECT r.id, r.maturity_date, r.maturity_source, r.lender_name, r.balance_estimate,
              r.rate, r.status, r.outcome_note, r.renewal_application_id,
              (r.maturity_date - CURRENT_DATE) AS days_to_maturity,
              cu.id AS customer_id, cu.first_name, cu.last_name, cu.email, cu.phone_e164,
              app.id AS application_id, app.portal_reference,
              u.name AS assigned_to_name,
              (SELECT jsonb_agg(jsonb_build_object(
                        'key', m.milestone_key, 'due_on', m.due_on, 'status', m.status)
                        ORDER BY m.due_on)
                 FROM renewal_milestones m WHERE m.renewal_record_id = r.id) AS milestones,
              (SELECT count(*)::int FROM renewal_milestones m
                WHERE m.renewal_record_id = r.id AND m.status = 'pending'
                  AND m.due_on <= CURRENT_DATE) AS milestones_due
         FROM renewal_records r
         JOIN customers cu ON cu.id = r.customer_id
         LEFT JOIN applications app ON app.id = r.application_id
         LEFT JOIN users u ON u.id = r.assigned_to
        WHERE ${where.join(' AND ')}
        ORDER BY r.maturity_date
        LIMIT $2`,
      params);

    const counts = await queryOne(
      `SELECT count(*) FILTER (WHERE status IN ('upcoming','engaged','in_progress')
                                 AND maturity_date <= CURRENT_DATE + 90)::int AS within_90,
              count(*) FILTER (WHERE status IN ('upcoming','engaged','in_progress')
                                 AND maturity_date <= CURRENT_DATE + 180)::int AS within_180,
              count(*) FILTER (WHERE status = 'renewed_with_us'
                                 AND resolved_at >= date_trunc('year', CURRENT_DATE))::int
                AS renewed_ytd,
              count(*) FILTER (WHERE status = 'lost_to_other'
                                 AND resolved_at >= date_trunc('year', CURRENT_DATE))::int
                AS lost_ytd,
              COALESCE(sum(balance_estimate) FILTER (
                WHERE status IN ('upcoming','engaged','in_progress')
                  AND maturity_date <= CURRENT_DATE + 180), 0) AS volume_180
         FROM renewal_records WHERE organization_id = $1`,
      [user.organization_id]);

    res.json({ renewals: rows, counts });
  }),
);

/**
 * Move a renewal along, or resolve it.
 *
 * Resolving it stops the milestones. A renewal marked "renewed with us" whose
 * T-45 message still goes out is the exact failure the whole milestone table
 * exists to prevent.
 */
fundingRoutes.post(
  '/renewals/:id',
  requirePermission('customer.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      status: z.enum(['upcoming', 'engaged', 'in_progress', 'renewed_with_us',
                      'lost_to_other', 'paid_out', 'declined', 'cancelled']).optional(),
      assigned_to: z.string().uuid().nullable().optional(),
      outcome_note: z.string().trim().optional(),
      balance_estimate: z.union([z.string(), z.number()]).nullable().optional(),
      maturity_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      renewal_application_id: z.string().uuid().nullable().optional(),
    }).parse(req.body);

    const renewal = await queryOne<{
      id: string; status: string; customer_id: string; maturity_date: string;
    }>(
      `SELECT id, status, customer_id, maturity_date FROM renewal_records
        WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!renewal) throw notFound('That renewal');

    const RESOLVED = ['renewed_with_us', 'lost_to_other', 'paid_out', 'declined', 'cancelled'];
    const resolving = body.status ? RESOLVED.includes(body.status) : false;

    if (resolving && !body.outcome_note && body.status === 'lost_to_other') {
      throw new AppError(
        'Record where it went. A renewal lost with no reason teaches the brokerage nothing.',
        400);
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE renewal_records
            SET status = COALESCE($2, status),
                assigned_to = COALESCE($3::uuid, assigned_to),
                outcome_note = COALESCE($4, outcome_note),
                balance_estimate = COALESCE($5, balance_estimate),
                maturity_date = COALESCE($6::date, maturity_date),
                renewal_application_id = COALESCE($7::uuid, renewal_application_id),
                resolved_at = CASE WHEN $8 THEN now() ELSE resolved_at END
          WHERE id = $1`,
        [renewal.id, body.status ?? null, body.assigned_to ?? null, body.outcome_note ?? null,
         fromCents(toCents(body.balance_estimate)), body.maturity_date ?? null,
         body.renewal_application_id ?? null, resolving]);

      if (resolving) {
        await client.query(
          `UPDATE renewal_milestones
              SET status = 'cancelled',
                  skip_reason = $2
            WHERE renewal_record_id = $1 AND status = 'pending'`,
          [renewal.id, `The renewal was resolved as ${body.status!.replace(/_/g, ' ')}.`]);
      }

      // A maturity date that moved moves the milestones with it. Recomputed
      // rather than left behind, because a T-45 message keyed to last year's
      // date is worse than none.
      if (body.maturity_date && body.maturity_date !== renewal.maturity_date && !resolving) {
        const today = todayIn(user.timezone ?? env.BROKERAGE_TIMEZONE);
        for (const milestone of milestonesFor(body.maturity_date, today)) {
          await client.query(
            `UPDATE renewal_milestones
                SET due_on = $3::date,
                    status = CASE WHEN status = 'pending' AND $4 THEN 'skipped' ELSE status END,
                    skip_reason = CASE WHEN status = 'pending' AND $4
                                       THEN 'The maturity date moved inside this window.'
                                       ELSE skip_reason END
              WHERE renewal_record_id = $1 AND milestone_key = $2 AND status = 'pending'`,
            [renewal.id, milestone.key, milestone.due_on, milestone.past]);
        }
      }
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'renewal.update',
      entityType: 'renewal',
      entityId: renewal.id,
      summary: body.status
        ? `Renewal ${body.status.replace(/_/g, ' ')}`
          + (body.outcome_note ? ` — ${body.outcome_note}` : '')
        : 'Renewal updated',
      before: { status: renewal.status },
      after: { status: body.status ?? renewal.status },
    });

    res.json({ ok: true, milestones_stopped: resolving });
  }),
);
