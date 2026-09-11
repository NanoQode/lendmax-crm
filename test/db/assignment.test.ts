/**
 * Assignment rules, against a real database.
 *
 * These exist because the failure they prevent was found by running the
 * system: an application arriving from the portal had nobody assigned, so
 * nobody was notified when the client uploaded a document.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, withTransaction } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { applyAssignmentRules } from '../../src/services/assignment.ts';

let orgId: string;
let users: string[] = [];
let applicationId: string;

before(async () => { await migrate(); });

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  const org = await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Test','ON') RETURNING id`,
  );
  orgId = org.rows[0]!.id;

  users = [];
  for (const name of ['Ann', 'Ben', 'Cara']) {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO users (organization_id, email, name, role, active)
       VALUES ($1,$2,$3,'broker',true) RETURNING id`,
      [orgId, `${name.toLowerCase()}@example.com`, name],
    );
    users.push(rows[0]!.id);
  }

  const customer = await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name)
     VALUES ($1,'Test','Client') RETURNING id`,
    [orgId],
  );
  const app = await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, property_province)
     VALUES ($1,$2,'ON') RETURNING id`,
    [orgId, customer.rows[0]!.id],
  );
  applicationId = app.rows[0]!.id;
});

after(async () => { await pool.end(); });

const apply = (facts: Record<string, unknown> = {}) =>
  withTransaction((client) =>
    applyAssignmentRules(client, orgId, {
      applicationId, province: 'ON', transactionType: 'refinance', ...facts,
    } as never));

test('unassigned means unassigned — nothing is invented', async () => {
  await query(
    `INSERT INTO assignment_rules (organization_id, role, mode) VALUES ($1,'broker','unassigned')`,
    [orgId],
  );
  assert.deepEqual(await apply(), []);
  const { rows } = await query('SELECT * FROM assignments');
  assert.equal(rows.length, 0);
});

test('a fixed rule assigns that person and notifies them', async () => {
  await query(
    `INSERT INTO assignment_rules (organization_id, role, mode, fixed_user_id)
     VALUES ($1,'broker','fixed',$2)`,
    [orgId, users[1]],
  );
  const assigned = await apply();
  assert.deepEqual(assigned, [{ role: 'broker', userId: users[1] }]);

  const { rows } = await query('SELECT user_id, role, is_primary FROM assignments');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.is_primary, true);

  const notifications = await query('SELECT user_id, kind FROM notifications');
  assert.equal(notifications.rows.length, 1);
  assert.equal(notifications.rows[0]!.user_id, users[1]);
});

test('round robin rotates rather than always picking the first', async () => {
  await query(
    `INSERT INTO assignment_rules (organization_id, role, mode, candidates)
     VALUES ($1,'broker','round_robin',$2::uuid[])`,
    [orgId, users],
  );
  const picked: string[] = [];
  for (let i = 0; i < 4; i++) {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO applications (organization_id, customer_id, property_province)
       SELECT $1, id, 'ON' FROM customers LIMIT 1 RETURNING id`,
      [orgId],
    );
    applicationId = rows[0]!.id;
    const assigned = await apply();
    picked.push(assigned[0]!.userId);
  }
  assert.deepEqual(picked, [users[0], users[1], users[2], users[0]], 'wraps around');
});

test('a deactivated candidate is skipped, not left holding every third file', async () => {
  await query('UPDATE users SET active = false WHERE id = $1', [users[1]]);
  await query(
    `INSERT INTO assignment_rules (organization_id, role, mode, candidates)
     VALUES ($1,'broker','round_robin',$2::uuid[])`,
    [orgId, users],
  );
  const picked: string[] = [];
  for (let i = 0; i < 4; i++) {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO applications (organization_id, customer_id, property_province)
       SELECT $1, id, 'ON' FROM customers LIMIT 1 RETURNING id`,
      [orgId],
    );
    applicationId = rows[0]!.id;
    picked.push((await apply())[0]!.userId);
  }
  assert.equal(picked.includes(users[1]!), false, 'the inactive user never gets a file');
  assert.deepEqual([...new Set(picked)].sort(), [users[0], users[2]].sort());
});

test('a rule that does not match the file does not fire', async () => {
  await query(
    `INSERT INTO assignment_rules (organization_id, role, mode, fixed_user_id, applies_when)
     VALUES ($1,'broker','fixed',$2,'{"province":["BC"]}'::jsonb)`,
    [orgId, users[0]],
  );
  assert.deepEqual(await apply({ province: 'ON' }), [], 'Ontario file, British Columbia rule');
  assert.equal((await apply({ province: 'BC' })).length, 1);
});

test('the first matching rule per role wins', async () => {
  await query(
    `INSERT INTO assignment_rules (organization_id, role, mode, fixed_user_id, applies_when, position)
     VALUES ($1,'broker','fixed',$2,'{"province":["ON"]}'::jsonb,0),
            ($1,'broker','fixed',$3,'{}'::jsonb,1)`,
    [orgId, users[0], users[2]],
  );
  const assigned = await apply({ province: 'ON' });
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0]!.userId, users[0], 'the more specific, earlier rule');
});

test('a rule pointing at a deleted or inactive fixed user assigns nobody', async () => {
  await query('UPDATE users SET active = false WHERE id = $1', [users[0]]);
  await query(
    `INSERT INTO assignment_rules (organization_id, role, mode, fixed_user_id)
     VALUES ($1,'broker','fixed',$2)`,
    [orgId, users[0]],
  );
  assert.deepEqual(await apply(), [], 'a deactivated account is never handed a file');
});

test('roles are independent', async () => {
  await query(
    `INSERT INTO assignment_rules (organization_id, role, mode, fixed_user_id)
     VALUES ($1,'broker','fixed',$2), ($1,'underwriter','fixed',$3)`,
    [orgId, users[0], users[1]],
  );
  const assigned = await apply();
  assert.equal(assigned.length, 2);
  assert.deepEqual(assigned.map((a) => a.role).sort(), ['broker', 'underwriter']);
});
