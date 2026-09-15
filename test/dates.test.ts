import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBusinessDays, addDays, addMonths, businessDaysBetween, calculateMaturity,
  daysBetween, daysToClose, isBusinessDay, isIsoDate, isWithinQuietHours,
  localParts, nextSendableTime, renewalSchedule, todayIn,
  DEFAULT_BUSINESS_CALENDAR, DEFAULT_QUIET_HOURS,
  type BusinessCalendar,
} from '../src/domain/dates.ts';

test('isIsoDate rejects impossible calendar dates', () => {
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2024-02-29'), true, 'leap year');
  assert.equal(isIsoDate('2026-02-29'), false, 'not a leap year');
  assert.equal(isIsoDate('2026-13-01'), false);
  assert.equal(isIsoDate('2026-04-31'), false, 'April has 30 days');
  assert.equal(isIsoDate('2026-1-1'), false, 'must be zero-padded');
  assert.equal(isIsoDate(''), false);
  assert.equal(isIsoDate(null), false);
});

test('addMonths clamps to the end of a shorter month', () => {
  // The case that breaks naive arithmetic: a term taken out at month end.
  assert.equal(addMonths('2026-08-31', 6), '2027-02-28');
  assert.equal(addMonths('2024-08-31', 6), '2025-02-28');
  assert.equal(addMonths('2023-08-31', 6), '2024-02-29', 'lands in a leap year');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28', 'backwards clamps too');
  // And the ordinary case still works.
  assert.equal(addMonths('2026-09-11', 60), '2031-09-11', 'five year term');
});

test('addMonths going backwards from month end does not skip a month', () => {
  // Counting six months back from 31 March must land in September, not October.
  assert.equal(addMonths('2027-03-31', -6), '2026-09-30');
});

test('daysBetween is signed and inclusive of neither endpoint twice', () => {
  assert.equal(daysBetween('2026-09-11', '2026-09-11'), 0);
  assert.equal(daysBetween('2026-09-11', '2026-09-12'), 1);
  assert.equal(daysBetween('2026-09-12', '2026-09-11'), -1);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1, 'non-leap year');
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2, 'leap year');
  // Across a daylight-saving boundary. UTC-midnight arithmetic must not lose
  // or gain the hour.
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1);
});

test('daysToClose reports urgency as a word, not only a colour', () => {
  const today = '2026-09-11';
  assert.deepEqual(daysToClose(null, today), {
    days: null, urgency: 'none', label: 'No closing date',
  });
  assert.equal(daysToClose('2026-09-11', today).label, 'Closes today');
  assert.equal(daysToClose('2026-09-12', today).label, 'Closes tomorrow');
  assert.equal(daysToClose('2026-09-15', today).urgency, 'urgent', '4 days');
  assert.equal(daysToClose('2026-09-20', today).urgency, 'attention', '9 days');
  assert.equal(daysToClose('2026-10-15', today).urgency, 'comfortable', '34 days');

  const late = daysToClose('2026-09-08', today);
  assert.equal(late.urgency, 'overdue');
  assert.equal(late.days, -3);
  assert.equal(late.label, 'Closing date passed 3 days ago');
  assert.equal(daysToClose('2026-09-10', today).label, 'Closing date passed 1 day ago',
    'singular, not "1 days"');
});

test('daysToClose honours configured thresholds', () => {
  const t = { attention: 30, urgent: 10 };
  assert.equal(daysToClose('2026-09-20', '2026-09-11', t).urgency, 'urgent');
  assert.equal(daysToClose('2026-10-05', '2026-09-11', t).urgency, 'attention');
});

test('calculateMaturity says why it could not, rather than returning null quietly', () => {
  assert.deepEqual(calculateMaturity('2026-09-11', 60), {
    date: '2031-09-11', source: 'calculated',
  });
  const noDate = calculateMaturity(null, 60);
  assert.equal(noDate.date, null);
  assert.match(noDate.reason!, /funding date/);
  const noTerm = calculateMaturity('2026-09-11', null);
  assert.equal(noTerm.date, null);
  assert.match(noTerm.reason!, /term/);
  assert.equal(calculateMaturity('2026-09-11', 0).date, null, 'a zero term is not a term');
});

test('renewalSchedule marks milestones already in the past instead of dropping them', () => {
  // A mortgage maturing in ten weeks has missed T-6m and T-3m. The brokerage
  // has to see that it is starting late.
  const schedule = renewalSchedule('2026-11-20', '2026-09-11');
  assert.equal(schedule.length, 3);
  assert.deepEqual(schedule.map((s) => s.key), ['t_minus_6m', 't_minus_3m', 't_minus_45d']);
  assert.equal(schedule[0]!.dueOn, '2026-05-20');
  assert.equal(schedule[0]!.passed, true);
  assert.equal(schedule[1]!.dueOn, '2026-08-20');
  assert.equal(schedule[1]!.passed, true);
  assert.equal(schedule[2]!.dueOn, '2026-10-06');
  assert.equal(schedule[2]!.passed, false);
});

test('business days skip weekends and configured holidays', () => {
  // 2026-09-11 is a Friday.
  const cal: BusinessCalendar = {
    ...DEFAULT_BUSINESS_CALENDAR,
    holidays: ['2026-09-14'], // the following Monday
  };
  assert.equal(isBusinessDay('2026-09-11', cal), true, 'Friday');
  assert.equal(isBusinessDay('2026-09-12', cal), false, 'Saturday');
  assert.equal(isBusinessDay('2026-09-13', cal), false, 'Sunday');
  assert.equal(isBusinessDay('2026-09-14', cal), false, 'statutory holiday');
  assert.equal(isBusinessDay('2026-09-15', cal), true, 'Tuesday');

  // One business day after Friday, with Monday a holiday, is Tuesday.
  assert.equal(addBusinessDays('2026-09-11', 1, cal), '2026-09-15');
  assert.equal(addBusinessDays('2026-09-11', 1, DEFAULT_BUSINESS_CALENDAR), '2026-09-14');
  assert.equal(addBusinessDays('2026-09-15', -1, cal), '2026-09-11', 'backwards');
  assert.equal(addBusinessDays('2026-09-11', 0, cal), '2026-09-11');
});

test('businessDaysBetween does not count the weekend an SLA fell over', () => {
  // Friday to Monday is one business day, not three calendar days. This is the
  // difference between a real alert list and one people learn to ignore.
  assert.equal(businessDaysBetween('2026-09-11', '2026-09-14', DEFAULT_BUSINESS_CALENDAR), 1);
  assert.equal(businessDaysBetween('2026-09-11', '2026-09-18', DEFAULT_BUSINESS_CALENDAR), 5);
  assert.equal(businessDaysBetween('2026-09-11', '2026-09-11', DEFAULT_BUSINESS_CALENDAR), 0);
  assert.equal(businessDaysBetween('2026-09-14', '2026-09-11', DEFAULT_BUSINESS_CALENDAR), -1,
    'signed');
});

test('addBusinessDays refuses a calendar with no working days rather than hanging', () => {
  assert.throws(
    () => addBusinessDays('2026-09-11', 1, { ...DEFAULT_BUSINESS_CALENDAR, workingDays: [] }),
    /check the calendar/,
  );
});

test('quiet hours wrap midnight', () => {
  const tz = 'America/Toronto';
  // 2026-09-11T23:30Z is 19:30 in Toronto (EDT, UTC-4) — sendable.
  assert.equal(isWithinQuietHours(new Date('2026-09-11T23:30:00Z'), tz, DEFAULT_QUIET_HOURS), false);
  // 2026-09-12T02:00Z is 22:00 in Toronto — quiet.
  assert.equal(isWithinQuietHours(new Date('2026-09-12T02:00:00Z'), tz, DEFAULT_QUIET_HOURS), true);
  // 2026-09-12T10:00Z is 06:00 in Toronto — still quiet.
  assert.equal(isWithinQuietHours(new Date('2026-09-12T10:00:00Z'), tz, DEFAULT_QUIET_HOURS), true);
  // 2026-09-12T13:00Z is 09:00 in Toronto — sendable.
  assert.equal(isWithinQuietHours(new Date('2026-09-12T13:00:00Z'), tz, DEFAULT_QUIET_HOURS), false);
  // Disabled means never quiet.
  assert.equal(
    isWithinQuietHours(new Date('2026-09-12T05:00:00Z'), tz, { ...DEFAULT_QUIET_HOURS, enabled: false }),
    false,
  );
});

test('quiet hours are evaluated in the brokerage zone, not the server zone', () => {
  // The same instant is quiet in Toronto and sendable in Vancouver.
  const at = new Date('2026-09-12T04:00:00Z'); // 00:00 Toronto, 21:00 Vancouver
  assert.equal(isWithinQuietHours(at, 'America/Toronto', DEFAULT_QUIET_HOURS), true);
  assert.equal(
    isWithinQuietHours(at, 'America/Vancouver', { ...DEFAULT_QUIET_HOURS, startHour: 22 }),
    false,
  );
});

test('nextSendableTime moves a quiet-hours send to the morning and leaves others alone', () => {
  const tz = 'America/Toronto';
  const fine = new Date('2026-09-11T18:00:00Z'); // 14:00 Toronto
  assert.equal(nextSendableTime(fine, tz, DEFAULT_QUIET_HOURS).getTime(), fine.getTime(),
    'an already-sendable time is returned unchanged');

  const quiet = new Date('2026-09-12T05:00:00Z'); // 01:00 Toronto
  const moved = nextSendableTime(quiet, tz, DEFAULT_QUIET_HOURS);
  assert.ok(moved.getTime() > quiet.getTime());
  assert.equal(isWithinQuietHours(moved, tz, DEFAULT_QUIET_HOURS), false);
  const parts = localParts(moved, tz);
  assert.equal(parts.hour, 8, 'resumes at the configured end hour');
});

test('localParts reports midnight as hour 0, never 24', () => {
  const midnight = new Date('2026-09-12T04:00:00Z'); // 00:00 Toronto
  assert.equal(localParts(midnight, 'America/Toronto').hour, 0);
});

test('todayIn respects the zone, not the server', () => {
  // 2026-09-12T02:00Z is still 11 September in Toronto.
  const at = new Date('2026-09-12T02:00:00Z');
  assert.equal(todayIn('America/Toronto', at), '2026-09-11');
  assert.equal(todayIn('UTC', at), '2026-09-12');
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
});

test('quiet hours end at 08:30, not 08:00', () => {
  const tz = 'America/Toronto';
  // 08:15 local is still quiet; the window runs to 08:30 (answer 27).
  const quarterPast = new Date('2026-09-15T12:15:00Z'); // 08:15 EDT
  assert.equal(isWithinQuietHours(quarterPast, tz, DEFAULT_QUIET_HOURS), true);

  const halfPast = new Date('2026-09-15T12:30:00Z'); // 08:30 EDT
  assert.equal(isWithinQuietHours(halfPast, tz, DEFAULT_QUIET_HOURS), false);

  // Something queued at 08:15 waits the fifteen minutes, not the full hour.
  const sendable = nextSendableTime(quarterPast, tz, DEFAULT_QUIET_HOURS);
  assert.equal(sendable.toISOString(), '2026-09-15T12:30:00.000Z');
});

test('quiet hours still cover the evening side of the window', () => {
  const tz = 'America/Toronto';
  assert.equal(isWithinQuietHours(new Date('2026-09-16T00:59:00Z'), tz, DEFAULT_QUIET_HOURS), false); // 20:59
  assert.equal(isWithinQuietHours(new Date('2026-09-16T01:00:00Z'), tz, DEFAULT_QUIET_HOURS), true);  // 21:00
});
