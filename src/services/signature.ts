/**
 * Staff email signatures: reading, saving, and keeping them current.
 *
 * The rendered HTML and text are stored, and rebuilt whenever what they are
 * built from changes — the source a person wrote, or their profile (a new
 * mobile number has to reach the signature without anybody re-saving it).
 * Sending reads the stored copy, so a send never depends on rendering.
 */
import type pg from 'pg';
import { z } from 'zod';
import { pool, queryOne, withTransaction } from '../db/pool.ts';
import {
  renderSignature, SIGNATURE_FIELDS, SIGNATURE_LIMITS, STANDARD_SIGNATURE,
  type SignatureProfile,
} from '../domain/signature.ts';
import { fieldError, notFound } from '../http/middleware/errors.ts';
import { recordAudit } from './audit.ts';
import type { Actor } from './staff.ts';

type Db = pg.Pool | pg.PoolClient;

type Row = SignatureProfile & {
  user_id: string; organization_id: string;
  signature_mode: 'standard' | 'custom' | null; signature_source: string | null;
  signature_html: string | null; signature_text: string | null;
  signature_updated_at: Date | null;
};

async function load(db: Db, userId: string): Promise<Row | null> {
  if (!z.string().uuid().safeParse(userId).success) return null;
  const { rows } = await db.query<Row>(
    `SELECT u.id AS user_id, u.organization_id, u.name, u.email, o.name AS organization_name,
            p.title, p.licence_number, p.licence_province, p.mobile_phone, p.direct_phone,
            p.office_phone, p.booking_url, p.signature_mode, p.signature_source,
            p.signature_html, p.signature_text, p.signature_updated_at
       FROM users u
       JOIN organizations o ON o.id = u.organization_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

const sourceOf = (row: Pick<Row, 'signature_mode' | 'signature_source'>) =>
  row.signature_mode === 'custom' && row.signature_source ? row.signature_source : STANDARD_SIGNATURE;

/**
 * Re-render and store somebody's signature from what is saved now. Called
 * after anything that feeds it changes; cheap, and safe to call twice.
 */
export async function rebuildSignature(db: Db, userId: string): Promise<{ html: string; text: string }> {
  const row = await load(db, userId);
  if (!row) return { html: '', text: '' };
  const { html, text } = renderSignature(sourceOf(row), row);
  await db.query(
    `INSERT INTO user_profiles (user_id, signature_html, signature_text)
     VALUES ($1,$2,$3)
     ON CONFLICT (user_id) DO UPDATE SET signature_html = EXCLUDED.signature_html,
                                         signature_text = EXCLUDED.signature_text`,
    [userId, html, text],
  );
  return { html, text };
}

/** The signature to put on an email somebody is sending now. */
export async function signatureFor(userId: string | null | undefined): Promise<{ html: string; text: string } | null> {
  if (!userId) return null;
  const row = await load(pool, userId);
  if (!row) return null;
  // Accounts from before signatures existed have nothing stored yet.
  if (row.signature_html === null || row.signature_text === null) return rebuildSignature(pool, userId);
  return row.signature_text ? { html: row.signature_html, text: row.signature_text } : null;
}

export type SignatureState = {
  mode: 'standard' | 'custom';
  source: string;
  standard_source: string;
  html: string;
  text: string;
  updated_at: string | null;
  fields: typeof SIGNATURE_FIELDS;
  limits: typeof SIGNATURE_LIMITS;
};

export async function getSignature(organizationId: string, userId: string): Promise<SignatureState> {
  const row = await load(pool, userId);
  if (!row || row.organization_id !== organizationId) throw notFound('That staff member');
  const mode = row.signature_mode === 'custom' ? 'custom' : 'standard';
  const rendered = renderSignature(sourceOf(row), row);
  return {
    mode,
    source: sourceOf(row),
    standard_source: STANDARD_SIGNATURE,
    html: rendered.html,
    text: rendered.text,
    updated_at: row.signature_updated_at?.toISOString() ?? null,
    fields: SIGNATURE_FIELDS,
    limits: SIGNATURE_LIMITS,
  };
}

export const SignatureInput = z.object({
  mode: z.enum(['standard', 'custom'], { errorMap: () => ({ message: 'Choose standard or custom.' }) }),
  source: z.string().max(SIGNATURE_LIMITS.characters + 200).optional(),
}).strict();

/** Render without saving, for the live preview. */
export async function previewSignature(organizationId: string, userId: string, raw: unknown) {
  const input = SignatureInput.parse(raw);
  const row = await load(pool, userId);
  if (!row || row.organization_id !== organizationId) throw notFound('That staff member');
  const source = input.mode === 'custom' ? input.source ?? '' : STANDARD_SIGNATURE;
  return renderSignature(source, row);
}

/**
 * Save a signature. A person edits their own; somebody with `user.manage`
 * may set anybody's (the route decides which applies). An unusable
 * signature is refused with the reason, never saved half-right.
 */
export async function saveSignature(actor: Actor, userId: string, raw: unknown): Promise<SignatureState> {
  const input = SignatureInput.parse(raw);
  const row = await load(pool, userId);
  if (!row || row.organization_id !== actor.organizationId) throw notFound('That staff member');

  const source = input.mode === 'custom' ? (input.source ?? '').trim() : null;
  if (input.mode === 'custom') {
    if (!source) throw fieldError('source', 'Write your signature, or switch back to the standard one.');
    const { problems, text } = renderSignature(source, row);
    if (problems.length) throw fieldError('source', problems[0]!);
    if (!text.trim()) {
      throw fieldError('source', 'Every line of that needs a profile field you have not filled in, so nothing would show.');
    }
  }

  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE user_profiles SET signature_mode = $2, signature_source = $3, signature_updated_at = now()
        WHERE user_id = $1`,
      [userId, input.mode, source],
    );
    if (!rowCount) {
      await client.query(
        `INSERT INTO user_profiles (user_id, signature_mode, signature_source, signature_updated_at)
         VALUES ($1,$2,$3,now())`,
        [userId, input.mode, source],
      );
    }
    await rebuildSignature(client, userId);
    await recordAudit({
      organizationId: actor.organizationId,
      actor: { userId: actor.userId, name: actor.name, role: actor.role ?? null, kind: actor.kind,
               ip: actor.ip ?? null },
      action: 'user.signature_updated',
      entityType: 'user',
      entityId: userId,
      summary: actor.userId === userId
        ? `${row.name} changed their email signature (${input.mode})`
        : `${actor.name} changed ${row.name}'s email signature (${input.mode})`,
      before: { mode: row.signature_mode, source: row.signature_source },
      after: { mode: input.mode, source },
    }, client);
  });

  return getSignature(actor.organizationId, userId);
}
