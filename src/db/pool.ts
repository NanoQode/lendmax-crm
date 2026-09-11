/**
 * The connection pool, and the two ways to talk to it.
 *
 *   query(...)        one statement, a connection borrowed and returned
 *   withTransaction() a callback that gets a client; commits, or rolls back
 *
 * Everything that writes more than one row goes through `withTransaction`. The
 * reason is the audit log: an audit row and the change it describes must land
 * together or not at all, otherwise the log is a record of things that may not
 * have happened.
 */
import pg from 'pg';
import { env } from '../config/env.ts';
import { log } from '../lib/logger.ts';

// Money must never arrive as a float. node-postgres parses NUMERIC to string by
// default, which is what we want — the parsers below only make that explicit so
// nobody "helpfully" turns it on later. int8 counts are safe to make numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'lendmax-crm',
});

pool.on('error', (err) => {
  // An idle client erroring is not fatal — the pool discards it — but it is a
  // symptom (the database restarted, a firewall dropped the connection) and
  // silence here has cost people hours.
  log.error('idle database client error', { error: err });
});

export type Queryable = Pick<pg.PoolClient, 'query'>;

const SLOW_MS = 300;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const started = performance.now();
  try {
    return await pool.query<T>(text, params as unknown[]);
  } finally {
    const ms = performance.now() - started;
    if (ms > SLOW_MS) {
      log.warn('slow query', { ms: Math.round(ms), sql: text.replace(/\s+/g, ' ').slice(0, 200) });
    }
  }
}

/** One row or null. Throws if the statement returns more than one. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const res = await query<T>(text, params);
  if (res.rows.length > 1) {
    throw new Error(`Expected at most one row, got ${res.rows.length}`);
  }
  return res.rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      log.error('rollback failed', { error: rollbackErr });
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function healthcheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = performance.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
