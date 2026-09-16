/** Appointments — the rules that need no database. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookingMove, DEFAULT_TEMPLATES, formatDuration, formatTime, instantToLocal, localToInstant, outcomeMove,
  promptPhase, whereText, type StageRef,
} from '../src/domain/appointments.ts';
import { MERGE_FIELD_NAMES, validateTemplate } from '../src/domain/merge-fields.ts';

const TORONTO = 'America/Toronto';

test('a wall-clock time in a zone becomes the right instant, either side of daylight saving', () => {
  assert.equal(localToInstant('2026-09-18', '14:30', TORONTO)?.toISOString(), '2026-09-18T18:30:00.000Z');
  assert.equal(localToInstant('2026-12-18', '14:30', TORONTO)?.toISOString(), '2026-12-18T19:30:00.000Z');
  assert.equal(localToInstant('2026-09-18', '14:30', 'America/Vancouver')?.toISOString(), '2026-09-18T21:30:00.000Z');
  assert.deepEqual(instantToLocal(new Date('2026-09-18T18:30:00Z'), TORONTO), { date: '2026-09-18', time: '14:30' });
});

test('a time the clocks skip does not exist; a repeated one means the first', () => {
  assert.equal(localToInstant('2026-03-08', '02:30', TORONTO), null);
  assert.equal(localToInstant('2026-11-01', '01:30', TORONTO)?.toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(localToInstant('2026-02-31', '10:00', TORONTO), null);
  assert.equal(localToInstant('2026-09-18', '25:00', TORONTO), null);
  assert.equal(localToInstant('2026-09-18', '10:00', 'Mars/Olympus'), null);
});

test('times in emails name their zone', () => {
  assert.match(formatTime(new Date('2026-09-18T18:30:00Z'), TORONTO), /^2:30 p\.m\. EDT$/);
  assert.equal(formatDuration(30), '30 minutes');
  assert.equal(formatDuration(90), '1 hour 30 minutes');
});

test('where to be, in one sentence — or nothing, so the line is dropped', () => {
  const base = { location: null, meeting_url: null, host_name: 'Priya', client_phone: '+14165550142' };
  assert.equal(whereText({ ...base, mode: 'video', meeting_url: 'https://meet.google.com/a-b-c' }),
               'Join the video call: https://meet.google.com/a-b-c');
  assert.equal(whereText({ ...base, mode: 'video' }), null);
  assert.equal(whereText({ ...base, mode: 'phone' }), 'Priya will call you at +14165550142.');
  assert.equal(whereText({ ...base, mode: 'in_person', location: '1 King St' }), "We'll meet at 1 King St.");
});

test('the popup asks while the meeting runs, then after, then stops', () => {
  const at = new Date('2026-09-18T18:00:00Z');
  const appt = { status: 'booked', starts_at: at, ends_at: new Date(at.getTime() + 30 * 60_000) };
  assert.equal(promptPhase(appt, new Date(at.getTime() - 60_000)), null, 'not before it starts');
  assert.equal(promptPhase(appt, new Date(at.getTime() + 5 * 60_000)), 'live');
  assert.equal(promptPhase(appt, new Date(at.getTime() + 45 * 60_000)), 'ended');
  assert.equal(promptPhase(appt, new Date(at.getTime() + 13 * 3_600_000)), null, 'gives up after 12 hours');
  assert.equal(promptPhase(appt, new Date(at.getTime() + 5 * 60_000), new Date(at.getTime() + 30 * 60_000)), null, 'snoozed');
  assert.equal(promptPhase({ ...appt, status: 'completed' }, new Date(at.getTime() + 5 * 60_000)), null);
});

const stage = (key: string, position: number, category = 'open', pipeline_id = 'p1'): StageRef =>
  ({ key, label: key[0]!.toUpperCase() + key.slice(1), position, category, pipeline_id });
const lead = stage('lead', 1), application = stage('application', 2), booked = stage('booked', 3),
  noShow = stage('no_show', 4), scarlett = stage('scarlett', 5), funded = stage('funded', 6, 'won'),
  nurture = stage('nurture', 7, 'parked');

test('booking moves a file forward to the booked stage, and never backwards', () => {
  assert.deepEqual(bookingMove({ current: lead, booked, missedKey: 'nurture' }), { move: booked });
  assert.deepEqual(bookingMove({ current: application, booked, missedKey: 'nurture' }), { move: booked });
  assert.ok('skip' in bookingMove({ current: scarlett, booked, missedKey: 'nurture' }));
  assert.ok('skip' in bookingMove({ current: funded, booked, missedKey: 'nurture' }), 'funded files stay funded');
  assert.deepEqual(bookingMove({ current: nurture, booked, missedKey: 'nurture' }), { move: booked }, 'nurture comes back');
  assert.deepEqual(bookingMove({ current: noShow, booked, missedKey: 'no_show' }), { move: booked }, 'so does the missed stage');
  assert.deepEqual(bookingMove({ current: lead, booked: null, missedKey: null }), { skip: null }, 'no setting, no move');
  assert.deepEqual(bookingMove({ current: stage('x', 1, 'open', 'p2'), booked, missedKey: null }), { skip: null });
});

test('attended and missed move the file only while it is where booking left it', () => {
  assert.deepEqual(outcomeMove({ current: booked, target: application, booked, outcome: 'attended' }), { move: application },
                   'back to Application is the configured flow');
  assert.deepEqual(outcomeMove({ current: booked, target: nurture, booked, outcome: 'missed' }), { move: nurture });
  assert.ok('skip' in outcomeMove({ current: scarlett, target: application, booked, outcome: 'attended' }),
            'somebody moved it on since');
  assert.ok('skip' in outcomeMove({ current: funded, target: nurture, booked, outcome: 'missed' }));
  assert.ok('skip' in outcomeMove({ current: booked, target: stage('x', 1, 'open', 'p2'), booked, outcome: 'missed' }));
  // Without a booked stage: attended only ever moves forward.
  assert.ok('skip' in outcomeMove({ current: scarlett, target: application, booked: null, outcome: 'attended' }));
  assert.deepEqual(outcomeMove({ current: lead, target: application, booked: null, outcome: 'attended' }), { move: application });
});

test('the default emails only use merge fields that exist', () => {
  for (const t of DEFAULT_TEMPLATES) {
    for (const text of [t.subject, t.body]) {
      const used = [...text.matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]!);
      for (const f of used) assert.ok(MERGE_FIELD_NAMES.has(f), `${t.key} uses unknown {${f}}`);
      assert.deepEqual(validateTemplate(text), [], t.key);
    }
  }
});
