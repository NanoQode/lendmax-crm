/**
 * Moving one file to another stage — including a stage in another pipeline.
 *
 * Lifted out of the customers route so the admin panel and the v1 API move a
 * file the same way: the stage machine decides (domain/pipeline.ts), and the
 * move, its history, the automations it stops and starts, and the audit row
 * are written in one transaction.
 *
 * A move to a stage in another pipeline IS a pipeline change; the file's
 * pipeline follows its stage (migration 0019). It is recorded with both
 * pipelines so the history reads "moved from Purchases to Renewals".
 */
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.ts';
import { evaluateTransition, transitionEffects, type FileSnapshot, type StageDefinition } from '../domain/pipeline.ts';
import { AppError, notFound } from '../http/middleware/errors.ts';
import { recordAudit } from './audit.ts';
import type { Actor } from './staff.ts';

type StageRow = StageDefinition & { pipeline_id: string; pipeline_name: string; pipeline_active: boolean };

/** Every stage not deleted, with its pipeline. */
export async function loadStages(organizationId: string): Promise<StageRow[]> {
  const { rows } = await query<StageRow>(
    `SELECT s.key, s.label, s.position, s.category, s.probability, s.active, s.entry_rules,
            s.pipeline_id, p.name AS pipeline_name, p.active AS pipeline_active
       FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
      WHERE s.organization_id = $1 AND s.archived_at IS NULL AND p.archived_at IS NULL
      ORDER BY p.position, s.position`,
    [organizationId],
  );
  return rows.map((r) => ({ ...r, probability: r.probability === null ? null : Number(r.probability) }));
}

export const StageMoveInput = z.object({
  stage_key: z.string().min(1, 'Choose a stage.'),
  reason: z.string().max(500).optional(),
  force: z.boolean().default(false),
  lost_disposition_key: z.string().optional(),
  lost_reason_note: z.string().max(2000).optional(),
}).strict();

export type StageMoveResult =
  | { ok: true; stage: StageRow; from: StageRow | null; pipeline_changed: boolean;
      stopped_automations: number; overridden: unknown[] }
  | { ok: false; message: string; blockers: Array<{ field: string; label: string; message: string }> };

export async function moveFileToStage(
  actor: Actor, applicationId: string, raw: unknown, options: { mayForce: boolean; sessionId?: string },
): Promise<StageMoveResult> {
  if (!z.string().uuid().safeParse(applicationId).success) throw notFound('That application');
  const body = StageMoveInput.parse(raw);

  const stages = await loadStages(actor.organizationId);
  const target = stages.find((s) => s.key === body.stage_key);
  if (!target) throw new AppError(`No stage called "${body.stage_key}".`, 422, 'unknown_stage');
  // An inactive pipeline takes nothing new — the same rule as an inactive stage.
  if (!target.pipeline_active) {
    throw new AppError(`“${target.pipeline_name}” is not an active pipeline, so files cannot be moved into it.`,
                       422, 'pipeline_inactive');
  }

  // Forcing past an entry rule is a deliberate act with a permission of its
  // own; a broker cannot quietly skip the compliance gate on the way to
  // Funded.
  if (body.force && !options.mayForce) {
    throw new AppError(
      'Overriding a stage rule needs the pipeline configuration permission. ' +
        'Ask a manager, or complete what is outstanding.',
      403, 'forbidden');
  }

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query<FileSnapshot & { id: string; organization_id: string; pipeline_id: string }>(
      `SELECT app.id, app.organization_id, app.stage_key, app.stage_changed_at, app.pipeline_id,
              app.percent_complete, app.amount_requested, app.closing_date,
              app.property_province, app.transaction_type_key, app.scarlett_deal_id,
              COALESCE($3, app.lost_disposition_key) AS lost_disposition_key,
              COALESCE(f.confirmed, false) AS funding_confirmed,
              f.funded_amount, f.lender_name,
              COALESCE((SELECT COUNT(*) FROM compliance_checklist_items i
                          JOIN compliance_cases cc ON cc.id = i.compliance_case_id
                         WHERE cc.application_id = app.id AND i.required
                           AND i.status = 'outstanding'), 0)::int AS compliance_outstanding_required,
              COALESCE((SELECT COUNT(*) FROM appointments ap
                         WHERE ap.application_id = app.id
                           AND ap.status <> 'cancelled'), 0)::int AS appointment_count
         FROM applications app
         LEFT JOIN funding_records f ON f.application_id = app.id
        WHERE app.id = $1 AND app.organization_id = $2
        FOR UPDATE OF app`,
      [applicationId, actor.organizationId, body.lost_disposition_key ?? null],
    );
    const file = rows[0];
    if (!file) throw notFound('That application');

    const decision = evaluateTransition(file, target, { force: body.force });
    if (!decision.allowed) {
      return { allowed: false as const, message: decision.message, blockers: decision.blockers };
    }

    const from = stages.find((s) => s.key === file.stage_key) ?? null;
    const pipelineChanged = file.pipeline_id !== target.pipeline_id;
    const effects = transitionEffects(from, target);

    const sets: string[] = ['stage_key = $2', 'stage_changed_at = now()', 'last_activity_at = now()'];
    const params: unknown[] = [applicationId, target.key];
    for (const field of effects.clearFields) sets.push(`${field} = NULL`);
    if (target.category === 'lost') {
      sets.push('lost_at = now()');
      if (body.lost_disposition_key) {
        params.push(body.lost_disposition_key);
        sets.push(`lost_disposition_key = $${params.length}`);
      }
      if (body.lost_reason_note) {
        params.push(body.lost_reason_note);
        sets.push(`lost_reason_note = $${params.length}`);
      }
    }
    await client.query(`UPDATE applications SET ${sets.join(', ')} WHERE id = $1`, params);

    const { rows: transition } = await client.query<{ id: string }>(
      `INSERT INTO stage_transitions (application_id, from_stage_key, to_stage_key, from_pipeline_id,
                                      to_pipeline_id, actor_user_id, actor_kind, reason, seconds_in_from_stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [applicationId, file.stage_key, target.key, file.pipeline_id, target.pipeline_id, actor.userId,
       actor.kind, body.reason ?? (pipelineChanged ? `Moved to the ${target.pipeline_name} pipeline` : null),
       decision.secondsInFromStage],
    );

    /* A reason given on a move becomes a note on the file as well as a row in
       the transition history.
     *
     * Two places, on purpose, because they answer different questions. The
     * transition row is "how did this file get from Lead to Application, and
     * how long did it sit"; the note is "what was happening with this client",
     * which is what somebody reads down the Notes tab looking for context. A
     * reason recorded only in the transition history is one nobody finds. */
    if (body.reason?.trim()) {
      await client.query(
        `INSERT INTO notes (organization_id, application_id, customer_id, body, note_type,
                            visibility, author_id, author_name)
         SELECT $1, id, customer_id, $2, 'general', 'team', $3, $4
           FROM applications WHERE id = $5`,
        [actor.organizationId,
         `${from?.label ?? file.stage_key ?? 'Unstaged'} → ${target.label}: ${body.reason.trim()}`,
         actor.userId, actor.name, applicationId],
      );
    }

    // Automations that were about the old stage are ended here, inside the
    // same transaction as the move. A file that is funded with its nurture
    // sequence still running is the failure this prevents.
    let stoppedEnrollments = 0;
    for (const reason of effects.stopAutomationReasons) {
      const stopped = await client.query(
        `UPDATE automation_enrollments
            SET status = 'stopped', stopped_at = now(), stopped_reason = $2, next_run_at = NULL
          WHERE application_id = $1 AND status IN ('active','paused')`,
        [applicationId, reason],
      );
      stoppedEnrollments += stopped.rowCount ?? 0;
    }

    for (const eventType of effects.events) {
      // Keyed to this one move (its history row), as every event must be:
      // the automation engine consumes each key once.
      await client.query(
        `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id,
                                    payload, actor_user_id, dedupe_key)
         SELECT $1, $2, customer_id, id, $3::jsonb, $4, $6 FROM applications WHERE id = $5
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [actor.organizationId, eventType,
         JSON.stringify({ from: file.stage_key, to: target.key,
                          from_pipeline: from?.pipeline_id ?? null, to_pipeline: target.pipeline_id }),
         actor.userId, applicationId, `${eventType}:transition:${transition[0]!.id}`],
      );
    }

    const summary = pipelineChanged
      ? `Moved from ${from ? `${from.pipeline_name} · ${from.label}` : 'no stage'} to ${target.pipeline_name} · ${target.label}`
      : `Stage changed from ${from?.label ?? 'none'} to ${target.label}`;
    const full = summary + (body.force ? ' (rules overridden)' : '');

    await client.query(
      `INSERT INTO activity (organization_id, application_id, customer_id, kind,
                             actor_user_id, actor_name, actor_kind, summary, detail)
       SELECT $1, id, customer_id, 'stage', $2, $3, $4, $5, $6::jsonb FROM applications WHERE id = $7`,
      [actor.organizationId, actor.userId, actor.name, actor.kind, full,
       JSON.stringify({ from: file.stage_key, to: target.key, forced: body.force,
                        overridden: decision.warnings, pipeline_changed: pipelineChanged }), applicationId],
    );

    await recordAudit(
      {
        organizationId: actor.organizationId,
        actor: { userId: actor.userId, name: actor.name, role: actor.role ?? null, kind: actor.kind,
                 ip: actor.ip ?? null, sessionId: options.sessionId ?? null },
        action: pipelineChanged ? 'pipeline.file_moved' : 'stage.change',
        entityType: 'application',
        entityId: applicationId,
        summary: full,
        before: { stage_key: file.stage_key, pipeline_id: file.pipeline_id },
        after: { stage_key: target.key, pipeline_id: target.pipeline_id, forced: body.force,
                 overridden: decision.warnings },
      },
      client,
    );

    return { allowed: true as const, warnings: decision.warnings, stoppedEnrollments, from, pipelineChanged };
  });

  if (!result.allowed) return { ok: false, message: result.message, blockers: result.blockers };
  return {
    ok: true, stage: target, from: result.from, pipeline_changed: result.pipelineChanged,
    stopped_automations: result.stoppedEnrollments, overridden: result.warnings,
  };
}
