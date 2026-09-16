/**
 * Pipelines, against a real database.
 *
 * What these protect: a new file always lands somewhere sensible; a pipeline
 * can never be left with nowhere to start, win or lose; and nothing in use is
 * deleted out from under the files on it.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import {
  createPipeline, createStage, deletePipeline, deleteStage, entryStage, moveStage, pipelineCatalogue,
  pipelineUsage, stageUsage, updatePipeline, updateStage,
} from '../../src/services/pipelines.ts';
import { moveFileToStage } from '../../src/services/stage-moves.ts';
import { importMirrorPayload } from '../../src/services/portal-import.ts';
import { createLead } from '../../src/services/leads.ts';
import { createApiKey } from '../../src/services/api-keys.ts';
import type { Actor } from '../../src/services/staff.ts';

const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;
let orgId: string;
let admin: Actor;
let mainId: string;

before(async () => {
  await migrate();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/crm/api`;
});
after(async () => { server.close(); await pool.end(); });

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Lendmax','ON') RETURNING id`)).rows[0]!.id;
  const adminId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete)
     VALUES ($1,'admin@example.com','Alex Admin','technical_admin',true,now(),true) RETURNING id`,
    [orgId])).rows[0]!.id;
  admin = { organizationId: orgId, kind: 'user', userId: adminId, name: 'Alex Admin', role: 'technical_admin' };
  // Inserted the way every existing path inserts stages — without naming a
  // pipeline — so this also proves they land in the default one.
  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
     VALUES ($1,'lead','Lead',1,'open',true), ($1,'application','Application',2,'open',true),
            ($1,'funded','Funded',8,'won',true), ($1,'lost','Lost',9,'lost',true)`, [orgId]);
  mainId = (await queryOne<{ id: string }>('SELECT id FROM pipelines WHERE organization_id = $1', [orgId]))!.id;
});

async function file(stageKey: string | null, name = 'Client') {
  const c = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name, email) VALUES ($1,$2,'X',$3) RETURNING id`,
    [orgId, name, `${name.toLowerCase()}${Math.random().toString(36).slice(2, 6)}@example.com`])).rows[0]!.id;
  return (await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, stage_key) VALUES ($1,$2,$3) RETURNING id`,
    [orgId, c, stageKey])).rows[0]!.id;
}
const pipelineOf = async (appId: string) =>
  (await queryOne<{ pipeline_id: string; stage_key: string }>(
    'SELECT pipeline_id, stage_key FROM applications WHERE id = $1', [appId]))!;

const fieldsOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (err) {
    if (err instanceof ZodError) return err.issues.map((i) => i.path.join('.'));
    throw err;
  }
  throw new Error('expected a validation error');
};

// ── Staying in step ────────────────────────────────────────────────────────

test('an organisation with stages but no pipeline gets a default one, and files follow their stage', async () => {
  const main = await queryOne<{ is_default: boolean; name: string }>('SELECT is_default, name FROM pipelines WHERE id = $1', [mainId]);
  assert.deepEqual(main, { is_default: true, name: 'Mortgage pipeline' });

  const { pipeline: renewals } = await createPipeline(admin, { name: 'Renewals' });
  const id = await file('lead');
  assert.equal((await pipelineOf(id)).pipeline_id, mainId);
  await query(`UPDATE applications SET stage_key = 'renewals_new' WHERE id = $1`, [id]);
  assert.equal((await pipelineOf(id)).pipeline_id, renewals.id, 'a file’s pipeline is its stage’s pipeline');
  const none = await file(null);
  assert.equal((await pipelineOf(none)).pipeline_id, mainId, 'no stage: the default');
});

// ── Pipelines ──────────────────────────────────────────────────────────────

test('a new pipeline starts with usable stages, or a copy of another’s, under its own keys', async () => {
  const { pipeline: starter } = await createPipeline(admin, { name: 'Private lending' });
  assert.deepEqual(starter.stages.map((s) => s.key),
    ['private_lending_new', 'private_lending_in_progress', 'private_lending_funded', 'private_lending_lost']);
  assert.deepEqual(starter.problems, []);

  const { pipeline: copy } = await createPipeline(admin, { name: 'Renewals', copy_from: mainId });
  assert.deepEqual(copy.stages.map((s) => s.label), ['Lead', 'Application', 'Funded', 'Lost']);
  assert.ok(copy.stages.every((s) => s.key.startsWith('renewals_')));

  assert.deepEqual(await fieldsOf(createPipeline(admin, { name: 'RENEWALS' })), ['name']);
});

test('a purpose goes to one pipeline; claiming it moves it and says so', async () => {
  const { pipeline: a } = await createPipeline(admin, { name: 'Renewals', purposes: ['renew'] });
  const { pipeline: b, notices } = await createPipeline(admin, { name: 'Renewals 2', purposes: ['renew', 'refinance'] });
  assert.deepEqual(notices, ['Renew moved here from Renewals']);
  const all = await pipelineCatalogue(pool, orgId);
  assert.deepEqual(all.find((p) => p.id === a.id)!.purposes, []);
  assert.deepEqual(all.find((p) => p.id === b.id)!.purposes, ['renew', 'refinance']);
});

test('a new file enters the pipeline for its purpose, on its first in-progress stage', async () => {
  const { pipeline } = await createPipeline(admin, { name: 'Renewals', purposes: ['renew'] });
  assert.deepEqual(await entryStage(pool, orgId, 'Renew'), { pipelineId: pipeline.id, stageKey: 'renewals_new' });
  assert.deepEqual(await entryStage(pool, orgId, 'Purchase'), { pipelineId: mainId, stageKey: 'lead' });
  assert.deepEqual(await entryStage(pool, orgId, null), { pipelineId: mainId, stageKey: 'lead' });

  await updatePipeline(admin, pipeline.id, { active: false });
  assert.equal((await entryStage(pool, orgId, 'Renew')).pipelineId, mainId, 'an inactive pipeline takes nothing new');
});

test('portal applications and new leads are routed by purpose', async () => {
  await query(
    `INSERT INTO transaction_types (organization_id, key, label, position, portal_purpose)
     VALUES ($1,'renewal','Renewal',1,'Renew')`, [orgId]);
  const { pipeline } = await createPipeline(admin, { name: 'Renewals', purposes: ['renew'] });

  const imported = await importMirrorPayload({ reference: 'LMX-A-1', purpose: 'Renew', first_name: 'P', last_name: 'Q',
                                               email: 'pq@example.com', data: {} }, { organizationId: orgId });
  assert.equal((await pipelineOf(imported.id)).pipeline_id, pipeline.id);

  const options = { defaultAssign: 'auto' as const, mayAssignOthers: false, source: 'test' };
  const byPurpose = await createLead(admin, { first_name: 'A', last_name: 'B', email: 'ab@x.com', purpose: 'Home Equity Line' }, options);
  assert.equal((await pipelineOf(byPurpose.application_id)).pipeline_id, mainId, 'unclaimed purpose: default');
  const byType = await createLead(admin, { first_name: 'C', last_name: 'D', email: 'cd@x.com', transaction_type_key: 'renewal' }, options);
  assert.equal((await pipelineOf(byType.application_id)).pipeline_id, pipeline.id, 'the transaction type’s purpose');
  const purpose = await queryOne<{ purpose: string }>('SELECT purpose FROM applications WHERE id = $1', [byType.application_id]);
  assert.equal(purpose!.purpose, 'Renew', 'and the purpose is recorded on the file');
});

test('there is always exactly one default, and it is active', async () => {
  const { pipeline } = await createPipeline(admin, { name: 'Renewals' });
  await assert.rejects(updatePipeline(admin, mainId, { active: false }), /default pipeline/);
  await assert.rejects(updatePipeline(admin, mainId, { is_default: false }), /always has to be a default/);
  await updatePipeline(admin, pipeline.id, { is_default: true });
  const defaults = await query('SELECT id FROM pipelines WHERE organization_id = $1 AND is_default', [orgId]);
  assert.deepEqual(defaults.rows.map((r) => r.id), [pipeline.id]);
  await updatePipeline(admin, mainId, { active: false });
});

// ── Stages ─────────────────────────────────────────────────────────────────

test('a pipeline can never lose its only way to start, win or lose', async () => {
  const funded = await queryOne<{ id: string }>(`SELECT id FROM pipeline_stages WHERE key = 'funded'`);
  await assert.rejects(updateStage(admin, funded!.id, { active: false }), /“Won” stage/);
  await assert.rejects(updateStage(admin, funded!.id, { category: 'open' }), /“Won” stage/);
  await assert.rejects(deleteStage(admin, funded!.id, {}), /“Won” stage/);
  const lead = await queryOne<{ id: string }>(`SELECT id FROM pipeline_stages WHERE key = 'lead'`);
  await updateStage(admin, lead!.id, { active: false });
  const application = await queryOne<{ id: string }>(`SELECT id FROM pipeline_stages WHERE key = 'application'`);
  await assert.rejects(updateStage(admin, application!.id, { active: false }), /“In progress” stage/);
});

test('an in-progress stage is added before the closing ones; reordering moves one place', async () => {
  const s = await createStage(admin, mainId, { label: 'Underwriting', category: 'open', probability: 50 });
  assert.equal(s.key, 'underwriting');
  let order = (await pipelineCatalogue(pool, orgId))[0]!.stages.map((x) => x.label);
  assert.deepEqual(order, ['Lead', 'Application', 'Underwriting', 'Funded', 'Lost']);
  await moveStage(admin, s.id, { direction: 'up' });
  order = (await pipelineCatalogue(pool, orgId))[0]!.stages.map((x) => x.label);
  assert.deepEqual(order, ['Lead', 'Underwriting', 'Application', 'Funded', 'Lost']);
  assert.deepEqual(await fieldsOf(createStage(admin, mainId, { label: 'lead', category: 'open' })), ['label']);
});

test('a stage with files is deleted only by saying where they go', async () => {
  const s = await createStage(admin, mainId, { label: 'Underwriting', category: 'open' });
  const a = await file('underwriting');
  const b = await file('underwriting');
  assert.equal((await stageUsage(orgId, s.id)).files, 2);

  assert.deepEqual(await fieldsOf(deleteStage(admin, s.id, {})), ['move_to']);
  const result = await deleteStage(admin, s.id, { move_to: 'application' });
  assert.equal(result.moved, 2);
  for (const id of [a, b]) {
    assert.equal((await pipelineOf(id)).stage_key, 'application');
    const history = await queryOne<{ reason: string; from_stage_key: string }>(
      'SELECT reason, from_stage_key FROM stage_transitions WHERE application_id = $1', [id]);
    assert.deepEqual(history, { reason: 'Stage “Underwriting” was deleted', from_stage_key: 'underwriting' });
  }
  const archived = await queryOne<{ archived_at: Date | null }>('SELECT archived_at FROM pipeline_stages WHERE id = $1', [s.id]);
  assert.ok(archived!.archived_at, 'archived, so history still has a name for it');
  await createStage(admin, mainId, { label: 'Underwriting', category: 'open' });
});

test('a pipeline with files is deleted only with a destination for each stage, in another pipeline', async () => {
  const { pipeline } = await createPipeline(admin, { name: 'Renewals', purposes: ['renew'] });
  const a = await file('renewals_new');
  const b = await file('renewals_funded');
  await assert.rejects(deletePipeline(admin, mainId, {}), /default pipeline/);

  const missing = await fieldsOf(deletePipeline(admin, pipeline.id, { stage_map: { renewals_new: 'lead' } }));
  assert.deepEqual(missing, ['stage_map.renewals_funded']);
  const sameOne = await fieldsOf(deletePipeline(admin, pipeline.id,
    { stage_map: { renewals_new: 'renewals_in_progress', renewals_funded: 'funded' } }));
  assert.deepEqual(sameOne, ['stage_map.renewals_new'], 'not into itself');

  const result = await deletePipeline(admin, pipeline.id, { stage_map: { renewals_new: 'lead', renewals_funded: 'funded' } });
  assert.equal(result.moved, 2);
  assert.deepEqual(result.purposes_now_default, ['Renew']);
  assert.deepEqual([(await pipelineOf(a)).stage_key, (await pipelineOf(b)).stage_key], ['lead', 'funded']);
  assert.equal((await pipelineOf(a)).pipeline_id, mainId);
  assert.equal((await entryStage(pool, orgId, 'Renew')).pipelineId, mainId);
  assert.equal((await pipelineCatalogue(pool, orgId)).length, 1);
});

// ── What uses them ─────────────────────────────────────────────────────────

test('usage names the automations and campaigns that use a stage — and not those that merely say “lost”', async () => {
  const auto = async (name: string, definition: unknown) => {
    const id = (await query<{ id: string }>(
      `INSERT INTO automations (organization_id, key, name, status) VALUES ($1,$2,$3,'active') RETURNING id`,
      [orgId, name.toLowerCase().replace(/\W+/g, '_'), name])).rows[0]!.id;
    await query('INSERT INTO automation_versions (automation_id, version, definition) VALUES ($1,1,$2::jsonb)',
                [id, JSON.stringify(definition)]);
  };
  await auto('Moves to application', { trigger: { type: 'file.created', filters: [] },
                                       nodes: [{ key: 'a', type: 'set_stage', stage_key: 'application' }] });
  await auto('Only on application', { trigger: { type: 'stage.changed', filters: [{ field: 'stage_key', op: 'in', value: ['lead', 'application'] }] }, nodes: [] });
  await auto('Stops when lost', { trigger: { type: 'file.created', filters: [] },
                                  stop_conditions: [{ field: 'stage_category', op: 'eq', value: 'lost' }], nodes: [] });
  await query(`INSERT INTO campaigns (organization_id, name, segment) VALUES ($1,'Leads blast',$2::jsonb)`,
              [orgId, JSON.stringify({ criteria: [{ field: 'stage_key', op: 'eq', value: 'lead' }] })]);

  const application = await queryOne<{ id: string }>(`SELECT id FROM pipeline_stages WHERE key = 'application'`);
  const appUsage = await stageUsage(orgId, application!.id);
  assert.deepEqual(appUsage.automations.map((a) => a.name).sort(), ['Moves to application', 'Only on application']);

  const lost = await queryOne<{ id: string }>(`SELECT id FROM pipeline_stages WHERE key = 'lost'`);
  assert.deepEqual((await stageUsage(orgId, lost!.id)).automations, [], 'a stage category of "lost" is not the Lost stage');

  const lead = await queryOne<{ id: string }>(`SELECT id FROM pipeline_stages WHERE key = 'lead'`);
  assert.deepEqual((await stageUsage(orgId, lead!.id)).campaigns.map((c) => c.name), ['Leads blast']);
  assert.equal((await pipelineUsage(orgId, mainId)).automations.length, 2);
});

// ── Moving a file between pipelines ────────────────────────────────────────

test('a file moved to another pipeline records both, and fires its events once', async () => {
  const { pipeline } = await createPipeline(admin, { name: 'Renewals' });
  const id = await file('lead');
  const result = await moveFileToStage(admin, id, { stage_key: 'renewals_in_progress' }, { mayForce: false });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.pipeline_changed, true);
  assert.equal((await pipelineOf(id)).pipeline_id, pipeline.id);

  const history = await queryOne<{ from_pipeline_id: string; to_pipeline_id: string; reason: string }>(
    'SELECT from_pipeline_id, to_pipeline_id, reason FROM stage_transitions WHERE application_id = $1', [id]);
  assert.deepEqual(history, { from_pipeline_id: mainId, to_pipeline_id: pipeline.id, reason: 'Moved to the Renewals pipeline' });
  const events = await query<{ dedupe_key: string }>('SELECT dedupe_key FROM domain_events WHERE application_id = $1', [id]);
  assert.ok(events.rows.length >= 2 && events.rows.every((e) => e.dedupe_key.includes(':transition:')));
});

test('a file cannot be moved into an inactive pipeline, and entry rules still apply across pipelines', async () => {
  const { pipeline } = await createPipeline(admin, { name: 'Renewals' });
  const id = await file('lead');
  await updatePipeline(admin, pipeline.id, { active: false });
  await assert.rejects(moveFileToStage(admin, id, { stage_key: 'renewals_new' }, { mayForce: false }), /not an active pipeline/);
  await updatePipeline(admin, pipeline.id, { active: true });
  const blocked = await moveFileToStage(admin, id, { stage_key: 'renewals_funded' }, { mayForce: false });
  assert.equal(blocked.ok, false, 'Funded still needs confirmed funding');
});

// ── Over HTTP ──────────────────────────────────────────────────────────────

test('a website reads the pipelines and where a purpose goes, through the API', async () => {
  const { pipeline } = await createPipeline(admin, { name: 'Renewals', purposes: ['renew'] });
  const { key } = await createApiKey(admin, { name: 'apply.lendmax.ca', permissions: ['pipeline.view'] });
  const headers = { authorization: `Bearer ${key}` };
  const list = await (await fetch(`${base}/v1/pipelines`, { headers })).json() as { data: Array<{ name: string }> };
  assert.deepEqual(list.data.map((p) => p.name), ['Mortgage pipeline', 'Renewals']);
  const route = await (await fetch(`${base}/v1/pipelines/for-purpose?purpose=Renew`, { headers })).json() as
    { data: { pipeline: { id: string }; entry_stage_key: string } };
  assert.equal(route.data.pipeline.id, pipeline.id);
  assert.equal(route.data.entry_stage_key, 'renewals_new');
  const write = await fetch(`${base}/v1/pipelines`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
                                                     body: JSON.stringify({ name: 'Nope' }) });
  assert.equal(write.status, 403, 'view-only key');
});
