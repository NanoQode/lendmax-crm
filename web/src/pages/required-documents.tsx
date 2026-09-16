/**
 * Required documents — for each application purpose, the documents a client
 * is asked for, what they are told about each, and which file formats count.
 *
 * The application's "request documents" step reads this list. What is set up
 * here is what a client with that purpose will see.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { del, fieldErrors, patch, post, relativeTime } from '../lib/api.ts';
import { toast, useAsync, type Session } from '../lib/store.ts';
import {
  Badge, Empty, ErrorNote, Field, Icon, ICONS, Modal, SearchSelect, Switch, type SelectOption,
} from '../components/ui.tsx';
import { DataTable, emptyQuery, queryToParams, type Column, type TableQuery } from '../components/data-table.tsx';

type Purpose = { key: string; label: string };
type Format = { key: string; label: string; extensions: string[] };
type Meta = {
  purposes: Purpose[];
  formats: Format[];
  categories: Array<{ key: string; label: string; group_key: string | null }>;
  suggested: Record<string, number>;
  can_manage: boolean;
};

export type RequiredDocument = {
  id: string; purpose: string; purpose_label: string; name: string; description: string | null;
  formats: string[]; formats_label: string; category_key: string | null; category_label: string | null;
  required: boolean; per_applicant: boolean; position: number; active: boolean;
  created_at: string; updated_at: string; updated_by_name: string | null;
};

type ListResponse = {
  rows: RequiredDocument[]; total: number; page: number; page_size: number;
  purposes: Array<Purpose & { total: number; active: number }>;
};

/** The groups the format checkboxes are shown in. */
const FORMAT_GROUPS: Array<[string, string[]]> = [
  ['Documents', ['pdf', 'doc', 'docx']],
  ['Images', ['jpg', 'jpeg', 'png', 'heic', 'webp', 'tiff']],
  ['Spreadsheets', ['xls', 'xlsx', 'csv']],
];

export function RequiredDocumentsPage({ session: _session }: { session: Session }) {
  const meta = useAsync<Meta>('/required-documents/meta');
  const [query, setQuery] = useState<TableQuery>(emptyQuery({ sort: 'position', dir: 'asc' }));
  const [data, setData] = useState<ListResponse | null>(null);
  const [editing, setEditing] = useState<RequiredDocument | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RequiredDocument | null>(null);
  const [nonce, setNonce] = useState(0);

  const m = meta.status === 'ready' ? meta.data : null;
  const canManage = m?.can_manage ?? false;
  const purpose = query.filters.purpose ?? '';

  const columns = useMemo<Column<RequiredDocument>[]>(() => {
    const cols: Column<RequiredDocument>[] = [
      {
        key: 'position', header: '#', sortKey: 'position', filter: false, width: '44px',
        render: (r) => <span class="text-muted num">{r.position}</span>,
      },
      {
        key: 'purpose', header: 'Purpose', param: 'purpose', sortKey: 'purpose',
        filter: { options: (m?.purposes ?? []).map((p) => ({ value: p.key, label: p.label })) },
        render: (r) => <Badge tone="accent">{r.purpose_label}</Badge>,
      },
      {
        key: 'name', header: 'Document', param: 'name', sortKey: 'name', primary: true, width: '30%',
        render: (r) => (
          <div>
            <div class="doc-name">{r.name}</div>
            {r.description && <div class="doc-desc">{r.description}</div>}
          </div>
        ),
      },
      {
        key: 'formats', header: 'Formats', param: 'format', sortKey: 'formats',
        filter: { options: (m?.formats ?? []).map((f) => ({ value: f.key, label: f.label })) },
        render: (r) => (
          <span class="fmt-badges" title={`Accepts ${r.formats_label}`}>
            {r.formats.map((f) => <span key={f} class="fmt">{f.toUpperCase()}</span>)}
          </span>
        ),
      },
      {
        key: 'category', header: 'Category', param: 'category', sortKey: 'category',
        filter: { options: [{ value: '__none', label: 'No category' },
                            ...(m?.categories ?? []).map((c) => ({ value: c.key, label: c.label }))] },
        render: (r) => r.category_label ?? <span class="text-muted">—</span>,
      },
      {
        key: 'required', header: 'Required', param: 'required', sortKey: 'required',
        filter: { options: [{ value: 'yes', label: 'Required' }, { value: 'no', label: 'If applicable' }] },
        render: (r) => r.required ? <Badge tone="info">Required</Badge> : <Badge>If applicable</Badge>,
      },
      {
        key: 'per_applicant', header: 'Asked of', param: 'per_applicant', sortKey: 'per_applicant',
        filter: { options: [{ value: 'yes', label: 'Each applicant' }, { value: 'no', label: 'Once per file' }] },
        render: (r) => r.per_applicant ? 'Each applicant' : 'Once per file',
      },
      {
        key: 'status', header: 'Status', param: 'status', sortKey: 'active',
        filter: { options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
        render: (r) => canManage
          ? <ActiveSwitch doc={r} onChanged={() => setNonce((n) => n + 1)} />
          : r.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>,
      },
      {
        key: 'updated_at', header: 'Updated', sortKey: 'updated_at', filter: false,
        render: (r) => (
          <span class="text-sm text-muted" title={r.updated_by_name ? `by ${r.updated_by_name}` : undefined}>
            {relativeTime(r.updated_at)}
          </span>
        ),
      },
    ];
    if (canManage) {
      cols.push({
        key: 'actions', header: '', sortable: false, filter: false,
        render: (r) => <RowActions doc={r} canReorder={query.sort === 'position' && !!purpose}
                                   onEdit={() => setEditing(r)} onDelete={() => setDeleting(r)}
                                   onChanged={() => setNonce((n) => n + 1)} />,
      });
    }
    return cols;
  }, [m, canManage, query.sort, purpose]);

  const params = queryToParams(query, columns).toString();
  const list = useAsync<ListResponse>(`/required-documents?${params}`, [params, nonce]);
  useEffect(() => { if (list.status === 'ready') setData(list.data); }, [list]);

  const reload = () => setNonce((n) => n + 1);
  const setPurpose = (key: string) => {
    const filters = { ...query.filters };
    if (key) filters.purpose = key; else delete filters.purpose;
    setQuery({ ...query, filters, page: 1 });
  };

  const counts = data?.purposes ?? [];
  const currentCount = counts.find((c) => c.key === purpose)?.total ?? null;

  const addSuggested = async () => {
    try {
      const { added } = await post<{ added: number }>('/required-documents/suggested', { purpose });
      toast(`${added} suggested document${added === 1 ? '' : 's'} added. Edit or remove any of them.`, 'ok');
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the suggested list.', 'error');
    }
  };

  if (meta.status === 'error') {
    return <div class="content-narrow"><ErrorNote error={meta.error} code={meta.code} permission={meta.permission} onRetry={meta.reload} /></div>;
  }

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Required documents</h1>
          <p>
            What a client is asked to provide, depending on the purpose of their application — and in which
            file formats. The application’s document request uses this list.
          </p>
        </div>
        {canManage && (
          <button class="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon path={ICONS.plus} /> Add document
          </button>
        )}
      </div>

      <div class="purpose-tabs" role="tablist" aria-label="Purpose">
        <button class="purpose-tab" role="tab" aria-selected={!purpose} onClick={() => setPurpose('')}>
          All purposes <span class="n">{counts.reduce((s, c) => s + c.total, 0)}</span>
        </button>
        {counts.map((c) => (
          <button key={c.key} class="purpose-tab" role="tab" aria-selected={purpose === c.key}
                  onClick={() => setPurpose(c.key)}>
            {c.label} <span class="n">{c.total}</span>
          </button>
        ))}
      </div>

      {canManage && purpose && currentCount === 0 && (
        <div class="card" style={{ marginBottom: 14 }}>
          <Empty title={`No documents for ${m?.purposes.find((p) => p.key === purpose)?.label} yet`}
                 action={
                   <div class="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                     {(m?.suggested[purpose] ?? 0) > 0 && (
                       <button class="btn btn-primary" onClick={addSuggested}>
                         Start from the suggested list ({m?.suggested[purpose]})
                       </button>
                     )}
                     <button class="btn" onClick={() => setEditing('new')}>Add one myself</button>
                   </div>
                 }>
            The suggested list is what Canadian lenders commonly ask for. Everything in it can be edited or removed.
          </Empty>
        </div>
      )}

      {!(canManage && purpose && currentCount === 0 && !query.q && Object.keys(query.filters).length === 1) && (
      <div class="card">
        <DataTable<RequiredDocument>
          label="Required documents"
          columns={columns}
          rows={data?.rows ?? []}
          total={data?.total ?? 0}
          rowKey={(r) => r.id}
          query={query}
          onQueryChange={setQuery}
          loading={list.status === 'loading'}
          initialSort={{ key: 'position', dir: 'asc' }}
          searchPlaceholder="Search documents and descriptions…"
          rowClass={(r) => (r.active ? '' : 'row-dim')}
          onRowClick={canManage ? (r) => setEditing(r) : undefined}
          toolbar={purpose && canManage && query.sort !== 'position'
            ? <span class="text-sm text-muted">Sort by # to reorder</span>
            : null}
          empty={
            <Empty title="No required documents yet"
                   action={canManage ? <button class="btn btn-primary" onClick={() => setEditing('new')}>Add the first one</button> : undefined}>
              Choose a purpose above to start from a suggested list, or add documents one at a time.
            </Empty>
          }
        />
      </div>
      )}

      {editing && m && (
        <DocumentForm meta={m} doc={editing === 'new' ? null : editing}
                      defaultPurpose={purpose || undefined}
                      onClose={() => setEditing(null)}
                      onSaved={(doc, created) => {
                        setEditing(null);
                        toast(created ? `“${doc.name}” added to ${doc.purpose_label}.` : `“${doc.name}” saved.`, 'ok');
                        reload();
                      }} />
      )}

      {deleting && (
        <Modal title={`Delete “${deleting.name}”?`} onClose={() => setDeleting(null)} footer={
          <>
            <button class="btn" onClick={() => setDeleting(null)}>Cancel</button>
            <button class="btn btn-danger-solid" onClick={async () => {
              try {
                await del(`/required-documents/${deleting.id}`);
                toast(`“${deleting.name}” removed from ${deleting.purpose_label}.`, 'ok');
                setDeleting(null);
                reload();
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Could not delete it.', 'error');
              }
            }}>Delete</button>
          </>
        }>
          <p class="mt-0">
            New {deleting.purpose_label.toLowerCase()} applications will no longer ask for it. Requests already sent
            keep their wording. To stop asking for it for a while instead, make it inactive.
          </p>
        </Modal>
      )}
    </div>
  );
}

function RowActions({ doc, canReorder, onEdit, onDelete, onChanged }: {
  doc: RequiredDocument; canReorder: boolean;
  onEdit: () => void; onDelete: () => void; onChanged: () => void;
}) {
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast(ok, 'ok'); onChanged(); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not do that.', 'error'); }
  };
  return (
    <div class="row-actions" onClick={(e) => e.stopPropagation()}>
      {canReorder && (
        <>
          <button class="btn btn-ghost btn-sm" title="Move up" aria-label={`Move ${doc.name} up`}
                  onClick={() => act(() => post(`/required-documents/${doc.id}/move`, { direction: 'up' }))}>↑</button>
          <button class="btn btn-ghost btn-sm" title="Move down" aria-label={`Move ${doc.name} down`}
                  onClick={() => act(() => post(`/required-documents/${doc.id}/move`, { direction: 'down' }))}>↓</button>
        </>
      )}
      <button class="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
      <button class="btn btn-ghost btn-sm" style={{ color: 'var(--danger-text)' }} onClick={onDelete}>Delete</button>
    </div>
  );
}

/** Active / inactive, switched in place. */
function ActiveSwitch({ doc, onChanged }: { doc: RequiredDocument; onChanged: () => void }) {
  return (
    <span class="row" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
      <Switch checked={doc.active} label={`${doc.name} active`} onChange={async (next) => {
        try {
          await patch(`/required-documents/${doc.id}`, { active: next });
          toast(`“${doc.name}” is ${next ? 'active' : 'inactive'}.`, 'ok');
          onChanged();
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Could not change that.', 'error');
        }
      }} />
      <span class="text-sm">{doc.active ? 'Active' : 'Inactive'}</span>
    </span>
  );
}

// ── Add / edit ─────────────────────────────────────────────────────────────

function DocumentForm({ meta, doc, defaultPurpose, onClose, onSaved }: {
  meta: Meta; doc: RequiredDocument | null; defaultPurpose?: string;
  onClose: () => void; onSaved: (doc: RequiredDocument, created: boolean) => void;
}) {
  const [form, setForm] = useState({
    purpose: doc?.purpose ?? defaultPurpose ?? '',
    name: doc?.name ?? '',
    description: doc?.description ?? '',
    formats: new Set<string>(doc?.formats ?? ['pdf', 'jpg', 'jpeg', 'png']),
    category_key: doc?.category_key ?? '',
    required: doc?.required ?? true,
    per_applicant: doc?.per_applicant ?? false,
    active: doc?.active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm({ ...form, [key]: value });
    if (errors[key as string]) setErrors({ ...errors, [key]: '' });
  };
  const toggleFormat = (key: string, on: boolean) => {
    const next = new Set(form.formats);
    if (on) next.add(key); else next.delete(key);
    set('formats', next);
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.purpose) e.purpose = 'Choose the purpose this document is for.';
    if (form.name.trim().length < 2) e.name = 'Name the document — at least 2 characters.';
    else if (form.name.trim().length > 120) e.name = 'Keep the name under 120 characters; put the detail in the description.';
    if (form.description.length > 1000) e.description = 'The description can be at most 1,000 characters.';
    if (!form.formats.size) e.formats = 'Tick at least one format — a document that accepts none cannot be sent.';
    return e;
  };

  const save = async () => {
    const local = validate();
    setErrors(local);
    if (Object.values(local).some(Boolean)) return;
    setBusy(true);
    const body = {
      purpose: form.purpose, name: form.name.trim(), description: form.description.trim(),
      formats: [...form.formats], category_key: form.category_key || null,
      required: form.required, per_applicant: form.per_applicant, active: form.active,
    };
    try {
      const { document } = doc
        ? await patch<{ document: RequiredDocument }>(`/required-documents/${doc.id}`, body)
        : await post<{ document: RequiredDocument }>('/required-documents', body);
      onSaved(document, !doc);
    } catch (err) {
      setErrors(fieldErrors(err, 'Could not save that.'));
      setBusy(false);
    }
  };

  const purposeOptions: SelectOption[] = meta.purposes.map((p) => ({ value: p.key, label: p.label }));
  const categoryOptions: SelectOption[] = [
    { value: '', label: 'No category' },
    ...meta.categories.map((c) => ({ value: c.key, label: c.label, hint: c.group_key ?? undefined })),
  ];
  const chosen = meta.formats.filter((f) => form.formats.has(f.key)).map((f) => f.label);
  const formatsSentence = chosen.length <= 1 ? chosen[0] ?? '—'
    : `${chosen.slice(0, -1).join(', ')} or ${chosen[chosen.length - 1]}`;

  return (
    <Modal title={doc ? `Edit “${doc.name}”` : 'Add a required document'} onClose={onClose} wide footer={
      <>
        {errors._ && <span class="text-sm" style={{ color: 'var(--danger-text)', marginRight: 'auto' }}>{errors._}</span>}
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : doc ? 'Save changes' : 'Add document'}
        </button>
      </>
    }>
      <div class="grid-2">
        <Field label="Purpose *" error={errors.purpose}
               hint="Which applications ask for it. Add it again under another purpose if more than one needs it.">
          <SearchSelect value={form.purpose} options={purposeOptions} ariaLabel="Purpose"
                        placeholder="Choose a purpose…" invalid={!!errors.purpose}
                        onChange={(v) => set('purpose', v)} />
        </Field>
        <Field label="Category" error={errors.category_key} hint="Where an upload of it is filed.">
          <SearchSelect value={form.category_key} options={categoryOptions} ariaLabel="Category"
                        searchPlaceholder="Search categories…" onChange={(v) => set('category_key', v)} />
        </Field>
      </div>

      <Field label="Document name *" error={errors.name} hint="Short, the way a client would say it.">
        <input value={form.name} maxLength={120} placeholder="Two most recent pay stubs" autofocus
               aria-invalid={!!errors.name}
               onInput={(e) => set('name', (e.target as HTMLInputElement).value)} />
      </Field>

      <Field label="Description" error={errors.description}
             hint={`What counts, how recent, from whom. The client reads this. ${form.description.length}/1000`}>
        <textarea rows={3} value={form.description} maxLength={1000}
                  placeholder="Showing your name, your employer and year-to-date earnings."
                  onInput={(e) => set('description', (e.target as HTMLTextAreaElement).value)} />
      </Field>

      <Field label="Accepted formats *" error={errors.formats}>
        <div class="format-groups">
          {FORMAT_GROUPS.map(([group, keys]) => (
            <div key={group}>
              <div class="format-group-label">{group}</div>
              <div class="format-options">
                {meta.formats.filter((f) => keys.includes(f.key)).map((f) => (
                  <label key={f.key} class="format-option" title={f.extensions.join(', ')}>
                    <input type="checkbox" checked={form.formats.has(f.key)}
                           onChange={(e) => toggleFormat(f.key, (e.target as HTMLInputElement).checked)} />
                    {f.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div class="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span class="text-sm text-muted">Quick:</span>
            <button type="button" class="chip" onClick={() => set('formats', new Set(['pdf']))}>PDF only</button>
            <button type="button" class="chip" onClick={() => set('formats', new Set(['pdf', 'jpg', 'jpeg', 'png']))}>PDF & photos</button>
            <button type="button" class="chip" onClick={() => set('formats', new Set(['pdf', 'jpg', 'jpeg', 'png', 'heic']))}>PDF & all photos incl. iPhone</button>
          </div>
        </div>
      </Field>

      <div class="choice-row" style={{ marginBottom: 13 }}>
        <div>
          <label>Is it required?</label>
          <SearchSelect value={form.required ? 'yes' : 'no'} ariaLabel="Is it required?"
                        options={[{ value: 'yes', label: 'Required', hint: 'Every client with this purpose' },
                                  { value: 'no', label: 'If applicable', hint: 'e.g. a gift letter' }]}
                        onChange={(v) => set('required', v === 'yes')} />
        </div>
        <div>
          <label>Asked of</label>
          <SearchSelect value={form.per_applicant ? 'yes' : 'no'} ariaLabel="Asked of"
                        options={[{ value: 'no', label: 'Once per application', hint: 'e.g. the purchase agreement' },
                                  { value: 'yes', label: 'Each applicant', hint: 'e.g. pay stubs' }]}
                        onChange={(v) => set('per_applicant', v === 'yes')} />
        </div>
      </div>

      <div class="row" style={{ gap: 10, marginBottom: 14 }}>
        <Switch checked={form.active} label="Active" onChange={(v) => set('active', v)} />
        <span class="text-sm">
          <strong>{form.active ? 'Active' : 'Inactive'}</strong>
          <span class="text-muted"> — {form.active ? 'asked for on new applications.' : 'kept, but not asked for.'}</span>
        </span>
      </div>

      <div class="client-preview" aria-label="What the client sees">
        <div class="text-sm text-muted" style={{ marginBottom: 6 }}>What the client sees</div>
        <div class="cp-name">
          {form.name.trim() || 'Document name'}
          {' '}{form.required ? <Badge tone="info">Required</Badge> : <Badge>If it applies to you</Badge>}
        </div>
        {form.description.trim() && <div class="text-sm" style={{ marginTop: 3 }}>{form.description.trim()}</div>}
        <div class="text-sm text-muted" style={{ marginTop: 6 }}>
          Upload a {formatsSentence} file{form.per_applicant ? ' — one for each applicant' : ''}.
        </div>
      </div>
    </Modal>
  );
}
