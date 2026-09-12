/**
 * Appointments and the calendar.
 *
 * An appointment stores BOTH the instant and the zone it was agreed in. The
 * instant is what a reminder fires on; the zone is what "2pm" meant to the
 * client. Storing only the instant loses the ability to say "2pm your time"
 * correctly after a daylight-saving change, and a broker telling a client
 * the wrong hour because the clocks moved is a small failure that costs a
 * whole meeting.
 *
 * A no-show is an event, not a deletion. It has its own status, its own
 * timestamp, and it starts the rebooking sequence; a rebooked appointment
 * points at the one it replaced, which is how that sequence knows to stop.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../db/pool.ts';
import { recordAudit } from '../../services/audit.ts';
import { asyncRoute, AppError, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';
import { can } from '../../domain/permissions.ts';
import { env } from '../../config/env.ts';

export const calendarRoutes: Router = Router();
calendarRoutes.use(requireAuth);

calendarRoutes.get(
  '/calendar',
  requirePermission('appointment.manage'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      scope: z.enum(['mine', 'all']).default('mine'),
    }).parse(req.query);

    const params: unknown[] = [user.organization_id, q.from ?? null, q.to ?? null];
    let filter = '';
    // A broker who cannot see everybody's files sees their own diary, and
    // asking for 'all' does not change that.
    if (q.scope === 'mine' || !can(user, 'customer.view_all')) {
      params.push(user.id);
      filter = `AND a.user_id = $4`;
    }

    const { rows } = await query(
      `SELECT a.id, a.starts_at, a.ends_at, a.timezone, a.appointment_type, a.status,
              a.location, a.meeting_url, a.notes, a.outcome,
              a.google_event_id,
              c.id AS customer_id, c.first_name, c.last_name, c.phone_e164, c.email,
              app.id AS application_id, app.portal_reference, app.stage_key,
              u.id AS user_id, u.name AS user_name
         FROM appointments a
         JOIN customers c ON c.id = a.customer_id
         LEFT JOIN applications app ON app.id = a.application_id
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.organization_id = $1
          AND ($2::timestamptz IS NULL OR a.starts_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR a.starts_at < $3::timestamptz)
          ${filter}
        ORDER BY a.starts_at`,
      params);

    const counts = await queryOne(
      `SELECT count(*) FILTER (WHERE starts_at::date = CURRENT_DATE
                                 AND status IN ('booked','confirmed'))::int AS today,
              count(*) FILTER (WHERE starts_at > now()
                                 AND starts_at < now() + interval '7 days'
                                 AND status IN ('booked','confirmed'))::int AS this_week,
              count(*) FILTER (WHERE status = 'no_show'
                                 AND no_show_at > now() - interval '30 days')::int AS no_shows_30d,
              count(*) FILTER (WHERE status = 'booked' AND starts_at > now()
                                 AND confirmed_at IS NULL)::int AS unconfirmed
         FROM appointments WHERE organization_id = $1
           ${q.scope === 'mine' ? 'AND user_id = $2' : ''}`,
      q.scope === 'mine' ? [user.organization_id, user.id] : [user.organization_id]);

    res.json({
      appointments: rows,
      counts,
      timezone: user.timezone ?? env.BROKERAGE_TIMEZONE,
      google_connected: false,
    });
  }),
);

const AppointmentInput = z.object({
  customer_id: z.string().uuid(),
  application_id: z.string().uuid().nullable().optional(),
  user_id: z.string().uuid().optional(),
  appointment_type: z.string().trim().default('discovery'),
  starts_at: z.string(),
  duration_minutes: z.number().int().min(5).max(480).default(30),
  timezone: z.string().default(env.BROKERAGE_TIMEZONE),
  location: z.string().trim().optional(),
  meeting_url: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

calendarRoutes.post(
  '/appointments',
  requirePermission('appointment.manage'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = AppointmentInput.parse(req.body);

    const startsAt = new Date(body.starts_at);
    if (Number.isNaN(startsAt.getTime())) {
      throw new AppError('That is not a date and time we can read.', 400);
    }
    const endsAt = new Date(startsAt.getTime() + body.duration_minutes * 60_000);

    // Double-booking is a mistake somebody makes at speed, and finding out
    // from the client is the worst way to find out.
    const owner = body.user_id ?? user.id;
    const clash = await queryOne<{ id: string; starts_at: string; first_name: string }>(
      `SELECT a.id, a.starts_at, c.first_name
         FROM appointments a JOIN customers c ON c.id = a.customer_id
        WHERE a.user_id = $1 AND a.status IN ('booked','confirmed')
          AND a.starts_at < $3::timestamptz AND a.ends_at > $2::timestamptz
        LIMIT 1`,
      [owner, startsAt, endsAt]);
    if (clash) {
      throw new AppError(
        `That overlaps an appointment with ${clash.first_name}. Choose another time, or `
        + 'move the other one first.', 409, 'double_booked', { appointment_id: clash.id });
    }

    const created = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO appointments (organization_id, application_id, customer_id, user_id,
                                   appointment_type, starts_at, ends_at, timezone, location,
                                   meeting_url, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'booked') RETURNING id`,
        [user.organization_id, body.application_id ?? null, body.customer_id, owner,
         body.appointment_type, startsAt, endsAt, body.timezone,
         body.location ?? null, body.meeting_url ?? null, body.notes ?? null]);
      const id = rows[0]!.id;

      await client.query(
        `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id,
                                    actor_user_id, payload, dedupe_key)
         VALUES ($1,'appointment.booked',$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [user.organization_id, body.customer_id, body.application_id ?? null, user.id,
         JSON.stringify({ appointment_id: id, starts_at: startsAt.toISOString() }),
         `appointment.booked:${id}`]);

      return id;
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'appointment.book',
      entityType: 'appointment',
      entityId: created,
      summary: `${body.appointment_type} booked for ${startsAt.toISOString()}`,
    });

    res.status(201).json({ id: created });
  }),
);

/**
 * Change an appointment's outcome.
 *
 * A no-show is recorded as one rather than deleted, because the pattern
 * matters: a client who has missed twice is a different conversation from
 * one who has missed once, and a deleted appointment says neither.
 */
calendarRoutes.post(
  '/appointments/:id/outcome',
  requirePermission('appointment.manage'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      status: z.enum(['confirmed', 'completed', 'no_show', 'cancelled']),
      outcome: z.string().trim().optional(),
      reason: z.string().trim().optional(),
    }).parse(req.body);

    const appointment = await queryOne<{
      id: string; customer_id: string; application_id: string | null;
      status: string; starts_at: string;
    }>(
      `SELECT id, customer_id, application_id, status, starts_at FROM appointments
        WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!appointment) throw notFound('That appointment');

    if (body.status === 'cancelled' && !body.reason) {
      throw new AppError('Record why it was cancelled.', 400);
    }
    if (body.status === 'no_show' && new Date(appointment.starts_at) > new Date()) {
      throw new AppError(
        'That appointment has not happened yet, so nobody has missed it.', 400);
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE appointments
            SET status = $2,
                outcome = COALESCE($3, outcome),
                cancelled_reason = COALESCE($4, cancelled_reason),
                confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END,
                no_show_at = CASE WHEN $2 = 'no_show' THEN now() ELSE no_show_at END,
                cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END
          WHERE id = $1`,
        [appointment.id, body.status, body.outcome ?? null, body.reason ?? null]);

      const eventType = body.status === 'no_show' ? 'appointment.no_show'
        : body.status === 'completed' ? 'appointment.completed' : null;
      if (eventType) {
        await client.query(
          `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id,
                                      actor_user_id, dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
          [user.organization_id, eventType, appointment.customer_id,
           appointment.application_id, user.id, `${eventType}:${appointment.id}`]);
      }
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: `appointment.${body.status}`,
      entityType: 'appointment',
      entityId: appointment.id,
      summary: `Appointment marked ${body.status.replace(/_/g, ' ')}`
        + (body.reason ? ` — ${body.reason}` : ''),
    });

    res.json({ ok: true, status: body.status });
  }),
);

/**
 * Rebook.
 *
 * The new appointment points at the one it replaces, and the old one is
 * marked rescheduled rather than deleted — which is what lets the no-show
 * follow-up stop the moment a client rebooks, instead of chasing somebody
 * who has already sorted it out.
 */
calendarRoutes.post(
  '/appointments/:id/rebook',
  requirePermission('appointment.manage'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      starts_at: z.string(),
      duration_minutes: z.number().int().min(5).max(480).default(30),
      notes: z.string().trim().optional(),
    }).parse(req.body);

    const original = await queryOne<{
      id: string; customer_id: string; application_id: string | null; user_id: string;
      appointment_type: string; timezone: string; location: string | null;
      meeting_url: string | null;
    }>(
      `SELECT id, customer_id, application_id, user_id, appointment_type, timezone,
              location, meeting_url
         FROM appointments WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!original) throw notFound('That appointment');

    const startsAt = new Date(body.starts_at);
    if (Number.isNaN(startsAt.getTime())) {
      throw new AppError('That is not a date and time we can read.', 400);
    }
    const endsAt = new Date(startsAt.getTime() + body.duration_minutes * 60_000);

    const created = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO appointments (organization_id, application_id, customer_id, user_id,
                                   appointment_type, starts_at, ends_at, timezone, location,
                                   meeting_url, notes, status, rescheduled_from_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'booked',$12) RETURNING id`,
        [user.organization_id, original.application_id, original.customer_id, original.user_id,
         original.appointment_type, startsAt, endsAt, original.timezone, original.location,
         original.meeting_url, body.notes ?? null, original.id]);

      await client.query(
        `UPDATE appointments SET status = 'rescheduled' WHERE id = $1
          AND status NOT IN ('completed')`, [original.id]);

      await client.query(
        `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id,
                                    actor_user_id, payload, dedupe_key)
         VALUES ($1,'appointment.booked',$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [user.organization_id, original.customer_id, original.application_id, user.id,
         JSON.stringify({ rebooked_from: original.id }), `appointment.booked:${rows[0]!.id}`]);

      return rows[0]!.id;
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'appointment.rebook',
      entityType: 'appointment',
      entityId: created,
      summary: `Rebooked for ${startsAt.toISOString()}`,
    });

    res.status(201).json({ id: created, replaces: original.id });
  }),
);
