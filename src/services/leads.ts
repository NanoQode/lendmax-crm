/**
 * Leads that do not come from the application portal: typed in by a person,
 * or sent by a connected website through the v1 API.
 *
 * Both paths come through here so a lead is created, assigned and recorded the
 * same way whichever door it used. The portal has its own importer
 * (portal-import.ts) because it mirrors a record another system owns; these
 * are records the CRM owns from the start.
 */
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import { toE164 } from '../lib/phone.ts';
import { AppError, notFound } from '../http/middleware/errors.ts';
import {
  applyAssignmentRules, assignableSql, assignInTransaction, OWNER_ROLE,
} from './assignment.ts';
import { recordAudit } from './audit.ts';
import { emitEvent } from './events.ts';
import { entryStage } from './pipelines.ts';
import { PURPOSES, purposeKey } from '../domain/required-documents.ts';
import { fieldError, type Actor } from './staff.ts';

export const LeadInput = z.object({
  first_name: z.string().trim().min(1, 'A first name is required.').max(60),
  last_name: z.string().trim().min(1, 'A last name is required.').max(60),
  email: z.string().trim().email('That is not a valid email address.').max(254)
    .optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional(),
  lead_source: z.string().trim().max(60).optional(),
  transaction_type_key: z.string().trim().max(60).optional().or(z.literal('')),
  /**
   * Purchase, Renew, Refinance or Home Equity Line (or a key). Decides which
   * pipeline the lead enters; without it, the transaction type's purpose.
   */
  purpose: z.string().trim().max(40).optional(),
  amount_requested: z.coerce.number().nonnegative('The amount cannot be negative.')
    .max(100_000_000).optional(),
  /** Whatever the person wrote in the website's form. Kept as a note on the file. */
  message: z.string().trim().max(4000).optional(),
  /**
   * Who owns it: `auto` for round robin, `me` for whoever is creating it (the
   * admin panel only), or a staff member's id.
   */
  assign_to: z.union([z.literal('auto'), z.literal('me'), z.string().uuid()]).optional(),
}).strict();

export type LeadResult = {
  customer_id: string;
  application_id: string;
  assigned_to: { id: string; name: string } | null;
  possible_duplicates: Array<{ id: string; first_name: string; last_name: string; email: string | null }>;
};

export async function createLead(
  actor: Actor,
  raw: unknown,
  options: { defaultAssign: 'auto' | 'me'; mayAssignOthers: boolean; source: string },
): Promise<LeadResult> {
  const body = LeadInput.parse(raw);
  const phone = body.phone ? toE164(body.phone) : null;
  if (body.phone && !phone) throw fieldError('phone', 'That is not a valid Canadian phone number.');
  if (!body.email && !phone) {
    throw fieldError('email', 'A lead needs at least an email address or a phone number.');
  }

  const assignTo = body.assign_to ?? options.defaultAssign;
  if (assignTo === 'me' && !actor.userId) {
    throw fieldError('assign_to', 'An API key is not a person; use "auto" or a staff id.');
  }
  if (assignTo !== 'auto' && assignTo !== 'me' && assignTo !== actor.userId && !options.mayAssignOthers) {
    throw new AppError('Your account cannot assign leads to other people.', 403, 'forbidden');
  }
  const ownerId = assignTo === 'me' ? actor.userId! : assignTo === 'auto' ? null : assignTo;
  if (ownerId) {
    const ok = await queryOne(
      `SELECT 1 FROM users WHERE id = $1 AND organization_id = $2 AND ${assignableSql()}`,
      [ownerId, actor.organizationId]);
    if (!ok) throw fieldError('assign_to', 'That staff member is not active, so cannot be given leads.');
  }
  if (body.transaction_type_key) {
    const type = await queryOne('SELECT 1 FROM transaction_types WHERE organization_id = $1 AND key = $2',
                                [actor.organizationId, body.transaction_type_key]);
    if (!type) throw fieldError('transaction_type_key', 'That is not one of the brokerage\'s transaction types.');
  }

  // Possible duplicates are reported, never merged silently. Merging two
  // people's mortgage files because they share an address is not recoverable.
  const duplicates = await query<LeadResult['possible_duplicates'][number]>(
    `SELECT id, first_name, last_name, email FROM customers
      WHERE organization_id = $1 AND merged_into_id IS NULL
        AND ((NULLIF($2,'') IS NOT NULL AND lower(email) = lower($2))
          OR ($3::text IS NOT NULL AND phone_e164 = $3))
      LIMIT 5`,
    [actor.organizationId, body.email ?? '', phone],
  );

  const created = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO customers (organization_id, first_name, last_name, email, phone_e164,
                              phone_raw, lead_source, created_by)
       VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8) RETURNING id`,
      [actor.organizationId, body.first_name, body.last_name, body.email ?? '',
       phone, body.phone ?? null, body.lead_source ?? options.source, actor.userId],
    );
    const customerId = rows[0]!.id;

    // The purpose picks the pipeline: said outright, or the one the
    // transaction type belongs to.
    let purpose = body.purpose ?? null;
    if (!purpose && body.transaction_type_key) {
      const { rows } = await client.query<{ portal_purpose: string | null }>(
        'SELECT portal_purpose FROM transaction_types WHERE organization_id = $1 AND key = $2',
        [actor.organizationId, body.transaction_type_key]);
      purpose = rows[0]?.portal_purpose ?? null;
    }
    const entry = await entryStage(client, actor.organizationId, purpose);
    const app = await client.query<{ id: string }>(
      `INSERT INTO applications (organization_id, customer_id, transaction_type_key, purpose,
                                 amount_requested, stage_key, stage_changed_at, last_activity_at)
       VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,now(),now()) RETURNING id`,
      [actor.organizationId, customerId, body.transaction_type_key ?? '',
       PURPOSES.find((p) => p.key === purposeKey(purpose))?.portal ?? null,
       body.amount_requested ?? null, entry.stageKey],
    );
    const applicationId = app.rows[0]!.id;

    if (ownerId) {
      await assignInTransaction(client, actor.organizationId, {
        applicationId, userId: ownerId, role: OWNER_ROLE, assignedBy: actor.userId,
        title: ownerId === actor.userId ? 'You created a lead' : 'A new lead was assigned to you',
        body: `${actor.name} assigned it to you.`,
        dedupeKey: `assigned:${applicationId}:${OWNER_ROLE}`,
      });
    }
    // The rules fill every role nobody chose by hand — the owner by round
    // robin when "auto", and the manager and underwriter routing either way.
    const auto = await applyAssignmentRules(client, actor.organizationId, {
      applicationId, transactionType: body.transaction_type_key || null, source: options.source,
    }, { skipRoles: ownerId ? [OWNER_ROLE] : [] });
    const owner = ownerId ?? auto.find((a) => a.role === OWNER_ROLE)?.userId ?? null;

    if (body.message) {
      await client.query(
        `INSERT INTO notes (organization_id, application_id, customer_id, body, note_type, author_name)
         VALUES ($1,$2,$3,$4,'general',$5)`,
        [actor.organizationId, applicationId, customerId, body.message, actor.name],
      );
    }
    await client.query(
      `INSERT INTO activity (organization_id, application_id, customer_id, kind,
                             actor_user_id, actor_name, actor_kind, summary)
       VALUES ($1,$2,$3,'system',$4,$5,$6,$7)`,
      [actor.organizationId, applicationId, customerId, actor.userId, actor.name, actor.kind,
       `Lead created by ${actor.name}`],
    );
    await recordAudit({
      organizationId: actor.organizationId,
      actor: { userId: actor.userId, name: actor.name, role: actor.role ?? null, kind: actor.kind,
               ip: actor.ip ?? null },
      action: 'customer.create',
      entityType: 'customer',
      entityId: customerId,
      summary: `Created ${body.first_name} ${body.last_name}`,
      after: { email: body.email, phone, source: body.lead_source ?? options.source, owner },
    }, client);
    for (const type of ['customer.created', 'application.created']) {
      await emitEvent({
        organizationId: actor.organizationId, type, customerId, applicationId, actorUserId: actor.userId,
        payload: { source: body.lead_source ?? options.source }, dedupeKey: `${type}:${applicationId}`,
      }, client);
    }
    return { customerId, applicationId, owner };
  });

  const ownerRow = created.owner
    ? await queryOne<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = $1', [created.owner])
    : null;
  return {
    customer_id: created.customerId,
    application_id: created.applicationId,
    assigned_to: ownerRow,
    possible_duplicates: duplicates.rows,
  };
}

export const AssignInput = z.object({
  user_id: z.string().uuid('Choose a staff member.'),
  role: z.enum(['broker', 'underwriter', 'manager', 'compliance', 'assistant']).default(OWNER_ROLE),
}).strict();

/** Hand a lead to somebody by hand. Only active staff can be chosen. */
export async function assignLead(
  actor: Actor, applicationId: string, raw: unknown,
): Promise<{ assigned_to: { id: string; name: string }; role: string }> {
  if (!z.string().uuid().safeParse(applicationId).success) throw notFound('That lead');
  const body = AssignInput.parse(raw);

  const app = await queryOne<{ id: string; customer_id: string }>(
    `SELECT id, customer_id FROM applications
      WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
    [applicationId, actor.organizationId]);
  if (!app) throw notFound('That lead');
  const assignee = await queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE id = $1 AND organization_id = $2 AND ${assignableSql()}`,
    [body.user_id, actor.organizationId]);
  if (!assignee) {
    throw fieldError('user_id', 'That staff member is inactive or has not activated their account.');
  }

  await withTransaction(async (client) => {
    const { rows: before } = await client.query<{ name: string }>(
      `SELECT u.name FROM assignments a JOIN users u ON u.id = a.user_id
        WHERE a.application_id = $1 AND a.role = $2 AND a.is_primary AND a.unassigned_at IS NULL`,
      [applicationId, body.role]);
    await assignInTransaction(client, actor.organizationId, {
      applicationId, userId: assignee.id, role: body.role, assignedBy: actor.userId,
      title: `You were assigned as ${body.role}`,
      body: `${actor.name} assigned you to a lead.`,
    });
    const summary = before[0] && before[0].name !== assignee.name
      ? `Reassigned from ${before[0].name} to ${assignee.name} (${body.role})`
      : `${assignee.name} assigned as ${body.role}`;
    await client.query(
      `INSERT INTO activity (organization_id, application_id, customer_id, kind,
                             actor_user_id, actor_name, actor_kind, summary)
       VALUES ($1,$2,$3,'system',$4,$5,$6,$7)`,
      [actor.organizationId, applicationId, app.customer_id, actor.userId, actor.name, actor.kind, summary],
    );
    await recordAudit({
      organizationId: actor.organizationId,
      actor: { userId: actor.userId, name: actor.name, role: actor.role ?? null, kind: actor.kind,
               ip: actor.ip ?? null },
      action: 'assignment.create',
      entityType: 'application',
      entityId: applicationId,
      summary,
      after: { user_id: assignee.id, role: body.role },
    }, client);
  });

  return { assigned_to: assignee, role: body.role };
}
