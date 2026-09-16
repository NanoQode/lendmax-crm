import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_PERMISSIONS, can, canAll, canAny, denialMessage, MODULES, overridesFor, permissionsFor,
  PERMISSION_IDS, ROLES, ROLE_IDS, type Role,
} from '../src/domain/permissions.ts';

const as = (role: Role, overrides: Record<string, boolean> = {}) => ({
  role, permission_overrides: overrides, active: true,
});

test('every role grants only permissions that exist', () => {
  for (const role of ROLE_IDS) {
    for (const p of ROLES[role].permissions) {
      assert.ok(PERMISSION_IDS.includes(p), `${role} grants unknown permission ${p}`);
    }
  }
});

test('no role definition contains a duplicate', () => {
  for (const role of ROLE_IDS) {
    const list = ROLES[role].permissions;
    assert.equal(new Set(list).size, list.length, `${role} lists a permission twice`);
  }
});

test('the technical admin runs the system without reading the clients', () => {
  // Least privilege has to apply to the account with the most access, or it is
  // not a principle. Support work does not require somebody's bank statements.
  const admin = as('technical_admin');
  assert.equal(can(admin, 'system.admin'), true);
  assert.equal(can(admin, 'user.manage'), true);
  assert.equal(can(admin, 'integration.manage'), true);

  assert.equal(can(admin, 'document.download'), false);
  assert.equal(can(admin, 'pii.view_sensitive'), false);
  assert.equal(can(admin, 'pii.view_financials'), false);
  assert.equal(can(admin, 'compliance.review'), false);

  // Writes that read nothing sensitive: correcting a file, asking for documents.
  assert.equal(can(admin, 'customer.edit'), true);
  assert.equal(can(admin, 'document.request'), true);
  assert.equal(can(admin, 'scarlett.push'), true);
});

test('only the compliance manager may approve a compliance file or hold it', () => {
  for (const role of ROLE_IDS) {
    const expected = role === 'compliance_manager';
    assert.equal(can(as(role), 'compliance.review'), expected, `${role} / compliance.review`);
    assert.equal(can(as(role), 'compliance.legal_hold'), expected, `${role} / compliance.legal_hold`);
    assert.equal(can(as(role), 'compliance.fintrac'), expected, `${role} / compliance.fintrac`);
  }
});

test('a broker cannot see files they are not assigned to, an underwriter can', () => {
  assert.equal(can(as('broker'), 'customer.view_all'), false);
  assert.equal(can(as('underwriter'), 'customer.view_all'), true);
  assert.equal(can(as('manager'), 'customer.view_all'), true);
  assert.equal(can(as('compliance_manager'), 'customer.view_all'), true);
});

test('sending to more than one client at a time is not a broker permission', () => {
  // A broker may text a client. Texting four hundred of them is a different
  // act with different consent consequences.
  assert.equal(can(as('broker'), 'message.send'), true);
  assert.equal(can(as('broker'), 'message.send_bulk'), false);
  assert.equal(can(as('broker'), 'campaign.send'), false);
  assert.equal(can(as('manager'), 'message.send_bulk'), true);
  assert.equal(can(as('manager'), 'campaign.send'), true);
});

test('publishing an automation is separate from editing one', () => {
  assert.equal(can(as('broker'), 'automation.edit'), false);
  assert.equal(can(as('broker'), 'automation.control'), true, 'may pause one on their own file');
  assert.equal(can(as('manager'), 'automation.publish'), true);
  assert.equal(can(as('underwriter'), 'automation.publish'), false);
});

test('an override grants one capability without inventing a sixth role', () => {
  const broker = as('broker', { 'automation.publish': true });
  assert.equal(can(broker, 'automation.publish'), true);
  assert.equal(can(broker, 'system.admin'), false, 'and nothing else');
});

test('an override can also take a capability away', () => {
  const underwriter = as('underwriter', { 'scarlett.push': false });
  assert.equal(can(underwriter, 'scarlett.push'), false);
  assert.equal(can(underwriter, 'underwriting.manage'), true);
});

test('an unknown permission id in overrides is ignored, never trusted', () => {
  // Overrides come from the database. A stale or tampered key must not become
  // a capability just because it was written down.
  const user = as('broker', { 'nonsense.permission': true, 'system.admin ': true });
  const set = permissionsFor(user);
  assert.equal(set.has('system.admin'), false);
  assert.equal([...set].every((p) => PERMISSION_IDS.includes(p)), true);
});

test('a deactivated account has no permissions at all, whatever its role', () => {
  const suspended = { role: 'manager' as Role, permission_overrides: { 'system.admin': true }, active: false };
  assert.equal(permissionsFor(suspended).size, 0);
  assert.equal(can(suspended, 'customer.view'), false);
  assert.equal(can(suspended, 'system.admin'), false);
});

test('canAll and canAny mean what they say', () => {
  const uw = as('underwriter');
  assert.equal(canAll(uw, ['document.review', 'scarlett.push']), true);
  assert.equal(canAll(uw, ['document.review', 'compliance.review']), false);
  assert.equal(canAny(uw, ['compliance.review', 'scarlett.push']), true);
  assert.equal(canAny(uw, ['compliance.review', 'system.admin']), false);
  assert.equal(canAll(uw, []), true, 'vacuously');
  assert.equal(canAny(uw, []), false, 'vacuously');
});

test('a refusal names the role and the capability', () => {
  const msg = denialMessage(as('broker'), 'compliance.review');
  assert.match(msg, /Broker/);
  assert.match(msg, /approve or reject a compliance file/i);
  assert.match(msg, /Staff/, 'and says where to get it fixed');
});

// ── The module registry ───────────────────────────────────────────────────

test('every permission belongs to exactly one module, so none is missing from the staff form', () => {
  const seen = new Map<string, string>();
  for (const module of MODULES) {
    for (const p of module.permissions) {
      assert.ok(PERMISSION_IDS.includes(p.id), `${module.key} lists unknown permission ${p.id}`);
      assert.ok(!seen.has(p.id), `${p.id} is in both ${seen.get(p.id)} and ${module.key}`);
      seen.set(p.id, module.key);
    }
  }
  const missing = PERMISSION_IDS.filter((id) => !seen.has(id));
  assert.deepEqual(missing, [], 'add these to a module in MODULES');
});

test('module keys are unique and every module has something to tick', () => {
  const keys = MODULES.map((m) => m.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const m of MODULES) assert.ok(m.permissions.length > 0, `${m.key} is empty`);
});

test('an API key can only be given permissions that have an endpoint', () => {
  assert.ok(API_PERMISSIONS.includes('customer.create'), 'leads from a website');
  assert.ok(API_PERMISSIONS.includes('user.view'));
  assert.equal(API_PERMISSIONS.includes('system.admin'), false);
  assert.equal(API_PERMISSIONS.includes('user.impersonate'), false);
});

test('overrides store only the difference from the role', () => {
  const broker = ROLES.broker.permissions;
  assert.deepEqual(overridesFor('broker', broker), {}, 'exactly the role: nothing stored');

  const plus = overridesFor('broker', [...broker, 'report.view_team']);
  assert.deepEqual(plus, { 'report.view_team': true });

  const minus = overridesFor('broker', broker.filter((p) => p !== 'message.send'));
  assert.deepEqual(minus, { 'message.send': false });

  // What is stored reproduces exactly what was ticked.
  const ticked = [...broker.filter((p) => p !== 'message.send'), 'report.view_team'];
  const effective = permissionsFor({ role: 'broker', permission_overrides: overridesFor('broker', ticked) });
  assert.deepEqual([...effective].sort(), [...ticked].sort());
});

test('an unknown permission in a ticked set is dropped rather than stored', () => {
  assert.deepEqual(overridesFor('broker', [...ROLES.broker.permissions, 'made.up']), {});
});
