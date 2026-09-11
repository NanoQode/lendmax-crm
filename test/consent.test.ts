import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyInboundKeyword, currentConsent, evaluateSend, summariseAudience,
  DEFAULT_CONSENT_RULES, type ConsentRecord, type SuppressionRecord,
} from '../src/domain/consent.ts';

const NOW = new Date('2026-09-11T15:00:00Z');

const express = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  channel: 'email', purpose: 'marketing', basis: 'express', granted: true,
  collected_at: '2026-01-15T10:00:00Z', ...over,
});
const implied = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  channel: 'email', purpose: 'marketing', basis: 'implied', granted: true,
  collected_at: '2026-01-15T10:00:00Z', ...over,
});
const base = {
  channel: 'email' as const, address: 'client@example.com',
  consents: [] as ConsentRecord[], suppressions: [] as SuppressionRecord[], now: NOW,
};

test('a transactional message goes out with no marketing consent at all', () => {
  // The client asked us to arrange a mortgage. Telling them their conditions
  // are outstanding is not a commercial electronic message.
  const d = evaluateSend({ ...base, purpose: 'transactional' });
  assert.equal(d.allowed, true);
  assert.equal(d.code, 'allowed_transactional');
});

test('a marketing unsubscribe does not stop transactional mail about their own file', () => {
  const d = evaluateSend({
    ...base,
    purpose: 'transactional',
    suppressions: [{ channel: 'email', scope: 'marketing', reason: 'unsubscribe' }],
  });
  assert.equal(d.allowed, true, 'the client still needs to hear about their closing');
});

test('but an explicit withdrawal of contact about the application does stop it', () => {
  const d = evaluateSend({
    ...base,
    purpose: 'transactional',
    consents: [{
      channel: 'email', purpose: 'transactional', basis: 'withdrawn',
      granted: false, collected_at: '2026-06-01T10:00:00Z',
    }],
  });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'consent_withdrawn');
});

test('a hard bounce stops everything on that address, transactional included', () => {
  // Continuing to send to a bouncing address destroys the sending domain and
  // does not reach the client either way.
  for (const purpose of ['transactional', 'marketing'] as const) {
    const d = evaluateSend({
      ...base, purpose,
      suppressions: [{ channel: 'email', scope: 'all', reason: 'hard_bounce' }],
    });
    assert.equal(d.allowed, false, purpose);
    assert.equal(d.code, 'hard_bounce', purpose);
    assert.match(d.reason, /working address/);
  }
});

test('marketing needs a basis; absence is a refusal with a reason', () => {
  const d = evaluateSend({ ...base, purpose: 'marketing' });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'no_consent');
  assert.match(d.reason, /No marketing consent on file for email/);
});

test('express consent does not expire on its own', () => {
  const d = evaluateSend({
    ...base, purpose: 'marketing',
    consents: [express({ collected_at: '2019-01-01T00:00:00Z' })],
  });
  assert.equal(d.allowed, true, 'seven years old and still express');
  assert.equal(d.code, 'allowed_express');
});

test('express consent with an explicit expiry is honoured', () => {
  const d = evaluateSend({
    ...base, purpose: 'marketing',
    consents: [express({ expires_at: '2026-08-01T00:00:00Z' })],
  });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'implied_expired');
  assert.match(d.reason, /2026-08-01/);
});

test('implied consent lapses on the configured window', () => {
  const fresh = evaluateSend({
    ...base, purpose: 'marketing',
    consents: [implied({ collected_at: '2025-06-01T00:00:00Z' })],
  });
  assert.equal(fresh.allowed, true, '15 months old, inside a 24-month window');
  assert.equal(fresh.code, 'allowed_implied');
  assert.match(fresh.reason, /valid until 2027-06-01/);

  const stale = evaluateSend({
    ...base, purpose: 'marketing',
    consents: [implied({ collected_at: '2024-01-01T00:00:00Z' })],
  });
  assert.equal(stale.allowed, false);
  assert.equal(stale.code, 'implied_expired');
  assert.match(stale.reason, /lapsed on 2026-01-01/);
});

test('the implied window is configuration, not a constant', () => {
  const consents = [implied({ collected_at: '2025-01-01T00:00:00Z' })];
  const short = evaluateSend({
    ...base, purpose: 'marketing', consents,
    rules: { ...DEFAULT_CONSENT_RULES, impliedConsentMonths: 6 },
  });
  assert.equal(short.allowed, false, '6-month window: lapsed');
  const long = evaluateSend({
    ...base, purpose: 'marketing', consents,
    rules: { ...DEFAULT_CONSENT_RULES, impliedConsentMonths: 36 },
  });
  assert.equal(long.allowed, true, '36-month window: live');
});

test('marketing SMS refuses an implied basis when express is required', () => {
  const ctx = {
    ...base, channel: 'sms' as const, address: '+16475551234', purpose: 'marketing' as const,
    consents: [implied({ channel: 'sms' })],
  };
  const strict = evaluateSend(ctx);
  assert.equal(strict.allowed, false);
  assert.equal(strict.code, 'express_required');

  const relaxed = evaluateSend({
    ...ctx, rules: { ...DEFAULT_CONSENT_RULES, smsMarketingRequiresExpress: false },
  });
  assert.equal(relaxed.allowed, true, 'the rule is configuration');
});

test('a STOP keyword suppression is reported in the client’s own terms', () => {
  const d = evaluateSend({
    ...base, channel: 'sms', address: '+16475551234', purpose: 'marketing',
    consents: [express({ channel: 'sms' })],
    suppressions: [{ channel: 'sms', scope: 'marketing', reason: 'stop_keyword' }],
  });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'suppressed');
  assert.equal(d.reason, 'The client texted STOP.');
});

test('cross-channel unsubscribe is off by default and configurable on', () => {
  const ctx = {
    ...base, channel: 'sms' as const, address: '+16475551234', purpose: 'marketing' as const,
    consents: [express({ channel: 'sms' })],
    suppressions: [{ channel: 'email' as const, scope: 'marketing' as const, reason: 'unsubscribe' }],
  };
  assert.equal(evaluateSend(ctx).allowed, true, 'an email unsubscribe does not stop SMS by default');
  assert.equal(
    evaluateSend({ ...ctx, rules: { ...DEFAULT_CONSENT_RULES, unsubscribeAppliesAcrossChannels: true } }).allowed,
    false,
  );
});

test('a removed suppression no longer suppresses', () => {
  const d = evaluateSend({
    ...base, purpose: 'marketing', consents: [express()],
    suppressions: [{ channel: 'email', scope: 'marketing', reason: 'unsubscribe', removed_at: '2026-08-01T00:00:00Z' }],
  });
  assert.equal(d.allowed, true);
});

test('no address is a refusal, not a crash', () => {
  assert.equal(evaluateSend({ ...base, purpose: 'transactional', address: null }).code, 'no_address');
  assert.equal(evaluateSend({ ...base, purpose: 'transactional', address: '   ' }).code, 'no_address');
});

test('a merged customer sends from the surviving record', () => {
  const d = evaluateSend({ ...base, purpose: 'transactional', mergedInto: 'other-id' });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'customer_merged');
});

test('currentConsent takes the newest by collection time, not by array order', () => {
  // The failure this guards: a consent imported from the portal is written to
  // the table after a later CRM withdrawal, and wins because it was inserted
  // second.
  const consents: ConsentRecord[] = [
    { channel: 'email', purpose: 'marketing', basis: 'express', granted: true, collected_at: '2026-01-01T00:00:00Z' },
    { channel: 'email', purpose: 'marketing', basis: 'withdrawn', granted: false, collected_at: '2026-07-01T00:00:00Z' },
    { channel: 'email', purpose: 'marketing', basis: 'express', granted: true, collected_at: '2026-03-01T00:00:00Z' },
  ];
  assert.equal(currentConsent(consents, 'email', 'marketing')!.basis, 'withdrawn');
  assert.equal(evaluateSend({ ...base, purpose: 'marketing', consents }).allowed, false);
});

test('a consent recorded for "any" channel covers a specific one', () => {
  const d = evaluateSend({
    ...base, purpose: 'marketing',
    consents: [express({ channel: 'any' })],
  });
  assert.equal(d.allowed, true);
});

test('STOP detection is strict about what counts as an opt-out', () => {
  assert.equal(classifyInboundKeyword('STOP'), 'stop');
  assert.equal(classifyInboundKeyword('  stop  '), 'stop');
  assert.equal(classifyInboundKeyword('Stop.'), 'stop');
  assert.equal(classifyInboundKeyword('unsubscribe'), 'stop');
  assert.equal(classifyInboundKeyword('ARRÊT'), 'stop');
  assert.equal(classifyInboundKeyword('START'), 'start');
  assert.equal(classifyInboundKeyword('yes'), 'start');

  // The one that matters: a client who writes a sentence has not opted out.
  assert.equal(classifyInboundKeyword('please stop by the office tomorrow'), null);
  assert.equal(classifyInboundKeyword('can you stop the appraisal'), null);
  assert.equal(classifyInboundKeyword('Yes I can make 2pm'), null);
  assert.equal(classifyInboundKeyword(''), null);
  assert.equal(classifyInboundKeyword(null), null);
});

test('summariseAudience produces the arithmetic a campaign screen must show', () => {
  const decisions = [
    ...Array.from({ length: 3 }, () => evaluateSend({ ...base, purpose: 'marketing', consents: [express()] })),
    evaluateSend({ ...base, purpose: 'marketing' }),
    evaluateSend({ ...base, purpose: 'marketing' }),
    evaluateSend({
      ...base, purpose: 'marketing', consents: [express()],
      suppressions: [{ channel: 'email', scope: 'marketing', reason: 'unsubscribe' }],
    }),
  ];
  const summary = summariseAudience(decisions);
  assert.equal(summary.matched, 6);
  assert.equal(summary.eligible, 3);
  assert.equal(summary.suppressed, 3);
  assert.deepEqual(summary.byReason, { no_consent: 2, suppressed: 1 });
});
