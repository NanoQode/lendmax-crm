/**
 * The client's answers, on the file, editable.
 *
 * The form is not written out here. It is rendered from the definition the
 * server sends, which is generated from the portal's own `lib/schema.js` — so
 * a broker correcting an answer is looking at the same questions, in the same
 * order, under the same conditions, as the client who answered them.
 *
 * HOW IT IS DRAWN follows apply.lendmax.ca's own renderer (`portal.js`), piece
 * for piece, so the same definition produces the same controls and the same
 * behaviour on both sides:
 *
 *   · `choice`  — the purpose cards, with the portal's icons
 *   · `radio`   — a segmented control; `checkbox` — a switch line
 *   · `select`  — a searchable dropdown (the CRM's rule for every dropdown)
 *   · `money`, `percent`, `sqft` — with their `$`, `%` and `sq ft` affixes;
 *     money is grouped with commas as it is typed
 *   · `dynamic: 'applicants'` — "Belongs to", listing the borrowers by name,
 *     answered as Applicant 1 and never drawn while there is only one
 *   · `hidden` — answered by something else (the renewal offer), not the grid
 *   · a section's `offer` — the renewal-vs-refinance tick, under its group
 *   · a group's `toggle` — "make this the subject property"
 *   · a section's `compute` — a liability's payment estimated at 5% of the
 *     balance unless it is a car loan, written into the field and left
 *     editable
 *   · `gate` and `declare` — answering "no" or "none" empties the list;
 *     answering "yes" starts one entry
 *   · `repeat.layout` — `table` for liabilities, `list` rows titled from
 *     what is in them ("Credit Card · $4,000")
 *
 * Two portal behaviours are deliberately not copied: the progressive reveal
 * (a broker correcting a file needs every group, not one at a time) and the
 * Google address lookup (the portal's Places key lives on the portal).
 *
 * And two things this screen adds:
 *
 *   · A CORRECTION IS VISIBLE AS A CORRECTION. A field the brokerage has
 *     changed is marked, says who changed it, and offers to put the client's
 *     own answer back. Nothing quietly replaces what somebody said.
 *
 *   · A SECTION IS EDITED, NOT A PAGE. Opening one section leaves the rest
 *     read-only, so a half-finished edit cannot be lost by a stray click
 *     somewhere else on a long file.
 */
import { useState } from 'preact/hooks';
import { del, put, formatDate } from '../lib/api.ts';
import { toast, useAsync, type Session } from '../lib/store.ts';
import { Badge, ErrorNote, Field, SearchSelect, Skeleton } from '../components/ui.tsx';
import { DocumentRequestPanel } from './document-requests.tsx';

// ── The definition, as the server sends it ─────────────────────────────────

type Condition = {
  field?: string; in?: Array<string | null>; not?: string[];
  lt?: number; gt?: number; any?: Condition[];
};
type Option = string | { v: string; l: string; icon?: string; d?: string };
type FormField = {
  n: string; l: string; t: string; req?: boolean;
  o?: Option[];
  when?: Condition; groupWhen?: Condition | null;
  hint?: string; ph?: string; full?: boolean; min?: number; max?: number; step?: number; d?: string;
  dynamic?: string; hidden?: boolean; col?: string;
};
type Repeat = {
  key: string; min?: number; max: number; label: string; addLabel?: string;
  layout?: 'list' | 'table'; softMax?: number;
};
type FormGroup = {
  id: string; title?: string; fields: FormField[]; when?: Condition;
  repeat?: Repeat; note?: string; blurb?: string;
  toggle?: { n: string; l: string; default?: boolean; hint?: string };
};
type Offer = {
  when?: Condition; after?: string; optional_label?: string; title: string;
  field: string; label: string; note_field: string; note: string; confirm: string; decline: string;
  example?: {
    toggle?: string; toggle_note?: string; title: string; columns: string[];
    rows: Array<{ l: string; a: string; b: string; total?: boolean; strong_b?: boolean }>;
    savings: Array<{ l: string; v: string }>; foot: string;
  };
};
type FormSection = {
  id: string; title: string; blurb?: string; tip?: string; note?: string; groups: FormGroup[];
  optional?: boolean; after_submit?: boolean;
  repeat?: Repeat;
  declare?: { n: string; l: string };
  gate?: { n: string; l: string; yes?: string; no?: string };
  offer?: Offer;
  compute?: { field: string; from: string; rate: number; unless: { field: string; in: string[] }; note?: string };
};

export type FormPayload = {
  application: {
    id: string; reference: string | null; portal_status: string | null;
    percent_complete: number | null;
    staff_edited_at: string | null; staff_edited_by_name: string | null;
  };
  can_edit: boolean;
  edit_blocked_reason: string | null;
  sections: FormSection[];
  answers: Record<string, any>;
  edits: Array<{ path: string; edited_at: string; edited_by: string | null; portal_value: unknown }>;
  hidden_sections: string[];
  hidden_reason: string | null;
};

/** Everything a field needs to know about the file around it. */
type Ctx = {
  root: Record<string, any>;
  /** The borrowers, for "Belongs to". */
  applicants: Array<Record<string, any>>;
  solo: boolean;
  editable: boolean;
  errors: Record<string, string>;
  editedPaths: Set<string>;
  onRevert: (path: string) => void;
};

/**
 * Whether a question applies, right now, to what is on screen.
 *
 * The same rule as `isActive` in the portal's schema and in
 * `domain/application-form.ts`, restated because the front end does not share
 * the server's module graph — and it has to run on every keystroke: changing
 * "Purchase" to "Renew" has to hide the purchase price before the next save.
 */
function isActive(field: { when?: Condition; groupWhen?: Condition | null },
                  scope: Record<string, any> = {}, root: Record<string, any> = {}): boolean {
  if (field.groupWhen && field.when !== field.groupWhen
      && !isActive({ when: field.groupWhen }, scope, root)) return false;
  const w = field.when;
  if (!w) return true;
  if (w.any) return w.any.some((c) => isActive({ when: c }, scope, root));
  const key = w.field ?? '';
  const val = scope[key] !== undefined ? scope[key] : root[key];
  if (w.in) return w.in.includes((val === undefined || val === '' ? null : val) as string | null);
  if (w.not) return !w.not.includes(val);
  if (w.lt !== undefined) return val !== '' && val !== undefined && Number(val) < w.lt;
  if (w.gt !== undefined) return val !== '' && val !== undefined && Number(val) > w.gt;
  return true;
}

const flatRoot = (answers: Record<string, any>) =>
  ({ ...(answers.purpose ?? {}), ...(answers.property ?? {}) });

const sectionKey = (section: FormSection) => section.repeat?.key ?? section.id;

/** The portal's `optionsOf`: plain strings become {v,l}; "Belongs to" lists the borrowers. */
function optionsOf(f: FormField, ctx: Pick<Ctx, 'applicants'>): Array<{ v: string; l: string; icon?: string; d?: string }> {
  if (f.dynamic === 'applicants') {
    const people = ctx.applicants.length ? ctx.applicants : [{}];
    return people.map((a, i) => {
      const n = [a.first_name, a.last_name].filter(Boolean).join(' ');
      return { v: `Applicant ${i + 1}`, l: n || `Applicant ${i + 1}` };
    });
  }
  return (f.o ?? []).map((o) => (typeof o === 'string' ? { v: o, l: o } : o));
}

// ── Showing a value (the portal's `display`) ───────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const digits = (v: unknown) => String(v ?? '').replace(/[^0-9.\-]/g, '');

function display(field: FormField, value: unknown, ctx: Pick<Ctx, 'applicants'>): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (field.t) {
    case 'money': {
      const n = Number(digits(value));
      return Number.isFinite(n) ? `$${n.toLocaleString('en-CA', { maximumFractionDigits: 2 })}` : String(value);
    }
    case 'percent': return `${String(value).replace(/%$/, '')}%`;
    case 'sqft': return `${Number(digits(value)).toLocaleString('en-CA')} sq ft`;
    case 'date': {
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        const [y, m, d] = String(value).split('-');
        return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
      }
      return formatDate(String(value));
    }
    case 'checkbox': return value ? 'Yes' : 'No';
    case 'choice': case 'select': case 'radio':
      return optionsOf(field, ctx).find((o) => String(o.v) === String(value))?.l ?? String(value);
    default: return String(value);
  }
}

/** Money grouped as it is typed, the way the portal's `formatMoney` does it. */
function groupMoney(raw: string): string {
  const clean = raw.replace(/[^0-9.]/g, '');
  if (!clean) return '';
  const [whole, ...rest] = clean.split('.');
  const grouped = Number(whole || 0).toLocaleString('en-CA');
  return rest.length ? `${grouped}.${rest.join('').slice(0, 2)}` : grouped;
}

// ── Row titles ─────────────────────────────────────────────────────────────

const ORDINAL: Record<string, string> = { 1: '1st', 2: '2nd', 3: '3rd' };
const money = (v: unknown) => display({ n: '', l: '', t: 'money' }, v, { applicants: [] });

/** "Bonus · $8,000 · monthly" rather than "Income 2" (the portal's `summarise`). */
function summarise(label: string, row: Record<string, any>, i: number): string {
  const val = (n: string) => (row && row[n] !== undefined && row[n] !== '' ? row[n] : null);
  const parts: string[] = [];
  const head = val('income_type') || val('asset_type') || val('liability_type');
  if (head) parts.push(String(head));
  const amount = val('amount') || val('value') || val('balance');
  if (amount) parts.push(money(amount));
  const freq = val('frequency');
  if (freq) parts.push(String(freq).toLowerCase());
  return parts.length ? parts.join(' · ') : `${label} ${i + 1}`;
}

/** "1st · RBC · $310,000", "Active · Costco · $24,000" (the portal's `jobSummary`). */
function jobSummary(label: string, row: Record<string, any>, k: number): string {
  const parts: string[] = [];
  if (row.position) parts.push(ORDINAL[row.position] ?? String(row.position));
  if (row.loan_type && row.loan_type !== 'Mortgage') parts.push(row.loan_type);
  if (row.status) parts.push(row.status);
  if (row.employer || row.lender) parts.push(row.employer || row.lender);
  if (row.annual_income) parts.push(money(row.annual_income));
  if (row.balance) parts.push(money(row.balance));
  return parts.length ? parts.join(' · ') : `${label} ${k + 1}`;
}

/** Errors under one path prefix, with the prefix taken off. */
const errorsUnder = (errors: Record<string, string>, prefix: string) =>
  Object.fromEntries(Object.entries(errors)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => [k.slice(prefix.length), v]));

// ── Preparing a section for editing (the portal's `renderSection`) ─────────

function prepare(section: FormSection, value: any, meta: Record<string, any>) {
  if (section.repeat) {
    const rows: any[] = Array.isArray(value) ? value : [];
    const declared = !!(section.declare && meta[section.declare.n])
      || !!(section.gate && meta[section.gate.n] === 'no');
    if (!declared) {
      // A list with a minimum starts with that many blank entries; answering
      // the gate "yes" raises the minimum to one.
      let min = section.repeat.min ?? 0;
      if (section.gate && meta[section.gate.n] === 'yes') min = Math.max(min, 1);
      while (rows.length < min) rows.push({});
    }
    // "Belongs to" is answered for a single borrower.
    const scoped = section.groups.flatMap((g) => g.fields.filter((f) => f.dynamic === 'applicants'));
    for (const row of rows) for (const f of scoped) if (!row[f.n]) row[f.n] = 'Applicant 1';
    return rows;
  }
  // A group toggle with no answer shows its default (GroupFields) rather than
  // having it written in: opening a section must not, by itself, become a
  // correction to a file the portal saved before the toggle existed.
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// ── The screen ─────────────────────────────────────────────────────────────

export function ApplicationForm({ id, session, onDocumentsRequested, readOnly = false }: {
  id: string; session: Session; onDocumentsRequested?: () => void;
  /** Shown elsewhere to be read (the Compliance tab): no editing, no document requests. */
  readOnly?: boolean;
}) {
  const state = useAsync<FormPayload>(`/applications/${id}/form`);
  const [data, setData] = useState<FormPayload | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const loaded = data ?? (state.status === 'ready' ? state.data : null);
  const form = loaded && readOnly ? { ...loaded, can_edit: false, edit_blocked_reason: null } : loaded;

  if (state.status === 'loading' && !form) return <div class="card"><Skeleton rows={6} /></div>;
  if (state.status === 'error' && !form) {
    return <ErrorNote error={state.error} code={state.code} permission={state.permission}
                      onRetry={state.reload} />;
  }
  if (!form) return null;

  const root = flatRoot(form.answers);
  const editedPaths = new Set(form.edits.map((e) => e.path));

  return (
    <div class="app-form">
      {form.application.staff_edited_at && (
        <div class="note-line">
          Some answers on this file have been corrected by the brokerage
          {form.application.staff_edited_by_name ? `, last by ${form.application.staff_edited_by_name}` : ''}.
          A corrected answer is marked, and the client's own answer is kept beside it.
        </div>
      )}
      {form.hidden_reason && (
        <div class="note-line">{form.hidden_reason}</div>
      )}
      {!form.can_edit && form.edit_blocked_reason && (
        <div class="alert alert-info">{form.edit_blocked_reason}</div>
      )}

      {form.sections.map((section, index) => (
        <SectionCard
          key={section.id}
          section={section}
          step={index + 1}
          steps={form.sections.length}
          form={form}
          root={root}
          editedPaths={editedPaths}
          open={editing === section.id}
          onOpen={() => setEditing(section.id)}
          onClose={() => setEditing(null)}
          onSaved={(next) => { setData(next); setEditing(null); }}
          applicationId={id}
        />
      ))}

      {/* Under the form's own Documents section: what the client uploaded
          with the application is above, what is still owed is asked for here. */}
      {!readOnly && (
        <div id="request-documents">
          <DocumentRequestPanel applicationId={id} session={session} onSent={onDocumentsRequested} />
        </div>
      )}
    </div>
  );
}

// ── One section ────────────────────────────────────────────────────────────

function SectionCard({ section, step, steps, form, root, editedPaths, open, onOpen, onClose, onSaved, applicationId }: {
  section: FormSection; step: number; steps: number; form: FormPayload; root: Record<string, any>;
  editedPaths: Set<string>; open: boolean;
  onOpen: () => void; onClose: () => void; onSaved: (next: FormPayload) => void;
  applicationId: string;
}) {
  const key = sectionKey(section);
  const value = form.answers[key] ?? (section.repeat ? [] : {});
  const meta = form.answers.meta?.[section.id] ?? {};

  const [draft, setDraft] = useState<any>(null);
  const [draftMeta, setDraftMeta] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const savedApplicants: any[] = Array.isArray(form.answers.applicants) ? form.answers.applicants : [];

  const start = () => {
    const m = structuredClone(meta);
    setDraft(prepare(section, structuredClone(value), m));
    setDraftMeta(m);
    setErrors({});
    onOpen();
  };

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const result = await put<{ form: FormPayload }>(
        `/applications/${applicationId}/form/${section.id}`,
        { value: draft, meta: draftMeta });
      toast(`${section.title} saved.`, 'ok');
      onSaved(result.form);
    } catch (err) {
      // The form's own field messages, keyed the way this screen addresses its
      // inputs, so each lands under the question it is about.
      const detail = (err as { detail?: { errors?: Record<string, string> } }).detail;
      if (detail?.errors) {
        setErrors(detail.errors);
        toast('Some answers need looking at.', 'error');
      } else {
        setErrors({ _section: err instanceof Error ? err.message : 'Could not save that section.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const revert = async (path: string) => {
    if (!confirm('Put the client’s own answer back? Your correction is removed.')) return;
    try {
      const next = await del<FormPayload>(
        `/applications/${applicationId}/form/edits?path=${encodeURIComponent(path)}`);
      toast('The client’s answer is back.', 'ok');
      onSaved(next);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not revert that.', 'error');
    }
  };

  const live = open ? draft : value;
  const liveMeta = open ? draftMeta : meta;
  // A section's own answers affect its own conditions, so the root is the file
  // with this section's draft laid over it.
  const liveRoot = section.id === 'purpose' || section.id === 'property'
    ? { ...root, ...(live ?? {}) }
    : root;
  const applicants: any[] = section.id === 'applicants' && open ? (draft ?? []) : savedApplicants;

  const ctx: Ctx = {
    root: liveRoot, applicants, solo: applicants.length <= 1, editable: open, errors,
    editedPaths, onRevert: revert,
  };

  const declaredNone = !!(section.declare && liveMeta[section.declare.n]);
  const gateAnswer = section.gate ? liveMeta[section.gate.n] ?? '' : '';
  const gatedOut = !!(section.gate && gateAnswer === 'no');

  const setMeta = (patch: Record<string, any>) => setDraftMeta((m) => ({ ...m, ...patch }));

  return (
    <div class={`card app-section${open ? ' app-section-open' : ''}`}>
      <div class="card-head">
        <div>
          <div class="app-step">Step {step} of {steps}</div>
          <h2>{section.title}</h2>
          {section.blurb && <p class="text-sm text-muted mb-0">{section.blurb}</p>}
        </div>
        <div class="row" style={{ gap: 6 }}>
          {section.optional && <Badge>Optional</Badge>}
          {section.after_submit && <Badge>After submission</Badge>}
          {form.can_edit && !open && (
            <button class="btn btn-sm" onClick={start}>Edit</button>
          )}
          {open && (
            <>
              <button class="btn btn-sm" disabled={busy} onClick={onClose}>Cancel</button>
              <button class="btn btn-sm btn-primary" disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      <div class="card-body">
        {errors._section && <div class="alert alert-error">{errors._section}</div>}
        {open && section.tip && <p class="text-sm text-muted">{section.tip}</p>}
        {section.note && <p class="app-sub-note">{section.note}</p>}

        {section.gate && (
          <div class="app-group">
            <h3 class="app-group-title">{section.gate.l}</h3>
            <div class="seg">
              {(['yes', 'no'] as const).map((v) => (
                <button key={v} type="button" disabled={!open} class={gateAnswer === v ? 'active' : ''}
                        onClick={() => {
                          setMeta({ [section.gate!.n]: v });
                          // "No" empties the list; "yes" starts one entry.
                          setDraft((rows: any[]) => (v === 'no' ? [] : prepare(section, rows ?? [], { [section.gate!.n]: 'yes' })));
                        }}>
                  {v === 'yes' ? section.gate!.yes ?? 'Yes' : section.gate!.no ?? 'No'}
                </button>
              ))}
            </div>
          </div>
        )}
        {section.declare && (
          <ToggleLine
            label={section.declare.l}
            hint="On when it genuinely does not apply — it says the client has not simply skipped it."
            on={declaredNone} disabled={!open}
            onChange={(on) => {
              setMeta({ [section.declare!.n]: on });
              setDraft(on ? [] : prepare(section, [], {}));
            }} />
        )}

        {declaredNone || gatedOut ? (
          <p class="text-sm text-muted mb-0">
            {gatedOut ? 'Nothing more is needed here.' : 'Declared: nothing to add here.'}
          </p>
        ) : section.repeat ? (
          <RepeatSection section={section} rows={(live ?? []) as any[]} ctx={ctx}
                         onChange={setDraft} />
        ) : (
          <PlainSection section={section} value={(live ?? {}) as Record<string, any>} ctx={ctx}
                        meta={liveMeta} prefix={section.id} onChange={setDraft} onMeta={setMeta} />
        )}
      </div>
    </div>
  );
}

// ── A section that is one form ─────────────────────────────────────────────

function PlainSection({ section, value, ctx, meta, prefix, onChange, onMeta }: {
  section: FormSection; value: Record<string, any>; ctx: Ctx; meta: Record<string, any>;
  prefix: string; onChange: (next: Record<string, any>) => void; onMeta: (patch: Record<string, any>) => void;
}) {
  const set = (patch: Record<string, unknown>) => onChange({ ...value, ...patch });
  const offer = (after: string | undefined) => (section.offer && section.offer.after === after
    ? <OfferBlock offer={section.offer} value={value} meta={meta} ctx={ctx} onSet={set} onMeta={onMeta} />
    : null);

  return (
    <>
      {section.groups.map((group) => {
        if (group.when && !isActive({ when: group.when }, value, ctx.root)) return null;
        return (
          <div key={group.id}>
            {group.repeat
              ? <NestedList group={group} rows={value[group.repeat.key] ?? []} ctx={ctx}
                            errPrefix={`${group.repeat.key}.`} topLevel
                            onChange={(rows) => set({ [group.repeat!.key]: rows })} />
              : <GroupFields group={group} scope={value} ctx={ctx} errPrefix="" editPrefix={`${prefix}.`}
                             onSet={set} />}
            {offer(group.id)}
          </div>
        );
      })}
      {offer(undefined)}
    </>
  );
}

/** A group's title, its toggle, and its grid of fields. */
function GroupFields({ group, scope, ctx, errPrefix, editPrefix, onSet, showTitle = true }: {
  group: FormGroup; scope: Record<string, any>; ctx: Ctx; errPrefix: string; editPrefix: string | null;
  onSet: (patch: Record<string, unknown>) => void; showTitle?: boolean;
}) {
  const fields = group.fields
    .map((f) => ({ ...f, when: f.when ?? group.when, groupWhen: group.when ?? null }))
    .filter((f) => isActive(f, scope, ctx.root))
    .filter((f) => !f.hidden && !(f.dynamic === 'applicants' && ctx.solo));
  if (!fields.length && !group.toggle) return null;
  const toggleOn = group.toggle
    ? (scope[group.toggle.n] === undefined ? !!group.toggle.default : !!scope[group.toggle.n])
    : false;

  return (
    <div class="app-group">
      {showTitle && group.title && <h3 class="app-group-title">{group.title}</h3>}
      {group.note && <p class="app-sub-note">{group.note}</p>}
      {group.blurb && <p class="app-sub-note">{group.blurb}</p>}
      {group.toggle && (
        <ToggleLine label={group.toggle.l} hint={group.toggle.hint} on={toggleOn} disabled={!ctx.editable}
                    onChange={(on) => onSet({ [group.toggle!.n]: on })} />
      )}
      <div class="form-grid">
        {fields.map((f) => {
          const path = editPrefix ? `${editPrefix}${f.n}` : null;
          return (
            <FieldControl
              key={f.n} field={f} value={scope[f.n]} ctx={ctx}
              error={ctx.errors[`${errPrefix}${f.n}`]}
              edited={!!path && ctx.editedPaths.has(path)}
              onRevert={path ? () => ctx.onRevert(path) : undefined}
              onChange={(v) => onSet({ [f.n]: v })} />
          );
        })}
      </div>
    </div>
  );
}

// ── The renewal offer (the portal's `offerHtml`) ───────────────────────────

function OfferBlock({ offer, value, meta, ctx, onSet, onMeta }: {
  offer: Offer; value: Record<string, any>; meta: Record<string, any>; ctx: Ctx;
  onSet: (patch: Record<string, unknown>) => void; onMeta: (patch: Record<string, any>) => void;
}) {
  if (offer.when && !isActive({ when: offer.when }, value, ctx.root)) return null;
  const on = !!value[offer.field];

  if (meta.offer_declined) {
    return (
      <div class="app-offer-declined text-sm">
        Refinance comparison: the client chose “{offer.decline}”.
        {ctx.editable && (
          <button class="link-button" style={{ marginLeft: 6 }}
                  onClick={() => onMeta({ offer_declined: false })}>Offer it again</button>
        )}
      </div>
    );
  }

  const x = offer.example;
  return (
    <section class={`app-offer${on ? ' on' : ''}`}>
      {offer.optional_label && <span class="app-offer-opt">{offer.optional_label}</span>}
      <h3>{offer.title}</h3>
      <label class="app-offer-tick">
        <input type="checkbox" checked={on} disabled={!ctx.editable}
               onChange={(e) => {
                 const checked = (e.target as HTMLInputElement).checked;
                 // The tick is a request, so it is written in words a broker reads.
                 onSet({ [offer.field]: checked, [offer.note_field]: checked ? offer.note : '' });
               }} />
        <span>{offer.label}</span>
      </label>
      {on && <p class="app-offer-ok">✓ {offer.confirm}</p>}
      {x && (
        <details class="app-offer-eg">
          <summary>{x.toggle ?? 'See a worked example'} <span class="text-muted">· {x.toggle_note ?? 'An illustration, not a quote'}</span></summary>
          <p class="app-offer-eg-h">{x.title}</p>
          <table class="app-offer-tbl">
            <thead><tr><th />{x.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {x.rows.map((r) => (
                <tr key={r.l} class={r.total ? 'total' : ''}>
                  <th scope="row">{r.l}</th><td>{r.a}</td><td class={r.strong_b ? 'win' : ''}>{r.b}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul class="app-offer-save">
            {x.savings.map((s) => <li key={s.l}><span>{s.l}</span><b>{s.v}</b></li>)}
          </ul>
          <p class="text-sm text-muted mb-0">{x.foot}</p>
        </details>
      )}
      {ctx.editable && (
        <button class="link-button text-sm" type="button" style={{ marginTop: 8, display: 'block' }}
                onClick={() => { onSet({ [offer.field]: false, [offer.note_field]: '' }); onMeta({ offer_declined: true }); }}>
          {offer.decline}
        </button>
      )}
    </section>
  );
}

// ── A section that is a list ───────────────────────────────────────────────

function RepeatSection({ section, rows, ctx, onChange }: {
  section: FormSection; rows: any[]; ctx: Ctx; onChange: (rows: any[]) => void;
}) {
  const r = section.repeat!;
  const edited = ctx.editedPaths.has(r.key);

  const setRow = (i: number, patch: Record<string, unknown>) => {
    onChange(rows.map((row, n) => {
      if (n !== i) return row;
      const next = { ...row, ...patch };
      // The portal's `recompute`: a liability's payment is 5% of its balance,
      // except a car loan's — written in, and left for a person to type over.
      const c = section.compute;
      if (c && (c.from in patch || c.unless.field in patch) && !c.unless.in.includes(next[c.unless.field])) {
        const base = Number(String(next[c.from] ?? '').replace(/[^0-9.]/g, ''));
        if (Number.isFinite(base) && base > 0) next[c.field] = String(Math.round(base * c.rate));
      }
      return next;
    }));
  };
  const remove = (i: number) => {
    if (!confirm(`Remove ${r.label.toLowerCase()} ${i + 1}?`)) return;
    onChange(rows.filter((_, n) => n !== i));
  };
  const add = () => onChange(prepare(section, [...rows, {}], {}));

  if (!rows.length && !ctx.editable) {
    return <p class="text-sm text-muted mb-0">No {r.label.toLowerCase()} on this file.</p>;
  }

  let note = '';
  if (r.softMax && rows.length >= r.softMax && rows.length < r.max) {
    note = `Most applications have ${r.softMax}. You can add up to ${r.max}.`;
  } else if (rows.length >= r.max) {
    note = `That is the maximum of ${r.max}.`;
  }

  return (
    <>
      {edited && (
        <div class="app-edited-list">
          This list was changed by the brokerage.
          <button class="link-button" onClick={() => ctx.onRevert(r.key)}>
            Put the client’s list back
          </button>
        </div>
      )}

      {r.layout === 'table'
        ? <TableRows section={section} rows={rows} ctx={ctx} onSet={setRow} onRemove={remove} />
        : rows.map((row, i) => {
            const rowCtx: Ctx = { ...ctx, errors: errorsUnder(ctx.errors, `${i}.`), editedPaths: new Set() };
            return (
              <div key={i} class="app-row">
                <div class="app-row-head">
                  <strong><span class="app-row-badge">{i + 1}</span>
                    {r.layout === 'list' ? summarise(r.label, row, i) : `${r.label} ${i + 1}`}</strong>
                  {ctx.editable && rows.length > (r.min ?? 0) && (
                    <button class="btn btn-ghost btn-sm" onClick={() => remove(i)}>Remove</button>
                  )}
                </div>
                {section.groups.map((g, gi) => {
                  if (g.when && !isActive({ when: g.when }, row, ctx.root)) return null;
                  if (g.repeat) {
                    return (
                      <NestedList key={g.id} group={g} rows={row[g.repeat.key] ?? []} ctx={rowCtx}
                                  errPrefix={`${g.repeat.key}.`}
                                  onChange={(list) => setRow(i, { [g.repeat!.key]: list })} />
                    );
                  }
                  return (
                    <GroupFields key={g.id} group={g} scope={row} ctx={rowCtx} errPrefix="" editPrefix={null}
                                 showTitle={gi > 0} onSet={(patch) => setRow(i, patch)} />
                  );
                })}
              </div>
            );
          })}

      {ctx.editable && (
        <div class="row" style={{ gap: 10, alignItems: 'center' }}>
          <button class="btn btn-sm" disabled={rows.length >= r.max} onClick={add}>
            + {r.addLabel ?? `Add ${r.label.toLowerCase()}`}
          </button>
          {note && <span class="text-sm text-muted">{note}</span>}
        </div>
      )}
    </>
  );
}

/** Liabilities: one row per debt, read down a column (the portal's `tableHtml`). */
function TableRows({ section, rows, ctx, onSet, onRemove }: {
  section: FormSection; rows: any[]; ctx: Ctx;
  onSet: (i: number, patch: Record<string, unknown>) => void; onRemove: (i: number) => void;
}) {
  const r = section.repeat!;
  const g = section.groups[0]!;
  const cols = g.fields.filter((f) =>
    !(f.dynamic === 'applicants' && ctx.solo) && !f.hidden && f.t !== 'checkbox' && !f.when);
  const extras = g.fields.filter((f) =>
    !f.hidden && f.t === 'checkbox' && !(f.dynamic === 'applicants' && ctx.solo));
  const template = `${cols.map((f) => f.col ?? '1fr').join(' ')} 44px`;

  return (
    <div class="app-tbl">
      <div class="app-tbl-head" style={{ gridTemplateColumns: template }}>
        {cols.map((f) => <span key={f.n}>{f.l}{f.req && ctx.editable ? <span class="req"> *</span> : null}</span>)}
        <span />
      </div>
      {rows.map((row, i) => {
        const errs = errorsUnder(ctx.errors, `${i}.`);
        return (
          <div key={i} class="app-tbl-row">
            <div class="app-tbl-cells" style={{ gridTemplateColumns: template }}>
              {cols.map((f) => (
                <div key={f.n} class="app-tbl-cell" data-label={f.l}>
                  <FieldControl field={f} value={row[f.n]} ctx={ctx} bare error={errs[f.n]}
                                onChange={(v) => onSet(i, { [f.n]: v })} />
                </div>
              ))}
              <div class="app-tbl-cell">
                {ctx.editable && rows.length > (r.min ?? 0) && (
                  <button class="btn btn-ghost btn-sm" aria-label={`Remove ${r.label} ${i + 1}`}
                          onClick={() => onRemove(i)}>✕</button>
                )}
              </div>
            </div>
            {extras.filter((f) => isActive(f, row, ctx.root)).map((f) => (
              <div key={f.n} class="app-tbl-extra">
                <FieldControl field={f} value={row[f.n]} ctx={ctx} error={errs[f.n]}
                              onChange={(v) => onSet(i, { [f.n]: v })} />
              </div>
            ))}
          </div>
        );
      })}
      {section.compute?.note && ctx.editable && (
        <p class="text-sm text-muted" style={{ margin: '6px 0 10px' }}>{section.compute.note}</p>
      )}
    </div>
  );
}

/** A list inside an entry or a section — an applicant's other jobs, a property's charges. */
function NestedList({ group, rows, ctx, errPrefix, topLevel = false, onChange }: {
  group: FormGroup; rows: any[]; ctx: Ctx; errPrefix: string; topLevel?: boolean;
  onChange: (rows: any[]) => void;
}) {
  const r = group.repeat!;
  const listError = ctx.errors[`${errPrefix}_list`];
  return (
    <div class="app-group">
      {group.title && <h3 class="app-group-title">{group.title}</h3>}
      {group.note && <p class="app-sub-note">{group.note}</p>}
      {group.blurb && <p class="app-sub-note">{group.blurb}</p>}
      {!rows.length && !ctx.editable && (
        <p class="text-sm text-muted mb-0">None recorded.</p>
      )}
      {rows.map((row, k) => {
        const errs = errorsUnder(ctx.errors, `${errPrefix}${k}.`);
        return (
          <div key={k} class={`app-row${topLevel ? '' : ' app-row-nested'}`}>
            <div class="app-row-head">
              <strong><span class="app-row-badge">{k + 1}</span>{jobSummary(r.label, row, k)}</strong>
              {ctx.editable && rows.length > (r.min ?? 0) && (
                <button class="btn btn-ghost btn-sm"
                        onClick={() => onChange(rows.filter((_, n) => n !== k))}>Remove</button>
              )}
            </div>
            <div class="form-grid">
              {group.fields.filter((f) => isActive(f, row, ctx.root) && !f.hidden).map((f) => (
                <FieldControl
                  key={f.n} field={f} value={row[f.n]} ctx={ctx} error={errs[f.n]}
                  onChange={(v) => onChange(rows.map((x, n) => (n === k ? { ...x, [f.n]: v } : x)))} />
              ))}
            </div>
          </div>
        );
      })}
      {listError && <div class="field-error">{listError}</div>}
      {ctx.editable && (
        <button class="btn btn-sm" disabled={rows.length >= r.max} onClick={() => onChange([...rows, {}])}>
          + {r.addLabel ?? `Add ${r.label.toLowerCase()}`}
        </button>
      )}
    </div>
  );
}

// ── Controls ───────────────────────────────────────────────────────────────

function ToggleLine({ label, hint, on, disabled, onChange }: {
  label: string; hint?: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void;
}) {
  return (
    <div class={`app-toggle-line${on ? ' on' : ''}`}>
      <span>
        {label}
        {hint && <span class="hint">{hint}</span>}
      </span>
      <button type="button" class="switch" role="switch" aria-checked={on} aria-label={label}
              disabled={disabled} onClick={() => onChange(!on)}>
        <span class="switch-thumb" />
      </button>
    </div>
  );
}

/** The portal's purpose icons, drawn with the same paths. */
const CHOICE_ICONS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
  renew: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 4v4h-4"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 20v-4h4"/>',
  coins: '<ellipse cx="9" cy="6.5" rx="6" ry="3"/><path d="M3 6.5v5c0 1.7 2.7 3 6 3s6-1.3 6-3"/><path d="M9 14.5v3c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/><ellipse cx="15" cy="9.5" rx="6" ry="3"/>',
  chart: '<path d="M4 20h16"/><path d="M6 16V9M11 16V5M16 16v-4"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
};

function FieldControl({ field, value, ctx, error, edited, onRevert, onChange, bare = false }: {
  field: FormField; value: unknown; ctx: Ctx; error?: string;
  edited?: boolean; onRevert?: () => void; onChange: (value: unknown) => void; bare?: boolean;
}) {
  const editable = ctx.editable;
  const marker = edited ? (
    <span class="app-edited" title="Corrected by the brokerage">
      {' '}· corrected
      {onRevert && <button class="link-button" style={{ marginLeft: 4 }} onClick={onRevert}>undo</button>}
    </span>
  ) : null;
  const label = bare ? <span class="sr-only">{field.l}</span> : (
    <>
      {field.l}
      {field.req && editable && <span class="req" aria-hidden="true"> *</span>}
      {marker}
    </>
  );
  const wide = field.full || ['choice', 'radio', 'checkbox', 'textarea'].includes(field.t);
  const wrap = (children: any) => (
    <div class={wide && !bare ? 'app-field-full' : undefined}>
      <Field label={label} error={error} hint={editable && !bare ? field.hint : undefined}>{children}</Field>
    </div>
  );

  /* choice cards — the opening question of the journey */
  if (field.t === 'choice') {
    return wrap(
      <div class="app-choice-grid" role="radiogroup" aria-label={field.l}>
        {optionsOf(field, ctx).map((o) => {
          const selected = String(value ?? '') === String(o.v);
          return (
            <button key={o.v} type="button" role="radio" aria-checked={selected}
                    disabled={!editable}
                    class={`app-choice${selected ? ' selected' : ''}`}
                    onClick={() => onChange(o.v)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                   stroke-linejoin="round" class="app-choice-icon" aria-hidden="true"
                   dangerouslySetInnerHTML={{ __html: CHOICE_ICONS[o.icon ?? 'check'] ?? CHOICE_ICONS.check! }} />
              <strong>{o.l}</strong>
              {o.d && <span>{o.d}</span>}
            </button>
          );
        })}
      </div>,
    );
  }

  /* a yes/no about this application, as a switch */
  if (field.t === 'checkbox') {
    return (
      <div class={bare ? undefined : 'app-field-full'}>
        <ToggleLine label={`${field.l}${field.req && editable ? ' *' : ''}`}
                    hint={editable ? field.hint : undefined} on={!!value}
                    disabled={!editable} onChange={(on) => onChange(on)} />
        {marker}
        {error && <div class="field-error">{error}</div>}
      </div>
    );
  }

  if (!editable) {
    return wrap(
      <div class={`static-field${edited ? ' static-field-edited' : ''}`}>
        {display(field, value, ctx)}
      </div>,
    );
  }

  /* two- or three-way answers as a segmented control */
  if (field.t === 'radio') {
    return wrap(
      <div class="seg seg-full" role="radiogroup" aria-label={field.l}>
        {optionsOf(field, ctx).map((o) => {
          const on = String(value ?? '') === String(o.v);
          return (
            <button key={o.v} type="button" role="radio" aria-checked={on} class={on ? 'active' : ''}
                    onClick={() => onChange(o.v)}>{o.l}</button>
          );
        })}
      </div>,
    );
  }

  if (field.t === 'select') {
    return wrap(
      <SearchSelect
        value={(value ?? '') as string} ariaLabel={field.l} placeholder="Select…"
        options={optionsOf(field, ctx).map((o) => ({ value: o.v, label: o.l }))}
        onChange={(v) => onChange(v)} invalid={!!error} />,
    );
  }

  const text = (value ?? '') as string;
  const input = (e: Event) => onChange((e.target as HTMLInputElement).value);
  const affix = (kind: 'prefix' | 'suffix', mark: string, control: any) => (
    <div class={`app-affix app-affix-${kind}`}>
      {kind === 'prefix' && <span class="app-affix-mark">{mark}</span>}
      {control}
      {kind === 'suffix' && <span class="app-affix-mark">{mark}</span>}
    </div>
  );

  switch (field.t) {
    case 'textarea':
      return wrap(<textarea rows={3} value={text} placeholder={field.ph} onInput={input} />);
    case 'money':
      return wrap(affix('prefix', '$',
        <input inputMode="decimal" value={groupMoney(String(text))} placeholder={field.ph}
               aria-invalid={!!error}
               onInput={(e) => {
                 const el = e.target as HTMLInputElement;
                 const clean = el.value.replace(/[^0-9.]/g, '');
                 el.value = groupMoney(clean);
                 onChange(clean);
               }} />));
    case 'percent':
      return wrap(affix('suffix', '%', <input inputMode="decimal" value={text} placeholder={field.ph} onInput={input} />));
    case 'sqft':
      return wrap(affix('suffix', 'sq ft', <input inputMode="numeric" value={text} placeholder={field.ph} onInput={input} />));
    case 'number': case 'year':
      return wrap(<input type="number" inputMode="numeric" value={text} placeholder={field.ph}
                         min={field.min} max={field.max} step={field.step ?? 1} onInput={input} />);
    case 'date':
      return wrap(<input type="date" value={text} onInput={input} />);
    case 'email':
      return wrap(<input type="email" inputMode="email" value={text} placeholder={field.ph} onInput={input} />);
    case 'phone':
      return wrap(<input type="tel" inputMode="tel" value={text} placeholder={field.ph} onInput={input} />);
    case 'postal':
      return wrap(<input maxLength={7} value={text} placeholder={field.ph ?? 'A1A 1A1'}
                         onInput={(e) => onChange((e.target as HTMLInputElement).value.toUpperCase())} />);
    default:
      return wrap(<input value={text} placeholder={field.ph} onInput={input} />);
  }
}
