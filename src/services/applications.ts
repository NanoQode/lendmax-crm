/**
 * The application file — reading and correcting the client's answers.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE. The client owns their answers; the
 * brokerage owns its corrections; the correction wins. `portal_data` is never
 * written here — it stays exactly as the client left it, so "what did they
 * actually say" always has an answer — and a correction is recorded against
 * the path it changed. Reading the file lays one over the other.
 *
 * That is a change from the original rule (docs/field-map.md, rule 2), and the
 * reason it changed is that a broker who fixes a transposed postal code should
 * not lose the fix to the next mirror push thirty seconds later.
 *
 * Who may correct: whoever the file is assigned to, or somebody who can see
 * every file (`customer.view_all`) and edit (`customer.edit`). Not a matter of
 * hiding the button — it is checked here.
 */
import { z } from 'zod';
import { query, queryOne, withTransaction, type Queryable } from '../db/pool.ts';
import {
  changedPaths, fieldsOf, flatRoot, isActive, mergeAnswers, readPath, repeatGroupsOf,
  SECTION_IDS, SECTIONS, sectionById, sectionPath, validateSection, VOCAB,
  type FormSection, type StaffEdit,
} from '../domain/application-form.ts';
import { columnAssignments, columnsFromAnswers } from '../domain/application-columns.ts';
import { AppError, notFound } from '../http/middleware/errors.ts';
import { log } from '../lib/logger.ts';
import { recordAudit } from './audit.ts';
import type { Actor } from './staff.ts';

export type Scope = {
  actor: Actor;
  viewAll: boolean;
  edit: boolean;
  viewFinancials: boolean;
};

const me = (scope: Scope): string => {
  if (!scope.actor.userId) throw new AppError('This needs a signed-in user.', 403, 'forbidden');
  return scope.actor.userId;
};

const auditActor = (a: Actor) => ({
  userId: a.userId, name: a.name, role: a.role ?? null, kind: a.kind, ip: a.ip ?? null,
});

/**
 * The sections holding money.
 *
 * `pii.view_financials` is a separate grant from opening a file, so these are
 * left out of the payload entirely rather than rendered empty — and the screen
 * is told why they are missing rather than showing a gap.
 */
const FINANCIAL_SECTIONS = new Set(['income', 'assets', 'liabilities']);

// ── Reading ────────────────────────────────────────────────────────────────

type FileRow = {
  id: string; customer_id: string; portal_data: Record<string, any> | null;
  portal_reference: string | null; portal_status: string | null; percent_complete: number | null;
  stage_key: string | null; archived_at: Date | null;
  staff_edited_at: Date | null; staff_edited_by_name: string | null;
  assigned: boolean;
};

async function loadFile(scope: Scope, id: string, client?: Queryable): Promise<FileRow> {
  const runner = client ?? { query };
  const { rows } = await runner.query<FileRow>(
    `SELECT app.id, app.customer_id, app.portal_data, app.portal_reference, app.portal_status,
            app.percent_complete, app.stage_key, app.archived_at,
            app.staff_edited_at, u.name AS staff_edited_by_name,
            EXISTS (SELECT 1 FROM assignments a
                     WHERE a.application_id = app.id AND a.user_id = $3
                       AND a.unassigned_at IS NULL) AS assigned
       FROM applications app
       LEFT JOIN users u ON u.id = app.staff_edited_by
      WHERE app.id = $1 AND app.organization_id = $2`,
    [id, scope.actor.organizationId, scope.actor.userId ?? null],
  );
  const row = rows[0];
  if (!row) throw notFound('That application');
  // A file somebody is not on and cannot see everything is not theirs to read.
  if (!row.assigned && !scope.viewAll) throw notFound('That application');
  return row;
}

async function editsFor(applicationId: string, client?: Queryable): Promise<Array<StaffEdit & {
  edited_by: string | null; edited_at: Date; portal_value: unknown;
}>> {
  const runner = client ?? { query };
  const { rows } = await runner.query<{
    path: string; value: unknown; portal_value: unknown; edited_by: string | null; edited_at: Date;
  }>(
    `SELECT path, value, portal_value, edited_by, edited_at
       FROM application_field_edits WHERE application_id = $1`,
    [applicationId],
  );
  return rows;
}

export type FormPayload = {
  application: {
    id: string; reference: string | null; portal_status: string | null;
    percent_complete: number | null; stage_key: string | null;
    staff_edited_at: string | null; staff_edited_by_name: string | null;
  };
  can_edit: boolean;
  edit_blocked_reason: string | null;
  /** The form definition, as the portal defines it, minus anything unreadable. */
  sections: FormSection[];
  vocab: Record<string, unknown>;
  /** The client's answers with the brokerage's corrections laid over them. */
  answers: Record<string, any>;
  /** Only the paths somebody has corrected, with who and when and what was there. */
  edits: Array<{ path: string; edited_at: string; edited_by: string | null; portal_value: unknown }>;
  hidden_sections: string[];
  hidden_reason: string | null;
};

export async function getApplicationForm(scope: Scope, id: string): Promise<FormPayload> {
  const file = await loadFile(scope, id);
  const edits = await editsFor(id);
  const answers = mergeAnswers(file.portal_data ?? {}, edits);

  const hidden = scope.viewFinancials ? [] : [...FINANCIAL_SECTIONS];
  const visible = SECTIONS.filter((s) => !hidden.includes(s.id));
  for (const section of hidden) delete answers[sectionPath(section)];

  return {
    application: {
      id: file.id,
      reference: file.portal_reference,
      portal_status: file.portal_status,
      percent_complete: file.percent_complete,
      stage_key: file.stage_key,
      staff_edited_at: file.staff_edited_at?.toISOString() ?? null,
      staff_edited_by_name: file.staff_edited_by_name,
    },
    // Editing needs the grant AND a reason to be on this file.
    can_edit: scope.edit && (file.assigned || scope.viewAll) && !file.archived_at,
    // Said on screen, so a read-only form is never a mystery.
    edit_blocked_reason: !scope.edit
      ? 'Read only: your account does not have “Edit customer and application details”. An admin can grant it under Staff.'
      : file.archived_at ? 'Read only: this file is archived.'
      : !file.assigned && !scope.viewAll ? 'Read only: this file is not assigned to you.'
      : null,
    sections: visible,
    vocab: VOCAB,
    answers,
    edits: edits.map((e) => ({
      path: e.path,
      edited_at: e.edited_at.toISOString(),
      edited_by: e.edited_by,
      portal_value: e.portal_value,
    })),
    hidden_sections: hidden,
    hidden_reason: hidden.length
      ? 'Income, assets and liabilities need the “View income, assets and liabilities” permission.'
      : null,
  };
}

// ── Correcting ─────────────────────────────────────────────────────────────

export const SaveInput = z.object({
  /** The section's whole value: an object, or a list for a repeating section. */
  value: z.union([z.record(z.unknown()), z.array(z.record(z.unknown()))]),
  /** The declaration or gate that goes with it, where the section has one. */
  meta: z.record(z.unknown()).optional(),
});

export type SaveResult = {
  changed: string[];
  form: FormPayload;
};

/**
 * A section that does not check out.
 *
 * Thrown rather than returned so that it travels the same path as every other
 * refusal in this CRM — the client's `api()` treats `ok: false` as a throw, and
 * a second success-shaped-failure convention for one form would be a trap for
 * whoever writes the next one. The field messages ride in `detail.errors`,
 * keyed the way the form addresses its inputs.
 */
export const formInvalid = (errors: Record<string, string>): AppError => {
  const count = Object.keys(errors).length;
  const first = Object.values(errors)[0] ?? 'Something needs looking at.';
  return new AppError(count === 1 ? first : `${count} answers need looking at.`,
    422, 'form_invalid', { errors });
};

/**
 * Save one section of the form.
 *
 * Validated as the portal would validate it, with one deliberate relaxation:
 * `partial`. A broker fixing one wrong postal code on a file the client left
 * half-finished must not be made to answer the other forty questions first —
 * what they type has to be *valid*, but the section does not have to be
 * *complete*. Completeness is the client's business and the portal's bar.
 */
export async function saveSection(
  scope: Scope, id: string, sectionId: string, raw: unknown,
): Promise<SaveResult> {
  if (!SECTION_IDS.includes(sectionId)) throw notFound('That section');
  const section = sectionById(sectionId)!;
  const input = SaveInput.parse(raw ?? {});
  const userId = me(scope);

  if (FINANCIAL_SECTIONS.has(sectionId) && !scope.viewFinancials) {
    throw new AppError(
      'Changing income, assets or liabilities needs the “View income, assets and liabilities” permission.',
      403, 'forbidden',
    );
  }

  const file = await loadFile(scope, id);
  if (!scope.edit || (!file.assigned && !scope.viewAll)) {
    throw new AppError('Only the staff this file is assigned to, or an admin, can change it.',
      403, 'forbidden');
  }
  if (file.archived_at) throw new AppError('That file is archived.', 409, 'archived');

  const edits = await editsFor(id);
  const before = mergeAnswers(file.portal_data ?? {}, edits);
  const value = input.value;

  // Checked against the rest of the file, because a question about a liability
  // can depend on what the whole application is for.
  const root = flatRoot(sectionId === 'purpose' || sectionId === 'property'
    ? { ...before, [sectionId]: value }
    : before);
  const meta = { ...(before.meta?.[sectionId] ?? {}), ...(input.meta ?? {}) };
  const result = validateSection(sectionId, value, root, meta, { partial: true });
  if (!result.ok) throw formInvalid(result.errors);

  const key = sectionPath(sectionId);
  const paths = changedPaths(sectionId, before[key], value);
  const metaChanged = JSON.stringify(meta) !== JSON.stringify(before.meta?.[sectionId] ?? {});
  if (!paths.length && !metaChanged) {
    return { changed: [], form: await getApplicationForm(scope, id) };
  }

  await withTransaction(async (client) => {
    for (const path of paths) {
      // What the client had said, kept beside the correction so the screen can
      // show both without going back to a push that may since be gone.
      const portalValue = readPath(file.portal_data ?? {}, path);
      const next = readPath({ ...before, [key]: value }, path);
      await client.query(
        `INSERT INTO application_field_edits
           (application_id, path, value, portal_value, edited_by, edited_at)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5, now())
         ON CONFLICT (application_id, path) DO UPDATE
           SET value = EXCLUDED.value, edited_by = EXCLUDED.edited_by, edited_at = now()`,
        [id, path, JSON.stringify(next ?? null), JSON.stringify(portalValue ?? null), userId],
      );
    }
    if (metaChanged) {
      await client.query(
        `INSERT INTO application_field_edits
           (application_id, path, value, portal_value, edited_by, edited_at)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5, now())
         ON CONFLICT (application_id, path) DO UPDATE
           SET value = EXCLUDED.value, edited_by = EXCLUDED.edited_by, edited_at = now()`,
        [id, `meta.${sectionId}`, JSON.stringify(meta),
         JSON.stringify(readPath(file.portal_data ?? {}, `meta.${sectionId}`) ?? null), userId],
      );
    }

    await client.query(
      'UPDATE applications SET staff_edited_at = now(), staff_edited_by = $2 WHERE id = $1',
      [id, userId],
    );
    await applyAnswerColumns(id, client);

    await recordAudit({
      organizationId: scope.actor.organizationId,
      actor: auditActor(scope.actor),
      action: 'application.edit',
      entityType: 'application',
      entityId: id,
      applicationId: id,
      summary: `Edited ${section.title.toLowerCase()} on ${file.portal_reference ?? 'the file'}`,
      before: Object.fromEntries(paths.map((p) => [p, readPath(before, p) ?? null])),
      after: Object.fromEntries(paths.map((p) => [p, readPath({ ...before, [key]: value }, p) ?? null])),
    }, client);
  });

  return { changed: paths, form: await getApplicationForm(scope, id) };
}

/**
 * Put a client's answer back the way they gave it.
 *
 * The correction is removed, not overwritten with the old value — so the field
 * goes back to following the portal, and a later push updates it again.
 */
export async function revertPath(scope: Scope, id: string, path: string): Promise<FormPayload> {
  const file = await loadFile(scope, id);
  if (!scope.edit || (!file.assigned && !scope.viewAll)) {
    throw new AppError('Only the staff this file is assigned to, or an admin, can change it.',
      403, 'forbidden');
  }
  const { rowCount } = await query(
    'DELETE FROM application_field_edits WHERE application_id = $1 AND path = $2', [id, path]);
  if (!rowCount) throw notFound('That correction');

  // Forced: this may have been the last correction on the file, and the column
  // would otherwise keep the value that has just been undone.
  await applyAnswerColumns(id, undefined, { force: true });
  await recordAudit({
    organizationId: scope.actor.organizationId,
    actor: auditActor(scope.actor),
    action: 'application.revert',
    entityType: 'application',
    entityId: id,
    applicationId: id,
    summary: `Reverted ${path} to what the client answered`,
  });
  return getApplicationForm(scope, id);
}

/**
 * Recompute the derived columns from whatever the answers now are.
 *
 * Called after a correction AND after a mirror push, which is what makes
 * "the correction wins" true rather than merely intended: the push replaces
 * `portal_data` and its own columns, and then this lays the corrections back
 * over the columns the answers feed.
 */
export async function applyAnswerColumns(
  applicationId: string,
  client?: Queryable,
  options: { force?: boolean } = {},
): Promise<void> {
  const runner = client ?? { query };
  const { rows } = await runner.query<{ portal_data: Record<string, any> | null }>(
    'SELECT portal_data FROM applications WHERE id = $1', [applicationId]);
  if (!rows[0]) return;
  const edits = await editsFor(applicationId, client);
  /* Nothing corrected — the importer's columns stand.
   *
   * Not merely an optimisation: the importer prefers the payload's own
   * top-level `purpose` and `property_city` over the copies inside `data`, and
   * recomputing from the data alone would quietly overrule that.
   *
   * `force` is the one case that has to recompute anyway — removing the LAST
   * correction, where doing nothing would leave the column holding the
   * correction that has just been taken away. */
  if (!edits.length && !options.force) return;

  const merged = mergeAnswers(rows[0].portal_data ?? {}, edits);
  const columns = columnsFromAnswers(merged);
  const { sql, params } = columnAssignments(columns, 2);
  await runner.query(`UPDATE applications SET ${sql} WHERE id = $1`, [applicationId, ...params]);
}

/**
 * Re-apply every file's corrections after a mirror push.
 *
 * Exported for the importer, which calls it once per imported application.
 */
export async function reapplyStaffEdits(applicationId: string): Promise<void> {
  try {
    await applyAnswerColumns(applicationId);
  } catch (err) {
    // A push that lands must not fail because a correction could not be
    // re-applied; the file is still readable and the merge still happens on
    // read. Logged so it is visible rather than silent.
    log.warn('could not re-apply staff edits after a mirror push', { applicationId, error: err });
  }
}

// ── What the screen shows beside a corrected field ─────────────────────────

/** Which of a section's questions currently apply, for the read-only summary. */
export function activeFields(sectionId: string, scope: Record<string, unknown>, root: Record<string, unknown>) {
  const section = sectionById(sectionId);
  if (!section) return [];
  return fieldsOf(section).filter((f) => isActive(f, scope, root));
}

export { repeatGroupsOf };
