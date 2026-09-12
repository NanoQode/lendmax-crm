/**
 * The client workspace.
 *
 * The test this screen is built to pass: within seconds of opening a file a
 * person can answer who the client is, what they want, how much, when they
 * close, how long is left, who owns it, what is missing, and what happens next
 * — without opening a tab. So the header carries the facts and the tabs carry
 * the detail, never the other way round.
 */
import { useState } from 'preact/hooks';
import { ApiError, formatDate, money, post, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, type Config, type Session } from '../lib/store.ts';
import {
  Avatar, Badge, Empty, ErrorNote, Field, Icon, ICONS, Modal, Skeleton, Urgency,
} from '../components/ui.tsx';
import { ClientAutomations } from './automations.tsx';
import { ComplianceTab } from './compliance.tsx';
import { CommunicationTab } from './messages.tsx';
import { FundingTab } from './funding.tsx';

type Workspace = {
  application: Record<string, any>;
  days_to_close: { days: number | null; urgency: string; label: string };
  applicants: Array<Record<string, any>>;
  assignments: Array<{ role: string; is_primary: boolean; user_id: string; name: string; email: string }>;
  conditions: Array<{ id: string; label: string; detail: string | null; due_on: string | null; status: string }>;
  compliance: { id: string; status: string; approved_at: string | null; legal_hold: boolean;
                outstanding_required: number } | null;
  documents: Array<Record<string, any>>;
  financials: {
    employments: Array<Record<string, any>>; incomes: Array<Record<string, any>>;
    assets: Array<Record<string, any>>; liabilities: Array<Record<string, any>>;
    properties: Array<Record<string, any>>;
  } | null;
  financials_hidden_reason: string | null;
};

const TABS = [
  { key: 'application', label: 'Application' },
  { key: 'compliance', label: 'Compliance' },
  { key: 'communication', label: 'Communication' },
  { key: 'documents', label: 'Documents' },
  { key: 'funding', label: 'Funding' },
  { key: 'notes', label: 'Notes & Tasks' },
  { key: 'automations', label: 'Automations' },
  { key: 'log', label: 'Log' },
];

export function ClientPage({ id, session, config }: {
  id: string; session: Session; config: Config | null;
}) {
  const [tab, setTab] = useState('application');
  const [movingStage, setMovingStage] = useState(false);
  const state = useAsync<Workspace>(`/applications/${id}`);

  if (state.status === 'loading') {
    return <div><Skeleton rows={3} height={70} /><Skeleton rows={5} /></div>;
  }
  if (state.status === 'error') {
    return (
      <div class="content-narrow">
        <ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} />
        <button class="btn" onClick={() => navigate('/customers')}>
          <Icon path={ICONS.back} /> Back to customers
        </button>
      </div>
    );
  }

  const { application: app, assignments, compliance, conditions } = state.data;
  const name = `${app.first_name ?? ''} ${app.last_name ?? ''}`.trim() || 'Unnamed client';
  const property = [
    [app.property_street_number, app.property_street_name].filter(Boolean).join(' '),
    app.property_city, app.property_province,
  ].filter(Boolean).join(', ');
  const type = config?.transaction_types.find((t) => t.key === app.transaction_type_key)?.label
    ?? app.transaction_type_key ?? 'Type not set';
  const outstandingConditions = conditions.filter((c) => c.status === 'outstanding').length;
  const primary = (role: string) => assignments.find((a) => a.role === role && a.is_primary);

  return (
    <div style={{ margin: '-20px -20px 0' }}>
      <header class="client-head">
        <button class="btn btn-ghost btn-sm" style={{ marginBottom: 9 }}
                onClick={() => navigate('/customers')}>
          <Icon path={ICONS.back} size={14} /> Customers
        </button>

        <div class="client-title">
          <h1>{name}</h1>
          <span class="badge badge-accent">{app.stage_label ?? 'No stage'}</span>
          {compliance?.legal_hold && <Badge tone="danger">Legal hold</Badge>}
          {app.awaiting_reply_since && <Badge tone="danger">Awaiting our reply</Badge>}
        </div>
        <div class="client-sub">
          {type} · {money(app.amount_requested)} mortgage{property ? ` · ${property}` : ''}
          {app.portal_reference ? ` · ${app.portal_reference}` : ''}
        </div>

        <div class="client-facts">
          <Fact label="Closing">
            <Urgency value={state.data.days_to_close} />
          </Fact>
          <Fact label="Application">
            {app.percent_complete}% complete
          </Fact>
          <Fact label="Broker">{primary('broker')?.name ?? '—'}</Fact>
          <Fact label="Underwriter">{primary('underwriter')?.name ?? '—'}</Fact>
          <Fact label="Scarlett">
            {app.scarlett_deal_id
              ? <span class="row" style={{ gap: 6 }}>
                  <span>{app.scarlett_deal_id}</span>
                  {app.scarlett_sync_state === 'error' && <Badge tone="danger">Sync failed</Badge>}
                </span>
              : 'Not submitted'}
          </Fact>
          <Fact label="Documents">
            {app.documents_outstanding > 0
              ? <span style={{ color: 'var(--warn-text)' }}>{app.documents_outstanding} outstanding</span>
              : 'None outstanding'}
          </Fact>
          <Fact label="Conditions">
            {outstandingConditions > 0
              ? <span style={{ color: 'var(--warn-text)' }}>{outstandingConditions} outstanding</span>
              : conditions.length ? 'All satisfied' : '—'}
          </Fact>
          <Fact label="Compliance">
            {compliance
              ? complianceLabel(compliance)
              : 'Not started'}
          </Fact>
          <Fact label="Last contact">{relativeTime(app.last_contacted_at)}</Fact>
        </div>

        <div class="client-actions">
          {/* Email and Text open the CRM's own composer. A mailto: link opens
              the broker's mail client, which goes around the consent gate and
              records nothing on the file — both of which matter more than the
              one click it saves. A phone call is not an electronic message, so
              Call stays a tel: link. */}
          <button class="btn" disabled={!app.email}
                  onClick={() => setTab('communication')}>Email</button>
          <button class="btn" disabled={!app.phone_e164}
                  onClick={() => setTab('communication')}>Text</button>
          <a class="btn" href={app.phone_e164 ? `tel:${app.phone_e164}` : undefined}
             aria-disabled={!app.phone_e164}>Call</a>
          {session.permissions.includes('pipeline.move') && (
            <button class="btn btn-primary" onClick={() => setMovingStage(true)}>Move stage</button>
          )}
        </div>
      </header>

      <div class="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} class="tab" role="tab" aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding: 20 }}>
        {tab === 'application' && <ApplicationTab data={state.data} />}
        {tab === 'notes' && <NotesTab id={id} session={session} />}
        {tab === 'log' && <LogTab id={id} />}
        {tab === 'documents' && <DocumentsTab data={state.data} id={id} session={session} />}
        {tab === 'compliance' && <ComplianceTab applicationId={id} session={session} />}
        {tab === 'funding' && <FundingTab applicationId={id} session={session} config={config} />}
        {tab === 'automations' && (
          <ClientAutomations customerId={String(app.customer_id)} session={session} />
        )}
        {tab === 'communication' && (
          <CommunicationTab customerId={String(app.customer_id)} applicationId={id}
                            session={session} />
        )}
      </div>

      {movingStage && (
        <MoveStage id={id} current={app.stage_key} config={config}
                   onClose={() => setMovingStage(false)}
                   onMoved={() => { setMovingStage(false); state.reload(); }} />
      )}
    </div>
  );
}

const complianceLabel = (c: { status: string; outstanding_required: number }) => {
  if (c.status === 'approved') return <Badge tone="ok">Approved</Badge>;
  if (c.outstanding_required > 0) {
    return <span style={{ color: 'var(--warn-text)' }}>{c.outstanding_required} outstanding</span>;
  }
  return <Badge tone="info">{c.status.replace(/_/g, ' ')}</Badge>;
};

const Fact = ({ label, children }: { label: string; children: any }) => (
  <div class="fact">
    <div class="label">{label}</div>
    <div class="value">{children}</div>
  </div>
);

function ApplicationTab({ data }: { data: Workspace }) {
  const { application: app, applicants, financials, financials_hidden_reason } = data;
  return (
    <div class="stack">
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Mortgage request</h2></div>
          <div class="card-body">
            <DL rows={[
              ['Amount requested', money(app.amount_requested)],
              ['Purpose', app.purpose ?? '—'],
              ['Timing', app.timing ?? '—'],
              ['Closing date', formatDate(app.closing_date)],
              ['Existing lender', app.existing_lender ?? '—'],
              ['Maturity date', app.maturity_date
                ? `${formatDate(app.maturity_date)} (${app.maturity_source ?? 'unknown source'})`
                : '—'],
            ]} />
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Subject property</h2></div>
          <div class="card-body">
            <DL rows={[
              ['Address', [[app.property_street_number, app.property_street_name].filter(Boolean).join(' '),
                           app.property_city, app.property_province, app.property_postal_code]
                           .filter(Boolean).join(', ') || '—'],
              ['Type', app.property_type ?? '—'],
              ['Occupancy', app.property_occupancy ?? '—'],
              ['Purchase price', money(app.purchase_price)],
              ['Estimated value', money(app.property_value)],
              ['Down payment', money(app.down_payment)],
              ['Existing balance', money(app.existing_balance)],
              ['Annual taxes', money(app.annual_taxes)],
              ['Monthly condo fee', money(app.monthly_condo_fee)],
            ]} />
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Borrowers</h2>
          <span class="text-sm text-muted">{applicants.length}</span>
        </div>
        <div class="card-body-flush">
          {applicants.length === 0
            ? <Empty title="No borrower detail yet">
                Borrower records arrive with the application from apply.lendmax.ca.
              </Empty>
            : (
              <div class="table-wrap">
                <table class="data">
                  <thead>
                    <tr><th>Name</th><th>Role</th><th>Contact</th><th>Status</th><th>Address</th></tr>
                  </thead>
                  <tbody>
                    {applicants.map((a) => (
                      <tr key={a.id} style={{ cursor: 'default' }}>
                        <td data-primary>{`${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() || '—'}</td>
                        <td data-label="Role">{String(a.applicant_role ?? '').replace(/_/g, ' ')}</td>
                        <td data-label="Contact">{a.email ?? a.phone_e164 ?? '—'}</td>
                        <td data-label="Status">{a.residential_status ?? '—'}</td>
                        <td data-label="Address">
                          {[a.addr_city, a.addr_province].filter(Boolean).join(', ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>

      {/* Said out loud rather than rendered as an empty section, so nobody
          mistakes "you may not see this" for "there is nothing here". */}
      {financials_hidden_reason && (
        <div class="alert alert-info">{financials_hidden_reason}</div>
      )}

      {financials && (
        <div class="grid-2">
          <MiniTable title="Employment and income" empty="No employment recorded."
                     rows={financials.employments.map((e) => [
                       `${e.employer ?? 'Employer not given'}${e.job_title ? ` — ${e.job_title}` : ''}`,
                       money(e.annual_income),
                     ])} />
          <MiniTable title="Other income" empty="No other income declared."
                     rows={financials.incomes.map((i) => [
                       `${i.income_type ?? 'Income'}${i.source ? ` — ${i.source}` : ''}`,
                       `${money(i.amount)} ${i.frequency ?? ''}`.trim(),
                     ])} />
          <MiniTable title="Assets" empty="No assets declared."
                     rows={financials.assets.map((a) => [
                       `${a.asset_type ?? 'Asset'}${a.institution ? ` — ${a.institution}` : ''}`,
                       money(a.value),
                     ])} />
          <MiniTable title="Liabilities" empty="No liabilities declared."
                     rows={financials.liabilities.map((l) => [
                       `${l.liability_type ?? 'Liability'}${l.lender ? ` — ${l.lender}` : ''}${l.payoff ? ' (paying out)' : ''}`,
                       `${money(l.balance)} · ${money(l.monthly_payment)}/mo`,
                     ])} />
        </div>
      )}
    </div>
  );
}

const DL = ({ rows }: { rows: Array<[string, any]> }) => (
  <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '7px 16px' }}>
    {rows.map(([k, v]) => (
      <>
        <dt key={`${k}-k`} class="text-sm text-muted" style={{ whiteSpace: 'nowrap' }}>{k}</dt>
        <dd key={`${k}-v`} style={{ margin: 0, textAlign: 'right', fontWeight: 520 }} class="num">{v}</dd>
      </>
    ))}
  </dl>
);

const MiniTable = ({ title, rows, empty }: {
  title: string; rows: Array<[string, string]>; empty: string;
}) => (
  <div class="card">
    <div class="card-head"><h2>{title}</h2></div>
    <div class="card-body">
      {rows.length === 0
        ? <div class="text-sm text-muted">{empty}</div>
        : <DL rows={rows} />}
    </div>
  </div>
);

/**
 * Documents on one file, and asking for more.
 *
 * A request sends the client a link rather than asking them to email
 * attachments: a mortgage document in a mailbox is a mortgage document in
 * the wrong place, and the link is short-lived, single-purpose and refuses
 * anything that is not what it claims to be.
 */
function DocumentsTab({ data, id, session }: {
  data: Workspace; id: string; session: Session;
}) {
  const requests = useAsync<{ requests: Array<Record<string, any>> }>(
    `/applications/${id}/document-requests`, [id]);
  const [requesting, setRequesting] = useState(false);
  const canRequest = session.permissions.includes('document.request');

  return (
    <div class="stack">
      {canRequest && (
        <div class="row" style={{ gap: 8 }}>
          <button class="btn btn-primary" onClick={() => setRequesting(true)}>
            Ask the client for documents
          </button>
        </div>
      )}

      {requests.status === 'ready' && requests.data.requests.length > 0 && (
        <div class="card">
          <div class="card-head"><h2>Asked for</h2></div>
          <div class="card-body-flush">
            {requests.data.requests.map((r) => (
              <div key={r.id} class="list-row">
                <div style={{ minWidth: 0 }}>
                  <strong>
                    {(r.items ?? []).map((i: { label: string }) => i.label).join(', ')
                      || 'No items'}
                  </strong>
                  <div class="text-sm text-muted">
                    Sent {relativeTime(r.created_at)}
                    {r.requested_by_name ? ` by ${r.requested_by_name}` : ''}
                    {' · '}
                    {(r.items ?? []).filter((i: { received_at: string | null }) => i.received_at)
                      .length} of {(r.items ?? []).length} received
                    {r.expires_at ? ` · link expires ${formatDate(r.expires_at)}` : ''}
                  </div>
                </div>
                <Badge tone={r.status === 'completed' ? 'ok'
                  : r.status === 'cancelled' ? 'neutral' : 'warn'}>{r.status}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      <div class="card">
        <div class="card-head">
          <h2>On file</h2>
          <span class="text-sm text-muted num">{data.documents.length}</span>
        </div>
        {data.documents.length === 0 ? (
          <Empty title="Nothing yet">
            Documents uploaded through the portal appear here, as does anything the client
            sends through a request link.
          </Empty>
        ) : (
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>Document</th><th>Category</th><th>Uploaded</th><th>Review</th><th>Scan</th></tr></thead>
              <tbody>
                {data.documents.map((d) => (
                  <tr key={d.id} style={{ cursor: 'default' }}>
                    <td data-primary>{d.display_label ?? d.filename}</td>
                    <td data-label="Category">{d.category_key ?? '—'}</td>
                    <td data-label="Uploaded">{relativeTime(d.uploaded_at)}</td>
                    <td data-label="Review">
                      <Badge tone={d.review_status === 'accepted' ? 'ok'
                                 : d.review_status === 'rejected' ? 'danger' : 'warn'}>
                        {d.review_status}
                      </Badge>
                    </td>
                    <td data-label="Scan">
                      <Badge tone={d.scan_status === 'clean' ? 'ok' : d.scan_status === 'infected' ? 'danger' : 'neutral'}>
                        {d.scan_status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {requesting && (
        <RequestDocuments id={id} config={null} onClose={() => setRequesting(false)}
                          onSent={() => { setRequesting(false); requests.reload(); }} />
      )}
    </div>
  );
}

function RequestDocuments({ id, onClose, onSent }: {
  id: string; config: unknown; onClose: () => void; onSent: () => void;
}) {
  const categories = useAsync<{ document_categories: Array<{ key: string; label: string }> }>(
    '/config');
  const [chosen, setChosen] = useState<string[]>([]);
  const [channel, setChannel] = useState('email');
  const [message, setMessage] = useState('');
  const [expires, setExpires] = useState('21');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const available = categories.status === 'ready'
    ? categories.data.document_categories ?? [] : [];

  const send = async () => {
    setBusy(true); setError('');
    try {
      const result = await post<{ sent: boolean; reason?: string }>(
        `/applications/${id}/document-requests`, {
          items: chosen.map((key) => ({
            category_key: key,
            label: available.find((c) => c.key === key)?.label ?? key,
          })),
          channel, message: message || undefined,
          expires_in_days: Number(expires),
        });
      toast(result.sent === false
        ? `Request created, but not sent — ${result.reason ?? 'the send was refused'}`
        : 'Sent. The client has a link.', result.sent === false ? 'info' : 'ok');
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send that.');
      setBusy(false);
    }
  };

  return (
    <Modal title="Ask for documents" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" disabled={busy || chosen.length === 0} onClick={send}>
          {busy ? 'Sending…' : `Ask for ${chosen.length || 'nothing'}`}
        </button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <p class="text-sm text-muted">
        The client gets a link, not a request to email attachments. It expires, it accepts
        only the things asked for, and it checks that a file is what it says it is.
      </p>

      <Field label="What to ask for">
        <div class="permission-pick permission-list">
          {available.map((c) => (
            <label key={c.key} class="check">
              <input type="checkbox" checked={chosen.includes(c.key)}
                     onChange={(e) => setChosen((e.target as HTMLInputElement).checked
                       ? [...chosen, c.key]
                       : chosen.filter((k) => k !== c.key))} />
              <span class="text-sm">{c.label}</span>
            </label>
          ))}
        </div>
      </Field>

      <div class="grid-2">
        <Field label="How to send it">
          <select value={channel} onChange={(e) => setChannel((e.target as HTMLSelectElement).value)}>
            <option value="email">Email</option>
            <option value="sms">Text</option>
            <option value="both">Both</option>
          </select>
        </Field>
        <Field label="Link lasts (days)">
          <input type="number" min={1} max={90} value={expires}
                 onInput={(e) => setExpires((e.target as HTMLInputElement).value)} />
        </Field>
      </div>

      <Field label="Anything to add" hint="Appears above the list in the message.">
        <textarea rows={3} value={message}
                  onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)} />
      </Field>
    </Modal>
  );
}

function NotesTab({ id, session }: { id: string; session: Session }) {
  const state = useAsync<{ notes: Array<Record<string, any>> }>(`/applications/${id}/notes`);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const canWrite = session.permissions.includes('note.create');

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await post(`/applications/${id}/notes`, { body, note_type: 'sales', visibility: 'team' });
      setBody('');
      state.reload();
      toast('Note added', 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the note.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack">
      {canWrite && (
        <div class="card">
          <div class="card-body">
            <form onSubmit={submit}>
              <Field label="Add a note">
                <textarea rows={3} value={body}
                          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
                          placeholder="What happened on the call?" />
              </Field>
              <button class="btn btn-primary" disabled={busy || !body.trim()}>
                {busy ? 'Saving…' : 'Add note'}
              </button>
            </form>
          </div>
        </div>
      )}

      <div class="card">
        <div class="card-head"><h2>Notes</h2></div>
        <div class="card-body-flush">
          {state.status === 'loading' && <Skeleton rows={3} />}
          {state.status === 'error' && <div style={{ padding: 15 }}><ErrorNote error={state.error} code={state.code} permission={state.permission} /></div>}
          {state.status === 'ready' && state.data.notes.length === 0 && (
            <Empty title="No notes yet">Anything written here stays on the file permanently.</Empty>
          )}
          {state.status === 'ready' && state.data.notes.map((n) => (
            <div key={n.id} style={{ padding: '12px 15px', borderBottom: '1px solid var(--border)' }}>
              <div class="row" style={{ marginBottom: 4 }}>
                <Avatar name={n.author_name ?? 'System'} />
                <strong style={{ fontSize: 13 }}>{n.author_name ?? 'System'}</strong>
                <Badge>{String(n.note_type).replace(/_/g, ' ')}</Badge>
                {n.visibility !== 'team' && <Badge tone="warn">{n.visibility}</Badge>}
                <span class="spacer" />
                <span class="text-sm text-muted">{relativeTime(n.created_at)}</span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LogTab({ id }: { id: string }) {
  const state = useAsync<{ activity: Array<Record<string, any>> }>(`/applications/${id}/activity`);
  return (
    <div class="card">
      <div class="card-head"><h2>Everything that happened to this file</h2></div>
      <div class="card-body-flush">
        {state.status === 'loading' && <Skeleton rows={5} />}
        {state.status === 'error' && <div style={{ padding: 15 }}><ErrorNote error={state.error} code={state.code} permission={state.permission} /></div>}
        {state.status === 'ready' && state.data.activity.length === 0 && (
          <Empty title="Nothing recorded yet" />
        )}
        {state.status === 'ready' && state.data.activity.map((a) => (
          <div key={a.id} class="row" style={{ padding: '10px 15px', borderBottom: '1px solid var(--border)',
                                               alignItems: 'flex-start' }}>
            <Badge tone={a.kind === 'stage' ? 'accent' : 'neutral'}>{a.kind}</Badge>
            <div style={{ flex: 1 }}>
              <div>{a.summary}</div>
              <div class="text-sm text-muted">
                {a.actor_name ?? 'System'} · {relativeTime(a.at)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MoveStage({ id, current, config, onClose, onMoved }: {
  id: string; current: string | null; config: Config | null;
  onClose: () => void; onMoved: () => void;
}) {
  const [stage, setStage] = useState('');
  const [disposition, setDisposition] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState<Array<{ label: string; message: string }>>([]);
  const [error, setError] = useState('');

  const target = config?.stages.find((s) => s.key === stage);
  const isLost = target?.category === 'lost';
  const dispositionMeta = config?.lost_dispositions.find((d) => d.key === disposition);

  const submit = async () => {
    setBusy(true);
    setBlockers([]);
    setError('');
    try {
      await post(`/applications/${id}/stage`, {
        stage_key: stage,
        reason: reason || undefined,
        lost_disposition_key: isLost ? disposition : undefined,
        lost_reason_note: isLost ? note : undefined,
      });
      toast(`Moved to ${target?.label}`, 'ok');
      onMoved();
    } catch (err) {
      if (err instanceof ApiError && err.blockers?.length) {
        setBlockers(err.blockers);
      } else {
        setError(err instanceof Error ? err.message : 'Could not move the file.');
      }
      setBusy(false);
    }
  };

  return (
    <Modal title="Move stage" onClose={onClose}
           footer={<>
             <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
             <button class="btn btn-primary" onClick={submit}
                     disabled={busy || !stage || (isLost && !disposition) ||
                               (isLost && Boolean(dispositionMeta?.requires_note) && !note.trim())}>
               {busy ? 'Moving…' : 'Move file'}
             </button>
           </>}>
      {error && <div class="alert alert-error">{error}</div>}
      {blockers.length > 0 && (
        <div class="alert alert-warn">
          <strong>This file is not ready for that stage.</strong>
          <ul>{blockers.map((b) => <li key={b.label}>{b.message}</li>)}</ul>
        </div>
      )}

      <Field label="Move to">
        <select value={stage} onChange={(e) => setStage((e.target as HTMLSelectElement).value)}>
          <option value="">Choose a stage…</option>
          {config?.stages.filter((s) => s.active && s.key !== current).map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </Field>

      {isLost && (
        <>
          <Field label="Why was it lost?"
                 hint="The disposition decides whether and when this client is worth approaching again.">
            <select value={disposition} onChange={(e) => setDisposition((e.target as HTMLSelectElement).value)}>
              <option value="">Choose a reason…</option>
              {config?.lost_dispositions.map((d) => (
                <option key={d.key} value={d.key}>{d.label}</option>
              ))}
            </select>
          </Field>
          {dispositionMeta?.requires_note && (
            <Field label="Details" hint="Required for this disposition.">
              <textarea rows={2} value={note}
                        onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
            </Field>
          )}
        </>
      )}

      <Field label="Note (optional)" hint="Recorded on the file and in the audit log.">
        <input value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
      </Field>
    </Modal>
  );
}

/**
 * An honest empty state for a module that has schema and API but no screen.
 * Deliberately not a mocked-up panel: a fake Kanban with no persistence behind
 * it is how a product gets signed off and then does not work.
 */
