/**
 * Campaigns, against a real database.
 *
 * The whole point of these is the consent arithmetic: that the audience is
 * built through the same gate every other send uses, that the number shown
 * is the number that will be sent, and that an unsubscribe actually stops
 * the next campaign without stopping mail about the client's own mortgage.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { buildAudience, freezeAudience } from '../../src/services/campaigns.ts';
import { unsubscribeToken, verifyUnsubscribeToken } from '../../src/services/unsubscribe.ts';
import { describeAudience } from '../../src/domain/segment.ts';

let orgId: string;
let clients: Record<string, string> = {};

before(async () => { await migrate(); });

after(async () => { await pool.end(); });

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');

  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Test','ON') RETURNING id`)
  ).rows[0]!.id;

  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
     VALUES ($1,'application','Application',10,'open',true)`, [orgId]);

  clients = {};
  for (const [name, email] of [
    ['consented', 'consented@example.com'],
    ['implied', 'implied@example.com'],
    ['none', 'none@example.com'],
    ['unsubscribed', 'unsub@example.com'],
    ['noaddress', ''],
  ] as Array<[string, string]>) {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO customers (organization_id, first_name, last_name, email)
       VALUES ($1,$2,'Client',$3) RETURNING id`,
      [orgId, name, email || null]);
    clients[name] = rows[0]!.id;
    await query(
      `INSERT INTO applications (organization_id, customer_id, property_province, stage_key)
       VALUES ($1,$2,'ON','application')`, [orgId, rows[0]!.id]);
  }

  await query(
    `INSERT INTO consents (organization_id, customer_id, channel, purpose, basis, granted, source)
     VALUES ($1,$2,'email','marketing','express',true,'crm')`, [orgId, clients.consented]);
  await query(
    `INSERT INTO consents (organization_id, customer_id, channel, purpose, basis, granted, source,
                           collected_at)
     VALUES ($1,$2,'email','marketing','implied',true,'crm', now() - interval '30 days')`,
    [orgId, clients.implied]);
  await query(
    `INSERT INTO consents (organization_id, customer_id, channel, purpose, basis, granted, source)
     VALUES ($1,$2,'email','marketing','express',true,'crm')`, [orgId, clients.unsubscribed]);
  await query(
    `INSERT INTO suppressions (organization_id, customer_id, address, channel, scope, reason)
     VALUES ($1,$2,'unsub@example.com','email','marketing','unsubscribe')`,
    [orgId, clients.unsubscribed]);
});

test('the audience separates who matches from who can be sent to', async () => {
  const audience = await buildAudience(orgId, {}, 'email', 'marketing');

  assert.equal(audience.count.matched, 5, 'everybody matches an empty segment');
  assert.equal(audience.count.sendable, 2, 'only the two with a live consent');

  const reasons = Object.fromEntries(
    audience.count.suppressed.map((s) => [s.reason, s.count]));
  assert.deepEqual(reasons, {
    'have no consent for this': 1,
    'have unsubscribed': 1,
    'have no address on file': 1,
  }, JSON.stringify(audience.members, null, 1));
});

test('the sentence above the send button leads with the real number', async () => {
  const audience = await buildAudience(orgId, {}, 'email', 'marketing');
  const sentence = describeAudience(audience.count, 'email');
  assert.match(sentence, /^2 of 5 matching client\(s\) will receive this\./);
});

test('a transactional send reaches everybody with an address', async () => {
  // The same segment, the same gate, a different purpose: a message about
  // the client's own mortgage is not a commercial electronic message.
  const audience = await buildAudience(orgId, {}, 'email', 'transactional');
  assert.equal(audience.count.sendable, 4);
  assert.equal(audience.count.suppressed[0]!.reason, 'have no address on file');
});

test('the frozen audience records the suppressed, with their reasons', async () => {
  const campaign = await queryOne<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, channel, purpose, status)
     VALUES ($1,'Test','email','marketing','draft') RETURNING id`, [orgId]);

  await freezeAudience(campaign!.id, orgId, {}, 'email', 'marketing');

  const rows = await query<{ status: string; suppress_reason: string | null }>(
    `SELECT status, suppress_reason FROM campaign_recipients WHERE campaign_id = $1`,
    [campaign!.id]);
  assert.equal(rows.rows.length, 5, 'a suppressed recipient is a row, not an absence');
  assert.equal(rows.rows.filter((r) => r.status === 'pending').length, 2);
  assert.equal(rows.rows.filter((r) => r.status === 'suppressed').length, 3);
  assert.ok(rows.rows.filter((r) => r.status === 'suppressed')
    .every((r) => r.suppress_reason), 'every one says why');

  const snapshot = await queryOne<{ audience_snapshot: { matched: number; sendable: number } }>(
    'SELECT audience_snapshot FROM campaigns WHERE id = $1', [campaign!.id]);
  assert.equal(snapshot!.audience_snapshot.matched, 5);
  assert.equal(snapshot!.audience_snapshot.sendable, 2);
});

test('re-freezing replaces the audience rather than doubling it', async () => {
  const campaign = await queryOne<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, channel, purpose, status)
     VALUES ($1,'Test','email','marketing','draft') RETURNING id`, [orgId]);
  await freezeAudience(campaign!.id, orgId, {}, 'email', 'marketing');
  await freezeAudience(campaign!.id, orgId, {}, 'email', 'marketing');
  const rows = await query('SELECT 1 FROM campaign_recipients WHERE campaign_id = $1',
    [campaign!.id]);
  assert.equal(rows.rows.length, 5);
});

test('a client with three applications gets one copy, not three', async () => {
  // A campaign sends to a person, not to a file.
  for (let i = 0; i < 2; i++) {
    await query(
      `INSERT INTO applications (organization_id, customer_id, property_province, stage_key)
       VALUES ($1,$2,'ON','application')`, [orgId, clients.consented]);
  }
  const audience = await buildAudience(orgId, {}, 'email', 'marketing');
  const appearances = audience.members.filter((m) => m.customer_id === clients.consented);
  assert.equal(appearances.length, 1);
});

test('a segment filters, and the arithmetic is done on what it returned', async () => {
  await query(`UPDATE applications SET property_province = 'BC'
                WHERE customer_id = $1`, [clients.consented]);

  const ontario = await buildAudience(orgId, {
    criteria: [{ field: 'province', op: 'eq', value: 'ON' }],
  }, 'email', 'marketing');
  assert.equal(ontario.count.matched, 4);
  assert.equal(ontario.count.sendable, 1, 'the implied consent only');
});

// ── The unsubscribe link ───────────────────────────────────────────────────

test('an unsubscribe token round-trips, and a forged one does not', () => {
  const token = unsubscribeToken(orgId, clients.consented!);
  assert.equal(verifyUnsubscribeToken(token, orgId), clients.consented);

  // Somebody else's organisation cannot read it.
  assert.equal(verifyUnsubscribeToken(token, '00000000-0000-0000-0000-000000000000'), null);
  // And the signature cannot be replaced.
  assert.equal(
    verifyUnsubscribeToken(`${clients.consented}.${'A'.repeat(32)}`, orgId), null);
  // Nor can one customer's token be pointed at another.
  assert.equal(
    verifyUnsubscribeToken(`${clients.none}.${token.split('.')[1]}`, orgId), null);
});

test('a token is stable, because the client keeps the email', () => {
  // No expiry and no stored row: an unsubscribe link that has expired is an
  // unsubscribe link that does not work.
  assert.equal(
    unsubscribeToken(orgId, clients.consented!),
    unsubscribeToken(orgId, clients.consented!));
});

test('an unsubscribe stops the next campaign and nothing about their own file', async () => {
  await query(
    `INSERT INTO suppressions (organization_id, customer_id, address, channel, scope, reason)
     VALUES ($1,$2,'consented@example.com','email','marketing','unsubscribe')`,
    [orgId, clients.consented]);

  const marketing = await buildAudience(orgId, {}, 'email', 'marketing');
  assert.ok(!marketing.members.find((m) => m.customer_id === clients.consented)?.allowed);

  const transactional = await buildAudience(orgId, {}, 'email', 'transactional');
  assert.ok(transactional.members.find((m) => m.customer_id === clients.consented)?.allowed,
    'a marketing unsubscribe does not stop mail about the mortgage they asked us to arrange');
});
