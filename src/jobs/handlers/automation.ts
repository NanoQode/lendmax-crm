/** Automation handlers: advancing an enrollment, and draining the event bus. */
import { queryOne } from '../../db/pool.ts';
import { registerHandler } from '../worker.ts';
import { enqueue } from '../queue.ts';
import { processEvents, runStep } from '../../services/automation-engine.ts';

export function registerAutomationHandlers(): void {
  registerHandler('automation.step', async (job) => {
    const enrollmentId = String((job.payload as { enrollmentId?: string }).enrollmentId ?? '');
    if (!enrollmentId) throw new Error('automation.step needs an enrollmentId.');
    const result = await runStep(enrollmentId);
    // Stopping and completing are correct outcomes, not failures. Only a
    // genuine fault is thrown, so the queue's retry is reserved for faults.
    if (result.status === 'failed') {
      throw new Error(result.reason ?? 'The automation step failed.');
    }
  });

  /**
   * Drain the event bus.
   *
   * Rescheduled by the handler rather than run on a timer, so there is exactly
   * one of it however many workers are running — the queue's dedupe key is
   * what enforces that.
   */
  registerHandler('automation.tick', async (job) => {
    const organizationId = job.organization_id
      ?? (await queryOne<{ id: string }>('SELECT id FROM organizations ORDER BY created_at LIMIT 1'))?.id;
    if (!organizationId) return;

    await processEvents(organizationId);

    await enqueue('automation.tick', {}, {
      organizationId,
      runAfter: new Date(Date.now() + 30_000),
      dedupeKey: 'automation.tick',
    });
  });
}
