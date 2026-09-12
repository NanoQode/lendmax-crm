/**
 * Segments and campaign content.
 *
 * The properties that matter: a segment is structure and never SQL, a
 * commercial message cannot go out without the things CASL requires on it,
 * and the audience arithmetic leads with the number that will actually be
 * sent rather than the number that matched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSegment, describeAudience, describeSegment, validateSegment,
} from '../src/domain/segment.ts';
import { BlockSchema, renderCampaign, renderSms, sendBlockers, type Block } from '../src/domain/blocks.ts';

const footer = {
  organizationName: 'Lendmax',
  physicalAddress: '1 King Street West, Toronto ON M5H 1A1',
  unsubscribeUrl: 'https://lendmax.ca/crm/u/abc',
  brokerageLicence: 'FSRA #12345',
};

const context = {
  values: {
    first_name: 'Sarah', user_name: 'Michael Chen', user_cell: '(416) 555-0142',
    maturity_date: '2027-06-30', organization_name: 'Lendmax',
  },
};

// ── Segments ───────────────────────────────────────────────────────────────

test('a value always becomes a bound parameter, never inline SQL', () => {
  const built = buildSegment({
    criteria: [{ field: 'city', op: 'eq', value: "Toronto'; DROP TABLE customers; --" }],
  });
  assert.match(built.where, /\$1/);
  assert.equal(built.params[0], "Toronto'; DROP TABLE customers; --");
  assert.doesNotMatch(built.where, /DROP TABLE/);
});

test('parameters can start from an offset so the fragment drops into a bigger query', () => {
  const built = buildSegment({
    criteria: [
      { field: 'province', op: 'eq', value: 'ON' },
      { field: 'amount_requested', op: 'gte', value: 500000 },
    ],
  }, 3);
  assert.match(built.where, /\$4/);
  assert.match(built.where, /\$5/);
  assert.equal(built.params.length, 2);
});

test('a filter that does not exist is refused rather than quietly ignored', () => {
  const issues = validateSegment({ criteria: [{ field: 'secret_score', op: 'gt', value: 5 }] });
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /no filter called "secret_score"/);

  // And it contributes nothing to the query, so a saved-anyway segment cannot
  // silently widen the audience.
  const built = buildSegment({ criteria: [{ field: 'secret_score', op: 'gt', value: 5 }] });
  assert.equal(built.where, 'TRUE');
});

test('"not contacted in ninety days" includes people never contacted at all', () => {
  // The bug this pins: a NULL last_contacted_at fails every comparison, so
  // the clients who have been most neglected drop out of the re-engagement
  // campaign aimed at them.
  const built = buildSegment({
    criteria: [{ field: 'last_contacted', op: 'older_than_days', value: 90 }],
  });
  assert.match(built.where, /IS NULL OR/);
  assert.match(describeSegment({
    criteria: [{ field: 'last_contacted', op: 'older_than_days', value: 90 }],
  }), /or never/);
});

test('a tag match is membership, not a substring', () => {
  // "renew" must not match a client tagged "do-not-renew".
  const built = buildSegment({ criteria: [{ field: 'tag', op: 'contains', value: 'renew' }] });
  assert.match(built.where, /= ANY\(/);
  assert.doesNotMatch(built.where, /ILIKE/);
});

test('a segment explains itself in a sentence', () => {
  assert.equal(
    describeSegment({
      criteria: [
        { field: 'province', op: 'eq', value: 'ON' },
        { field: 'days_to_maturity', op: 'lte', value: 180 },
      ],
    }),
    'Clients where Property province is ON, and Days to maturity is at most 180.');
  assert.equal(describeSegment({}), 'Every client.');
});

test('an empty segment matches everybody, and says so rather than matching nobody', () => {
  assert.equal(buildSegment({}).where, 'TRUE');
});

// ── The audience arithmetic ────────────────────────────────────────────────

test('the audience sentence leads with who will actually receive it', () => {
  const sentence = describeAudience({
    matched: 4000,
    suppressed: [
      { reason: 'have no marketing consent', count: 1800 },
      { reason: 'unsubscribed', count: 190 },
      { reason: 'have no email address', count: 10 },
    ],
    sendable: 2000,
  }, 'email');
  assert.match(sentence, /^2000 of 4000 matching client\(s\) will receive this\./);
  assert.match(sentence, /1800 have no marketing consent/);
});

test('an audience of nobody says why, rather than showing a zero', () => {
  assert.match(
    describeAudience({
      matched: 40, sendable: 0,
      suppressed: [{ reason: 'have no marketing consent', count: 40 }],
    }, 'email'),
    /none of them can be sent this\. 40 have no marketing consent\./);
  assert.equal(describeAudience({ matched: 0, sendable: 0, suppressed: [] }, 'email'),
    'Nobody matches this segment.');
});

// ── Campaign content ───────────────────────────────────────────────────────

const blocks: Block[] = [
  BlockSchema.parse({ type: 'heading', text: 'Your renewal is coming up', level: 2 }),
  BlockSchema.parse({ type: 'text', text: 'Hi {first_name},\n\nYour mortgage matures on {maturity_date}.' }),
  BlockSchema.parse({ type: 'button', label: 'Book a call', href: 'https://lendmax.ca/book' }),
  BlockSchema.parse({ type: 'signature' }),
];

test('a commercial message carries the address and unsubscribe without being asked', () => {
  const rendered = renderCampaign(blocks, context, footer,
    { channel: 'email', purpose: 'marketing' });
  assert.match(rendered.html, /1 King Street West/);
  assert.match(rendered.html, /Unsubscribe from these messages/);
  assert.match(rendered.text, /Unsubscribe: https:\/\/lendmax\.ca\/crm\/u\/abc/);
});

test('a transactional message carries no unsubscribe, because it is not commercial', () => {
  const rendered = renderCampaign(blocks, context, footer,
    { channel: 'email', purpose: 'transactional' });
  assert.doesNotMatch(rendered.html, /Unsubscribe/);
});

test('a marketing campaign with no mailing address configured cannot be sent', () => {
  const problems = sendBlockers(blocks, {
    channel: 'email', purpose: 'marketing', subject: 'Your renewal',
    footer: { ...footer, physicalAddress: null },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /mailing address/);

  // The same campaign sent transactionally is not blocked on it.
  assert.deepEqual(sendBlockers(blocks, {
    channel: 'email', purpose: 'transactional', subject: 'Your renewal',
    footer: { ...footer, physicalAddress: null },
  }), []);
});

test('an email with no subject, and an image with no alt text, are both refused', () => {
  const problems = sendBlockers(
    [...blocks, BlockSchema.parse({ type: 'image', src: 'https://x/y.png', alt: '' })],
    { channel: 'email', purpose: 'marketing', subject: '  ', footer });
  assert.equal(problems.length, 2);
  assert.match(problems.join(' '), /no subject line/);
  assert.match(problems.join(' '), /no alt text/);
});

test('a dangerous link is neutralised rather than rendered', () => {
  const rendered = renderCampaign([
    BlockSchema.parse({ type: 'button', label: 'Click', href: 'javascript:alert(1)' }),
  ], context, footer);
  assert.doesNotMatch(rendered.html, /javascript:/);
  assert.match(rendered.html, /href="#"/);
});

test('content is escaped, so a client name with a bracket in it is not markup', () => {
  const rendered = renderCampaign(
    [BlockSchema.parse({ type: 'text', text: 'Hi {first_name}' })],
    { values: { first_name: '<script>alert(1)</script>' } }, footer);
  assert.doesNotMatch(rendered.html, /<script>/);
  assert.match(rendered.html, /&lt;script&gt;/);
});

test('a block whose merge field has no value is dropped, not sent blank', () => {
  const rendered = renderCampaign(blocks, { values: { user_name: 'Michael Chen' } }, footer);
  assert.doesNotMatch(rendered.text, /matures on \./);
  assert.doesNotMatch(rendered.text, /\{maturity_date\}/);
  assert.ok(rendered.missing.includes('maturity_date'));
});

test('a button whose link did not resolve is dropped, not pointed nowhere', () => {
  const rendered = renderCampaign(
    [BlockSchema.parse({ type: 'button', label: 'Finish your application',
                         href: '{application_link}' })],
    { values: {} }, footer);
  assert.doesNotMatch(rendered.html, /Finish your application/);
  assert.ok(rendered.dropped.some((d) => d.includes('Finish your application')));
});

test('an image contributes its alt text to the plain-text part', () => {
  // Most people read the plain-text alternative or have images off; an image
  // block that renders as nothing there is a gap in the message.
  const rendered = renderCampaign(
    [BlockSchema.parse({ type: 'image', src: 'https://x/rates.png', alt: 'This week’s rates' })],
    context, footer);
  assert.match(rendered.text, /\[This week’s rates\]/);
});

test('a marketing text message carries the stop instruction', () => {
  const sms = renderSms([BlockSchema.parse({ type: 'text', text: 'Hi {first_name}, rates dropped.' })],
    context, { purpose: 'marketing' });
  assert.match(sms.text, /Reply STOP to opt out\./);

  const transactional = renderSms(
    [BlockSchema.parse({ type: 'text', text: 'Hi {first_name}, your documents arrived.' })],
    context, { purpose: 'transactional' });
  assert.doesNotMatch(transactional.text, /STOP/);
});
