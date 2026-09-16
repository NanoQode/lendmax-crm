/**
 * Appointments, against a real database: who may book what, the file's
 * stage, Google Calendar (the sandbox driver), the emails, the reminders and
 * the popup.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { AppError } from '../../src/http/middleware/errors.ts';
import { instantToLocal } from '../../src/domain/appointments.ts';
import { sandbox } from '../../src/integrations/google-calendar.ts';
import {
  bookableFiles, bookAppointment, cancelAppointment, getAppointment, listAppointments, promptsFor,
  recordOutcome, runAppointmentTick, snoozePrompt, syncOne, updateAppointment, type Scope,
} from '../../src/services/appointments.ts';
import { connectUrl, finishConnect } from '../../src/services/google-calendar.ts';
import { createApiKey } from '../../src/services/api-keys.ts';
import { deleteStage, updatePipeline } from '../../src/services/pipelines.ts';
import type { Actor } from '../../src/services/staff.ts';

const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;
let orgId: string;
let pipelineId: string;
let admin: Actor, dana: Actor, evan: Actor;
let fileDana: string, fileEvan: string;

const ZONE = 'America/Toronto';

before(async () => {
  await migrate();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/crm/api`;
});
after(async () => { server.close(); await pool.end(); });

const person = async (email: string, name: string, role: string): Promise<Actor> => {
  const id = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete, timezone)
     VALUES ($1,$2,$3,$4,true,now(),true,'America/Toronto') RETURNING id`, [orgId, email, name, role])).rows[0]!.id;
  return { organizationId: orgId, kind: 'user', userId: id, name, role };
};

const fileFor = async (owner: Actor, first: string, stage = 'lead') => {
  const customer = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name, email, phone_e164)
     VALUES ($1,$2,'Client',$3,'+14165550142') RETURNING id`, [orgId, first, `${first.toLowerCase()}@example.com`])).rows[0]!.id;
  const id = (await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, stage_key) VALUES ($1,$2,$3) RETURNING id`,
    [orgId, customer, stage])).rows[0]!.id;
  await query(`INSERT INTO assignments (application_id, user_id, role, is_primary) VALUES ($1,$2,'broker',true)`, [id, owner.userId]);
  return id;
};

beforeEach(async () => {
  sandbox.reset();
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  await query(`DELETE FROM jobs WHERE kind LIKE 'google.%'`);
  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province, timezone) VALUES ('Lendmax','ON','America/Toronto') RETURNING id`)).rows[0]!.id;
  admin = await person('admin@example.com', 'Alex Admin', 'technical_admin');
  dana = await person('dana@example.com', 'Dana Broker', 'broker');
  evan = await person('evan@example.com', 'Evan Broker', 'broker');
  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
     VALUES ($1,'lead','Lead',1,'open',true), ($1,'application','Application',2,'open',true),
            ($1,'appointment_booked','Appointment Booked',3,'open',true), ($1,'scarlett','Scarlett',5,'open',true),
            ($1,'funded','Funded',8,'won',true), ($1,'nurture','Nurture',9,'parked',true), ($1,'lost','Lost',10,'lost',true)`,
    [orgId]);
  pipelineId = (await queryOne<{ id: string }>('SELECT id FROM pipelines WHERE organization_id = $1', [orgId]))!.id;
  await query(
    `UPDATE pipelines SET appointment_booked_stage_key = 'appointment_booked',
            appointment_attended_stage_key = 'application', appointment_missed_stage_key = 'nurture' WHERE id = $1`,
    [pipelineId]);
  fileDana = await fileFor(dana, 'Rena');
  fileEvan = await fileFor(evan, 'Omar');
});

const scope = (a: Actor, all = false): Scope => ({ actor: a, viewAll: all, manage: true, manageAll: all, timezone: ZONE });
const tomorrow = (time: string) => ({ date: instantToLocal(new Date(Date.now() + 86_400_000), ZONE).date, time });
const stageOf = async (id: string) => (await queryOne<{ stage_key: string }>('SELECT stage_key FROM applications WHERE id = $1', [id]))!.stage_key;
const startNow = (id: string, minutesAgo = 5, length = 30) => query(
  `UPDATE appointments SET starts_at = now() - make_interval(mins => $2), ends_at = now() - make_interval(mins => $2) + make_interval(mins => $3)
    WHERE id = $1`, [id, minutesAgo, length]);

const refusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (err) {
    if (err instanceof ZodError) return { fields: err.issues.map((i) => i.path.join('.')), message: err.issues[0]!.message };
    if (err instanceof AppError) return { code: err.code, status: err.status, message: err.message };
    throw err;
  }
  throw new Error('expected a refusal');
};

async function connectGoogle(a: Actor, email: string) {
  const url = await connectUrl(orgId, a.userId!);
  const state = new URL(url).searchParams.get('state')!;
  await finishConnect({ id: a.userId!, organization_id: orgId, name: a.name, email, role: a.role! }, 'sandbox', state);
}

// ── Who books what ─────────────────────────────────────────────────────────

test('an admin books for a broker: only that broker’s clients, the file moves, the client is emailed', async () => {
  const offered = await bookableFiles(scope(admin, true), { host: dana.userId });
  assert.deepEqual(offered.map((f) => f.id), [fileDana], 'only Dana’s clients are offered for Dana');

  const wrong = await refusal(bookAppointment(scope(admin, true), { application_id: fileEvan, user_id: dana.userId, mode: 'phone', ...tomorrow('14:00') }));
  assert.deepEqual(wrong.fields, ['application_id']);

  const result = await bookAppointment(scope(admin, true), {
    application_id: fileDana, user_id: dana.userId, mode: 'phone', ...tomorrow('14:00'),
  });
  assert.equal(result.appointment.host_name, 'Dana Broker');
  assert.equal(result.appointment.status, 'booked');
  assert.equal(result.stage?.moved_to, 'Appointment Booked');
  assert.equal(await stageOf(fileDana), 'appointment_booked');
  assert.equal(result.email?.status, 'sent');

  const email = await queryOne<{ subject: string; body_text: string; purpose: string }>(
    `SELECT subject, body_text, purpose FROM messages WHERE template_key = 'appointment_confirmation'`);
  assert.equal(email!.purpose, 'transactional');
  assert.match(email!.subject, /discovery call with Dana Broker/);
  assert.match(email!.body_text, /2:00 p\.m\. E[DS]T/);
  assert.match(email!.body_text, /Dana Broker will call you at \+14165550142/);

  assert.ok(await queryOne(`SELECT 1 FROM domain_events WHERE event_type = 'appointment.booked'`), 'automations hear it');
  assert.ok(await queryOne(`SELECT 1 FROM activity WHERE application_id = $1 AND kind = 'appointment'`, [fileDana]), 'on the file’s timeline');
  assert.ok(await queryOne(`SELECT 1 FROM activity_logs WHERE action = 'appointment.book' AND application_id = $1`, [fileDana]),
            'in the activity log, linked to the file');
  assert.ok(await queryOne(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'appointment'`, [dana.userId]),
            'Dana is told somebody booked for her');
  assert.ok((await queryOne<{ next_appointment_at: Date | null }>('SELECT next_appointment_at FROM applications WHERE id = $1', [fileDana]))!.next_appointment_at);
});

test('a broker books and sees only their own clients', async () => {
  const notMine = await refusal(bookAppointment(scope(dana), { application_id: fileEvan, mode: 'phone', ...tomorrow('10:00') }));
  assert.deepEqual(notMine.fields, ['application_id']);
  const forEvan = await refusal(bookAppointment(scope(dana), { application_id: fileDana, user_id: evan.userId, mode: 'phone', ...tomorrow('10:00') }));
  assert.equal(forEvan.status, 403);

  const evans = await bookAppointment(scope(admin, true), { application_id: fileEvan, user_id: evan.userId, mode: 'phone', ...tomorrow('11:00') });
  const danas = await bookAppointment(scope(dana), { application_id: fileDana, mode: 'phone', ...tomorrow('11:00') });
  assert.equal(danas.appointment.host_id, dana.userId, 'a broker hosts their own');

  const seen = await listAppointments(scope(dana), { tab: 'all' });
  assert.deepEqual(seen.appointments.map((a) => a.id), [danas.appointment.id]);
  assert.equal((await refusal(getAppointment(scope(dana), evans.appointment.id))).status, 404, 'not even that it exists');
  assert.equal((await listAppointments(scope(admin, true), { tab: 'all' })).total, 2);
});

test('double booking is refused; a Google busy time asks first, and "book anyway" books', async () => {
  await connectGoogle(dana, 'dana@example.com');
  const at = tomorrow('15:00');
  await bookAppointment(scope(dana), { application_id: fileDana, mode: 'phone', ...at });
  const clash = await refusal(bookAppointment(scope(dana), { application_id: fileDana, mode: 'phone', ...at }));
  assert.equal(clash.code, 'double_booked');

  const other = tomorrow('16:00');
  const start = new Date((await bookAppointment(scope(dana), { application_id: fileDana, mode: 'phone', ...tomorrow('17:30') })).appointment.starts_at);
  sandbox.setBusy('dana@example.com', [{ start: new Date(start.getTime() - 90 * 60_000), end: new Date(start.getTime() - 60 * 60_000) }]);
  const busy = await refusal(bookAppointment(scope(dana), { application_id: fileDana, mode: 'phone', ...other }));
  assert.equal(busy.code, 'calendar_busy');
  assert.match(busy.message!, /busy in Google Calendar/);
  const anyway = await bookAppointment(scope(dana), { application_id: fileDana, mode: 'phone', ...other, allow_conflict: true });
  assert.equal(anyway.appointment.status, 'booked');
});

test('with Google connected: a Meet link, the client invited, and changes kept in step both ways', async () => {
  const noLink = await refusal(bookAppointment(scope(dana), { application_id: fileDana, mode: 'video', ...tomorrow('09:00') }));
  assert.deepEqual(noLink.fields, ['meeting_url'], 'without Google a video call needs a link');

  await connectGoogle(dana, 'dana@example.com');
  const booked = await bookAppointment(scope(dana), { application_id: fileDana, mode: 'video', ...tomorrow('09:00') });
  const a = booked.appointment;
  assert.equal(booked.google?.synced, true);
  assert.match(a.meeting_url ?? '', /^https:\/\/meet\.google\.com\//);
  const event = sandbox.events.get(a.google_event_id!)!;
  assert.deepEqual(event.attendees, ['rena@example.com'], 'the client is invited');

  // Moved here: moved there, the client told, the reminder re-armed.
  const moved = await updateAppointment(scope(dana), a.id, { time: '10:30' });
  assert.equal(sandbox.events.get(a.google_event_id!)!.startsAt!.toISOString(), moved.appointment.starts_at);
  assert.equal(moved.appointment.reschedule_count, 1);
  assert.ok(await queryOne(`SELECT 1 FROM messages WHERE template_key = 'appointment_rescheduled'`));

  // Moved in Google: moved here.
  const later = new Date(new Date(moved.appointment.starts_at).getTime() + 3_600_000);
  sandbox.move(a.google_event_id!, later, new Date(later.getTime() + 30 * 60_000));
  assert.equal(await syncOne(dana.userId!, orgId, dana.name), 1);
  assert.equal((await getAppointment(scope(dana), a.id)).starts_at, later.toISOString());
  assert.ok(await queryOne(`SELECT 1 FROM activity_logs WHERE action = 'appointment.google_sync'`));

  // Deleted in Google: cancelled here.
  sandbox.cancel(a.google_event_id!);
  assert.equal(await syncOne(dana.userId!, orgId, dana.name), 1);
  const after = await getAppointment(scope(dana), a.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(after.cancelled_reason, 'Cancelled in Google Calendar');
});

test('cancelling needs a reason, tells the client, and takes it out of Google', async () => {
  await connectGoogle(dana, 'dana@example.com');
  const { appointment: a } = await bookAppointment(scope(dana), { application_id: fileDana, mode: 'in_person', location: '1 King St W', ...tomorrow('13:00') });
  assert.deepEqual((await refusal(cancelAppointment(scope(dana), a.id, {}))).fields, ['reason']);
  const done = await cancelAppointment(scope(dana), a.id, { reason: 'Client asked to postpone' });
  assert.equal(done.appointment.status, 'cancelled');
  assert.equal(done.email?.status, 'sent');
  assert.equal(sandbox.events.get(a.google_event_id!)!.status, 'cancelled');
  assert.equal((await refusal(cancelAppointment(scope(dana), a.id, { reason: 'again' }))).code, 'not_open');
});

// ── Outcomes ───────────────────────────────────────────────────────────────

test('attended and missed: only once it has started, and the file follows its pipeline', async () => {
  const { appointment: a } = await bookAppointment(scope(dana), { application_id: fileDana, mode: 'phone', ...tomorrow('12:00') });
  assert.equal((await refusal(recordOutcome(scope(dana), a.id, { outcome: 'attended' }))).code, 'not_started');

  await startNow(a.id);
  const attended = await recordOutcome(scope(dana), a.id, { outcome: 'attended' });
  assert.equal(attended.appointment.status, 'completed');
  assert.equal(attended.stage?.moved_to, 'Application');
  assert.equal(await stageOf(fileDana), 'application');
  assert.equal(attended.appointment.outcome_stage_key, 'application');
  assert.ok(await queryOne(`SELECT 1 FROM domain_events WHERE event_type = 'appointment.completed'`));

  // A correction moves it again.
  const missed = await recordOutcome(scope(dana), a.id, { outcome: 'missed' });
  assert.equal(missed.appointment.status, 'no_show');
  assert.equal(await stageOf(fileDana), 'nurture');
  assert.ok(await queryOne(`SELECT 1 FROM domain_events WHERE event_type = 'appointment.no_show'`));
});

test('a file somebody has moved on since booking stays where they put it', async () => {
  const { appointment: a } = await bookAppointment(scope(dana), { application_id: fileDana, mode: 'phone', ...tomorrow('12:00') });
  await query(`UPDATE applications SET stage_key = 'scarlett' WHERE id = $1`, [fileDana]);
  await startNow(a.id);
  const result = await recordOutcome(scope(dana), a.id, { outcome: 'missed' });
  assert.equal(result.stage?.moved_to, null);
  assert.match(result.stage?.note ?? '', /already moved past Appointment Booked/);
  assert.equal(await stageOf(fileDana), 'scarlett');
});

test('reminders go 15 minutes before — once, to the client and the host', async () => {
  const { appointment: a } = await bookAppointment(scope(dana), { application_id: fileDana, mode: 'phone', ...tomorrow('12:00') });
  const { appointment: late } = await bookAppointment(scope(dana), { application_id: fileDana, mode: 'phone', ...tomorrow('16:00') });
  await query(`UPDATE appointments SET starts_at = now() + interval '10 minutes', ends_at = now() + interval '40 minutes',
                      time_set_at = now() - interval '1 hour' WHERE id = $1`, [a.id]);
  // Booked with only ten minutes to go: the confirmation is the reminder.
  await query(`UPDATE appointments SET starts_at = now() + interval '12 minutes', ends_at = now() + interval '42 minutes',
                      time_set_at = now() - interval '1 minute' WHERE id = $1`, [late.id]);

  assert.deepEqual(await runAppointmentTick(), { reminded: 1 });
  assert.deepEqual(await runAppointmentTick(), { reminded: 0 }, 'once');
  const reminders = await query(`SELECT 1 FROM messages WHERE template_key = 'appointment_reminder'`);
  assert.equal(reminders.rowCount, 1);
  assert.ok(await queryOne(`SELECT 1 FROM notifications WHERE user_id = $1 AND title LIKE 'In 15 minutes%'`, [dana.userId]));
});

test('the popup asks whoever hosts it and whoever booked it, until one of them answers', async () => {
  const { appointment: a } = await bookAppointment(scope(admin, true), { application_id: fileDana, user_id: dana.userId, mode: 'phone', ...tomorrow('12:00') });
  assert.deepEqual(await promptsFor(scope(dana)), [], 'nothing before it starts');
  await startNow(a.id);

  const forDana = await promptsFor(scope(dana));
  assert.equal(forDana[0]?.prompt, 'live');
  assert.equal((await promptsFor(scope(admin, true)))[0]?.booked_by_me, true);
  assert.deepEqual(await promptsFor(scope(evan)), [], 'nobody else');

  await snoozePrompt(scope(dana), a.id, { until: 'end' });
  assert.deepEqual(await promptsFor(scope(dana)), [], 'asked again at the end');
  assert.equal((await promptsFor(scope(admin, true))).length, 1, 'the snooze is Dana’s own');

  await recordOutcome(scope(admin, true), a.id, { outcome: 'attended' });
  assert.deepEqual(await promptsFor(scope(admin, true)), []);
});

test('the list: tabs count what the filters allow', async () => {
  const one = await bookAppointment(scope(dana), { application_id: fileDana, mode: 'phone', ...tomorrow('09:00') });
  await bookAppointment(scope(dana), { application_id: fileDana, mode: 'in_person', location: 'Office', ...tomorrow('11:00') });
  await bookAppointment(scope(admin, true), { application_id: fileEvan, user_id: evan.userId, mode: 'phone', ...tomorrow('09:00') });
  await startNow(one.appointment.id, 60);
  const all = await listAppointments(scope(admin, true), { tab: 'upcoming' });
  assert.deepEqual({ upcoming: all.tabs!.upcoming, needs: all.tabs!.needs_outcome }, { upcoming: 2, needs: 1 });
  assert.equal((await listAppointments(scope(admin, true), { tab: 'all', host: dana.userId })).total, 2);
  assert.equal((await listAppointments(scope(admin, true), { tab: 'all', mode: 'in_person' })).total, 1);
  assert.equal((await listAppointments(scope(admin, true), { tab: 'all', when: 'tomorrow' })).total, 2);
  assert.equal((await listAppointments(scope(admin, true), { tab: 'all', client: 'omar' })).total, 1);
});

// ── Pipelines and the API ──────────────────────────────────────────────────

test('a pipeline’s appointment stages are its own, and follow a deleted stage', async () => {
  const bad = await refusal(updatePipeline(admin, pipelineId, { appointment_stages: { attended: 'nope' } }));
  assert.deepEqual(bad.fields, ['appointment_stages.attended']);
  const { pipeline } = await updatePipeline(admin, pipelineId, { appointment_stages: { missed: 'lost' } });
  assert.equal(pipeline.appointment_stages.missed, 'lost');

  const application = (await queryOne<{ id: string }>(`SELECT id FROM pipeline_stages WHERE key = 'application' AND organization_id = $1`, [orgId]))!.id;
  await deleteStage(admin, application, { move_to: 'lead' });
  const after = await queryOne<{ appointment_attended_stage_key: string }>('SELECT appointment_attended_stage_key FROM pipelines WHERE id = $1', [pipelineId]);
  assert.equal(after!.appointment_attended_stage_key, 'lead');
});

test('a website books through the API, and the file’s broker hosts', async () => {
  const { key } = await createApiKey(admin, { name: 'booking page', permissions: ['appointment.manage_all'] });
  const startsAt = new Date(Date.now() + 2 * 86_400_000);
  startsAt.setUTCMinutes(0, 0, 0);
  const response = await fetch(`${base}/v1/appointments`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ application_id: fileDana, mode: 'phone', starts_at: startsAt.toISOString() }),
  });
  const body = await response.json() as { data: { appointment: { host_name: string; starts_at: string } } };
  assert.equal(response.status, 201);
  assert.equal(body.data.appointment.host_name, 'Dana Broker');

  const { key: reader } = await createApiKey(admin, { name: 'dashboard', permissions: ['appointment.view_all'] });
  assert.equal((await fetch(`${base}/v1/appointments?tab=all`, { headers: { authorization: `Bearer ${reader}` } })).status, 200);
  assert.equal((await fetch(`${base}/v1/appointments`, {
    method: 'POST', headers: { authorization: `Bearer ${reader}`, 'content-type': 'application/json' },
    body: JSON.stringify({ application_id: fileDana, mode: 'phone', starts_at: startsAt.toISOString() }),
  })).status, 403);
});
