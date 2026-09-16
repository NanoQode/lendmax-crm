/**
 * Required documents, for the admin panel. The rules are in
 * services/required-documents.ts, which the v1 API calls too.
 *
 * Asserted per route (no router-level guard): this router is mounted at the
 * API root, where a router-level guard would run for every request passing
 * through it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { queryOne } from '../../db/pool.ts';
import { can } from '../../domain/permissions.ts';
import {
  addSuggested, checklistFor, createRequiredDocument, deleteRequiredDocument, getRequiredDocument,
  listRequiredDocuments, moveRequiredDocument, requiredDocumentsMeta, updateRequiredDocument,
} from '../../services/required-documents.ts';
import { asyncRoute } from '../middleware/errors.ts';
import { actorOf, requirePermission } from '../middleware/auth.ts';

export const requiredDocumentRoutes: Router = Router();

const view = requirePermission('required_document.view');
const manage = requirePermission('required_document.manage');

requiredDocumentRoutes.get('/required-documents/meta', view, asyncRoute(async (req, res) => {
  res.json({
    ok: true,
    ...(await requiredDocumentsMeta(req.user!.organization_id)),
    can_manage: can(req.user!, 'required_document.manage'),
  });
}));

requiredDocumentRoutes.get('/required-documents', view, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await listRequiredDocuments(req.user!.organization_id, req.query)) });
}));

/**
 * The list a client with this purpose is asked for.
 *
 * `application` is accepted instead of `purpose` because a file does not
 * always carry one: a lead created in the CRM has a transaction type and no
 * portal purpose, and the brokerage's checklist is keyed on the purpose. The
 * mapping already exists on `transaction_types.portal_purpose`, so the caller
 * does not have to know it.
 */
requiredDocumentRoutes.get('/required-documents/checklist', view, asyncRoute(async (req, res) => {
  const q = z.object({
    purpose: z.string().max(40).optional(),
    application: z.string().uuid().optional(),
  }).parse(req.query);

  let purpose = q.purpose ?? null;
  if (!purpose && q.application) {
    const row = await queryOne<{ purpose: string | null; portal_purpose: string | null }>(
      `SELECT app.purpose, t.portal_purpose
         FROM applications app
         LEFT JOIN transaction_types t
                ON t.organization_id = app.organization_id AND t.key = app.transaction_type_key
        WHERE app.id = $1 AND app.organization_id = $2`,
      [q.application, req.user!.organization_id],
    );
    purpose = row?.purpose ?? row?.portal_purpose ?? null;
  }
  if (!purpose) {
    res.json({ ok: true, purpose: null, documents: [] });
    return;
  }
  res.json({ ok: true, ...(await checklistFor(req.user!.organization_id, purpose)) });
}));

requiredDocumentRoutes.post('/required-documents/suggested', manage, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await addSuggested(actorOf(req), req.body)) });
}));

requiredDocumentRoutes.get('/required-documents/:id', view, asyncRoute(async (req, res) => {
  res.json({ ok: true, document: await getRequiredDocument(req.user!.organization_id, String(req.params.id)) });
}));

requiredDocumentRoutes.post('/required-documents', manage, asyncRoute(async (req, res) => {
  res.status(201).json({ ok: true, document: await createRequiredDocument(actorOf(req), req.body) });
}));

requiredDocumentRoutes.patch('/required-documents/:id', manage, asyncRoute(async (req, res) => {
  res.json({ ok: true, document: await updateRequiredDocument(actorOf(req), String(req.params.id), req.body) });
}));

requiredDocumentRoutes.post('/required-documents/:id/move', manage, asyncRoute(async (req, res) => {
  await moveRequiredDocument(actorOf(req), String(req.params.id), req.body);
  res.json({ ok: true });
}));

requiredDocumentRoutes.delete('/required-documents/:id', manage, asyncRoute(async (req, res) => {
  await deleteRequiredDocument(actorOf(req), String(req.params.id));
  res.json({ ok: true });
}));
