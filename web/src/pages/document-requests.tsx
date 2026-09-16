/**
 * Asking a client for documents, from their file.
 *
 * One panel, used on the Application tab (under the Documents section) and on
 * the Documents tab, so the two cannot drift apart. What can be asked for is
 * the Required Documents checklist the admin keeps for the file's purpose; a
 * broker ticks the ones this client still owes and sends one link for all of
 * them. Where the brokerage has no checklist for the purpose yet, the filing
 * categories stand in, so the panel is never a dead end.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ApiError, formatDate, post, relativeTime } from '../lib/api.ts';
import { toast, useAsync, type Session } from '../lib/store.ts';
import { Badge, ErrorNote, Field, SearchSelect, Skeleton } from '../components/ui.tsx';

type ChecklistEntry = {
  id: string; name: string; description: string | null; required: boolean;
  per_applicant: boolean; formats_label: string;
};

type Choice = {
  key: string; label: string; hint?: string; required?: boolean;
  perBorrower?: boolean; formats?: string; fromChecklist: boolean;
};

type RequestRow = {
  id: string; status: string; created_at: string; expires_at: string | null;
  requested_by_name: string | null; open_count: number | null;
  items: Array<{ id: string; label: string; status: string; required: boolean; received_at: string | null }>;
};

export function DocumentRequestPanel({ applicationId, session, onSent }: {
  applicationId: string; session: Session; onSent?: () => void;
}) {
  const requests = useAsync<{ requests: RequestRow[] }>(
    `/applications/${applicationId}/document-requests`, [applicationId]);
  const canRequest = session.permissions.includes('document.request');

  return (
    <div class="stack">
      {canRequest
        ? <DocumentRequestPicker applicationId={applicationId}
                                 onSent={() => { requests.reload(); onSent?.(); }} />
        : (
          <div class="alert alert-info">
            Asking the client for documents needs the “Request documents” permission.
          </div>
        )}
      <RequestHistory state={requests} canCancel={canRequest} />
    </div>
  );
}

function DocumentRequestPicker({ applicationId, onSent }: {
  applicationId: string; onSent: () => void;
}) {
  const checklist = useAsync<{
    purpose: { key: string; label: string } | null; documents: ChecklistEntry[];
  }>(`/required-documents/checklist?application=${applicationId}`, [applicationId]);
  const config = useAsync<{ document_categories?: Array<{ key: string; label: string }> }>('/config');

  const [chosen, setChosen] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('email');
  const [message, setMessage] = useState('');
  const [expires, setExpires] = useState('21');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const fromChecklist = checklist.status === 'ready' ? checklist.data.documents : [];
  const usingChecklist = fromChecklist.length > 0;
  const choices: Choice[] = useMemo(() => usingChecklist
    ? fromChecklist.map((d) => ({
        key: d.id, label: d.name, hint: d.description ?? undefined, required: d.required,
        perBorrower: d.per_applicant, formats: d.formats_label, fromChecklist: true,
      }))
    : (config.status === 'ready' ? config.data.document_categories ?? [] : [])
        .map((c) => ({ key: c.key, label: c.label, fromChecklist: false })),
  [usingChecklist, fromChecklist, config.status]);

  // Nothing is pre-ticked: the broker picks what this client still owes.
  useEffect(() => { setChosen([]); }, [applicationId]);

  if (checklist.status === 'loading') return <div class="card"><Skeleton rows={4} /></div>;
  if (checklist.status === 'error') {
    return <ErrorNote error={checklist.error} code={checklist.code} permission={checklist.permission}
                      onRetry={checklist.reload} />;
  }

  const needle = search.trim().toLowerCase();
  const visible = needle
    ? choices.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(needle))
    : choices;
  const toggle = (key: string, on: boolean) =>
    setChosen(on ? [...chosen, key] : chosen.filter((k) => k !== key));

  const send = async () => {
    setBusy(true); setError('');
    try {
      const result = await post<{ sent: boolean; reason: string | null; items: number }>(
        `/applications/${applicationId}/document-requests`, {
          items: chosen.map((key) => {
            const c = choices.find((x) => x.key === key)!;
            return c.fromChecklist
              ? { required_document_id: c.key }
              : { category_key: c.key, label: c.label };
          }),
          channel, message: message.trim() || undefined, expires_in_days: Number(expires),
        });
      toast(result.sent
        ? `Sent. The client has a link for ${result.items} document${result.items === 1 ? '' : 's'}.`
        : `Request saved, but not delivered — ${result.reason ?? 'the send was refused'}`,
        result.sent ? 'ok' : 'error');
      setChosen([]); setMessage('');
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send that.');
    } finally {
      setBusy(false);
    }
  };

  const purposeLabel = checklist.data.purpose?.label;

  return (
    <div class="card">
      <div class="card-head">
        <div>
          <h2>Request documents</h2>
          <p class="text-sm text-muted mb-0">
            {usingChecklist
              ? `From the Required Documents checklist for ${purposeLabel ?? 'this purpose'}. Tick what this client still needs to send.`
              : purposeLabel
                ? `There is no Required Documents checklist for ${purposeLabel} yet — these are the filing categories.`
                : 'This file has no purpose set, so there is no checklist — these are the filing categories.'}
          </p>
        </div>
        <span class="text-sm text-muted num">{chosen.length} of {choices.length} selected</span>
      </div>

      <div class="card-body">
        {error && <div class="alert alert-error">{error}</div>}

        <div class="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          {choices.length > 6 && (
            <input type="search" placeholder="Search documents…" value={search}
                   style={{ flex: '1 1 200px', maxWidth: 320 }} aria-label="Search documents"
                   onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
          )}
          <button class="btn btn-sm" type="button"
                  onClick={() => setChosen([...new Set([...chosen, ...visible.map((c) => c.key)])])}>
            Select all
          </button>
          {usingChecklist && (
            <button class="btn btn-sm" type="button"
                    onClick={() => setChosen([...new Set([...chosen,
                      ...visible.filter((c) => c.required).map((c) => c.key)])])}>
              Select required
            </button>
          )}
          <button class="btn btn-sm btn-ghost" type="button" disabled={!chosen.length}
                  onClick={() => setChosen([])}>Clear</button>
        </div>

        {choices.length === 0 ? (
          <p class="text-sm text-muted">Nothing to choose from. Add documents under Required documents.</p>
        ) : (
          <div class="permission-pick permission-list" style={{ maxHeight: 340 }}>
            {visible.map((c) => (
              <label key={c.key} class="check">
                <input type="checkbox" checked={chosen.includes(c.key)}
                       onChange={(e) => toggle(c.key, (e.target as HTMLInputElement).checked)} />
                <span class="text-sm" style={{ minWidth: 0 }}>
                  <strong style={{ fontWeight: 560 }}>{c.label}</strong>
                  {c.fromChecklist && (
                    <span class="row" style={{ gap: 4, display: 'inline-flex', marginLeft: 6, flexWrap: 'wrap' }}>
                      {c.required ? <Badge tone="warn">Required</Badge> : <Badge>Optional</Badge>}
                      {c.perBorrower && <Badge tone="info">One per borrower</Badge>}
                    </span>
                  )}
                  {c.hint && <div class="text-muted">{c.hint}</div>}
                  {c.formats && <div class="text-muted">Accepts {c.formats}</div>}
                </span>
              </label>
            ))}
            {!visible.length && <p class="text-sm text-muted">Nothing matches “{search}”.</p>}
          </div>
        )}

        <div class="grid-2" style={{ marginTop: 12 }}>
          <Field label="Send by">
            <SearchSelect value={channel} onChange={setChannel} ariaLabel="Send by"
                          options={[{ value: 'email', label: 'Email' }, { value: 'sms', label: 'Text' },
                                    { value: 'both', label: 'Email and text' }]} />
          </Field>
          <Field label="Link lasts (days)">
            <input type="number" min={1} max={90} value={expires}
                   onInput={(e) => setExpires((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <Field label="Message (optional)" hint="Appears above the list in the email or text.">
          <textarea rows={2} value={message}
                    onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)} />
        </Field>

        <div class="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button class="btn btn-primary" disabled={busy || !chosen.length} onClick={send}>
            {busy ? 'Sending…'
              : chosen.length ? `Send request for ${chosen.length} document${chosen.length === 1 ? '' : 's'}`
              : 'Select documents to request'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RequestHistory({ state, canCancel }: {
  state: ReturnType<typeof useAsync<{ requests: RequestRow[] }>>; canCancel: boolean;
}) {
  if (state.status !== 'ready' || !state.data.requests.length) return null;

  const cancel = async (id: string) => {
    if (!confirm('Cancel this request? The client’s link stops working.')) return;
    try {
      await post(`/document-requests/${id}/cancel`);
      toast('Request cancelled.', 'ok');
      state.reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not cancel that.', 'error');
    }
  };

  return (
    <div class="card">
      <div class="card-head"><h2>Requested</h2></div>
      <div class="card-body-flush">
        {state.data.requests.map((r) => {
          const received = r.items.filter((i) => i.received_at || i.status !== 'outstanding').length;
          const open = r.status === 'open' || r.status === 'partial';
          return (
            <div key={r.id} class="list-row">
              <div style={{ minWidth: 0 }}>
                <strong>{r.items.map((i) => i.label).join(', ') || 'No items'}</strong>
                <div class="text-sm text-muted">
                  Sent {relativeTime(r.created_at)}{r.requested_by_name ? ` by ${r.requested_by_name}` : ''}
                  {' · '}{received} of {r.items.length} received
                  {r.open_count ? ` · opened ${r.open_count}×` : ' · not opened yet'}
                  {r.expires_at ? ` · link expires ${formatDate(r.expires_at)}` : ''}
                </div>
              </div>
              <div class="row" style={{ gap: 6 }}>
                <Badge tone={r.status === 'completed' ? 'ok' : r.status === 'cancelled' || r.status === 'expired' ? 'neutral' : 'warn'}>
                  {r.status}
                </Badge>
                {canCancel && open && (
                  <button class="btn btn-ghost btn-sm" onClick={() => cancel(r.id)}>Cancel</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
