/**
 * The worker loop.
 *
 * Runs in the same process as the web server by default, which for a
 * brokerage's volume is the right trade: one thing to deploy, one thing to
 * watch, no message bus to keep alive. `WORKER_ENABLED=0` turns it off so it
 * can be moved to its own process later without touching anything else.
 *
 * Shutdown is graceful — the loop stops claiming and waits for what it holds.
 * A job killed halfway is a job retried, and a job retried is a client texted
 * twice.
 */
import { randomUUID } from 'node:crypto';
import { log } from '../lib/logger.ts';
import { claim, fail, pruneFinishedJobs, reclaimStalled, succeed, type Job } from './queue.ts';

export type JobHandler = (job: Job) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(kind: string, handler: JobHandler): void {
  if (handlers.has(kind)) throw new Error(`A handler for "${kind}" is already registered.`);
  handlers.set(kind, handler);
}

export function registeredKinds(): string[] {
  return [...handlers.keys()].sort();
}

export type WorkerOptions = {
  queue?: string;
  /** How long to wait when there was nothing to do. */
  idleMs?: number;
  /** How many jobs to take at once. */
  batch?: number;
  concurrency?: number;
};

export class Worker {
  private readonly id = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly options: Required<WorkerOptions>;
  private running = false;
  private stopping = false;
  private inFlight = 0;
  private timer: NodeJS.Timeout | null = null;
  private housekeeping: NodeJS.Timeout | null = null;

  constructor(options: WorkerOptions = {}) {
    this.options = {
      queue: options.queue ?? 'default',
      idleMs: options.idleMs ?? 2000,
      batch: options.batch ?? 5,
      concurrency: options.concurrency ?? 3,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    log.info('worker started', { id: this.id, queue: this.options.queue,
                                 handlers: registeredKinds().length });
    void this.tick();

    // Reclaiming stranded work and pruning finished rows are both cheap and
    // both easy to forget. They run on a slow timer rather than as jobs, so a
    // broken queue cannot stop the thing that repairs the queue.
    this.housekeeping = setInterval(() => {
      void reclaimStalled().catch((err) => log.error('reclaim failed', { error: err }));
      void pruneFinishedJobs().catch((err) => log.error('prune failed', { error: err }));
    }, 5 * 60_000);
    this.housekeeping.unref?.();
  }

  async stop(timeoutMs = 15_000): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.housekeeping) clearInterval(this.housekeeping);

    const deadline = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.inFlight > 0) {
      // Said out loud: these will be reclaimed and run again, which for a
      // handler that sends something means it may send twice.
      log.warn('worker stopped with jobs still running', { inFlight: this.inFlight });
    }
    this.running = false;
    log.info('worker stopped', { id: this.id });
  }

  private schedule(ms: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;

    let jobs: Job[] = [];
    try {
      const capacity = Math.max(0, this.options.concurrency - this.inFlight);
      if (capacity === 0) {
        this.schedule(200);
        return;
      }
      jobs = await claim(this.id, {
        queue: this.options.queue,
        limit: Math.min(this.options.batch, capacity),
      });
    } catch (err) {
      // The database being briefly unavailable must not kill the loop.
      log.error('could not claim jobs', { error: err });
      this.schedule(Math.max(this.options.idleMs, 5000));
      return;
    }

    if (jobs.length === 0) {
      this.schedule(this.options.idleMs);
      return;
    }

    for (const job of jobs) {
      this.inFlight++;
      void this.run(job).finally(() => {
        this.inFlight--;
      });
    }

    // There was work, so look again immediately rather than sleeping.
    this.schedule(0);
  }

  private async run(job: Job): Promise<void> {
    const handler = handlers.get(job.kind);
    if (!handler) {
      // An unknown kind is a deploy problem, not a transient one. Retrying it
      // five times changes nothing; dead-lettering it puts it on the screen.
      await fail({ ...job, attempts: job.max_attempts }, `No handler registered for "${job.kind}".`);
      return;
    }

    const started = performance.now();
    try {
      await handler(job);
      await succeed(job.id);
      const ms = Math.round(performance.now() - started);
      if (ms > 5000) log.warn('slow job', { id: job.id, kind: job.kind, ms });
      else log.debug('job done', { id: job.id, kind: job.kind, ms });
    } catch (err) {
      await fail(job, err).catch((e) => log.error('could not record a job failure', { error: e }));
    }
  }
}

let worker: Worker | null = null;

export function startWorker(options?: WorkerOptions): Worker {
  if (!worker) worker = new Worker(options);
  worker.start();
  return worker;
}

export async function stopWorker(): Promise<void> {
  await worker?.stop();
  worker = null;
}
