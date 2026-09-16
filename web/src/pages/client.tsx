/**
 * The client workspace.
 *
 * The test this screen is built to pass: within seconds of opening a file a
 * person can answer who the client is, what they want, how much, when they
 * close, how long is left, who owns it, what is missing, and what happens next
 * — without opening a tab. So the header carries the facts and the tabs carry
 * the detail, never the other way round.
 */
import { useEffect, useState } from 'preact/hooks';
import { ApiError, formatDate, formatDateTime, money, post, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, type Config, type Session } from '../lib/store.ts';
import {
  Avatar, Badge, Empty, ErrorNote, Field, Icon, ICONS, Modal, SearchSelect, Skeleton, Urgency,
  type SelectOption,
} from '../components/ui.tsx';
import { hasSeveralPipelines, stageOptions } from '../lib/pipelines.ts';
import { DataTable, recency } from '../components/data-table.tsx';
import { ClientAutomations } from './automations.tsx';
import { ComplianceTab } from './compliance.tsx';
import { CommunicationTab } from './messages.tsx';
import { FundingTab } from './funding.tsx';
import { FileAppointments } from './appointments.tsx';
import { FileTasks } from './tasks.tsx';
import { ApplicationForm } from './application-form.tsx';
import { DocumentRequestPanel } from './document-requests.tsx';
import { SendToScarlett } from './scarlett-send.tsx';
import {
  ArchiveFile, EditContact, MergeCustomer, useCustomerRecord, type RecordPayload,
} from './customer-record.tsx';

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

/** A tab with a permission is only offered to those who hold it. */
const TABS: Array<{ key: string; label: string; permission?: string }> = [
  { key: 'summary', label: 'Summary' },
  { key: 'application', label: 'Application' },
  { key: 'compliance', label: 'Compliance', permission: 'compliance.view' },
  { key: 'communication', label: 'Communication' },
  { key: 'documents', label: 'Documents' },
  { key: 'funding', label: 'Funding', permission: 'funding.view' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'notes', label: 'Notes' },
  { key: 'appointments', label: 'Appointments' },
  { key: 'automations', label: 'Automations' },
  { key: 'log', label: 'Log' },
];

export function ClientPage({ id, session, config }: {
  id: string; session: Session; config: Config | null;
}) {
  const [tab, setTab] = useState('application');
  const [movingStage, setMovingStage] = useState(false);
  const [changingPipeline, setChangingPipeline] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [bookRequested, setBookRequested] = useState(false);
  const [editingContact, setEditingContact] = useState(false);
  const [merging, setMerging] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [sendingScarlett, setSendingScarlett] = useState(false);
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
  const can = (p: string) => session.permissions.includes(p);
  const name = `${app.first_name ?? ''} ${app.last_name ?? ''}`.trim() || 'Unnamed client';
  const property = [
    [app.property_street_number, app.property_street_name].filter(Boolean).join(' '),
    app.property_city, app.property_province,
  ].filter(Boolean).join(', ');
  const type = config?.transaction_types.find((t) => t.key === app.transaction_type_key)?.label
    ?? app.transaction_type_key ?? 'Type not set';
  const outstandingConditions = conditions.filter((c) => c.status === 'outstanding').length;
  const primary = (role: string) => assignments.find((a) => a.role === role && a.is_primary);
  const pipelineName = config?.pipelines.find((p) => p.id === app.pipeline_id)?.name ?? null;

  return (
    <div style={{ margin: '-20px -20px 0' }}>
      <header class="client-head">
        <button class="btn btn-ghost btn-sm" style={{ marginBottom: 9 }}
                onClick={() => navigate('/customers')}>
          <Icon path={ICONS.back} size={14} /> Customers
        </button>

        <div class="client-title">
          <h1>{name}</h1>
          <span class="badge badge-accent">
            {hasSeveralPipelines(config) && pipelineName ? `${pipelineName} · ` : ''}{app.stage_label ?? 'No stage'}
          </span>
          {compliance?.legal_hold && <Badge tone="danger">Legal hold</Badge>}
          {app.awaiting_reply_since && <Badge tone="danger">Awaiting our reply</Badge>}
          {app.archived_at && <Badge tone="neutral">Archived {formatDate(app.archived_at)}</Badge>}
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
          <Fact label="Assigned to">
            <span class="row" style={{ gap: 6 }}>
              <span>{primary('broker')?.name ?? <span class="text-muted">Unassigned</span>}</span>
              {session.permissions.includes('pipeline.assign') && (
                <button class="link-button text-sm" onClick={() => setAssigning(true)}>
                  {primary('broker') ? 'Change' : 'Assign'}
                </button>
              )}
            </span>
          </Fact>
          <Fact label="Underwriter">{primary('underwriter')?.name ?? '—'}</Fact>
          <Fact label="Scarlett">
            {app.scarlett_deal_id
              ? <span class="row" style={{ gap: 6 }}>
                  <span>{app.scarlett_deal_id}</span>
                  {app.scarlett_sync_state === 'error' && <Badge tone="danger">Sync failed</Badge>}
                  {app.scarlett_sync_state === 'stale' && <Badge tone="warn">Check in Scarlett</Badge>}
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
          <Fact label="Next meeting">
            {app.next_appointment_at
              ? <button class="link-button" onClick={() => setTab('appointments')}>{formatDateTime(app.next_appointment_at)}</button>
              : 'None booked'}
          </Fact>
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
          {(session.permissions.includes('appointment.manage') || session.permissions.includes('appointment.manage_all')) && (
            <button class="btn" onClick={() => { setTab('appointments'); setBookRequested(true); }}>Book appointment</button>
          )}
          {(session.permissions.includes('task.manage') || session.permissions.includes('task.manage_all')) && (
            <button class="btn" onClick={() => setTab('tasks')}>Add task</button>
          )}
          {can('customer.edit') && (
            <button class="btn" onClick={() => setEditingContact(true)}>Edit contact</button>
          )}
          {can('customer.merge') && (
            <button class="btn" onClick={() => setMerging(true)}>Merge duplicate</button>
          )}
          {can('customer.delete') && (
            <button class="btn" onClick={() => setArchiving(true)}>{app.archived_at ? 'Restore file' : 'Archive'}</button>
          )}
          {can('scarlett.push') && !app.archived_at && (
            <button class={`btn${app.scarlett_deal_id ? '' : ' btn-primary'}`} onClick={() => setSendingScarlett(true)}>
              {app.scarlett_deal_id ? 'Re-send to Scarlett' : 'Send to Scarlett'}
            </button>
          )}
          {session.permissions.includes('pipeline.move') && (
            <>
              {hasSeveralPipelines(config) && (
                <button class="btn" onClick={() => setChangingPipeline(true)}>Change pipeline</button>
              )}
              <button class="btn btn-primary" onClick={() => setMovingStage(true)}>Move stage</button>
            </>
          )}
        </div>
        <RecordNotices customerId={String(app.customer_id)} archived={!!app.archived_at}
                       canMerge={can('customer.merge')} canRestore={can('customer.delete')}
                       onMerge={() => setMerging(true)} onRestore={() => setArchiving(true)} />
      </header>

      <div class="tabs" role="tablist">
        {TABS.filter((t) => !t.permission || session.permissions.includes(t.permission)).map((t) => (
          <button key={t.key} class="tab" role="tab" aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding: 20 }}>
        {tab === 'summary' && <ApplicationTab data={state.data} />}
        {tab === 'application' && <ApplicationForm id={id} session={session} onDocumentsRequested={state.reload} />}
        {tab === 'tasks' && <FileTasks applicationId={id} session={session} />}
        {tab === 'notes' && <NotesTab id={id} session={session} />}
        {tab === 'appointments' && (
          <FileAppointments applicationId={id} session={session} clientName={name} hostId={primary('broker')?.user_id ?? null} bookRequested={bookRequested}
                            onBookingOpened={() => setBookRequested(false)} onChanged={state.reload} />
        )}
        {tab === 'log' && <LogTab id={id} />}
        {tab === 'documents' && <DocumentsTab data={state.data} id={id} session={session} onChanged={state.reload} />}
        {tab === 'compliance' && session.permissions.includes('compliance.view') && <ComplianceTab applicationId={id} session={session} />}
        {tab === 'funding' && session.permissions.includes('funding.view') && <FundingTab applicationId={id} session={session} config={config} />}
        {tab === 'automations' && (
          <ClientAutomations customerId={String(app.customer_id)} session={session} />
        )}
        {tab === 'communication' && (
          <CommunicationTab customerId={String(app.customer_id)} applicationId={id}
                            session={session} />
        )}
      </div>

      {assigning && (
        <AssignLead id={id} current={primary('broker') ?? null} clientName={name}
                    onClose={() => setAssigning(false)}
                    onAssigned={() => { setAssigning(false); state.reload(); }} />
      )}
      {editingContact && (
        <CustomerModal customerId={String(app.customer_id)} onClose={() => setEditingContact(false)} render={(record, reload) => (
          <EditContact customer={record.customer} onClose={() => setEditingContact(false)}
                       onSaved={() => { setEditingContact(false); reload(); state.reload(); }} />
        )} />
      )}
      {merging && (
        <CustomerModal customerId={String(app.customer_id)} onClose={() => setMerging(false)} render={(record, reload) => (
          <MergeCustomer customer={record.customer} duplicates={record.duplicates}
                         onClose={() => setMerging(false)}
                         onMerged={() => { setMerging(false); reload(); state.reload(); }} />
        )} />
      )}
      {sendingScarlett && (
        <SendToScarlett applicationId={id} session={session}
                        onClose={() => setSendingScarlett(false)}
                        onSent={() => { setSendingScarlett(false); state.reload(); }} />
      )}
      {archiving && (
        <ArchiveFile applicationId={id} archived={!!app.archived_at} clientName={name}
                     onClose={() => setArchiving(false)}
                     onDone={() => { setArchiving(false); state.reload(); }} />
      )}
      {movingStage && (
        <MoveStage id={id} current={app.stage_key} config={config} pipelineId={app.pipeline_id}
                   onClose={() => setMovingStage(false)}
                   onMoved={() => { setMovingStage(false); state.reload(); }} />
      )}
      {changingPipeline && (
        <MoveStage id={id} current={app.stage_key} config={config} pipelineId={app.pipeline_id} changePipeline
                   onClose={() => setChangingPipeline(false)}
                   onMoved={() => { setChangingPipeline(false); state.reload(); }} />
      )}
    </div>
  );
}

/** Loads the customer record, then renders a modal that needs it. */
function CustomerModal({ customerId, render, onClose }: {
  customerId: string; onClose: () => void;
  render: (record: RecordPayload, reload: () => void) => any;
}) {
  const record = useCustomerRecord(customerId);
  if (record.status === 'error') {
    return (
      <Modal title="Customer record" onClose={onClose}>
        <ErrorNote error={record.error} code={record.code} permission={record.permission} onRetry={record.reload} />
      </Modal>
    );
  }
  return record.status === 'ready' ? render(record.data, record.reload) : null;
}

/** Said at the top of the file: it is archived, or somebody else looks like the same person. */
function RecordNotices({ customerId, archived, canMerge, canRestore, onMerge, onRestore }: {
  customerId: string; archived: boolean; canMerge: boolean; canRestore: boolean;
  onMerge: () => void; onRestore: () => void;
}) {
  const record = useCustomerRecord(customerId);
  const duplicates = record.status === 'ready' ? record.data.duplicates : [];
  if (!archived && !duplicates.length) return null;
  return (
    <div class="stack" style={{ gap: 6, marginTop: 10 }}>
      {archived && (
        <div class="alert alert-info">
          This file is archived: it is off the customer list and the board, and its application answers are locked.
          {canRestore && <> <button class="link-button" onClick={onRestore}>Restore it</button></>}
        </div>
      )}
      {duplicates.length > 0 && (
        <div class="alert alert-warn">
          {duplicates.length === 1
            ? `Another record looks like the same person: ${[duplicates[0]!.first_name, duplicates[0]!.last_name].filter(Boolean).join(' ') || 'unnamed'} (same ${duplicates[0]!.matched_on?.join(', ')}).`
            : `${duplicates.length} other records look like the same person.`}
          {canMerge && <> <button class="link-button" onClick={onMerge}>Review and merge</button></>}
        </div>
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
              <DataTable label="Borrowers" compact rows={applicants} rowKey={(a) => String(a.id)}
                columns={[
                  { key: 'name', header: 'Name', primary: true,
                    value: (a) => `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() || null },
                  { key: 'applicant_role', header: 'Role', filter: 'auto',
                    value: (a) => String(a.applicant_role ?? '').replace(/_/g, ' ') },
                  { key: 'contact', header: 'Contact', value: (a) => a.email ?? a.phone_e164 ?? null,
                    render: (a) => a.email ?? a.phone_e164 ?? '—' },
                  { key: 'residential_status', header: 'Status', filter: 'auto',
                    render: (a) => a.residential_status ?? '—' },
                  { key: 'address', header: 'Address',
                    value: (a) => [a.addr_city, a.addr_province].filter(Boolean).join(', ') || null,
                    render: (a) => [a.addr_city, a.addr_province].filter(Boolean).join(', ') || '—' },
                ]} />
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
function DocumentsTab({ data, id, session, onChanged }: {
  data: Workspace; id: string; session: Session; onChanged: () => void;
}) {
  return (
    <div class="stack">
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
          <DataTable label="Documents on this file" compact rows={data.documents} rowKey={(d) => String(d.id)}
            initialSort={{ key: 'uploaded_at', dir: 'desc' }}
            columns={[
              { key: 'name', header: 'Document', primary: true, value: (d) => d.display_label ?? d.filename },
              { key: 'category_key', header: 'Category', filter: 'auto', render: (d) => d.category_key ?? '—' },
              { key: 'uploaded_at', header: 'Uploaded', filter: 'auto', filterValue: (d) => recency(d.uploaded_at),
                render: (d) => relativeTime(d.uploaded_at) },
              { key: 'review_status', header: 'Review', filter: 'auto',
                render: (d) => (
                  <Badge tone={d.review_status === 'accepted' ? 'ok' : d.review_status === 'rejected' ? 'danger' : 'warn'}>
                    {d.review_status}
                  </Badge>
                ) },
              { key: 'scan_status', header: 'Scan', filter: 'auto',
                render: (d) => (
                  <Badge tone={d.scan_status === 'clean' ? 'ok' : d.scan_status === 'infected' ? 'danger' : 'neutral'}>
                    {d.scan_status}
                  </Badge>
                ) },
            ]} />
        )}
      </div>

      <DocumentRequestPanel applicationId={id} session={session} onSent={onChanged} />
    </div>
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

function MoveStage({ id, current, config, pipelineId, changePipeline = false, onClose, onMoved }: {
  id: string; current: string | null; config: Config | null; pipelineId: string;
  /** Pick another pipeline first, then the stage in it the file lands on. */
  changePipeline?: boolean;
  onClose: () => void; onMoved: () => void;
}) {
  const [stage, setStage] = useState('');
  const others = (config?.pipelines ?? []).filter((p) => p.active && p.id !== pipelineId);
  const [targetPipeline, setTargetPipeline] = useState(changePipeline ? others[0]?.id ?? '' : pipelineId);
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
      toast(changePipeline
        ? `Moved to ${config?.pipelines.find((p) => p.id === targetPipeline)?.name} · ${target?.label}`
        : `Moved to ${target?.label}`, 'ok');
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
    <Modal title={changePipeline ? 'Move to another pipeline' : 'Move stage'} onClose={onClose}
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

      {changePipeline && (
        <Field label="Pipeline" hint="The file keeps its history; the move is recorded on it.">
          <SearchSelect value={targetPipeline} ariaLabel="Pipeline"
                        options={others.map((p) => ({ value: p.id, label: p.name, hint: p.is_default ? 'Default' : undefined }))}
                        onChange={(v) => { setTargetPipeline(v); setStage(''); }} />
        </Field>
      )}
      <Field label={changePipeline ? 'Stage it lands on' : 'Move to'}>
        <SearchSelect value={stage} onChange={setStage} ariaLabel="Move to" placeholder="Choose a stage…"
                      options={stageOptions(config, { pipelineId: targetPipeline, exclude: current })} />
      </Field>

      {isLost && (
        <>
          <Field label="Why was it lost?"
                 hint="The disposition decides whether and when this client is worth approaching again.">
            <SearchSelect value={disposition} onChange={setDisposition} ariaLabel="Why was it lost?"
                          placeholder="Choose a reason…"
                          options={(config?.lost_dispositions ?? []).map((d) => ({ value: d.key, label: d.label }))} />
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

/**
 * Hand this lead to somebody. Only active staff are offered — an inactive or
 * not-yet-activated account could not open the file it was given. Staff with
 * round robin off are offered: that switch only stops automatic assignment.
 */
function AssignLead({ id, current, clientName, onClose, onAssigned }: {
  id: string; current: { user_id: string; name: string } | null; clientName: string;
  onClose: () => void; onAssigned: () => void;
}) {
  const staff = useAsync<{ staff: Array<{ id: string; name: string; role_name: string; open_leads: number;
                                          round_robin_enabled: boolean }> }>('/staff/assignable');
  const [to, setTo] = useState(current?.user_id ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const options: SelectOption[] = staff.status === 'ready'
    ? staff.data.staff.map((s) => ({
      value: s.id, label: s.name,
      hint: `${s.role_name} · ${s.open_leads} open lead${s.open_leads === 1 ? '' : 's'}${s.round_robin_enabled ? '' : ' · round robin off'}`,
    }))
    : [];

  const submit = async () => {
    if (!to) { setError('Choose a staff member.'); return; }
    setBusy(true);
    try {
      const result = await post<{ assigned_to: { name: string } }>(`/applications/${id}/assign`, { user_id: to, role: 'broker' });
      toast(`${clientName} is now assigned to ${result.assigned_to.name}.`, 'ok');
      onAssigned();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign the lead.');
      setBusy(false);
    }
  };

  return (
    <Modal title={current ? 'Reassign lead' : 'Assign lead'} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class="btn btn-primary" onClick={submit}
                disabled={busy || !to || to === current?.user_id}>
          {busy ? 'Assigning…' : 'Assign'}
        </button>
      </>
    }>
      <p class="mt-0">
        {current ? <>Currently with <strong>{current.name}</strong>. </> : null}
        They are notified, and the change is recorded on the file’s log.
      </p>
      {staff.status === 'error' && <ErrorNote error={staff.error} code={staff.code} onRetry={staff.reload} />}
      <Field label="Assign to" error={error}>
        <SearchSelect value={to} options={options} onChange={(v) => { setTo(v); setError(''); }}
                      placeholder={staff.status === 'loading' ? 'Loading staff…' : 'Choose a staff member…'}
                      searchPlaceholder="Search staff by name or role…" ariaLabel="Assign to"
                      emptyText="No active staff match that." invalid={!!error} />
      </Field>
    </Modal>
  );
}
