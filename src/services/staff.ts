/**
 * The staff module.
 *
 * Every rule about a staff account lives here, once, and both doors call it:
 * the admin panel (a signed-in person) and the v1 API (a connected website with
 * an API key). A rule enforced in only one of them is a rule the other one is
 * a way around.
 *
 * An account's life:
 *
 *   invited ──(sets a password from the emailed link)──▶ active ⇄ inactive
 *                                                           │
 *                                                           ▼
 *                                                        deleted
 *
 * "Deleted" is an archive, not a DELETE. Their name is on notes, audit rows,
 * funded files and commission; a compliance review has to be able to see who
 * did what, years later. An archived account is gone from every list, cannot
 * sign in, and frees its email address for somebody new.
 *
 * Inactive and deleted staff never hold open leads: the admin chooses who takes
 * them over, and the move happens in the same transaction as the deactivation.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { z, ZodError } from 'zod';
import { env } from '../config/env.ts';
import { pool, query, queryOne, withTransaction } from '../db/pool.ts';
import { log } from '../lib/logger.ts';
import { toE164 } from '../lib/phone.ts';
import {
  MODULES, overridesFor, permissionsFor, ROLE_IDS, ROLES, type Role,
} from '../domain/permissions.ts';
import { sendEmail } from '../integrations/email.ts';
import { AppError, fieldError, notFound } from '../http/middleware/errors.ts';
import { ASSIGNABLE_SQL, assignableSql, roundRobinStatus, setRoundRobin } from './assignment.ts';
import { recordAudit } from './audit.ts';
import { joinCommunity } from './chats.ts';
import { hashPassword, hashToken, MIN_PASSWORD_LENGTH } from './auth.ts';
import { rebuildSignature } from './signature.ts';

// ── Who is acting ──────────────────────────────────────────────────────────

/** A person in the admin panel, or a website holding an API key. */
export type Actor = {
  organizationId: string;
  kind: 'user' | 'integration';
  userId: string | null;
  name: string;
  role?: string | null;
  ip?: string | null;
};

const auditActor = (a: Actor) => ({
  userId: a.userId, name: a.name, role: a.role ?? null, kind: a.kind, ip: a.ip ?? null,
});

export { fieldError };

/**
 * What a connected website may not do to staff, even holding `user.manage`.
 *
 * Without these a leaked API key is the whole CRM: create a technical admin
 * with the attacker's own email, receive the invitation, sign in. A website
 * that onboards agents has no need to mint administrators, so it cannot.
 */
const PRIVILEGED: string[] = [
  'user.manage', 'user.impersonate', 'system.admin', 'api_key.manage',
  'integration.manage', 'settings.manage',
];

function guardIntegration(
  actor: Actor,
  check: { targetRole?: Role; newRole?: Role; permissions?: Iterable<string> },
): void {
  if (actor.kind !== 'integration') return;
  if (check.targetRole === 'technical_admin' || check.newRole === 'technical_admin') {
    throw new AppError('Technical admin accounts can only be managed from inside the CRM.',
                       403, 'forbidden');
  }
  const granted = [...(check.permissions ?? [])].filter((p) => PRIVILEGED.includes(p));
  if (granted.length) {
    throw new AppError(
      `An API key cannot grant administrative permissions (${granted.join(', ')}). ` +
      'Grant them from inside the CRM.', 403, 'forbidden');
  }
}

// ── Validation ─────────────────────────────────────────────────────────────

export const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'] as const;

const personName = (label: string) => z.string({ required_error: `${label} is required.` })
  .trim()
  .min(1, `${label} is required.`)
  .max(60, `${label} can be at most 60 characters.`)
  // Checked only once there is something to check, so an empty field says
  // "required" and nothing else.
  .refine((v) => v === '' || /^\p{L}[\p{L}\p{M}' .-]*$/u.test(v),
          `${label} can contain letters, spaces, hyphens and apostrophes.`);

/**
 * Absent stays absent (an update that did not mention the field leaves it
 * alone); sent-but-blank becomes null (the person cleared it).
 */
const blankToNull = <T extends string>(v: T | undefined): T | null | undefined =>
  v === undefined ? undefined : v === '' ? null : v;

const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label} can be at most ${max} characters.`).optional()
    .transform(blankToNull);

const StaffFields = {
  first_name: personName('First name'),
  last_name: personName('Last name'),
  email: z.string({ required_error: 'Email is required.' }).trim().toLowerCase()
    .min(1, 'Email is required.')
    .max(254, 'That email address is too long.')
    .email('Enter a valid email address.'),
  mobile_phone: z.string({ required_error: 'A mobile number is required.' }).trim()
    .min(1, 'A mobile number is required.'),
  role: z.enum(ROLE_IDS as [Role, ...Role[]], {
    errorMap: () => ({ message: 'Choose a role.' }),
  }),
  title: optionalText(80, 'Title'),
  licence_number: z.string().trim().max(20, 'A licence number is at most 20 characters.')
    .regex(/^[A-Za-z0-9-]*$/, 'A licence number is letters, numbers and hyphens.')
    .optional().transform((v) => {
      const value = blankToNull(v);
      return typeof value === 'string' ? value.toUpperCase() : value;
    }),
  licence_province: z.union([z.enum(PROVINCES), z.literal('')], {
    errorMap: () => ({ message: 'Choose a province.' }),
  }).optional().transform(blankToNull),
  round_robin_enabled: z.boolean(),
  /** The full set of ticked permissions. Omitted: the role's defaults. */
  permissions: z.array(z.string()).max(200).optional(),
};

/**
 * The rules that span fields, shared by create and update. Update runs them
 * against the record as it will be after the change, not only against the
 * fields that happened to be sent.
 */
function crossFieldIssues(value: {
  role?: Role; licence_number?: string | null; licence_province?: string | null; mobile_phone?: string;
}): Array<{ path: string[]; message: string }> {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (value.mobile_phone !== undefined && !toE164(value.mobile_phone)) {
    issues.push({ path: ['mobile_phone'],
                  message: 'Enter a valid Canadian mobile number, e.g. (416) 555-0142.' });
  }
  // A mortgage agent or broker deals with the public under their licence;
  // one without a number on file cannot appear on a disclosure.
  if (value.role === 'broker' && !value.licence_number) {
    issues.push({ path: ['licence_number'],
                  message: 'A broker needs their mortgage licence number on file.' });
  }
  if (value.licence_number && !value.licence_province) {
    issues.push({ path: ['licence_province'], message: 'Choose the province that issued the licence.' });
  }
  return issues;
}

export const CreateStaffInput = z.object({
  ...StaffFields,
  round_robin_enabled: StaffFields.round_robin_enabled.default(false),
}).strict().superRefine((value, ctx) => {
  for (const issue of crossFieldIssues(value)) ctx.addIssue({ code: 'custom', ...issue });
});

export const UpdateStaffInput = z.object({
  first_name: StaffFields.first_name.optional(),
  last_name: StaffFields.last_name.optional(),
  email: StaffFields.email.optional(),
  mobile_phone: StaffFields.mobile_phone.optional(),
  role: StaffFields.role.optional(),
  title: StaffFields.title,
  licence_number: StaffFields.licence_number,
  licence_province: StaffFields.licence_province,
  round_robin_enabled: StaffFields.round_robin_enabled.optional(),
  permissions: StaffFields.permissions,
}).strict();

export type CreateStaff = z.infer<typeof CreateStaffInput>;
export type UpdateStaff = z.infer<typeof UpdateStaffInput>;

// ── Reading ────────────────────────────────────────────────────────────────

export type StaffStatus = 'invited' | 'active' | 'inactive' | 'deleted';

export type StaffRecord = {
  id: string;
  first_name: string;
  last_name: string | null;
  name: string;
  email: string;
  role: Role;
  role_name: string;
  status: StaffStatus;
  round_robin_enabled: boolean;
  mobile_phone: string | null;
  title: string | null;
  licence_number: string | null;
  licence_province: string | null;
  permissions: string[];
  has_custom_permissions: boolean;
  open_leads: number;
  open_tasks: number;
  last_login_at: string | null;
  last_auto_assigned_at: string | null;
  invited_at: string | null;
  activated_at: string | null;
  invite_expires_at: string | null;
  invite_email_error: string | null;
  created_at: string;
};

/** The open part of the book: a funded or lost file keeps whoever worked it. */
const OPEN_FILE_SQL = `
  ap.archived_at IS NULL
  AND COALESCE((SELECT ps.category FROM pipeline_stages ps
                 WHERE ps.organization_id = ap.organization_id AND ps.key = ap.stage_key),
               'open') NOT IN ('won','lost')`;

const OPEN_TASK_SQL = `t.status IN ('open','in_progress','waiting')`;

const STAFF_SELECT = `
  SELECT u.id, u.first_name, u.last_name, u.name, u.email, u.role, u.round_robin_enabled,
         u.permission_overrides, u.active, u.last_login_at, u.last_auto_assigned_at,
         u.invited_at, u.activated_at, u.created_at,
         CASE WHEN u.archived_at IS NOT NULL THEN 'deleted'
              WHEN NOT u.active THEN 'inactive'
              WHEN u.activated_at IS NULL THEN 'invited'
              ELSE 'active' END AS status,
         p.mobile_phone, p.title, p.licence_number, p.licence_province,
         (SELECT count(DISTINCT a.application_id)::int
            FROM assignments a JOIN applications ap ON ap.id = a.application_id
           WHERE a.user_id = u.id AND a.unassigned_at IS NULL AND ${OPEN_FILE_SQL}) AS open_leads,
         (SELECT count(*)::int FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
           WHERE ta.user_id = u.id AND ${OPEN_TASK_SQL}) AS open_tasks,
         inv.expires_at AS invite_expires_at,
         inv.email_error AS invite_email_error
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT expires_at, email_error FROM user_invitations i
       WHERE i.user_id = u.id AND i.used_at IS NULL AND i.revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1) inv ON u.activated_at IS NULL`;

type StaffRow = Omit<StaffRecord, 'role_name' | 'permissions' | 'has_custom_permissions'> & {
  permission_overrides: Record<string, boolean>; active: boolean;
};

function present(row: StaffRow): StaffRecord {
  const { permission_overrides, active: _active, ...rest } = row;
  return {
    ...rest,
    role_name: ROLES[row.role]?.name ?? row.role,
    permissions: [...permissionsFor({ role: row.role, permission_overrides })].sort(),
    has_custom_permissions: Object.keys(permission_overrides ?? {}).length > 0,
  };
}

export async function listStaff(
  organizationId: string,
  filters: { status?: StaffStatus | 'all'; q?: string; role?: string } = {},
): Promise<StaffRecord[]> {
  const where = ['u.organization_id = $1'];
  const params: unknown[] = [organizationId];
  const status = filters.status ?? 'all';
  // Deleted staff are only listed when asked for by name.
  if (status === 'deleted') where.push('u.archived_at IS NOT NULL');
  else {
    where.push('u.archived_at IS NULL');
    if (status === 'active') where.push('u.active AND u.activated_at IS NOT NULL');
    if (status === 'inactive') where.push('NOT u.active');
    if (status === 'invited') where.push('u.active AND u.activated_at IS NULL');
  }
  if (filters.role) {
    params.push(filters.role);
    where.push(`u.role = $${params.length}`);
  }
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim().toLowerCase()}%`);
    where.push(`(lower(u.name) LIKE $${params.length} OR lower(u.email) LIKE $${params.length})`);
  }
  const { rows } = await query<StaffRow>(
    `${STAFF_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY (u.archived_at IS NULL) DESC, u.active DESC, lower(u.name)`,
    params,
  );
  return rows.map(present);
}

export async function getStaff(organizationId: string, id: string): Promise<StaffRecord> {
  if (!z.string().uuid().safeParse(id).success) throw notFound('That staff member');
  const row = await queryOne<StaffRow>(
    `${STAFF_SELECT} WHERE u.organization_id = $1 AND u.id = $2`, [organizationId, id]);
  if (!row) throw notFound('That staff member');
  return present(row);
}

/**
 * Who a lead can be handed to by hand: active and activated. Round robin
 * being off does not matter here — that only stops automatic assignment.
 */
export async function assignableStaff(
  organizationId: string,
): Promise<Array<{ id: string; name: string; email: string; role: string; role_name: string;
                   round_robin_enabled: boolean; open_leads: number }>> {
  const { rows } = await query<{ id: string; name: string; email: string; role: Role;
                                 round_robin_enabled: boolean; open_leads: number }>(
    `SELECT u.id, u.name, u.email, u.role, u.round_robin_enabled,
            (SELECT count(DISTINCT a.application_id)::int
               FROM assignments a JOIN applications ap ON ap.id = a.application_id
              WHERE a.user_id = u.id AND a.unassigned_at IS NULL AND ${OPEN_FILE_SQL}) AS open_leads
       FROM users u
      WHERE u.organization_id = $1 AND ${assignableSql('u.')}
      ORDER BY lower(u.name)`,
    [organizationId],
  );
  return rows.map((r) => ({ ...r, role_name: ROLES[r.role]?.name ?? r.role }));
}

/** Everything the staff form needs to draw itself. */
export function staffMeta() {
  return {
    roles: ROLE_IDS.map((key) => ({
      key, name: ROLES[key].name, description: ROLES[key].description,
      permissions: ROLES[key].permissions,
    })),
    modules: MODULES,
    provinces: PROVINCES,
    min_password_length: MIN_PASSWORD_LENGTH,
    invitation_valid_hours: INVITATION_VALID_HOURS,
  };
}

// ── Creating ───────────────────────────────────────────────────────────────

export const INVITATION_VALID_HOURS = 72;

export type InvitationOutcome = {
  sent: boolean;
  /** The provider, so "console" can be called what it is: nothing was sent. */
  provider: string;
  error?: string;
  expires_at: string;
  /**
   * Only when the email did not actually reach anybody (a failure, or the
   * console driver). The admin can then pass it on by hand rather than the
   * person being stuck; a link that was emailed is not echoed back.
   */
  link?: string;
};

async function assertEmailFree(
  client: pg.PoolClient, organizationId: string, email: string, exceptId?: string,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT 1 FROM users WHERE organization_id = $1 AND lower(email) = lower($2)
        AND archived_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`,
    [organizationId, email, exceptId ?? null],
  );
  if (rows.length) throw fieldError('email', 'Another staff member already uses that email address.');
}

export async function createStaff(
  actor: Actor,
  raw: unknown,
): Promise<{ staff: StaffRecord; invitation: InvitationOutcome }> {
  const input = CreateStaffInput.parse(raw);
  const mobile = toE164(input.mobile_phone)!;
  const name = `${input.first_name} ${input.last_name}`;
  const overrides = input.permissions ? overridesFor(input.role, input.permissions) : {};
  guardIntegration(actor, {
    newRole: input.role,
    permissions: permissionsFor({ role: input.role, permission_overrides: overrides }),
  });

  const { id, token, expiresAt } = await withTransaction(async (client) => {
    await assertEmailFree(client, actor.organizationId, input.email);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (organization_id, email, name, first_name, last_name, role,
                          permission_overrides, round_robin_enabled, active, profile_complete,
                          invited_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,true,false,now(),$9)
       RETURNING id`,
      [actor.organizationId, input.email, name, input.first_name, input.last_name, input.role,
       JSON.stringify(overrides), input.round_robin_enabled, actor.userId],
    );
    const userId = rows[0]!.id;
    await client.query(
      `INSERT INTO user_profiles (user_id, display_name, title, mobile_phone, licence_number,
                                  licence_province)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, input.first_name, input.title, mobile, input.licence_number, input.licence_province],
    );
    await rebuildSignature(client, userId);
    // Everybody is in the Community group, and a new hire is in it before
    // their first sign-in — "the new person cannot see the announcements
    // until tomorrow" is a support call, not a design.
    await joinCommunity(userId, actor.organizationId, client);
    const invitation = await issueInvitation(client, actor, userId);
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'user.create',
      entityType: 'user',
      entityId: userId,
      summary: `${name} added as ${ROLES[input.role].name} and invited`,
      after: {
        email: input.email, role: input.role, round_robin_enabled: input.round_robin_enabled,
        permission_overrides: overrides,
      },
    }, client);
    return { id: userId, ...invitation };
  });

  const invitation = await deliverInvitation(actor, id, token, expiresAt);
  return { staff: await getStaff(actor.organizationId, id), invitation };
}

// ── Updating ───────────────────────────────────────────────────────────────

type Target = {
  id: string; name: string; email: string; role: Role; active: boolean;
  activated_at: Date | null; archived_at: Date | null;
  first_name: string | null; last_name: string | null;
  round_robin_enabled: boolean; permission_overrides: Record<string, boolean>;
};

async function lockTarget(client: pg.PoolClient, organizationId: string, id: string): Promise<Target> {
  if (!z.string().uuid().safeParse(id).success) throw notFound('That staff member');
  const { rows } = await client.query<Target>(
    `SELECT id, name, email, role, active, activated_at, archived_at, first_name, last_name,
            round_robin_enabled, permission_overrides
       FROM users WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [id, organizationId],
  );
  if (!rows[0] || rows[0].archived_at) throw notFound('That staff member');
  return rows[0];
}

/**
 * The brokerage must never be left without somebody who can manage staff and
 * settings — that is how an organisation locks itself out of its own system.
 */
async function assertNotLastTechnicalAdmin(
  client: pg.PoolClient, organizationId: string, target: Target, change: string,
): Promise<void> {
  if (target.role !== 'technical_admin' || !target.active) return;
  const { rows } = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM users
      WHERE organization_id = $1 AND role = 'technical_admin' AND id <> $2
        AND ${ASSIGNABLE_SQL}`,
    [organizationId, target.id],
  );
  if (!rows[0]?.count) {
    throw new AppError(
      `${target.name} is the only active technical admin, so they cannot be ${change}. ` +
      'Make somebody else a technical admin first.', 409, 'last_admin');
  }
}

export async function updateStaff(actor: Actor, id: string, raw: unknown): Promise<StaffRecord> {
  const input = UpdateStaffInput.parse(raw);

  await withTransaction(async (client) => {
    const target = await lockTarget(client, actor.organizationId, id);
    const role = input.role ?? target.role;
    guardIntegration(actor, {
      targetRole: target.role,
      newRole: input.role,
      permissions: input.permissions || input.role
        ? permissionsFor({ role, permission_overrides: input.permissions ? overridesFor(role, input.permissions) : {} })
        : [],
    });

    // Cross-field rules against the record as it will be, not only the
    // fields that happened to be sent.
    const profile = (await client.query<{ licence_number: string | null; licence_province: string | null }>(
      'SELECT licence_number, licence_province FROM user_profiles WHERE user_id = $1', [id])).rows[0];
    // The licence rules apply when the role or the licence is being changed.
    // Switching an existing broker's round robin off must not be refused
    // because their licence was never recorded before this rule existed.
    const touchesLicence = input.role !== undefined || input.licence_number !== undefined
      || input.licence_province !== undefined;
    const issues = crossFieldIssues({
      role: touchesLicence ? role : undefined,
      licence_number: input.licence_number !== undefined ? input.licence_number : profile?.licence_number ?? null,
      licence_province: touchesLicence
        ? (input.licence_province !== undefined ? input.licence_province : profile?.licence_province ?? null)
        : 'ON',
      mobile_phone: input.mobile_phone,
    });
    if (issues.length) throw new ZodError(issues.map((i) => ({ code: 'custom' as const, ...i })));

    if (actor.userId === target.id && input.role && input.role !== target.role) {
      throw new AppError('You cannot change your own role.', 409, 'self_change');
    }
    if (input.role && input.role !== 'technical_admin') {
      await assertNotLastTechnicalAdmin(client, actor.organizationId, target, 'moved to another role');
    }
    if (input.email && input.email !== target.email.toLowerCase()) {
      await assertEmailFree(client, actor.organizationId, input.email, target.id);
    }

    const sets: string[] = [];
    const params: unknown[] = [target.id];
    const set = (column: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    const first = input.first_name ?? target.first_name ?? '';
    const last = input.last_name ?? target.last_name ?? '';
    if (input.first_name !== undefined) set('first_name', input.first_name);
    if (input.last_name !== undefined) set('last_name', input.last_name);
    if (input.first_name !== undefined || input.last_name !== undefined) {
      set('name', `${first} ${last}`.trim());
    }
    if (input.email !== undefined) set('email', input.email);
    if (input.role !== undefined) set('role', input.role);
    if (input.round_robin_enabled !== undefined) set('round_robin_enabled', input.round_robin_enabled);
    // A role change without a permission list starts from the new role's
    // defaults: carrying exceptions across from a different job is how
    // somebody ends up with access nobody remembers granting.
    if (input.permissions !== undefined || input.role !== undefined) {
      set('permission_overrides',
          JSON.stringify(input.permissions ? overridesFor(role, input.permissions) : {}), '::jsonb');
    }
    if (sets.length) await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);

    const profileChanges: Record<string, unknown> = {};
    if (input.mobile_phone !== undefined) profileChanges.mobile_phone = toE164(input.mobile_phone);
    if (input.title !== undefined) profileChanges.title = input.title;
    if (input.licence_number !== undefined) profileChanges.licence_number = input.licence_number;
    if (input.licence_province !== undefined) profileChanges.licence_province = input.licence_province;
    if (Object.keys(profileChanges).length) {
      const columns = Object.keys(profileChanges);
      await client.query(
        `INSERT INTO user_profiles (user_id, ${columns.join(', ')})
         VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (user_id) DO UPDATE SET
           ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
        [target.id, ...Object.values(profileChanges)],
      );
    }

    // Name, title, licence and phone all feed the signature.
    await rebuildSignature(client, target.id);

    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'user.update',
      entityType: 'user',
      entityId: target.id,
      summary: describeUpdate(target, input),
      before: {
        role: target.role, email: target.email, round_robin_enabled: target.round_robin_enabled,
        permission_overrides: target.permission_overrides,
      },
      after: input,
    }, client);
  });

  return getStaff(actor.organizationId, id);
}

function describeUpdate(target: Target, input: UpdateStaff): string {
  const parts: string[] = [];
  if (input.role && input.role !== target.role) parts.push(`role changed to ${ROLES[input.role].name}`);
  if (input.round_robin_enabled !== undefined && input.round_robin_enabled !== target.round_robin_enabled) {
    parts.push(`round robin ${input.round_robin_enabled ? 'on' : 'off'}`);
  }
  if (input.permissions) parts.push('permissions changed');
  return `${target.name} updated${parts.length ? ` — ${parts.join(', ')}` : ''}`;
}

// ── Deactivating, reactivating, deleting ───────────────────────────────────

export type HandoverResult = { leads_moved: number; tasks_moved: number; to: string | null };

/**
 * Hand somebody's open leads and open tasks to one other person.
 *
 * Only the open book moves. A funded or lost file keeps the person who worked
 * it, or the commission report would credit the deal to whoever inherited the
 * desk.
 */
async function handOver(
  client: pg.PoolClient, actor: Actor, from: Target, toId: string,
): Promise<HandoverResult> {
  const { rows: target } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE id = $1 AND organization_id = $2 AND ${ASSIGNABLE_SQL}`,
    [toId, actor.organizationId],
  );
  if (!target[0]) {
    throw fieldError('reassign_to', 'Choose an active staff member to take over their leads.');
  }

  const { rows: moving } = await client.query<{ application_id: string; role: string; is_primary: boolean }>(
    `SELECT a.application_id, a.role, a.is_primary
       FROM assignments a JOIN applications ap ON ap.id = a.application_id
      WHERE a.user_id = $1 AND a.unassigned_at IS NULL AND ${OPEN_FILE_SQL}`,
    [from.id],
  );

  for (const row of moving) {
    await client.query(
      `UPDATE assignments SET unassigned_at = now(), is_primary = false
        WHERE application_id = $1 AND user_id = $2 AND role = $3`,
      [row.application_id, from.id, row.role],
    );
    if (row.is_primary) {
      await client.query(
        `UPDATE assignments SET is_primary = false
          WHERE application_id = $1 AND role = $2 AND unassigned_at IS NULL AND user_id <> $3`,
        [row.application_id, row.role, toId],
      );
    }
    await client.query(
      `INSERT INTO assignments (application_id, user_id, role, is_primary, assigned_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (application_id, user_id, role)
       DO UPDATE SET is_primary = assignments.is_primary OR EXCLUDED.is_primary,
                     unassigned_at = NULL, assigned_at = now(), assigned_by = EXCLUDED.assigned_by`,
      [row.application_id, toId, row.role, row.is_primary, actor.userId],
    );
    await client.query(
      `INSERT INTO activity (organization_id, application_id, kind, actor_user_id, actor_name,
                            actor_kind, summary)
       VALUES ($1,$2,'system',$3,$4,$5,$6)`,
      [actor.organizationId, row.application_id, actor.userId, actor.name, actor.kind,
       `Reassigned from ${from.name} to ${target[0].name} (${from.name} was deactivated)`],
    );
  }

  await client.query(
    `INSERT INTO task_assignees (task_id, user_id)
     SELECT ta.task_id, $2 FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
      WHERE ta.user_id = $1 AND ${OPEN_TASK_SQL}
     ON CONFLICT DO NOTHING`,
    [from.id, toId],
  );
  const { rowCount: tasksReleased } = await client.query(
    `DELETE FROM task_assignees ta USING tasks t
      WHERE t.id = ta.task_id AND ta.user_id = $1 AND ${OPEN_TASK_SQL}`,
    [from.id],
  );

  const leads = new Set(moving.map((m) => m.application_id)).size;
  if (leads || tasksReleased) {
    await client.query(
      `INSERT INTO notifications (organization_id, user_id, kind, title, body)
       VALUES ($1,$2,'assignment',$3,$4)`,
      [actor.organizationId, toId,
       `${from.name}'s work was handed to you`,
       `${leads} open lead${leads === 1 ? '' : 's'} and ${tasksReleased ?? 0} open task${tasksReleased === 1 ? '' : 's'}.`],
    );
  }
  return { leads_moved: leads, tasks_moved: tasksReleased ?? 0, to: target[0].name };
}

/** How much work a deactivation would move, so the popup can say so. */
export async function openWork(organizationId: string, id: string) {
  const staff = await getStaff(organizationId, id);
  return { open_leads: staff.open_leads, open_tasks: staff.open_tasks };
}

async function endAccess(client: pg.PoolClient, userId: string, reason: string): Promise<void> {
  await client.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  await client.query(
    `UPDATE user_invitations SET revoked_at = now()
      WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
    [userId],
  );
}

const HandoverInput = z.object({
  reassign_to: z.string().uuid('Choose who takes over their leads.').optional().nullable(),
}).strict();

async function deactivateOrDelete(
  actor: Actor, id: string, raw: unknown, mode: 'deactivate' | 'delete',
): Promise<{ staff: StaffRecord | null; handover: HandoverResult }> {
  const { reassign_to } = HandoverInput.parse(raw ?? {});
  const verb = mode === 'delete' ? 'deleted' : 'deactivated';

  const handover = await withTransaction(async (client) => {
    const target = await lockTarget(client, actor.organizationId, id);
    guardIntegration(actor, { targetRole: target.role });
    if (actor.userId === target.id) throw new AppError(`You cannot ${mode} your own account.`, 409, 'self_change');
    if (mode === 'deactivate' && !target.active) {
      throw new AppError(`${target.name} is already inactive.`, 409, 'already_inactive');
    }
    await assertNotLastTechnicalAdmin(client, actor.organizationId, target, verb);

    const { rows: open } = await client.query<{ leads: number; tasks: number }>(
      `SELECT (SELECT count(DISTINCT a.application_id)::int
                 FROM assignments a JOIN applications ap ON ap.id = a.application_id
                WHERE a.user_id = $1 AND a.unassigned_at IS NULL AND ${OPEN_FILE_SQL}) AS leads,
              (SELECT count(*)::int FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
                WHERE ta.user_id = $1 AND ${OPEN_TASK_SQL}) AS tasks`,
      [target.id],
    );
    const hasWork = (open[0]?.leads ?? 0) + (open[0]?.tasks ?? 0) > 0;

    let result: HandoverResult = { leads_moved: 0, tasks_moved: 0, to: null };
    if (hasWork) {
      // Nothing is orphaned silently: somebody named takes the work over.
      if (!reassign_to) {
        throw fieldError('reassign_to',
          `${target.name} has ${open[0]!.leads} open lead(s) and ${open[0]!.tasks} open task(s). ` +
          'Choose who takes them over.');
      }
      if (reassign_to === target.id) {
        throw fieldError('reassign_to', 'Choose somebody other than the person being ' + verb + '.');
      }
      result = await handOver(client, actor, target, reassign_to);
    }

    if (mode === 'delete') {
      await client.query(
        `UPDATE users SET active = false, archived_at = now(), archived_by = $2,
                          deactivated_at = COALESCE(deactivated_at, now()),
                          round_robin_enabled = false
          WHERE id = $1`,
        [target.id, actor.userId],
      );
    } else {
      await client.query(
        'UPDATE users SET active = false, deactivated_at = now() WHERE id = $1', [target.id]);
    }
    await endAccess(client, target.id, `account ${verb}`);

    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: mode === 'delete' ? 'user.delete' : 'user.deactivate',
      entityType: 'user',
      entityId: target.id,
      summary: `${target.name} ${verb} and signed out` + (result.to
        ? `; ${result.leads_moved} lead(s) and ${result.tasks_moved} task(s) handed to ${result.to}` : ''),
      before: { active: target.active },
      after: { reassign_to: reassign_to ?? null, ...result },
    }, client);
    return result;
  });

  return {
    staff: mode === 'delete' ? null : await getStaff(actor.organizationId, id),
    handover,
  };
}

export const deactivateStaff = (actor: Actor, id: string, raw: unknown) =>
  deactivateOrDelete(actor, id, raw, 'deactivate');

export const deleteStaff = (actor: Actor, id: string, raw: unknown) =>
  deactivateOrDelete(actor, id, raw, 'delete');

export async function reactivateStaff(actor: Actor, id: string): Promise<StaffRecord> {
  await withTransaction(async (client) => {
    const target = await lockTarget(client, actor.organizationId, id);
    guardIntegration(actor, { targetRole: target.role });
    if (target.active) throw new AppError(`${target.name} is already active.`, 409, 'already_active');
    await client.query('UPDATE users SET active = true, deactivated_at = NULL WHERE id = $1', [target.id]);
    // Reactivating puts them back in the Community group; being taken out of
    // it while inactive is a separate, deliberate act by an admin.
    await joinCommunity(target.id, actor.organizationId, client);
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'user.reactivate',
      entityType: 'user',
      entityId: target.id,
      summary: `${target.name} reactivated`,
    }, client);
  });
  return getStaff(actor.organizationId, id);
}

// ── Round robin, for the whole brokerage ───────────────────────────────────

export async function assignmentSettings(organizationId: string) {
  const status = await roundRobinStatus(pool, organizationId);
  return {
    round_robin_enabled: status.enabled,
    // Who takes the next lead, and after them, in order.
    rotation: status.pool,
    next_up: status.enabled ? status.pool[0] ?? null : null,
  };
}

export async function updateAssignmentSettings(actor: Actor, raw: unknown) {
  const { round_robin_enabled } = z.object({ round_robin_enabled: z.boolean() }).strict().parse(raw);
  await withTransaction(async (client) => {
    await setRoundRobin(client, actor.organizationId, round_robin_enabled);
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'assignment.round_robin',
      entityType: 'organization',
      entityId: actor.organizationId,
      summary: `Round robin assignment of new leads turned ${round_robin_enabled ? 'on' : 'off'}`,
      after: { round_robin_enabled },
    }, client);
  });
  return assignmentSettings(actor.organizationId);
}

// ── Invitations and activation ─────────────────────────────────────────────

async function issueInvitation(
  client: pg.PoolClient, actor: Actor, userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  // A new link replaces the old one. Two live links to one account is one
  // more than the person needs and one more than can leak.
  await client.query(
    `UPDATE user_invitations SET revoked_at = now()
      WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
    [userId],
  );
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITATION_VALID_HOURS * 3_600_000);
  await client.query(
    `INSERT INTO user_invitations (organization_id, user_id, token_hash, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [actor.organizationId, userId, hashToken(token), expiresAt, actor.userId],
  );
  await client.query('UPDATE users SET invited_at = now() WHERE id = $1', [userId]);
  return { token, expiresAt };
}

export const activationLink = (token: string) =>
  `${env.PUBLIC_URL.replace(/\/+$/, '')}/activate?token=${encodeURIComponent(token)}`;

/**
 * Send the invitation. Outside the transaction on purpose: the account and
 * the link exist whether or not the email provider is having a good day, and
 * the admin is told plainly which it was.
 */
async function deliverInvitation(
  actor: Actor, userId: string, token: string, expiresAt: Date,
): Promise<InvitationOutcome> {
  const person = await queryOne<{ first_name: string | null; name: string; email: string; role: Role }>(
    'SELECT first_name, name, email, role FROM users WHERE id = $1', [userId]);
  const org = await queryOne<{ name: string }>(
    'SELECT name FROM organizations WHERE id = $1', [actor.organizationId]);
  const link = activationLink(token);
  const brokerage = org?.name ?? 'Lendmax';
  const hours = INVITATION_VALID_HOURS;

  const text = [
    `Hi ${person?.first_name ?? person?.name ?? ''},`,
    '',
    `${actor.kind === 'user' ? actor.name : brokerage} has added you to the ${brokerage} CRM as ${ROLES[person!.role].name}.`,
    '',
    'Activate your account and choose a password here:',
    link,
    '',
    `The link works once and expires in ${hours} hours. If it has expired, ask your administrator to send a new one.`,
    '',
    'If you were not expecting this, you can ignore this email — nothing happens until the link is used.',
  ].join('\n');
  const html = `
    <p>Hi ${escapeHtml(person?.first_name ?? person?.name ?? '')},</p>
    <p>${escapeHtml(actor.kind === 'user' ? actor.name : brokerage)} has added you to the
       ${escapeHtml(brokerage)} CRM as <strong>${escapeHtml(ROLES[person!.role].name)}</strong>.</p>
    <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none">Activate your account</a></p>
    <p style="color:#64748b;font-size:13px">Or paste this link into your browser:<br>${escapeHtml(link)}</p>
    <p style="color:#64748b;font-size:13px">The link works once and expires in ${hours} hours.
       If you were not expecting this, ignore this email — nothing happens until the link is used.</p>`;

  const result = await sendEmail(actor.organizationId, {
    to: person!.email,
    subject: `Activate your ${brokerage} CRM account`,
    text, html,
  });

  await query(
    `UPDATE user_invitations SET email_sent = $2, email_error = $3
      WHERE token_hash = $1`,
    [hashToken(token), result.ok && result.provider !== 'console', result.ok ? null : result.error ?? null],
  );
  if (!result.ok) log.warn('invitation email failed', { userId, error: result.error });
  if (!env.isProduction) log.info('invitation link (development only)', { email: person!.email, link });

  const delivered = result.ok && result.provider !== 'console';
  return {
    sent: delivered,
    provider: result.provider,
    error: result.ok
      ? (result.provider === 'console'
          ? 'Email is set to the console driver, so nothing was actually sent. Pass the link on yourself, or configure email under Integrations.'
          : undefined)
      : result.error,
    expires_at: expiresAt.toISOString(),
    // Never to an API caller: the link is a working login for whoever holds
    // it, and must only ever reach the person's own mailbox or an admin.
    ...(delivered || actor.kind === 'integration' ? {} : { link }),
  };
}

export async function resendInvitation(actor: Actor, id: string): Promise<InvitationOutcome> {
  const { token, expiresAt } = await withTransaction(async (client) => {
    const target = await lockTarget(client, actor.organizationId, id);
    guardIntegration(actor, { targetRole: target.role });
    if (target.activated_at) {
      throw new AppError(`${target.name} has already activated their account.`, 409, 'already_activated');
    }
    if (!target.active) {
      throw new AppError(`${target.name} is inactive. Reactivate them before sending an invitation.`,
                         409, 'inactive_user');
    }
    const issued = await issueInvitation(client, actor, target.id);
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'user.invite_resent',
      entityType: 'user',
      entityId: target.id,
      summary: `New activation link sent to ${target.name}`,
    }, client);
    return issued;
  });
  return deliverInvitation(actor, id, token, expiresAt);
}

type InvitationLookup = {
  invitation_id: string; user_id: string; organization_id: string; email: string; name: string;
  first_name: string | null; expires_at: Date; used_at: Date | null; revoked_at: Date | null;
  active: boolean; activated_at: Date | null; archived_at: Date | null; organization_name: string;
};

async function findInvitation(token: string): Promise<InvitationLookup> {
  const row = token
    ? await queryOne<InvitationLookup>(
      `SELECT i.id AS invitation_id, i.user_id, i.organization_id, u.email, u.name, u.first_name,
              i.expires_at, i.used_at, i.revoked_at, u.active, u.activated_at, u.archived_at,
              o.name AS organization_name
         FROM user_invitations i
         JOIN users u ON u.id = i.user_id
         JOIN organizations o ON o.id = i.organization_id
        WHERE i.token_hash = $1`,
      [hashToken(token)])
    : null;

  // Every way a link can be unusable gets its own sentence, because "invalid
  // link" sends the person back to their inbox to click the same link again.
  if (!row) throw new AppError('That activation link is not valid. Check you copied all of it, or ask for a new one.', 404, 'invitation_invalid');
  if (row.activated_at || row.used_at) {
    throw new AppError('This account is already activated. Sign in with your email and password.', 409, 'already_activated');
  }
  if (row.archived_at || !row.active) {
    throw new AppError('This account is no longer active. Ask your administrator.', 403, 'inactive');
  }
  if (row.revoked_at) {
    throw new AppError('A newer activation link has been sent. Use the most recent email.', 410, 'invitation_replaced');
  }
  if (row.expires_at.getTime() < Date.now()) {
    throw new AppError('This activation link has expired. Ask your administrator to send a new one.', 410, 'invitation_expired');
  }
  return row;
}

/** What the activation page shows before the person has done anything. */
export async function describeInvitation(token: string) {
  const row = await findInvitation(token);
  return {
    name: row.name, first_name: row.first_name, email: row.email,
    organization: row.organization_name, expires_at: row.expires_at.toISOString(),
    min_password_length: MIN_PASSWORD_LENGTH,
  };
}

export const ActivateInput = z.object({
  token: z.string().min(1),
  password: z.string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(200, 'That password is too long.'),
  password_confirmation: z.string(),
}).strict().superRefine((v, ctx) => {
  if (v.password !== v.password_confirmation) {
    ctx.addIssue({ code: 'custom', path: ['password_confirmation'], message: 'The two passwords do not match.' });
  }
});

/** Set the password, mark the account activated, and hand back who they are. */
export async function activateAccount(raw: unknown, ip?: string | null): Promise<{ userId: string }> {
  const input = ActivateInput.parse(raw);
  const row = await findInvitation(input.token);
  if (input.password.toLowerCase().includes(row.email.split('@')[0]!.toLowerCase())) {
    throw fieldError('password', 'Choose a password that does not contain your email address.');
  }
  const hash = await hashPassword(input.password);

  await withTransaction(async (client) => {
    // Claimed atomically: a link clicked twice at once activates once.
    const { rowCount } = await client.query(
      `UPDATE user_invitations SET used_at = now()
        WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [row.invitation_id],
    );
    if (!rowCount) throw new AppError('That activation link has just been used.', 409, 'already_activated');
    await client.query(
      `UPDATE users SET password_hash = $2, activated_at = now(), failed_login_count = 0,
                        locked_until = NULL
        WHERE id = $1`,
      [row.user_id, hash],
    );
    await client.query(
      `UPDATE user_invitations SET revoked_at = now()
        WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [row.user_id],
    );
    await recordAudit({
      organizationId: row.organization_id,
      actor: { userId: row.user_id, name: row.name, kind: 'user', ip: ip ?? null },
      action: 'user.activated',
      entityType: 'user',
      entityId: row.user_id,
      summary: `${row.name} activated their account`,
    }, client);
  });
  return { userId: row.user_id };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
