/**
 * Tasks, against a real database: who may make work for whom, the file the
 * task sits on, the fifteen-minute reminder, and what the list shows.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { AppError } from '../../src/http/middleware/errors.ts';
import { createSession } from '../../src/services/auth.ts';
import { listActivity } from '../../src/services/activity.ts';
import { closeAll } from '../../src/services/realtime.ts';
import {
  assignableFiles, createTask, getTask, listTasks, previewOwner, runTaskReminders, taskMeta,
  updateTask, type Scope,
} from '../../src/services/tasks.ts';
import type { Actor } from '../../src/services/staff.ts';

const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;
let orgId: string;
let alex: Actor, dana: Actor, evan: Actor;
let adminScope: Scope, danaScope: Scope, evanScope: Scope;
let danaCookie: string;
let fileDana: string, fileEvan: string, unassigned: string;

const ZONE = 'America/Toronto';

before(async () => {
  await migrate();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/crm/api`;
});
after(async () => { closeAll(); server.close(); await pool.end(); });

const person = async (email: string, name: string, role: string): Promise<Actor> => {
  const id = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete, timezone)
     VALUES ($1,$2,$3,$4,true,now(),true,$5) RETURNING id`,
    [orgId, email, name, role, ZONE])).rows[0]!.id;
  return { organizationId: orgId, kind: 'user', userId: id, name, role };
};

const fileFor = async (owner: Actor | null, first: string) => {
  const customer = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name, email)
     VALUES ($1,$2,'Client',$3) RETURNING id`,
    [orgId, first, `${first.toLowerCase()}@example.com`])).rows[0]!.id;
  const id = (await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, stage_key) VALUES ($1,$2,'lead') RETURNING id`,
    [orgId, customer])).rows[0]!.id;
  if (owner) {
    await query(
      `INSERT INTO assignments (application_id, user_id, role, is_primary) VALUES ($1,$2,'broker',true)`,
      [id, owner.userId]);
  }
  return id;
};

const scopeOf = (a: Actor, over: Partial<Scope> = {}): Scope => ({
  actor: a, viewAll: false, manage: true, manageAll: false, timezone: ZONE, ...over,
});

/** Tomorrow, so nothing under test is accidentally in the past. */
const tomorrow = () => {
  const d = new Date(Date.now() + 86_400_000);
  return d.toISOString().slice(0, 10);
};

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province, timezone)
     VALUES ('Lendmax','ON',$1) RETURNING id`, [ZONE])).rows[0]!.id;
  alex = await person('alex@example.com', 'Alex Admin', 'technical_admin');
  dana = await person('dana@example.com', 'Dana Broker', 'broker');
  evan = await person('evan@example.com', 'Evan Broker', 'broker');
  adminScope = scopeOf(alex, { viewAll: true, manageAll: true });
  danaScope = scopeOf(dana);
  evanScope = scopeOf(evan);
  danaCookie = `lmx_crm_session=${(await createSession(dana.userId!, {})).token}`;
  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
     VALUES ($1,'lead','Lead',1,'open',true)`, [orgId]);
  fileDana = await fileFor(dana, 'Rena');
  fileEvan = await fileFor(evan, 'Marcus');
  unassigned = await fileFor(null, 'Nobody');
});

// ── Making work for yourself ───────────────────────────────────────────────

test('a broker writes themselves a task on their own client, at 4:30', async () => {
  const task = await createTask(danaScope, {
    title: 'Call the customer', description: 'Talk through the rate hold.',
    application_id: fileDana, due_on: tomorrow(), due_time: '16:30',
  });

  assert.equal(task.owner!.name, 'Dana Broker');
  assert.equal(task.client_name, 'Rena Client');
  assert.equal(task.application_id, fileDana);
  assert.equal(task.due_time, '16:30');
  assert.match(task.due_label!, /at 4:30 p\.m\./);
  assert.equal(task.reminder_minutes, 15, 'fifteen minutes before, without being asked');
  assert.equal(task.status, 'open');

  // The stamp the pipeline board reads is written by the same change.
  const stamp = await queryOne<{ next_task_at: Date | null }>(
    'SELECT next_task_at FROM applications WHERE id = $1', [fileDana]);
  assert.equal(stamp!.next_task_at?.toISOString(), task.due_at);
});

test('the client list is the broker’s own files, and only those', async () => {
  const mine = await assignableFiles(danaScope, {});
  assert.deepEqual(mine.map((f) => f.name), ['Rena Client']);

  // An admin sees every file, each carrying whose it is.
  const all = await assignableFiles(adminScope, {});
  assert.deepEqual(all.map((f) => f.name).sort(), ['Marcus Client', 'Nobody Client', 'Rena Client']);
  assert.equal(all.find((f) => f.name === 'Rena Client')!.owner!.name, 'Dana Broker');
  assert.equal(all.find((f) => f.name === 'Nobody Client')!.owner, null);
});

test('a broker cannot put a task on somebody else’s file', async () => {
  await assert.rejects(
    createTask(danaScope, { title: 'Nose in', application_id: fileEvan, due_on: tomorrow() }),
    (err: AppError) => err.status === 404,
    'a file they are not on is not theirs to see, let alone to add to',
  );
});

test('a task with no file is a note to yourself', async () => {
  const task = await createTask(danaScope, { title: 'Book the meeting room' });
  assert.equal(task.application_id, null);
  assert.equal(task.owner!.id, dana.userId);
  assert.equal(task.bucket, 'someday');
  assert.equal(task.reminder_minutes, null, 'nothing to be early for');
});

// ── An admin making work for somebody else ─────────────────────────────────

test('an admin picks a client and the task lands with whoever that client belongs to', async () => {
  // What the read-only field shows, asked before anything is written.
  const preview = await previewOwner(adminScope, fileDana);
  assert.equal(preview.owner.name, 'Dana Broker');
  assert.equal(preview.source, 'file');
  assert.match(preview.note!, /Dana Broker is assigned to this file/);

  const task = await createTask(adminScope, {
    title: 'Chase the income documents', application_id: fileDana,
    due_on: tomorrow(), due_time: '09:00', priority: 'high',
  });
  assert.equal(task.owner!.name, 'Dana Broker', 'not the admin who made it');
  assert.equal(task.created_by_name, 'Alex Admin');

  // It is on Dana's list, and Dana was told.
  const hers = await listTasks(danaScope, {});
  assert.deepEqual(hers.tasks.map((t) => t.title), ['Chase the income documents']);
  const bell = await queryOne<{ title: string; body: string }>(
    `SELECT title, body FROM notifications WHERE user_id = $1 AND kind = 'task'`, [dana.userId]);
  assert.equal(bell!.title, 'New task assigned to you');
  assert.match(bell!.body, /Alex Admin: Chase the income documents/);
});

test('a file nobody is assigned to leaves the task with the admin, and says so', async () => {
  const preview = await previewOwner(adminScope, unassigned);
  assert.equal(preview.owner.id, alex.userId);
  assert.match(preview.note!, /Nobody is assigned to this file/);

  const task = await createTask(adminScope, { title: 'Assign this file', application_id: unassigned });
  assert.equal(task.owner!.id, alex.userId);
});

test('a broker cannot make work for somebody else by choosing their client', async () => {
  // Dana has no manage_all, so even on a file she can see the task is hers.
  await query(
    `INSERT INTO assignments (application_id, user_id, role, is_primary) VALUES ($1,$2,'assistant',false)`,
    [fileEvan, dana.userId]);
  const task = await createTask(danaScope, { title: 'Help out', application_id: fileEvan });
  assert.equal(task.owner!.id, dana.userId, 'hers, not Evan’s');
});

// ── Seeing, and not seeing ─────────────────────────────────────────────────

test('a broker sees their own work; an admin sees everybody’s', async () => {
  await createTask(danaScope, { title: 'Dana’s own' });
  await createTask(evanScope, { title: 'Evan’s own' });
  await createTask(adminScope, { title: 'For Dana', application_id: fileDana });

  assert.deepEqual((await listTasks(danaScope, {})).tasks.map((t) => t.title).sort(),
    ['Dana’s own', 'For Dana']);
  assert.deepEqual((await listTasks(evanScope, {})).tasks.map((t) => t.title), ['Evan’s own']);
  assert.equal((await listTasks(adminScope, {})).total, 3);

  // And one broker cannot open another's.
  const evans = (await listTasks(evanScope, {})).tasks[0]!;
  await assert.rejects(getTask(danaScope, evans.id), (err: AppError) => err.status === 404);
});

test('somebody who makes work for others still sees what they made', async () => {
  // manage_all without view_all: they can put a task on Dana's list, and they
  // can still see the one they put there.
  const maker = scopeOf(alex, { manageAll: true, viewAll: false });
  const task = await createTask(maker, { title: 'Made by me', application_id: fileDana });
  assert.ok((await listTasks(maker, {})).tasks.some((t) => t.id === task.id));
  await createTask(danaScope, { title: 'Dana’s private note' });
  assert.equal((await listTasks(maker, {})).tasks.some((t) => t.title === 'Dana’s private note'), false);
});

test('the list buckets by the reader’s day, counts every tab, and pages', async () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await createTask(danaScope, { title: 'Late', application_id: fileDana, due_on: yesterday });
  await createTask(danaScope, { title: 'Today', due_on: new Date().toISOString().slice(0, 10) });
  await createTask(danaScope, { title: 'Someday' });
  const done = await createTask(danaScope, { title: 'Finished' });
  await updateTask(danaScope, done.id, { status: 'completed' });

  const open = await listTasks(danaScope, { tab: 'open' });
  assert.equal(open.total, 3);
  assert.deepEqual(open.tabs.open, 3);
  assert.deepEqual(open.tabs.completed, 1);
  assert.deepEqual(open.tabs.overdue, 1);

  assert.deepEqual((await listTasks(danaScope, { bucket: 'overdue' })).tasks.map((t) => t.title), ['Late']);
  assert.deepEqual((await listTasks(danaScope, { bucket: 'someday' })).tasks.map((t) => t.title), ['Someday']);
  assert.deepEqual((await listTasks(danaScope, { tab: 'completed' })).tasks.map((t) => t.title), ['Finished']);

  // Undated work sorts last, not first: a task with no date is not urgent.
  assert.deepEqual(open.tasks.map((t) => t.title), ['Late', 'Today', 'Someday']);

  const page = await listTasks(danaScope, { tab: 'open', page_size: 2, page: 2 });
  assert.equal(page.tasks.length, 1);
  assert.equal(page.total, 3);
});

test('search and filters narrow the same list', async () => {
  await createTask(danaScope, { title: 'Call Rena about the rate', application_id: fileDana, priority: 'urgent' });
  await createTask(danaScope, { title: 'File the paperwork', category: 'compliance' });

  assert.equal((await listTasks(danaScope, { q: 'rena' })).total, 1);
  assert.equal((await listTasks(danaScope, { q: 'Rena Client' })).total, 1, 'the client’s name counts too');
  assert.equal((await listTasks(danaScope, { priority: 'urgent' })).total, 1);
  assert.equal((await listTasks(danaScope, { category: 'compliance' })).total, 1);
  assert.equal((await listTasks(danaScope, { application_id: fileDana })).total, 1);
  assert.equal((await listTasks(danaScope, { owner: 'me' })).total, 2);
});

// ── Changing it ────────────────────────────────────────────────────────────

test('completing a task takes it off the file’s next-task stamp', async () => {
  const task = await createTask(danaScope, {
    title: 'Call the customer', application_id: fileDana, due_on: tomorrow(), due_time: '16:30' });
  const done = await updateTask(danaScope, task.id, { status: 'completed' });

  assert.equal(done.status, 'completed');
  assert.equal(done.open, false);
  assert.equal(done.completed_by_name, 'Dana Broker');
  const stamp = await queryOne<{ next_task_at: Date | null }>(
    'SELECT next_task_at FROM applications WHERE id = $1', [fileDana]);
  assert.equal(stamp!.next_task_at, null);

  // A finished task is reopened before it is changed again.
  await assert.rejects(updateTask(danaScope, task.id, { status: 'cancelled' }),
    (err: AppError) => err.status === 409 && /Reopen it/.test(err.message));
  const reopened = await updateTask(danaScope, task.id, { status: 'open' });
  assert.equal(reopened.open, true);
  assert.equal(reopened.completed_at, null);
});

test('moving a task re-arms its reminder', async () => {
  const task = await createTask(danaScope, {
    title: 'Call', application_id: fileDana, due_on: tomorrow(), due_time: '16:30' });
  await query('UPDATE tasks SET reminder_sent_at = now() WHERE id = $1', [task.id]);

  const moved = await updateTask(danaScope, task.id, { due_time: '17:30' });
  assert.equal(moved.due_time, '17:30');
  assert.equal(moved.reminder_sent, false, 'a task moved to a new time is reminded about again');

  const row = await queryOne<{ remind_at: Date; due_at: Date }>(
    'SELECT remind_at, due_at FROM tasks WHERE id = $1', [task.id]);
  assert.equal(row!.due_at.getTime() - row!.remind_at.getTime(), 15 * 60_000);
});

test('clearing the time makes it an all-day task with nothing to remind about', async () => {
  const task = await createTask(danaScope, {
    title: 'Call', due_on: tomorrow(), due_time: '16:30' });
  const allDay = await updateTask(danaScope, task.id, { due_time: null });
  assert.equal(allDay.due_time, null);
  assert.equal(allDay.due_at, null);
  assert.equal(allDay.reminder_minutes, null);
  const row = await queryOne<{ remind_at: Date | null }>(
    'SELECT remind_at FROM tasks WHERE id = $1', [task.id]);
  assert.equal(row!.remind_at, null);
});

test('one broker cannot change another’s task, and an admin can', async () => {
  const evans = await createTask(evanScope, { title: 'Evan’s' });
  await assert.rejects(updateTask(danaScope, evans.id, { title: 'Mine now' }),
    (err: AppError) => err.status === 404, 'not even visible to her');
  const moved = await updateTask(adminScope, evans.id, { priority: 'urgent' });
  assert.equal(moved.priority, 'urgent');
});

// ── The reminder ───────────────────────────────────────────────────────────

/** Put a task's reminder in the past so the tick will pick it up. */
const armFor = (id: string, minutesAgo: number) => query(
  `UPDATE tasks SET remind_at = now() - ($2 || ' minutes')::interval, reminder_sent_at = NULL
    WHERE id = $1`, [id, String(minutesAgo)]);

test('the owner is emailed and belled fifteen minutes before, once', async () => {
  const task = await createTask(adminScope, {
    title: 'Call the customer', application_id: fileDana,
    due_on: tomorrow(), due_time: '16:30' });
  await armFor(task.id, 0);

  const run = await runTaskReminders();
  assert.equal(run.reminded, 1);
  assert.deepEqual(run.sent, [{
    task_id: task.id,
    to: 'dana@example.com', // the person who has to do it, not the admin who set it
    subject: 'In 15 minutes: Call the customer',
  }]);

  const bell = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications
      WHERE user_id = $1 AND dedupe_key = $2`, [dana.userId, `task-reminder:${task.id}`]);
  assert.equal(bell!.n, 1);

  // Running again sends nothing: the mark is the guard.
  assert.deepEqual(await runTaskReminders(), { reminded: 0, sent: [] });
});

test('a reminder hours late is swallowed rather than sent stale', async () => {
  const task = await createTask(danaScope, {
    title: 'Call', due_on: tomorrow(), due_time: '16:30' });
  await armFor(task.id, 300); // five hours ago

  assert.deepEqual(await runTaskReminders(), { reminded: 0, sent: [] });
  const row = await queryOne<{ reminder_sent_at: Date | null }>(
    'SELECT reminder_sent_at FROM tasks WHERE id = $1', [task.id]);
  assert.ok(row!.reminder_sent_at, 'and marked, so it is not reconsidered every minute');
});

test('nothing is reminded about a task that is finished or has no time', async () => {
  const done = await createTask(danaScope, { title: 'Done', due_on: tomorrow(), due_time: '16:30' });
  await armFor(done.id, 0);
  await updateTask(danaScope, done.id, { status: 'completed' });

  const allDay = await createTask(danaScope, { title: 'All day', due_on: tomorrow() });
  await query('UPDATE tasks SET remind_at = now() WHERE id = $1', [allDay.id]);

  assert.deepEqual(await runTaskReminders(), { reminded: 0, sent: [] });
});

// ── The rest of the CRM ────────────────────────────────────────────────────

test('making and finishing work is in the activity log', async () => {
  const task = await createTask(adminScope, {
    title: 'Chase documents', application_id: fileDana, due_on: tomorrow() });
  await updateTask(adminScope, task.id, { due_on: tomorrow(), due_time: '10:00' });
  await updateTask(adminScope, task.id, { status: 'completed' });

  const { entries } = await listActivity(
    { organizationId: orgId, userId: alex.userId!, seeAll: true }, { module: 'tasks' });
  assert.deepEqual(entries.map((e) => e.action_label),
    ['Completed a task', 'Moved a task to another time', 'Created a task']);
  assert.match(String(entries.at(-1)!.summary), /for Dana Broker/);
});

test('the permission gates the module, and the meta says what the form may offer', async () => {
  const meta = await taskMeta(danaScope);
  assert.equal(meta.can_manage_all, false);
  assert.equal(meta.timezone, ZONE);
  assert.equal(meta.default_reminder_minutes, 15);
  assert.ok(meta.categories.length > 1 && meta.priorities.length === 4);
  assert.equal((await taskMeta(adminScope)).can_manage_all, true);

  const ok = await fetch(`${base}/tasks`, { headers: { cookie: danaCookie } });
  assert.equal(ok.status, 200);

  await query(`UPDATE users SET permission_overrides = '{"task.view": false}'::jsonb WHERE id = $1`,
    [dana.userId]);
  const refused = await fetch(`${base}/tasks`, { headers: { cookie: danaCookie } });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { permission: string }).permission, 'task.view');
});

test('one organization never sees another’s work', async () => {
  const otherOrg = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Other','BC') RETURNING id`)).rows[0]!.id;
  const outsiderId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, profile_complete)
     VALUES ($1,'x@other.com','Otto','technical_admin',true,true) RETURNING id`,
    [otherOrg])).rows[0]!.id;
  const outsider: Scope = {
    actor: { organizationId: otherOrg, kind: 'user', userId: outsiderId, name: 'Otto', role: 'technical_admin' },
    viewAll: true, manage: true, manageAll: true,
  };

  const ours = await createTask(danaScope, { title: 'Ours', application_id: fileDana });
  await assert.rejects(getTask(outsider, ours.id), (err: AppError) => err.status === 404);
  assert.equal((await listTasks(outsider, {})).total, 0);
  assert.equal((await assignableFiles(outsider, {})).length, 0);
  await assert.rejects(createTask(outsider, { title: 'Reach across', application_id: fileDana }),
    (err: AppError) => err.status === 404);
});
