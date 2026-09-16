/**
 * The customer list and the board — the same files, two ways of looking at them.
 *
 * On a phone the table becomes cards (see the CSS), because a broker standing
 * outside a client's house scrolling a nine-column table horizontally is not
 * using this product.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BASE, compactMoney, fieldErrors, formatDate, get, post, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, useRoute, type Config, type Session } from '../lib/store.ts';
import { DataTable, emptyQuery, queryToParams, type Column, type TableQuery } from '../components/data-table.tsx';
import { hasSeveralPipelines, pipelineOptions, stageOptions } from '../lib/pipelines.ts';
import {
  AvatarStack, Badge, Empty, ErrorNote, Field, Icon, ICONS, Modal, SearchSelect, Skeleton, Urgency,
  type SelectOption,
} from '../components/ui.tsx';

type Row = {
  id: string; customer_id: string; first_name: string; last_name: string;
  email: string | null; phone_e164: string | null;
  stage_key: string | null; stage_label: string | null; stage_colour: string | null;
  transaction_type_key: string | null; amount_requested: string | null;
  closing_date: string | null; days_to_close: { days: number | null; urgency: string; label: string };
  property_street_number: string | null; property_street_name: string | null;
  property_city: string | null; property_province: string | null;
  stage_category: string | null;
  last_activity_at: string | null; next_task_at: string | null;
  documents_outstanding: number; awaiting_reply_since: string | null;
  percent_complete: number; scarlett_sync_state: string | null;
  assignees: Array<{ name: string; role: string }>;
  pipeline_id: string; pipeline_name: string | null;
};

const address = (r: Pick<Row, 'property_street_number' | 'property_street_name' | 'property_city'>) =>
  [[r.property_street_number, r.property_street_name].filter(Boolean).join(' '), r.property_city]
    .filter(Boolean).join(', ') || '—';

const fullName = (r: { first_name: string | null; last_name: string | null }) =>
  `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Unnamed';

export function CustomersPage({ session, config }: { session: Session; config: Config | null }) {
  const route = useRoute();
  const [creating, setCreating] = useState(route.query.get('new') === '1');
  const [query, setQuery] = useState<TableQuery>(emptyQuery({ sort: 'last_activity', dir: 'desc' }));
  const [data, setData] = useState<{ customers: Row[]; total: number } | null>(null);
  const canCreate = session.permissions.includes('customer.create');
  const canExport = session.permissions.includes('customer.export');
  const canArchive = session.permissions.includes('customer.delete');
  const [showArchived, setShowArchived] = useState(false);

  const columns = useMemo<Column<Row>[]>(() => [
    {
      key: 'client', header: 'Client', param: 'client', sortKey: 'name', primary: true,
      render: (r) => (
        <>
          <div class="cell-strong">{fullName(r)}</div>
          <div class="cell-muted text-sm">{r.email ?? r.phone_e164 ?? '—'}</div>
        </>
      ),
    },
    ...(hasSeveralPipelines(config) ? [{
      key: 'pipeline', header: 'Pipeline', param: 'pipeline', sortKey: 'pipeline',
      filter: { options: pipelineOptions(config) },
      render: (r: Row) => <span class="text-sm">{r.pipeline_name ?? '—'}</span>,
    } as Column<Row>] : []),
    {
      key: 'stage', header: 'Stage', param: 'stage', sortKey: 'stage',
      filter: { options: stageOptions(config) },
      render: (r) => (
        <span class="badge" style={r.stage_colour
          ? { background: `${r.stage_colour}1f`, color: r.stage_colour } : undefined}>
          {r.stage_label ?? 'No stage'}
        </span>
      ),
    },
    {
      key: 'amount', header: 'Mortgage', param: 'amount', sortKey: 'amount', align: 'right',
      filter: { options: [
        { value: 'lt250', label: 'Under $250k' }, { value: '250_500', label: '$250k – $500k' },
        { value: '500_1000', label: '$500k – $1M' }, { value: 'gt1000', label: '$1M and over' },
        { value: 'none', label: 'Not given' },
      ] },
      render: (r) => compactMoney(r.amount_requested),
    },
    {
      key: 'property', header: 'Subject property', param: 'property', sortKey: 'property',
      render: (r) => address(r),
    },
    {
      key: 'closing', header: 'Closing', param: 'closing', sortKey: 'closing',
      filter: { options: [
        { value: 'overdue', label: 'Past, still open' }, { value: '14', label: 'Within 14 days' },
        { value: '30', label: 'Within 30 days' }, { value: 'later', label: 'More than 30 days' },
        { value: 'none', label: 'No closing date' },
      ] },
      render: (r) => <Urgency value={r.days_to_close} settled={r.stage_category === 'won' || r.stage_category === 'lost'} />,
    },
    {
      key: 'assignee', header: 'Assigned', param: 'assignee', sortable: false,
      filter: { options: [{ value: '__none', label: 'Unassigned' },
                          ...(config?.users ?? []).map((u) => ({ value: u.id, label: u.name }))] },
      render: (r) => <AvatarStack people={r.assignees} />,
    },
    {
      key: 'flag', header: 'Flags', param: 'flag', sortable: false,
      filter: { options: [
        { value: 'awaiting_reply', label: 'Awaiting our reply' }, { value: 'documents', label: 'Documents outstanding' },
        { value: 'scarlett', label: 'Scarlett sync failed' }, { value: 'incomplete', label: 'Application incomplete' },
      ] },
      render: (r) => (
        <span class="row" style={{ gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {r.awaiting_reply_since && <Badge tone="danger">Awaiting reply</Badge>}
          {r.documents_outstanding > 0 && (
            <Badge tone="warn">{r.documents_outstanding} doc{r.documents_outstanding === 1 ? '' : 's'}</Badge>
          )}
          {r.scarlett_sync_state === 'error' && <Badge tone="danger">Scarlett</Badge>}
          {r.percent_complete < 100 && <Badge>{r.percent_complete}%</Badge>}
        </span>
      ),
    },
    {
      key: 'activity', header: 'Last activity', param: 'activity', sortKey: 'last_activity',
      filter: { options: [
        { value: 'today', label: 'Today' }, { value: 'week', label: 'Last 7 days' },
        { value: 'month', label: 'Last 31 days' }, { value: 'older', label: 'Older' },
      ] },
      render: (r) => <span class="cell-muted">{relativeTime(r.last_activity_at)}</span>,
    },
  ], [config]);

  const params = (() => {
    const p = queryToParams(query, columns);
    if (showArchived) p.set('archived', 'true');
    return p.toString();
  })();
  const state = useAsync<{ customers: Row[]; total: number }>(`/customers?${params}`, [params]);
  useEffect(() => { if (state.status === 'ready') setData(state.data); }, [state]);

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Customers</h1>
          <p>{data ? `${data.total} ${showArchived ? 'archived ' : ''}file${data.total === 1 ? '' : 's'}` : 'Loading…'}</p>
        </div>
        <div class="row" style={{ flexWrap: 'wrap' }}>
          {canArchive && (
            <label class="row text-sm" style={{ gap: 6, margin: 0, cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 16 }} checked={showArchived}
                     onChange={(e) => { setShowArchived((e.target as HTMLInputElement).checked); setQuery((q) => ({ ...q, page: 1 })); }} />
              Show archived
            </label>
          )}
          {canExport && (
            // A plain link: the session cookie goes with it and the browser
            // saves the file. The same filters as the table, every page of them.
            <a class="btn" href={`${BASE}/api/customers/export?${params}`} download>
              Export CSV
            </a>
          )}
          <button class="btn" onClick={() => navigate('/pipeline')}>
            <Icon path={ICONS.board} /> Board
          </button>
          {canCreate && (
            <button class="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon path={ICONS.plus} /> New customer
            </button>
          )}
        </div>
      </div>

      <div class="card">
        {state.status === 'error' && !data ? (
          <div style={{ padding: 15 }}><ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} /></div>
        ) : (
          <DataTable<Row>
            label="Customers"
            columns={columns}
            rows={data?.customers ?? []}
            total={data?.total ?? 0}
            rowKey={(r) => r.id}
            query={query}
            onQueryChange={setQuery}
            loading={state.status === 'loading'}
            initialSort={{ key: 'activity', dir: 'desc' }}
            searchPlaceholder="Name, email, phone, address or reference…"
            onRowClick={(r) => navigate(`/applications/${r.id}`)}
            empty={
              <Empty title="No customers yet"
                     action={canCreate ? <button class="btn btn-primary" onClick={() => setCreating(true)}>New customer</button> : undefined}>
                Files arrive automatically from apply.lendmax.ca once the portal mirror is connected, or you can create one by hand.
              </Empty>
            }
          />
        )}
      </div>

      {creating && (
        <NewCustomer config={config} session={session}
                     onClose={() => setCreating(false)}
                     onCreated={(id) => { setCreating(false); navigate(`/applications/${id}`); }} />
      )}
    </div>
  );
}

type Assignable = { id: string; name: string; role_name: string; open_leads: number; round_robin_enabled: boolean };

function NewCustomer({ config, session, onClose, onCreated }: {
  config: Config | null; session: Session; onClose: () => void; onCreated: (applicationId: string) => void;
}) {
  const canAssign = session.permissions.includes('pipeline.assign');
  // A broker typing in their own referral keeps it; anybody else defaults to
  // the rotation. Either can pick someone else.
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '',
    transaction_type_key: '', amount_requested: '',
    assign_to: session.user.role === 'broker' ? 'me' : 'auto',
  });
  const [staff, setStaff] = useState<Assignable[]>([]);
  useEffect(() => {
    if (!canAssign) return;
    get<{ staff: Assignable[] }>('/staff/assignable').then((d) => setStaff(d.staff)).catch(() => { /* the two built-in choices still work */ });
  }, [canAssign]);
  const assignOptions: SelectOption[] = [
    { value: 'auto', label: 'Automatic — round robin', hint: 'The next person in turn' },
    { value: 'me', label: `Me (${session.user.name})` },
    ...staff.filter((s) => s.id !== session.user.id).map((s) => ({
      value: s.id, label: s.name,
      hint: `${s.role_name} · ${s.open_leads} open${s.round_robin_enabled ? '' : ' · round robin off'}`,
    })),
  ];
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [duplicates, setDuplicates] = useState<Array<{ id: string; first_name: string; last_name: string; email: string }>>([]);

  const set = (k: string) => (e: Event) =>
    setForm((f) => ({ ...f, [k]: (e.target as HTMLInputElement).value }));

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const result = await post<{ application_id: string; possible_duplicates: typeof duplicates;
                                  assigned_to: { name: string } | null }>(
        '/customers',
        {
          first_name: form.first_name,
          last_name: form.last_name,
          email: form.email || undefined,
          phone: form.phone || undefined,
          transaction_type_key: form.transaction_type_key || undefined,
          amount_requested: form.amount_requested ? Number(form.amount_requested) : undefined,
          assign_to: form.assign_to,
        },
      );
      // A possible duplicate is reported, never merged silently — merging two
      // people's mortgage files because they share an address is not undoable.
      if (result.possible_duplicates?.length) {
        setDuplicates(result.possible_duplicates);
        toast(`Created — but ${result.possible_duplicates.length} similar record(s) already exist.`, 'info');
      }
      if (!result.possible_duplicates?.length) {
        toast(result.assigned_to
          ? `Created and assigned to ${result.assigned_to.name}.`
          : 'Created. Nobody was assigned — round robin is off or has nobody in it.', result.assigned_to ? 'ok' : 'info');
      }
      onCreated(result.application_id);
    } catch (err) {
      setErrors(fieldErrors(err, 'Could not create the customer.'));
      setBusy(false);
    }
  };

  return (
    <Modal title="New customer" onClose={onClose}
           footer={<>
             <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
             <button class="btn btn-primary" onClick={submit} disabled={busy}>
               {busy ? 'Creating…' : 'Create customer'}
             </button>
           </>}>
      <form onSubmit={submit}>
        {errors._ && <div class="alert alert-error">{errors._}</div>}
        {duplicates.length > 0 && (
          <div class="alert alert-warn">
            Similar records already exist:
            <ul>{duplicates.map((d) => <li key={d.id}>{d.first_name} {d.last_name} — {d.email}</li>)}</ul>
          </div>
        )}
        <div class="grid-2">
          <Field label="First name" error={errors.first_name}>
            <input value={form.first_name} onInput={set('first_name')} required autofocus />
          </Field>
          <Field label="Last name" error={errors.last_name}>
            <input value={form.last_name} onInput={set('last_name')} required />
          </Field>
        </div>
        <Field label="Email" error={errors.email}>
          <input type="email" value={form.email} onInput={set('email')} />
        </Field>
        <Field label="Phone" error={errors.phone}
               hint="Any format — it is normalised so an inbound text finds this client.">
          <input value={form.phone} onInput={set('phone')} placeholder="(416) 555-0142" />
        </Field>
        <div class="grid-2">
          <Field label="Transaction type" error={errors.transaction_type_key}>
            <SearchSelect value={form.transaction_type_key} ariaLabel="Transaction type"
                          onChange={(v) => setForm((f) => ({ ...f, transaction_type_key: v }))}
                          options={[{ value: '', label: 'Not sure yet' },
                                    ...(config?.transaction_types ?? []).map((t) => ({ value: t.key, label: t.label }))]} />
          </Field>
          <Field label="Mortgage requested">
            <input type="number" min="0" step="1000" value={form.amount_requested}
                   onInput={set('amount_requested')} placeholder="500000" />
          </Field>
        </div>
        <Field label="Assign to" error={errors.assign_to}
               hint={form.assign_to === 'auto' ? 'If round robin is off, the lead waits unassigned on the dashboard.' : undefined}>
          <SearchSelect value={form.assign_to} options={canAssign ? assignOptions : assignOptions.slice(0, 2)}
                        onChange={(v) => setForm((f) => ({ ...f, assign_to: v }))} ariaLabel="Assign to"
                        searchPlaceholder="Search staff…" />
        </Field>
        <p class="text-sm text-muted mb-0">
          An email address or a phone number is needed — without one there is no way to reach them.
        </p>
      </form>
    </Modal>
  );
}

// ── The board ──────────────────────────────────────────────────────────────

type Stage = { key: string; label: string; colour: string | null; probability: number | null };
type BoardCard = Row & { customer_id: string };

type BoardData = {
  pipeline: { id: string; key: string; name: string; active: boolean };
  pipelines: Array<{ id: string; key: string; name: string; active: boolean; is_default: boolean; files_open: number }>;
  columns: Array<{
    stage: Stage;
    count: number; value: number; weighted: number | null;
    cards: BoardCard[];
  }>;
};

export function PipelinePage({ session }: { session: Session }) {
  const route = useRoute();
  const chosen = route.query.get('pipeline') ?? '';
  const [nonce, setNonce] = useState(0);
  const state = useAsync<BoardData>(
    `/pipeline${chosen ? `?pipeline=${encodeURIComponent(chosen)}` : ''}`, [chosen, nonce]);
  const total = state.status === 'ready'
    ? state.data.columns.reduce((sum, c) => sum + (c.weighted ?? 0), 0) : 0;

  const canMove = session.permissions.includes('pipeline.move');
  /**
   * The card being dragged.
   *
   * Held in a ref as well as in state, and the ref is what the drop handlers
   * read. `dragover` has to call `preventDefault` synchronously or the browser
   * refuses the drop, and a state update set in `dragstart` has not necessarily
   * been applied by the time the first `dragover` arrives. The state copy is
   * only there to grey the card being moved.
   */
  const draggingRef = useRef<BoardCard | null>(null);
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** A move waiting for its note. Nothing is sent until the note is answered. */
  const [moving, setMoving] = useState<{ card: BoardCard; to: Stage } | null>(null);

  const drop = (stage: Stage) => {
    setOver(null);
    const card = draggingRef.current;
    draggingRef.current = null;
    setDragging(null);
    if (!card || card.stage_key === stage.key) return;
    // The note comes first. A stage change with no reason is the thing this
    // board exists to stop being easy.
    setMoving({ card, to: stage });
  };

  return (
    <div>
      <div class="page-head">
        <div>
          <h1>{state.status === 'ready' && state.data.pipelines.length > 1 ? state.data.pipeline.name : 'Pipeline'}</h1>
          <p>
            {state.status === 'ready'
              ? `Weighted forecast ${compactMoney(total)} — stages with no probability set are counted but not forecast.`
              : 'Loading the board…'}
          </p>
        </div>
        <button class="btn" onClick={() => navigate('/customers')}>
          <Icon path={ICONS.customers} /> List
        </button>
      </div>

      {state.status === 'ready' && state.data.pipelines.length > 1 && (
        <div class="purpose-tabs" role="tablist" aria-label="Pipeline">
          {state.data.pipelines.map((p) => (
            <button key={p.id} class="purpose-tab" role="tab" aria-selected={p.id === state.data.pipeline.id}
                    onClick={() => navigate(`/pipeline?pipeline=${p.id}`)}>
              {p.name}{!p.active && ' (inactive)'} <span class="n">{p.files_open}</span>
            </button>
          ))}
        </div>
      )}
      {state.status === 'error' && <ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} />}
      {state.status === 'loading' && <Skeleton rows={4} height={110} />}

      {state.status === 'ready' && canMove && (
        <p class="text-sm text-muted" style={{ margin: '0 0 8px' }}>
          Drag a file to another stage. You will be asked for a note, which is kept on the file.
        </p>
      )}

      {state.status === 'ready' && (
        <div class="board">
          {state.data.columns.map((col) => (
            <section key={col.stage.key}
                     class={`board-col${over === col.stage.key ? ' board-col-over' : ''}`}
                     aria-label={col.stage.label}
                     onDragOver={(e) => {
                       if (!draggingRef.current || !canMove) return;
                       // Without preventDefault the browser refuses the drop.
                       e.preventDefault();
                       if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                       setOver(col.stage.key);
                     }}
                     onDragLeave={(e) => {
                       if (!draggingRef.current) return;
                       // Only when the pointer has actually left the column, not
                       // when it crosses a card inside it.
                       if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                         setOver((current) => (current === col.stage.key ? null : current));
                       }
                     }}
                     onDrop={(e) => { e.preventDefault(); drop(col.stage); }}>
              <header class="board-col-head">
                <div class="title">
                  <span class="swatch" style={{ background: col.stage.colour ?? 'var(--grey-400)' }}
                        aria-hidden="true" />
                  <span>{col.stage.label}</span>
                  <span class="text-muted" style={{ marginLeft: 'auto' }}>{col.count}</span>
                </div>
                <div class="meta num">
                  {compactMoney(col.value)}
                  {col.weighted !== null && col.count > 0 && ` · ${compactMoney(col.weighted)} weighted`}
                </div>
              </header>
              <div class="board-cards">
                {col.cards.length === 0 && (
                  <div class="text-sm text-muted" style={{ padding: '14px 4px', textAlign: 'center' }}>
                    Nothing here
                  </div>
                )}
                {col.cards.map((card) => (
                  /* A div, not a button.
                   *
                   * Chromium will not start a native drag from a form control,
                   * however `draggable` is set — the card simply never moved.
                   * So the card carries the button's role and keyboard
                   * behaviour instead of its tag. */
                  <div key={card.id}
                          role="button"
                          tabIndex={0}
                          class={`board-card${dragging?.id === card.id ? ' board-card-dragging' : ''}`}
                          draggable={canMove}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              navigate(`/applications/${card.id}`);
                            }
                          }}
                          onDragStart={(e) => {
                            draggingRef.current = card;
                            setDragging(card);
                            // Firefox will not start a drag without payload.
                            e.dataTransfer?.setData('text/plain', card.id);
                            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                          }}
                          onDragEnd={() => {
                            draggingRef.current = null;
                            setDragging(null);
                            setOver(null);
                          }}
                          onClick={() => navigate(`/applications/${card.id}`)}>
                    <div class="name">{fullName(card)}</div>
                    <div class="amount num">
                      {compactMoney(card.amount_requested)}
                      {card.property_city ? ` · ${card.property_city}` : ''}
                    </div>
                    <div class="row">
                      {card.days_to_close?.days !== null && <Urgency value={card.days_to_close} />}
                    </div>
                    <div class="row">
                      <AvatarStack people={card.assignees} />
                      <span class="spacer" />
                      {card.awaiting_reply_since && <Badge tone="danger">Reply</Badge>}
                      {card.documents_outstanding > 0 && (
                        <Badge tone="warn">{card.documents_outstanding}</Badge>
                      )}
                    </div>
                  </div>
                ))}
                {col.count > col.cards.length && (
                  <div class="text-sm text-muted" style={{ textAlign: 'center', padding: 7 }}>
                    + {col.count - col.cards.length} more — open the list to see them all
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {moving && (
        <StageMoveNote
          card={moving.card}
          to={moving.to}
          onClose={() => setMoving(null)}
          onMoved={() => { setMoving(null); setNonce((n) => n + 1); }} />
      )}
    </div>
  );
}

/**
 * The note that goes with a stage change.
 *
 * Asked for every time, before anything moves. A file that jumped from Lead to
 * Funded with nobody able to say why is the thing a pipeline is supposed to
 * answer, and the cheapest moment to capture the reason is the moment somebody
 * had one.
 *
 * The note is kept twice on purpose: on the transition, which is how the board
 * reports on time-in-stage, and as a note on the file, which is where anybody
 * reading the client's history will actually look.
 */
function StageMoveNote({ card, to, onClose, onMoved }: {
  card: BoardCard; to: Stage; onClose: () => void; onMoved: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [blockers, setBlockers] = useState<Array<{ label: string; message: string }>>([]);

  const move = async (force = false) => {
    setBusy(true);
    setError('');
    try {
      await post(`/applications/${card.id}/stage`, {
        stage_key: to.key, reason: note.trim() || undefined, force,
      });
      toast(`${fullName(card)} moved to ${to.label}.`, 'ok');
      onMoved();
    } catch (err) {
      const e = err as { blockers?: Array<{ label: string; message: string }>; message?: string };
      setBlockers(e.blockers ?? []);
      setError(e.message ?? 'Could not move that file.');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Move to ${to.label}`} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" disabled={busy || !note.trim()} onClick={() => move()}>
          {busy ? 'Moving…' : 'Move file'}
        </button>
      </>
    }>
      {error && (
        <div class="alert alert-error">
          {error}
          {blockers.length > 0 && (
            <ul class="consequences">
              {blockers.map((b) => <li key={b.label}><strong>{b.label}</strong> — {b.message}</li>)}
            </ul>
          )}
        </div>
      )}
      <p class="text-sm text-muted">
        <strong>{fullName(card)}</strong> moves from <strong>{card.stage_label}</strong> to{' '}
        <strong>{to.label}</strong>.
      </p>
      <Field label="What changed?"
             hint="Kept on the file and in the stage history. Say what you would want to read in a month.">
        <textarea rows={3} value={note} autofocus
                  placeholder="Spoke to the client — documents are coming Friday, so this is ready for underwriting."
                  onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
      </Field>
    </Modal>
  );
}
