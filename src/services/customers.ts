/**
 * The customer record itself: correcting it, archiving its files, finding and
 * merging duplicates, and exporting the list.
 *
 * The file's answers are `applications.ts`; the list and the board are the
 * routes. What is here is everything that changes WHO the client is.
 *
 * Nothing in this module deletes. A file is archived and can be restored; a
 * duplicate is merged and kept, pointing at its survivor, so every message,
 * consent and audit row that named it still resolves. A mortgage brokerage
 * has retention obligations, and "delete" is the retention runner's decision,
 * not a button's.
 */
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import { toE164 } from '../lib/phone.ts';
import { AppError, fieldError, notFound } from '../http/middleware/errors.ts';
import { recordAudit } from './audit.ts';
import { emitEvent } from './events.ts';
import type { Actor } from './staff.ts';

export type CustomerScope = { actor: Actor; viewAll: boolean };

const auditActor = (a: Actor) => ({
  userId: a.userId, name: a.name, role: a.role ?? null, kind: a.kind, ip: a.ip ?? null,
});

export type Customer = {
  id: string; first_name: string | null; last_name: string | null; email: string | null;
  phone_e164: string | null; phone_raw: string | null; preferred_language: string | null;
  address_line1: string | null; address_line2: string | null; city: string | null;
  province: string | null; postal_code: string | null;
  lead_source: string | null; referral_source: string | null; tags: string[];
  merged_into_id: string | null; created_at: string; updated_at: string;
};

const CUSTOMER_COLUMNS = `c.id, c.first_name, c.last_name, c.email, c.phone_e164, c.phone_raw,
  c.preferred_language, c.address_line1, c.address_line2, c.city, c.province, c.postal_code,
  c.lead_source, c.referral_source, c.tags, c.merged_into_id,
  c.created_at, c.updated_at`;

/**
 * A customer this person may act on. Without `customer.view_all` that means
 * being assigned to one of their files — and a 404 otherwise, because saying
 * "exists, not yours" is itself a disclosure.
 */
export async function loadCustomer(scope: CustomerScope, id: string): Promise<Customer> {
  const params: unknown[] = [id, scope.actor.organizationId];
  let visible = '';
  if (!scope.viewAll) {
    params.push(scope.actor.userId);
    visible = `AND EXISTS (
      SELECT 1 FROM applications app JOIN assignments a ON a.application_id = app.id
       WHERE app.customer_id = c.id AND a.unassigned_at IS NULL AND a.user_id = $3)`;
  }
  const row = await queryOne<Customer>(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers c
      WHERE c.id = $1 AND c.organization_id = $2 ${visible}`,
    params,
  );
  if (!row) throw notFound('That customer');
  return row;
}

// ── Correcting the contact record ──────────────────────────────────────────

const optionalText = (max: number) =>
  z.union([z.string().trim().max(max), z.null()]).optional()
    .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));

export const CustomerUpdate = z.object({
  first_name: optionalText(80),
  last_name: optionalText(80),
  email: z.union([z.string().trim().email('That is not an email address.').max(200), z.literal(''), z.null()])
    .optional().transform((v) => (v === undefined ? undefined : v ? v.toLowerCase() : null)),
  phone: optionalText(40),
  preferred_language: optionalText(20),
  address_line1: optionalText(200),
  address_line2: optionalText(200),
  city: optionalText(80),
  province: z.union([z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use the two-letter province code.'),
                     z.literal(''), z.null()]).optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
  postal_code: z.union([z.string().trim().toUpperCase()
                         .regex(/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/, 'That is not a Canadian postal code.'),
                        z.literal(''), z.null()]).optional()
    .transform((v) => (v === undefined ? undefined : v ? `${v.replace(' ', '').slice(0, 3)} ${v.replace(' ', '').slice(3)}` : null)),
  lead_source: optionalText(80),
  referral_source: optionalText(120),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
}).strict();

export type DuplicateMatch = {
  id: string; first_name: string | null; last_name: string | null; email: string | null;
  phone_e164: string | null; matched_on: string[]; files: number;
};

export async function updateCustomer(scope: CustomerScope, id: string, raw: unknown) {
  const input = CustomerUpdate.parse(raw ?? {});
  const before = await loadCustomer(scope, id);
  if (before.merged_into_id) {
    throw new AppError('This record was merged into another customer; change the surviving one.',
      409, 'customer_merged');
  }

  const next: Record<string, unknown> = {};
  for (const key of ['first_name', 'last_name', 'email', 'preferred_language', 'lead_source',
                     'referral_source', 'address_line1', 'address_line2', 'city', 'province',
                     'postal_code'] as const) {
    if (input[key] !== undefined) next[key] = input[key];
  }
  if (input.phone !== undefined) {
    if (input.phone === null) {
      next.phone_e164 = null; next.phone_raw = null;
    } else {
      const e164 = toE164(input.phone);
      if (!e164) throw fieldError('phone', 'That is not a valid Canadian phone number.');
      next.phone_e164 = e164; next.phone_raw = input.phone;
    }
  }
  if (input.tags !== undefined) next.tags = [...new Set(input.tags)];

  const emailAfter = next.email !== undefined ? next.email : before.email;
  const phoneAfter = next.phone_e164 !== undefined ? next.phone_e164 : before.phone_e164;
  if (!emailAfter && !phoneAfter) {
    throw fieldError('email', 'A customer needs at least an email address or a phone number.');
  }

  const changed = Object.keys(next).filter((k) =>
    JSON.stringify(next[k] ?? null) !== JSON.stringify((before as Record<string, unknown>)[k] ?? null));
  if (changed.length) {
    await withTransaction(async (client) => {
      const sets = changed.map((k, i) => `${k} = $${i + 2}`);
      await client.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $1`,
        [id, ...changed.map((k) => next[k])]);
      // The primary applicant on each file is the same person; their contact
      // line on the file follows, so the file and the record do not disagree.
      const applicantCols = changed.filter((k) => ['first_name', 'last_name', 'email', 'phone_e164'].includes(k));
      if (applicantCols.length) {
        await client.query(
          `UPDATE application_applicants SET ${applicantCols.map((k, i) => `${k} = $${i + 2}`).join(', ')}
            WHERE customer_id = $1 AND position = 0`,
          [id, ...applicantCols.map((k) => next[k])]);
      }
      await recordAudit({
        organizationId: scope.actor.organizationId,
        actor: auditActor(scope.actor),
        action: 'customer.edit',
        entityType: 'customer',
        entityId: id,
        summary: `Edited ${changed.map((k) => k.replace(/_e164$/, '').replace(/_/g, ' ')).join(', ')} for ${nameOf(before)}`,
        before: Object.fromEntries(changed.map((k) => [k, (before as Record<string, unknown>)[k] ?? null])),
        after: Object.fromEntries(changed.map((k) => [k, next[k] ?? null])),
      }, client);
      const stamp = Date.now();
      await emitEvent({
        organizationId: scope.actor.organizationId, type: 'customer.updated', customerId: id,
        actorUserId: scope.actor.userId, payload: { changed: changed.join(',') },
        dedupeKey: `customer.updated:${id}:${stamp}`,
      }, client);
      if (changed.includes('tags')) {
        const was = new Set(before.tags ?? []);
        const now = new Set((next.tags as string[]) ?? []);
        for (const tag of now) {
          if (!was.has(tag)) {
            await emitEvent({ organizationId: scope.actor.organizationId, type: 'tag.added', customerId: id,
              actorUserId: scope.actor.userId, payload: { tag }, dedupeKey: `tag.added:${id}:${tag}:${stamp}` }, client);
          }
        }
        for (const tag of was) {
          if (!now.has(tag)) {
            await emitEvent({ organizationId: scope.actor.organizationId, type: 'tag.removed', customerId: id,
              actorUserId: scope.actor.userId, payload: { tag }, dedupeKey: `tag.removed:${id}:${tag}:${stamp}` }, client);
          }
        }
      }
    });
  }

  return {
    customer: await loadCustomer(scope, id),
    changed,
    // Reported, never acted on: two people can share a family email.
    possible_duplicates: await findDuplicates(scope, id),
  };
}

const nameOf = (c: { first_name: string | null; last_name: string | null }) =>
  `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'a customer';

// ── Duplicates ─────────────────────────────────────────────────────────────

/**
 * Other live records that look like the same person: same email, same phone,
 * or flagged by the portal importer and not yet dismissed. Name alone is not
 * a match — there are a lot of people called Chen.
 */
export async function findDuplicates(scope: CustomerScope, id: string): Promise<DuplicateMatch[]> {
  const me = await loadCustomer(scope, id);
  const { rows } = await query<DuplicateMatch>(
    `SELECT c.id, c.first_name, c.last_name, c.email, c.phone_e164,
            array_remove(ARRAY[
              CASE WHEN $3::text IS NOT NULL AND lower(c.email) = lower($3) THEN 'email' END,
              CASE WHEN $4::text IS NOT NULL AND c.phone_e164 = $4 THEN 'phone' END,
              CASE WHEN dc.id IS NOT NULL THEN 'flagged on import' END
            ], NULL) AS matched_on,
            (SELECT COUNT(*)::int FROM applications a WHERE a.customer_id = c.id) AS files
       FROM customers c
       LEFT JOIN duplicate_candidates dc
              ON dc.status = 'open'
             AND ((dc.customer_id = c.id AND dc.duplicate_of_id = $1)
               OR (dc.duplicate_of_id = c.id AND dc.customer_id = $1))
      WHERE c.organization_id = $2 AND c.id <> $1 AND c.merged_into_id IS NULL
        AND (($3::text IS NOT NULL AND lower(c.email) = lower($3))
          OR ($4::text IS NOT NULL AND c.phone_e164 = $4)
          OR dc.id IS NOT NULL)
      ORDER BY c.updated_at DESC
      LIMIT 20`,
    [id, scope.actor.organizationId, me.email, me.phone_e164],
  );
  return rows;
}

/** Search for a record to merge with, when the duplicate is not an obvious match. */
export async function searchCustomers(scope: CustomerScope, text: string, excludeId?: string) {
  const needle = text.trim().toLowerCase();
  if (needle.length < 2) return [];
  const digits = needle.replace(/\D/g, '');
  const params: unknown[] = [scope.actor.organizationId, `%${needle}%`, digits.length >= 4 ? `%${digits}%` : null,
                             excludeId ?? null];
  let visible = '';
  if (!scope.viewAll) {
    params.push(scope.actor.userId);
    visible = `AND EXISTS (SELECT 1 FROM applications app JOIN assignments a ON a.application_id = app.id
                            WHERE app.customer_id = c.id AND a.unassigned_at IS NULL AND a.user_id = $5)`;
  }
  const { rows } = await query(
    `SELECT c.id, c.first_name, c.last_name, c.email, c.phone_e164,
            (SELECT COUNT(*)::int FROM applications a WHERE a.customer_id = c.id) AS files
       FROM customers c
      WHERE c.organization_id = $1 AND c.merged_into_id IS NULL
        AND ($4::uuid IS NULL OR c.id <> $4)
        AND (lower(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) LIKE $2
          OR lower(coalesce(c.email,'')) LIKE $2
          OR ($3::text IS NOT NULL AND regexp_replace(coalesce(c.phone_e164,''), '\\D', '', 'g') LIKE $3))
        ${visible}
      ORDER BY c.updated_at DESC LIMIT 20`,
    params,
  );
  return rows;
}

export async function dismissDuplicate(scope: CustomerScope, id: string, otherId: string) {
  const one = await loadCustomer(scope, id);
  const other = await loadCustomer(scope, otherId);
  await recordAudit({
    organizationId: scope.actor.organizationId,
    actor: auditActor(scope.actor),
    action: 'customer.duplicate_dismiss',
    entityType: 'customer',
    entityId: id,
    summary: `Marked ${nameOf(one)} and ${nameOf(other)} as different people`,
  });
  const { rowCount } = await query(
    `UPDATE duplicate_candidates SET status = 'dismissed', resolved_by = $3, resolved_at = now()
      WHERE status = 'open' AND ((customer_id = $1 AND duplicate_of_id = $2)
                              OR (customer_id = $2 AND duplicate_of_id = $1))`,
    [id, otherId, scope.actor.userId],
  );
  // Recorded even where the importer never flagged the pair, so the next
  // person looking sees that somebody already decided these are two people.
  if (!rowCount) {
    await query(
      `INSERT INTO duplicate_candidates (organization_id, customer_id, duplicate_of_id, matched_on,
                                         status, resolved_by, resolved_at)
       VALUES ($1,$2,$3,'{manual}','dismissed',$4, now())
       ON CONFLICT (customer_id, duplicate_of_id) DO NOTHING`,
      [scope.actor.organizationId, id, otherId, scope.actor.userId],
    );
  }
}

/**
 * Tables that point at a customer and simply move to the survivor.
 *
 * `consents` is not here: it is append-only by trigger, and rewriting whose
 * consent a row records would be rewriting evidence. The send gate reads the
 * consents of every record merged into a customer instead.
 */
const MOVE_PLAIN = [
  'applications', 'application_applicants', 'appointments', 'communication_threads',
  'compliance_cases', 'document_requests', 'documents', 'identity_verifications', 'messages',
  'notes', 'renewal_records', 'tasks', 'activity', 'domain_events', 'suppressions',
] as const;

/**
 * Fold one record into another.
 *
 * Everything that belonged to `loserId` — files, messages, documents, tasks,
 * suppressions — now belongs to `survivorId`. Blank contact fields on the
 * survivor are filled from the loser; nothing the survivor already has is
 * overwritten. The loser stays, marked merged, so an old link or an inbound
 * reply to it still finds its way.
 */
export async function mergeCustomers(scope: CustomerScope, survivorId: string, loserId: string) {
  if (survivorId === loserId) throw new AppError('A customer cannot be merged into itself.', 422, 'invalid');
  const survivor = await loadCustomer(scope, survivorId);
  const loser = await loadCustomer(scope, loserId);
  if (survivor.merged_into_id || loser.merged_into_id) {
    throw new AppError('One of those records has already been merged.', 409, 'customer_merged');
  }
  const held = await queryOne(
    `SELECT 1 FROM compliance_cases WHERE customer_id = $1 AND legal_hold`, [loserId]);
  if (held) {
    throw new AppError('That record has a file under legal hold, so it cannot be merged.', 409, 'legal_hold');
  }

  const moved: Record<string, number> = {};
  await withTransaction(async (client) => {
    for (const table of MOVE_PLAIN) {
      const r = await client.query(`UPDATE ${table} SET customer_id = $1 WHERE customer_id = $2`,
        [survivorId, loserId]);
      if (r.rowCount) moved[table] = r.rowCount;
    }
    // Unique per campaign: where both were sent the same campaign, the
    // survivor's row stands and the loser's stays with the loser.
    for (const [table, key] of [['campaign_recipients', 'campaign_id'],
                                ['campaign_attributions', 'campaign_id, outcome']] as const) {
      const r = await client.query(
        `UPDATE ${table} t SET customer_id = $1 WHERE t.customer_id = $2
            AND NOT EXISTS (SELECT 1 FROM ${table} s WHERE s.customer_id = $1
                              AND (${key.split(', ').map((k) => `s.${k} = t.${k}`).join(' AND ')}))`,
        [survivorId, loserId]);
      if (r.rowCount) moved[table] = r.rowCount;
    }
    // One live enrollment per automation. A second copy of the same sequence
    // is stopped, not moved, or the client gets every email twice.
    await client.query(
      `UPDATE automation_enrollments t SET status = 'stopped'
        WHERE t.customer_id = $2 AND t.status IN ('active','paused')
          AND EXISTS (SELECT 1 FROM automation_enrollments s WHERE s.customer_id = $1
                        AND s.automation_id = t.automation_id AND s.status IN ('active','paused'))`,
      [survivorId, loserId]);
    const enrol = await client.query(
      `UPDATE automation_enrollments SET customer_id = $1 WHERE customer_id = $2`, [survivorId, loserId]);
    if (enrol.rowCount) moved.automation_enrollments = enrol.rowCount;
    await client.query(
      `UPDATE unmatched_messages SET resolved_customer_id = $1 WHERE resolved_customer_id = $2`,
      [survivorId, loserId]);
    // Anything already merged into the loser now points at the survivor, so
    // there is never a chain to follow.
    await client.query(`UPDATE customers SET merged_into_id = $1 WHERE merged_into_id = $2`,
      [survivorId, loserId]);

    await client.query(
      `UPDATE customers s
          SET first_name = COALESCE(s.first_name, l.first_name),
              last_name = COALESCE(s.last_name, l.last_name),
              email = COALESCE(s.email, l.email),
              phone_e164 = COALESCE(s.phone_e164, l.phone_e164),
              phone_raw = COALESCE(s.phone_raw, l.phone_raw),
              preferred_language = COALESCE(s.preferred_language, l.preferred_language),
              lead_source = COALESCE(s.lead_source, l.lead_source),
              referral_source = COALESCE(s.referral_source, l.referral_source),
              tags = ARRAY(SELECT DISTINCT unnest(s.tags || l.tags)),
              last_contacted_at = GREATEST(s.last_contacted_at, l.last_contacted_at),
              last_inbound_at = GREATEST(s.last_inbound_at, l.last_inbound_at),
              last_outbound_at = GREATEST(s.last_outbound_at, l.last_outbound_at),
              awaiting_reply_since = LEAST(s.awaiting_reply_since, l.awaiting_reply_since)
         FROM customers l
        WHERE s.id = $1 AND l.id = $2`,
      [survivorId, loserId]);
    await client.query(
      `UPDATE customers SET merged_into_id = $1, merged_at = now(), awaiting_reply_since = NULL
        WHERE id = $2`,
      [survivorId, loserId]);
    await client.query(
      `UPDATE duplicate_candidates SET status = 'merged', resolved_by = $3, resolved_at = now()
        WHERE status = 'open' AND ((customer_id = $1 AND duplicate_of_id = $2)
                                OR (customer_id = $2 AND duplicate_of_id = $1))`,
      [survivorId, loserId, scope.actor.userId]);

    await recordAudit({
      organizationId: scope.actor.organizationId,
      actor: auditActor(scope.actor),
      action: 'customer.merge',
      entityType: 'customer',
      entityId: survivorId,
      summary: `Merged ${nameOf(loser)} (${loser.email ?? loser.phone_e164 ?? loserId}) into ${nameOf(survivor)}`,
      before: { survivor, loser },
      after: { survivor_id: survivorId, merged_id: loserId, moved },
    }, client);
  });

  return { customer: await loadCustomer(scope, survivorId), merged_id: loserId, moved };
}

// ── Archiving a file ───────────────────────────────────────────────────────

export async function setArchived(scope: CustomerScope, applicationId: string, archived: boolean,
                                  reason?: string) {
  const params: unknown[] = [applicationId, scope.actor.organizationId];
  let visible = '';
  if (!scope.viewAll) {
    params.push(scope.actor.userId);
    visible = `AND EXISTS (SELECT 1 FROM assignments a WHERE a.application_id = app.id
                             AND a.unassigned_at IS NULL AND a.user_id = $3)`;
  }
  const file = await queryOne<{
    id: string; archived_at: Date | null; portal_reference: string | null;
    first_name: string | null; last_name: string | null;
  }>(
    `SELECT app.id, app.archived_at, app.portal_reference, c.first_name, c.last_name
       FROM applications app JOIN customers c ON c.id = app.customer_id
      WHERE app.id = $1 AND app.organization_id = $2 ${visible}`,
    params,
  );
  if (!file) throw notFound('That application');
  if (archived === !!file.archived_at) return { archived, changed: false };

  await withTransaction(async (client) => {
    await client.query('UPDATE applications SET archived_at = $2 WHERE id = $1',
      [applicationId, archived ? new Date() : null]);
    await recordAudit({
      organizationId: scope.actor.organizationId,
      actor: auditActor(scope.actor),
      action: archived ? 'application.archive' : 'application.restore',
      entityType: 'application',
      entityId: applicationId,
      applicationId,
      summary: `${archived ? 'Archived' : 'Restored'} ${file.portal_reference ?? 'the file'} for ${nameOf(file)}` +
               (reason?.trim() ? ` — ${reason.trim()}` : ''),
    }, client);
  });
  return { archived, changed: true };
}
