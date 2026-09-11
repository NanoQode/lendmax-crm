/**
 * Tasks, notes and the file timeline.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../db/pool.ts';
import { recordAudit, recordAuditSafely } from '../../services/audit.ts';
import { can } from '../../domain/permissions.ts';
import { asyncRoute, AppError, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';

export const workRoutes: Router = Router();
workRoutes.use(requireAuth);

// ── Tasks ──────────────────────────────────────────────────────────────────

const TaskInput = z.object({
  title: z.string().trim().min(1, 'A task needs a title.'),
  description: z.string().optional(),
  application_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  category: z
    .enum(['follow_up', 'document_request', 'lender_submission', 'application_review',
           'compliance', 'condition', 'appointment', 'closing_deadline', 'renewal', 'other'])
    .default('follow_up'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional(),
  due_time: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.').optional(),
  assignee_ids: z.array(z.string().uuid()).default([]),
});

workRoutes.get(
  '/tasks',
  requirePermission('task.view'),
  asyncRoute(async (req, res) => {
    const q = z
      .object({
        application_id: z.string().uuid().optional(),
        assigned_to: z.string().uuid().optional(),
        status: z.enum(['open', 'in_progress', 'waiting', 'completed', 'cancelled', 'active', 'all'])
          .default('active'),
        due: z.enum(['overdue', 'today', 'week', 'all']).default('all'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const user = req.user!;

    const params: unknown[] = [user.organization_id];
    const where = ['t.organization_id = $1'];

    if (q.status === 'active') where.push(`t.status IN ('open','in_progress','waiting')`);
    else if (q.status !== 'all') {
      params.push(q.status);
      where.push(`t.status = $${params.length}`);
    }
    if (q.application_id) {
      params.push(q.application_id);
      where.push(`t.application_id = $${params.length}`);
    }
    // Default to the caller's own work: a task list showing everybody's tasks
    // is a list nobody reads.
    const assignee = q.assigned_to ?? (q.application_id ? null : user.id);
    if (assignee) {
      params.push(assignee);
      where.push(`EXISTS (SELECT 1 FROM task_assignees ta
                           WHERE ta.task_id = t.id AND ta.user_id = $${params.length})`);
    }
    if (q.due === 'overdue') where.push('t.due_on < CURRENT_DATE');
    else if (q.due === 'today') where.push('t.due_on = CURRENT_DATE');
    else if (q.due === 'week') where.push('t.due_on BETWEEN CURRENT_DATE AND CURRENT_DATE + 7');

    params.push(q.limit);
    const { rows } = await query(
      `SELECT t.*,
              trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) AS client_name,
              COALESCE(a.list, '[]'::json) AS assignees,
              (t.due_on IS NOT NULL AND t.due_on < CURRENT_DATE
                 AND t.status IN ('open','in_progress','waiting')) AS overdue
         FROM tasks t
         LEFT JOIN customers c ON c.id = t.customer_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('user_id', u.id, 'name', u.name)) AS list
             FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = t.id
         ) a ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY (t.due_on IS NULL), t.due_on, t.due_time NULLS LAST,
                 CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                                 WHEN 'normal' THEN 2 ELSE 3 END
        LIMIT $${params.length}`,
      params,
    );
    res.json({ ok: true, tasks: rows });
  }),
);

workRoutes.post(
  '/tasks',
  requirePermission('task.manage'),
  asyncRoute(async (req, res) => {
    const input = TaskInput.parse(req.body);
    const user = req.user!;

    if (!input.application_id && !input.customer_id && !input.assignee_ids.length) {
      throw new AppError(
        'A task needs somebody to do it or a file to sit on, or nobody will ever see it.',
        422, 'validation_failed',
      );
    }

    // If a file is named, the customer follows from it rather than being taken
    // on trust from the client — otherwise a task can be attached to one
    // client's file and another client's record.
    let customerId = input.customer_id ?? null;
    if (input.application_id) {
      const app = await queryOne<{ customer_id: string }>(
        'SELECT customer_id FROM applications WHERE id = $1 AND organization_id = $2',
        [input.application_id, user.organization_id],
      );
      if (!app) throw notFound('That application');
      customerId = app.customer_id;
    }

    const assignees = input.assignee_ids.length ? input.assignee_ids : [user.id];

    const task = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO tasks (organization_id, application_id, customer_id, title, description,
                            category, priority, due_on, due_time, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [user.organization_id, input.application_id ?? null, customerId, input.title,
         input.description ?? null, input.category, input.priority,
         input.due_on ?? null, input.due_time ?? null, user.id],
      );
      const taskId = rows[0]!.id;

      for (const userId of assignees) {
        await client.query(
          'INSERT INTO task_assignees (task_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [taskId, userId],
        );
        if (userId !== user.id) {
          await client.query(
            `INSERT INTO notifications (organization_id, user_id, kind, title, body, entity_type, entity_id)
             VALUES ($1,$2,'task',$3,$4,'task',$5)`,
            [user.organization_id, userId, 'New task assigned to you',
             `${user.name}: ${input.title}`, taskId],
          );
        }
      }

      // The denormalised stamp the list and the staleness rules read.
      if (input.application_id) {
        await client.query(
          `UPDATE applications
              SET next_task_at = (
                    SELECT MIN(due_on::timestamptz) FROM tasks
                     WHERE application_id = $1 AND status IN ('open','in_progress','waiting')
                       AND due_on IS NOT NULL)
            WHERE id = $1`,
          [input.application_id],
        );
      }
      return taskId;
    });

    res.status(201).json({ ok: true, id: task });
  }),
);

workRoutes.patch(
  '/tasks/:id',
  requirePermission('task.manage'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        status: z.enum(['open', 'in_progress', 'waiting', 'completed', 'cancelled']).optional(),
        title: z.string().trim().min(1).optional(),
        due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      })
      .parse(req.body);
    const user = req.user!;

    const existing = await queryOne<{ id: string; application_id: string | null; title: string; status: string }>(
      'SELECT id, application_id, title, status FROM tasks WHERE id = $1 AND organization_id = $2',
      [id, user.organization_id],
    );
    if (!existing) throw notFound('That task');

    const sets: string[] = [];
    const params: unknown[] = [id];
    if (body.status) {
      params.push(body.status);
      sets.push(`status = $${params.length}`);
      if (body.status === 'completed') {
        params.push(user.id);
        sets.push('completed_at = now()', `completed_by = $${params.length}`);
      }
    }
    if (body.title) {
      params.push(body.title);
      sets.push(`title = $${params.length}`);
    }
    if (body.due_on !== undefined) {
      params.push(body.due_on);
      sets.push(`due_on = $${params.length}::date`);
    }
    if (body.priority) {
      params.push(body.priority);
      sets.push(`priority = $${params.length}`);
    }
    if (!sets.length) {
      res.json({ ok: true, unchanged: true });
      return;
    }

    await query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, params);

    if (existing.application_id) {
      await query(
        `UPDATE applications
            SET next_task_at = (SELECT MIN(due_on::timestamptz) FROM tasks
                                 WHERE application_id = $1 AND status IN ('open','in_progress','waiting')
                                   AND due_on IS NOT NULL)
          WHERE id = $1`,
        [existing.application_id],
      );
    }

    recordAuditSafely({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'task.update',
      entityType: 'task',
      entityId: id,
      summary: body.status
        ? `Task "${existing.title}" marked ${body.status}`
        : `Task "${existing.title}" updated`,
      before: { status: existing.status },
      after: body,
    });

    res.json({ ok: true });
  }),
);

// ── Notes ──────────────────────────────────────────────────────────────────

workRoutes.get(
  '/applications/:id/notes',
  requirePermission('note.view'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const user = req.user!;
    // Visibility is a WHERE clause, not a filter applied afterwards. A
    // compliance note must not be read out of the database for somebody who
    // may not see it, even if it is dropped before the response is built.
    const { rows } = await query(
      `SELECT n.id, n.body, n.note_type, n.visibility, n.pinned, n.author_name,
              n.created_at, n.edited_at
         FROM notes n
        WHERE n.application_id = $1 AND n.organization_id = $2 AND n.deleted_at IS NULL
          AND (n.visibility = 'team'
            OR (n.visibility = 'compliance' AND $3::boolean)
            OR (n.visibility = 'private' AND n.author_id = $4))
        ORDER BY n.pinned DESC, n.created_at DESC LIMIT 200`,
      [id, user.organization_id, can(user, 'note.view_compliance'), user.id],
    );
    res.json({ ok: true, notes: rows });
  }),
);

workRoutes.post(
  '/applications/:id/notes',
  requirePermission('note.create'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = z
      .object({
        body: z.string().trim().min(1, 'A note needs some text.'),
        note_type: z.enum(['sales', 'underwriting', 'compliance', 'call', 'meeting', 'lender', 'general'])
          .default('general'),
        visibility: z.enum(['team', 'compliance', 'private']).default('team'),
        pinned: z.boolean().default(false),
      })
      .parse(req.body);
    const user = req.user!;

    if (input.note_type === 'compliance' && !can(user, 'compliance.edit')) {
      throw new AppError('Only compliance staff may write a compliance note.', 403, 'forbidden');
    }

    const app = await queryOne<{ customer_id: string }>(
      'SELECT customer_id FROM applications WHERE id = $1 AND organization_id = $2',
      [id, user.organization_id],
    );
    if (!app) throw notFound('That application');

    const note = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO notes (organization_id, application_id, customer_id, body, note_type,
                            visibility, pinned, author_id, author_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [user.organization_id, id, app.customer_id, input.body, input.note_type,
         input.visibility, input.pinned, user.id, user.name],
      );
      await client.query(
        `INSERT INTO activity (organization_id, application_id, customer_id, kind,
                               actor_user_id, actor_name, summary, entity_type, entity_id)
         VALUES ($1,$2,$3,'note',$4,$5,$6,'note',$7)`,
        [user.organization_id, id, app.customer_id, user.id, user.name,
         `${user.name} added a ${input.note_type} note`, rows[0]!.id],
      );
      await client.query('UPDATE applications SET last_activity_at = now() WHERE id = $1', [id]);
      return rows[0]!.id;
    });

    res.status(201).json({ ok: true, id: note });
  }),
);

// ── The timeline ───────────────────────────────────────────────────────────

workRoutes.get(
  '/applications/:id/activity',
  requirePermission('customer.view'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const q = z
      .object({
        kind: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        before: z.string().optional(),
      })
      .parse(req.query);
    const user = req.user!;

    const params: unknown[] = [id, user.organization_id];
    const where = ['a.application_id = $1', 'a.organization_id = $2'];
    if (q.kind) {
      params.push(q.kind.split(','));
      where.push(`a.kind = ANY($${params.length})`);
    }
    if (q.before) {
      params.push(q.before);
      where.push(`a.id < $${params.length}::bigint`);
    }
    params.push(q.limit);

    const { rows } = await query(
      `SELECT a.id, a.at, a.kind, a.actor_name, a.actor_kind, a.summary, a.detail,
              a.entity_type, a.entity_id
         FROM activity a WHERE ${where.join(' AND ')}
        ORDER BY a.at DESC, a.id DESC LIMIT $${params.length}`,
      params,
    );
    res.json({ ok: true, activity: rows, next_before: rows.length === q.limit ? rows.at(-1)?.id : null });
  }),
);

/** The readable, file-scoped view of the audit log. */
workRoutes.get(
  '/applications/:id/audit',
  requirePermission('audit.view'),
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const user = req.user!;
    const { rows } = await query(
      `SELECT id, at, actor_name, actor_role, actor_kind, action, summary, before_json, after_json
         FROM audit_log
        WHERE organization_id = $1 AND entity_type = 'application' AND entity_id = $2
        ORDER BY at DESC LIMIT 200`,
      [user.organization_id, id],
    );
    res.json({ ok: true, entries: rows });
  }),
);
