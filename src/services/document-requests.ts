/**
 * Asking a client for documents: the request, its items, the link, and the
 * message that carries it.
 *
 * One implementation for everybody who asks — a broker on the file, the
 * "Request documents" step of an automation, and anything added later — so
 * the checklist is copied the same way, per-borrower entries split the same
 * way, and the consent gate sees every send.
 */
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import { env } from '../config/env.ts';
import { recordAudit } from './audit.ts';
import { send } from './messaging.ts';
import { emitEvent } from './events.ts';
import { describeFormats } from '../domain/required-documents.ts';
import { AppError, notFound } from '../http/middleware/errors.ts';

export const RequestInput = z.object({
  items: z.array(z.object({
    /**
     * An entry on the Required Documents checklist. When given, its name,
     * description, formats, category and required flag are copied from the
     * checklist on the server — what the admin saved is what the client is
     * asked for, whatever the screen sent — and a per-borrower entry becomes
     * one item for each borrower on the file.
     */
    required_document_id: z.string().uuid().optional(),
    category_key: z.string().optional(),
    label: z.string().min(1).optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    applicant_id: z.string().uuid().optional(),
  }).refine((i) => i.required_document_id || i.label, 'Each document needs a name.'))
    .min(1, 'Choose at least one document.'),
  channel: z.enum(['email', 'sms', 'both']).default('email'),
  message: z.string().optional(),
  expires_in_days: z.coerce.number().int().min(1).max(90).default(21),
});

export type DocumentRequester = {
  organizationId: string;
  /** Null for an automation, which is not a person. */
  userId: string | null;
  name: string;
  role?: string | null;
  kind: 'user' | 'system';
  ip?: string | null;
};

export type DocumentRequestResult = {
  id: string; items: number; sent: boolean; reason: string | null; link: string;
  delivery: Array<{ channel: 'email' | 'sms'; ok: boolean; status: string; reason: string | undefined }>;
};

/** Create the request, store its items, send the link. Visibility is the caller's to check. */
export async function createDocumentRequest(
  by: DocumentRequester,
  applicationId: string,
  raw: unknown,
  options: { dedupe?: string } = {},
): Promise<DocumentRequestResult> {
  const input = RequestInput.parse(raw);
  const app = await queryOne<{ customer_id: string; first_name: string | null }>(
    `SELECT a.customer_id, c.first_name
       FROM applications a JOIN customers c ON c.id = a.customer_id
      WHERE a.id = $1 AND a.organization_id = $2`,
    [applicationId, by.organizationId],
  );
  if (!app) throw notFound('That application');

  const items = await expandRequestItems(by.organizationId, applicationId, input.items);
  if (!items.length) {
    throw new AppError('None of those documents are on the checklist any more.', 422, 'invalid');
  }

  // The token is a bearer credential to somebody's financial documents, so
  // it is generated with real entropy and only its hash is stored.
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + input.expires_in_days * 86_400_000);

  const requestId = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO document_requests
         (organization_id, application_id, customer_id, message, channel, token_hash,
          expires_at, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [by.organizationId, applicationId, app.customer_id, input.message ?? null,
       input.channel, tokenHash, expiresAt, by.userId],
    );
    const id = rows[0]!.id;
    for (const [i, item] of items.entries()) {
      await client.query(
        `INSERT INTO document_request_items
           (document_request_id, category_key, label, description, applicant_id, required, position,
            required_document_id, formats)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, item.category_key, item.label, item.description, item.applicant_id, item.required, i,
         item.required_document_id, item.formats],
      );
    }
    await client.query(
      `INSERT INTO activity (organization_id, application_id, customer_id, kind, actor_user_id,
                             actor_kind, actor_name, summary, entity_type, entity_id)
       VALUES ($1,$2,$3,'document',$4,$5,$6,$7,'document_request',$8)`,
      [by.organizationId, applicationId, app.customer_id, by.userId, by.kind, by.name,
       `${by.name} requested ${items.length} document(s)`, id],
    );
    await recordAudit({
      organizationId: by.organizationId,
      actor: { userId: by.userId, name: by.name, role: by.role ?? null, kind: by.kind, ip: by.ip ?? null },
      action: 'document.request',
      entityType: 'document_request',
      entityId: id,
      applicationId,
      summary: `Requested ${items.length} document(s): ${items.map((i) => i.label).join(', ')}`,
      after: { items: items.map((i) => i.label), channel: input.channel },
    }, client);
    await emitEvent({
      organizationId: by.organizationId, type: 'document.requested', customerId: app.customer_id,
      applicationId, actorUserId: by.userId,
      payload: { request_id: id, items: items.map((i) => i.label) },
      dedupeKey: `document.requested:${id}`,
    }, client);
    return id;
  });

  const link = `${env.PUBLIC_URL.replace(/\/+$/, '')}/upload/${token}`;
  const list = items.map((i) => `• ${i.label}${i.formats ? ` (${describeFormats(i.formats)})` : ''}`)
    .join('\n');
  const greeting = app.first_name ? `Hi ${app.first_name},` : 'Hello,';
  const signOff = by.kind === 'user' ? `${by.name}\nLendmax` : 'Lendmax';

  const bodyText =
    `${greeting}\n\n` +
    `${input.message?.trim() || 'To keep your mortgage application moving, we need a few documents.'}\n\n` +
    `${list}\n\n` +
    `You can upload them here — the link is private to you and works from your phone:\n${link}\n\n` +
    `${signOff}\n`;

  // Transactional: these are documents for the mortgage the client asked us
  // to arrange, not marketing, and a marketing unsubscribe must not stop
  // them arriving. Urgent, because a client is usually waiting on the link.
  const origin = by.kind === 'user' ? 'manual' : 'automation';
  const sends: Array<{ channel: 'email' | 'sms'; outcome: Awaited<ReturnType<typeof send>> }> = [];
  if (input.channel === 'email' || input.channel === 'both') {
    sends.push({ channel: 'email', outcome: await send({
      organizationId: by.organizationId, customerId: app.customer_id,
      applicationId, channel: 'email', purpose: 'transactional',
      subject: 'Documents for your mortgage application',
      bodyText, origin, sentBy: by.userId, urgent: true,
      dedupeKey: `docreq:${options.dedupe ?? requestId}:email`,
    }) });
  }
  if (input.channel === 'sms' || input.channel === 'both') {
    sends.push({ channel: 'sms', outcome: await send({
      organizationId: by.organizationId, customerId: app.customer_id,
      applicationId, channel: 'sms', purpose: 'transactional',
      bodyText:
        `${greeting} we need ${items.length} document(s) for your mortgage application. ` +
        `Upload them here: ${link} — ${by.kind === 'user' ? `${by.name}, ` : ''}Lendmax`,
      origin, sentBy: by.userId, urgent: true,
      dedupeKey: `docreq:${options.dedupe ?? requestId}:sms`,
    }) });
  }

  await refreshOutstanding(applicationId);

  const failed = sends.filter((s) => !s.outcome.ok);
  return {
    id: requestId,
    items: items.length,
    // True only when every channel asked for went (or is queued to go).
    sent: failed.length === 0,
    reason: failed.map((s) => `${s.channel}: ${s.outcome.decision.reason ?? s.outcome.status}`)
      .join('; ') || null,
    link,
    delivery: sends.map((s) => ({
      channel: s.channel, ok: s.outcome.ok, status: s.outcome.status,
      reason: s.outcome.decision.reason,
    })),
  };
}


type RequestItem = {
  required_document_id: string | null; category_key: string | null; label: string;
  description: string | null; applicant_id: string | null; required: boolean;
  formats: string[] | null;
};

/**
 * Turn what the screen picked into the rows that are stored.
 *
 * A checklist entry is read back from `required_documents` rather than trusted
 * from the request, and one marked per-borrower becomes one item per borrower
 * ("Photo ID — Sarah", "Photo ID — James"), so each person's upload is tracked
 * on its own. A free-text item passes through as it came.
 */
export async function expandRequestItems(
  organizationId: string,
  applicationId: string,
  picked: Array<z.infer<typeof RequestInput>['items'][number]>,
): Promise<RequestItem[]> {
  const ids = picked.map((p) => p.required_document_id).filter((v): v is string => !!v);
  const { rows: entries } = ids.length
    ? await query<{
        id: string; name: string; description: string | null; formats: string[];
        category_key: string | null; required: boolean; per_applicant: boolean;
      }>(
        `SELECT id, name, description, formats, category_key, required, per_applicant
           FROM required_documents
          WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND archived_at IS NULL`,
        [organizationId, ids],
      )
    : { rows: [] };
  const byId = new Map(entries.map((e) => [e.id, e]));

  let applicants: Array<{ id: string; first_name: string | null }> | null = null;
  const borrowers = async () => {
    applicants ??= (await query<{ id: string; first_name: string | null }>(
      `SELECT id, first_name FROM application_applicants
        WHERE application_id = $1 ORDER BY position`,
      [applicationId],
    )).rows;
    return applicants;
  };

  const out: RequestItem[] = [];
  for (const p of picked) {
    if (!p.required_document_id) {
      out.push({
        required_document_id: null, category_key: p.category_key ?? null, label: p.label!,
        description: p.description ?? null, applicant_id: p.applicant_id ?? null,
        required: p.required ?? true, formats: null,
      });
      continue;
    }
    const entry = byId.get(p.required_document_id);
    if (!entry) continue;
    const base = {
      required_document_id: entry.id, category_key: entry.category_key,
      description: entry.description, required: p.required ?? entry.required,
      formats: entry.formats?.length ? entry.formats : null,
    };
    const people = entry.per_applicant ? await borrowers() : [];
    // Per borrower only means something with more than one on file; with
    // one (or none recorded yet) the plain name reads better.
    if (people.length > 1) {
      for (const [n, person] of people.entries()) {
        out.push({
          ...base, applicant_id: person.id,
          label: `${entry.name} — ${person.first_name?.trim() || `Borrower ${n + 1}`}`,
        });
      }
    } else {
      out.push({ ...base, applicant_id: people[0]?.id ?? null, label: entry.name });
    }
  }
  return out;
}

export async function markItemReceived(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  itemId: string,
): Promise<void> {
  await client.query(
    `UPDATE document_request_items SET status = 'received', received_at = now()
      WHERE id = $1 AND status = 'outstanding'`,
    [itemId],
  );
  // A request is complete when nothing required is outstanding. Optional items
  // do not hold it open, or a request for "anything else you think helps"
  // never closes.
  await client.query(
    `UPDATE document_requests r
        SET status = CASE
              WHEN NOT EXISTS (SELECT 1 FROM document_request_items i
                                WHERE i.document_request_id = r.id AND i.required
                                  AND i.status = 'outstanding') THEN 'completed'
              WHEN EXISTS (SELECT 1 FROM document_request_items i
                            WHERE i.document_request_id = r.id AND i.status <> 'outstanding')
                THEN 'partial'
              ELSE r.status END,
            completed_at = CASE
              WHEN NOT EXISTS (SELECT 1 FROM document_request_items i
                                WHERE i.document_request_id = r.id AND i.required
                                  AND i.status = 'outstanding') THEN now()
              ELSE r.completed_at END
      WHERE r.id = (SELECT document_request_id FROM document_request_items WHERE id = $1)`,
    [itemId],
  );
}

/** The denormalised count the list, the board and three alert rules read. */
export async function refreshOutstanding(applicationId: string): Promise<void> {
  await query(
    `UPDATE applications a
        SET documents_outstanding = COALESCE((
              SELECT COUNT(*) FROM document_request_items i
                JOIN document_requests r ON r.id = i.document_request_id
               WHERE r.application_id = a.id AND r.status IN ('open','partial')
                 AND i.required AND i.status = 'outstanding'), 0)
      WHERE a.id = $1`,
    [applicationId],
  );
}
