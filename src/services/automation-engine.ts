/**
 * The automation runtime.
 *
 * Three halves:
 *
 *   `processEvents` — reads unprocessed domain_events, matches them to the
 *   triggers of published automations, and enrols whoever qualifies.
 *
 *   `emitTimeEvents` — the triggers nobody causes: a closing date coming up,
 *   a file gone quiet, a task gone overdue. Looked for on the engine's tick,
 *   per automation, because "how many days" belongs to the automation.
 *
 *   `runStep` — advances one enrollment by one node.
 *
 * THE STOP CHECK RUNS BEFORE EVERY STEP, not only at enrollment. That is the
 * whole safety mechanism. A condition true when somebody was enrolled and
 * false three days later must end the sequence at step three, and the
 * enrollment records which condition ended it — "Stopped: documents received"
 * is the difference between an engine people trust and one they switch off.
 *
 * A step is also the last place a send is checked. `send` runs the consent
 * gate itself, so an automation cannot route around it; the engine's job is
 * to record what the gate decided.
 */
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { pool, query, queryOne, withTransaction } from '../db/pool.ts';
import { log } from '../lib/logger.ts';
import {
  chosenBranch, DefinitionSchema, evaluateConditions, firstStopReason, nextKey, nodeByKey,
  TIME_TRIGGERS, waitUntil, type AutomationDefinition, type AutomationNode, type Facts, type Trigger,
} from '../domain/automation.ts';
import { renderTemplate, type MergeContext } from '../domain/merge-fields.ts';
import { calculatorMergeValues } from './link-tracking.ts';
import { signatureFor } from './signature.ts';
import { send } from './messaging.ts';
import { enqueue } from '../jobs/queue.ts';
import { nextSendableTime, todayIn, type QuietHours, DEFAULT_QUIET_HOURS } from '../domain/dates.ts';
import { env } from '../config/env.ts';
import { gatherFacts } from './automation-facts.ts';
import { emitEvent } from './events.ts';
import { moveFileToStage } from './stage-moves.ts';
import { assignInTransaction, claimNextInRotation, ASSIGNABLE_SQL } from './assignment.ts';
import { createDocumentRequest } from './document-requests.ts';
import { checklistFor } from './required-documents.ts';
import { sendEmail } from '../integrations/email.ts';

export { gatherFacts } from './automation-facts.ts';

async function quietHoursFor(organizationId: string): Promise<{ quiet: QuietHours; timezone: string }> {
  const setting = await queryOne<{ value: Record<string, unknown> }>(
    `SELECT value FROM settings WHERE organization_id = $1 AND key = 'quiet_hours'
        AND effective_from <= CURRENT_DATE ORDER BY effective_from DESC LIMIT 1`,
    [organizationId],
  );
  const org = await queryOne<{ timezone: string }>(
    'SELECT timezone FROM organizations WHERE id = $1', [organizationId],
  );
  return {
    quiet: { ...DEFAULT_QUIET_HOURS, ...(setting?.value ?? {}) } as QuietHours,
    timezone: org?.timezone ?? env.BROKERAGE_TIMEZONE,
  };
}

// ── Enrolment ──────────────────────────────────────────────────────────────

export type PublishedAutomation = {
  id: string;
  key: string;
  name: string;
  purpose: 'transactional' | 'marketing' | 'service';
  allow_reenrollment: boolean;
  reenrollment_cooldown_days: number | null;
  version: number;
  published_at?: Date | null;
  definition: AutomationDefinition;
};

async function publishedAutomations(organizationId: string): Promise<PublishedAutomation[]> {
  const { rows } = await query<Omit<PublishedAutomation, 'definition'> & { definition: unknown }>(
    `SELECT a.id, a.key, a.name, a.purpose, a.allow_reenrollment, a.reenrollment_cooldown_days,
            v.version, v.published_at, v.definition
       FROM automations a
       JOIN automation_versions v
         ON v.automation_id = a.id AND v.version = a.published_version
      WHERE a.organization_id = $1 AND a.status = 'active'`,
    [organizationId],
  );
  const out: PublishedAutomation[] = [];
  for (const row of rows) {
    const parsed = DefinitionSchema.safeParse(row.definition);
    if (!parsed.success) {
      // A published version that no longer parses is a deploy problem, and
      // running half of it would be worse than running none of it.
      log.error('a published automation could not be parsed', {
        automation: row.key, version: row.version,
      });
      continue;
    }
    out.push({ ...row, definition: parsed.data });
  }
  return out;
}

/** The event's own details, as facts a trigger filter can test (`event.to`, `event.tag`). */
function eventFacts(payload: Record<string, unknown>): Facts {
  const out: Facts = {};
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (v === null || typeof v !== 'object') out[`event.${k}`] = v;
  }
  return out;
}

/** Which of an automation's triggers this event satisfies, if any. */
export function matchingTrigger(
  automation: Pick<PublishedAutomation, 'id' | 'definition'>,
  event: { event_type: string; payload: Record<string, unknown> },
  facts: Facts,
): Trigger | null {
  // An event raised for one automation (a time trigger, an inbound webhook)
  // belongs to that automation alone.
  const target = event.payload?.automation_id;
  if (target && target !== automation.id) return null;
  // A workflow is never started by its own step (tagging somebody with the tag
  // it listens for would enrol them in a loop).
  if (event.payload?.by_automation === automation.id) return null;
  const index = typeof event.payload?.trigger_index === 'number' ? event.payload.trigger_index : null;
  return automation.definition.triggers.find((t, i) =>
    t.type === event.event_type
    && (index === null || index === i)
    && evaluateConditions(t.filters, facts)) ?? null;
}

/**
 * Turn events into enrollments.
 *
 * Events are consumed in order and marked processed whatever happens, because
 * an event that cannot be matched is not an event to retry forever — the error
 * is recorded on the row instead.
 */
export async function processEvents(organizationId: string, limit = 100): Promise<{
  processed: number; enrolled: number;
}> {
  const { rows: events } = await query<{
    id: string; event_type: string; customer_id: string | null;
    application_id: string | null; payload: Record<string, unknown>;
  }>(
    `SELECT id, event_type, customer_id, application_id, payload
       FROM domain_events
      WHERE organization_id = $1 AND processed_at IS NULL
      ORDER BY id LIMIT $2`,
    [organizationId, limit],
  );
  if (!events.length) return { processed: 0, enrolled: 0 };

  const automations = await publishedAutomations(organizationId);
  let enrolled = 0;

  for (const event of events) {
    try {
      if (event.customer_id) {
        const candidates = automations.filter((a) =>
          a.definition.triggers.some((t) => t.type === event.event_type));
        if (candidates.length) {
          const facts = {
            ...(await gatherFacts(pool, event.customer_id, event.application_id)),
            ...eventFacts(event.payload),
          };
          for (const automation of candidates) {
            const trigger = matchingTrigger(automation, event, facts);
            if (!trigger) continue;
            if (!evaluateConditions(automation.definition.entry_conditions, facts)) continue;
            // Somebody already past the point the sequence is about should not
            // be enrolled into it at all.
            if (firstStopReason(automation.definition, facts)) continue;
            const created = await enrol(automation, organizationId, event.customer_id,
                                        event.application_id, `Trigger: ${trigger.label ?? event.event_type}`);
            if (created) enrolled++;
          }
        }
      }
      await query('UPDATE domain_events SET processed_at = now() WHERE id = $1', [event.id]);
    } catch (err) {
      log.error('could not process a domain event', { id: event.id, error: err });
      await query(
        'UPDATE domain_events SET processed_at = now(), process_error = $2 WHERE id = $1',
        [event.id, err instanceof Error ? err.message : String(err)],
      );
    }
  }

  return { processed: events.length, enrolled };
}

// ── Time-based triggers ────────────────────────────────────────────────────

const lastTimeSweep = new Map<string, number>();
const TIME_SWEEP_EVERY_MS = 5 * 60_000;

/**
 * Raise the events nobody causes.
 *
 * Every published automation with a time trigger gets its own events, keyed so
 * each file qualifies once per occurrence: once per closing date, once per
 * quiet spell, once per overdue task.
 *
 * AND ONLY FROM THE MOMENT IT WAS PUBLISHED. Publishing "no activity for 72
 * hours" must not enrol every file that went quiet last year in one tick and
 * send four hundred emails before lunch. A spell of inactivity, an overdue
 * task or an unanswered request counts only if it crossed the line after the
 * version went live. A date trigger is naturally bounded — it matches one day.
 */
export async function emitTimeEvents(organizationId: string, options: { force?: boolean } = {}): Promise<number> {
  const last = lastTimeSweep.get(organizationId) ?? 0;
  if (!options.force && Date.now() - last < TIME_SWEEP_EVERY_MS) return 0;
  lastTimeSweep.set(organizationId, Date.now());

  const automations = (await publishedAutomations(organizationId))
    .filter((a) => a.definition.triggers.some((t) => TIME_TRIGGERS.includes(t.type)));
  if (!automations.length) return 0;

  const { timezone } = await quietHoursFor(organizationId);
  const today = todayIn(timezone);
  let raised = 0;

  for (const automation of automations) {
    const since = automation.published_at ?? new Date();
    for (const [index, trigger] of automation.definition.triggers.entries()) {
      if (!TIME_TRIGGERS.includes(trigger.type)) continue;
      const rows = await timeTriggerRows(organizationId, trigger, today, since);
      for (const row of rows) {
        await emitEvent({
          organizationId, type: trigger.type, customerId: row.customer_id, applicationId: row.application_id,
          payload: { automation_id: automation.id, trigger_index: index, ...row.payload },
          dedupeKey: `${trigger.type}:${automation.id}:${index}:${row.key}`,
        });
        raised++;
      }
    }
  }
  return raised;
}

type TimeRow = { customer_id: string; application_id: string | null; key: string; payload: Record<string, unknown> };

async function timeTriggerRows(organizationId: string, trigger: Trigger, today: string, since: Date): Promise<TimeRow[]> {
  const hours = trigger.after_hours ?? 0;
  const open = `app.archived_at IS NULL AND COALESCE(ps.category, 'open') = 'open'`;
  const from = `FROM applications app
                LEFT JOIN pipeline_stages ps ON ps.organization_id = app.organization_id AND ps.key = app.stage_key`;
  switch (trigger.type) {
    case 'closing.approaching':
    case 'maturity.approaching': {
      const column = trigger.type === 'closing.approaching' ? 'closing_date' : 'maturity_date';
      const { rows } = await query<{ customer_id: string; id: string; on: string }>(
        `SELECT app.customer_id, app.id, app.${column}::text AS on ${from}
          WHERE app.organization_id = $1 AND app.archived_at IS NULL
            AND app.${column} = $2::date + $3::int
          LIMIT 500`,
        [organizationId, today, trigger.offset_days ?? 0]);
      return rows.map((r) => ({ customer_id: r.customer_id, application_id: r.id, key: `${r.id}:${r.on}`,
                                payload: { date: r.on, days_before: trigger.offset_days ?? 0 } }));
    }
    case 'no_activity':
    case 'application.abandoned': {
      const extra = trigger.type === 'application.abandoned'
        ? 'AND app.submitted_at IS NULL AND COALESCE(app.percent_complete, 0) < 100' : '';
      const { rows } = await query<{ customer_id: string; id: string; last: string }>(
        `SELECT app.customer_id, app.id,
                extract(epoch FROM COALESCE(app.last_activity_at, app.created_at))::bigint::text AS last ${from}
          WHERE app.organization_id = $1 AND ${open} ${extra}
            AND COALESCE(app.last_activity_at, app.created_at) < now() - ($2::int * interval '1 hour')
            AND COALESCE(app.last_activity_at, app.created_at) + ($2::int * interval '1 hour') >= $3
          LIMIT 500`,
        [organizationId, hours, since]);
      return rows.map((r) => ({ customer_id: r.customer_id, application_id: r.id, key: `${r.id}:${r.last}`,
                                payload: { quiet_hours: hours } }));
    }
    case 'documents.outstanding': {
      const { rows } = await query<{ customer_id: string; application_id: string; id: string }>(
        `SELECT r.customer_id, r.application_id, r.id FROM document_requests r
          WHERE r.organization_id = $1 AND r.status IN ('open','partial')
            AND r.created_at < now() - ($2::int * interval '1 hour')
            AND r.created_at + ($2::int * interval '1 hour') >= $3
          LIMIT 500`,
        [organizationId, hours, since]);
      return rows.map((r) => ({ customer_id: r.customer_id, application_id: r.application_id, key: r.id,
                                payload: { request_id: r.id } }));
    }
    case 'task.overdue': {
      const { rows } = await query<{ customer_id: string; application_id: string | null; id: string; title: string; due: string }>(
        `SELECT COALESCE(t.customer_id, app.customer_id) AS customer_id, t.application_id, t.id, t.title,
                COALESCE(t.due_at, t.due_on::timestamptz)::text AS due
           FROM tasks t LEFT JOIN applications app ON app.id = t.application_id
          WHERE t.organization_id = $1 AND t.status NOT IN ('completed','cancelled')
            AND COALESCE(t.due_at, (t.due_on + 1)::timestamptz) < now()
            AND COALESCE(t.due_at, (t.due_on + 1)::timestamptz) >= $2
            AND COALESCE(t.customer_id, app.customer_id) IS NOT NULL
          LIMIT 500`,
        [organizationId, since]);
      return rows.map((r) => ({ customer_id: r.customer_id, application_id: r.application_id,
                                key: `${r.id}:${r.due}`, payload: { task_id: r.id, task_title: r.title } }));
    }
    default:
      return [];
  }
}

/**
 * Re-queue enrollments whose time has come and whose job is not there.
 *
 * Steps are scheduled by enqueueing a job with a run-after time, which is
 * right until a job is lost — dead-lettered after its retries, or dropped by
 * a worker that died between claiming and finishing. Without this, that
 * client sits at step four of a renewal sequence forever and nobody finds
 * out, because nothing is failing.
 */
export async function sweepDueEnrollments(
  organizationId: string,
  limit = 200,
): Promise<{ requeued: number }> {
  const { rows } = await query<{ id: string; current_node_key: string | null }>(
    `SELECT e.id, e.current_node_key
       FROM automation_enrollments e
      WHERE e.organization_id = $1 AND e.status = 'active'
        AND e.next_run_at IS NOT NULL AND e.next_run_at <= now()
        -- A claimed enrollment is being worked on right now; only an
        -- abandoned claim counts as missing.
        AND (e.running_since IS NULL OR e.running_since < now() - interval '${CLAIM_TIMEOUT}')
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.kind = 'automation.step'
             AND j.state IN ('pending','running')
             AND j.payload->>'enrollmentId' = e.id::text
        )
      ORDER BY e.next_run_at
      LIMIT $2`,
    [organizationId, limit],
  );
  for (const row of rows) {
    await enqueue('automation.step', { enrollmentId: row.id }, {
      organizationId,
      dedupeKey: `automation.step:${row.id}:sweep:${row.current_node_key ?? 'end'}`,
    });
  }
  if (rows.length) {
    log.warn('re-queued automation steps whose job had gone missing', { count: rows.length });
  }
  return { requeued: rows.length };
}

export async function enrol(
  automation: PublishedAutomation,
  organizationId: string,
  customerId: string,
  applicationId: string | null,
  reason: string,
  enrolledBy?: string | null,
): Promise<string | null> {
  // Re-enrolment is off unless the automation says otherwise. A renewal cycle
  // wants it; an onboarding sequence emphatically does not.
  if (!automation.allow_reenrollment) {
    const previous = await queryOne<{ id: string }>(
      `SELECT id FROM automation_enrollments
        WHERE automation_id = $1 AND customer_id = $2 LIMIT 1`,
      [automation.id, customerId],
    );
    if (previous) return null;
  } else if (automation.reenrollment_cooldown_days) {
    const recent = await queryOne<{ id: string }>(
      `SELECT id FROM automation_enrollments
        WHERE automation_id = $1 AND customer_id = $2
          AND enrolled_at > now() - ($3 || ' days')::interval LIMIT 1`,
      [automation.id, customerId, String(automation.reenrollment_cooldown_days)],
    );
    if (recent) return null;
  }

  // A contact-level event (a tag, a reply) carries no file; the client's most
  // recent open one is what the steps act on.
  let fileId = applicationId;
  if (!fileId) {
    fileId = (await queryOne<{ id: string }>(
      `SELECT id FROM applications WHERE customer_id = $1 AND archived_at IS NULL
        ORDER BY last_activity_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [customerId],
    ))?.id ?? null;
  }

  const facts = await gatherFacts(pool, customerId, fileId);

  const row = await queryOne<{ id: string }>(
    `INSERT INTO automation_enrollments
       (organization_id, automation_id, automation_version, customer_id, application_id,
        current_node_key, next_run_at, context, enrolled_by, enrolled_reason)
     VALUES ($1,$2,$3,$4,$5,$6,now(),$7::jsonb,$8,$9)
     ON CONFLICT (automation_id, customer_id) WHERE status IN ('active','paused') DO NOTHING
     RETURNING id`,
    [
      organizationId, automation.id, automation.version, customerId, fileId,
      automation.definition.start_node, JSON.stringify(facts), enrolledBy ?? null, reason,
    ],
  );
  if (!row) return null;

  await enqueue('automation.step', { enrollmentId: row.id }, {
    organizationId, dedupeKey: `automation.step:${row.id}`,
  });
  log.info('enrolled', { automation: automation.key, customerId, enrollment: row.id });
  return row.id;
}

/** A published automation, by id — for a step that enrols somebody into another one. */
export async function publishedAutomation(organizationId: string, id: string): Promise<PublishedAutomation | null> {
  return (await publishedAutomations(organizationId)).find((a) => a.id === id) ?? null;
}

// ── Running one step ───────────────────────────────────────────────────────

export type StepOutcome = {
  status: 'advanced' | 'waiting' | 'completed' | 'stopped' | 'failed';
  reason?: string;
};

/**
 * How long a claim is honoured before another worker may take the step over.
 *
 * Long enough that no real step is still running, short enough that a worker
 * killed mid-step does not strand the client for an afternoon.
 */
const CLAIM_TIMEOUT = "5 minutes";

export async function runStep(enrollmentId: string): Promise<StepOutcome> {
  // Claim the step before reading anything else. Two jobs can exist for one
  // enrollment — a scheduled step and somebody pressing "run this now" — and
  // without this they both advance it, which duplicates a task or steps over
  // a node entirely. (A duplicate SEND was already impossible: every message
  // carries a dedupe key of enrollment plus node.)
  const enrollment = await queryOne<ClaimedEnrollment>(
    `UPDATE automation_enrollments
        SET running_since = now()
      WHERE id = $1 AND status = 'active'
        AND (running_since IS NULL OR running_since < now() - interval '${CLAIM_TIMEOUT}')
      RETURNING *`,
    [enrollmentId],
  );
  if (!enrollment) {
    // Either it is gone, it is not active, or another worker has it. Say
    // which, because "skipped" in a log with no reason is a mystery.
    const existing = await queryOne<{ status: string; running_since: string | null }>(
      'SELECT status, running_since FROM automation_enrollments WHERE id = $1', [enrollmentId]);
    if (!existing) return { status: 'failed', reason: 'No such enrollment.' };
    if (existing.running_since) {
      return { status: 'waiting', reason: 'Another worker is running this step.' };
    }
    return { status: 'stopped', reason: `Already ${existing.status}.` };
  }

  try {
    return await runClaimedStep(enrollment);
  } finally {
    // Released whatever happened, including a throw: a claim left behind
    // blocks the enrollment until the reclaim window expires, which turns one
    // failed step into five minutes of silence.
    await query(
      'UPDATE automation_enrollments SET running_since = NULL WHERE id = $1',
      [enrollmentId]);
  }
}

type ClaimedEnrollment = {
  id: string; organization_id: string; automation_id: string; automation_version: number;
  customer_id: string; application_id: string | null; status: string;
  current_node_key: string | null; steps_completed: number; messages_sent: number;
};

/** A goto chain longer than this in one step is a loop, whatever the validator thought. */
const MAX_HOPS = 25;

async function runClaimedStep(enrollment: ClaimedEnrollment): Promise<StepOutcome> {
  const enrollmentId = enrollment.id;

  const versionRow = await queryOne<{ definition: unknown; purpose: string; name: string; key: string }>(
    `SELECT v.definition, a.purpose, a.name, a.key
       FROM automation_versions v JOIN automations a ON a.id = v.automation_id
      WHERE v.automation_id = $1 AND v.version = $2`,
    [enrollment.automation_id, enrollment.automation_version],
  );
  if (!versionRow) return { status: 'failed', reason: 'The automation version is missing.' };

  const parsed = DefinitionSchema.safeParse(versionRow.definition);
  if (!parsed.success) return { status: 'failed', reason: 'The automation definition is not valid.' };
  const definition = parsed.data;

  const facts = await gatherFacts(pool, enrollment.customer_id, enrollment.application_id);

  // Before every step, not only at enrollment. This is the safety mechanism.
  const stopReason = firstStopReason(definition, facts);
  if (stopReason) {
    await stop(enrollmentId, stopReason);
    return { status: 'stopped', reason: stopReason };
  }

  const node = nodeByKey(definition, enrollment.current_node_key);
  if (!node) {
    await complete(enrollmentId);
    return { status: 'completed' };
  }

  try {
    const result = await executeNode(node, {
      enrollmentId,
      organizationId: enrollment.organization_id,
      automationId: enrollment.automation_id,
      customerId: enrollment.customer_id,
      applicationId: enrollment.application_id,
      automationName: versionRow.name,
      automationPurpose: versionRow.purpose as 'transactional' | 'marketing' | 'service',
      facts,
      definition,
    });

    if (result.kind === 'wait') {
      await query(
        `UPDATE automation_enrollments
            SET current_node_key = $2, next_run_at = $3, steps_completed = steps_completed + 1
          WHERE id = $1`,
        [enrollmentId, result.nextKey, result.runAt],
      );
      await enqueue('automation.step', { enrollmentId }, {
        organizationId: enrollment.organization_id,
        runAfter: result.runAt,
        dedupeKey: `automation.step:${enrollmentId}:${result.nextKey}:${result.runAt.getTime()}`,
      });
      return { status: 'waiting' };
    }

    if (result.kind === 'ended') {
      return { status: 'stopped', reason: result.reason };
    }

    const next = result.nextKey;
    if (!next) {
      // The last step ran too: it counts, and so does what it sent.
      await complete(enrollmentId, { stepRan: true, sent: result.sent ?? false });
      return { status: 'completed' };
    }

    await query(
      `UPDATE automation_enrollments
          SET current_node_key = $2, steps_completed = steps_completed + 1,
              messages_sent = messages_sent + $3, next_run_at = now()
        WHERE id = $1`,
      [enrollmentId, next, result.sent ? 1 : 0],
    );
    // Straight on to the next node. The validator refuses a loop with no wait
    // in it, so this cannot spin. The step count in the key keeps a loop that
    // does have a wait in it from colliding with its own earlier job.
    await enqueue('automation.step', { enrollmentId }, {
      organizationId: enrollment.organization_id,
      dedupeKey: `automation.step:${enrollmentId}:${next}:${enrollment.steps_completed + 1}`,
    });
    return { status: 'advanced' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE automation_enrollments SET last_error = $2 WHERE id = $1`,
      [enrollmentId, message],
    );
    await recordExecution(enrollmentId, node, 'failed', message);
    throw err;
  }
}

type ExecuteContext = {
  enrollmentId: string;
  organizationId: string;
  automationId: string;
  customerId: string;
  applicationId: string | null;
  automationName: string;
  automationPurpose: 'transactional' | 'marketing' | 'service';
  facts: Facts;
  definition: AutomationDefinition;
};

type ExecuteResult =
  | { kind: 'wait'; nextKey: string | null; runAt: Date }
  | { kind: 'done'; nextKey: string | null; sent?: boolean }
  | { kind: 'ended'; reason: string };

/** The system actor an automation acts as, where a service expects one. */
const systemActor = (ctx: ExecuteContext) => ({
  organizationId: ctx.organizationId,
  kind: 'integration' as const,
  userId: null,
  name: `Automation: ${ctx.automationName}`,
  role: 'automation',
});

async function executeNode(node: AutomationNode, ctx: ExecuteContext): Promise<ExecuteResult> {
  const done = (sent?: boolean): ExecuteResult => ({ kind: 'done', nextKey: nextKey(node, ctx.facts), sent });

  switch (node.type) {
    case 'wait': {
      const { quiet, timezone } = await quietHoursFor(ctx.organizationId);
      let runAt = waitUntil(node, ctx.facts);
      if (node.business_hours_only) runAt = nextSendableTime(runAt, timezone, quiet);
      await recordExecution(
        ctx.enrollmentId, node, 'waiting',
        `Until ${runAt.toLocaleString('en-CA', {
          timeZone: timezone, day: 'numeric', month: 'long',
          hour: 'numeric', minute: '2-digit',
        })}`,
      );
      return { kind: 'wait', nextKey: node.next ?? null, runAt };
    }

    case 'send_email':
    case 'send_sms': {
      const channel = node.type === 'send_email' ? 'email' : 'sms';
      const rendered = await renderForNode(node, ctx);
      const outcome = await send({
        organizationId: ctx.organizationId,
        customerId: ctx.customerId,
        applicationId: ctx.applicationId,
        channel,
        // The automation's own purpose wins over the node's if it is stricter:
        // a marketing automation cannot send a step labelled transactional.
        purpose: ctx.automationPurpose === 'marketing' ? 'marketing' : node.purpose,
        subject: rendered.subject,
        bodyText: rendered.text,
        bodyHtml: rendered.html,
        origin: 'automation',
        templateKey: node.template_key ?? null,
        automationRunId: ctx.enrollmentId,
        mergeSnapshot: rendered.used,
        // One send per node per enrollment, whatever the queue does.
        dedupeKey: `automation:${ctx.enrollmentId}:${node.key}`,
      });

      await recordExecution(
        ctx.enrollmentId, node,
        outcome.status === 'suppressed' ? 'suppressed' : 'executed',
        outcome.decision.reason, outcome.messageId,
      );
      // A suppressed send is not a failure — the gate did its job — and the
      // sequence continues, because the next step may be a task rather than
      // another message.
      return done(outcome.ok);
    }

    case 'internal_email': {
      const to = node.to === 'address' ? { email: node.address ?? null, name: node.address ?? '' }
        : node.to === 'user' ? await userContact(ctx.organizationId, node.user_id)
        : await roleContact(ctx, node.role);
      if (!to?.email) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', 'Nobody to email.');
        return done();
      }
      const result = await sendEmail(ctx.organizationId, {
        to: to.email,
        subject: interpolate(node.subject, ctx.facts),
        text: `${interpolate(node.body, ctx.facts)}\n\n— ${ctx.automationName}` +
          (ctx.applicationId ? `\n${env.PUBLIC_URL.replace(/\/+$/, '')}/applications/${ctx.applicationId}` : ''),
        idempotencyKey: `automation:${ctx.enrollmentId}:${node.key}`,
      });
      await recordExecution(ctx.enrollmentId, node, result.ok ? 'executed' : 'failed',
        result.ok ? `Emailed ${to.name || to.email}` : result.error);
      return done();
    }

    case 'branch': {
      const target = nextKey(node, ctx.facts);
      await recordExecution(ctx.enrollmentId, node, 'branched', `Went to "${target ?? 'the end'}"`);
      return { kind: 'done', nextKey: target };
    }

    case 'if_else': {
      const branch = chosenBranch(node, ctx.facts);
      await recordExecution(ctx.enrollmentId, node, 'branched',
        branch ? `Matched "${branch.name}"` : 'No branch matched — took the None path');
      return { kind: 'done', nextKey: branch ? branch.next : node.else_next };
    }

    case 'goto': {
      await recordExecution(ctx.enrollmentId, node, 'executed', `Went to "${labelOf(ctx.definition, node.target)}"`);
      return { kind: 'done', nextKey: node.target };
    }

    case 'create_task': {
      const recipient = await resolveRecipient(ctx, node.assign_to);
      const taskId = await withTransaction(async (client) => {
        const due = node.due_in_days !== undefined
          ? new Date(Date.now() + node.due_in_days * 86_400_000).toISOString().slice(0, 10)
          : null;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO tasks (organization_id, application_id, customer_id, title, description,
                              category, priority, due_on, source_kind, source_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,'automation',$9) RETURNING id`,
          [
            ctx.organizationId, ctx.applicationId, ctx.customerId,
            interpolate(node.title, ctx.facts), node.description ? interpolate(node.description, ctx.facts) : null,
            node.category, node.priority, due, `${ctx.enrollmentId}:${node.key}`,
          ],
        );
        const id = rows[0]!.id;
        if (recipient) {
          await client.query(
            `INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2)
             ON CONFLICT DO NOTHING`,
            [id, recipient.userId],
          );
        }
        return id;
      });
      await recordExecution(
        ctx.enrollmentId, node,
        // An unowned task is not a created task in any sense that matters, so
        // it is recorded as a partial outcome rather than a clean one.
        recipient ? 'executed' : 'skipped',
        recipient ? `Task for ${recipient.name}${recipient.note}` : NOBODY_TO_ASSIGN,
        undefined, taskId,
      );
      return done();
    }

    case 'notify_user': {
      const recipient = node.user_id
        ? await userContact(ctx.organizationId, node.user_id).then((u) => u && { userId: node.user_id!, name: u.name, note: '' })
        : await resolveRecipient(ctx, node.role);
      if (!recipient) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', NOBODY_TO_ASSIGN);
        return done();
      }
      await query(
        `INSERT INTO notifications (organization_id, user_id, kind, title, body, entity_type,
                                    entity_id, dedupe_key)
         VALUES ($1,$2,'workflow',$3,$4,'application',$5::text,$6)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          ctx.organizationId, recipient.userId, interpolate(node.title, ctx.facts),
          node.body ? interpolate(node.body, ctx.facts) : null,
          ctx.applicationId, `automation:${ctx.enrollmentId}:${node.key}`,
        ],
      );
      await recordExecution(
        ctx.enrollmentId, node, 'executed', `Notified ${recipient.name}${recipient.note}`,
      );
      return done();
    }

    case 'add_note': {
      await query(
        `INSERT INTO notes (organization_id, application_id, customer_id, body, note_type,
                            author_name)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ctx.organizationId, ctx.applicationId, ctx.customerId,
         interpolate(node.body, ctx.facts), node.note_type, ctx.automationName],
      );
      await recordExecution(ctx.enrollmentId, node, 'executed', 'Note added');
      return done();
    }

    case 'add_tag':
    case 'remove_tag': {
      const tag = interpolate(node.tag, ctx.facts).trim();
      const adding = node.type === 'add_tag';
      const changed = await query(
        adding
          ? `UPDATE customers SET tags = array_append(tags, $2) WHERE id = $1 AND NOT ($2 = ANY(tags))`
          : `UPDATE customers SET tags = array_remove(tags, $2) WHERE id = $1 AND $2 = ANY(tags)`,
        [ctx.customerId, tag],
      );
      if (changed.rowCount) {
        // Another workflow may be waiting on this tag. A workflow does not
        // trigger itself: its own tag event is raised for the others only.
        await emitEvent({
          organizationId: ctx.organizationId, type: adding ? 'tag.added' : 'tag.removed',
          customerId: ctx.customerId, applicationId: ctx.applicationId,
          payload: { tag, by_automation: ctx.automationId },
          dedupeKey: `${adding ? 'tag.added' : 'tag.removed'}:${ctx.enrollmentId}:${node.key}`,
        });
      }
      await recordExecution(ctx.enrollmentId, node, changed.rowCount ? 'executed' : 'skipped',
        changed.rowCount ? `${adding ? 'Tagged' : 'Untagged'} "${tag}"`
          : adding ? `Already tagged "${tag}"` : `Was not tagged "${tag}"`);
      return done();
    }

    case 'update_contact': {
      const value = interpolate(node.value, ctx.facts).trim() || null;
      await query(`UPDATE customers SET ${node.field} = $2 WHERE id = $1`, [ctx.customerId, value]);
      await recordExecution(ctx.enrollmentId, node, 'executed',
        `Set ${node.field.replace(/_/g, ' ')} to ${value ?? '(empty)'}`);
      return done();
    }

    case 'set_stage': {
      if (!ctx.applicationId) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', 'No application on this enrollment');
        return done();
      }
      // Through the stage machine, like a person's move: its entry rules apply
      // and it records the transition, the timeline entry and the stage events.
      // An automation may not force past a rule, and may not mark a file won —
      // funding is recorded by a person with the funding in front of them.
      const stage = await queryOne<{ label: string; category: string }>(
        `SELECT label, category FROM pipeline_stages WHERE organization_id = $1 AND key = $2`,
        [ctx.organizationId, node.stage_key]);
      if (!stage) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', `No stage "${node.stage_key}"`);
        return done();
      }
      if (stage.category === 'won') {
        await recordExecution(ctx.enrollmentId, node, 'skipped', 'An automation may not mark a file funded');
        return done();
      }
      if (ctx.facts.stage_key === node.stage_key) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', `Already in ${stage.label}`);
        return done();
      }
      try {
        const moved = await moveFileToStage(systemActor(ctx), ctx.applicationId,
          { stage_key: node.stage_key, reason: `Automation: ${ctx.automationName}` }, { mayForce: false });
        if (!moved.ok) {
          await recordExecution(ctx.enrollmentId, node, 'skipped',
            `Not moved to ${stage.label}: ${moved.blockers.map((b) => b.message).join(' ')}`);
          return done();
        }
        await recordExecution(ctx.enrollmentId, node, 'executed', `Moved to ${stage.label}`);
      } catch (err) {
        await recordExecution(ctx.enrollmentId, node, 'skipped',
          `Not moved to ${stage.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return done();
    }

    case 'assign_user': {
      if (!ctx.applicationId) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', 'No application on this enrollment');
        return done();
      }
      const outcome = await withTransaction(async (client) => {
        if (node.only_if_unassigned) {
          const { rows } = await client.query(
            `SELECT 1 FROM assignments WHERE application_id = $1 AND role = $2 AND is_primary
                AND unassigned_at IS NULL`, [ctx.applicationId, node.role]);
          if (rows.length) return { skipped: `Already has a ${node.role}` };
        }
        const userId = node.mode === 'round_robin'
          ? await claimNextInRotation(client, ctx.organizationId, [])
          : node.user_id ?? null;
        if (!userId) return { skipped: 'Nobody is in the round robin' };
        const { rows } = await client.query<{ name: string }>(
          `SELECT name FROM users WHERE id = $1 AND organization_id = $2 AND ${ASSIGNABLE_SQL}`,
          [userId, ctx.organizationId]);
        if (!rows.length) return { skipped: 'That staff member cannot take files' };
        await assignInTransaction(client, ctx.organizationId, {
          applicationId: ctx.applicationId!, userId, role: node.role,
          title: `You were assigned as ${node.role}`,
          body: `By the automation "${ctx.automationName}".`,
          dedupeKey: `automation:${ctx.enrollmentId}:${node.key}`,
        });
        return { name: rows[0]!.name };
      });
      await recordExecution(ctx.enrollmentId, node, 'skipped' in outcome ? 'skipped' : 'executed',
        'skipped' in outcome ? outcome.skipped : `Assigned ${outcome.name} as ${node.role}`);
      return done();
    }

    case 'request_documents': {
      if (!ctx.applicationId) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', 'No application on this enrollment');
        return done();
      }
      let ids = node.required_document_ids;
      if (!ids.length) {
        const purpose = String(ctx.facts['purpose.purpose'] ?? ctx.facts.purpose ?? '');
        ids = (await checklistFor(ctx.organizationId, purpose)).documents
          .filter((d) => d.required).map((d) => d.id);
      }
      if (!ids.length) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', 'There is no checklist for this purpose');
        return done();
      }
      const result = await createDocumentRequest(
        { organizationId: ctx.organizationId, userId: null, name: ctx.automationName, kind: 'system' },
        ctx.applicationId,
        { items: ids.map((id) => ({ required_document_id: id })), channel: node.channel,
          message: node.message ? interpolate(node.message, ctx.facts) : undefined,
          expires_in_days: node.expires_in_days },
        { dedupe: `automation:${ctx.enrollmentId}:${node.key}` },
      );
      await recordExecution(ctx.enrollmentId, node, result.sent ? 'executed' : 'suppressed',
        result.sent ? `Asked for ${result.items} document(s)` : `Request saved, not delivered — ${result.reason}`);
      return done(result.sent);
    }

    case 'enroll_automation': {
      if (!node.automation_id) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', 'No workflow was chosen');
        return done();
      }
      if (node.automation_id === ctx.automationId) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', 'A workflow cannot add a client to itself');
        return done();
      }
      const target = await publishedAutomation(ctx.organizationId, node.automation_id);
      if (!target) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', 'That workflow is not published and running');
        return done();
      }
      const id = await enrol(target, ctx.organizationId, ctx.customerId, ctx.applicationId,
        `Added by the workflow "${ctx.automationName}"`);
      await recordExecution(ctx.enrollmentId, node, id ? 'executed' : 'skipped',
        id ? `Added to "${target.name}"` : `Already in "${target.name}", or not allowed to re-enter`);
      return done();
    }

    case 'stop_automation': {
      const stopped = await query(
        `UPDATE automation_enrollments
            SET status = 'stopped', stopped_at = now(), next_run_at = NULL, stopped_reason = $3
          WHERE customer_id = $1 AND status IN ('active','paused') AND id <> $2
            AND ($4::uuid IS NULL OR automation_id = $4::uuid)`,
        [ctx.customerId, ctx.enrollmentId, `Removed by the workflow "${ctx.automationName}"`,
         node.automation_id]);
      await recordExecution(ctx.enrollmentId, node, 'executed',
        `Removed from ${stopped.rowCount ?? 0} other workflow(s)`);
      return done();
    }

    case 'webhook': {
      const result = await callWebhook(node, ctx);
      await recordExecution(ctx.enrollmentId, node, result.ok ? 'executed' : 'failed', result.message);
      return done();
    }

    case 'stop': {
      await recordExecution(ctx.enrollmentId, node, 'executed', node.reason ?? 'Sequence ended');
      return { kind: 'done', nextKey: null };
    }
  }
}

function labelOf(definition: AutomationDefinition, key: string | null): string {
  const node = nodeByKey(definition, key);
  return node?.label ?? key ?? 'the end';
}

// ── The outgoing webhook ───────────────────────────────────────────────────

/**
 * Is this address somewhere the CRM must never be made to call?
 *
 * A webhook URL is typed by a person with automation rights, and without this
 * it is a way to make the server read its own metadata service or an internal
 * admin port. Every address the name resolves to is checked, not only the
 * first, because DNS can be made to answer differently.
 */
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function callWebhook(node: Extract<AutomationNode, { type: 'webhook' }>, ctx: ExecuteContext): Promise<{ ok: boolean; message: string }> {
  let url: URL;
  try { url = new URL(node.url); } catch { return { ok: false, message: 'That is not a valid address.' }; }
  if (url.protocol !== 'https:') return { ok: false, message: 'Only https:// addresses can be called.' };
  try {
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      return { ok: false, message: 'That address is on a private network and cannot be called.' };
    }
  } catch {
    return { ok: false, message: `Could not resolve ${url.hostname}.` };
  }

  const pick = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, ctx.facts[k] ?? null]));
  const body = JSON.stringify({
    workflow: { id: ctx.automationId, name: ctx.automationName, step: node.label ?? node.key },
    enrollment_id: ctx.enrollmentId,
    contact: pick(['customer_id', 'first_name', 'last_name', 'email', 'phone_e164', 'tags', 'lead_source']),
    application: ctx.applicationId ? pick([
      'application_id', 'portal_reference', 'pipeline_key', 'stage_key', 'stage_label', 'purpose',
      'amount_requested', 'closing_date', 'property_city', 'property_province', 'percent_complete',
    ]) : null,
    sent_at: new Date().toISOString(),
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'user-agent': 'Lendmax-CRM-Workflow/1',
    'x-lendmax-delivery': `${ctx.enrollmentId}:${node.key}`,
  };
  if (node.secret) headers['x-lendmax-signature'] = `sha256=${createHmac('sha256', node.secret).update(body).digest('hex')}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // No redirects: a public address that redirects to a private one would
    // walk straight past the check above.
    const res = await fetch(url, { method: node.method, headers, body, redirect: 'manual', signal: controller.signal });
    return res.ok
      ? { ok: true, message: `${url.hostname} answered ${res.status}` }
      : { ok: false, message: `${url.hostname} answered ${res.status}` };
  } catch (err) {
    return { ok: false, message: `Could not reach ${url.hostname}: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── People ─────────────────────────────────────────────────────────────────

const NOBODY_TO_ASSIGN =
  'Nobody holds that role on this file, and there is no broker to fall back to.';

async function userContact(organizationId: string, userId: string | undefined) {
  if (!userId) return null;
  return queryOne<{ email: string; name: string }>(
    `SELECT email, name FROM users WHERE id = $1 AND organization_id = $2 AND active`,
    [userId, organizationId]);
}

async function roleContact(ctx: ExecuteContext, role: string) {
  const recipient = await resolveRecipient(ctx, role);
  return recipient ? userContact(ctx.organizationId, recipient.userId) : null;
}

/**
 * Who an automation's task or notification actually goes to.
 *
 * The role if somebody holds it, otherwise the broker (who owns the file and
 * can hand it on), otherwise nobody and the step says so out loud. The
 * fallback is named in the execution record, because "assigned to the broker
 * because there is no underwriter" is a staffing fact somebody should read.
 */
async function resolveRecipient(
  ctx: ExecuteContext,
  role: string,
): Promise<{ userId: string; name: string; note: string } | null> {
  if (!ctx.applicationId) return null;
  const found = await queryOne<{ user_id: string; name: string; role: string }>(
    `SELECT a.user_id, u.name, a.role
       FROM assignments a JOIN users u ON u.id = a.user_id
      WHERE a.application_id = $1 AND a.unassigned_at IS NULL
        AND a.role IN ($2, 'broker') AND u.active
      ORDER BY (a.role = $2) DESC, a.is_primary DESC
      LIMIT 1`,
    [ctx.applicationId, role],
  );
  if (!found) return null;
  return {
    userId: found.user_id,
    name: found.name,
    note: found.role === role ? '' : ` (the broker — no ${role} is assigned)`,
  };
}

// ── Messages ───────────────────────────────────────────────────────────────

async function renderForNode(
  node: Extract<AutomationNode, { type: 'send_email' | 'send_sms' }>,
  ctx: ExecuteContext,
): Promise<{ subject?: string; text: string; html?: string; used: Record<string, unknown> }> {
  if (node.template_key) {
    const template = await queryOne<{ subject: string | null; body_text: string | null; body_html: string | null }>(
      `SELECT subject, body_text, body_html FROM templates
        WHERE organization_id = $1 AND key = $2 AND active`,
      [ctx.organizationId, node.template_key],
    );
    if (!template) throw new Error(`The template "${node.template_key}" does not exist.`);
    const context = await mergeContextFor(ctx);
    return {
      subject: template.subject ? renderTemplate(template.subject, context).text : undefined,
      text: renderTemplate(template.body_text ?? '', context).text,
      html: template.body_html ? renderTemplate(template.body_html, context).text : undefined,
      used: context.values,
    };
  }
  const context = await mergeContextFor(ctx);
  return {
    subject: 'subject' in node && node.subject
      ? renderTemplate(node.subject, context).text : undefined,
    text: renderTemplate(node.body ?? '', context).text,
    used: context.values,
  };
}

async function mergeContextFor(ctx: ExecuteContext): Promise<MergeContext> {
  const user = await queryOne<{ id: string; name: string; mobile_phone: string | null; booking_url: string | null }>(
    `SELECT u.id, u.name, p.mobile_phone, p.booking_url
       FROM assignments a JOIN users u ON u.id = a.user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE a.application_id = $1 AND a.role = 'broker' AND a.unassigned_at IS NULL
      LIMIT 1`,
    [ctx.applicationId],
  );
  return {
    values: {
      ...ctx.facts,
      user_name: user?.name ?? null,
      user_first_name: user?.name?.split(' ')[0] ?? null,
      user_cell: user?.mobile_phone ?? null,
      schedule_link: user?.booking_url ?? null,
      signature: (await signatureFor(user?.id))?.text ?? null,
      // Same helper the manual composer and campaigns use, so a calculator
      // link means the same thing however the message was written.
      ...calculatorMergeValues(ctx.organizationId, ctx.customerId, ctx.facts.transaction_type_key),
    },
  };
}

/**
 * A merge field inside a task title or an internal note.
 *
 * Deliberately NOT the client-facing renderer. That one drops a whole line
 * when a value is missing, which is right for a message going to a borrower
 * and wrong for an internal task — a task called "" helps nobody, and staff
 * can see that a value was unavailable.
 */
function interpolate(text: string, facts: Facts): string {
  return text.replace(/\{\{?\s*([a-z0-9_.]+)\s*\}?\}/gi, (match, name: string) => {
    const value = facts[name];
    return value === null || value === undefined || value === '' ? match : String(value);
  });
}

async function recordExecution(
  enrollmentId: string,
  node: AutomationNode,
  outcome: 'executed' | 'skipped' | 'failed' | 'branched' | 'waiting' | 'suppressed',
  reason?: string,
  messageId?: string,
  taskId?: string,
): Promise<void> {
  await query(
    `INSERT INTO automation_executions (enrollment_id, node_key, node_type, outcome, reason,
                                        message_id, task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [enrollmentId, node.key, node.type, outcome, reason ?? null, messageId ?? null, taskId ?? null],
  );
}

async function stop(enrollmentId: string, reason: string): Promise<void> {
  await query(
    `UPDATE automation_enrollments
        SET status = 'stopped', stopped_at = now(), stopped_reason = $2, next_run_at = NULL
      WHERE id = $1`,
    [enrollmentId, reason],
  );
  log.info('enrollment stopped', { enrollmentId, reason });
}

async function complete(enrollmentId: string, last = { stepRan: false, sent: false }): Promise<void> {
  await query(
    `UPDATE automation_enrollments
        SET status = 'completed', completed_at = now(), next_run_at = NULL,
            steps_completed = steps_completed + $2, messages_sent = messages_sent + $3
      WHERE id = $1`,
    [enrollmentId, last.stepRan ? 1 : 0, last.sent ? 1 : 0],
  );
}

/**
 * Stop every live enrollment on a file, with a reason.
 *
 * Called by the stage machine when a file funds or is lost, so a nurture
 * sequence cannot outlive the thing it was about.
 */
export async function stopEnrollmentsFor(
  applicationId: string,
  reason: string,
  purposes?: Array<'transactional' | 'marketing' | 'service'>,
): Promise<number> {
  const result = await query(
    `UPDATE automation_enrollments e
        SET status = 'stopped', stopped_at = now(), stopped_reason = $2, next_run_at = NULL
       FROM automations a
      WHERE a.id = e.automation_id AND e.application_id = $1
        AND e.status IN ('active','paused')
        AND ($3::text[] IS NULL OR a.purpose = ANY($3::text[]))`,
    [applicationId, reason, purposes ?? null],
  );
  return result.rowCount ?? 0;
}

// ── A dry run ──────────────────────────────────────────────────────────────

export type TestStep = {
  key: string; type: string; label: string; outcome: 'would_run' | 'branched' | 'waits' | 'ends';
  detail: string;
};

/**
 * Walk a definition against one real file without doing anything.
 *
 * Which trigger conditions and entry conditions pass, whether a stop condition
 * would end it before it started, and the path the steps would take today —
 * which branch, what wait. Nothing is sent, created or moved.
 */
export async function dryRun(
  definition: AutomationDefinition,
  organizationId: string,
  customerId: string,
  applicationId: string | null,
): Promise<{
  facts: Facts; triggers: Array<{ label: string; type: string; filters_pass: boolean }>;
  entry_pass: boolean; stop_reason: string | null; steps: TestStep[];
}> {
  const file = applicationId ?? (await queryOne<{ id: string }>(
    `SELECT id FROM applications WHERE customer_id = $1 AND archived_at IS NULL
      ORDER BY last_activity_at DESC NULLS LAST LIMIT 1`, [customerId]))?.id ?? null;
  const facts = await gatherFacts(pool, customerId, file);
  if (!Object.keys(facts).length) throw new Error('That client does not exist.');
  void organizationId;

  const steps: TestStep[] = [];
  const seen = new Set<string>();
  let key: string | null = definition.start_node;
  while (key && steps.length < 60) {
    const node = nodeByKey(definition, key);
    if (!node) break;
    const label = node.label ?? node.type;
    if (seen.has(key) && node.type !== 'wait') {
      steps.push({ key, type: node.type, label, outcome: 'ends', detail: 'Loops back here — the test stops.' });
      break;
    }
    seen.add(key);
    if (node.type === 'if_else') {
      const branch = chosenBranch(node, facts);
      steps.push({ key, type: node.type, label, outcome: 'branched',
                   detail: branch ? `Takes "${branch.name}"` : 'No branch matches — takes None' });
    } else if (node.type === 'branch') {
      const yes = evaluateConditions(node.conditions, facts, node.match);
      steps.push({ key, type: node.type, label, outcome: 'branched', detail: yes ? 'Takes Yes' : 'Takes No' });
    } else if (node.type === 'wait') {
      steps.push({ key, type: node.type, label, outcome: 'waits',
                   detail: `Would wait until ${waitUntil(node, facts).toLocaleString('en-CA')}` });
    } else if (node.type === 'stop') {
      steps.push({ key, type: node.type, label, outcome: 'ends', detail: node.reason ?? 'Ends here' });
      break;
    } else {
      steps.push({ key, type: node.type, label, outcome: 'would_run', detail: '' });
    }
    if (seen.has(nextKey(node, facts) ?? '') && nodeByKey(definition, nextKey(node, facts))?.type === 'wait') break;
    key = nextKey(node, facts);
  }

  return {
    facts,
    triggers: definition.triggers.map((t) => ({
      type: t.type, label: t.label ?? t.type, filters_pass: evaluateConditions(t.filters, facts),
    })),
    entry_pass: evaluateConditions(definition.entry_conditions, facts),
    stop_reason: firstStopReason(definition, facts),
    steps,
  };
}
