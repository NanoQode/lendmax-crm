/**
 * The customer record, from their file: correcting contact details, archiving
 * the file, and merging a duplicate into it.
 *
 * The file's answers are the Application tab. These are the facts every
 * message, reminder and inbound text is matched against, which is why a wrong
 * email here matters more than a wrong answer there.
 */
import { useEffect, useState } from 'preact/hooks';
import { ApiError, fieldErrors, get, patch, post } from '../lib/api.ts';
import { toast, useAsync } from '../lib/store.ts';
import { Badge, Field, Modal, SearchSelect } from '../components/ui.tsx';

export type CustomerRecord = {
  id: string; first_name: string | null; last_name: string | null; email: string | null;
  phone_e164: string | null; phone_raw: string | null; preferred_language: string | null;
  address_line1: string | null; address_line2: string | null; city: string | null;
  province: string | null; postal_code: string | null;
  lead_source: string | null; referral_source: string | null; tags: string[];
  merged_into_id: string | null;
};

type Duplicate = {
  id: string; first_name: string | null; last_name: string | null; email: string | null;
  phone_e164: string | null; matched_on?: string[]; files: number;
};

export type RecordPayload = {
  customer: CustomerRecord;
  files: Array<{ id: string; portal_reference: string | null; stage_label: string | null; archived_at: string | null }>;
  duplicates: Duplicate[];
};

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

const nameOf = (c: { first_name: string | null; last_name: string | null }) =>
  `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Unnamed';

export const useCustomerRecord = (customerId: string) =>
  useAsync<RecordPayload>(`/customers/${customerId}`, [customerId]);

// ── Edit contact ───────────────────────────────────────────────────────────

export function EditContact({ customer, onClose, onSaved }: {
  customer: CustomerRecord; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    first_name: customer.first_name ?? '', last_name: customer.last_name ?? '',
    email: customer.email ?? '', phone: customer.phone_raw ?? customer.phone_e164 ?? '',
    preferred_language: customer.preferred_language ?? '',
    address_line1: customer.address_line1 ?? '', address_line2: customer.address_line2 ?? '',
    city: customer.city ?? '', province: customer.province ?? '', postal_code: customer.postal_code ?? '',
    lead_source: customer.lead_source ?? '', referral_source: customer.referral_source ?? '',
    tags: (customer.tags ?? []).join(', '),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: Event) =>
    setForm((f) => ({ ...f, [k]: (e.target as HTMLInputElement).value }));

  const submit = async (e?: Event) => {
    e?.preventDefault();
    setBusy(true); setErrors({});
    try {
      const { tags, ...rest } = form;
      const result = await patch<{ changed: string[]; possible_duplicates: Duplicate[] }>(
        `/customers/${customer.id}`,
        { ...rest, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) });
      toast(!result.changed.length ? 'Nothing had changed.'
        : result.possible_duplicates.length
          ? `Saved. ${result.possible_duplicates.length} other record(s) share this email or phone — see Merge.`
          : 'Contact details saved.',
        result.possible_duplicates.length ? 'info' : 'ok');
      onSaved();
    } catch (err) {
      setErrors(fieldErrors(err, 'Could not save those details.'));
      setBusy(false);
    }
  };

  return (
    <Modal title="Edit contact details" onClose={onClose} wide footer={<>
      <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button class="btn btn-primary" onClick={() => submit()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </>}>
      <form onSubmit={submit}>
        {errors._ && <div class="alert alert-error">{errors._}</div>}
        <p class="text-sm text-muted">
          Messages, reminders and inbound texts are matched on these details. A later update from
          the portal fills blanks only; it does not overwrite what you change here.
        </p>
        <div class="grid-2">
          <Field label="First name" error={errors.first_name}>
            <input value={form.first_name} onInput={set('first_name')} autofocus />
          </Field>
          <Field label="Last name" error={errors.last_name}>
            <input value={form.last_name} onInput={set('last_name')} />
          </Field>
          <Field label="Email" error={errors.email}>
            <input type="email" value={form.email} onInput={set('email')} />
          </Field>
          <Field label="Phone" error={errors.phone} hint="Any format; it is normalised.">
            <input type="tel" value={form.phone} onInput={set('phone')} placeholder="(416) 555-0142" />
          </Field>
          <Field label="Street address" error={errors.address_line1}>
            <input value={form.address_line1} onInput={set('address_line1')} />
          </Field>
          <Field label="Unit / line 2" error={errors.address_line2}>
            <input value={form.address_line2} onInput={set('address_line2')} />
          </Field>
          <Field label="City" error={errors.city}>
            <input value={form.city} onInput={set('city')} />
          </Field>
          <div class="grid-2">
            <Field label="Province" error={errors.province}>
              <SearchSelect value={form.province} ariaLabel="Province"
                            onChange={(v) => setForm((f) => ({ ...f, province: v }))}
                            options={[{ value: '', label: '—' }, ...PROVINCES.map((p) => ({ value: p, label: p }))]} />
            </Field>
            <Field label="Postal code" error={errors.postal_code}>
              <input value={form.postal_code} onInput={set('postal_code')} placeholder="M5V 2T6" />
            </Field>
          </div>
          <Field label="Preferred language" error={errors.preferred_language}>
            <SearchSelect value={form.preferred_language} ariaLabel="Preferred language"
                          onChange={(v) => setForm((f) => ({ ...f, preferred_language: v }))}
                          options={[{ value: '', label: 'Not set' }, { value: 'en', label: 'English' },
                                    { value: 'fr', label: 'French' }, { value: 'pa', label: 'Punjabi' },
                                    { value: 'hi', label: 'Hindi' }, { value: 'zh', label: 'Chinese' },
                                    { value: 'ur', label: 'Urdu' }, { value: 'es', label: 'Spanish' }]} />
          </Field>
          <Field label="Lead source" error={errors.lead_source}>
            <input value={form.lead_source} onInput={set('lead_source')} />
          </Field>
          <Field label="Referred by" error={errors.referral_source}>
            <input value={form.referral_source} onInput={set('referral_source')} />
          </Field>
          <Field label="Tags" error={errors.tags} hint="Separate with commas.">
            <input value={form.tags} onInput={set('tags')} placeholder="vip, realtor-referral" />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

// ── Merge ──────────────────────────────────────────────────────────────────

export function MergeCustomer({ customer, duplicates, onClose, onMerged }: {
  customer: CustomerRecord; duplicates: Duplicate[]; onClose: () => void; onMerged: () => void;
}) {
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Duplicate[]>([]);
  const [picked, setPicked] = useState<string>(duplicates[0]?.id ?? '');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (search.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => {
      get<{ customers: Duplicate[] }>(
        `/customers/search?q=${encodeURIComponent(search)}&exclude=${customer.id}`)
        .then((d) => setFound(d.customers)).catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search, customer.id]);

  const candidates = [...duplicates, ...found.filter((f) => !duplicates.some((d) => d.id === f.id))];
  const other = candidates.find((c) => c.id === picked) ?? null;

  const merge = async () => {
    setBusy(true); setError('');
    try {
      await post(`/customers/${customer.id}/merge`, { merge_id: picked });
      toast(`${nameOf(other!)} merged into ${nameOf(customer)}.`, 'ok');
      onMerged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not merge those records.');
      setBusy(false);
    }
  };

  const dismiss = async (id: string) => {
    try {
      await post(`/customers/${customer.id}/duplicates/${id}/dismiss`);
      toast('Marked as different people.', 'ok');
      onMerged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save that.', 'error');
    }
  };

  return (
    <Modal title={`Merge a duplicate into ${nameOf(customer)}`} onClose={onClose} wide footer={<>
      <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
      {confirming
        ? <button class="btn btn-danger" onClick={merge} disabled={busy || !other}>
            {busy ? 'Merging…' : `Yes, merge ${other ? nameOf(other) : ''}`}
          </button>
        : <button class="btn btn-primary" onClick={() => setConfirming(true)} disabled={!other}>Merge…</button>}
    </>}>
      {error && <div class="alert alert-error">{error}</div>}
      <p class="text-sm text-muted">
        The record you pick is folded into this one: its files, messages, documents, tasks,
        appointments and unsubscribes move here, and any blank contact details here are filled from it.
        It is kept, marked as merged, so nothing that referred to it breaks. This cannot be undone
        from the screen.
      </p>

      {duplicates.length > 0 && <h3 class="app-group-title">Looks like the same person</h3>}
      <div class="card-body-flush">
        {duplicates.map((d) => (
          <DuplicateRow key={d.id} d={d} checked={picked === d.id}
                        onPick={() => { setPicked(d.id); setConfirming(false); }}
                        onDismiss={() => dismiss(d.id)} />
        ))}
      </div>

      <Field label="Or find another record" hint="Name, email or phone.">
        <input type="search" value={search} placeholder="Search customers…"
               onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
      </Field>
      {found.filter((f) => !duplicates.some((d) => d.id === f.id)).map((d) => (
        <DuplicateRow key={d.id} d={d} checked={picked === d.id}
                      onPick={() => { setPicked(d.id); setConfirming(false); }} />
      ))}
      {search.trim().length >= 2 && !found.length && <p class="text-sm text-muted">No other records match.</p>}

      {confirming && other && (
        <div class="alert alert-warn" style={{ marginTop: 12 }}>
          {nameOf(other)} ({other.email ?? other.phone_e164 ?? 'no contact'}, {other.files} file{other.files === 1 ? '' : 's'})
          will be merged into {nameOf(customer)} ({customer.email ?? customer.phone_e164 ?? 'no contact'}).
        </div>
      )}
    </Modal>
  );
}

function DuplicateRow({ d, checked, onPick, onDismiss }: {
  d: Duplicate; checked: boolean; onPick: () => void; onDismiss?: () => void;
}) {
  return (
    <label class="list-row" style={{ cursor: 'pointer', gap: 10 }}>
      <input type="radio" name="merge-pick" checked={checked} onChange={onPick} style={{ width: 16 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <strong>{nameOf(d)}</strong>
        <div class="text-sm text-muted">
          {[d.email, d.phone_e164].filter(Boolean).join(' · ') || 'No contact details'}
          {' · '}{d.files} file{d.files === 1 ? '' : 's'}
        </div>
      </div>
      {d.matched_on?.map((m) => <Badge key={m} tone="warn">same {m}</Badge>)}
      {onDismiss && (
        <button class="btn btn-ghost btn-sm" type="button"
                onClick={(e) => { e.preventDefault(); onDismiss(); }}>Not a duplicate</button>
      )}
    </label>
  );
}

// ── Archive / restore ──────────────────────────────────────────────────────

export function ArchiveFile({ applicationId, archived, clientName, onClose, onDone }: {
  applicationId: string; archived: boolean; clientName: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true); setError('');
    try {
      await post(`/applications/${applicationId}/${archived ? 'restore' : 'archive'}`,
        { reason: reason.trim() || undefined });
      toast(archived ? 'File restored.' : 'File archived.', 'ok');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not do that.');
      setBusy(false);
    }
  };

  return (
    <Modal title={archived ? 'Restore this file' : 'Archive this file'} onClose={onClose} footer={<>
      <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button class={`btn ${archived ? 'btn-primary' : 'btn-danger'}`} onClick={run} disabled={busy}>
        {busy ? 'Working…' : archived ? 'Restore' : 'Archive'}
      </button>
    </>}>
      {error && <div class="alert alert-error">{error}</div>}
      <p class="text-sm">
        {archived
          ? `${clientName}'s file goes back on the customer list and the board.`
          : `${clientName}'s file comes off the customer list and the board, and its application answers can no longer be edited. Nothing is deleted — messages, documents and the audit trail stay, and it can be restored from Customers → Show archived.`}
      </p>
      <Field label="Reason (optional)" hint="Kept in the activity log.">
        <input value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)}
               placeholder={archived ? 'Client came back' : 'Test file, went elsewhere, duplicate…'} />
      </Field>
    </Modal>
  );
}
