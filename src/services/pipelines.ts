/**
 * Pipelines and their stages.
 *
 * The one place the rest of the CRM asks "which pipelines are there, which
 * stages do they have, and where does a new file go". The admin panel, the
 * v1 API, the portal importer, new leads, the board, automations and
 * campaigns all read from `pipelineCatalogue` and `entryStage` here, so a
 * pipeline an admin adds is everywhere at once.
 *
 * Three rules:
 *   · An active pipeline always has somewhere to start, to win and to lose
 *     (domain/pipelines.ts). A change that would break that is refused.
 *   · Nothing in use is deleted out from under it. Deleting a stage or a
 *     pipeline that files sit on means saying where those files go; they are
 *     moved and the move is recorded on each file. The stage or pipeline is
 *     then archived, so history that passed through it keeps its name.
 *   · There is always exactly one default pipeline, and it is active.
 */
import type pg from 'pg';
import { z } from 'zod';
import { pool, withTransaction } from '../db/pool.ts';
import {
  entryStageOf, pipelineProblems, slugKey, STAGE_CATEGORIES, STARTER_STAGES, suggestTarget, uniqueKey,
} from '../domain/pipelines.ts';
import type { StageCategory } from '../domain/pipeline.ts';
import { PURPOSE_KEYS, PURPOSES, purposeKey, type PurposeKey } from '../domain/required-documents.ts';
import { AppError, fieldError, notFound } from '../http/middleware/errors.ts';
import { recordAudit } from './audit.ts';
import type { Actor } from './staff.ts';

type Db = pg.Pool | pg.PoolClient;

export type StageRecord = {
  id: string; pipeline_id: string; key: string; label: string; description: string | null;
  position: number; category: StageCategory; category_label: string; probability: number | null;
  colour: string | null; entry_rules: Record<string, unknown>; active: boolean;
  files: number; updated_at: string;
};

export type PipelineRecord = {
  id: string; key: string; name: string; description: string | null; colour: string | null;
  is_default: boolean; position: number; active: boolean;
  purposes: PurposeKey[]; purpose_labels: string[];
  stages: StageRecord[]; stage_count: number; files_open: number; files_total: number;
  problems: string[]; updated_at: string; updated_by_name: string | null;
  /** Where booking, attending and missing an appointment move a file (stage keys; null = stay). */
  appointment_stages: { booked: string | null; attended: string | null; missed: string | null };
};

const categoryLabel = (c: string) => STAGE_CATEGORIES.find((x) => x.key === c)?.label ?? c;
const purposeLabel = (p: string) => PURPOSES.find((x) => x.key === p)?.label ?? p;

const auditActor = (a: Actor) => ({
  userId: a.userId, name: a.name, role: a.role ?? null, kind: a.kind, ip: a.ip ?? null,
});

// ── Reading ────────────────────────────────────────────────────────────────

/**
 * Every pipeline (not deleted) with its stages and how many files sit on
 * each. The shape every consumer uses — the board, the dropdowns, the API.
 */
export async function pipelineCatalogue(db: Db, organizationId: string): Promise<PipelineRecord[]> {
  const { rows: pipelines } = await db.query<Omit<PipelineRecord, 'purposes' | 'purpose_labels' | 'stages' | 'stage_count' | 'files_open' | 'files_total' | 'problems' | 'appointment_stages'>
    & { appointment_booked_stage_key: string | null; appointment_attended_stage_key: string | null; appointment_missed_stage_key: string | null }>(
    `SELECT p.id, p.key, p.name, p.description, p.colour, p.is_default, p.position, p.active,
            p.updated_at, u.name AS updated_by_name, p.appointment_booked_stage_key,
            p.appointment_attended_stage_key, p.appointment_missed_stage_key
       FROM pipelines p LEFT JOIN users u ON u.id = COALESCE(p.updated_by, p.created_by)
      WHERE p.organization_id = $1 AND p.archived_at IS NULL
      ORDER BY p.is_default DESC, p.position, lower(p.name)`,
    [organizationId],
  );
  const { rows: stages } = await db.query<Omit<StageRecord, 'category_label'>>(
    `SELECT s.id, s.pipeline_id, s.key, s.label, s.description, s.position, s.category,
            s.probability::float AS probability, s.colour, s.entry_rules, s.active, s.updated_at,
            (SELECT count(*)::int FROM applications a
              WHERE a.organization_id = s.organization_id AND a.stage_key = s.key
                AND a.archived_at IS NULL) AS files
       FROM pipeline_stages s
      WHERE s.organization_id = $1 AND s.archived_at IS NULL
      ORDER BY s.position, s.label`,
    [organizationId],
  );
  const { rows: purposes } = await db.query<{ purpose: PurposeKey; pipeline_id: string }>(
    'SELECT purpose, pipeline_id FROM pipeline_purposes WHERE organization_id = $1', [organizationId]);

  return pipelines.map(({ appointment_booked_stage_key: booked, appointment_attended_stage_key: attended,
                           appointment_missed_stage_key: missed, ...p }) => {
    const own = stages.filter((s) => s.pipeline_id === p.id)
      .map((s) => ({ ...s, category_label: categoryLabel(s.category) }));
    const mine = PURPOSE_KEYS.filter((k) => purposes.some((x) => x.purpose === k && x.pipeline_id === p.id));
    return {
      ...p,
      appointment_stages: { booked, attended, missed },
      purposes: mine,
      purpose_labels: mine.map(purposeLabel),
      stages: own,
      stage_count: own.length,
      files_total: own.reduce((n, s) => n + s.files, 0),
      files_open: own.filter((s) => s.category === 'open' || s.category === 'parked').reduce((n, s) => n + s.files, 0),
      problems: p.active ? pipelineProblems(own, p.name) : [],
    };
  });
}

/**
 * The short form every dropdown needs: active pipelines, and active stages
 * labelled with their pipeline. Automations, campaigns and the client screens
 * all take it from here.
 */
export async function pipelineOptions(organizationId: string) {
  const catalogue = await pipelineCatalogue(pool, organizationId);
  const multiple = catalogue.filter((p) => p.active).length > 1;
  return {
    pipelines: catalogue.map((p) => ({ id: p.id, key: p.key, name: p.name, active: p.active, is_default: p.is_default })),
    stages: catalogue.flatMap((p) => p.stages.filter((s) => s.active && p.active).map((s) => ({
      key: s.key, label: multiple ? `${s.label} — ${p.name}` : s.label, stage_label: s.label,
      category: s.category, pipeline_id: p.id, pipeline_key: p.key, pipeline_name: p.name,
    }))),
  };
}

export async function getPipeline(organizationId: string, id: string): Promise<PipelineRecord> {
  if (!z.string().uuid().safeParse(id).success) throw notFound('That pipeline');
  const found = (await pipelineCatalogue(pool, organizationId)).find((p) => p.id === id);
  if (!found) throw notFound('That pipeline');
  return found;
}

/**
 * Which pipeline a purpose feeds: the active pipeline that claims it, or the
 * default. Accepts the portal's wording ("Home Equity Line") or a key.
 */
export async function pipelineForPurpose(db: Db, organizationId: string, purpose: string | null | undefined): Promise<string> {
  const key = purposeKey(purpose);
  if (key) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT p.id FROM pipeline_purposes pp JOIN pipelines p ON p.id = pp.pipeline_id
        WHERE pp.organization_id = $1 AND pp.purpose = $2 AND p.active AND p.archived_at IS NULL`,
      [organizationId, key]);
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await db.query<{ id: string }>('SELECT default_pipeline_for($1) AS id', [organizationId]);
  return rows[0]!.id;
}

/**
 * Where a new file lands: its purpose's pipeline, on that pipeline's first
 * active in-progress stage. Falls back to the default pipeline if the chosen
 * one has nowhere to start (which the rules above make unlikely).
 */
export async function entryStage(
  db: Db, organizationId: string, purpose: string | null | undefined,
): Promise<{ pipelineId: string; stageKey: string | null }> {
  const pipelineId = await pipelineForPurpose(db, organizationId, purpose);
  const first = async (pid: string) => {
    const { rows } = await db.query<{ key: string; category: StageCategory; active: boolean; position: number }>(
      `SELECT key, category, active, position FROM pipeline_stages
        WHERE pipeline_id = $1 AND archived_at IS NULL`, [pid]);
    return entryStageOf(rows)?.key ?? null;
  };
  const stageKey = await first(pipelineId);
  if (stageKey) return { pipelineId, stageKey };
  const fallback = await pipelineForPurpose(db, organizationId, null);
  return { pipelineId: fallback, stageKey: await first(fallback) };
}

// ── What uses a stage or a pipeline ────────────────────────────────────────

export type Usage = {
  files: number;
  files_open: number;
  by_stage: Array<{ key: string; label: string; category: StageCategory; files: number }>;
  automations: Array<{ id: string; name: string; status: string }>;
  campaigns: Array<{ id: string; name: string; status: string }>;
  purposes: string[];
  is_default: boolean;
};

/**
 * Automations and campaigns that name these stages or pipelines.
 *
 * Matched on structure, not text: a condition on the stage field, a "move to
 * stage" step, or a condition on the pipeline. Text matching found the Lost
 * stage in every automation that stops "when the stage category is lost" —
 * a different field that happens to share the word.
 */
async function referencing(db: Db, organizationId: string, stageKeys: string[], pipelineKeys: string[] = []) {
  if (!stageKeys.length && !pipelineKeys.length) return { automations: [], campaigns: [] };
  const path = `$.** ? ((@.field == "stage_key" && @.value == $stages) || @.stage_key == $stages
                        || ((@.field == "pipeline_key" || @.field == "pipeline") && @.value == $pipelines))`;
  const vars = JSON.stringify({ stages: stageKeys, pipelines: pipelineKeys });
  const { rows: automations } = await db.query<{ id: string; name: string; status: string }>(
    `SELECT a.id, a.name, a.status FROM automations a
       JOIN LATERAL (SELECT definition FROM automation_versions v WHERE v.automation_id = a.id
                      ORDER BY v.version DESC LIMIT 1) v ON TRUE
      WHERE a.organization_id = $1 AND a.status <> 'archived'
        AND jsonb_path_exists(v.definition, $2::jsonpath, $3::jsonb)
      ORDER BY a.name`,
    [organizationId, path, vars]);
  const { rows: campaigns } = await db.query<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM campaigns
      WHERE organization_id = $1 AND status IN ('draft','scheduled','paused','sending')
        AND jsonb_path_exists(segment, $2::jsonpath, $3::jsonb)
      ORDER BY name`,
    [organizationId, path, vars]);
  return { automations, campaigns };
}

export async function stageUsage(organizationId: string, stageId: string): Promise<Usage & { stage: StageRecord; pipeline: PipelineRecord }> {
  const { pipeline, stage } = await findStage(organizationId, stageId);
  const refs = await referencing(pool, organizationId, [stage.key]);
  return {
    stage, pipeline,
    files: stage.files,
    files_open: stage.category === 'open' || stage.category === 'parked' ? stage.files : 0,
    by_stage: [{ key: stage.key, label: stage.label, category: stage.category, files: stage.files }],
    ...refs,
    purposes: [],
    is_default: false,
  };
}

export async function pipelineUsage(organizationId: string, id: string): Promise<Usage & { pipeline: PipelineRecord }> {
  const pipeline = await getPipeline(organizationId, id);
  const refs = await referencing(pool, organizationId, pipeline.stages.map((s) => s.key), [pipeline.key]);
  return {
    pipeline,
    files: pipeline.files_total,
    files_open: pipeline.files_open,
    by_stage: pipeline.stages.filter((s) => s.files > 0)
      .map((s) => ({ key: s.key, label: s.label, category: s.category, files: s.files })),
    ...refs,
    purposes: pipeline.purpose_labels,
    is_default: pipeline.is_default,
  };
}

/**
 * For each stage with files, the stage in `targetPipelineId` they would go to
 * — the suggestion the delete screen starts from.
 */
export async function suggestStageMap(organizationId: string, fromPipelineId: string, targetPipelineId: string) {
  const all = await pipelineCatalogue(pool, organizationId);
  const from = all.find((p) => p.id === fromPipelineId);
  const to = all.find((p) => p.id === targetPipelineId);
  if (!from || !to) throw notFound('That pipeline');
  return Object.fromEntries(from.stages.filter((s) => s.files > 0)
    .map((s) => [s.key, suggestTarget(s, to.stages)?.key ?? null]));
}

// ── Pipelines: writing ─────────────────────────────────────────────────────

const colour = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'A colour is a hex value like #4f46e5.')
  .nullable().optional();

export const PipelineInput = z.object({
  name: z.string({ required_error: 'Name the pipeline.' }).trim()
    .min(2, 'Name the pipeline — at least 2 characters.').max(80, 'At most 80 characters.'),
  description: z.string().trim().max(500, 'At most 500 characters.').optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
  colour,
  purposes: z.array(z.enum(PURPOSE_KEYS)).max(4).optional(),
  is_default: z.boolean().optional(),
  active: z.boolean().optional(),
  /** Create only: start with a copy of another pipeline's stages. */
  copy_from: z.string().uuid().nullable().optional(),
}).strict();

const stageKeyOrNull = z.string().trim().min(1).max(80).nullable().optional();
const PipelineUpdate = PipelineInput.omit({ copy_from: true }).partial().extend({
  /** Stages in THIS pipeline that booking, attending and missing an appointment move a file to. */
  appointment_stages: z.object({ booked: stageKeyOrNull, attended: stageKeyOrNull, missed: stageKeyOrNull })
    .strict().optional(),
}).strict();

/**
 * The appointment stages a new pipeline starts with: the same stages (by
 * name) as the pipeline it was copied from, else ones that look the part —
 * "Appointment Booked", "Application", and the first parked stage.
 */
async function applyAppointmentDefaults(client: pg.PoolClient, pipelineId: string, copyFrom: string | null) {
  const { rows: stages } = await client.query<{ key: string; label: string; category: string; active: boolean }>(
    'SELECT key, label, category, active FROM pipeline_stages WHERE pipeline_id = $1 AND archived_at IS NULL ORDER BY position',
    [pipelineId]);
  const byLabel = (label: string | null | undefined) =>
    label ? stages.find((s) => s.active && s.label.toLowerCase() === label.toLowerCase())?.key ?? null : null;
  let picks = {
    booked: byLabel('Appointment Booked'),
    attended: byLabel('Application'),
    missed: stages.find((s) => s.active && s.category === 'parked')?.key ?? null,
  };
  if (copyFrom) {
    const { rows } = await client.query<{ booked: string | null; attended: string | null; missed: string | null }>(
      `SELECT (SELECT label FROM pipeline_stages WHERE key = p.appointment_booked_stage_key AND organization_id = p.organization_id) AS booked,
              (SELECT label FROM pipeline_stages WHERE key = p.appointment_attended_stage_key AND organization_id = p.organization_id) AS attended,
              (SELECT label FROM pipeline_stages WHERE key = p.appointment_missed_stage_key AND organization_id = p.organization_id) AS missed
         FROM pipelines p WHERE p.id = $1`, [copyFrom]);
    if (rows[0]) picks = { booked: byLabel(rows[0].booked), attended: byLabel(rows[0].attended), missed: byLabel(rows[0].missed) };
  }
  await client.query(
    `UPDATE pipelines SET appointment_booked_stage_key = $2, appointment_attended_stage_key = $3,
                          appointment_missed_stage_key = $4 WHERE id = $1`,
    [pipelineId, picks.booked, picks.attended, picks.missed]);
}

async function takenStageKeys(client: pg.PoolClient, organizationId: string): Promise<Set<string>> {
  const { rows } = await client.query<{ key: string }>(
    'SELECT key FROM pipeline_stages WHERE organization_id = $1', [organizationId]);
  return new Set(rows.map((r) => r.key));
}

/** Claim these purposes for a pipeline; returns the ones taken from another. */
async function claimPurposes(
  client: pg.PoolClient, organizationId: string, pipelineId: string, purposes: PurposeKey[],
): Promise<string[]> {
  const { rows: before } = await client.query<{ purpose: string; name: string; pipeline_id: string }>(
    `SELECT pp.purpose, p.name, pp.pipeline_id FROM pipeline_purposes pp JOIN pipelines p ON p.id = pp.pipeline_id
      WHERE pp.organization_id = $1`, [organizationId]);
  await client.query(
    'DELETE FROM pipeline_purposes WHERE pipeline_id = $1 AND NOT (purpose = ANY($2::text[]))',
    [pipelineId, purposes]);
  for (const purpose of purposes) {
    await client.query(
      `INSERT INTO pipeline_purposes (organization_id, purpose, pipeline_id) VALUES ($1,$2,$3)
       ON CONFLICT (organization_id, purpose) DO UPDATE SET pipeline_id = EXCLUDED.pipeline_id`,
      [organizationId, purpose, pipelineId]);
  }
  return before.filter((b) => purposes.includes(b.purpose as PurposeKey) && b.pipeline_id !== pipelineId)
    .map((b) => `${purposeLabel(b.purpose)} moved here from ${b.name}`);
}

async function assertNameFree(client: pg.PoolClient, organizationId: string, name: string, exceptId?: string) {
  const { rows } = await client.query(
    `SELECT 1 FROM pipelines WHERE organization_id = $1 AND lower(btrim(name)) = lower(btrim($2))
        AND archived_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`,
    [organizationId, name, exceptId ?? null]);
  if (rows.length) throw fieldError('name', `There is already a pipeline called “${name}”.`);
}

export async function createPipeline(actor: Actor, raw: unknown): Promise<{ pipeline: PipelineRecord; notices: string[] }> {
  const input = PipelineInput.parse(raw);
  const { id, notices } = await withTransaction(async (client) => {
    await assertNameFree(client, actor.organizationId, input.name);
    const { rows: keys } = await client.query<{ key: string }>(
      'SELECT key FROM pipelines WHERE organization_id = $1', [actor.organizationId]);
    const key = uniqueKey(slugKey(input.name, 30), new Set(keys.map((k) => k.key)), 40);

    if (input.is_default) {
      await client.query('UPDATE pipelines SET is_default = false WHERE organization_id = $1 AND is_default',
                         [actor.organizationId]);
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO pipelines (organization_id, key, name, description, colour, is_default, active, position,
                              created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               (SELECT COALESCE(max(position),0)+1 FROM pipelines WHERE organization_id = $1), $8, $8)
       RETURNING id`,
      [actor.organizationId, key, input.name, input.description ?? null, input.colour ?? null,
       input.is_default ?? false, input.is_default ? true : input.active ?? true, actor.userId]);
    const pipelineId = rows[0]!.id;

    // Its stages: a copy of another pipeline's, or a starter set.
    let template: Array<{ label: string; category: StageCategory; probability: number | null; colour: string | null;
                          entry_rules: Record<string, unknown>; description?: string | null; active?: boolean }> = STARTER_STAGES;
    if (input.copy_from) {
      const { rows: copied } = await client.query<{
        label: string; category: StageCategory; probability: number | null; colour: string | null;
        entry_rules: Record<string, unknown>; description: string | null; active: boolean;
      }>(
        `SELECT s.label, s.category, s.probability::float AS probability, s.colour, s.entry_rules, s.description, s.active
           FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
          WHERE p.id = $1 AND p.organization_id = $2 AND s.archived_at IS NULL ORDER BY s.position`,
        [input.copy_from, actor.organizationId]);
      if (!copied.length) throw fieldError('copy_from', 'That pipeline has no stages to copy.');
      template = copied;
    }
    const taken = await takenStageKeys(client, actor.organizationId);
    for (const [i, s] of template.entries()) {
      const stageKey = uniqueKey(`${key}_${slugKey(s.label, 30)}`, taken);
      taken.add(stageKey);
      await client.query(
        `INSERT INTO pipeline_stages (organization_id, pipeline_id, key, label, description, position, category,
                                      probability, colour, entry_rules, active, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12)`,
        [actor.organizationId, pipelineId, stageKey, s.label, s.description ?? null, (i + 1) * 10, s.category,
         s.probability, s.colour, JSON.stringify(s.entry_rules ?? {}), s.active ?? true, actor.userId]);
    }

    await applyAppointmentDefaults(client, pipelineId, input.copy_from ?? null);

    const notices = input.purposes?.length
      ? await claimPurposes(client, actor.organizationId, pipelineId, input.purposes) : [];

    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'pipeline.create',
      entityType: 'pipeline',
      entityId: pipelineId,
      summary: `Pipeline “${input.name}” created with ${template.length} stages` +
        (input.copy_from ? ' (copied)' : ''),
      after: { ...input, key },
    }, client);
    return { id: pipelineId, notices };
  });
  return { pipeline: await getPipeline(actor.organizationId, id), notices };
}

async function lockPipeline(client: pg.PoolClient, organizationId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound('That pipeline');
  const { rows } = await client.query<{ id: string; key: string; name: string; is_default: boolean; active: boolean }>(
    `SELECT id, key, name, is_default, active FROM pipelines
      WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL FOR UPDATE`, [id, organizationId]);
  if (!rows[0]) throw notFound('That pipeline');
  return rows[0];
}

async function stagesOf(client: pg.PoolClient, pipelineId: string) {
  return (await client.query<{ id: string; key: string; label: string; category: StageCategory; active: boolean; position: number }>(
    `SELECT id, key, label, category, active, position FROM pipeline_stages
      WHERE pipeline_id = $1 AND archived_at IS NULL ORDER BY position, label`, [pipelineId])).rows;
}

export async function updatePipeline(actor: Actor, id: string, raw: unknown): Promise<{ pipeline: PipelineRecord; notices: string[] }> {
  const input = PipelineUpdate.parse(raw);
  const notices = await withTransaction(async (client) => {
    const before = await lockPipeline(client, actor.organizationId, id);
    const willBeActive = input.active ?? before.active;
    const willBeDefault = input.is_default ?? before.is_default;

    if (input.name !== undefined) await assertNameFree(client, actor.organizationId, input.name, id);
    if (before.is_default && input.is_default === false) {
      throw new AppError('There always has to be a default pipeline. Make another pipeline the default instead.',
                         409, 'default_required');
    }
    if (willBeDefault && !willBeActive) {
      throw new AppError(`“${before.name}” is the default pipeline, where unmatched files go, so it cannot be inactive. ` +
                         'Make another pipeline the default first.', 409, 'default_inactive');
    }
    if (willBeActive && !before.active) {
      const problems = pipelineProblems(await stagesOf(client, id), before.name);
      if (problems.length) throw new AppError(problems[0]!, 409, 'pipeline_incomplete', problems);
    }
    if (input.is_default && !before.is_default) {
      await client.query('UPDATE pipelines SET is_default = false WHERE organization_id = $1 AND is_default',
                         [actor.organizationId]);
    }

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    for (const column of ['name', 'description', 'colour', 'is_default', 'active'] as const) {
      if (input[column] !== undefined) set(column, input[column]);
    }
    if (input.appointment_stages) {
      const own = await stagesOf(client, id);
      for (const [field, value] of Object.entries(input.appointment_stages)) {
        if (value === undefined) continue;
        if (value !== null) {
          const stage = own.find((s) => s.key === value);
          if (!stage) throw fieldError(`appointment_stages.${field}`, 'Choose a stage in this pipeline.');
          if (!stage.active) throw fieldError(`appointment_stages.${field}`, `“${stage.label}” is inactive. Choose an active stage.`);
        }
        set(`appointment_${field}_stage_key`, value);
      }
    }
    set('updated_by', actor.userId);
    await client.query(`UPDATE pipelines SET ${sets.join(', ')} WHERE id = $1`, params);

    const moved = input.purposes !== undefined
      ? await claimPurposes(client, actor.organizationId, id, input.purposes) : [];

    const parts = [];
    if (input.active !== undefined && input.active !== before.active) parts.push(input.active ? 'activated' : 'deactivated');
    if (input.is_default && !before.is_default) parts.push('made the default');
    if (input.purposes !== undefined) parts.push('purposes changed');
    if (input.appointment_stages) parts.push('appointment stages changed');
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'pipeline.update',
      entityType: 'pipeline',
      entityId: id,
      summary: `Pipeline “${input.name ?? before.name}” updated${parts.length ? ` — ${parts.join(', ')}` : ''}`,
      before,
      after: input,
    }, client);
    return moved;
  });
  return { pipeline: await getPipeline(actor.organizationId, id), notices };
}

/**
 * Move every file on one stage to another, recording the move on each.
 * Used when a stage or pipeline is deleted. Deliberately does not fire the
 * automations a stage change normally starts: an admin tidying the pipeline
 * is not a reason to email forty clients.
 */
async function moveFiles(
  client: pg.PoolClient, actor: Actor, fromKey: string, toKey: string, reason: string,
): Promise<number> {
  const { rows: to } = await client.query<{ pipeline_id: string }>(
    'SELECT pipeline_id FROM pipeline_stages WHERE organization_id = $1 AND key = $2', [actor.organizationId, toKey]);
  const { rows } = await client.query<{ id: string }>(
    `WITH moving AS (
       SELECT id, stage_changed_at, pipeline_id FROM applications
        WHERE organization_id = $1 AND stage_key = $2 AND archived_at IS NULL FOR UPDATE
     ), moved AS (
       UPDATE applications a SET stage_key = $3, stage_changed_at = now(), last_activity_at = now()
         FROM moving WHERE a.id = moving.id RETURNING a.id
     ), history AS (
       INSERT INTO stage_transitions (application_id, from_stage_key, to_stage_key, from_pipeline_id,
                                      to_pipeline_id, actor_user_id, actor_kind, reason, seconds_in_from_stage)
       SELECT moving.id, $2, $3, moving.pipeline_id, $4, $5, $6, $7,
              EXTRACT(EPOCH FROM now() - moving.stage_changed_at)::bigint
         FROM moving
     ), log AS (
       INSERT INTO activity (organization_id, application_id, customer_id, kind, actor_user_id,
                             actor_name, actor_kind, summary)
       SELECT $1, a.id, a.customer_id, 'stage', $5, $8, $6, $7 FROM applications a JOIN moving ON moving.id = a.id
     )
     SELECT id FROM moved`,
    [actor.organizationId, fromKey, toKey, to[0]?.pipeline_id ?? null, actor.userId,
     actor.kind, reason, actor.name]);
  return rows.length;
}

const DeletePipelineInput = z.object({
  /** For each stage with files, the stage (in another pipeline) they go to. */
  stage_map: z.record(z.string(), z.string()).optional(),
}).strict();

export async function deletePipeline(actor: Actor, id: string, raw: unknown) {
  const { stage_map = {} } = DeletePipelineInput.parse(raw ?? {});
  return withTransaction(async (client) => {
    const pipeline = await lockPipeline(client, actor.organizationId, id);
    if (pipeline.is_default) {
      throw new AppError(`“${pipeline.name}” is the default pipeline. Make another pipeline the default before deleting it.`,
                         409, 'default_required');
    }
    const stages = await stagesOf(client, id);
    const { rows: occupied } = await client.query<{ stage_key: string; files: number }>(
      `SELECT stage_key, count(*)::int AS files FROM applications
        WHERE organization_id = $1 AND pipeline_id = $2 AND archived_at IS NULL GROUP BY stage_key`,
      [actor.organizationId, id]);

    // Every occupied stage must be given somewhere to go, in another pipeline.
    const { rows: targets } = await client.query<{ key: string; pipeline_id: string; active: boolean }>(
      `SELECT s.key, s.pipeline_id, s.active AND p.active AS active FROM pipeline_stages s
         JOIN pipelines p ON p.id = s.pipeline_id
        WHERE s.organization_id = $1 AND s.archived_at IS NULL AND p.archived_at IS NULL`,
      [actor.organizationId]);
    for (const o of occupied) {
      const label = stages.find((s) => s.key === o.stage_key)?.label ?? o.stage_key;
      const to = targets.find((t) => t.key === stage_map[o.stage_key]);
      if (!to || to.pipeline_id === id || !to.active) {
        throw fieldError(`stage_map.${o.stage_key}`,
          `Choose an active stage in another pipeline for the ${o.files} file(s) on “${label}”.`);
      }
    }

    let moved = 0;
    for (const o of occupied) {
      moved += await moveFiles(client, actor, o.stage_key, stage_map[o.stage_key]!,
                               `Pipeline “${pipeline.name}” was deleted`);
    }
    await client.query(
      `UPDATE pipeline_stages SET archived_at = now(), archived_by = $2, active = false
        WHERE pipeline_id = $1 AND archived_at IS NULL`, [id, actor.userId]);
    await client.query(
      `UPDATE pipelines SET archived_at = now(), archived_by = $2, active = false, is_default = false WHERE id = $1`,
      [id, actor.userId]);
    const { rows: freed } = await client.query<{ purpose: string }>(
      'DELETE FROM pipeline_purposes WHERE pipeline_id = $1 RETURNING purpose', [id]);
    const refs = await referencing(client, actor.organizationId, stages.map((s) => s.key), [pipeline.key]);

    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'pipeline.delete',
      entityType: 'pipeline',
      entityId: id,
      summary: `Pipeline “${pipeline.name}” deleted${moved ? `; ${moved} file(s) moved` : ''}`,
      before: pipeline,
      after: { stage_map, moved },
    }, client);
    return {
      moved,
      purposes_now_default: freed.map((f) => purposeLabel(f.purpose)),
      still_referenced_by: refs,
    };
  });
}

// ── Stages: writing ────────────────────────────────────────────────────────

const ENTRY_RULE_KEYS = ['minPercentComplete', 'requireAppointment', 'requireScarlettDeal',
  'requireLostDisposition', 'requireFundingConfirmed', 'requireComplianceComplete',
  'blockedOnceScarlettPushed', 'requireFields'] as const;

const EntryRules = z.object({
  minPercentComplete: z.number().int().min(0).max(100).optional(),
  requireAppointment: z.boolean().optional(),
  requireScarlettDeal: z.boolean().optional(),
  requireLostDisposition: z.boolean().optional(),
  requireFundingConfirmed: z.boolean().optional(),
  requireComplianceComplete: z.boolean().optional(),
  blockedOnceScarlettPushed: z.boolean().optional(),
  requireFields: z.array(z.object({ field: z.string(), label: z.string() })).optional(),
}).strict();

const StageFields = {
  label: z.string({ required_error: 'Name the stage.' }).trim()
    .min(2, 'Name the stage — at least 2 characters.').max(60, 'At most 60 characters.'),
  description: z.string().trim().max(500).optional().transform((v) => (v === undefined ? undefined : v || null)),
  category: z.enum(['open', 'parked', 'won', 'lost'], { errorMap: () => ({ message: 'Choose what the stage means.' }) }),
  probability: z.number().min(0, 'Between 0 and 100.').max(100, 'Between 0 and 100.').nullable(),
  colour,
  entry_rules: EntryRules,
  active: z.boolean(),
};

export const StageInput = z.object({
  ...StageFields,
  probability: StageFields.probability.optional(),
  entry_rules: StageFields.entry_rules.default({}),
  active: StageFields.active.default(true),
}).strict();
const StageUpdate = z.object(StageFields).partial().strict();

async function findStage(organizationId: string, stageId: string) {
  if (!z.string().uuid().safeParse(stageId).success) throw notFound('That stage');
  const all = await pipelineCatalogue(pool, organizationId);
  for (const pipeline of all) {
    const stage = pipeline.stages.find((s) => s.id === stageId);
    if (stage) return { pipeline, stage };
  }
  throw notFound('That stage');
}

async function lockStage(client: pg.PoolClient, organizationId: string, stageId: string) {
  if (!z.string().uuid().safeParse(stageId).success) throw notFound('That stage');
  const { rows } = await client.query<{
    id: string; key: string; label: string; category: StageCategory; active: boolean; position: number;
    pipeline_id: string; pipeline_name: string; pipeline_active: boolean; pipeline_key: string;
  }>(
    `SELECT s.id, s.key, s.label, s.category, s.active, s.position, s.pipeline_id,
            p.name AS pipeline_name, p.active AS pipeline_active, p.key AS pipeline_key
       FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
      WHERE s.id = $1 AND s.organization_id = $2 AND s.archived_at IS NULL AND p.archived_at IS NULL
      FOR UPDATE OF s`,
    [stageId, organizationId]);
  if (!rows[0]) throw notFound('That stage');
  return rows[0];
}

async function assertStageLabelFree(client: pg.PoolClient, pipelineId: string, label: string, exceptId?: string) {
  const { rows } = await client.query(
    `SELECT 1 FROM pipeline_stages WHERE pipeline_id = $1 AND lower(btrim(label)) = lower(btrim($2))
        AND archived_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`, [pipelineId, label, exceptId ?? null]);
  if (rows.length) throw fieldError('label', `This pipeline already has a stage called “${label}”.`);
}

/** Renumber a pipeline's stages 10, 20, 30… in the order given. */
async function renumber(client: pg.PoolClient, ids: string[]) {
  await client.query(
    `UPDATE pipeline_stages s SET position = o.n * 10
       FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, n) WHERE s.id = o.id`, [ids]);
}

export async function createStage(actor: Actor, pipelineId: string, raw: unknown): Promise<StageRecord> {
  const input = StageInput.parse(raw);
  const stageId = await withTransaction(async (client) => {
    const pipeline = await lockPipeline(client, actor.organizationId, pipelineId);
    await assertStageLabelFree(client, pipelineId, input.label);
    const taken = await takenStageKeys(client, actor.organizationId);
    const key = uniqueKey(pipeline.key === 'main' ? slugKey(input.label, 40) : `${pipeline.key}_${slugKey(input.label, 30)}`, taken);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO pipeline_stages (organization_id, pipeline_id, key, label, description, position, category,
                                    probability, colour, entry_rules, active, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9::jsonb,$10,$11,$11) RETURNING id`,
      [actor.organizationId, pipelineId, key, input.label, input.description ?? null, input.category,
       input.probability ?? null, input.colour ?? null, JSON.stringify(input.entry_rules), input.active, actor.userId]);
    // An in-progress or on-hold stage goes before the closing ones, where it
    // belongs on a board; a won or lost stage goes at the end.
    const existing = await stagesOf(client, pipelineId);
    const others = existing.filter((s) => s.id !== rows[0]!.id);
    const firstClosing = others.findIndex((s) => s.category === 'won' || s.category === 'lost');
    const at = input.category === 'open' || input.category === 'parked'
      ? (firstClosing === -1 ? others.length : firstClosing) : others.length;
    const order = [...others.slice(0, at).map((s) => s.id), rows[0]!.id, ...others.slice(at).map((s) => s.id)];
    await renumber(client, order);
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'pipeline.stage_create',
      entityType: 'pipeline_stage',
      entityId: rows[0]!.id,
      summary: `Stage “${input.label}” added to ${pipeline.name}`,
      after: { ...input, key },
    }, client);
    return rows[0]!.id;
  });
  return (await findStage(actor.organizationId, stageId)).stage;
}

export async function updateStage(actor: Actor, stageId: string, raw: unknown): Promise<StageRecord> {
  const input = StageUpdate.parse(raw);
  await withTransaction(async (client) => {
    const stage = await lockStage(client, actor.organizationId, stageId);
    if (input.label !== undefined) await assertStageLabelFree(client, stage.pipeline_id, input.label, stageId);

    // Would the pipeline still be usable afterwards?
    if (stage.pipeline_active && (input.active !== undefined || input.category !== undefined)) {
      const after = (await stagesOf(client, stage.pipeline_id)).map((s) => s.id === stageId
        ? { ...s, active: input.active ?? s.active, category: input.category ?? s.category } : s);
      const problems = pipelineProblems(after, stage.pipeline_name);
      if (problems.length) throw new AppError(problems[0]!, 409, 'pipeline_incomplete', problems);
    }

    const sets: string[] = [];
    const params: unknown[] = [stageId];
    const set = (column: string, value: unknown, cast = '') => { params.push(value); sets.push(`${column} = $${params.length}${cast}`); };
    for (const column of ['label', 'description', 'category', 'probability', 'colour', 'active'] as const) {
      if (input[column] !== undefined) set(column, input[column]);
    }
    if (input.entry_rules !== undefined) set('entry_rules', JSON.stringify(input.entry_rules), '::jsonb');
    set('updated_by', actor.userId);
    await client.query(`UPDATE pipeline_stages SET ${sets.join(', ')} WHERE id = $1`, params);

    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'pipeline.stage_update',
      entityType: 'pipeline_stage',
      entityId: stageId,
      summary: `Stage “${input.label ?? stage.label}” in ${stage.pipeline_name} updated` +
        (input.active !== undefined && input.active !== stage.active ? ` — ${input.active ? 'activated' : 'deactivated'}` : ''),
      before: stage,
      after: input,
    }, client);
  });
  return (await findStage(actor.organizationId, stageId)).stage;
}

export async function moveStage(actor: Actor, stageId: string, raw: unknown): Promise<void> {
  const { direction } = z.object({ direction: z.enum(['up', 'down']) }).strict().parse(raw);
  await withTransaction(async (client) => {
    const stage = await lockStage(client, actor.organizationId, stageId);
    const ids = (await stagesOf(client, stage.pipeline_id)).map((s) => s.id);
    const at = ids.indexOf(stageId);
    const swap = direction === 'up' ? at - 1 : at + 1;
    if (swap < 0 || swap >= ids.length) {
      throw new AppError(`It is already ${direction === 'up' ? 'first' : 'last'}.`, 409, 'cannot_move');
    }
    [ids[at], ids[swap]] = [ids[swap]!, ids[at]!];
    await renumber(client, ids);
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'pipeline.stage_reorder',
      entityType: 'pipeline_stage',
      entityId: stageId,
      summary: `Stage “${stage.label}” moved ${direction} in ${stage.pipeline_name}`,
    }, client);
  });
}

const DeleteStageInput = z.object({
  /** Where the files on this stage go. Required when it has any. */
  move_to: z.string().optional(),
}).strict();

export async function deleteStage(actor: Actor, stageId: string, raw: unknown) {
  const { move_to } = DeleteStageInput.parse(raw ?? {});
  return withTransaction(async (client) => {
    const stage = await lockStage(client, actor.organizationId, stageId);
    const remaining = (await stagesOf(client, stage.pipeline_id)).filter((s) => s.id !== stageId);
    if (stage.pipeline_active) {
      const problems = pipelineProblems(remaining, stage.pipeline_name);
      if (problems.length) throw new AppError(problems[0]!, 409, 'pipeline_incomplete', problems);
    }
    const { rows: count } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM applications
        WHERE organization_id = $1 AND stage_key = $2 AND archived_at IS NULL`, [actor.organizationId, stage.key]);
    const files = count[0]!.n;
    let moved = 0;
    if (files > 0) {
      const { rows: target } = await client.query<{ active: boolean }>(
        `SELECT s.active AND p.active AS active FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
          WHERE s.organization_id = $1 AND s.key = $2 AND s.archived_at IS NULL AND p.archived_at IS NULL`,
        [actor.organizationId, move_to ?? '']);
      if (!move_to || move_to === stage.key || !target[0]?.active) {
        throw fieldError('move_to', `Choose an active stage for the ${files} file(s) on “${stage.label}”.`);
      }
      moved = await moveFiles(client, actor, stage.key, move_to, `Stage “${stage.label}” was deleted`);
    }
    await client.query(
      `UPDATE pipeline_stages SET archived_at = now(), archived_by = $2, active = false WHERE id = $1`,
      [stageId, actor.userId]);
    // An appointment setting that named this stage follows the files, when
    // they went somewhere in the same pipeline; otherwise it stops moving.
    const followTo = move_to && remaining.some((s) => s.key === move_to) ? move_to : null;
    for (const field of ['booked', 'attended', 'missed']) {
      await client.query(
        `UPDATE pipelines SET appointment_${field}_stage_key = $3
          WHERE id = $1 AND appointment_${field}_stage_key = $2`, [stage.pipeline_id, stage.key, followTo]);
    }
    await renumber(client, remaining.map((s) => s.id));
    const refs = await referencing(client, actor.organizationId, [stage.key]);
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'pipeline.stage_delete',
      entityType: 'pipeline_stage',
      entityId: stageId,
      summary: `Stage “${stage.label}” deleted from ${stage.pipeline_name}${moved ? `; ${moved} file(s) moved` : ''}`,
      before: stage,
      after: { move_to: move_to ?? null, moved },
    }, client);
    return { moved, still_referenced_by: refs };
  });
}

export const ENTRY_RULE_FIELDS = ENTRY_RULE_KEYS;
