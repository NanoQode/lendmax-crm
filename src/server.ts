/**
 * Process entry point.
 *
 * Boots in an order that fails early and loudly: environment, then database
 * reachability, then migrations are checked (not run — running them implicitly
 * on boot means a bad migration takes the service down at the worst moment),
 * then the HTTP listener.
 *
 * Shutdown drains: stop accepting connections, let in-flight requests finish,
 * close the pool. A hard exit mid-request leaves a half-written stage change.
 */
import { createApp } from './http/app.ts';
import { env } from './config/env.ts';
import { log } from './lib/logger.ts';
import { closePool, healthcheck, query } from './db/pool.ts';
import { loadMigrations } from './db/migrate.ts';
import { registerHandlers } from './jobs/handlers/index.ts';
import { startWorker, stopWorker } from './jobs/worker.ts';

async function assertSchemaIsCurrent(): Promise<void> {
  const files = await loadMigrations();
  const { rows } = await query<{ id: string }>('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));
  const pending = files.filter((f) => !applied.has(f.id));
  if (pending.length) {
    throw new Error(
      `${pending.length} migration(s) have not been applied:\n` +
        pending.map((p) => `  ${p.file}`).join('\n') +
        '\n\nRun: npm run migrate',
    );
  }
}

async function main(): Promise<void> {
  const db = await healthcheck();
  if (!db.ok) {
    throw new Error(`Database is not reachable: ${db.error ?? 'unknown error'}`);
  }

  try {
    await assertSchemaIsCurrent();
  } catch (err) {
    // A missing schema_migrations table means the database has never been set
    // up, which deserves an instruction rather than a stack trace.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('schema_migrations')) {
      throw new Error('The database has no schema yet. Run: npm run migrate');
    }
    throw err;
  }

  // The worker runs in this process by default. For a brokerage's volume that
  // is the right trade — one thing to deploy, one thing to watch — and
  // WORKER_ENABLED=0 moves it to its own process without touching anything
  // else.
  const workerEnabled = process.env.WORKER_ENABLED !== '0';
  if (workerEnabled) {
    registerHandlers();
    startWorker();
  } else {
    log.warn('the background worker is disabled; scheduled messages will not go out');
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    log.info('lendmax-crm listening', {
      port: env.PORT,
      basePath: env.BASE_PATH,
      env: env.NODE_ENV,
      timezone: env.BROKERAGE_TIMEZONE,
    });
  });

  // Slightly longer than a typical upstream proxy's, so the proxy times out
  // first and the connection is not cut from under a response mid-write.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });

    const forced = setTimeout(() => {
      log.error('shutdown timed out; exiting anyway');
      process.exit(1);
    }, 20_000);
    forced.unref();

    server.close(async () => {
      try {
        // The worker drains before the pool closes, or a job dies mid-write.
        await stopWorker();
        await closePool();
      } catch (err) {
        log.error('failed to close the database pool', { error: err });
      }
      log.info('shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    // Logged, not fatal. A rejected promise in one request must not take the
    // whole brokerage's CRM down with it.
    log.error('unhandled promise rejection', { error: reason });
  });
  process.on('uncaughtException', (err) => {
    // Fatal, because the process state is now unknown. systemd restarts it.
    log.error('uncaught exception; exiting', { error: err });
    shutdown('uncaughtException');
  });
}

main().catch(async (err) => {
  log.error('failed to start', { error: err });
  console.error(`\n${err instanceof Error ? err.message : err}\n`);
  await closePool().catch(() => {});
  process.exit(1);
});
