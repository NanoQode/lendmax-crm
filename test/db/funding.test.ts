/**
 * Funding, commission and renewals, against a real database.
 *
 * Confirming a funding is the moment several other things become true at
 * once — the file is funded, the commission is expected, the maturity date
 * is known and so is the renewal. The test that matters is that they all
 * happen, together, and that resolving a renewal actually stops the messages
 * it would otherwise keep sending.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { createSession } from '../../src/services/auth.ts';

let orgId: string;
let brokerId: string;
let underwriterId: string;
let managerId: string;
let applicationId: string;
let cookies: Record<string, string> = {};
const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;

before(async () => {
  await migrate();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/crm/api`;
});

after(async () => {
  server.close();
  await pool.end();
});

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');

  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Test','ON') RETURNING id`)
  ).rows[0]!.id;

  brokerId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, profile_complete)
     VALUES ($1,'broker@example.com','Dana Broker','broker',true,true) RETURNING id`, [orgId])
  ).rows[0]!.id;
  // A broker deliberately cannot record a funding: the figures drive the
  // commission they are paid, so entering them is somebody else's job.
  underwriterId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, profile_complete)
     VALUES ($1,'uw@example.com','Jo Underwriter','underwriter',true,true) RETURNING id`, [orgId])
  ).rows[0]!.id;
  managerId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, profile_complete)
     VALUES ($1,'manager@example.com','Sam Manager','manager',true,true) RETURNING id`, [orgId])
  ).rows[0]!.id;

  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
     VALUES ($1,'application','Application',10,'open',true),
            ($1,'funded','Funded',90,'won',true)`, [orgId]);

  const customerId = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name)
     VALUES ($1,'Test','Client') RETURNING id`, [orgId])
  ).rows[0]!.id;

  applicationId = (await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, property_province, stage_key,
                               amount_requested)
     VALUES ($1,$2,'ON','application',500000) RETURNING id`, [orgId, customerId])
  ).rows[0]!.id;

  await query(
    `INSERT INTO assignments (application_id, user_id, role, is_primary)
     VALUES ($1,$2,'broker',true)`, [applicationId, brokerId]);

  cookies = {
    broker: `lmx_crm_session=${(await createSession(brokerId, {})).token}`,
    underwriter: `lmx_crm_session=${(await createSession(underwriterId, {})).token}`,
    manager: `lmx_crm_session=${(await createSession(managerId, {})).token}`,
  };
});

async function call(
  who: 'broker' | 'underwriter' | 'manager', method: string, path: string, body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { cookie: cookies[who]!, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const goodFunding = {
  lender_name: 'First National',
  approved_amount: '$520,000',
  funded_amount: '$512,000',
  rate: 4.89,
  rate_type: 'fixed',
  term_months: 60,
  funding_date: '2026-08-31',
};

test('a rate typed as a decimal fraction is refused, with the number it meant', async () => {
  // The failure: 0.0489 is between 0 and 30, so a naive bounds check passes it
  // and every payment and renewal comparison on that file is then wrong.
  const result = await call('underwriter', 'PUT', `/applications/${applicationId}/funding`,
    { ...goodFunding, rate: 0.0489 });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /almost certainly 4\.89%/);
});

test('the funded amount may not exceed the approved amount', async () => {
  const result = await call('underwriter', 'PUT', `/applications/${applicationId}/funding`,
    { ...goodFunding, funded_amount: '600000' });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /more than the approved amount/);
});

test('the maturity date follows from the funding date and the term, clamped', async () => {
  const result = await call('underwriter', 'PUT', `/applications/${applicationId}/funding`, goodFunding);
  assert.equal(result.status, 200);
  assert.equal(result.body.maturity_date, '2031-08-31');
});

test('confirming a funding does everything it makes true, in one act', async () => {
  await call('underwriter', 'PUT', `/applications/${applicationId}/funding`, goodFunding);
  const result = await call('underwriter', 'POST', `/applications/${applicationId}/funding/confirm`, {
    commission_bps: 85,
    expected_on: '2026-09-30',
    splits: [
      { party: 'referrer', party_name: 'Kelly', amount: '500' },
      { party: 'broker', user_id: brokerId, percent: 70 },
      { party: 'brokerage', percent: 30 },
    ],
  });
  assert.equal(result.status, 200);

  const application = await queryOne<{ stage_key: string }>(
    'SELECT stage_key FROM applications WHERE id = $1', [applicationId]);
  assert.equal(application!.stage_key, 'funded');

  const transition = await queryOne<{ to_stage_key: string; reason: string }>(
    'SELECT to_stage_key, reason FROM stage_transitions WHERE application_id = $1',
    [applicationId]);
  assert.equal(transition!.to_stage_key, 'funded');
  assert.equal(transition!.reason, 'Funding confirmed');

  const commission = await queryOne<{ gross_expected: string; status: string }>(
    'SELECT gross_expected, status FROM commission_records WHERE application_id = $1',
    [applicationId]);
  assert.equal(commission!.gross_expected, '4352.00', '85bps of $512,000');
  assert.equal(commission!.status, 'expected');

  const splits = await query<{ party: string; amount: string }>(
    `SELECT party, amount FROM commission_splits s
       JOIN commission_records c ON c.id = s.commission_record_id
      WHERE c.application_id = $1 ORDER BY party`, [applicationId]);
  // The referral fee comes off the top and the percentages divide what is
  // left, so the three parts come to the commission exactly.
  assert.deepEqual(splits.rows, [
    { party: 'broker', amount: '2696.40' },
    { party: 'brokerage', amount: '1155.60' },
    { party: 'referrer', amount: '500.00' },
  ]);
  assert.equal(
    splits.rows.reduce((sum, s) => sum + Number(s.amount), 0), 4352,
    'the splits add up to the commission, which is the first thing anybody checks');

  const renewal = await queryOne<{ maturity_date: string; status: string; assigned_to: string }>(
    'SELECT maturity_date, status, assigned_to FROM renewal_records WHERE application_id = $1',
    [applicationId]);
  assert.equal(renewal!.maturity_date, '2031-08-31');
  assert.equal(renewal!.assigned_to, brokerId, 'it lands with the broker who owns the file');

  const milestones = await query<{ milestone_key: string; due_on: string; status: string }>(
    `SELECT m.milestone_key, m.due_on, m.status FROM renewal_milestones m
       JOIN renewal_records r ON r.id = m.renewal_record_id
      WHERE r.application_id = $1 ORDER BY m.due_on`, [applicationId]);
  assert.deepEqual(milestones.rows.map((m) => m.milestone_key),
    ['t_minus_6m', 't_minus_3m', 't_minus_45d']);
  assert.equal(milestones.rows[2]!.due_on, '2031-07-17');

  const event = await queryOne<{ event_type: string }>(
    `SELECT event_type FROM domain_events WHERE application_id = $1`, [applicationId]);
  assert.equal(event!.event_type, 'file.funded');
});

test('splits that do not come to a hundred stop the confirmation', async () => {
  await call('underwriter', 'PUT', `/applications/${applicationId}/funding`, goodFunding);
  const result = await call('underwriter', 'POST', `/applications/${applicationId}/funding/confirm`, {
    commission_bps: 85,
    splits: [{ party: 'broker', user_id: brokerId, percent: 70 },
             { party: 'brokerage', percent: 20 }],
  });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /10% unallocated/);

  const funding = await queryOne<{ confirmed: boolean }>(
    'SELECT confirmed FROM funding_records WHERE application_id = $1', [applicationId]);
  assert.equal(funding!.confirmed, false, 'and nothing was confirmed');
});

test('a funding with no amount, date or lender cannot be confirmed', async () => {
  await call('underwriter', 'PUT', `/applications/${applicationId}/funding`, { rate: 4.89 });
  const result = await call('underwriter', 'POST', `/applications/${applicationId}/funding/confirm`, {});
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /the funded amount, the funding date, the lender/);
});

test('confirming twice is refused', async () => {
  await call('underwriter', 'PUT', `/applications/${applicationId}/funding`, goodFunding);
  await call('underwriter', 'POST', `/applications/${applicationId}/funding/confirm`, {});
  const again = await call('underwriter', 'POST', `/applications/${applicationId}/funding/confirm`, {});
  assert.equal(again.status, 409);
});

test('a confirmed funding is not something a broker quietly edits', async () => {
  await call('underwriter', 'PUT', `/applications/${applicationId}/funding`, goodFunding);
  await call('underwriter', 'POST', `/applications/${applicationId}/funding/confirm`, {});

  const broker = await call('underwriter', 'PUT', `/applications/${applicationId}/funding`,
    { funded_amount: '600000' });
  assert.equal(broker.status, 403);
  assert.match(String(broker.body.error), /A manager can amend it/);

  const manager = await call('manager', 'PUT', `/applications/${applicationId}/funding`,
    { approved_amount: '620000', funded_amount: '600000' });
  assert.equal(manager.status, 200);
});

test('a variance cannot be reconciled until somebody says what happened', async () => {
  await call('underwriter', 'PUT', `/applications/${applicationId}/funding`, goodFunding);
  await call('underwriter', 'POST', `/applications/${applicationId}/funding/confirm`,
    { commission_bps: 85 });
  const commission = await queryOne<{ id: string }>(
    'SELECT id FROM commission_records WHERE application_id = $1', [applicationId]);

  const received = await call('manager', 'PUT', `/commissions/${commission!.id}`,
    { gross_received: '4039.50', received_on: '2026-10-15', status: 'received' });
  assert.equal(received.status, 200);
  // Money that does not match is a variance whatever the status said.
  assert.equal(received.body.status, 'variance');
  assert.equal((received.body.variance as { label: string }).label, 'Short by $312.50');

  const unexplained = await call('manager', 'PUT', `/commissions/${commission!.id}`,
    { status: 'reconciled' });
  assert.equal(unexplained.status, 400);
  assert.match(String(unexplained.body.error), /Record what happened/);

  const explained = await call('manager', 'PUT', `/commissions/${commission!.id}`,
    { status: 'reconciled', variance_note: 'Clawback on the prior file.' });
  assert.equal(explained.status, 200);

  const stored = await queryOne<{ variance_amount: string; status: string }>(
    'SELECT variance_amount, status FROM commission_records WHERE id = $1', [commission!.id]);
  assert.equal(stored!.variance_amount, '-312.50', 'stored, not recomputed later');
  assert.equal(stored!.status, 'reconciled');
});

test('a broker sees the commission they are paid on, and is told so', async () => {
  await call('underwriter', 'PUT', `/applications/${applicationId}/funding`, goodFunding);
  await call('underwriter', 'POST', `/applications/${applicationId}/funding/confirm`, {
    commission_bps: 85,
    splits: [{ party: 'broker', user_id: brokerId, percent: 100 }],
  });

  const mine = await call('broker', 'GET', '/commissions?status=all');
  assert.equal((mine.body.commissions as unknown[]).length, 1);
  assert.equal(mine.body.scope, 'mine');
  assert.match(String(mine.body.scope_reason), /A manager sees the brokerage/);

  const all = await call('manager', 'GET', '/commissions?status=all');
  assert.equal(all.body.scope, 'all');
  assert.equal(all.body.scope_reason, null);
});

test('resolving a renewal stops every message it would have sent', async () => {
  await call('underwriter', 'PUT', `/applications/${applicationId}/funding`, goodFunding);
  await call('underwriter', 'POST', `/applications/${applicationId}/funding/confirm`, {});
  const renewal = await queryOne<{ id: string }>(
    'SELECT id FROM renewal_records WHERE application_id = $1', [applicationId]);

  const lost = await call('manager', 'POST', `/renewals/${renewal!.id}`,
    { status: 'lost_to_other' });
  assert.equal(lost.status, 400, 'a renewal lost with no reason teaches nothing');

  const resolved = await call('manager', 'POST', `/renewals/${renewal!.id}`,
    { status: 'renewed_with_us', outcome_note: 'Renewed at 4.44%.' });
  assert.equal(resolved.status, 200);

  const milestones = await query<{ status: string; skip_reason: string }>(
    `SELECT status, skip_reason FROM renewal_milestones WHERE renewal_record_id = $1`,
    [renewal!.id]);
  assert.ok(milestones.rows.every((m) => m.status === 'cancelled'));
  assert.match(milestones.rows[0]!.skip_reason, /resolved as renewed with us/);

  const record = await queryOne<{ resolved_at: string | null }>(
    'SELECT resolved_at FROM renewal_records WHERE id = $1', [renewal!.id]);
  assert.ok(record!.resolved_at);
});

test('a maturity already inside a milestone window is skipped, not fired at once', async () => {
  // Funded today on a six-month term: T-6m and T-3m are already behind us.
  const today = new Date().toISOString().slice(0, 10);
  await call('underwriter', 'PUT', `/applications/${applicationId}/funding`,
    { ...goodFunding, funding_date: today, term_months: 6, maturity_date: null });
  await call('underwriter', 'POST', `/applications/${applicationId}/funding/confirm`, {});

  const milestones = await query<{ milestone_key: string; status: string; skip_reason: string }>(
    `SELECT m.milestone_key, m.status, m.skip_reason FROM renewal_milestones m
       JOIN renewal_records r ON r.id = m.renewal_record_id
      WHERE r.application_id = $1 ORDER BY m.due_on`, [applicationId]);
  assert.equal(milestones.rows[0]!.status, 'skipped');
  assert.match(milestones.rows[0]!.skip_reason, /already inside this window/);
  assert.equal(milestones.rows[2]!.status, 'pending', 'the one still ahead stays');
});

test('splits that allocate more than the commission stop the confirmation', async () => {
  // Found by looking at the screen: a $500 referral fee plus 70/30 of the
  // gross rendered as $4,852 of a $4,352 commission, and the confirmation
  // had gone through.
  await call('underwriter', 'PUT', `/applications/${applicationId}/funding`, goodFunding);
  const result = await call('underwriter', 'POST',
    `/applications/${applicationId}/funding/confirm`, {
      commission_bps: 85,
      splits: [
        { party: 'referrer', party_name: 'Kelly', amount: '9000' },
        { party: 'broker', user_id: brokerId, percent: 100 },
      ],
    });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /more than the commission itself/);

  const funding = await queryOne<{ confirmed: boolean }>(
    'SELECT confirmed FROM funding_records WHERE application_id = $1', [applicationId]);
  assert.equal(funding!.confirmed, false);
});
