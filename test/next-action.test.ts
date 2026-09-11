import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prioritise, suggestionsFor, type FileFacts } from '../src/domain/next-action.ts';

const TODAY = '2026-09-11';
const NOW = new Date('2026-09-11T15:00:00Z');

const facts = (over: Partial<FileFacts> = {}): FileFacts => ({
  applicationId: 'app-1', customerId: 'cust-1', clientName: 'John Smith',
  stageKey: 'application', stageCategory: 'open',
  closingDate: null, maturityDate: null, percentComplete: 100,
  conditionsOutstanding: 0, complianceOutstandingRequired: 0, complianceApproved: true,
  documentsOutstanding: 0, oldestDocumentRequestDays: null, documentsAwaitingReview: 0,
  awaitingReplySince: null, lastContactedAt: '2026-09-10T15:00:00Z', createdAt: '2026-09-01T15:00:00Z',
  hasFutureTask: true, overdueTaskCount: 0, nextAppointmentAt: null, lastAppointmentNoShow: false,
  scarlettDealId: null, scarlettSyncState: null, ...over,
});

const rules = (s: ReturnType<typeof suggestionsFor>) => s.map((x) => x.rule);

test('a lost file generates no work at all', () => {
  // Without this, every lost file in the brokerage's history competes for the
  // top of somebody's list.
  const s = suggestionsFor(
    facts({ stageCategory: 'lost', conditionsOutstanding: 3, closingDate: '2026-09-13',
            overdueTaskCount: 2, awaitingReplySince: '2026-09-11T09:00:00Z' }),
    TODAY, NOW,
  );
  assert.deepEqual(s, []);
});

test('closing soon with conditions outstanding is the critical case', () => {
  const s = suggestionsFor(
    facts({ closingDate: '2026-09-15', conditionsOutstanding: 2 }), TODAY, NOW,
  );
  const top = s[0]!;
  assert.equal(top.rule, 'closing_conditions_outstanding');
  assert.equal(top.priority, 'critical');
  assert.equal(top.action, 'Resolve lender conditions');
  assert.equal(top.reason, 'Closes in 4 days; 2 lender conditions outstanding.');
});

test('every suggestion carries its evidence, never a bare score', () => {
  const s = suggestionsFor(
    facts({ closingDate: '2026-09-13', conditionsOutstanding: 1, complianceApproved: false,
            complianceOutstandingRequired: 2, documentsOutstanding: 3 }),
    TODAY, NOW,
  );
  assert.ok(s.length >= 3);
  for (const sug of s) {
    assert.ok(sug.reason.length > 0, `${sug.rule} has no reason`);
    assert.ok(sug.action.length > 0, `${sug.rule} has no action`);
    assert.notEqual(sug.action, sug.reason, `${sug.rule} repeats itself`);
  }
  const compliance = s.find((x) => x.rule === 'closing_without_compliance')!;
  assert.match(compliance.reason, /Closes in 2 days/);
  assert.match(compliance.reason, /2 items outstanding/);
});

test('a file can produce several suggestions and they are not collapsed', () => {
  // "Closes in four days" and "the client replied two hours ago" are two
  // different pieces of work; hiding the second behind the first loses it.
  const s = suggestionsFor(
    facts({ closingDate: '2026-09-15', conditionsOutstanding: 1,
            awaitingReplySince: '2026-09-11T13:00:00Z' }),
    TODAY, NOW,
  );
  assert.ok(rules(s).includes('closing_conditions_outstanding'));
  assert.ok(rules(s).includes('client_awaiting_reply'));
});

test('an imminent appointment outranks everything', () => {
  const s = suggestionsFor(
    facts({ nextAppointmentAt: '2026-09-11T15:20:00Z', closingDate: '2026-09-12',
            conditionsOutstanding: 4 }),
    TODAY, NOW,
  );
  assert.equal(s[0]!.rule, 'appointment_imminent');
  assert.match(s[0]!.reason, /begins in 20 minutes/);
});

test('a closing date that has passed without funding is flagged', () => {
  const s = suggestionsFor(facts({ closingDate: '2026-09-08' }), TODAY, NOW);
  const passed = s.find((x) => x.rule === 'closing_date_passed')!;
  assert.ok(passed);
  assert.match(passed.reason, /passed 3 days ago/);
  // But not once it has funded.
  const funded = suggestionsFor(
    facts({ closingDate: '2026-09-08', stageCategory: 'won' }), TODAY, NOW,
  );
  assert.equal(rules(funded).includes('closing_date_passed'), false);
});

test('a reply waiting inside the SLA is medium, past it is high', () => {
  const fresh = suggestionsFor(facts({ awaitingReplySince: '2026-09-11T14:00:00Z' }), TODAY, NOW);
  assert.equal(fresh.find((x) => x.rule === 'client_awaiting_reply')!.priority, 'medium', '1 hour');
  const stale = suggestionsFor(facts({ awaitingReplySince: '2026-09-11T05:00:00Z' }), TODAY, NOW);
  assert.equal(stale.find((x) => x.rule === 'client_awaiting_reply')!.priority, 'high', '10 hours');
});

test('a reply less than an hour old is not described as "0 hours ago"', () => {
  const s = suggestionsFor(facts({ awaitingReplySince: '2026-09-11T14:40:00Z' }), TODAY, NOW);
  assert.match(s.find((x) => x.rule === 'client_awaiting_reply')!.reason, /less than an hour ago/);
});

test('an incomplete application only surfaces once it is stale and unscheduled', () => {
  const scheduled = facts({ percentComplete: 40, createdAt: '2026-09-01T15:00:00Z', hasFutureTask: true });
  assert.equal(rules(suggestionsFor(scheduled, TODAY, NOW)).includes('application_incomplete_stale'), false,
    'somebody is already on it');

  const unscheduled = { ...scheduled, hasFutureTask: false };
  const s = suggestionsFor(unscheduled, TODAY, NOW);
  assert.ok(rules(s).includes('application_incomplete_stale'));
  assert.match(s.find((x) => x.rule === 'application_incomplete_stale')!.reason,
    /40% complete, started 10 days ago/);

  const brandNew = { ...unscheduled, createdAt: '2026-09-11T05:00:00Z' };
  assert.equal(rules(suggestionsFor(brandNew, TODAY, NOW)).includes('application_incomplete_stale'), false,
    '10 hours old is not stale');
});

test('a no-show surfaces only while nothing is scheduled', () => {
  const open = facts({ lastAppointmentNoShow: true, hasFutureTask: false });
  assert.ok(rules(suggestionsFor(open, TODAY, NOW)).includes('no_show_rebook'));
  const rebooked = { ...open, hasFutureTask: true };
  assert.equal(rules(suggestionsFor(rebooked, TODAY, NOW)).includes('no_show_rebook'), false);
});

test('renewal milestones fire on the day, not forever afterwards', () => {
  const at = (maturity: string) =>
    rules(suggestionsFor(facts({ maturityDate: maturity }), TODAY, NOW));
  assert.ok(at('2027-03-10').includes('renewal_milestone'), 'T-180');
  assert.ok(at('2026-12-10').includes('renewal_milestone'), 'T-90');
  assert.ok(at('2026-10-26').includes('renewal_milestone'), 'T-45');
  assert.equal(at('2026-11-15').includes('renewal_milestone'), false, 'between milestones');
  assert.equal(at('2026-09-01').includes('renewal_milestone'), false, 'already matured');
});

test('a T-45 renewal is higher priority than a T-180 one', () => {
  const near = suggestionsFor(facts({ maturityDate: '2026-10-26' }), TODAY, NOW)[0]!;
  const far = suggestionsFor(facts({ maturityDate: '2027-03-10' }), TODAY, NOW)[0]!;
  assert.equal(near.priority, 'high');
  assert.equal(far.priority, 'medium');
});

test('a failed Scarlett sync is work, a healthy one is not', () => {
  assert.ok(rules(suggestionsFor(facts({ scarlettSyncState: 'error' }), TODAY, NOW))
    .includes('scarlett_sync_failed'));
  assert.equal(rules(suggestionsFor(facts({ scarlettSyncState: 'ok' }), TODAY, NOW))
    .includes('scarlett_sync_failed'), false);
});

test('prioritise ranks across files, critical first, and caps the list', () => {
  const files = [
    facts({ applicationId: 'quiet', lastContactedAt: '2026-08-01T00:00:00Z', hasFutureTask: false }),
    facts({ applicationId: 'urgent', closingDate: '2026-09-13', conditionsOutstanding: 2 }),
    facts({ applicationId: 'reply', awaitingReplySince: '2026-09-11T04:00:00Z' }),
    facts({ applicationId: 'docs', documentsAwaitingReview: 3 }),
  ];
  const top = prioritise(files, TODAY, NOW, undefined, 3);
  assert.equal(top.length, 3, 'capped');
  assert.equal(top[0]!.priority, 'critical');
  assert.equal(top[0]!.applicationId, 'urgent');
  assert.equal(top[1]!.applicationId, 'reply', 'high beats medium');
});

test('plurals read correctly at one', () => {
  const s = suggestionsFor(
    facts({ closingDate: '2026-09-12', conditionsOutstanding: 1, overdueTaskCount: 1,
            documentsAwaitingReview: 1 }),
    TODAY, NOW,
  );
  const text = s.map((x) => x.reason).join(' | ');
  assert.match(text, /Closes in 1 day;/);
  assert.match(text, /1 lender condition outstanding/);
  assert.match(text, /1 task past due/);
  assert.match(text, /uploaded 1 document that/);
  assert.equal(/1 days|1 conditions|1 tasks|1 documents/.test(text), false, text);
});
