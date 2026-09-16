/**
 * The application form — the rules, without a database.
 *
 * The questions themselves are not defined here. They come from
 * `integrations/portal-schema.ts`, which is generated from the portal's own
 * `lib/schema.js`: the file its browser renders from and its server validates
 * against. A broker correcting a client's answer has to be looking at the same
 * form the client filled in, and the only way to guarantee that is to have one
 * definition rather than two.
 *
 * What IS here:
 *
 *   · WHEN A QUESTION APPLIES (`isActive`) and WHAT IT ACCEPTS
 *     (`validateSection`) — ported from the portal's `lib/validate.js` so a
 *     value the portal would refuse is refused here too, with the same words.
 *
 *   · WHOSE ANSWER WINS (`mergeAnswers`). The portal owns what the client
 *     said; the brokerage owns what it has since corrected. A correction is
 *     recorded against the path it changed, and a later push from the portal
 *     fills in around it rather than over it. The client's original answer is
 *     never destroyed — it stays in `portal_data` and the screen can show it.
 */
import { PORTAL_SCHEMA } from '../integrations/portal-schema.ts';

// ── The shape of the schema ────────────────────────────────────────────────

export type Condition = {
  field?: string;
  in?: Array<string | null>;
  not?: string[];
  lt?: number;
  gt?: number;
  any?: Condition[];
};

export type FormField = {
  n: string;
  l: string;
  t: string;
  req?: boolean;
  o?: Array<string | { v: string; l: string }>;
  when?: Condition;
  groupWhen?: Condition | null;
  group?: string;
  hint?: string;
  ph?: string;
  full?: boolean;
  min?: number;
  max?: number;
  step?: number;
  d?: string;
  dynamic?: string;
};

export type FormGroup = {
  id: string;
  title?: string;
  fields: FormField[];
  when?: Condition;
  repeat?: { key: string; min?: number; max: number; label: string; addLabel?: string };
};

export type FormSection = {
  id: string;
  title: string;
  menu?: string;
  blurb?: string;
  tip?: string;
  groups: FormGroup[];
  optional?: boolean;
  after_submit?: boolean;
  repeat?: { key: string; min?: number; max: number; label: string; addLabel?: string };
  declare?: { n: string; l: string };
  gate?: { n: string; l: string; yes?: string; no?: string };
  upload?: unknown;
};

/** The schema, typed. The generated module is `as const`, which is unusable as data. */
export const SECTIONS = PORTAL_SCHEMA.sections as unknown as FormSection[];
export const VOCAB = PORTAL_SCHEMA.vocab as unknown as Record<string, unknown>;
export const SECTION_IDS = SECTIONS.map((s) => s.id);
export const sectionById = (id: string): FormSection | null =>
  SECTIONS.find((s) => s.id === id) ?? null;

/**
 * The fields of a section, flattened out of its groups.
 *
 * A group with its own `repeat` is a list nested inside the entry — an
 * applicant's other jobs, the charges on a property. Its fields belong to each
 * row of that list rather than to the entry, so they come back from
 * `repeatGroupsOf` instead; left in here they would be demanded once, at the
 * wrong level.
 */
export function fieldsOf(section: FormSection): FormField[] {
  return (section.groups ?? [])
    .filter((g) => !g.repeat)
    .flatMap((g) => (g.fields ?? []).map((f) => ({
      ...f,
      group: g.id,
      // A field's own condition wins; the group's applies when it has none.
      when: f.when ?? g.when,
      groupWhen: g.when ?? null,
    })));
}

export const repeatGroupsOf = (section: FormSection): FormGroup[] =>
  (section.groups ?? []).filter((g) => !!g.repeat);

// ── When a question applies ────────────────────────────────────────────────

/**
 * Ported from the portal, condition for condition.
 *
 * `scope` is the entry being looked at (one borrower, one liability) and
 * `root` is the flattened purpose-and-property view, because a question about
 * a liability can depend on what the whole application is for.
 */
export function isActive(
  field: { when?: Condition; groupWhen?: Condition | null },
  scope: Record<string, unknown> = {},
  root: Record<string, unknown> = {},
): boolean {
  // A field inside a conditional group is only live when the group is.
  if (field.groupWhen && field.when !== field.groupWhen
      && !isActive({ when: field.groupWhen }, scope, root)) return false;

  const w = field.when;
  if (!w) return true;
  if (w.any) return w.any.some((c) => isActive({ when: c }, scope, root));
  const key = w.field ?? '';
  const val = scope[key] !== undefined ? scope[key] : root[key];
  if (w.in) return w.in.includes((val === undefined || val === '' ? null : val) as string | null);
  if (w.not) return !w.not.includes(val as string);
  if (w.lt !== undefined) return val !== '' && val !== undefined && Number(val) < w.lt;
  if (w.gt !== undefined) return val !== '' && val !== undefined && Number(val) > w.gt;
  return true;
}

/** Cross-section conditions read from a flattened view of the answers. */
export const flatRoot = (data: Record<string, any> = {}): Record<string, unknown> =>
  ({ ...(data.purpose ?? {}), ...(data.property ?? {}) });

// ── What a question accepts ────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const POSTAL = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ ]?\d[ABCEGHJ-NPRSTV-Z]\d$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "$1,200.50" → 1200.5, and anything unreadable → null. */
export function money(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** One field. The error sentence, or null. Word for word the portal's. */
export function checkField(f: FormField, value: unknown): string | null {
  const empty = value === undefined || value === null || value === ''
    || (Array.isArray(value) && !value.length);

  if (f.req && (empty || (f.t === 'checkbox' && !value))) {
    return f.t === 'checkbox' ? 'Please tick this to continue.' : `${f.l} is required.`;
  }
  if (empty) return null; // optional and blank — fine

  switch (f.t) {
    case 'email':
      return EMAIL.test(String(value).trim()) ? null : 'That does not look like an email address.';
    case 'phone': {
      const digits = String(value).replace(/\D/g, '');
      return digits.length === 10 || (digits.length === 11 && digits[0] === '1')
        ? null : 'Enter a 10-digit phone number.';
    }
    case 'postal':
      return POSTAL.test(String(value).trim()) ? null : 'Enter a Canadian postal code, like M5V 2T6.';
    case 'date': {
      if (!ISO_DATE.test(String(value))) return 'Enter a date.';
      const d = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) return 'That date is not valid.';
      if (f.n === 'dob') {
        const age = (Date.now() - d.getTime()) / 31_557_600_000;
        if (age < 18) return 'Applicants must be 18 or older.';
        if (age > 110) return 'Please check the year.';
      }
      return null;
    }
    case 'money': {
      const n = money(value);
      if (n === null) return 'Enter an amount.';
      if (n < 0) return 'This cannot be negative.';
      if (n > 100_000_000) return 'Please check that figure.';
      return null;
    }
    case 'percent': {
      const n = Number(String(value).replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(n)) return 'Enter a rate.';
      return n > 0 && n < 30 ? null : 'Enter a rate between 0 and 30%.';
    }
    case 'sqft':
    case 'number': {
      const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(n)) return 'Enter a number.';
      if (f.min !== undefined && n < f.min) return `Must be ${f.min} or more.`;
      if (f.max !== undefined && n > f.max) return `Must be ${f.max} or less.`;
      return null;
    }
    case 'year': {
      const n = Number(value);
      const now = new Date().getFullYear();
      return Number.isInteger(n) && n >= 1800 && n <= now + 3
        ? null : `Enter a year between 1800 and ${now + 3}.`;
    }
    case 'select':
    case 'radio':
    case 'choice': {
      if (!f.o || !f.o.length || f.dynamic) return null;
      const allowed = f.o.map((o) => (typeof o === 'string' ? o : o.v));
      return allowed.includes(String(value)) ? null : 'Choose one of the options.';
    }
    case 'textarea':
      return String(value).length > 4000 ? 'Please keep this under 4000 characters.' : null;
    default:
      return String(value).length > 500 ? 'That is longer than we can store.' : null;
  }
}

export type SectionErrors = Record<string, string>;
export type SectionResult = { ok: boolean; errors: SectionErrors; complete: boolean; declared?: boolean };

/**
 * One section's answers, checked.
 *
 * Errors are keyed the way the form addresses its inputs: `field` for a plain
 * section, `index.field` inside a repeating one, and
 * `index.list.k.field` for a list nested in an entry.
 *
 * A staff member is held to the same rules as the client with one deliberate
 * exception — see `partial`. A broker correcting one wrong postal code should
 * not be forced to finish a section the client left half-done.
 */
export function validateSection(
  sectionId: string,
  data: unknown,
  root: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
  options: { partial?: boolean } = {},
): SectionResult {
  const section = sectionById(sectionId);
  if (!section) return { ok: false, errors: { _section: 'Unknown section.' }, complete: false };

  const errors: SectionErrors = {};
  const fields = fieldsOf(section);
  const required = (f: FormField) => (options.partial ? { ...f, req: false } : f);

  // An explicit answer beats an empty list. "I have no assets to declare" and
  // "nobody has filled this in yet" are different facts.
  const m = meta ?? {};
  if (section.declare && m[section.declare.n]) {
    const rows = Array.isArray(data) ? data : [];
    if (rows.length) {
      errors._section = `You have declared none, but ${rows.length} ${rows.length === 1 ? 'entry is' : 'entries are'} still listed. Remove them, or untick the declaration.`;
      return { ok: false, errors, complete: false };
    }
    return { ok: true, errors: {}, complete: true, declared: true };
  }
  if (section.gate) {
    const answer = m[section.gate.n];
    if (answer === 'no') return { ok: true, errors: {}, complete: true, declared: true };
    if (answer !== 'yes' && !options.partial) {
      errors._section = section.gate.l;
      return { ok: false, errors, complete: false };
    }
  }

  const nested = repeatGroupsOf(section);

  if (section.repeat) {
    const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
    const min = section.gate ? Math.max(section.repeat.min ?? 0, 1) : (section.repeat.min ?? 0);
    if (!options.partial && rows.length < min) {
      errors._section = section.gate
        ? `Add the ${section.repeat.label.toLowerCase()} you own, or answer "no" above.`
        : `Add at least ${min} ${section.repeat.label.toLowerCase()}.`;
    }
    if (rows.length > section.repeat.max) {
      errors._section = `No more than ${section.repeat.max} may be added.`;
    }
    rows.forEach((row, i) => {
      for (const f of fields) {
        if (!isActive(f, row, root)) continue;
        const e = checkField(required(f), row[f.n]);
        if (e) errors[`${i}.${f.n}`] = e;
      }
      for (const g of nested) {
        if (g.when && !isActive({ when: g.when }, row, root)) continue;
        const sub = (Array.isArray(row[g.repeat!.key]) ? row[g.repeat!.key] : []) as Array<Record<string, unknown>>;
        if (!options.partial && sub.length < (g.repeat!.min ?? 0)) {
          errors[`${i}.${g.repeat!.key}._list`] =
            `Add at least ${g.repeat!.min} ${g.repeat!.label.toLowerCase()}.`;
        }
        if (sub.length > g.repeat!.max) {
          errors[`${i}.${g.repeat!.key}._list`] = `No more than ${g.repeat!.max} may be added.`;
        }
        sub.forEach((srow, k) => {
          for (const f of g.fields) {
            if (!isActive(f, srow, root)) continue;
            const e = checkField(required(f), srow[f.n]);
            if (e) errors[`${i}.${g.repeat!.key}.${k}.${f.n}`] = e;
          }
        });
      }
    });
  } else {
    const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    for (const f of fields) {
      if (!isActive(f, obj, root)) continue;
      const e = checkField(required(f), obj[f.n]);
      if (e) errors[f.n] = e;
    }
    for (const g of nested) {
      if (g.when && !isActive({ when: g.when }, obj, root)) continue;
      const sub = (Array.isArray(obj[g.repeat!.key]) ? obj[g.repeat!.key] : []) as Array<Record<string, unknown>>;
      if (!options.partial && sub.length < (g.repeat!.min ?? 0)) {
        errors[`${g.repeat!.key}._list`] = `Add at least ${g.repeat!.min} ${g.repeat!.label.toLowerCase()}.`;
      }
      if (sub.length > g.repeat!.max) {
        errors[`${g.repeat!.key}._list`] = `No more than ${g.repeat!.max} may be added.`;
      }
      sub.forEach((srow, k) => {
        for (const f of g.fields) {
          if (!isActive(f, srow, root)) continue;
          const e = checkField(required(f), srow[f.n]);
          if (e) errors[`${g.repeat!.key}.${k}.${f.n}`] = e;
        }
      });
    }
  }

  const ok = Object.keys(errors).length === 0;
  return { ok, errors, complete: ok };
}

// ── Whose answer wins ──────────────────────────────────────────────────────

/**
 * How a staff correction is addressed.
 *
 * A SCALAR IS PINNED BY ITSELF. `property.purchase_price` names one answer; a
 * later portal push may still update the postal code beside it.
 *
 * A LIST IS PINNED AS A LIST. `liabilities` names the whole list, because rows
 * get added and removed and there is no stable identity to pin a row by — the
 * client's third liability after they delete their second is not the same debt.
 * Pinning per row would silently reattach a correction to the wrong one.
 */
export type EditPath = string;

export const isListPath = (path: EditPath): boolean => !path.includes('.');

/** Read `property.purchase_price` out of the answers. */
export function readPath(data: Record<string, any>, path: EditPath): unknown {
  return path.split('.').reduce<any>((at, key) => (at == null ? undefined : at[key]), data);
}

/** Write `property.purchase_price`, making the objects on the way as needed. */
export function writePath(data: Record<string, any>, path: EditPath, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  let at = data;
  for (const key of keys) {
    if (at[key] == null || typeof at[key] !== 'object') at[key] = {};
    at = at[key];
  }
  at[last] = value;
}

export type StaffEdit = { path: EditPath; value: unknown };

/**
 * The client's answers with the brokerage's corrections laid over them.
 *
 * The portal copy is never modified — it stays exactly as the client left it,
 * so "what did they actually say" always has an answer.
 */
export function mergeAnswers(
  portalData: Record<string, any>,
  edits: StaffEdit[],
): Record<string, any> {
  const merged = structuredClone(portalData ?? {});
  for (const edit of edits) writePath(merged, edit.path, structuredClone(edit.value));
  return merged;
}

/**
 * The paths a section's save is responsible for, given what changed.
 *
 * Only what actually differs is recorded. A broker who opens a section, changes
 * one field and saves has pinned one field — not the forty they looked at, which
 * would stop the portal ever updating any of them again.
 */
export function changedPaths(
  sectionId: string,
  before: unknown,
  after: unknown,
): EditPath[] {
  const section = sectionById(sectionId);
  if (!section) return [];
  // A repeating section is one list, addressed by its own name.
  if (section.repeat) {
    return same(before, after) ? [] : [section.repeat.key];
  }
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  const paths: EditPath[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (same(a[key], b[key])) continue;
    paths.push(`${sectionId}.${key}`);
  }
  return paths;
}

const same = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown) => (v === '' || v === null ? undefined : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

/** Where a section's value lives in the answers. Lists sit at their repeat key. */
export const sectionPath = (sectionId: string): string => {
  const section = sectionById(sectionId);
  return section?.repeat ? section.repeat.key : sectionId;
};
