/**
 * Required documents — the checklist a client is asked for, per purpose.
 *
 * Both doors call this: the admin panel and the v1 API. The application's
 * "request documents" step will call `checklistFor` to turn a purpose into
 * the list the client sees.
 *
 * Deleting archives. A document request made last month points at the entry
 * it came from, and "what were they asked for, and in whose words" has to
 * stay answerable after the list changes.
 */
import type pg from 'pg';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import {
  describeFormats, DOCUMENT_FORMATS, FORMAT_KEYS, PURPOSE_KEYS, PURPOSES, purposeKey, SUGGESTED,
  type PurposeKey,
} from '../domain/required-documents.ts';
import { AppError, fieldError, notFound } from '../http/middleware/errors.ts';
import { recordAudit } from './audit.ts';
import type { Actor } from './staff.ts';

export type RequiredDocument = {
  id: string;
  purpose: PurposeKey;
  purpose_label: string;
  name: string;
  description: string | null;
  formats: string[];
  formats_label: string;
  category_key: string | null;
  category_label: string | null;
  required: boolean;
  per_applicant: boolean;
  position: number;
  active: boolean;
  created_at: string;
  updated_at: string;
  updated_by_name: string | null;
};

const purposeLabel = (key: string) => PURPOSES.find((p) => p.key === key)?.label ?? key;

/** Formats in the one canonical order, whatever order they were ticked in. */
const canonicalFormats = (list: string[]) =>
  DOCUMENT_FORMATS.map((f) => f.key).filter((k) => list.includes(k));

const auditActor = (a: Actor) => ({
  userId: a.userId, name: a.name, role: a.role ?? null, kind: a.kind, ip: a.ip ?? null,
});

// ── Reading ────────────────────────────────────────────────────────────────

const SELECT = `
  SELECT r.id, r.purpose, r.name, r.description, r.formats, r.category_key,
         dc.label AS category_label, r.required, r.per_applicant, r.position, r.active,
         r.created_at, r.updated_at, u.name AS updated_by_name
    FROM required_documents r
    LEFT JOIN document_categories dc
           ON dc.organization_id = r.organization_id AND dc.key = r.category_key
    LEFT JOIN users u ON u.id = COALESCE(r.updated_by, r.created_by)`;

type Row = Omit<RequiredDocument, 'purpose_label' | 'formats_label'>;

const present = (r: Row): RequiredDocument => ({
  ...r,
  purpose_label: purposeLabel(r.purpose),
  formats_label: describeFormats(r.formats),
});

/** Purposes sort in the portal's order, not alphabetically. */
const PURPOSE_ORDER = `array_position(ARRAY[${PURPOSE_KEYS.map((k) => `'${k}'`).join(',')}]::text[], r.purpose)`;

/** The list's own order: purpose, then the position an admin set. */
const LIST_ORDER = [PURPOSE_ORDER, 'r.position', 'r.id'];

const SORTS: Record<string, string> = {
  position: LIST_ORDER.join(', '),
  purpose: `${PURPOSE_ORDER}`,
  name: 'lower(r.name)',
  formats: 'cardinality(r.formats)',
  category: 'lower(dc.label)',
  required: 'r.required',
  per_applicant: 'r.per_applicant',
  active: 'r.active',
  updated_at: 'r.updated_at',
};

export const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  purpose: z.enum(PURPOSE_KEYS).optional(),
  name: z.string().trim().max(100).optional(),
  format: z.enum(FORMAT_KEYS).optional(),
  category: z.string().trim().max(60).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  required: z.enum(['yes', 'no']).optional(),
  per_applicant: z.enum(['yes', 'no']).optional(),
  sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).default('position'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

export async function listRequiredDocuments(organizationId: string, raw: unknown) {
  const q = ListQuery.parse(raw ?? {});
  const params: unknown[] = [organizationId];
  const where = ['r.organization_id = $1', 'r.archived_at IS NULL'];
  const add = (sql: (p: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };

  if (q.q) {
    add((p) => `(lower(r.name) LIKE ${p} OR lower(coalesce(r.description,'')) LIKE ${p})`,
        `%${q.q.toLowerCase()}%`);
  }
  if (q.name) add((p) => `lower(r.name) LIKE ${p}`, `%${q.name.toLowerCase()}%`);
  if (q.purpose) add((p) => `r.purpose = ${p}`, q.purpose);
  if (q.format) add((p) => `${p} = ANY(r.formats)`, q.format);
  if (q.category) {
    if (q.category === '__none') where.push('r.category_key IS NULL');
    else add((p) => `r.category_key = ${p}`, q.category);
  }
  if (q.status !== 'all') where.push(q.status === 'active' ? 'r.active' : 'NOT r.active');
  if (q.required) where.push(q.required === 'yes' ? 'r.required' : 'NOT r.required');
  if (q.per_applicant) where.push(q.per_applicant === 'yes' ? 'r.per_applicant' : 'NOT r.per_applicant');

  const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  // Every sort ends on the list order, so equal rows keep a stable order
  // between pages rather than shuffling.
  const order = q.sort === 'position'
    ? LIST_ORDER.map((c) => `${c} ${dir}`).join(', ')
    : `${SORTS[q.sort]} ${dir} NULLS LAST, ${LIST_ORDER.join(', ')}`;
  params.push(q.page_size, (q.page - 1) * q.page_size);

  const { rows } = await query<Row & { total: number }>(
    `${SELECT.replace('SELECT r.id', 'SELECT COUNT(*) OVER ()::int AS total, r.id')}
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  // How many each purpose has, for the tabs — unaffected by the filters, so
  // the numbers mean the same thing whatever else is selected.
  const { rows: counts } = await query<{ purpose: string; total: number; active: number }>(
    `SELECT purpose, count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active
       FROM required_documents WHERE organization_id = $1 AND archived_at IS NULL GROUP BY purpose`,
    [organizationId],
  );

  return {
    rows: rows.map(({ total: _t, ...r }) => present(r)),
    total: rows[0]?.total ?? 0,
    page: q.page,
    page_size: q.page_size,
    purposes: PURPOSES.map((p) => {
      const c = counts.find((x) => x.purpose === p.key);
      return { key: p.key, label: p.label, total: c?.total ?? 0, active: c?.active ?? 0 };
    }),
  };
}

export async function getRequiredDocument(organizationId: string, id: string): Promise<RequiredDocument> {
  if (!z.string().uuid().safeParse(id).success) throw notFound('That document');
  const row = await queryOne<Row>(
    `${SELECT} WHERE r.id = $1 AND r.organization_id = $2 AND r.archived_at IS NULL`, [id, organizationId]);
  if (!row) throw notFound('That document');
  return present(row);
}

/**
 * What a client with this purpose is asked for: active entries, in order.
 * Accepts the portal's wording ("Home Equity Line") or a key. An application
 * with no recognised purpose gets an empty list, not a guess.
 */
export async function checklistFor(organizationId: string, purpose: string | null | undefined) {
  const key = purposeKey(purpose);
  if (!key) return { purpose: null, documents: [] as RequiredDocument[] };
  const { rows } = await query<Row>(
    `${SELECT} WHERE r.organization_id = $1 AND r.purpose = $2 AND r.active AND r.archived_at IS NULL
      ORDER BY r.position, r.id`,
    [organizationId, key],
  );
  return { purpose: { key, label: purposeLabel(key) }, documents: rows.map(present) };
}

export async function requiredDocumentsMeta(organizationId: string) {
  const { rows: categories } = await query<{ key: string; label: string; group_key: string | null }>(
    `SELECT key, label, group_key FROM document_categories
      WHERE organization_id = $1 AND active ORDER BY position, label`,
    [organizationId],
  );
  return {
    purposes: PURPOSES,
    formats: DOCUMENT_FORMATS.map(({ key, label, extensions }) => ({ key, label, extensions })),
    categories,
    suggested: Object.fromEntries(Object.entries(SUGGESTED).map(([k, v]) => [k, v.length])),
  };
}

// ── Writing ────────────────────────────────────────────────────────────────

const blankToNull = (v: string | undefined) => (v === undefined ? undefined : v === '' ? null : v);

const Fields = {
  purpose: z.enum(PURPOSE_KEYS, { errorMap: () => ({ message: 'Choose the purpose this document is for.' }) }),
  name: z.string({ required_error: 'Name the document.' }).trim()
    .min(2, 'Name the document — at least 2 characters.')
    .max(120, 'Keep the name under 120 characters; put the detail in the description.'),
  description: z.string().trim().max(1000, 'The description can be at most 1,000 characters.')
    .optional().transform(blankToNull),
  formats: z.array(z.enum(FORMAT_KEYS, { errorMap: () => ({ message: 'That is not a format the CRM accepts.' }) }))
    .min(1, 'Tick at least one format — a document that accepts none cannot be sent.')
    .transform(canonicalFormats),
  category_key: z.string().trim().max(60).nullable().optional().transform((v) => (v ? v : v === undefined ? undefined : null)),
  required: z.boolean(),
  per_applicant: z.boolean(),
  active: z.boolean(),
};

export const CreateInput = z.object({
  ...Fields,
  required: Fields.required.default(true),
  per_applicant: Fields.per_applicant.default(false),
  active: Fields.active.default(true),
}).strict();

export const UpdateInput = z.object({
  purpose: Fields.purpose.optional(),
  name: Fields.name.optional(),
  description: Fields.description,
  formats: Fields.formats.optional(),
  category_key: Fields.category_key,
  required: Fields.required.optional(),
  per_applicant: Fields.per_applicant.optional(),
  active: Fields.active.optional(),
}).strict();

async function assertCategory(client: pg.PoolClient, organizationId: string, key: string | null | undefined) {
  if (!key) return;
  const { rows } = await client.query(
    'SELECT 1 FROM document_categories WHERE organization_id = $1 AND key = $2', [organizationId, key]);
  if (!rows.length) throw fieldError('category_key', 'That is not one of the brokerage’s document categories.');
}

async function assertNameFree(
  client: pg.PoolClient, organizationId: string, purpose: string, name: string, exceptId?: string,
) {
  const { rows } = await client.query(
    `SELECT 1 FROM required_documents
      WHERE organization_id = $1 AND purpose = $2 AND lower(btrim(name)) = lower(btrim($3))
        AND archived_at IS NULL AND ($4::uuid IS NULL OR id <> $4)`,
    [organizationId, purpose, name, exceptId ?? null],
  );
  if (rows.length) {
    throw fieldError('name', `${purposeLabel(purpose)} already has a document called “${name}”.`);
  }
}

const nextPosition = async (client: pg.PoolClient, organizationId: string, purpose: string) =>
  (await client.query<{ next: number }>(
    `SELECT COALESCE(max(position), 0) + 1 AS next FROM required_documents
      WHERE organization_id = $1 AND purpose = $2 AND archived_at IS NULL`,
    [organizationId, purpose])).rows[0]!.next;

export async function createRequiredDocument(actor: Actor, raw: unknown): Promise<RequiredDocument> {
  const input = CreateInput.parse(raw);
  const id = await withTransaction(async (client) => {
    await assertNameFree(client, actor.organizationId, input.purpose, input.name);
    await assertCategory(client, actor.organizationId, input.category_key);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO required_documents (organization_id, purpose, name, description, formats, category_key,
                                       required, per_applicant, active, position, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
      [actor.organizationId, input.purpose, input.name, input.description ?? null, input.formats,
       input.category_key ?? null, input.required, input.per_applicant, input.active,
       await nextPosition(client, actor.organizationId, input.purpose), actor.userId],
    );
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'required_document.create',
      entityType: 'required_document',
      entityId: rows[0]!.id,
      summary: `“${input.name}” added to the ${purposeLabel(input.purpose)} checklist`,
      after: input,
    }, client);
    return rows[0]!.id;
  });
  return getRequiredDocument(actor.organizationId, id);
}

async function lock(client: pg.PoolClient, organizationId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound('That document');
  const { rows } = await client.query<Row>(
    `SELECT id, purpose, name, description, formats, category_key, required, per_applicant, position, active
       FROM required_documents WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL FOR UPDATE`,
    [id, organizationId]);
  if (!rows[0]) throw notFound('That document');
  return rows[0];
}

export async function updateRequiredDocument(actor: Actor, id: string, raw: unknown): Promise<RequiredDocument> {
  const input = UpdateInput.parse(raw);
  await withTransaction(async (client) => {
    const before = await lock(client, actor.organizationId, id);
    const purpose = input.purpose ?? before.purpose;
    const name = input.name ?? before.name;
    if (input.name !== undefined || input.purpose !== undefined) {
      await assertNameFree(client, actor.organizationId, purpose, name, id);
    }
    if (input.category_key !== undefined) await assertCategory(client, actor.organizationId, input.category_key);

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    for (const column of ['purpose', 'name', 'description', 'formats', 'category_key', 'required',
                          'per_applicant', 'active'] as const) {
      if (input[column] !== undefined) set(column, input[column]);
    }
    // Moved to another purpose: it joins the end of that list.
    if (input.purpose && input.purpose !== before.purpose) {
      set('position', await nextPosition(client, actor.organizationId, input.purpose));
    }
    set('updated_by', actor.userId);
    await client.query(`UPDATE required_documents SET ${sets.join(', ')} WHERE id = $1`, params);

    const changed = Object.keys(input).filter(
      (k) => JSON.stringify(input[k as keyof typeof input]) !== JSON.stringify(before[k as keyof Row]));
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'required_document.update',
      entityType: 'required_document',
      entityId: id,
      summary: `“${name}” (${purposeLabel(purpose)}) updated${changed.length ? ` — ${changed.join(', ')}` : ''}`,
      before,
      after: input,
    }, client);
  });
  return getRequiredDocument(actor.organizationId, id);
}

export async function deleteRequiredDocument(actor: Actor, id: string): Promise<void> {
  await withTransaction(async (client) => {
    const before = await lock(client, actor.organizationId, id);
    await client.query(
      `UPDATE required_documents SET archived_at = now(), archived_by = $2, active = false WHERE id = $1`,
      [id, actor.userId]);
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'required_document.delete',
      entityType: 'required_document',
      entityId: id,
      summary: `“${before.name}” removed from the ${purposeLabel(before.purpose)} checklist`,
      before,
    }, client);
  });
}

/**
 * Move one entry up or down its purpose's list. The list is renumbered 1..n
 * first, so gaps left by deletions never make a move look like it did nothing.
 */
export async function moveRequiredDocument(actor: Actor, id: string, raw: unknown): Promise<void> {
  const { direction } = z.object({ direction: z.enum(['up', 'down']) }).strict().parse(raw);
  await withTransaction(async (client) => {
    const target = await lock(client, actor.organizationId, id);
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM required_documents
        WHERE organization_id = $1 AND purpose = $2 AND archived_at IS NULL
        ORDER BY position, id FOR UPDATE`,
      [actor.organizationId, target.purpose]);
    const ids = rows.map((r) => r.id);
    const at = ids.indexOf(id);
    const swap = direction === 'up' ? at - 1 : at + 1;
    if (swap < 0 || swap >= ids.length) {
      throw new AppError(`It is already ${direction === 'up' ? 'first' : 'last'} in the list.`, 409, 'cannot_move');
    }
    [ids[at], ids[swap]] = [ids[swap]!, ids[at]!];
    await client.query(
      `UPDATE required_documents r SET position = o.n
         FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, n) WHERE r.id = o.id`,
      [ids]);
    await recordAudit({
      organizationId: actor.organizationId,
      actor: auditActor(actor),
      action: 'required_document.reorder',
      entityType: 'required_document',
      entityId: id,
      summary: `“${target.name}” moved ${direction} in the ${purposeLabel(target.purpose)} checklist`,
    }, client);
  });
}

/**
 * Add the suggested starting list for a purpose. Only what is not already
 * there by name is added, so pressing it twice does nothing the second time.
 * A suggested category that this brokerage does not have is left off rather
 * than refused.
 */
export async function addSuggested(actor: Actor, raw: unknown): Promise<{ added: number }> {
  const { purpose } = z.object({ purpose: z.enum(PURPOSE_KEYS) }).strict().parse(raw);
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query<{ name: string }>(
      `SELECT lower(btrim(name)) AS name FROM required_documents
        WHERE organization_id = $1 AND purpose = $2 AND archived_at IS NULL`,
      [actor.organizationId, purpose]);
    const have = new Set(existing.map((r) => r.name));
    const { rows: cats } = await client.query<{ key: string }>(
      'SELECT key FROM document_categories WHERE organization_id = $1', [actor.organizationId]);
    const categories = new Set(cats.map((c) => c.key));

    let position = await nextPosition(client, actor.organizationId, purpose);
    let added = 0;
    for (const s of SUGGESTED[purpose]) {
      if (have.has(s.name.toLowerCase())) continue;
      await client.query(
        `INSERT INTO required_documents (organization_id, purpose, name, description, formats, category_key,
                                         required, per_applicant, position, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [actor.organizationId, purpose, s.name, s.description, s.formats,
         s.category_key && categories.has(s.category_key) ? s.category_key : null,
         s.required, s.per_applicant, position++, actor.userId]);
      added++;
    }
    if (added) {
      await recordAudit({
        organizationId: actor.organizationId,
        actor: auditActor(actor),
        action: 'required_document.suggested',
        entityType: 'required_document',
        summary: `${added} suggested document(s) added to the ${purposeLabel(purpose)} checklist`,
      }, client);
    }
    return { added };
  });
}
