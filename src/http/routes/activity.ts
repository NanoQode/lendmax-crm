/**
 * Activity logs, for the admin panel. Everybody signed in reads their own;
 * `activity.view_all` reads everyone's. There is deliberately no DELETE.
 * The rules are in services/activity.ts, which the v1 API calls too.
 */
import { Router, type Request } from 'express';
import { can } from '../../domain/permissions.ts';
import { activityOptions, listActivity, type Scope } from '../../services/activity.ts';
import { asyncRoute } from '../middleware/errors.ts';

export const activityRoutes: Router = Router();

const scopeOf = (req: Request): Scope => ({
  organizationId: req.user!.organization_id,
  userId: req.user!.id,
  seeAll: can(req.user!, 'activity.view_all'),
  timezone: req.user!.timezone,
});

activityRoutes.get('/activity', asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await listActivity(scopeOf(req), req.query)) });
}));

activityRoutes.get('/activity/options', asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await activityOptions(scopeOf(req))) });
}));
