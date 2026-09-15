/**
 * Documents: what is on the file, what has been asked for, and getting it.
 *
 * The staff side is here. The client-facing upload link is in `public.ts`,
 * because it is reached without a session and everything about it is different.
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { randomBytes, createHash } from 'node:crypto';
import { query, queryOne, withTransaction } from '../../db/pool.ts';
import { env } from '../../config/env.ts';
import { log } from '../../lib/logger.ts';
import { recordAudit, recordAuditSafely } from '../../services/audit.ts';
import {
  checkUpload, getObjectStream, putObject, scanObject, signDownload, verifyDownload,
  MAX_BYTES,
} from '../../services/storage.ts';
import { send } from '../../services/messaging.ts';
import { resolveIntegration } from '../../services/integrations.ts';
import { AppError, asyncRoute, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';

export const documentRoutes: Router = Router();
documentRoutes.use(requireAuth);

// Memory storage, with the real limit enforced by the storage layer too. The
// file is streamed to disk under a generated key; a browser-supplied filename
// never touches the filesystem.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

// ── The list ───────────────────────────────────────────────────────────────

documentRoutes.get(
  '/documents',
  requirePermission('document.view'),
  asyncRoute(async (req, res) => {
    const q = z
      .object({
        application_id: z.string().uuid().optional(),
        review_status: z.enum(['pending', 'accepted', 'rejected', 'superseded']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);
    const user = req.user!;

    const params: unknown[] = [user.organization_id];
    const where = ['d.organization_id = $1', 'd.archived_at IS NULL'];
    if (q.application_id) {
      params.push(q.application_id);
      where.push(`d.application_id = $${params.length}`);
    }
    if (q.review_status) {
      params.push(q.review_status);
      where.push(`d.review_status = $${params.length}`);
    }
    params.push(q.limit);

    const { rows } = await query(
      `SELECT d.id, d.category_key, d.filename, d.display_label, d.mime_type, d.byte_size,
              d.source, d.uploaded_at, d.review_status, d.review_note, d.scan_status,
              d.storage_driver, d.version, d.application_id,
              trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS client_name,
              u.name AS uploaded_by_name, cat.label AS category_label
         FROM documents d
         LEFT JOIN customers c ON c.id = d.customer_id
         LEFT JOIN users u ON u.id = d.uploaded_by
         LEFT JOIN document_categories cat
                ON cat.organization_id = d.organization_id AND cat.key = d.category_key
        WHERE ${where.join(' AND ')}
        ORDER BY d.uploaded_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json({ ok: true, documents: rows });
  }),
);

// ── Upload, by staff ───────────────────────────────────────────────────────

documentRoutes.post(
  '/applications/:id/documents',
  requirePermission('document.upload'),
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const applicationId = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        category_key: z.string().optional(),
        display_label: z.string().optional(),
        description: z.string().optional(),
        applicant_id: z.string().uuid().optional(),
        document_request_item_id: z.string().uuid().optional(),
      })
      .parse(req.body ?? {});
    const user = req.user!;
    const file = req.file;
    if (!file) throw new AppError('No file was attached.', 422, 'validation_failed');

    const check = checkUpload(file.originalname, file.mimetype, file.size);
    if (!check.ok) throw new AppError(check.reason, 422, 'rejected_upload');

    const app = await queryOne<{ customer_id: string }>(
      'SELECT customer_id FROM applications WHERE id = $1 AND organization_id = $2',
      [applicationId, user.organization_id],
    );
    if (!app) throw notFound('That application');

    const stored = await putObject(Readable.from(file.buffer), {
      filename: file.originalname, mimeType: file.mimetype,
    });
    const scan = await scanObject(stored.key);

    const documentId = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO documents
           (organization_id, application_id, customer_id, applicant_id, category_key, filename,
            display_label, description, mime_type, byte_size, sha256, storage_driver, storage_key,
            source, uploaded_by, scan_status, scan_at, scan_detail, document_request_item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'staff_upload',$14,$15,now(),$16,$17)
         RETURNING id`,
        [
          user.organization_id, applicationId, app.customer_id, body.applicant_id ?? null,
          body.category_key ?? null, file.originalname,
          body.display_label ?? file.originalname, body.description ?? null,
          file.mimetype, stored.bytes, stored.sha256, stored.driver, stored.key,
          user.id, scan.status, scan.detail ?? null, body.document_request_item_id ?? null,
        ],
      );
      const id = rows[0]!.id;
      if (body.document_request_item_id) {
        await markItemReceived(client, body.document_request_item_id);
      }
      await client.query(
        `INSERT INTO activity (organization_id, application_id, customer_id, kind, actor_user_id,
                               actor_name, summary, entity_type, entity_id)
         VALUES ($1,$2,$3,'document',$4,$5,$6,'document',$7)`,
        [user.organization_id, applicationId, app.customer_id, user.id, user.name,
         `${user.name} uploaded ${body.display_label ?? file.originalname}`, id],
      );
      await recordAudit(
        {
          organizationId: user.organization_id,
          actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
          action: 'document.upload',
          entityType: 'document',
          entityId: id,
          summary: `Uploaded ${file.originalname} to ${applicationId}`,
        },
        client,
      );
      return id;
    });

    await refreshOutstanding(applicationId);
    res.status(201).json({ ok: true, id: documentId, scan_status: scan.status });
  }),
);

// ── Download ───────────────────────────────────────────────────────────────

/**
 * Two steps on purpose: ask for a link, then use it.
 *
 * The grant is signed for one user and expires in minutes, so a URL pasted
 * into a chat does not work for anybody else. Both steps are recorded — the
 * request and the actual read — because "who looked at this client's bank
 * statements" has to have an answer.
 */
documentRoutes.post(
  '/documents/:id/link',
  requirePermission('document.download'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const user = req.user!;
    const doc = await queryOne<{ id: string; scan_status: string; display_label: string | null }>(
      'SELECT id, scan_status, display_label FROM documents WHERE id = $1 AND organization_id = $2',
      [id, user.organization_id],
    );
    if (!doc) throw notFound('That document');

    if (doc.scan_status === 'infected') {
      throw new AppError('That file was flagged by the virus scanner and cannot be opened.', 423, 'infected');
    }
    if (doc.scan_status === 'pending') {
      throw new AppError('That file has not been scanned yet. Try again in a moment.', 409, 'scan_pending');
    }

    const token = signDownload(id, user.id);
    res.json({
      ok: true,
      url: `${env.BASE_PATH}/api/documents/${id}/download?t=${token}`,
      expires_in: env.DOCUMENT_URL_TTL_SECONDS,
    });
  }),
);

documentRoutes.get(
  '/documents/:id/download',
  requirePermission('document.download'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const token = z.string().min(1).parse(req.query.t);
    const user = req.user!;

    if (!verifyDownload(id, user.id, token)) {
      throw new AppError('That download link has expired or is not yours.', 403, 'bad_link');
    }

    const doc = await queryOne<{
      storage_driver: string; storage_key: string; filename: string;
      display_label: string | null; mime_type: string | null; scan_status: string;
    }>(
      `SELECT storage_driver, storage_key, filename, display_label, mime_type, scan_status
         FROM documents WHERE id = $1 AND organization_id = $2`,
      [id, user.organization_id],
    );
    if (!doc) throw notFound('That document');
    if (doc.scan_status === 'infected') {
      throw new AppError('That file was flagged by the virus scanner.', 423, 'infected');
    }

    if (doc.storage_driver === 'portal') {
      // The portal owns the bytes. Rather than holding a second copy of
      // somebody's passport, the CRM streams it back through the portal's own
      // authenticated endpoint.
      const portal = await resolveIntegration(user.organization_id, 'portal');
      if (!portal.configured) {
        throw new AppError(
          'This document lives at apply.lendmax.ca and that integration is not configured, ' +
            'so it cannot be fetched.',
          503, 'portal_unavailable',
        );
      }
      const url = `${String(portal.values.base_url).replace(/\/+$/, '')}` +
        `/api/internal/documents/${encodeURIComponent(doc.storage_key)}`;
      const upstream = await fetch(url, {
        headers: { 'x-internal-key': String(portal.values.internal_api_key) },
      });
      if (!upstream.ok || !upstream.body) {
        throw new AppError(
          `The portal could not return that document (HTTP ${upstream.status}).`, 502, 'portal_error',
        );
      }
      recordAccess(id, user.id, 'download', req.ip);
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream');
      res.setHeader('content-disposition', `attachment; filename="${safeFilename(doc.display_label ?? doc.filename)}"`);
      res.setHeader('cache-control', 'private, no-store');
      await Readable.fromWeb(upstream.body as never).pipe(res);
      return;
    }

    recordAccess(id, user.id, 'download', req.ip);
    res.setHeader('content-type', doc.mime_type ?? 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${safeFilename(doc.display_label ?? doc.filename)}"`);
    // Never cached, anywhere. A mortgage document in a shared browser cache is
    // a disclosure nobody notices.
    res.setHeader('cache-control', 'private, no-store, max-age=0');
    res.setHeader('x-content-type-options', 'nosniff');
    getObjectStream(doc.storage_key).on('error', (err) => {
      log.error('could not read a stored document', { id, error: err });
      if (res.headersSent) return;
      // The document's own headers went on before the stream opened, so the
      // error would otherwise be sent as a JSON body labelled application/pdf
      // — express keeps a Content-Type that is already set. A browser then
      // shows a broken-file dialog instead of the sentence explaining what
      // happened.
      res.removeHeader('content-type');
      res.removeHeader('content-disposition');
      res.status(500).json({ ok: false, error: 'That file could not be read.' });
    }).pipe(res);
  }),
);

/** Strip anything that could break out of a Content-Disposition header. */
function safeFilename(name: string): string {
  return name.replace(/[^\w .\-()]+/g, '_').slice(0, 120) || 'document';
}

function recordAccess(documentId: string, userId: string, action: string, ip?: string): void {
  void query(
    `INSERT INTO document_access_log (document_id, user_id, action, ip) VALUES ($1,$2,$3,$4)`,
    [documentId, userId, action, ip ?? null],
  ).catch((err) => log.error('could not record document access', { error: err }));
}

// ── Review ─────────────────────────────────────────────────────────────────

documentRoutes.patch(
  '/documents/:id',
  requirePermission('document.review'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        review_status: z.enum(['pending', 'accepted', 'rejected']),
        review_note: z.string().optional(),
        display_label: z.string().optional(),
      })
      .parse(req.body);
    const user = req.user!;

    if (body.review_status === 'rejected' && !body.review_note?.trim()) {
      // A rejection with no reason is a document the client will re-send
      // identically.
      throw new AppError('Say why it was rejected — the client has to know what to send instead.',
                         422, 'validation_failed');
    }

    const doc = await queryOne<{ application_id: string; document_request_item_id: string | null }>(
      `UPDATE documents SET review_status = $2, review_note = $3,
                            display_label = COALESCE($4, display_label),
                            reviewed_by = $5, reviewed_at = now()
        WHERE id = $1 AND organization_id = $6
        RETURNING application_id, document_request_item_id`,
      [id, body.review_status, body.review_note ?? null, body.display_label ?? null,
       user.id, user.organization_id],
    );
    if (!doc) throw notFound('That document');

    if (doc.document_request_item_id) {
      await query(
        `UPDATE document_request_items SET status = $2 WHERE id = $1`,
        [doc.document_request_item_id,
         body.review_status === 'accepted' ? 'accepted'
           : body.review_status === 'rejected' ? 'outstanding' : 'received'],
      );
    }
    if (doc.application_id) await refreshOutstanding(doc.application_id);

    recordAuditSafely({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'document.review',
      entityType: 'document',
      entityId: id,
      summary: `Document ${body.review_status}${body.review_note ? `: ${body.review_note}` : ''}`,
    });
    res.json({ ok: true });
  }),
);

// ── Requesting documents ───────────────────────────────────────────────────

documentRoutes.get(
  '/applications/:id/document-requests',
  requirePermission('document.view'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await query(
      `SELECT r.id, r.status, r.channel, r.message, r.created_at, r.expires_at,
              r.first_opened_at, r.last_opened_at, r.open_count, r.completed_at,
              u.name AS requested_by_name,
              COALESCE(items.list, '[]'::json) AS items
         FROM document_requests r
         LEFT JOIN users u ON u.id = r.requested_by
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('id', i.id, 'label', i.label, 'status', i.status,
                                             'required', i.required, 'category_key', i.category_key)
                           ORDER BY i.position) AS list
             FROM document_request_items i WHERE i.document_request_id = r.id
         ) items ON TRUE
        WHERE r.application_id = $1 ORDER BY r.created_at DESC LIMIT 25`,
      [id],
    );
    res.json({ ok: true, requests: rows });
  }),
);

const RequestInput = z.object({
  items: z.array(z.object({
    category_key: z.string().optional(),
    label: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean().default(true),
    applicant_id: z.string().uuid().optional(),
  })).min(1, 'Choose at least one document.'),
  channel: z.enum(['email', 'sms', 'both']).default('email'),
  message: z.string().optional(),
  expires_in_days: z.coerce.number().int().min(1).max(90).default(21),
});

documentRoutes.post(
  '/applications/:id/document-requests',
  requirePermission('document.request'),
  asyncRoute(async (req, res) => {
    const applicationId = z.string().uuid().parse(req.params.id);
    const input = RequestInput.parse(req.body);
    const user = req.user!;

    const app = await queryOne<{
      customer_id: string; first_name: string | null; email: string | null;
      phone_e164: string | null;
    }>(
      `SELECT a.customer_id, c.first_name, c.email, c.phone_e164
         FROM applications a JOIN customers c ON c.id = a.customer_id
        WHERE a.id = $1 AND a.organization_id = $2`,
      [applicationId, user.organization_id],
    );
    if (!app) throw notFound('That application');

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
        [user.organization_id, applicationId, app.customer_id, input.message ?? null,
         input.channel, tokenHash, expiresAt, user.id],
      );
      const id = rows[0]!.id;
      for (const [i, item] of input.items.entries()) {
        await client.query(
          `INSERT INTO document_request_items
             (document_request_id, category_key, label, description, applicant_id, required, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, item.category_key ?? null, item.label, item.description ?? null,
           item.applicant_id ?? null, item.required, i],
        );
      }
      await client.query(
        `INSERT INTO activity (organization_id, application_id, customer_id, kind, actor_user_id,
                               actor_name, summary, entity_type, entity_id)
         VALUES ($1,$2,$3,'document',$4,$5,$6,'document_request',$7)`,
        [user.organization_id, applicationId, app.customer_id, user.id, user.name,
         `${user.name} requested ${input.items.length} document(s)`, id],
      );
      return id;
    });

    const link = `${env.PUBLIC_URL.replace(/\/+$/, '')}/upload/${token}`;
    const list = input.items.map((i) => `• ${i.label}`).join('\n');
    const greeting = app.first_name ? `Hi ${app.first_name},` : 'Hello,';

    const bodyText =
      `${greeting}\n\n` +
      `${input.message?.trim() || 'To keep your mortgage application moving, we need a few documents.'}\n\n` +
      `${list}\n\n` +
      `You can upload them here — the link is private to you and works from your phone:\n${link}\n\n` +
      `${user.name}\nLendmax\n`;

    // Transactional: these are documents for the mortgage the client asked us
    // to arrange, not marketing, and a marketing unsubscribe must not stop
    // them arriving. Urgent, because a client is usually waiting on the link.
    const sends: Array<{ channel: 'email' | 'sms'; outcome: Awaited<ReturnType<typeof send>> }> = [];
    if (input.channel === 'email' || input.channel === 'both') {
      sends.push({ channel: 'email', outcome: await send({
        organizationId: user.organization_id, customerId: app.customer_id,
        applicationId, channel: 'email', purpose: 'transactional',
        subject: 'Documents for your mortgage application',
        bodyText, origin: 'manual', sentBy: user.id, urgent: true,
        dedupeKey: `docreq:${requestId}:email`,
      }) });
    }
    if (input.channel === 'sms' || input.channel === 'both') {
      sends.push({ channel: 'sms', outcome: await send({
        organizationId: user.organization_id, customerId: app.customer_id,
        applicationId, channel: 'sms', purpose: 'transactional',
        bodyText:
          `${greeting} we need ${input.items.length} document(s) for your mortgage application. ` +
          `Upload them here: ${link} — ${user.name}, Lendmax`,
        origin: 'manual', sentBy: user.id, urgent: true,
        dedupeKey: `docreq:${requestId}:sms`,
      }) });
    }

    await refreshOutstanding(applicationId);

    res.status(201).json({
      ok: true,
      id: requestId,
      // The link is returned once so a broker on the phone can read it out.
      // It is not stored anywhere in plaintext.
      link,
      // Whether each channel actually went, and why not where it did not.
      delivery: sends.map((s) => ({
        channel: s.channel, ok: s.outcome.ok, status: s.outcome.status,
        reason: s.outcome.decision.reason,
      })),
    });
  }),
);

documentRoutes.post(
  '/document-requests/:id/cancel',
  requirePermission('document.request'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const user = req.user!;
    const row = await queryOne<{ application_id: string }>(
      `UPDATE document_requests SET status = 'cancelled'
        WHERE id = $1 AND organization_id = $2 AND status IN ('open','partial')
        RETURNING application_id`,
      [id, user.organization_id],
    );
    if (!row) throw notFound('That open request');
    await refreshOutstanding(row.application_id);
    res.json({ ok: true });
  }),
);

// ── Shared helpers ─────────────────────────────────────────────────────────

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
