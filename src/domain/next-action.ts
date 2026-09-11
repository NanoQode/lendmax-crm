/**
 * "What should I work on next?"
 *
 * Deterministic rules, evaluated in order, each producing a suggestion that
 * carries its own reason. Not a model, and deliberately not a score with no
 * explanation attached: a broker who cannot see why a file is at the top of
 * their list stops believing the list.
 *
 * An LLM may later rewrite the wording of a reason. It must not decide the
 * order. Prioritisation that cannot be explained or reproduced is
 * prioritisation nobody can be held to.
 */
import { type IsoDate, daysBetween, businessDaysBetween, type BusinessCalendar } from './dates.ts';

export type Priority = 'critical' | 'high' | 'medium' | 'low';

export type Suggestion = {
  rule: string;
  priority: Priority;
  /** The imperative: what to do. */
  action: string;
  /** The evidence: why this, now. Always shown beside the action. */
  reason: string;
  applicationId?: string;
  customerId?: string;
  link?: string;
  /** For ordering within a priority band. Higher is more urgent. */
  weight: number;
};

/** Everything the rules read. Assembled by one query, not N. */
export type FileFacts = {
  applicationId: string;
  customerId: string;
  clientName: string;
  stageKey: string | null;
  stageCategory: 'open' | 'parked' | 'won' | 'lost';
  closingDate: IsoDate | null;
  maturityDate: IsoDate | null;
  percentComplete: number;

  conditionsOutstanding: number;
  complianceOutstandingRequired: number;
  complianceApproved: boolean;
  documentsOutstanding: number;
  oldestDocumentRequestDays: number | null;
  documentsAwaitingReview: number;

  /** When the client last wrote to us with nothing sent back since. */
  awaitingReplySince: Date | string | null;
  lastContactedAt: Date | string | null;
  createdAt: Date | string;

  hasFutureTask: boolean;
  overdueTaskCount: number;
  nextAppointmentAt: Date | string | null;
  lastAppointmentNoShow: boolean;

  scarlettDealId: string | null;
  scarlettSyncState: 'never' | 'ok' | 'stale' | 'error' | null;
};

export type RuleConfig = {
  closingUrgentDays: number;
  closingComplianceDays: number;
  incompleteApplicationHours: number;
  staleNoContactDays: number;
  documentReminderHours: number;
  replySlaBusinessHours: number;
  renewalMilestoneDays: number[];
};

export const DEFAULT_RULES: RuleConfig = {
  closingUrgentDays: 7,
  closingComplianceDays: 3,
  incompleteApplicationHours: 48,
  staleNoContactDays: 7,
  documentReminderHours: 48,
  replySlaBusinessHours: 4,
  renewalMilestoneDays: [180, 90, 45],
};

const PRIORITY_ORDER: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const hoursSince = (v: Date | string | null | undefined, now: Date): number | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return (now.getTime() - d.getTime()) / 3_600_000;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Every suggestion this file generates, most urgent first.
 *
 * A file can produce several. They are not collapsed to one, because "closes
 * in four days" and "the client replied two hours ago" are two different
 * pieces of work and hiding the second behind the first is how a reply gets
 * missed for a week.
 */
export function suggestionsFor(
  f: FileFacts,
  today: IsoDate,
  now: Date,
  config: RuleConfig = DEFAULT_RULES,
  calendar?: BusinessCalendar,
): Suggestion[] {
  const out: Suggestion[] = [];
  const daysToClose = f.closingDate ? daysBetween(today, f.closingDate) : null;

  // A resolved file generates no work. Without this, every funded and lost
  // file in the brokerage's history competes for the top of somebody's list.
  if (f.stageCategory === 'lost') return out;

  // ── Closing, and what is unresolved against it ──────────────────────────
  if (f.stageCategory !== 'won' && daysToClose !== null && daysToClose >= 0) {
    if (daysToClose <= config.closingUrgentDays && f.conditionsOutstanding > 0) {
      out.push({
        rule: 'closing_conditions_outstanding',
        priority: 'critical',
        action: 'Resolve lender conditions',
        reason: `Closes in ${plural(daysToClose, 'day')}; ${plural(f.conditionsOutstanding, 'lender condition')} outstanding.`,
        applicationId: f.applicationId,
        customerId: f.customerId,
        weight: 1000 - daysToClose * 10 + f.conditionsOutstanding,
      });
    }
    if (daysToClose <= config.closingComplianceDays && !f.complianceApproved) {
      out.push({
        rule: 'closing_without_compliance',
        priority: 'critical',
        action: 'Complete the compliance review',
        reason: `Closes in ${plural(daysToClose, 'day')} and the compliance file is not approved${
          f.complianceOutstandingRequired ? ` (${plural(f.complianceOutstandingRequired, 'item')} outstanding)` : ''
        }.`,
        applicationId: f.applicationId,
        customerId: f.customerId,
        weight: 990 - daysToClose * 10,
      });
    }
    if (daysToClose <= config.closingUrgentDays && f.documentsOutstanding > 0) {
      out.push({
        rule: 'closing_documents_outstanding',
        priority: 'high',
        action: 'Chase outstanding documents',
        reason: `Closes in ${plural(daysToClose, 'day')}; ${plural(f.documentsOutstanding, 'document')} still outstanding.`,
        applicationId: f.applicationId,
        customerId: f.customerId,
        weight: 900 - daysToClose * 10,
      });
    }
  }
  if (f.stageCategory !== 'won' && daysToClose !== null && daysToClose < 0) {
    out.push({
      rule: 'closing_date_passed',
      priority: 'high',
      action: 'Confirm the closing date',
      reason: `The closing date passed ${plural(Math.abs(daysToClose), 'day')} ago and the file has not funded.`,
      applicationId: f.applicationId,
      customerId: f.customerId,
      weight: 880,
    });
  }

  // ── The client is waiting on us ────────────────────────────────────────
  const waitingHours = hoursSince(f.awaitingReplySince, now);
  if (waitingHours !== null) {
    // Measured in business hours, so an SLA is not breached by a weekend. A
    // Saturday message is not an emergency on Sunday morning.
    const businessHours = calendar
      ? Math.min(
          waitingHours,
          Math.max(0, businessDaysBetween(
            new Date(f.awaitingReplySince as string | Date).toISOString().slice(0, 10),
            today,
            calendar,
          )) * (calendar.workdayEndHour - calendar.workdayStartHour) + (waitingHours % 24),
        )
      : waitingHours;
    const breached = businessHours >= config.replySlaBusinessHours;
    out.push({
      rule: 'client_awaiting_reply',
      priority: breached ? 'high' : 'medium',
      action: 'Reply to the client',
      reason: `${f.clientName} replied ${
        waitingHours < 1 ? 'less than an hour' : plural(Math.floor(waitingHours), 'hour')
      } ago and has had no response.`,
      applicationId: f.applicationId,
      customerId: f.customerId,
      weight: 800 + Math.min(100, waitingHours),
    });
  }

  // ── Documents that arrived and nobody looked at ────────────────────────
  if (f.documentsAwaitingReview > 0) {
    out.push({
      rule: 'documents_awaiting_review',
      priority: 'medium',
      action: 'Review new documents',
      reason: `${f.clientName} uploaded ${plural(f.documentsAwaitingReview, 'document')} that nobody has reviewed.`,
      applicationId: f.applicationId,
      customerId: f.customerId,
      weight: 700 + f.documentsAwaitingReview,
    });
  }

  // ── Document requests going stale ──────────────────────────────────────
  if (
    f.documentsOutstanding > 0 &&
    f.oldestDocumentRequestDays !== null &&
    f.oldestDocumentRequestDays * 24 >= config.documentReminderHours
  ) {
    out.push({
      rule: 'documents_outstanding_stale',
      priority: 'medium',
      action: 'Follow up on the document request',
      reason: `${plural(f.documentsOutstanding, 'document')} requested ${plural(f.oldestDocumentRequestDays, 'day')} ago and still outstanding.`,
      applicationId: f.applicationId,
      customerId: f.customerId,
      weight: 650 + f.oldestDocumentRequestDays,
    });
  }

  // ── Appointments ───────────────────────────────────────────────────────
  const untilAppointment = f.nextAppointmentAt ? -(hoursSince(f.nextAppointmentAt, now) ?? 0) : null;
  if (untilAppointment !== null && untilAppointment > 0 && untilAppointment <= 1) {
    out.push({
      rule: 'appointment_imminent',
      priority: 'critical',
      action: 'Appointment starting shortly',
      reason: `Meeting with ${f.clientName} begins in ${Math.max(1, Math.round(untilAppointment * 60))} minutes.`,
      applicationId: f.applicationId,
      customerId: f.customerId,
      weight: 1100,
    });
  }
  if (f.lastAppointmentNoShow && !f.hasFutureTask) {
    out.push({
      rule: 'no_show_rebook',
      priority: 'high',
      action: 'Rebook after a no-show',
      reason: `${f.clientName} did not attend their appointment and nothing is scheduled.`,
      applicationId: f.applicationId,
      customerId: f.customerId,
      weight: 760,
    });
  }

  // ── Incomplete applications ────────────────────────────────────────────
  const ageHours = hoursSince(f.createdAt, now) ?? 0;
  if (
    f.stageCategory === 'open' &&
    f.percentComplete < 100 &&
    ageHours >= config.incompleteApplicationHours &&
    !f.hasFutureTask
  ) {
    out.push({
      rule: 'application_incomplete_stale',
      priority: 'medium',
      action: 'Follow up on the incomplete application',
      reason: `${f.percentComplete}% complete, started ${plural(Math.floor(ageHours / 24), 'day')} ago, with nothing scheduled.`,
      applicationId: f.applicationId,
      customerId: f.customerId,
      weight: 600 + Math.min(100, ageHours / 24),
    });
  }

  // ── Files with nobody looking after them ───────────────────────────────
  const sinceContactHours = hoursSince(f.lastContactedAt, now);
  if (
    f.stageCategory === 'open' &&
    !f.hasFutureTask &&
    sinceContactHours !== null &&
    sinceContactHours / 24 >= config.staleNoContactDays
  ) {
    out.push({
      rule: 'no_contact_no_task',
      priority: 'low',
      action: 'Make contact or schedule a next step',
      reason: `No contact for ${plural(Math.floor(sinceContactHours / 24), 'day')} and no task scheduled.`,
      applicationId: f.applicationId,
      customerId: f.customerId,
      weight: 400 + Math.min(100, sinceContactHours / 24),
    });
  }

  // ── Overdue tasks ──────────────────────────────────────────────────────
  if (f.overdueTaskCount > 0) {
    out.push({
      rule: 'tasks_overdue',
      priority: 'high',
      action: 'Clear overdue tasks',
      reason: `${plural(f.overdueTaskCount, 'task')} past due on this file.`,
      applicationId: f.applicationId,
      customerId: f.customerId,
      weight: 750 + f.overdueTaskCount,
    });
  }

  // ── Scarlett ───────────────────────────────────────────────────────────
  if (f.scarlettSyncState === 'error') {
    out.push({
      rule: 'scarlett_sync_failed',
      priority: 'high',
      action: 'Fix the Scarlett synchronisation',
      reason: 'The last push to Scarlett failed and the deal is out of step.',
      applicationId: f.applicationId,
      customerId: f.customerId,
      weight: 770,
    });
  }

  // ── Renewals ───────────────────────────────────────────────────────────
  if (f.maturityDate) {
    const daysToMaturity = daysBetween(today, f.maturityDate);
    // Fire on the day a milestone is reached, not on every day after it — the
    // "tomorrow" window is what makes this a prompt rather than a permanent
    // fixture on somebody's list.
    const hit = config.renewalMilestoneDays.find((d) => daysToMaturity === d || daysToMaturity === d - 1);
    if (hit !== undefined && daysToMaturity >= 0) {
      out.push({
        rule: 'renewal_milestone',
        priority: daysToMaturity <= 45 ? 'high' : 'medium',
        action: 'Start the renewal conversation',
        reason: `${f.clientName}’s mortgage matures in ${plural(daysToMaturity, 'day')} (T-${hit} milestone).`,
        applicationId: f.applicationId,
        customerId: f.customerId,
        weight: 720 - daysToMaturity / 10,
      });
    }
  }

  return out.sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.weight - a.weight,
  );
}

/** The dashboard's "My priorities" block: the top suggestions across many files. */
export function prioritise(
  files: FileFacts[],
  today: IsoDate,
  now: Date,
  config: RuleConfig = DEFAULT_RULES,
  limit = 12,
  calendar?: BusinessCalendar,
): Suggestion[] {
  return files
    .flatMap((f) => suggestionsFor(f, today, now, config, calendar))
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.weight - a.weight)
    .slice(0, limit);
}
