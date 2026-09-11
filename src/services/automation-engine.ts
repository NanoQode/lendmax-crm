/**
 * The automation runtime.
 *
 * Two halves:
 *
 *   `processEvents` — reads unprocessed domain_events, matches them to the
 *   triggers of published automations, and enrols whoever qualifies.
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
import type pg from 'pg';
import { pool, query, queryOne, withTransaction } from '../db/pool.ts';
import { log } from '../lib/logger.ts';
import {
  DefinitionSchema, evaluateConditions, firstStopReason, nextKey, nodeByKey,
  waitMs, type AutomationDefinition, type AutomationNode, type Facts,
} from '../domain/automation.ts';
import { renderTemplate, type MergeContext } from '../domain/merge-fields.ts';
import { send } from './messaging.ts';
import { enqueue } from '../jobs/queue.ts';
import { nextSendableTime, type QuietHours, DEFAULT_QUIET_HOURS } from '../domain/dates.ts';
import { env } from '../config/env.ts';

/**
 * Everything a condition or a merge field can read about a file.
 *
 * One query per enrollment per step. The alternative — a query per condition —
 * is what makes an engine that works at fifty enrollments unusable at five
 * thousand.
 */
export async function gatherFacts(
  client: pg.PoolClient | typeof pool,
  customerId: string,
  applicationId: string | null,
): Promise<Facts> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT
       c.id AS customer_id, c.first_name, c.last_name, c.email, c.phone_e164,
       c.last_contacted_at, c.awaiting_reply_since, c.tags,
       app.id AS application_id, app.portal_reference, app.stage_key, app.status_key,
       app.percent_complete, app.amount_requested, app.closing_date, app.maturity_date,
       app.transaction_type_key, app.purpose, app.documents_outstanding,
       app.scarlett_deal_id, app.property_city, app.property_province,
       app.lost_disposition_key, app.submitted_at,
       COALESCE(ps.category, 'open') AS stage_category,
       ps.label AS stage_label,
       COALESCE(cond.outstanding, 0) AS conditions_outstanding,
       COALESCE(appt.future, 0) AS future_appointments,
       COALESCE(appt.no_show, false) AS last_appointment_no_show,
       COALESCE(f.confirmed, false) AS funding_confirmed,
       (app.closing_date - CURRENT_DATE) AS days_to_close,
       (app.maturity_date - CURRENT_DATE) AS days_to_maturity
     FROM customers c
     LEFT JOIN applications app ON app.id = $2::uuid
     LEFT JOIN pipeline_stages ps
            ON ps.organization_id = app.organization_id AND ps.key = app.stage_key
     LEFT JOIN funding_records f ON f.application_id = app.id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS outstanding FROM lender_conditions lc
        WHERE lc.application_id = app.id AND lc.status = 'outstanding'
     ) cond ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE a.starts_at > now() AND a.status IN ('booked','confirmed'))::int AS future,
              bool_or(a.status = 'no_show') AS no_show
         FROM appointments a WHERE a.application_id = app.id
     ) appt ON TRUE
     WHERE c.id = $1`,
    [customerId, applicationId],
  );
  return (rows[0] ?? {}) as Facts;
}

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

type PublishedAutomation = {
  id: string;
  key: string;
  name: string;
  purpose: 'transactional' | 'marketing' | 'service';
  allow_reenrollment: boolean;
  reenrollment_cooldown_days: number | null;
  version: number;
  definition: AutomationDefinition;
};

async function publishedAutomations(organizationId: string): Promise<PublishedAutomation[]> {
  const { rows } = await query<Omit<PublishedAutomation, 'definition'> & { definition: unknown }>(
    `SELECT a.id, a.key, a.name, a.purpose, a.allow_reenrollment, a.reenrollment_cooldown_days,
            v.version, v.definition
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
        const matching = automations.filter((a) => a.definition.trigger.type === event.event_type);
        if (matching.length) {
          const facts = await gatherFacts(pool, event.customer_id, event.application_id);
          for (const automation of matching) {
            if (!evaluateConditions(automation.definition.trigger.filters, facts)) continue;
            if (!evaluateConditions(automation.definition.entry_conditions, facts)) continue;
            // Somebody already past the point the sequence is about should not
            // be enrolled into it at all.
            if (firstStopReason(automation.definition, facts)) continue;
            const created = await enrol(automation, organizationId, event.customer_id,
                                        event.application_id, `event ${event.event_type}`);
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

  const facts = await gatherFacts(pool, customerId, applicationId);

  const row = await queryOne<{ id: string }>(
    `INSERT INTO automation_enrollments
       (organization_id, automation_id, automation_version, customer_id, application_id,
        current_node_key, next_run_at, context, enrolled_by, enrolled_reason)
     VALUES ($1,$2,$3,$4,$5,$6,now(),$7::jsonb,$8,$9)
     ON CONFLICT (automation_id, customer_id) WHERE status IN ('active','paused') DO NOTHING
     RETURNING id`,
    [
      organizationId, automation.id, automation.version, customerId, applicationId,
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

// ── Running one step ───────────────────────────────────────────────────────

export type StepOutcome = {
  status: 'advanced' | 'waiting' | 'completed' | 'stopped' | 'failed';
  reason?: string;
};

export async function runStep(enrollmentId: string): Promise<StepOutcome> {
  const enrollment = await queryOne<{
    id: string; organization_id: string; automation_id: string; automation_version: number;
    customer_id: string; application_id: string | null; status: string;
    current_node_key: string | null; steps_completed: number; messages_sent: number;
  }>(
    `SELECT * FROM automation_enrollments WHERE id = $1`, [enrollmentId],
  );
  if (!enrollment) return { status: 'failed', reason: 'No such enrollment.' };
  if (enrollment.status !== 'active') return { status: 'stopped', reason: `Already ${enrollment.status}.` };

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
      customerId: enrollment.customer_id,
      applicationId: enrollment.application_id,
      automationName: versionRow.name,
      automationPurpose: versionRow.purpose as 'transactional' | 'marketing' | 'service',
      facts,
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
        dedupeKey: `automation.step:${enrollmentId}:${result.nextKey}`,
      });
      return { status: 'waiting' };
    }

    const next = result.nextKey;
    if (!next) {
      await complete(enrollmentId);
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
    // in it, so this cannot spin.
    await enqueue('automation.step', { enrollmentId }, {
      organizationId: enrollment.organization_id,
      dedupeKey: `automation.step:${enrollmentId}:${next}`,
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
  customerId: string;
  applicationId: string | null;
  automationName: string;
  automationPurpose: 'transactional' | 'marketing' | 'service';
  facts: Facts;
};

type ExecuteResult =
  | { kind: 'wait'; nextKey: string | null; runAt: Date }
  | { kind: 'done'; nextKey: string | null; sent?: boolean };

async function executeNode(node: AutomationNode, ctx: ExecuteContext): Promise<ExecuteResult> {
  switch (node.type) {
    case 'wait': {
      let runAt = new Date(Date.now() + waitMs(node));
      if (node.business_hours_only) {
        const { quiet, timezone } = await quietHoursFor(ctx.organizationId);
        runAt = nextSendableTime(runAt, timezone, quiet);
      }
      await recordExecution(ctx.enrollmentId, node, 'waiting', `Until ${runAt.toISOString()}`);
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
      return { kind: 'done', nextKey: nextKey(node, ctx.facts), sent: outcome.ok };
    }

    case 'branch': {
      const target = nextKey(node, ctx.facts);
      await recordExecution(
        ctx.enrollmentId, node, 'branched',
        `Went to "${target ?? 'the end'}"`,
      );
      return { kind: 'done', nextKey: target };
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
            interpolate(node.title, ctx.facts), node.description ?? null,
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
      return { kind: 'done', nextKey: nextKey(node, ctx.facts) };
    }

    case 'notify_user': {
      const recipient = await resolveRecipient(ctx, node.role);
      if (!recipient) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', NOBODY_TO_ASSIGN);
        return { kind: 'done', nextKey: nextKey(node, ctx.facts) };
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
      return { kind: 'done', nextKey: nextKey(node, ctx.facts) };
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
      return { kind: 'done', nextKey: nextKey(node, ctx.facts) };
    }

    case 'add_tag': {
      await query(
        `UPDATE customers SET tags = array_append(tags, $2)
          WHERE id = $1 AND NOT ($2 = ANY(tags))`,
        [ctx.customerId, node.tag],
      );
      await recordExecution(ctx.enrollmentId, node, 'executed', `Tagged "${node.tag}"`);
      return { kind: 'done', nextKey: nextKey(node, ctx.facts) };
    }

    case 'set_stage': {
      // Deliberately narrow: the engine sets the column and records it, and
      // does NOT run the stage machine's entry rules. An automation that can
      // force a file past the compliance gate is an automation that will.
      if (!ctx.applicationId) {
        await recordExecution(ctx.enrollmentId, node, 'skipped', 'No application on this enrollment');
        return { kind: 'done', nextKey: nextKey(node, ctx.facts) };
      }
      const stage = await queryOne<{ key: string; label: string; category: string }>(
        `SELECT key, label, category FROM pipeline_stages
          WHERE organization_id = $1 AND key = $2 AND active`,
        [ctx.organizationId, node.stage_key],
      );
      if (!stage || stage.category === 'won') {
        await recordExecution(
          ctx.enrollmentId, node, 'skipped',
          stage ? 'An automation may not mark a file funded' : `No stage "${node.stage_key}"`,
        );
        return { kind: 'done', nextKey: nextKey(node, ctx.facts) };
      }
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE applications SET stage_key = $2, stage_changed_at = now() WHERE id = $1`,
          [ctx.applicationId, stage.key],
        );
        await client.query(
          `INSERT INTO stage_transitions (application_id, from_stage_key, to_stage_key,
                                          actor_kind, reason)
           VALUES ($1,$2,$3,'system',$4)`,
          [ctx.applicationId, String(ctx.facts.stage_key ?? ''), stage.key,
           `Automation: ${ctx.automationName}`],
        );
      });
      await recordExecution(ctx.enrollmentId, node, 'executed', `Moved to ${stage.label}`);
      return { kind: 'done', nextKey: nextKey(node, ctx.facts) };
    }

    case 'stop': {
      await recordExecution(ctx.enrollmentId, node, 'executed', node.reason ?? 'Sequence ended');
      return { kind: 'done', nextKey: null };
    }
  }
}

const NOBODY_TO_ASSIGN =
  'Nobody holds that role on this file, and there is no broker to fall back to.';

/**
 * Who an automation's task or notification actually goes to.
 *
 * The definition asks for a role — "assign the underwriting review to the
 * underwriter". On a file with no underwriter assigned, the previous version
 * of this inserted zero assignee rows and reported "Task created", which is
 * how a brokerage ends up with a queue of review tasks nobody can see and an
 * automation that looks like it is working.
 *
 * So: the role if somebody holds it, otherwise the broker (who owns the file
 * and can hand it on), otherwise nobody and the step says so out loud. The
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
  const user = await queryOne<{ name: string; mobile_phone: string | null; booking_url: string | null }>(
    `SELECT u.name, p.mobile_phone, p.booking_url
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
  return text.replace(/\{([a-z0-9_]+)\}/gi, (match, name: string) => {
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

async function complete(enrollmentId: string): Promise<void> {
  await query(
    `UPDATE automation_enrollments
        SET status = 'completed', completed_at = now(), next_run_at = NULL
      WHERE id = $1`,
    [enrollmentId],
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
