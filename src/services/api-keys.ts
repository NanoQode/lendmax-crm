/**
 * API keys for connected websites.
 *
 * One key per website or service, so one can be revoked without breaking the
 * others, and so the audit log says which site did what. Each key holds only
 * the permissions it was given, drawn from API_PERMISSIONS — the ones with an
 * endpoint behind them.
 *
 * The key is shown once, when it is made. The database keeps its SHA-256 and
 * its first few characters; a copy of the database is not a set of keys.
 *
 * Keys are for server-to-server calls. A key placed in a web page's
 * JavaScript is a key published to everybody who opens the page, which is why
 * the v1 API sends no CORS headers: a browser will refuse to use it from
 * another origin, and that refusal is the point.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import { API_PERMISSIONS, PERMISSIONS, type Permission } from '../domain/permissions.ts';
import { AppError, notFound } from '../http/middleware/errors.ts';
import { recordAudit } from './audit.ts';
import { hashToken } from './auth.ts';
import type { Actor } from './staff.ts';

export const KEY_PREFIX = 'lmx_';

export type ApiKeyRecord = {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  permissions: string[];
  created_at: string;
  created_by_name: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  status: 'active' | 'revoked';
};

export const CreateApiKeyInput = z.object({
  name: z.string().trim().min(2, 'Name the website or service this key is for.')
    .max(80, 'At most 80 characters.'),
  description: z.string().trim().max(300, 'At most 300 characters.').optional()
    .transform((v) => v || null),
  permissions: z.array(z.string()).min(1, 'Give the key at least one permission.')
    .refine((list) => list.every((p) => API_PERMISSIONS.includes(p as Permission)),
            'One of those permissions cannot be given to an API key.'),
}).strict();

export async function listApiKeys(organizationId: string): Promise<ApiKeyRecord[]> {
  const { rows } = await query<ApiKeyRecord>(
    `SELECT k.id, k.name, k.description, k.key_prefix, k.permissions, k.created_at,
            u.name AS created_by_name, k.last_used_at, k.last_used_ip, k.revoked_at,
            CASE WHEN k.revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status
       FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
      WHERE k.organization_id = $1
      ORDER BY (k.revoked_at IS NULL) DESC, k.created_at DESC`,
    [organizationId],
  );
  return rows;
}

export async function createApiKey(
  actor: Actor, raw: unknown,
): Promise<{ key: string; record: ApiKeyRecord }> {
  const input = CreateApiKeyInput.parse(raw);
  const key = `${KEY_PREFIX}${randomBytes(30).toString('base64url')}`;
  const prefix = key.slice(0, 12);

  const id = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO api_keys (organization_id, name, description, key_prefix, key_hash,
                             permissions, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [actor.organizationId, input.name, input.description, prefix, hashToken(key),
       [...new Set(input.permissions)].sort(), actor.userId],
    );
    await recordAudit({
      organizationId: actor.organizationId,
      actor: { userId: actor.userId, name: actor.name, role: actor.role ?? null, ip: actor.ip ?? null },
      action: 'api_key.create',
      entityType: 'api_key',
      entityId: rows[0]!.id,
      summary: `API key "${input.name}" created with ${input.permissions.length} permission(s)`,
      after: { name: input.name, permissions: input.permissions, prefix },
    }, client);
    return rows[0]!.id;
  });

  const record = (await listApiKeys(actor.organizationId)).find((k) => k.id === id)!;
  return { key, record };
}

export async function revokeApiKey(actor: Actor, id: string): Promise<void> {
  if (!z.string().uuid().safeParse(id).success) throw notFound('That API key');
  const row = await queryOne<{ name: string; revoked_at: Date | null }>(
    'SELECT name, revoked_at FROM api_keys WHERE id = $1 AND organization_id = $2',
    [id, actor.organizationId],
  );
  if (!row) throw notFound('That API key');
  if (row.revoked_at) throw new AppError('That key is already revoked.', 409, 'already_revoked');

  await withTransaction(async (client) => {
    await client.query('UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1',
                       [id, actor.userId]);
    await recordAudit({
      organizationId: actor.organizationId,
      actor: { userId: actor.userId, name: actor.name, role: actor.role ?? null, ip: actor.ip ?? null },
      action: 'api_key.revoke',
      entityType: 'api_key',
      entityId: id,
      summary: `API key "${row.name}" revoked`,
    }, client);
  });
}

export type AuthenticatedKey = {
  id: string; organizationId: string; name: string; permissions: Set<Permission>;
};

/**
 * Resolve a presented key. Looked up by its hash, so the comparison is the
 * database's unique index rather than a loop of string compares.
 */
export async function authenticateApiKey(
  presented: string | undefined, ip?: string | null,
): Promise<AuthenticatedKey | null> {
  if (!presented || !presented.startsWith(KEY_PREFIX) || presented.length > 200) return null;
  const row = await queryOne<{ id: string; organization_id: string; name: string;
                               permissions: string[]; last_used_at: Date | null }>(
    `SELECT id, organization_id, name, permissions, last_used_at
       FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashToken(presented)],
  );
  if (!row) return null;

  // Recorded at most once a minute: a busy site should not turn every request
  // into a write.
  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) {
    await query('UPDATE api_keys SET last_used_at = now(), last_used_ip = $2 WHERE id = $1',
                [row.id, ip ?? null]);
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    // Only permissions that still exist and are still API-grantable count.
    permissions: new Set(row.permissions.filter(
      (p): p is Permission => p in PERMISSIONS && API_PERMISSIONS.includes(p as Permission))),
  };
}
