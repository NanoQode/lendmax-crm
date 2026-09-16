/**
 * The staff module and API keys, for the admin panel.
 *
 * Thin on purpose: every rule is in services/staff.ts and services/api-keys.ts,
 * which the v1 API calls too. This file only decides who may call what.
 *
 * Permissions are asserted per route rather than with a router-level
 * `requireAuth`, because this router is mounted at the API root and a
 * router-level guard would run for every request that passes through it,
 * matched or not.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { API_PERMISSIONS, can, MODULES } from '../../domain/permissions.ts';
import {
  assignableStaff, assignmentSettings, createStaff, deactivateStaff, deleteStaff, getStaff,
  listStaff, openWork, reactivateStaff, resendInvitation, staffMeta, updateAssignmentSettings,
  updateStaff,
} from '../../services/staff.ts';
import { createApiKey, listApiKeys, revokeApiKey } from '../../services/api-keys.ts';
import { getSignature, previewSignature, saveSignature } from '../../services/signature.ts';
import { asyncRoute } from '../middleware/errors.ts';
import { actorOf, requirePermission } from '../middleware/auth.ts';

export const staffRoutes: Router = Router();

const ListQuery = z.object({
  status: z.enum(['all', 'active', 'invited', 'inactive', 'deleted']).default('all'),
  q: z.string().max(100).optional(),
  role: z.string().max(40).optional(),
});

/** The assign list is needed by whoever assigns leads and whoever manages staff. */
function requireAssignOrManage(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ ok: false, code: 'unauthenticated', error: 'Sign in to continue.' });
    return;
  }
  if (!can(req.user, 'pipeline.assign') && !can(req.user, 'user.manage')) {
    res.status(403).json({ ok: false, code: 'forbidden', permission: 'pipeline.assign',
                           error: 'Your account cannot assign leads.' });
    return;
  }
  next();
}

staffRoutes.get('/staff/meta', requirePermission('user.view'), (_req, res) => {
  res.json({ ok: true, ...staffMeta() });
});

staffRoutes.get('/staff', requirePermission('user.view'), asyncRoute(async (req, res) => {
  const filters = ListQuery.parse(req.query);
  res.json({
    ok: true,
    staff: await listStaff(req.user!.organization_id, filters),
    can_manage: can(req.user!, 'user.manage'),
  });
}));

staffRoutes.get('/staff/assignable', requireAssignOrManage, asyncRoute(async (req, res) => {
  res.json({ ok: true, staff: await assignableStaff(req.user!.organization_id) });
}));

staffRoutes.get('/staff/assignment', requirePermission('user.view'), asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await assignmentSettings(req.user!.organization_id)) });
}));

staffRoutes.put('/staff/assignment', requirePermission('user.manage'), asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await updateAssignmentSettings(actorOf(req), req.body)) });
}));

staffRoutes.get('/staff/:id', requirePermission('user.view'), asyncRoute(async (req, res) => {
  res.json({ ok: true, staff: await getStaff(req.user!.organization_id, String(req.params.id)) });
}));

staffRoutes.get('/staff/:id/open-work', requirePermission('user.view'), asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await openWork(req.user!.organization_id, String(req.params.id))) });
}));

staffRoutes.post('/staff', requirePermission('user.manage'), asyncRoute(async (req, res) => {
  res.status(201).json({ ok: true, ...(await createStaff(actorOf(req), req.body)) });
}));

staffRoutes.patch('/staff/:id', requirePermission('user.manage'), asyncRoute(async (req, res) => {
  res.json({ ok: true, staff: await updateStaff(actorOf(req), String(req.params.id), req.body) });
}));

staffRoutes.post('/staff/:id/deactivate', requirePermission('user.manage'), asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await deactivateStaff(actorOf(req), String(req.params.id), req.body)) });
}));

staffRoutes.post('/staff/:id/reactivate', requirePermission('user.manage'), asyncRoute(async (req, res) => {
  res.json({ ok: true, staff: await reactivateStaff(actorOf(req), String(req.params.id)) });
}));

staffRoutes.post('/staff/:id/resend-invite', requirePermission('user.manage'), asyncRoute(async (req, res) => {
  res.json({ ok: true, invitation: await resendInvitation(actorOf(req), String(req.params.id)) });
}));

staffRoutes.delete('/staff/:id', requirePermission('user.manage'), asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await deleteStaff(actorOf(req), String(req.params.id), req.body)) });
}));

// ── A staff member's email signature, set by an admin ─────────────────────
// Everybody edits their own under their profile (/auth/signature); these are
// for an admin setting one up, or bringing a signature into line.

staffRoutes.get('/staff/:id/signature', requirePermission('user.view'), asyncRoute(async (req, res) => {
  res.json({ ok: true, signature: await getSignature(req.user!.organization_id, String(req.params.id)) });
}));

staffRoutes.post('/staff/:id/signature/preview', requirePermission('user.manage'), asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await previewSignature(req.user!.organization_id, String(req.params.id), req.body)) });
}));

staffRoutes.put('/staff/:id/signature', requirePermission('user.manage'), asyncRoute(async (req, res) => {
  res.json({ ok: true, signature: await saveSignature(actorOf(req), String(req.params.id), req.body) });
}));

// ── API keys ───────────────────────────────────────────────────────────────

staffRoutes.get('/api-keys', requirePermission('api_key.manage'), asyncRoute(async (req, res) => {
  res.json({
    ok: true,
    keys: await listApiKeys(req.user!.organization_id),
    // Only the modules that have something an API key can be given.
    modules: MODULES
      .map((m) => ({ ...m, permissions: m.permissions.filter((p) => API_PERMISSIONS.includes(p.id)) }))
      .filter((m) => m.permissions.length),
  });
}));

staffRoutes.post('/api-keys', requirePermission('api_key.manage'), asyncRoute(async (req, res) => {
  res.status(201).json({ ok: true, ...(await createApiKey(actorOf(req), req.body)) });
}));

staffRoutes.post('/api-keys/:id/revoke', requirePermission('api_key.manage'), asyncRoute(async (req, res) => {
  await revokeApiKey(actorOf(req), String(req.params.id));
  res.json({ ok: true });
}));
