/**
 * Migration runner.
 *
 * Numbered .sql files, applied in order, each in its own transaction, each
 * recorded with the SHA-256 of the text that was applied.
 *
 * The checksum is the point. A migration that has already run and whose file
 * has since been edited is a database that does not match the repository, and
 * every later assumption about the schema is then a guess. That is a hard stop,
 * not a warning — with one deliberate escape hatch (`--accept-drift`) for the
 * case where a file was reformatted and a human has checked it.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, withTransaction } from './pool.ts';
import { log } from '../lib/logger.ts';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL
    )
  `);
}

export type MigrationFile = { id: string; file: string; sql: string; checksum: string };

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const file of names) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    out.push({ id: file.replace(/\.sql$/, ''), file, sql, checksum: sha256(sql) });
  }
  return out;
}

export async function migrate(options: { acceptDrift?: boolean } = {}): Promise<string[]> {
  await ensureTable();
  const files = await loadMigrations();
  const { rows: applied } = await pool.query<{ id: string; checksum: string }>(
    'SELECT id, checksum FROM schema_migrations',
  );
  const seen = new Map(applied.map((r) => [r.id, r.checksum]));

  const drifted = files.filter((f) => seen.has(f.id) && seen.get(f.id) !== f.checksum);
  if (drifted.length && !options.acceptDrift) {
    throw new Error(
      `These migrations have changed since they were applied:\n` +
        drifted.map((d) => `  ${d.file}`).join('\n') +
        `\n\nAn applied migration is history and editing it makes the database and the ` +
        `repository disagree. Write a new migration instead. If the change was only ` +
        `formatting and you have checked it, re-run with --accept-drift.`,
    );
  }
  if (drifted.length && options.acceptDrift) {
    for (const d of drifted) {
      await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE id = $2', [d.checksum, d.id]);
      log.warn('migration checksum accepted', { id: d.id });
    }
  }

  const pending = files.filter((f) => !seen.has(f.id));
  if (!pending.length) {
    log.info('database is up to date', { applied: files.length });
    return [];
  }

  const ran: string[] = [];
  for (const m of pending) {
    const started = performance.now();
    await withTransaction(async (client) => {
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations (id, checksum, duration_ms) VALUES ($1, $2, $3)',
        [m.id, m.checksum, Math.round(performance.now() - started)],
      );
    });
    ran.push(m.id);
    log.info('migration applied', { id: m.id, ms: Math.round(performance.now() - started) });
  }
  return ran;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  migrate({ acceptDrift: process.argv.includes('--accept-drift') })
    .then(async (ran) => {
      console.log(ran.length ? `Applied ${ran.length} migration(s).` : 'Nothing to apply.');
      await pool.end();
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
