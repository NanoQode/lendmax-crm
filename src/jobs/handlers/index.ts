/**
 * The handler registry.
 *
 * Imported once at boot. A job kind with no handler is dead-lettered rather
 * than retried, because an unknown kind is a deploy problem and retrying it
 * five times changes nothing.
 */
import { log } from '../../lib/logger.ts';
import { registerHandler } from '../worker.ts';
import { deliver } from '../../services/messaging.ts';
import { pushDeal } from '../../integrations/scarlett.ts';
import { registerAutomationHandlers } from './automation.ts';
import { registerCampaignHandlers } from './campaign.ts';
import { enqueue } from '../queue.ts';
import { queryOne } from '../../db/pool.ts';
import { purgeActivity } from '../../services/activity.ts';
import {
  ensureTemplates, retryGooglePush, runAppointmentTick, syncGoogleCalendars,
} from '../../services/appointments.ts';
import { ensureCommunity } from '../../services/chats.ts';
import { runTaskReminders } from '../../services/tasks.ts';

export function registerHandlers(): void {
  registerAutomationHandlers();
  registerCampaignHandlers();

  registerHandler('message.send', async (job) => {
    const messageId = String((job.payload as { messageId?: string }).messageId ?? '');
    if (!messageId) throw new Error('message.send needs a messageId.');
    const result = await deliver(messageId);
    // A suppressed message is a correct outcome, not a failure — the gate did
    // its job. Throwing here would retry it four more times and dead-letter a
    // decision that was right.
    if (!result.ok && result.status === 'failed') {
      throw new Error(result.error ?? 'The message could not be sent.');
    }
  });

  // The activity screen keeps 30 days. Daily; the screen and the API read
  // only the last 30 days whatever this has got to, so a late run never
  // shows anybody an entry it should not.
  registerHandler('activity.purge', async () => {
    const removed = await purgeActivity();
    if (removed) log.info('activity log purged', { removed });
    return { rerunAt: new Date(Date.now() + 24 * 3_600_000) };
  });

  // Appointment reminders, 15 minutes out. Every minute, so a reminder is
  // never more than a minute late.
  registerHandler('appointments.tick', async () => {
    const { reminded } = await runAppointmentTick();
    if (reminded) log.info('appointment reminders sent', { reminded });
    return { rerunAt: new Date(Date.now() + 60_000) };
  });

  // Task reminders, 15 minutes out by default. Every minute, so one is never
  // more than a minute late.
  registerHandler('tasks.tick', async () => {
    const { reminded } = await runTaskReminders();
    if (reminded) log.info('task reminders sent', { reminded });
    return { rerunAt: new Date(Date.now() + 60_000) };
  });

  // Meetings moved or deleted in somebody's Google Calendar.
  registerHandler('google.sync', async () => {
    const { applied } = await syncGoogleCalendars();
    if (applied) log.info('google calendar changes applied', { applied });
    return { rerunAt: new Date(Date.now() + 5 * 60_000) };
  });

  // A push to Google that failed at booking time, tried again with backoff.
  registerHandler('google.push', async (job) => {
    const appointmentId = String((job.payload as { appointmentId?: string }).appointmentId ?? '');
    const result = await retryGooglePush(appointmentId);
    if (result?.error) throw new Error(result.error);
  });

  registerHandler('scarlett.push', async (job) => {
    const payload = job.payload as { applicationId?: string; actorUserId?: string | null };
    if (!job.organization_id || !payload.applicationId) {
      throw new Error('scarlett.push needs an organization and an application.');
    }
    const result = await pushDeal(job.organization_id, payload.applicationId, {
      actorUserId: payload.actorUserId ?? null,
    });
    // Only a retryable failure is thrown. A file that is missing its province
    // will still be missing it in four minutes; that is for a person.
    if (!result.ok && result.retryable) {
      throw new Error(result.error ?? 'The Scarlett push failed.');
    }
    if (!result.ok) {
      log.warn('scarlett push needs a person', {
        applicationId: payload.applicationId, error: result.error,
      });
    }
  });
}

/**
 * Start the recurring work.
 *
 * The tick reschedules itself, so this only has to plant the first one — and
 * the dedupe key means a restart does not leave two of them running.
 */
export async function primeRecurringJobs(): Promise<void> {
  const org = await queryOne<{ id: string }>(
    'SELECT id FROM organizations ORDER BY created_at LIMIT 1',
  );
  if (!org) return;
  await enqueue('automation.tick', {}, { organizationId: org.id, dedupeKey: 'automation.tick' });
  await enqueue('activity.purge', {}, { dedupeKey: 'activity.purge' });
  await enqueue('appointments.tick', {}, { dedupeKey: 'appointments.tick' });
  await enqueue('google.sync', {}, { dedupeKey: 'google.sync' });
  await enqueue('tasks.tick', {}, { dedupeKey: 'tasks.tick' });
  // Every organization has the appointment email templates to edit.
  await ensureTemplates();
  // …and a Community group with everybody in it, including an organization
  // created after migration 0022 ran.
  await ensureCommunity();
}
