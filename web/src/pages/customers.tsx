/**
 * The customer list and the board — the same files, two ways of looking at them.
 *
 * On a phone the table becomes cards (see the CSS), because a broker standing
 * outside a client's house scrolling a nine-column table horizontally is not
 * using this product.
 */
import { useEffect, useState } from 'preact/hooks';
import { compactMoney, formatDate, post, relativeTime, ApiError } from '../lib/api.ts';
import { navigate, toast, useAsync, useDebounced, useRoute, type Config, type Session } from '../lib/store.ts';
import { AvatarStack, Badge, Empty, ErrorNote, Field, Icon, ICONS, Modal, Skeleton, Urgency } from '../components/ui.tsx';

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
};

const address = (r: Pick<Row, 'property_street_number' | 'property_street_name' | 'property_city'>) =>
  [[r.property_street_number, r.property_street_name].filter(Boolean).join(' '), r.property_city]
    .filter(Boolean).join(', ') || '—';

const fullName = (r: { first_name: string | null; last_name: string | null }) =>
  `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Unnamed';

export function CustomersPage({ session, config }: { session: Session; config: Config | null }) {
  const route = useRoute();
  const [term, setTerm] = useState('');
  const [stage, setStage] = useState('');
  const [creating, setCreating] = useState(route.query.get('new') === '1');
  const search = useDebounced(term, 250);

  const params = new URLSearchParams({ limit: '50' });
  if (search.trim()) params.set('q', search.trim());
  if (stage) params.set('stage', stage);

  const state = useAsync<{ customers: Row[]; total: number }>(`/customers?${params}`, [search, stage]);
  const canCreate = session.permissions.includes('customer.create');

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Customers</h1>
          <p>
            {state.status === 'ready'
              ? `${state.data.total} file${state.data.total === 1 ? '' : 's'}${stage ? ' in this stage' : ''}`
              : 'Loading…'}
          </p>
        </div>
        <div class="row">
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

      <div class="card" style={{ marginBottom: 14 }}>
        <div class="card-body row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}>
            <input value={term} placeholder="Name, email, phone, address or reference…"
                   aria-label="Search customers"
                   onInput={(e) => setTerm((e.target as HTMLInputElement).value)} />
          </div>
          <div style={{ flex: '0 1 200px' }}>
            <select value={stage} aria-label="Filter by stage"
                    onChange={(e) => setStage((e.target as HTMLSelectElement).value)}>
              <option value="">All stages</option>
              {config?.stages.filter((s) => s.active).map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </div>
          {(term || stage) && (
            <button class="btn btn-ghost" onClick={() => { setTerm(''); setStage(''); }}>Clear</button>
          )}
        </div>
      </div>

      <div class="card">
        {state.status === 'loading' && <Skeleton rows={6} />}
        {state.status === 'error' && (
          <div style={{ padding: 15 }}><ErrorNote error={state.error} onRetry={state.reload} /></div>
        )}
        {state.status === 'ready' && state.data.customers.length === 0 && (
          <Empty title={term || stage ? 'No files match those filters' : 'No customers yet'}
                 action={canCreate && !term && !stage
                   ? <button class="btn btn-primary" onClick={() => setCreating(true)}>New customer</button>
                   : undefined}>
            {term || stage
              ? 'Try a different search, or clear the filters.'
              : 'Files arrive automatically from apply.lendmax.ca once the portal mirror is connected, or you can create one by hand.'}
          </Empty>
        )}
        {state.status === 'ready' && state.data.customers.length > 0 && (
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Client</th><th>Stage</th><th>Mortgage</th><th>Subject property</th>
                  <th>Closing</th><th>Assigned</th><th>Flags</th><th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {state.data.customers.map((r) => (
                  <tr key={r.id} tabIndex={0} role="link"
                      onClick={() => navigate(`/applications/${r.id}`)}
                      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/applications/${r.id}`); }}>
                    <td data-primary>
                      <div class="cell-strong">{fullName(r)}</div>
                      <div class="cell-muted text-sm">{r.email ?? r.phone_e164 ?? '—'}</div>
                    </td>
                    <td data-label="Stage">
                      <span class="badge" style={r.stage_colour
                        ? { background: `${r.stage_colour}1f`, color: r.stage_colour } : undefined}>
                        {r.stage_label ?? 'No stage'}
                      </span>
                    </td>
                    <td data-label="Mortgage" class="num">{compactMoney(r.amount_requested)}</td>
                    <td data-label="Property">{address(r)}</td>
                    <td data-label="Closing">
                      <Urgency value={r.days_to_close}
                               settled={r.stage_category === 'won' || r.stage_category === 'lost'} />
                    </td>
                    <td data-label="Assigned"><AvatarStack people={r.assignees} /></td>
                    <td data-label="Flags">
                      <span class="row" style={{ gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {r.awaiting_reply_since && <Badge tone="danger">Awaiting reply</Badge>}
                        {r.documents_outstanding > 0 && (
                          <Badge tone="warn">{r.documents_outstanding} doc{r.documents_outstanding === 1 ? '' : 's'}</Badge>
                        )}
                        {r.scarlett_sync_state === 'error' && <Badge tone="danger">Scarlett</Badge>}
                        {r.percent_complete < 100 && <Badge>{r.percent_complete}%</Badge>}
                      </span>
                    </td>
                    <td data-label="Last activity" class="cell-muted">{relativeTime(r.last_activity_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && (
        <NewCustomer config={config}
                     onClose={() => setCreating(false)}
                     onCreated={(id) => { setCreating(false); navigate(`/applications/${id}`); }} />
      )}
    </div>
  );
}

function NewCustomer({ config, onClose, onCreated }: {
  config: Config | null; onClose: () => void; onCreated: (applicationId: string) => void;
}) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '',
    transaction_type_key: '', amount_requested: '',
  });
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
      const result = await post<{ application_id: string; possible_duplicates: typeof duplicates }>(
        '/customers',
        {
          first_name: form.first_name,
          last_name: form.last_name,
          email: form.email || undefined,
          phone: form.phone || undefined,
          transaction_type_key: form.transaction_type_key || undefined,
          amount_requested: form.amount_requested ? Number(form.amount_requested) : undefined,
        },
      );
      // A possible duplicate is reported, never merged silently — merging two
      // people's mortgage files because they share an address is not undoable.
      if (result.possible_duplicates?.length) {
        setDuplicates(result.possible_duplicates);
        toast(`Created — but ${result.possible_duplicates.length} similar record(s) already exist.`, 'info');
      }
      onCreated(result.application_id);
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setErrors(Object.fromEntries(err.fields.map((f) => [f.field, f.message])));
      } else {
        setErrors({ _: err instanceof Error ? err.message : 'Could not create the customer.' });
      }
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
          <Field label="Transaction type">
            <select value={form.transaction_type_key} onChange={set('transaction_type_key')}>
              <option value="">Not sure yet</option>
              {config?.transaction_types.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Mortgage requested">
            <input type="number" min="0" step="1000" value={form.amount_requested}
                   onInput={set('amount_requested')} placeholder="500000" />
          </Field>
        </div>
        <p class="text-sm text-muted mb-0">
          An email address or a phone number is needed — without one there is no way to reach them.
        </p>
      </form>
    </Modal>
  );
}

// ── The board ──────────────────────────────────────────────────────────────

type BoardData = {
  columns: Array<{
    stage: { key: string; label: string; colour: string | null; probability: number | null };
    count: number; value: number; weighted: number | null;
    cards: Array<Row & { customer_id: string }>;
  }>;
};

export function PipelinePage({ session }: { session: Session }) {
  const state = useAsync<BoardData>('/pipeline');
  const total = state.status === 'ready'
    ? state.data.columns.reduce((sum, c) => sum + (c.weighted ?? 0), 0) : 0;

  return (
    <div>
      <div class="page-head">
        <div>
          <h1>Pipeline</h1>
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

      {state.status === 'error' && <ErrorNote error={state.error} onRetry={state.reload} />}
      {state.status === 'loading' && <Skeleton rows={4} height={110} />}

      {state.status === 'ready' && (
        <div class="board">
          {state.data.columns.map((col) => (
            <section key={col.stage.key} class="board-col" aria-label={col.stage.label}>
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
                  <button key={card.id} class="board-card"
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
                  </button>
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
    </div>
  );
}
