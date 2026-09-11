/**
 * The audit log, and the chain that makes it hard to quietly rewrite.
 *
 * Each row carries the SHA-256 of its own content plus the hash of the row
 * before it. Deleting or editing a row breaks every hash after it, and
 * `verifyChain` says exactly where. The database refuses UPDATE and DELETE on
 * the table outright (see migration 0001); the chain is what catches somebody
 * who has gone around the database.
 *
 * This is not a claim that the log is cryptographically un-forgeable by
 * somebody with full database access — it is not, and pretending otherwise
 * would be worse than useless. It is a claim that tampering cannot be silent,
 * which is the property a compliance review actually needs.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { pool, query } from '../db/pool.ts';
import { log } from '../lib/logger.ts';
import { canonicalJson } from '../lib/canonical-json.ts';

export type AuditActor = {
  userId?: string | null;
  name?: string | null;
  role?: string | null;
  kind?: 'user' | 'system' | 'client' | 'integration';
  ip?: string | null;
  sessionId?: string | null;
};

export type AuditEntry = {
  organizationId: string;
  actor: AuditActor;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
};

/**
 * Fields are joined with a separator that cannot occur in any of the values,
 * so that text moved across a field boundary cannot produce the same digest.
 */
const SEPARATOR = String.fromCharCode(0);

function hashRow(input: {
  prevHash: string | null;
  at: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorUserId: string | null;
  summary: string;
  before: string | null;
  after: string | null;
}): string {
  return createHash('sha256')
    .update(
      [
        input.prevHash ?? '',
        input.at,
        input.action,
        input.entityType ?? '',
        input.entityId ?? '',
        input.actorUserId ?? '',
        input.summary,
        input.before ?? '',
        input.after ?? '',
      ].join(SEPARATOR),
    )
    .digest('hex');
}

/**
 * Append one entry.
 *
 * Takes an optional client so the audit row lands in the SAME transaction as
 * the change it describes. A log of things that may not have happened is worse
 * than no log, and that is exactly what a separate connection produces when the
 * outer transaction rolls back.
 */
export async function recordAudit(
  entry: AuditEntry,
  client?: pg.PoolClient,
): Promise<{ id: string; rowHash: string }> {
  const run = client ?? pool;

  // Serialised against concurrent appends: two writers reading the same
  // previous hash would fork the chain, and both forks look valid in isolation.
  if (client) await client.query('LOCK TABLE audit_log IN EXCLUSIVE MODE');

  const { rows: prevRows } = await run.query<{ row_hash: string }>(
    'SELECT row_hash FROM audit_log WHERE organization_id = $1 ORDER BY id DESC LIMIT 1',
    [entry.organizationId],
  );
  const prevHash = prevRows[0]?.row_hash ?? null;

  const at = new Date().toISOString();
  // Canonical for the hash; the same string is what gets stored, so the value
  // in the column and the value that was hashed are the same document.
  const before = entry.before === undefined ? null : canonicalJson(entry.before);
  const after = entry.after === undefined ? null : canonicalJson(entry.after);
  const rowHash = hashRow({
    prevHash,
    at,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    actorUserId: entry.actor.userId ?? null,
    summary: entry.summary,
    before,
    after,
  });

  const { rows } = await run.query<{ id: string }>(
    `INSERT INTO audit_log (organization_id, at, actor_user_id, actor_name, actor_role,
                            actor_kind, action, entity_type, entity_id, summary,
                            before_json, after_json, ip, session_id, prev_hash, row_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      entry.organizationId, at, entry.actor.userId ?? null, entry.actor.name ?? null,
      entry.actor.role ?? null, entry.actor.kind ?? 'user', entry.action,
      entry.entityType ?? null, entry.entityId ?? null, entry.summary,
      before, after, entry.actor.ip ?? null, entry.actor.sessionId ?? null,
      prevHash, rowHash,
    ],
  );
  return { id: String(rows[0]!.id), rowHash };
}

export type ChainVerification = {
  ok: boolean;
  checked: number;
  /** The first row whose hash does not follow from its predecessor. */
  brokenAt?: { id: string; at: string; action: string; expected: string; found: string };
};

export async function verifyChain(
  organizationId: string,
  options: { limit?: number } = {},
): Promise<ChainVerification> {
  const { rows } = await query<{
    id: string; at: Date; action: string; entity_type: string | null;
    entity_id: string | null; actor_user_id: string | null; summary: string;
    before_json: unknown; after_json: unknown; prev_hash: string | null; row_hash: string;
  }>(
    `SELECT id, at, action, entity_type, entity_id, actor_user_id, summary,
            before_json, after_json, prev_hash, row_hash
       FROM audit_log WHERE organization_id = $1 ORDER BY id ASC
       ${options.limit ? 'LIMIT ' + Number(options.limit) : ''}`,
    [organizationId],
  );

  let previous: string | null = null;
  let checked = 0;
  for (const row of rows) {
    const expected = hashRow({
      prevHash: previous,
      at: new Date(row.at).toISOString(),
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      actorUserId: row.actor_user_id,
      summary: row.summary,
      before: row.before_json === null ? null : canonicalJson(row.before_json),
      after: row.after_json === null ? null : canonicalJson(row.after_json),
    });
    checked++;
    if (expected !== row.row_hash) {
      return {
        ok: false,
        checked,
        brokenAt: {
          id: String(row.id),
          at: new Date(row.at).toISOString(),
          action: row.action,
          expected,
          found: row.row_hash,
        },
      };
    }
    previous = row.row_hash;
  }
  return { ok: true, checked };
}

/**
 * Fire-and-forget audit, for paths where a logging failure must not fail the
 * user's action. Used sparingly — anything with a compliance dimension takes
 * the transactional form above instead.
 */
export function recordAuditSafely(entry: AuditEntry): void {
  recordAudit(entry).catch((err) => {
    log.error('audit write failed', { action: entry.action, error: err });
  });
}

/** Exported for tests, so the chain maths can be checked without a database. */
export const __testing = { hashRow, SEPARATOR };
