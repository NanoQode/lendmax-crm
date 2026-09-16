/**
 * The staff module, against a real database.
 *
 * What these protect, in the order a brokerage would feel their absence:
 *   · somebody added through the screen can actually get in — and only by
 *     proving they hold the mailbox the invitation went to;
 *   · deactivating or deleting somebody never strands their open leads;
 *   · a connected website cannot mint an administrator, whatever its key says;
 *   · a lead from a website is assigned the same way as one from the portal.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { pool, query, queryOne, withTransaction } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { setRoundRobin } from '../../src/services/assignment.ts';
import { signIn } from '../../src/services/auth.ts';
import {
  activateAccount, createStaff, deactivateStaff, deleteStaff, describeInvitation, getStaff,
  listStaff, resendInvitation, updateStaff, type Actor,
} from '../../src/services/staff.ts';
import { authenticateApiKey, createApiKey, revokeApiKey } from '../../src/services/api-keys.ts';
import { createLead } from '../../src/services/leads.ts';

let orgId: string;
let admin: Actor;

before(async () => { await migrate(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Test Brokerage','ON') RETURNING id`)).rows[0]!.id;
  const adminId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete)
     VALUES ($1,'admin@example.com','Alex Admin','technical_admin',true,now(),true) RETURNING id`,
    [orgId])).rows[0]!.id;
  admin = { organizationId: orgId, kind: 'user', userId: adminId, name: 'Alex Admin', role: 'technical_admin' };
  await query(
    `INSERT INTO pipeline_stages (organization_id, key, label, position, category, active)
     VALUES ($1,'lead','Lead',10,'open',true), ($1,'funded','Funded',90,'won',true)`, [orgId]);
});

const broker = (over: Record<string, unknown> = {}) => ({
  first_name: 'Priya', last_name: 'Sandhu', email: 'priya@example.com',
  mobile_phone: '(647) 555-0110', role: 'broker', licence_number: 'M123', licence_province: 'ON',
  round_robin_enabled: true, ...over,
});

const tokenOf = (link: string | undefined) => new URL(link!).searchParams.get('token')!;

/** Create and activate, the way a real person would. */
async function activeStaff(over: Record<string, unknown> = {}) {
  const { staff, invitation } = await createStaff(admin, broker(over));
  await activateAccount({ token: tokenOf(invitation.link), password: 'Harbour-Lights-2026',
                          password_confirmation: 'Harbour-Lights-2026' });
  return staff;
}

const fieldsOf = async (promise: Promise<unknown>) => {
  try { await promise; } catch (err) {
    if (err instanceof ZodError) return err.issues.map((i) => i.path.join('.'));
    throw err;
  }
  throw new Error('expected a validation error');
};

// ── Invitation and activation ──────────────────────────────────────────────

test('a new staff member is invited, cannot sign in, and can after activating', async () => {
  const { staff, invitation } = await createStaff(admin, broker());
  assert.equal(staff.status, 'invited');
  assert.equal(invitation.provider, 'console');
  assert.ok(invitation.link, 'the console driver sends nothing, so the admin is given the link');

  const before = await signIn('priya@example.com', 'Harbour-Lights-2026');
  assert.equal(before.ok, false);
  assert.equal(!before.ok && before.reason, 'not_activated');

  const described = await describeInvitation(tokenOf(invitation.link));
  assert.equal(described.email, 'priya@example.com');

  await activateAccount({ token: tokenOf(invitation.link), password: 'Harbour-Lights-2026',
                          password_confirmation: 'Harbour-Lights-2026' });
  assert.equal((await getStaff(orgId, staff.id)).status, 'active');
  assert.equal((await signIn('PRIYA@example.com', 'Harbour-Lights-2026')).ok, true);
});

test('an activation link works once', async () => {
  const { invitation } = await createStaff(admin, broker());
  const input = { token: tokenOf(invitation.link), password: 'Harbour-Lights-2026',
                  password_confirmation: 'Harbour-Lights-2026' };
  await activateAccount(input);
  await assert.rejects(activateAccount(input), /already activated/);
});

test('a resent invitation replaces the old link', async () => {
  const { staff, invitation } = await createStaff(admin, broker());
  const second = await resendInvitation(admin, staff.id);
  await assert.rejects(describeInvitation(tokenOf(invitation.link)), /newer activation link/);
  assert.equal((await describeInvitation(tokenOf(second.link))).email, 'priya@example.com');
});

test('an expired link is refused and says to ask for a new one', async () => {
  const { staff, invitation } = await createStaff(admin, broker());
  await query(`UPDATE user_invitations SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [staff.id]);
  await assert.rejects(describeInvitation(tokenOf(invitation.link)), /expired/);
});

test('the database never holds the activation token itself', async () => {
  const { invitation } = await createStaff(admin, broker());
  const token = tokenOf(invitation.link);
  const row = await queryOne<{ token_hash: string }>('SELECT token_hash FROM user_invitations');
  assert.notEqual(row!.token_hash, token);
  assert.equal(row!.token_hash.length, 64);
});

test('a deactivated person cannot use an invitation they were sent', async () => {
  const { staff, invitation } = await createStaff(admin, broker());
  await deactivateStaff(admin, staff.id, {});
  await assert.rejects(describeInvitation(tokenOf(invitation.link)), /no longer active|newer/);
});

// ── Validation ─────────────────────────────────────────────────────────────

test('every field problem is reported against its field, at once', async () => {
  const fields = await fieldsOf(createStaff(admin, {
    first_name: 'J0hn', last_name: '', email: 'not-an-email', mobile_phone: '123', role: 'broker',
  }));
  for (const f of ['first_name', 'last_name', 'email', 'mobile_phone', 'licence_number']) {
    assert.ok(fields.includes(f), `${f} reported`);
  }
});

test('an email already in use is refused, whatever its capitalisation', async () => {
  await createStaff(admin, broker());
  assert.deepEqual(await fieldsOf(createStaff(admin, broker({ email: 'PRIYA@Example.com' }))), ['email']);
});

test('names with apostrophes, hyphens and accents are names', async () => {
  const { staff } = await createStaff(admin, broker({ first_name: 'Zoë', last_name: "O'Brien-Côté" }));
  assert.equal(staff.name, "Zoë O'Brien-Côté");
});

test('a licence needs its province; an underwriter needs no licence', async () => {
  assert.deepEqual(await fieldsOf(createStaff(admin, broker({ licence_province: '' }))), ['licence_province']);
  const { staff } = await createStaff(admin, broker({
    role: 'underwriter', licence_number: '', licence_province: '', email: 'uw@example.com',
  }));
  assert.equal(staff.role, 'underwriter');
});

test('ticked permissions are stored as the difference from the role', async () => {
  const { staff } = await createStaff(admin, broker({
    permissions: ['customer.view', 'report.view_team'],
  }));
  assert.deepEqual(staff.permissions.sort(), ['customer.view', 'report.view_team']);
  assert.equal(staff.has_custom_permissions, true);

  // A role change without a list starts from the new role's defaults.
  const changed = await updateStaff(admin, staff.id, { role: 'underwriter' });
  assert.equal(changed.has_custom_permissions, false);
});

// ── Deactivating and deleting ──────────────────────────────────────────────

async function fileFor(userId: string, stage = 'lead') {
  const customer = (await query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name) VALUES ($1,'C','L') RETURNING id`,
    [orgId])).rows[0]!.id;
  const app = (await query<{ id: string }>(
    `INSERT INTO applications (organization_id, customer_id, stage_key) VALUES ($1,$2,$3) RETURNING id`,
    [orgId, customer, stage])).rows[0]!.id;
  await query(`INSERT INTO assignments (application_id, user_id, role, is_primary) VALUES ($1,$2,'broker',true)`,
              [app, userId]);
  return app;
}

test('deactivating somebody with open leads needs somebody to take them', async () => {
  const priya = await activeStaff();
  await fileFor(priya.id);
  assert.deepEqual(await fieldsOf(deactivateStaff(admin, priya.id, {})), ['reassign_to']);
  assert.equal((await getStaff(orgId, priya.id)).status, 'active', 'nothing changed');
});

test('the open book moves; funded files keep the person who worked them', async () => {
  const priya = await activeStaff();
  const marcus = await activeStaff({ first_name: 'Marcus', email: 'marcus@example.com' });
  const open1 = await fileFor(priya.id);
  const open2 = await fileFor(priya.id);
  const funded = await fileFor(priya.id, 'funded');
  const task = (await query<{ id: string }>(
    `INSERT INTO tasks (organization_id, application_id, title) VALUES ($1,$2,'Call back') RETURNING id`,
    [orgId, open1])).rows[0]!.id;
  await query('INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2)', [task, priya.id]);

  const { handover } = await deactivateStaff(admin, priya.id, { reassign_to: marcus.id });
  assert.deepEqual(handover, { leads_moved: 2, tasks_moved: 1, to: 'Marcus Sandhu' });

  const owner = async (app: string) => (await queryOne<{ user_id: string }>(
    `SELECT user_id FROM assignments WHERE application_id = $1 AND is_primary AND unassigned_at IS NULL`,
    [app]))?.user_id;
  assert.equal(await owner(open1), marcus.id);
  assert.equal(await owner(open2), marcus.id);
  assert.equal(await owner(funded), priya.id, 'the commission report still credits Priya');
  const assignees = await query('SELECT user_id FROM task_assignees WHERE task_id = $1', [task]);
  assert.deepEqual(assignees.rows.map((r) => r.user_id), [marcus.id]);
});

test('work cannot be handed to somebody inactive or not yet activated', async () => {
  const priya = await activeStaff();
  await fileFor(priya.id);
  const { staff: invited } = await createStaff(admin, broker({ email: 'new@example.com' }));
  assert.deepEqual(await fieldsOf(deactivateStaff(admin, priya.id, { reassign_to: invited.id })), ['reassign_to']);
});

test('a deleted account disappears from lists, cannot sign in, and frees its email', async () => {
  const priya = await activeStaff();
  await deleteStaff(admin, priya.id, {});
  assert.equal((await listStaff(orgId)).some((s) => s.id === priya.id), false);
  assert.equal((await listStaff(orgId, { status: 'deleted' }))[0]!.id, priya.id, 'but can be looked up');
  assert.equal((await signIn('priya@example.com', 'Harbour-Lights-2026')).ok, false);

  const again = await createStaff(admin, broker());
  assert.notEqual(again.staff.id, priya.id, 'the same person can be invited again as a new account');
});

// ── What a website may not do ──────────────────────────────────────────────

const website: () => Actor = () => ({
  organizationId: orgId, kind: 'integration', userId: null, name: 'API: HR portal',
});

test('an API caller cannot create or touch a technical admin', async () => {
  await assert.rejects(createStaff(website(), broker({ role: 'technical_admin' })), /inside the CRM/);
  await assert.rejects(deactivateStaff(website(), admin.userId!, {}), /inside the CRM/);
});

test('an API caller cannot grant administrative permissions', async () => {
  await assert.rejects(
    createStaff(website(), broker({ permissions: ['customer.view', 'user.manage'] })),
    /cannot grant administrative permissions/);
  const { staff } = await createStaff(website(), broker());
  await assert.rejects(
    updateStaff(website(), staff.id, { role: 'manager', permissions: ['user.impersonate'] }),
    /cannot grant/);
});

test('an API caller is never handed an activation link', async () => {
  const { invitation } = await createStaff(website(), broker());
  assert.equal(invitation.link, undefined);
});

// ── API keys ───────────────────────────────────────────────────────────────

test('a key works until revoked, and only with what it was given', async () => {
  const { key, record } = await createApiKey(admin, {
    name: 'lendmax.ca form', permissions: ['customer.create'],
  });
  assert.ok(key.startsWith('lmx_'));
  assert.equal(record.key_prefix, key.slice(0, 12));

  const found = await authenticateApiKey(key);
  assert.deepEqual([...found!.permissions], ['customer.create']);
  assert.equal(await authenticateApiKey(`${key}x`), null);

  await revokeApiKey(admin, record.id);
  assert.equal(await authenticateApiKey(key), null);
});

test('a key cannot be given a permission with no API behind it', async () => {
  await assert.rejects(createApiKey(admin, { name: 'Too much', permissions: ['system.admin'] }),
                       /cannot be given to an API key/);
});

// ── Leads from a website ───────────────────────────────────────────────────

test('a website lead is assigned by round robin, like one from the portal', async () => {
  const priya = await activeStaff();
  const marcus = await activeStaff({ first_name: 'Marcus', email: 'marcus@example.com' });
  await withTransaction((c) => setRoundRobin(c, orgId, true));

  const options = { defaultAssign: 'auto' as const, mayAssignOthers: false, source: 'api:form' };
  const first = await createLead(website(), { first_name: 'A', last_name: 'One', email: 'a@x.com',
                                              message: 'Refinancing in spring' }, options);
  const second = await createLead(website(), { first_name: 'B', last_name: 'Two', phone: '416-555-0199' }, options);
  assert.deepEqual([first.assigned_to!.id, second.assigned_to!.id], [priya.id, marcus.id]);

  const note = await queryOne<{ body: string }>('SELECT body FROM notes WHERE application_id = $1',
                                                 [first.application_id]);
  assert.equal(note!.body, 'Refinancing in spring', 'the form message is kept on the file');
});

test('a website cannot name somebody inactive as the owner', async () => {
  const priya = await activeStaff();
  await deactivateStaff(admin, priya.id, {});
  const options = { defaultAssign: 'auto' as const, mayAssignOthers: true, source: 'api:form' };
  assert.deepEqual(await fieldsOf(createLead(website(), {
    first_name: 'A', last_name: 'One', email: 'a@x.com', assign_to: priya.id,
  }, options)), ['assign_to']);
});
