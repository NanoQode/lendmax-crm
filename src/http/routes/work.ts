/**
 * Notes and the file timeline. Tasks have their own module — see routes/tasks.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../db/pool.ts';
import { can } from '../../domain/permissions.ts';
import { asyncRoute, AppError, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';

export const workRoutes: Router = Router();
workRoutes.use(requireAuth);

// ── Tasks ──────────────────────────────────────────────────────────────────
//
// Tasks moved to their own module: `domain/tasks.ts` for the rules,
// `services/tasks.ts` for the writing, `http/routes/tasks.ts` for the
// endpoints. Notes and the timeline stayed here, which is why this file did
// not move with them.

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
