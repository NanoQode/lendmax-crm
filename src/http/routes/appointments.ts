/**
 * Appointments, for the admin panel — and each person's Google Calendar
 * connection. The rules are in services/appointments.ts, which the v1 API
 * calls too; this file only decides the caller's scope.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { can } from '../../domain/permissions.ts';
import {
  appointmentMeta, availability, bookableFiles, bookableHosts, bookAppointment, cancelAppointment,
  confirmAppointment, getAppointment, listAppointments, promptsFor, recordOutcome, retryGoogle,
  snoozePrompt, syncOne, updateAppointment, type Scope,
} from '../../services/appointments.ts';
import { connectUrl, disconnect, finishConnect, googleStatus } from '../../services/google-calendar.ts';
import { AppError, asyncRoute } from '../middleware/errors.ts';
import { actorOf, requireAuth } from '../middleware/auth.ts';

export const appointmentRoutes: Router = Router();

export const scopeOf = (req: Request): Scope => ({
  actor: actorOf(req),
  viewAll: can(req.user!, 'appointment.view_all'),
  manage: can(req.user!, 'appointment.manage'),
  manageAll: can(req.user!, 'appointment.manage_all'),
  timezone: req.user!.timezone,
});

/** Anyone who can see appointments at all. */
const seeing = (req: Request) => {
  const u = req.user!;
  if (!can(u, 'appointment.view') && !can(u, 'appointment.view_all') && !can(u, 'appointment.manage_all')) {
    throw new AppError('Appointments need the appointments permission. Ask an admin.', 403, 'forbidden',
                       { permission: 'appointment.view' });
  }
  return scopeOf(req);
};

// The Google callback is a browser redirect, answered with a redirect.
const back = (outcome: string, message?: string) =>
  `${env.BASE_PATH.replace(/\/$/, '')}/appointments?google=${outcome}${message ? `&message=${encodeURIComponent(message)}` : ''}`;

appointmentRoutes.get('/integrations/google/callback', asyncRoute(async (req, res) => {
  if (!req.user) {
    res.redirect(`${env.BASE_PATH.replace(/\/$/, '')}/?next=${encodeURIComponent('/appointments')}`);
    return;
  }
  const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
  if (q.error || !q.code || !q.state) {
    res.redirect(back('error', q.error === 'access_denied' ? 'Google access was not granted.' : 'Google did not complete the sign-in.'));
    return;
  }
  try {
    const { email } = await finishConnect(req.user, q.code, q.state, req.ip);
    res.redirect(back('connected', email));
  } catch (err) {
    res.redirect(back('error', (err as Error).message));
  }
}));

// Per route rather than router-wide: every router here is mounted at the API
// root, and a router-level guard would answer for routes that are not its own.
// ── Google Calendar, per person ────────────────────────────────────────────

appointmentRoutes.get('/integrations/google/status', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await googleStatus(req.user!.organization_id, req.user!.id)) });
}));

appointmentRoutes.post('/integrations/google/connect', requireAuth, asyncRoute(async (req, res) => {
  seeing(req);
  res.json({ ok: true, url: await connectUrl(req.user!.organization_id, req.user!.id) });
}));

appointmentRoutes.post('/integrations/google/disconnect', requireAuth, asyncRoute(async (req, res) => {
  await disconnect(req.user!, req.ip);
  res.json({ ok: true });
}));

appointmentRoutes.post('/integrations/google/sync', requireAuth, asyncRoute(async (req, res) => {
  const applied = await syncOne(req.user!.id, req.user!.organization_id, req.user!.name);
  res.json({ ok: true, applied, status: await googleStatus(req.user!.organization_id, req.user!.id) });
}));

// ── Appointments ───────────────────────────────────────────────────────────

appointmentRoutes.get('/appointments', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await listAppointments(seeing(req), req.query)) });
}));

appointmentRoutes.get('/appointments/meta', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await appointmentMeta(seeing(req))) });
}));

appointmentRoutes.get('/appointments/hosts', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, hosts: await bookableHosts(seeing(req)) });
}));

appointmentRoutes.get('/appointments/files', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, files: await bookableFiles(seeing(req), req.query) });
}));

appointmentRoutes.get('/appointments/availability', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await availability(seeing(req), req.query)) });
}));

appointmentRoutes.get('/appointments/prompts', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, prompts: await promptsFor(seeing(req)) });
}));

appointmentRoutes.get('/appointments/:id', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, appointment: await getAppointment(seeing(req), String(req.params.id)) });
}));

appointmentRoutes.post('/appointments', requireAuth, asyncRoute(async (req, res) => {
  res.status(201).json({ ok: true, ...(await bookAppointment(seeing(req), req.body)) });
}));

appointmentRoutes.patch('/appointments/:id', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await updateAppointment(seeing(req), String(req.params.id), req.body)) });
}));

appointmentRoutes.post('/appointments/:id/cancel', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await cancelAppointment(seeing(req), String(req.params.id), req.body)) });
}));

appointmentRoutes.post('/appointments/:id/outcome', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await recordOutcome(seeing(req), String(req.params.id), req.body)) });
}));

appointmentRoutes.post('/appointments/:id/confirm', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, appointment: await confirmAppointment(seeing(req), String(req.params.id)) });
}));

appointmentRoutes.post('/appointments/:id/snooze', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await snoozePrompt(seeing(req), String(req.params.id), req.body)) });
}));

appointmentRoutes.post('/appointments/:id/google-retry', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await retryGoogle(seeing(req), String(req.params.id))) });
}));
