/**
 * Tasks — the admin-panel endpoints.
 *
 * `task.view` gates reading and `task.manage` writing; `task.view_all` and
 * `task.manage_all` widen both to everybody's work. The route reads those once
 * and hands them to the service as a scope, so the rules live in one place.
 *
 * The v1 API for connected websites is in `api-v1.ts` and calls the same
 * service with the same scope, built from the key's permissions instead.
 */
import { Router } from 'express';
import { z } from 'zod';
import { can } from '../../domain/permissions.ts';
import {
  assignableFiles, createTask, getTask, listTasks, previewOwner, taskMeta, updateTask,
  type Scope,
} from '../../services/tasks.ts';
import { asyncRoute } from '../middleware/errors.ts';
import { actorOf, requireAuth, requirePermission } from '../middleware/auth.ts';
import type { Request } from 'express';

export const taskRoutes: Router = Router();
taskRoutes.use('/tasks', requireAuth);

const UUID = z.string().uuid();

export const scopeOf = (req: Request): Scope => ({
  actor: actorOf(req),
  viewAll: can(req.user!, 'task.view_all'),
  manage: can(req.user!, 'task.manage'),
  manageAll: can(req.user!, 'task.manage_all'),
  timezone: req.user!.timezone,
});

taskRoutes.get(
  '/tasks/meta',
  requirePermission('task.view'),
  asyncRoute(async (req, res) => {
    res.json({ ok: true, ...(await taskMeta(scopeOf(req))) });
  }),
);

/**
 * The client list the form offers: their own files, or every file for somebody
 * who makes work for others — each carrying whose file it is.
 */
taskRoutes.get(
  '/tasks/files',
  requirePermission('task.view'),
  asyncRoute(async (req, res) => {
    res.json({ ok: true, files: await assignableFiles(scopeOf(req), req.query) });
  }),
);

/**
 * Whose task this would be, asked the moment a client is picked.
 *
 * This is what fills the read-only "assigned to" field, so that an admin sees
 * whose work they are about to make before they make it.
 */
taskRoutes.get(
  '/tasks/owner',
  requirePermission('task.view'),
  asyncRoute(async (req, res) => {
    const q = z.object({ application_id: UUID }).parse(req.query);
    res.json({ ok: true, ...(await previewOwner(scopeOf(req), q.application_id)) });
  }),
);

taskRoutes.get(
  '/tasks',
  requirePermission('task.view'),
  asyncRoute(async (req, res) => {
    res.json({ ok: true, ...(await listTasks(scopeOf(req), req.query)) });
  }),
);

taskRoutes.post(
  '/tasks',
  requirePermission('task.manage'),
  asyncRoute(async (req, res) => {
    res.status(201).json({ ok: true, task: await createTask(scopeOf(req), req.body) });
  }),
);

taskRoutes.get(
  '/tasks/:id',
  requirePermission('task.view'),
  asyncRoute(async (req, res) => {
    res.json({ ok: true, task: await getTask(scopeOf(req), UUID.parse(req.params.id)) });
  }),
);

/** Edit, move, complete, reopen or cancel — all one call, because they are one row. */
taskRoutes.patch(
  '/tasks/:id',
  requirePermission('task.manage'),
  asyncRoute(async (req, res) => {
    res.json({ ok: true, task: await updateTask(scopeOf(req), UUID.parse(req.params.id), req.body) });
  }),
);

/** Completing is the thing people do most, so it has a door of its own. */
taskRoutes.post(
  '/tasks/:id/complete',
  requirePermission('task.manage'),
  asyncRoute(async (req, res) => {
    const task = await updateTask(scopeOf(req), UUID.parse(req.params.id), { status: 'completed' });
    res.json({ ok: true, task });
  }),
);

taskRoutes.post(
  '/tasks/:id/reopen',
  requirePermission('task.manage'),
  asyncRoute(async (req, res) => {
    const task = await updateTask(scopeOf(req), UUID.parse(req.params.id), { status: 'open' });
    res.json({ ok: true, task });
  }),
);
