/**
 * The automation runtime, against a real database.
 *
 * Written after running the engine rather than before: the first end-to-end
 * run produced a perfectly clean "Task created" for a task with no assignee,
 * because the definition asked for an underwriter and the file only had a
 * broker. A queue of review tasks nobody can see is exactly the failure an
 * automation engine is supposed to prevent, so the fallback and these tests
 * exist together.
 *
 * The rest of it is the stop check, which is the reason the module is shaped
 * the way it is: a sequence that keeps chasing a client for documents they
 * have already sent is worse than no sequence at all.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import {
  enrol, gatherFacts, processEvents, runStep, sweepDueEnrollments,
} from '../../src/services/automation-engine.ts';
import { DefinitionSchema, type AutomationDefinition } from '../../src/domain/automation.ts';

let orgId: string;
let brokerId: string;
let customerId: string;
let applicationId: string;

before(async () => { await migrate(); });

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');

  const org = await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Test','ON') RETURNING id`);
  orgId = org.rows[0]!.id;

  const broker = await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active)
     VALUES ($1,'broker@example.com','Dana Broker','broker',true) RETURNING id`, [orgId]);
  brokerId = broker.rows[0]!.id;

  const customer = await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name, email)
     VALUES ($1,'Renee','Okafor','renee@example.com') RETURNING id`, [orgId]);
  customerId = customer.rows[0]!.id;

  const app = await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, property_province,
                               portal_reference, stage_key, documents_outstanding)
     VALUES ($1,$2,'ON','LMX-A-TEST-0001','application',3) RETURNING id`,
    [orgId, customerId]);
  applicationId = app.rows[0]!.id;

  await query(
    `INSERT INTO assignments (application_id, user_id, role, is_primary)
     VALUES ($1,$2,'broker',true)`, [applicationId, brokerId]);

  // The consent the send gate needs for a transactional message. Recorded the
  // way the importer records it, so the test exercises the real gate.
  await query(
    `INSERT INTO consents (organization_id, customer_id, channel, purpose, basis, granted, source)
     VALUES ($1,$2,'email','transactional','implied',true,'crm')`,
    [orgId, customerId]);
});

after(async () => { await pool.end(); });

/** Publish a definition and hand back what `enrol` wants. */
async function publish(
  key: string,
  definition: AutomationDefinition,
  options: { purpose?: string; allowReenrollment?: boolean; cooldownDays?: number } = {},
) {
  const a = await queryOne<{ id: string }>(
    `INSERT INTO automations (organization_id, key, name, status, published_version,
                              purpose, allow_reenrollment, reenrollment_cooldown_days)
     VALUES ($1,$2,$2,'active',1,$3,$4,$5) RETURNING id`,
    [orgId, key, options.purpose ?? 'transactional',
     options.allowReenrollment ?? false, options.cooldownDays ?? null]);
  await query(
    `INSERT INTO automation_versions (automation_id, version, definition, published_at)
     VALUES ($1,1,$2::jsonb, now())`, [a!.id, JSON.stringify(definition)]);
  return {
    id: a!.id, key, name: key, purpose: options.purpose ?? 'transactional',
    allow_reenrollment: options.allowReenrollment ?? false,
    reenrollment_cooldown_days: options.cooldownDays ?? null,
    version: 1, definition: DefinitionSchema.parse(definition),
  };
}

const confirmSequence = DefinitionSchema.parse({
  trigger: { type: 'application.submitted', filters: [] },
  entry_conditions: [],
  stop_conditions: [{ field: 'stage_category', op: 'eq', value: 'lost', reason: 'The file was lost' }],
  start_node: 'confirm',
  nodes: [
    { key: 'confirm', type: 'send_email', subject: 'We have your application',
      body: 'Hi {first_name},\nReference {portal_reference}.\nCall me at {user_cell}.',
      next: 'task' },
    { key: 'task', type: 'create_task', title: 'Review {first_name}’s application',
      category: 'application_review', priority: 'high', assign_to: 'underwriter', next: 'notify' },
    { key: 'notify', type: 'notify_user', role: 'broker',
      title: '{first_name} submitted', next: 'end' },
    { key: 'end', type: 'stop' },
  ],
});

/** Run the enrollment to a resting point, recording the nodes it passed. */
async function drain(enrollmentId: string, limit = 12): Promise<string[]> {
  const path: string[] = [];
  for (let i = 0; i < limit; i++) {
    const row = await queryOne<{ current_node_key: string | null; status: string }>(
      'SELECT current_node_key, status FROM automation_enrollments WHERE id = $1', [enrollmentId]);
    if (!row || row.status !== 'active') break;
    path.push(row.current_node_key ?? '(none)');
    const outcome = await runStep(enrollmentId);
    if (outcome.status !== 'advanced') break;
  }
  return path;
}

test('an event enrols the customer and the sequence runs to the end', async () => {
  await publish('confirm', confirmSequence);
  await query(
    `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id, dedupe_key)
     VALUES ($1,'application.submitted',$2,$3,'test-1')`, [orgId, customerId, applicationId]);

  const result = await processEvents(orgId);
  assert.equal(result.enrolled, 1);

  const enrollment = await queryOne<{ id: string; current_node_key: string }>(
    'SELECT id, current_node_key FROM automation_enrollments');
  assert.equal(enrollment!.current_node_key, 'confirm');

  assert.deepEqual(await drain(enrollment!.id), ['confirm', 'task', 'notify', 'end']);

  const final = await queryOne<{ status: string; messages_sent: number }>(
    'SELECT status, messages_sent FROM automation_enrollments WHERE id = $1', [enrollment!.id]);
  assert.equal(final!.status, 'completed');
  assert.equal(final!.messages_sent, 1);

  const { rows: executions } = await query('SELECT * FROM automation_executions');
  assert.equal(executions.length, 4, 'every node records what it did');
});

test('a line whose merge field has no value is dropped, not sent blank', async () => {
  await publish('confirm', confirmSequence);
  const automation = await queryOne<{ id: string }>('SELECT id FROM automations');
  assert.ok(automation);
  const enrollmentId = await enrol(
    { ...(await publishedRow()), id: automation.id } as never,
    orgId, customerId, applicationId, 'test');
  await drain(enrollmentId!);

  const message = await queryOne<{ body_text: string }>(
    'SELECT body_text FROM messages WHERE automation_run_id = $1', [enrollmentId]);
  assert.ok(message);
  assert.match(message.body_text, /Renee/);
  assert.match(message.body_text, /LMX-A-TEST-0001/);
  // The broker has no mobile number on file, so the line offering one goes.
  assert.doesNotMatch(message.body_text, /\{user_cell\}/);
  assert.doesNotMatch(message.body_text, /Call me at/);
});

test('a task for a role nobody holds goes to the broker, and says so', async () => {
  const automation = await publish('confirm', confirmSequence);
  const enrollmentId = await enrol(automation as never, orgId, customerId, applicationId, 'test');
  await drain(enrollmentId!);

  const assignee = await queryOne<{ name: string }>(
    `SELECT u.name FROM tasks t
       JOIN task_assignees ta ON ta.task_id = t.id
       JOIN users u ON u.id = ta.user_id
      WHERE t.source_kind = 'automation'`);
  assert.equal(assignee?.name, 'Dana Broker', 'the task reached a real person');

  const execution = await queryOne<{ reason: string }>(
    `SELECT reason FROM automation_executions WHERE node_key = 'task'`);
  assert.match(execution!.reason, /no underwriter is assigned/,
    'the fallback is recorded, because it is a staffing fact somebody should read');
});

test('nobody at all is a skipped step with a reason, not a silent success', async () => {
  await query('UPDATE assignments SET unassigned_at = now()');
  const automation = await publish('confirm', confirmSequence);
  const enrollmentId = await enrol(automation as never, orgId, customerId, applicationId, 'test');
  await drain(enrollmentId!);

  const execution = await queryOne<{ outcome: string; reason: string }>(
    `SELECT outcome, reason FROM automation_executions WHERE node_key = 'task'`);
  assert.equal(execution!.outcome, 'skipped');
  assert.match(execution!.reason, /Nobody holds that role/);

  const notification = await queryOne('SELECT 1 FROM notifications');
  assert.equal(notification, null, 'and nothing is notified into the void');
});

const documentChase = DefinitionSchema.parse({
  trigger: { type: 'document.requested', filters: [] },
  entry_conditions: [{ field: 'documents_outstanding', op: 'gt', value: 0 }],
  stop_conditions: [
    { field: 'documents_outstanding', op: 'lte', value: 0, reason: 'Everything requested has arrived' },
    { field: 'stage_category', op: 'in', value: ['won', 'lost'], reason: 'The file was resolved' },
  ],
  start_node: 'first',
  nodes: [
    { key: 'first', type: 'send_email', subject: 'Still needed',
      body: 'Hi {first_name}, we still need {documents_outstanding} document(s).', next: 'end' },
    { key: 'end', type: 'stop' },
  ],
});

test('the stop check runs before the step, so the chase ends the moment it should', async () => {
  const automation = await publish('chase', documentChase,
    { allowReenrollment: true, cooldownDays: 7 });
  const enrollmentId = await enrol(automation as never, orgId, customerId, applicationId, 'test');
  assert.ok(enrollmentId, 'enrolled while three documents are outstanding');

  // The documents arrive between the enrollment and the step.
  await query('UPDATE applications SET documents_outstanding = 0 WHERE id = $1', [applicationId]);
  const facts = await gatherFacts(pool, customerId, applicationId);
  assert.equal(Number(facts.documents_outstanding), 0);

  const outcome = await runStep(enrollmentId);
  assert.equal(outcome.status, 'stopped');
  assert.equal(outcome.reason, 'Everything requested has arrived');

  const sent = await queryOne<{ n: number }>(
    'SELECT count(*)::int AS n FROM messages WHERE automation_run_id = $1', [enrollmentId]);
  assert.equal(sent!.n, 0, 'and no reminder went out');

  const row = await queryOne<{ status: string; stopped_reason: string }>(
    'SELECT status, stopped_reason FROM automation_enrollments WHERE id = $1', [enrollmentId]);
  assert.equal(row!.status, 'stopped');
  assert.equal(row!.stopped_reason, 'Everything requested has arrived');
});

test('somebody already past the point of the sequence is never enrolled', async () => {
  await publish('chase', documentChase);
  await query('UPDATE applications SET documents_outstanding = 0 WHERE id = $1', [applicationId]);
  await query(
    `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id, dedupe_key)
     VALUES ($1,'document.requested',$2,$3,'test-2')`, [orgId, customerId, applicationId]);

  const result = await processEvents(orgId);
  assert.equal(result.processed, 1);
  assert.equal(result.enrolled, 0, 'the entry condition refused it');
});

test('re-enrolment is refused outright, and inside a cooldown', async () => {
  const once = await publish('once', confirmSequence);
  assert.ok(await enrol(once as never, orgId, customerId, applicationId, 'test'));
  assert.equal(await enrol(once as never, orgId, customerId, applicationId, 'test'), null);

  const cooling = await publish('cooling', documentChase,
    { allowReenrollment: true, cooldownDays: 7 });
  const first = await enrol(cooling as never, orgId, customerId, applicationId, 'test');
  assert.ok(first);
  await query(
    `UPDATE automation_enrollments SET status = 'stopped', stopped_at = now() WHERE id = $1`, [first]);
  assert.equal(await enrol(cooling as never, orgId, customerId, applicationId, 'test'), null,
    'a stopped enrollment inside the cooldown still blocks a new one');
});

test('an automation may not mark a file funded', async () => {
  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
     VALUES ($1,'funded','Funded',90,'won',true)`, [orgId]);
  const automation = await publish('forcer', DefinitionSchema.parse({
    trigger: { type: 'manual', filters: [] },
    entry_conditions: [], stop_conditions: [],
    start_node: 'force',
    nodes: [
      { key: 'force', type: 'set_stage', stage_key: 'funded', next: 'end' },
      { key: 'end', type: 'stop' },
    ],
  }));
  const enrollmentId = await enrol(automation as never, orgId, customerId, applicationId, 'test');
  await drain(enrollmentId!);

  const app = await queryOne<{ stage_key: string }>(
    'SELECT stage_key FROM applications WHERE id = $1', [applicationId]);
  assert.equal(app!.stage_key, 'application', 'the stage did not move');

  const execution = await queryOne<{ outcome: string; reason: string }>(
    `SELECT outcome, reason FROM automation_executions WHERE node_key = 'force'`);
  assert.equal(execution!.outcome, 'skipped');
  assert.match(execution!.reason, /may not mark a file funded/);
});

async function publishedRow() {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT a.id, a.key, a.name, a.purpose, a.allow_reenrollment, a.reenrollment_cooldown_days,
            v.version, v.definition
       FROM automations a JOIN automation_versions v
         ON v.automation_id = a.id AND v.version = a.published_version`);
  return { ...row, definition: DefinitionSchema.parse(row!.definition) };
}

test('a wait schedules the next step rather than running it', async () => {
  const automation = await publish('slow', DefinitionSchema.parse({
    trigger: { type: 'manual', filters: [] },
    entry_conditions: [], stop_conditions: [],
    start_node: 'hold',
    nodes: [
      { key: 'hold', type: 'wait', hours: 4, next: 'tag' },
      { key: 'tag', type: 'add_tag', tag: 'waited', next: 'end' },
      { key: 'end', type: 'stop' },
    ],
  }));
  const enrollmentId = await enrol(automation as never, orgId, customerId, applicationId, 'test');
  const outcome = await runStep(enrollmentId!);
  assert.equal(outcome.status, 'waiting');

  const row = await queryOne<{ current_node_key: string; next_run_at: string }>(
    'SELECT current_node_key, next_run_at FROM automation_enrollments WHERE id = $1', [enrollmentId]);
  assert.equal(row!.current_node_key, 'tag');
  const dueInHours = (new Date(row!.next_run_at).getTime() - Date.now()) / 3_600_000;
  assert.ok(dueInHours > 3.9 && dueInHours < 4.1, `due in ${dueInHours}h`);

  const customer = await queryOne<{ tags: string[] }>(
    'SELECT tags FROM customers WHERE id = $1', [customerId]);
  assert.ok(!customer!.tags?.includes('waited'), 'the step after the wait did not run early');
});

test('the sweeper recovers an enrollment whose job went missing', async () => {
  const automation = await publish('sweepable', DefinitionSchema.parse({
    trigger: { type: 'manual', filters: [] },
    entry_conditions: [], stop_conditions: [],
    start_node: 'tag',
    nodes: [
      { key: 'tag', type: 'add_tag', tag: 'swept', next: 'end' },
      { key: 'end', type: 'stop' },
    ],
  }));
  const enrollmentId = await enrol(automation as never, orgId, customerId, applicationId, 'test');

  // The job the enrollment was relying on is gone: dead-lettered after its
  // retries, or dropped by a worker that died mid-claim.
  await query(`DELETE FROM jobs WHERE kind = 'automation.step'`);
  assert.equal((await sweepDueEnrollments(orgId)).requeued, 1);

  const job = await queryOne<{ state: string; payload: { enrollmentId: string } }>(
    `SELECT state, payload FROM jobs WHERE kind = 'automation.step'`);
  assert.equal(job?.payload.enrollmentId, enrollmentId);

  // And an enrollment whose job is healthy is not queued a second time.
  assert.equal((await sweepDueEnrollments(orgId)).requeued, 0);
});

test('a future step is left alone by the sweeper', async () => {
  const automation = await publish('later', DefinitionSchema.parse({
    trigger: { type: 'manual', filters: [] },
    entry_conditions: [], stop_conditions: [],
    start_node: 'tag',
    nodes: [
      { key: 'tag', type: 'add_tag', tag: 'later', next: 'end' },
      { key: 'end', type: 'stop' },
    ],
  }));
  const enrollmentId = await enrol(automation as never, orgId, customerId, applicationId, 'test');
  await query(`DELETE FROM jobs WHERE kind = 'automation.step'`);
  await query(
    `UPDATE automation_enrollments SET next_run_at = now() + interval '3 days' WHERE id = $1`,
    [enrollmentId]);
  assert.equal((await sweepDueEnrollments(orgId)).requeued, 0);
});

test('two workers cannot advance one enrollment at the same time', async () => {
  // Found in a real automation log: the same wait step recorded twice, three
  // milliseconds apart, because a manual "run this now" landed alongside the
  // scheduled job.
  const automation = await publish('concurrent', DefinitionSchema.parse({
    trigger: { type: 'manual', filters: [] },
    entry_conditions: [], stop_conditions: [],
    start_node: 'note',
    nodes: [
      { key: 'note', type: 'add_note', body: 'Only once', next: 'end' },
      { key: 'end', type: 'stop' },
    ],
  }));
  const enrollmentId = await enrol(automation as never, orgId, customerId, applicationId, 'test');

  const [a, b] = await Promise.all([runStep(enrollmentId!), runStep(enrollmentId!)]);
  const outcomes = [a.status, b.status].sort();
  assert.deepEqual(outcomes, ['advanced', 'waiting'], `got ${JSON.stringify([a, b])}`);

  const notes = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM notes WHERE application_id = $1`, [applicationId]);
  assert.equal(notes!.n, 1, 'the note was written once, not twice');

  const executions = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM automation_executions
      WHERE enrollment_id = $1 AND node_key = 'note'`, [enrollmentId]);
  assert.equal(executions!.n, 1);
});

test('the claim is released even when a step throws', async () => {
  // A category the tasks table's CHECK constraint refuses, so the step fails
  // inside the database rather than by anything this test arranges.
  const automation = await publish('thrower', DefinitionSchema.parse({
    trigger: { type: 'manual', filters: [] },
    entry_conditions: [], stop_conditions: [],
    start_node: 'bad',
    nodes: [
      { key: 'bad', type: 'create_task', title: 'Doomed',
        category: 'not_a_real_category', assign_to: 'broker', next: 'end' },
      { key: 'end', type: 'stop' },
    ],
  }));
  const enrollmentId = await enrol(automation as never, orgId, customerId, applicationId, 'test');

  await assert.rejects(() => runStep(enrollmentId!), 'the step really did fail');

  const row = await queryOne<{ running_since: string | null; last_error: string }>(
    'SELECT running_since, last_error FROM automation_enrollments WHERE id = $1', [enrollmentId]);
  assert.equal(row!.running_since, null,
    'a claim left behind blocks the enrollment until the reclaim window expires');
  assert.ok(row!.last_error, 'and the failure is recorded where somebody will see it');

  // The next attempt is not locked out by the claim the failure left.
  await assert.rejects(() => runStep(enrollmentId!));
});
