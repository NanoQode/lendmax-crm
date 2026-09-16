/**
 * The application file's own answers — reading them, and correcting them.
 *
 * Mounted ahead of `customerRoutes`, which owns the rest of `/applications/:id`.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { can } from '../../domain/permissions.ts';
import {
  getApplicationForm, revertPath, saveSection, type Scope,
} from '../../services/applications.ts';
import { asyncRoute } from '../middleware/errors.ts';
import { actorOf, requireAuth, requirePermission } from '../middleware/auth.ts';

export const applicationFormRoutes: Router = Router();
applicationFormRoutes.use('/applications', requireAuth);

const UUID = z.string().uuid();

const scopeOf = (req: Request): Scope => ({
  actor: actorOf(req),
  viewAll: can(req.user!, 'customer.view_all'),
  edit: can(req.user!, 'customer.edit'),
  viewFinancials: can(req.user!, 'pii.view_financials'),
});

/** The form definition, the answers, and which of them a colleague corrected. */
applicationFormRoutes.get(
  '/applications/:id/form',
  requirePermission('customer.view'),
  asyncRoute(async (req, res) => {
    res.json({ ok: true, ...(await getApplicationForm(scopeOf(req), UUID.parse(req.params.id))) });
  }),
);

/**
 * Save one section.
 *
 * A section that does not check out refuses with a 422 carrying `detail.errors`
 * — the form's own messages, keyed the way it addresses its inputs, so the
 * screen paints each one next to the question it belongs to.
 */
applicationFormRoutes.put(
  '/applications/:id/form/:section',
  requirePermission('customer.edit'),
  asyncRoute(async (req, res) => {
    const result = await saveSection(
      scopeOf(req), UUID.parse(req.params.id), String(req.params.section), req.body);
    res.json({ ok: true, ...result });
  }),
);

/** Put one field back to what the client answered. */
applicationFormRoutes.delete(
  '/applications/:id/form/edits',
  requirePermission('customer.edit'),
  asyncRoute(async (req, res) => {
    const q = z.object({ path: z.string().min(1).max(200) }).parse(req.query);
    res.json({ ok: true, ...(await revertPath(scopeOf(req), UUID.parse(req.params.id), q.path)) });
  }),
);
