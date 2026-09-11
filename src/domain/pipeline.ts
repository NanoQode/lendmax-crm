/**
 * The pipeline state machine.
 *
 * A stage change is not a column update. It has to:
 *   1. be allowed (the stage exists, is active, and its entry rules are met)
 *   2. record when it happened and how long the file sat where it was
 *   3. write an audit event
 *   4. stop automations that were about the old stage
 *   5. start whatever the new stage begins
 *   6. create the tasks the new stage requires
 *
 * This module owns (1) and computes what (2)–(6) need. It is deliberately
 * pure — it takes a file and a target and returns a decision plus the side
 * effects to apply — so that the rules can be tested without a database and so
 * that every caller (the board, the list, the API, the automation engine)
 * cannot each invent its own slightly different version.
 *
 * REFUSALS NAME THE FIX. "Cannot move to Funded" is useless. "Cannot move to
 * Funded: no funded amount and no lender recorded" is a to-do list.
 */
import { type IsoDate, daysBetween } from './dates.ts';

export type StageCategory = 'open' | 'parked' | 'won' | 'lost';

export type StageDefinition = {
  key: string;
  label: string;
  position: number;
  category: StageCategory;
  probability?: number | null;
  active: boolean;
  entry_rules?: EntryRules;
};

/**
 * Entry rules, expressed as data rather than code, so a brokerage can tighten
 * or loosen them without a deploy — and so the reason a move was refused can
 * be rendered from the same structure that refused it.
 */
export type EntryRules = {
  /** Columns on the application that must be present and non-empty. */
  requireFields?: Array<{ field: string; label: string }>;
  /** Require at least this application completeness. */
  minPercentComplete?: number;
  /** Require a disposition to have been chosen (the Lost stages). */
  requireLostDisposition?: boolean;
  /** Require the file to have been pushed to Scarlett. */
  requireScarlettDeal?: boolean;
  /** Require a funding record marked confirmed. */
  requireFundingConfirmed?: boolean;
  /** Require every required compliance item to be complete. */
  requireComplianceComplete?: boolean;
  /** Require at least one future or completed appointment. */
  requireAppointment?: boolean;
};

/** The shape the state machine needs to decide. Not the whole application row. */
export type FileSnapshot = {
  stage_key: string | null;
  stage_changed_at: Date | string | null;
  percent_complete: number;
  amount_requested: number | null;
  closing_date: IsoDate | null;
  property_province: string | null;
  transaction_type_key: string | null;
  scarlett_deal_id: string | null;
  lost_disposition_key: string | null;
  funding_confirmed: boolean;
  funded_amount: number | null;
  lender_name: string | null;
  compliance_outstanding_required: number;
  appointment_count: number;
};

export type Blocker = { field: string; label: string; message: string };

export type TransitionDecision =
  | { allowed: true; from: string | null; to: string; secondsInFromStage: number | null; warnings: Blocker[] }
  | { allowed: false; from: string | null; to: string; blockers: Blocker[]; message: string };

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function readField(file: FileSnapshot, field: string): unknown {
  return (file as unknown as Record<string, unknown>)[field];
}

/**
 * Can this file move to this stage, and if not, exactly what is missing?
 *
 * `force` is offered because a rule that cannot be overridden by a human with
 * the authority to do so is a rule people route around by writing a note and
 * lying to the board. An override is allowed, recorded and reported — it is
 * never silent.
 */
export function evaluateTransition(
  file: FileSnapshot,
  toStage: StageDefinition,
  options: { force?: boolean; now?: Date } = {},
): TransitionDecision {
  const now = options.now ?? new Date();
  const from = file.stage_key;

  const changedAt = file.stage_changed_at
    ? file.stage_changed_at instanceof Date
      ? file.stage_changed_at
      : new Date(file.stage_changed_at)
    : null;
  const secondsInFromStage =
    changedAt && !Number.isNaN(changedAt.getTime())
      ? Math.max(0, Math.round((now.getTime() - changedAt.getTime()) / 1000))
      : null;

  const blockers: Blocker[] = [];

  if (!toStage.active) {
    blockers.push({
      field: 'stage',
      label: 'Stage',
      message: `"${toStage.label}" is no longer an active stage.`,
    });
  }

  const rules = toStage.entry_rules ?? {};

  for (const req of rules.requireFields ?? []) {
    if (isBlank(readField(file, req.field))) {
      blockers.push({
        field: req.field,
        label: req.label,
        message: `${req.label} is not recorded.`,
      });
    }
  }

  if (rules.minPercentComplete !== undefined && file.percent_complete < rules.minPercentComplete) {
    blockers.push({
      field: 'percent_complete',
      label: 'Application completeness',
      message: `The application is ${file.percent_complete}% complete; ${toStage.label} needs at least ${rules.minPercentComplete}%.`,
    });
  }

  if (rules.requireAppointment && file.appointment_count < 1) {
    blockers.push({
      field: 'appointment',
      label: 'Appointment',
      message: 'No appointment has been booked on this file.',
    });
  }

  if (rules.requireScarlettDeal && isBlank(file.scarlett_deal_id)) {
    blockers.push({
      field: 'scarlett_deal_id',
      label: 'Scarlett',
      message: 'This file has not been pushed to Scarlett.',
    });
  }

  if (rules.requireLostDisposition && isBlank(file.lost_disposition_key)) {
    blockers.push({
      field: 'lost_disposition_key',
      label: 'Lost reason',
      message: 'A lost file needs a disposition before it can be closed.',
    });
  }

  if (rules.requireFundingConfirmed) {
    if (!file.funding_confirmed) {
      blockers.push({
        field: 'funding_confirmed',
        label: 'Funding',
        message: 'Funding has not been confirmed.',
      });
    }
    if (file.funded_amount === null || file.funded_amount === undefined) {
      blockers.push({
        field: 'funded_amount',
        label: 'Funded amount',
        message: 'The amount that actually advanced is not recorded.',
      });
    }
    if (isBlank(file.lender_name)) {
      blockers.push({ field: 'lender_name', label: 'Lender', message: 'No lender is recorded.' });
    }
  }

  if (rules.requireComplianceComplete && file.compliance_outstanding_required > 0) {
    blockers.push({
      field: 'compliance',
      label: 'Compliance',
      message: `${file.compliance_outstanding_required} required compliance item${
        file.compliance_outstanding_required === 1 ? ' is' : 's are'
      } still outstanding.`,
    });
  }

  if (blockers.length && !options.force) {
    return {
      allowed: false,
      from,
      to: toStage.key,
      blockers,
      message:
        `Cannot move to ${toStage.label}: ` +
        blockers.map((b) => b.message.replace(/\.$/, '')).join('; ') + '.',
    };
  }

  return {
    allowed: true,
    from,
    to: toStage.key,
    secondsInFromStage,
    // A forced move still reports what it overrode, so the audit entry and the
    // screen both say what was skipped.
    warnings: options.force ? blockers : [],
  };
}

/**
 * What a stage change should cause, beyond the column itself.
 *
 * Returned as a description rather than performed here: the caller applies it
 * inside the same transaction as the stage write, so the file never ends up
 * moved with its automations left running.
 */
export type TransitionEffects = {
  stopAutomationReasons: string[];
  clearFields: string[];
  setFields: Record<string, unknown>;
  events: string[];
};

export function transitionEffects(
  from: StageDefinition | null,
  to: StageDefinition,
  at: Date = new Date(),
): TransitionEffects {
  const effects: TransitionEffects = {
    stopAutomationReasons: [],
    clearFields: [],
    setFields: { stage_key: to.key, stage_changed_at: at },
    events: [`stage.changed`, `stage.entered.${to.key}`],
  };

  // Leaving a lost stage un-loses the file. Leaving the disposition behind is
  // how a reactivated client keeps showing up in the lost-reasons report.
  if (from?.category === 'lost' && to.category !== 'lost') {
    effects.clearFields.push('lost_disposition_key', 'lost_reason_note', 'lost_at', 'lost_to_competitor');
    effects.stopAutomationReasons.push('File reactivated out of a lost stage');
  }

  if (to.category === 'lost') {
    effects.setFields.lost_at = at;
    // Nurture and reminder sequences must not survive a client saying no.
    effects.stopAutomationReasons.push('File marked lost');
    effects.events.push('file.lost');
  }

  if (to.category === 'won') {
    // The single most common automation failure: continuing to chase a lead
    // that has already funded.
    effects.stopAutomationReasons.push('File funded');
    effects.events.push('file.funded');
  }

  if (from?.category === 'open' && to.category === 'parked') {
    effects.stopAutomationReasons.push('File moved to nurture');
  }

  return effects;
}

/** Pipeline counts and weighted value, for the board header and the forecast. */
export function summarisePipeline(
  files: Array<{ stage_key: string | null; amount_requested: number | null }>,
  stages: StageDefinition[],
): Array<{ stage: StageDefinition; count: number; value: number; weighted: number }> {
  const byKey = new Map(stages.map((s) => [s.key, s]));
  const acc = new Map<string, { count: number; value: number }>();
  for (const f of files) {
    if (!f.stage_key || !byKey.has(f.stage_key)) continue;
    const entry = acc.get(f.stage_key) ?? { count: 0, value: 0 };
    entry.count++;
    entry.value += Number(f.amount_requested ?? 0);
    acc.set(f.stage_key, entry);
  }
  return stages
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((stage) => {
      const entry = acc.get(stage.key) ?? { count: 0, value: 0 };
      // A null probability means "leave out of the forecast", which is not the
      // same as a probability of zero — and silently treating it as zero is
      // how a forecast quietly under-counts.
      const weighted =
        stage.probability === null || stage.probability === undefined
          ? 0
          : (entry.value * Number(stage.probability)) / 100;
      return { stage, count: entry.count, value: entry.value, weighted };
    });
}

/** Files that have sat too long on a stage. Thresholds are configured per stage. */
export function stalledFiles<T extends { stage_key: string | null; stage_changed_at: Date | string | null }>(
  files: T[],
  thresholdDaysByStage: Record<string, number>,
  today: IsoDate,
): Array<{ file: T; days: number; threshold: number }> {
  const out: Array<{ file: T; days: number; threshold: number }> = [];
  for (const file of files) {
    if (!file.stage_key) continue;
    const threshold = thresholdDaysByStage[file.stage_key];
    if (threshold === undefined) continue;
    if (!file.stage_changed_at) continue;
    const since = file.stage_changed_at instanceof Date
      ? file.stage_changed_at
      : new Date(file.stage_changed_at);
    if (Number.isNaN(since.getTime())) continue;
    const days = daysBetween(since.toISOString().slice(0, 10), today);
    if (days >= threshold) out.push({ file, days, threshold });
  }
  return out.sort((a, b) => b.days - a.days);
}
