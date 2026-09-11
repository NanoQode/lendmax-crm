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

export function registerHandlers(): void {
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
