/**
 * Tasks — the rules, with no database in sight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueBucket, dueInstant, isOpen, ownerFor, REMINDER_MINUTES, reminderInstant, reminderSubject,
  scheduleRefusal, shouldRemind, titleRefusal, transitionRefusal, MAX_TITLE,
} from '../src/domain/tasks.ts';

const ZONE = 'America/Toronto';

// ── When it is due ─────────────────────────────────────────────────────────

test('a date and a time become an instant in the right zone', () => {
  // 4:30 pm in Toronto in September is 20:30 UTC.
  assert.equal(dueInstant('2026-09-18', '16:30', ZONE)!.toISOString(), '2026-09-18T20:30:00.000Z');
  // In January the same wall clock is 21:30 UTC — the offset is not a constant.
  assert.equal(dueInstant('2026-01-18', '16:30', ZONE)!.toISOString(), '2026-01-18T21:30:00.000Z');
});

test('a day with no time has no instant', () => {
  // The whole point: an all-day task must not become due at midnight and
  // therefore overdue by breakfast.
  assert.equal(dueInstant('2026-09-18', null, ZONE), null);
  assert.equal(dueInstant(null, '16:30', ZONE), null);
});

test('a time that does not exist is refused rather than moved', () => {
  // 02:30 on the morning the clocks go forward never happens in Toronto.
  assert.equal(dueInstant('2026-03-08', '02:30', ZONE), null);
  assert.match(scheduleRefusal('2026-03-08', '02:30', ZONE)!, /does not exist/);
});

test('a time with no date is a wish, not a task', () => {
  assert.match(scheduleRefusal(null, '16:30', ZONE)!, /date as well as a time/);
  assert.equal(scheduleRefusal('2026-09-18', null, ZONE), null, 'a day on its own is a real promise');
  assert.equal(scheduleRefusal(null, null, ZONE), null, 'and so is no date at all');
});

// ── Reminders ──────────────────────────────────────────────────────────────

test('the reminder is fifteen minutes before, by default', () => {
  assert.equal(REMINDER_MINUTES, 15);
  const due = new Date('2026-09-18T20:30:00Z');
  assert.equal(reminderInstant(due, 15, 'open')!.toISOString(), '2026-09-18T20:15:00.000Z');
  assert.equal(reminderInstant(due, 0, 'open')!.toISOString(), '2026-09-18T20:30:00.000Z');
});

test('there is nothing to remind about without a time, or once it is done', () => {
  assert.equal(reminderInstant(null, 15, 'open'), null);
  assert.equal(reminderInstant(new Date(), null, 'open'), null);
  assert.equal(reminderInstant(new Date(), 15, 'completed'), null);
  assert.equal(reminderInstant(new Date(), 15, 'cancelled'), null);
});

test('a reminder goes once, on time, and is dropped if it is hours late', () => {
  const now = new Date('2026-09-18T20:15:00Z');
  const open = { status: 'open', reminder_sent_at: null };

  assert.equal(shouldRemind({ ...open, remind_at: now }, now), true);
  assert.equal(shouldRemind({ ...open, remind_at: new Date('2026-09-18T20:16:00Z') }, now), false,
    'not before it is due');
  assert.equal(
    shouldRemind({ ...open, remind_at: new Date('2026-09-18T20:14:00Z'), reminder_sent_at: now }, now),
    false, 'and never twice');

  // "Your 9am task starts in 15 minutes", sent at 4pm, is worse than silence.
  assert.equal(shouldRemind({ ...open, remind_at: new Date('2026-09-18T16:00:00Z') }, now), false);
  assert.equal(shouldRemind({ ...open, remind_at: new Date('2026-09-18T19:00:00Z') }, now), true,
    'an hour behind is still worth sending');
});

test('the reminder says how long is left', () => {
  assert.equal(reminderSubject({ title: 'Call Rena', minutes: 15 }), 'In 15 minutes: Call Rena');
  assert.equal(reminderSubject({ title: 'Call Rena', minutes: 0 }), 'Starting now: Call Rena');
  assert.equal(reminderSubject({ title: 'Call Rena', minutes: 1440 }), 'Tomorrow: Call Rena');
});

// ── Which heading it sits under ────────────────────────────────────────────

const at = (iso: string) => new Date(iso);

test('a task is bucketed in the reader’s own day, not in UTC', () => {
  // 9pm in Toronto is already tomorrow by UTC. A task due tonight must stay
  // under Today for the person who has to do it tonight.
  const now = at('2026-09-18T01:00:00Z'); // 2026-09-17, 9pm in Toronto
  assert.equal(
    dueBucket({ due_on: '2026-09-17', due_at: at('2026-09-18T02:00:00Z'), status: 'open' }, now, ZONE),
    'today');
  assert.equal(
    dueBucket({ due_on: '2026-09-18', due_at: null, status: 'open' }, now, ZONE),
    'tomorrow');
});

test('a timed task is overdue the minute it passes; an all-day one only after the day', () => {
  const now = at('2026-09-18T18:00:00Z'); // 2pm in Toronto
  assert.equal(
    dueBucket({ due_on: '2026-09-18', due_at: at('2026-09-18T17:00:00Z'), status: 'open' }, now, ZONE),
    'overdue', 'one o’clock has been and gone');
  assert.equal(
    dueBucket({ due_on: '2026-09-18', due_at: null, status: 'open' }, now, ZONE),
    'today', 'but "sometime today" still has the afternoon');
  assert.equal(
    dueBucket({ due_on: '2026-09-17', due_at: null, status: 'open' }, now, ZONE),
    'overdue');
});

test('the far future and no date at all have their own headings', () => {
  const now = at('2026-09-18T18:00:00Z');
  assert.equal(dueBucket({ due_on: '2026-09-22', due_at: null, status: 'open' }, now, ZONE), 'this_week');
  assert.equal(dueBucket({ due_on: '2026-10-30', due_at: null, status: 'open' }, now, ZONE), 'later');
  assert.equal(dueBucket({ due_on: null, due_at: null, status: 'open' }, now, ZONE), 'someday');
});

// ── Whose task it is ───────────────────────────────────────────────────────

const dana = { user_id: 'dana', name: 'Dana Broker', role: 'broker' };

test('an admin picking a client makes work for whoever that client belongs to', () => {
  // This is the rule the read-only field on the form is showing.
  const decision = ownerFor({ actorId: 'alex', manageAll: true, fileOwner: dana, hasFile: true });
  assert.deepEqual(decision, {
    assignee: 'dana', source: 'file',
    note: 'Dana Broker is assigned to this file, so the task will be theirs.',
  });
});

test('a file nobody is assigned to leaves the task with whoever made it', () => {
  const decision = ownerFor({ actorId: 'alex', manageAll: true, fileOwner: null, hasFile: true });
  assert.equal('assignee' in decision && decision.assignee, 'alex');
  assert.match(('note' in decision && decision.note) || '', /Nobody is assigned/);
});

test('a staff member’s task is always their own, whoever the file belongs to', () => {
  // Without manage_all there is no way to put work on somebody else's list —
  // not by choosing them, and not by choosing their client.
  const decision = ownerFor({ actorId: 'evan', manageAll: false, fileOwner: dana, hasFile: true });
  assert.deepEqual(decision, { assignee: 'evan', source: 'self', note: null });
});

test('a task with no file is your own note to yourself', () => {
  assert.deepEqual(
    ownerFor({ actorId: 'alex', manageAll: true, fileOwner: dana, hasFile: false }),
    { assignee: 'alex', source: 'self', note: null });
});

test('an admin on their own client is told nothing they do not know', () => {
  const decision = ownerFor({
    actorId: 'dana', manageAll: true, fileOwner: dana, hasFile: true });
  assert.deepEqual(decision, { assignee: 'dana', source: 'file', note: null });
});

// ── Status ─────────────────────────────────────────────────────────────────

test('open means open', () => {
  assert.equal(isOpen('open'), true);
  assert.equal(isOpen('in_progress'), true);
  assert.equal(isOpen('waiting'), true);
  assert.equal(isOpen('completed'), false);
  assert.equal(isOpen('cancelled'), false);
});

test('a finished task is reopened before it is changed', () => {
  assert.equal(transitionRefusal('open', 'completed'), null);
  assert.equal(transitionRefusal('completed', 'open'), null, 'reopening is always allowed');
  assert.match(transitionRefusal('completed', 'cancelled')!, /Reopen it before changing it/);
  assert.match(transitionRefusal('cancelled', 'completed')!, /Reopen it/);
  assert.equal(transitionRefusal('open', 'open'), null);
  assert.match(transitionRefusal('open', 'nonsense')!, /not a status/);
});

// ── Validation ─────────────────────────────────────────────────────────────

test('a task needs a title somebody could act on', () => {
  assert.match(titleRefusal('   ')!, /what is it you have to do/);
  assert.match(titleRefusal('x'.repeat(MAX_TITLE + 1))!, /at most 160 characters/);
  assert.equal(titleRefusal('  Call Rena at 4:30  '), null);
});
