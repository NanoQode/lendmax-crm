import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  can, canAll, canAny, denialMessage, permissionsFor,
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
  assert.match(msg, /Settings/, 'and says where to get it fixed');
});
