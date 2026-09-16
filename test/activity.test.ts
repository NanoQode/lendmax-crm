/** Activity logs — the rules that need no database. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACTIVITY_MODULES, actionLabel, isStaffActivity, KNOWN_ACTIONS, moduleOf, RETENTION_DAYS,
} from '../src/domain/activity.ts';
import { can, MODULES, type Role } from '../src/domain/permissions.ts';

const as = (role: Role) => ({ role, permission_overrides: {}, active: true });

test('only staff and connected websites count as activity', () => {
  assert.equal(isStaffActivity({ kind: 'user', userId: 'u1' }), true);
  assert.equal(isStaffActivity({ kind: 'integration', userId: null }), true);
  assert.equal(isStaffActivity({ kind: 'system', userId: null }), false);
  assert.equal(isStaffActivity({ kind: 'client', userId: null }), false);
  // A failed sign-in for an unknown address has nobody behind it.
  assert.equal(isStaffActivity({ kind: 'user', userId: null }), false);
});

test('every action lands in a module the filter offers', () => {
  const offered = new Set(ACTIVITY_MODULES.map((m) => m.key));
  for (const a of KNOWN_ACTIONS) assert.ok(offered.has(a.module), `${a.key} → ${a.module} is not offered`);
  assert.equal(moduleOf('pipeline.stage_create'), 'pipeline');
  assert.equal(moduleOf('assignment.create'), 'pipeline');
  assert.equal(moduleOf('user.create'), 'staff');
  assert.equal(moduleOf('user.profile_updated'), 'account');
  assert.equal(moduleOf('auth.sign_in'), 'account');
  assert.equal(moduleOf('required_document.update'), 'required_documents');
  assert.equal(moduleOf('something.new'), 'other');
});

test('every permission module can be filtered on, so a new module shows up here too', () => {
  const offered = new Set(ACTIVITY_MODULES.map((m) => m.key));
  for (const m of MODULES) if (m.key !== 'sensitive') assert.ok(offered.has(m.key), m.key);
});

test('the migration backfill files actions under the same modules as the code', () => {
  const sql = readFileSync(new URL('../migrations/0020_activity_logs.sql', import.meta.url), 'utf8');
  const pairs = [...sql.matchAll(/WHEN '([a-z_]+)' THEN '([a-z_]+)'/g)];
  assert.ok(pairs.length > 20);
  for (const [, prefix, module] of pairs) {
    if (prefix === 'user') continue; // split between account and staff, checked above
    assert.equal(moduleOf(`${prefix}.anything`), module, prefix);
  }
});

test('actions read as sentences, known or not', () => {
  assert.equal(actionLabel('auth.sign_in'), 'Signed in');
  assert.equal(actionLabel('customer.opened'), 'Opened a client file');
  assert.equal(actionLabel('compliance.hold_placed'), 'Hold placed');
});

test("seeing everyone's activity is on for admins and off for brokers and underwriters", () => {
  assert.equal(RETENTION_DAYS, 30);
  for (const role of ['technical_admin', 'manager', 'compliance_manager'] as Role[]) {
    assert.equal(can(as(role), 'activity.view_all'), true, role);
  }
  for (const role of ['broker', 'underwriter'] as Role[]) {
    assert.equal(can(as(role), 'activity.view_all'), false, role);
  }
});
