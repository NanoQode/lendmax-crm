/**
 * The job queue.
 *
 * Postgres with `FOR UPDATE SKIP LOCKED`, not Redis. This queue holds scheduled
 * client messages, renewal milestones and automation steps — a queue that can
 * lose its contents on restart is a queue that silently stops following up on
 * mortgage files, and nobody notices for a month.
 *
 * Three properties everything else relies on:
 *
 *   IDEMPOTENT ENQUEUE. `dedupe_key` is unique across pending and running
 *   work, so the same job asked for twice is one job. That is what lets a
 *   webhook be delivered twice — and it will be — without texting a client
 *   twice.
 *
 *   AT-LEAST-ONCE, NOT EXACTLY-ONCE. A worker can die between doing the work
 *   and recording that it did. Handlers must therefore be safe to run twice;
 *   the ones that send something use a dedupe key on the message itself.
 *
 *   VISIBLE FAILURE. A job that exhausts its attempts becomes `dead` rather
 *   than vanishing, and `dead` is on the status screen. Work that gave up
 *   quietly is the failure mode that costs a client.
 */
import { query, queryOne } from '../db/pool.ts';
import { log } from '../lib/logger.ts';

export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';

export type Job<T = Record<string, unknown>> = {
  id: string;
  organization_id: string | null;
  queue: string;
  kind: string;
  payload: T;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  dedupe_key: string | null;
};

export type EnqueueOptions = {
  organizationId?: string | null;
  queue?: string;
  /** Run no earlier than this. Used for every delay and every schedule. */
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
  /** Makes the enqueue idempotent while the job is pending or running. */
  dedupeKey?: string;
};

export async function enqueue(
  kind: string,
  payload: Record<string, unknown> = {},
  options: EnqueueOptions = {},
): Promise<{ id: string | null; deduplicated: boolean }> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO jobs (organization_id, queue, kind, payload, run_after, priority,
                       max_attempts, dedupe_key)
     VALUES ($1,$2,$3,$4::jsonb,COALESCE($5::timestamptz, now()),$6,$7,$8)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('pending','running')
     DO NOTHING
     RETURNING id`,
    [
      options.organizationId ?? null,
      options.queue ?? 'default',
      kind,
      JSON.stringify(payload),
      options.runAfter ?? null,
      options.priority ?? 100,
      options.maxAttempts ?? 5,
      options.dedupeKey ?? null,
    ],
  );
  return { id: row?.id ?? null, deduplicated: !row };
}

/**
 * Claim up to `limit` jobs for this worker.
 *
 * SKIP LOCKED is what makes more than one worker safe: a row another worker
 * has taken is stepped over rather than waited for, so two workers do twice
 * the work instead of taking turns.
 */
export async function claim(
  workerId: string,
  options: { queue?: string; limit?: number } = {},
): Promise<Job[]> {
  const { rows } = await query<Job>(
    `UPDATE jobs SET state = 'running', locked_at = now(), locked_by = $1,
                     attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM jobs
         WHERE state = 'pending' AND run_after <= now() AND queue = $2
         ORDER BY priority, run_after, id
         FOR UPDATE SKIP LOCKED
         LIMIT $3
      )
      RETURNING id, organization_id, queue, kind, payload, attempts, max_attempts,
                run_after, dedupe_key`,
    [workerId, options.queue ?? 'default', options.limit ?? 5],
  );
  return rows;
}

export async function succeed(jobId: string): Promise<void> {
  await query(
    `UPDATE jobs SET state = 'succeeded', finished_at = now(), locked_at = NULL,
                     locked_by = NULL, last_error = NULL
      WHERE id = $1`,
    [jobId],
  );
}

/**
 * Record a failure and decide whether to try again.
 *
 * Exponential backoff with a cap, and jitter. Jitter matters: without it, a
 * hundred jobs that failed together because a provider was down all retry at
 * the same instant and take it down again the moment it recovers.
 */
export async function fail(job: Job, error: unknown): Promise<'retry' | 'dead'> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.max_attempts;

  if (exhausted) {
    await query(
      `UPDATE jobs SET state = 'dead', finished_at = now(), locked_at = NULL,
                       locked_by = NULL, last_error = $2
        WHERE id = $1`,
      [job.id, message.slice(0, 2000)],
    );
    log.error('job dead-lettered', {
      id: job.id, kind: job.kind, attempts: job.attempts, error: message,
    });
    return 'dead';
  }

  const base = Math.min(30 * 2 ** (job.attempts - 1), 3600);
  const delaySeconds = Math.round(base * (0.75 + Math.random() * 0.5));
  await query(
    `UPDATE jobs SET state = 'pending', locked_at = NULL, locked_by = NULL,
                     last_error = $2, run_after = now() + ($3 || ' seconds')::interval
      WHERE id = $1`,
    [job.id, message.slice(0, 2000), String(delaySeconds)],
  );
  log.warn('job failed, will retry', {
    id: job.id, kind: job.kind, attempt: job.attempts, inSeconds: delaySeconds, error: message,
  });
  return 'retry';
}

/**
 * Return work stranded by a worker that died mid-job.
 *
 * Without this a crash leaves rows `running` forever: invisible to the claim
 * query, never retried, and never reported. The timeout is generous because
 * reclaiming a job that is merely slow means running it twice.
 */
export async function reclaimStalled(olderThanMinutes = 15): Promise<number> {
  const result = await query(
    `UPDATE jobs SET state = 'pending', locked_at = NULL, locked_by = NULL,
                     last_error = COALESCE(last_error, 'Reclaimed after the worker stopped responding')
      WHERE state = 'running' AND locked_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  if (result.rowCount) log.warn('reclaimed stalled jobs', { count: result.rowCount });
  return result.rowCount ?? 0;
}

export async function cancelByDedupeKey(prefix: string): Promise<number> {
  const result = await query(
    `UPDATE jobs SET state = 'cancelled', finished_at = now()
      WHERE state = 'pending' AND dedupe_key LIKE $1 || '%'`,
    [prefix],
  );
  return result.rowCount ?? 0;
}

export async function queueStats(): Promise<Record<string, number>> {
  const { rows } = await query<{ state: string; count: number }>(
    `SELECT state, COUNT(*)::int AS count FROM jobs
      WHERE created_at > now() - interval '7 days' GROUP BY state`,
  );
  const out: Record<string, number> = { pending: 0, running: 0, succeeded: 0, failed: 0, dead: 0 };
  for (const row of rows) out[row.state] = row.count;
  const overdue = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM jobs
      WHERE state = 'pending' AND run_after < now() - interval '5 minutes'`,
  );
  out.overdue = overdue?.count ?? 0;
  return out;
}

/** Housekeeping: succeeded jobs are not kept forever. Dead ones are. */
export async function pruneFinishedJobs(olderThanDays = 30): Promise<number> {
  const result = await query(
    `DELETE FROM jobs WHERE state = 'succeeded' AND finished_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays)],
  );
  return result.rowCount ?? 0;
}
