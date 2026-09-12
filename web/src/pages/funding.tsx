/**
 * Funding, commission and renewals.
 *
 * Confirming a funding is the one irreversible-feeling action in the CRM, so
 * the screen says what it is about to do before it does it: the file becomes
 * funded, the commission becomes expected with its splits, and the renewal
 * appears with its milestones. Nobody should discover any of that afterwards.
 *
 * The split editor shows the arithmetic as it is typed. A split table whose
 * parts do not visibly sum to the whole is the fastest way to lose a broker's
 * confidence in every other number on the screen.
 */
import { useMemo, useState } from 'preact/hooks';
import { ApiError, formatDate, money, post, put, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, type Config, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Field, Modal, Skeleton } from '../components/ui.tsx';

type Funding = Record<string, any> | null;

type Commission = {
  id: string; status: string; source: string; lender_name: string | null;
  basis_bps: string | null; gross_expected: string | null; gross_received: string | null;
  expected_on: string | null; received_on: string | null;
  variance_amount: string | null; variance_note: string | null;
  reconciled_by_name: string | null;
  splits: Array<{
    id: string; party: string; user_id: string | null; party_name: string | null;
    percent: number | null; amount: string | null; paid_on: string | null;
  }>;
  variance_description: { amount: number | null; label: string; tone: string };
};

type Payload = {
  funding: Funding;
  submissions: Array<Record<string, any>>;
  lenders: Array<{ id: string; name: string; short_name: string | null; default_bps: string | null }>;
  commissions: Commission[];
  commission_hidden: boolean;
  renewal: Record<string, any> | null;
  amount_requested: string | null;
  can_edit: boolean;
  can_edit_commission: boolean;
};

export function FundingTab({ applicationId, session, config }: {
  applicationId: string; session: Session; config: Config | null;
}) {
  const state = useAsync<Payload>(`/applications/${applicationId}/funding`, [applicationId]);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reconciling, setReconciling] = useState<Commission | null>(null);

  if (state.status === 'loading') return <Skeleton rows={5} height={54} />;
  if (state.status === 'error') return <ErrorNote error={state.error} onRetry={state.reload} />;

  const d = state.data;
  const f = d.funding;
  const confirmed = f?.confirmed === true;

  return (
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <h2>Funding</h2>
          {f && <Badge tone={confirmed ? 'ok' : 'neutral'}>
            {confirmed ? 'Confirmed' : 'Recorded, not confirmed'}
          </Badge>}
        </div>
        <div class="card-body">
          {!f ? (
            <Empty title="No funding recorded">
              Funding is recorded from the lender's final figures, never carried over from
              what was requested — they routinely differ, and reporting the request as the
              funding makes every historical figure wrong.
            </Empty>
          ) : (
            <>
              <div class="client-facts">
                {([
                  ['Lender', f.lender_name ?? '—'],
                  ['Product', f.product_name ?? '—'],
                  ['Requested', money(d.amount_requested)],
                  ['Approved', money(f.approved_amount)],
                  ['Funded', money(f.funded_amount)],
                  ['Rate', f.rate ? `${Number(f.rate)}%${f.rate_type ? ` ${f.rate_type}` : ''}` : '—'],
                  ['Term', f.term_months ? `${f.term_months} months` : '—'],
                  ['Amortization', f.amortization_months
                    ? `${Math.round(f.amortization_months / 12 * 10) / 10} years` : '—'],
                  ['Payment', f.payment_amount
                    ? `${money(f.payment_amount)} ${f.payment_frequency ?? ''}` : '—'],
                  ['Insurance', f.insurance_status
                    ? `${f.insurance_status}${f.insurer ? ` · ${f.insurer}` : ''}` : '—'],
                  ['Funded on', formatDate(f.funding_date)],
                  ['Matures', formatDate(f.maturity_date)],
                ] as Array<[string, string]>).map(([label, value]) => (
                  <div key={label} class="fact">
                    <div class="label">{label}</div>
                    <div class="value">{value}</div>
                  </div>
                ))}
              </div>

              {/* The number a broker actually checks first. */}
              {f.funded_amount && d.amount_requested
                && Number(f.funded_amount) !== Number(d.amount_requested) && (
                <div class="alert alert-info">
                  The lender advanced {money(f.funded_amount)} against{' '}
                  {money(d.amount_requested)} requested — a difference of{' '}
                  {money(Math.abs(Number(f.funded_amount) - Number(d.amount_requested)))}.
                </div>
              )}

              {confirmed && (
                <div class="text-sm text-subtle">
                  Confirmed by {f.confirmed_by_name ?? 'somebody'} {relativeTime(f.confirmed_at)}.
                </div>
              )}
            </>
          )}

          {d.can_edit && (
            <div class="row" style={{ gap: 8, marginTop: 12 }}>
              <button class="btn" onClick={() => setEditing(true)}>
                {f ? 'Edit the figures' : 'Record the funding'}
              </button>
              {f && !confirmed && (
                <button class="btn btn-primary" onClick={() => setConfirming(true)}>
                  Confirm the funding
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {d.commission_hidden ? (
        <div class="card"><div class="card-body">
          <p class="text-muted">
            Commission on this file is not something your account can see.
          </p>
        </div></div>
      ) : d.commissions.length > 0 && (
        <div class="card">
          <div class="card-head"><h2>Commission</h2></div>
          <div class="card-body-flush">
            {d.commissions.map((c) => (
              <CommissionRow key={c.id} commission={c} canEdit={d.can_edit_commission}
                             onReconcile={() => setReconciling(c)} />
            ))}
          </div>
        </div>
      )}

      {d.renewal && <RenewalCard renewal={d.renewal} />}

      {editing && (
        <FundingForm applicationId={applicationId} existing={f} lenders={d.lenders}
                     onClose={() => setEditing(false)}
                     onSaved={() => { setEditing(false); state.reload(); }} />
      )}
      {confirming && f && (
        <ConfirmFunding applicationId={applicationId} funding={f} config={config}
                        onClose={() => setConfirming(false)}
                        onConfirmed={() => { setConfirming(false); state.reload(); }} />
      )}
      {reconciling && (
        <ReconcileForm commission={reconciling}
                       onClose={() => setReconciling(null)}
                       onSaved={() => { setReconciling(null); state.reload(); }} />
      )}
    </div>
  );
}

function CommissionRow({ commission: c, canEdit, onReconcile }: {
  commission: Commission; canEdit: boolean; onReconcile: () => void;
}) {
  const splitTotal = c.splits.reduce((s, x) => s + Number(x.amount ?? 0), 0);
  const gross = Number(c.gross_received ?? c.gross_expected ?? 0);

  return (
    <div class="commission-row">
      <div class="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <strong>{money(c.gross_expected)} expected</strong>
          {c.basis_bps && <span class="text-sm text-muted"> · {Number(c.basis_bps)}bps</span>}
          <div class="text-sm text-muted">
            {c.lender_name ?? 'No lender recorded'}
            {c.expected_on ? ` · due ${formatDate(c.expected_on)}` : ''}
            {c.received_on ? ` · received ${formatDate(c.received_on)}` : ''}
          </div>
        </div>
        <Badge tone={
          c.variance_description.tone === 'danger' ? 'danger'
            : c.variance_description.tone === 'warn' ? 'warn'
            : c.status === 'reconciled' || c.status === 'closed' ? 'ok' : 'neutral'
        }>
          {c.variance_description.label}
        </Badge>
      </div>

      {c.variance_note && (
        <div class="text-sm text-muted" style={{ marginTop: 6 }}>
          “{c.variance_note}”
          {c.reconciled_by_name ? ` — ${c.reconciled_by_name}` : ''}
        </div>
      )}

      {c.splits.length > 0 && (
        <div class="split-table">
          {c.splits.map((s) => (
            <div key={s.id} class="split-row">
              <span>{s.party_name ?? s.party}</span>
              <span class="text-sm text-muted">
                {s.percent !== null ? `${Number(s.percent)}%` : 'fixed'}
              </span>
              <span class="num">{money(s.amount)}</span>
            </div>
          ))}
          <div class="split-row split-total">
            <span>Total</span>
            <span />
            <span class="num">{money(splitTotal)}</span>
          </div>
          {Math.abs(splitTotal - gross) > 0.005 && (
            <div class="text-sm" style={{ color: 'var(--danger-text)' }}>
              The splits come to {money(splitTotal)} against {money(gross)}.
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <button class="btn btn-sm" style={{ marginTop: 10 }} onClick={onReconcile}>
          Record what arrived
        </button>
      )}
    </div>
  );
}

function RenewalCard({ renewal: r }: { renewal: Record<string, any> }) {
  const milestones = (r.milestones ?? []) as Array<{
    key: string; due_on: string; status: string; skip_reason?: string;
  }>;
  return (
    <div class="card">
      <div class="card-head">
        <h2>Renewal</h2>
        <Badge tone={r.status === 'renewed_with_us' ? 'ok'
          : r.status === 'lost_to_other' ? 'danger' : 'neutral'}>
          {String(r.status).replace(/_/g, ' ')}
        </Badge>
      </div>
      <div class="card-body">
        <p>
          Matures {formatDate(r.maturity_date)}
          {r.lender_name ? ` with ${r.lender_name}` : ''}
          {r.assigned_to_name ? ` · ${r.assigned_to_name}` : ''}
        </p>
        <div class="milestone-track">
          {milestones.map((m) => (
            <div key={m.key} class={`milestone milestone-${m.status}`}>
              <div class="milestone-dot" aria-hidden="true" />
              <div class="text-sm">
                <strong>{MILESTONE_LABELS[m.key] ?? m.key}</strong>
                <div class="text-muted">
                  {formatDate(m.due_on)} · {m.status}
                </div>
              </div>
            </div>
          ))}
        </div>
        {r.outcome_note && <p class="text-sm text-muted">“{r.outcome_note}”</p>}
        <button class="btn btn-sm" onClick={() => navigate('/renewals')}>
          All renewals
        </button>
      </div>
    </div>
  );
}

const MILESTONE_LABELS: Record<string, string> = {
  t_minus_6m: 'Six months out',
  t_minus_3m: 'Three months out',
  t_minus_45d: 'Forty-five days out',
};

// ── Forms ──────────────────────────────────────────────────────────────────

function FundingForm({ applicationId, existing, lenders, onClose, onSaved }: {
  applicationId: string; existing: Funding;
  lenders: Payload['lenders']; onClose: () => void; onSaved: () => void;
}) {
  const e = existing ?? {};
  const [form, setForm] = useState({
    lender_id: String(e.lender_id ?? ''),
    lender_name: String(e.lender_name ?? ''),
    product_name: String(e.product_name ?? ''),
    approved_amount: String(e.approved_amount ?? ''),
    funded_amount: String(e.funded_amount ?? ''),
    rate: String(e.rate ?? ''),
    rate_type: String(e.rate_type ?? 'fixed'),
    term_months: String(e.term_months ?? ''),
    amortization_months: String(e.amortization_months ?? ''),
    payment_frequency: String(e.payment_frequency ?? 'monthly'),
    payment_amount: String(e.payment_amount ?? ''),
    insurance_status: String(e.insurance_status ?? ''),
    insurer: String(e.insurer ?? ''),
    insurance_premium: String(e.insurance_premium ?? ''),
    funding_date: String(e.funding_date ?? ''),
    maturity_date: String(e.maturity_date ?? ''),
    first_payment_date: String(e.first_payment_date ?? ''),
    lender_fee: String(e.lender_fee ?? ''),
    brokerage_fee: String(e.brokerage_fee ?? ''),
    note: String(e.note ?? ''),
  });
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<string[]>([]);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const save = async () => {
    setError(''); setDetail([]);
    try {
      const result = await put<{ maturity_date: string | null }>(
        `/applications/${applicationId}/funding`, {
          ...form,
          lender_id: form.lender_id || null,
          rate: form.rate === '' ? null : Number(form.rate),
          rate_type: form.rate_type || null,
          term_months: form.term_months === '' ? null : Number(form.term_months),
          amortization_months: form.amortization_months === ''
            ? null : Number(form.amortization_months),
          insurance_status: form.insurance_status || null,
          insurer: form.insurer || null,
          funding_date: form.funding_date || null,
          maturity_date: form.maturity_date || null,
          first_payment_date: form.first_payment_date || null,
        });
      toast(result.maturity_date
        ? `Saved. Maturing ${formatDate(result.maturity_date)}.`
        : 'Saved.', 'ok');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setDetail((err.detail as string[] | undefined) ?? []);
      } else setError('Could not save that.');
    }
  };

  const text = (name: keyof typeof form, label: string, hint?: string, type = 'text') => (
    <Field label={label} hint={hint}>
      <input type={type} value={String(form[name])}
             onInput={(ev) => set({ [name]: (ev.target as HTMLInputElement).value } as never)} />
    </Field>
  );

  return (
    <Modal title="Funding figures" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={save}>Save</button>
      </>
    }>
      {error && (
        <div class="alert alert-error">
          {error}
          {detail.length > 1 && <ul>{detail.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}
      <p class="text-sm text-muted">
        The lender's final figures, not what was requested.
      </p>

      <Field label="Lender">
        <select value={form.lender_id}
                onChange={(ev) => {
                  const id = (ev.target as HTMLSelectElement).value;
                  const lender = lenders.find((l) => l.id === id);
                  set({ lender_id: id, lender_name: lender?.name ?? form.lender_name });
                }}>
          <option value="">Not on the list — type it below</option>
          {lenders.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
      {!form.lender_id && text('lender_name', 'Lender name')}
      {text('product_name', 'Product')}

      <div class="grid-2">
        {text('approved_amount', 'Approved amount')}
        {text('funded_amount', 'Funded amount', 'What the lender actually advanced.')}
      </div>
      <div class="grid-3">
        {text('rate', 'Rate (%)', '4.89, not 0.0489.')}
        <Field label="Rate type">
          <select value={form.rate_type}
                  onChange={(ev) => set({ rate_type: (ev.target as HTMLSelectElement).value })}>
            {['fixed', 'variable', 'adjustable'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        {text('term_months', 'Term (months)', undefined, 'number')}
      </div>
      <div class="grid-3">
        {text('amortization_months', 'Amortization (months)', undefined, 'number')}
        {text('payment_amount', 'Payment')}
        <Field label="Frequency">
          <select value={form.payment_frequency}
                  onChange={(ev) => set({ payment_frequency: (ev.target as HTMLSelectElement).value })}>
            {['monthly', 'semi-monthly', 'bi-weekly', 'accelerated bi-weekly', 'weekly']
              .map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>

      <h3 class="sub-heading">Insurance</h3>
      <div class="grid-3">
        <Field label="Status" hint="Insured, insurable and uninsured are three different things.">
          <select value={form.insurance_status}
                  onChange={(ev) => set({ insurance_status: (ev.target as HTMLSelectElement).value })}>
            <option value="">Not recorded</option>
            <option value="insured">Insured</option>
            <option value="insurable">Insurable</option>
            <option value="uninsured">Uninsured</option>
          </select>
        </Field>
        <Field label="Insurer">
          <select value={form.insurer} disabled={form.insurance_status === 'uninsured'}
                  onChange={(ev) => set({ insurer: (ev.target as HTMLSelectElement).value })}>
            <option value="">—</option>
            {['CMHC', 'Sagen', 'Canada Guaranty'].map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </Field>
        {text('insurance_premium', 'Premium')}
      </div>

      <h3 class="sub-heading">Dates</h3>
      <div class="grid-3">
        {text('funding_date', 'Funded on', undefined, 'date')}
        {text('maturity_date', 'Matures', 'Left blank, this follows from the term.', 'date')}
        {text('first_payment_date', 'First payment', undefined, 'date')}
      </div>

      <div class="grid-2">
        {text('lender_fee', 'Lender fee')}
        {text('brokerage_fee', 'Brokerage fee')}
      </div>
    </Modal>
  );
}

/**
 * Confirming, and the split editor.
 *
 * The arithmetic is shown as it is typed, and the confirmation says what it
 * is about to cause before it causes it.
 */
function ConfirmFunding({ applicationId, funding, config, onClose, onConfirmed }: {
  applicationId: string; funding: Record<string, any>; config: Config | null;
  onClose: () => void; onConfirmed: () => void;
}) {
  // The user list is already on the config the app loads once; fetching it
  // again here would be a second round trip for a dropdown.
  const users = config?.users ?? [];
  const [bps, setBps] = useState('85');
  const [expectedOn, setExpectedOn] = useState('');
  const [splits, setSplits] = useState<Array<{
    party: string; user_id?: string; party_name?: string; percent?: string; amount?: string;
  }>>([{ party: 'broker', percent: '70' }, { party: 'brokerage', percent: '30' }]);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const funded = Number(funding.funded_amount ?? 0);
  const gross = useMemo(
    () => (bps === '' ? 0 : Math.round(funded * Number(bps)) / 10_000),
    [funded, bps]);

  // The same arithmetic the server will do, shown while it is being typed —
  // including that a fixed amount comes off the top and the percentages
  // divide what is left.
  const preview = useMemo(() => {
    const fixed = splits.filter((s) => s.amount !== undefined && s.amount !== '');
    const proportional = splits.filter((s) => s.amount === undefined || s.amount === '');
    const percentTotal = proportional.reduce((sum, s) => sum + Number(s.percent || 0), 0);
    const fixedTotal = fixed.reduce((sum, s) => sum + Number(s.amount || 0), 0);
    const pool = Math.max(gross - fixedTotal, 0);
    const rows = splits.map((s) => ({
      ...s,
      computed: s.amount !== undefined && s.amount !== ''
        ? Number(s.amount)
        : Math.round(pool * Number(s.percent || 0)) / 100,
    }));
    const total = rows.reduce((sum, r) => sum + r.computed, 0);
    return {
      rows, total, percentTotal, fixedTotal, pool,
      balanced: fixedTotal <= gross
        && (proportional.length === 0 || Math.abs(percentTotal - 100) < 0.0001),
    };
  }, [splits, gross]);

  const confirm = async () => {
    setBusy(true); setError(''); setDetail([]);
    try {
      await post(`/applications/${applicationId}/funding/confirm`, {
        commission_bps: bps === '' ? null : Number(bps),
        expected_on: expectedOn || null,
        splits: splits.map((s) => ({
          party: s.party,
          user_id: s.user_id || null,
          party_name: s.party_name || undefined,
          percent: s.amount ? null : Number(s.percent || 0),
          amount: s.amount || null,
        })),
      });
      toast('Funded. The commission and the renewal are on the file.', 'ok');
      onConfirmed();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setDetail((err.detail as string[] | undefined) ?? []);
      } else setError('Could not confirm that.');
      setBusy(false);
    }
  };

  return (
    <Modal title="Confirm the funding" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" disabled={busy || !preview.balanced} onClick={confirm}>
          {busy ? 'Confirming…' : 'Confirm'}
        </button>
      </>
    }>
      {error && (
        <div class="alert alert-error">
          {error}
          {detail.length > 1 && <ul>{detail.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}

      <div class="alert alert-info">
        <strong>This does four things at once.</strong>
        <ul>
          <li>The file moves to Funded, with a transition recording why.</li>
          <li>The commission below becomes expected, with its splits.</li>
          <li>
            The renewal appears, maturing{' '}
            {funding.maturity_date ? formatDate(funding.maturity_date) : 'on the computed date'},
            with its milestones.
          </li>
          <li>Any automation waiting on a funding is told.</li>
        </ul>
      </div>

      <div class="grid-2">
        <Field label="Commission (bps)" hint={`On ${money(funded)} funded.`}>
          <input type="number" value={bps} step="0.25"
                 onInput={(e) => setBps((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Expected on">
          <input type="date" value={expectedOn}
                 onInput={(e) => setExpectedOn((e.target as HTMLInputElement).value)} />
        </Field>
      </div>
      <p class="text-sm">
        Gross commission: <strong class="num">{money(gross)}</strong>
      </p>

      <h3 class="sub-heading">Splits</h3>
      <div class="stack-tight">
        {splits.map((s, i) => (
          <div key={i} class="condition-row">
            <select value={s.party}
                    onChange={(e) => setSplits(splits.map((x, j) =>
                      (j === i ? { ...x, party: (e.target as HTMLSelectElement).value } : x)))}>
              {['broker', 'brokerage', 'referrer', 'house', 'other'].map((p) =>
                <option key={p} value={p}>{p}</option>)}
            </select>
            {s.party === 'broker' ? (
              <select value={s.user_id ?? ''}
                      onChange={(e) => setSplits(splits.map((x, j) =>
                        (j === i ? { ...x, user_id: (e.target as HTMLSelectElement).value } : x)))}>
                <option value="">Who?</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            ) : (
              <input placeholder="Name" value={s.party_name ?? ''}
                     onInput={(e) => setSplits(splits.map((x, j) =>
                       (j === i ? { ...x, party_name: (e.target as HTMLInputElement).value } : x)))} />
            )}
            <input placeholder="%" type="number" value={s.percent ?? ''}
                   disabled={!!s.amount}
                   onInput={(e) => setSplits(splits.map((x, j) =>
                     (j === i ? { ...x, percent: (e.target as HTMLInputElement).value } : x)))} />
            <input placeholder="or fixed $" value={s.amount ?? ''}
                   onInput={(e) => setSplits(splits.map((x, j) =>
                     (j === i ? { ...x, amount: (e.target as HTMLInputElement).value } : x)))} />
            <span class="num split-preview">
              {money(preview.rows[i]?.computed ?? 0)}
            </span>
            <button class="btn btn-sm btn-ghost"
                    onClick={() => setSplits(splits.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button class="btn btn-sm" onClick={() => setSplits([...splits, { party: 'referrer' }])}>
          Add a party
        </button>
      </div>

      <div class={`split-check${preview.balanced ? '' : ' split-check-bad'}`}>
        {preview.balanced ? (
          <>
            The splits allocate <strong class="num">{money(preview.total)}</strong>{' '}
            of {money(gross)}.
            {preview.fixedTotal > 0 && (
              <div class="text-sm text-muted">
                {money(preview.fixedTotal)} comes off the top; the percentages divide the{' '}
                {money(preview.pool)} left.
              </div>
            )}
          </>
        ) : preview.fixedTotal > gross ? (
          <>The fixed amounts come to {money(preview.fixedTotal)}, more than the
            commission itself.</>
        ) : (
          <>The percentages come to {Math.round(preview.percentTotal * 100) / 100}%.
            They have to come to 100 before this can be confirmed.</>
        )}
      </div>
    </Modal>
  );
}

function ReconcileForm({ commission, onClose, onSaved }: {
  commission: Commission; onClose: () => void; onSaved: () => void;
}) {
  const [received, setReceived] = useState(commission.gross_received ?? '');
  const [receivedOn, setReceivedOn] = useState(
    commission.received_on ?? new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState(commission.status);
  const [note, setNote] = useState(commission.variance_note ?? '');
  const [error, setError] = useState('');

  const expected = Number(commission.gross_expected ?? 0);
  const difference = received === '' ? null : Number(received) - expected;

  const save = async () => {
    setError('');
    try {
      const result = await put<{ status: string; variance: { label: string } }>(
        `/commissions/${commission.id}`, {
          gross_received: received === '' ? null : received,
          received_on: receivedOn || null,
          status,
          variance_note: note || undefined,
        });
      toast(`${result.variance.label}. Recorded as ${result.status.replace(/_/g, ' ')}.`, 'ok');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    }
  };

  return (
    <Modal title="Record what arrived" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={save}>Save</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <div class="grid-2">
        <Field label="Expected"><input value={money(commission.gross_expected)} disabled /></Field>
        <Field label="Received">
          <input value={received} autofocus
                 onInput={(e) => setReceived((e.target as HTMLInputElement).value)} />
        </Field>
      </div>
      {difference !== null && Math.abs(difference) > 0.005 && (
        <div class={`alert alert-${difference < 0 ? 'error' : 'warn'}`}>
          {difference < 0
            ? `Short by ${money(-difference)}.`
            : `Over by ${money(difference)}.`}{' '}
          This cannot be marked reconciled until you record what happened.
        </div>
      )}
      <div class="grid-2">
        <Field label="Received on">
          <input type="date" value={receivedOn}
                 onInput={(e) => setReceivedOn((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}>
            {['expected', 'submitted', 'awaiting_payment', 'received', 'variance',
              'reconciled', 'closed'].map((s) =>
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
      </div>
      <Field label="What happened"
             hint="Required when the amount does not match. Read at the next reconciliation.">
        <textarea rows={3} value={note}
                  onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
      </Field>
    </Modal>
  );
}

// ── The renewals pipeline ──────────────────────────────────────────────────

type Renewal = {
  id: string; maturity_date: string; maturity_source: string; lender_name: string | null;
  balance_estimate: string | null; rate: string | null; status: string;
  outcome_note: string | null; days_to_maturity: number;
  customer_id: string; first_name: string; last_name: string;
  application_id: string | null; portal_reference: string | null;
  assigned_to_name: string | null;
  milestones: Array<{ key: string; due_on: string; status: string }> | null;
  milestones_due: number;
};

export function RenewalsPage({ session }: { session: Session }) {
  const [window, setWindow] = useState('180');
  const [status, setStatus] = useState('open');
  const state = useAsync<{ renewals: Renewal[]; counts: Record<string, string | number> }>(
    `/renewals?window=${window}&status=${status}`, [window, status]);
  const [resolving, setResolving] = useState<Renewal | null>(null);
  const canEdit = session.permissions.includes('customer.edit');

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Renewals</h1>
          <p>
            Every mortgage with a known maturity, whether we funded it or the client told us
            about it. A renewal that resolves stops its own reminders.
          </p>
        </div>
      </div>

      {state.status === 'loading' && <Skeleton rows={5} height={60} />}
      {state.status === 'error' && <ErrorNote error={state.error} onRetry={state.reload} />}

      {state.status === 'ready' && (
        <>
          <div class="kpi-grid">
            {([
              ['within_90', 'Maturing in 90 days'],
              ['within_180', 'Maturing in 180 days'],
              ['volume_180', 'Volume (180 days)'],
              ['renewed_ytd', 'Renewed this year'],
              ['lost_ytd', 'Lost this year'],
            ] as Array<[string, string]>).map(([key, label]) => (
              <div key={key} class="card kpi">
                <div class="label">{label}</div>
                <div class="value num">
                  {key === 'volume_180'
                    ? money(state.data.counts[key])
                    : state.data.counts[key] ?? 0}
                </div>
              </div>
            ))}
          </div>

          <div class="card" style={{ marginTop: 16 }}>
            <div class="card-head">
              <h2>Pipeline</h2>
              <div class="row" style={{ gap: 8 }}>
                <select value={window} onChange={(e) => setWindow((e.target as HTMLSelectElement).value)}>
                  <option value="90">Next 90 days</option>
                  <option value="180">Next 180 days</option>
                  <option value="365">Next year</option>
                  <option value="all">All</option>
                </select>
                <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}>
                  <option value="open">Open</option>
                  <option value="upcoming">Upcoming</option>
                  <option value="engaged">Engaged</option>
                  <option value="in_progress">In progress</option>
                  <option value="resolved">Resolved</option>
                  <option value="all">All</option>
                </select>
              </div>
            </div>
            <div class="card-body-flush">
              {state.data.renewals.length === 0 ? (
                <Empty title="Nothing maturing in that window">
                  A renewal is created when a funding is confirmed, and when a client tells us
                  about a mortgage we did not arrange.
                </Empty>
              ) : state.data.renewals.map((r) => (
                <div key={r.id} class="list-row">
                  <div style={{ minWidth: 0 }}>
                    <button class="link-button"
                            onClick={() => r.application_id
                              && navigate(`/applications/${r.application_id}`)}>
                      {r.first_name} {r.last_name}
                    </button>
                    <div class="text-sm text-muted">
                      {formatDate(r.maturity_date)}
                      {' · '}
                      {r.days_to_maturity < 0
                        ? `${Math.abs(r.days_to_maturity)} days ago`
                        : `in ${r.days_to_maturity} days`}
                      {r.lender_name ? ` · ${r.lender_name}` : ''}
                      {r.balance_estimate ? ` · ${money(r.balance_estimate)}` : ''}
                      {r.assigned_to_name ? ` · ${r.assigned_to_name}` : ' · unassigned'}
                    </div>
                    {r.outcome_note && (
                      <div class="text-sm text-subtle">“{r.outcome_note}”</div>
                    )}
                  </div>
                  <div class="row" style={{ gap: 8 }}>
                    {r.milestones_due > 0 && (
                      <Badge tone="warn">{r.milestones_due} milestone(s) due</Badge>
                    )}
                    <Badge tone={r.status === 'renewed_with_us' ? 'ok'
                      : r.status === 'lost_to_other' ? 'danger' : 'neutral'}>
                      {r.status.replace(/_/g, ' ')}
                    </Badge>
                    {canEdit && !['renewed_with_us', 'lost_to_other', 'paid_out', 'declined',
                                  'cancelled'].includes(r.status) && (
                      <button class="btn btn-sm" onClick={() => setResolving(r)}>Update</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {resolving && (
        <RenewalForm renewal={resolving} onClose={() => setResolving(null)}
                     onSaved={() => { setResolving(null); state.reload(); }} />
      )}
    </div>
  );
}

function RenewalForm({ renewal, onClose, onSaved }: {
  renewal: Renewal; onClose: () => void; onSaved: () => void;
}) {
  const [status, setStatus] = useState(renewal.status);
  const [note, setNote] = useState(renewal.outcome_note ?? '');
  const [balance, setBalance] = useState(renewal.balance_estimate ?? '');
  const [error, setError] = useState('');

  const RESOLVED = ['renewed_with_us', 'lost_to_other', 'paid_out', 'declined', 'cancelled'];
  const resolving = RESOLVED.includes(status);

  const save = async () => {
    setError('');
    try {
      const result = await post<{ milestones_stopped: boolean }>(`/renewals/${renewal.id}`, {
        status, outcome_note: note || undefined,
        balance_estimate: balance === '' ? null : balance,
      });
      toast(result.milestones_stopped
        ? 'Resolved. The remaining reminders are cancelled.'
        : 'Updated.', 'ok');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    }
  };

  return (
    <Modal title={`${renewal.first_name} ${renewal.last_name}`} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={save}>Save</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <p class="text-sm text-muted">
        Maturing {formatDate(renewal.maturity_date)}
        {renewal.lender_name ? ` with ${renewal.lender_name}` : ''}.
      </p>
      <Field label="Where it stands">
        <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}>
          <option value="upcoming">Upcoming — not contacted yet</option>
          <option value="engaged">Engaged — the client is talking to us</option>
          <option value="in_progress">In progress — a new file is open</option>
          <option value="renewed_with_us">Renewed with us</option>
          <option value="lost_to_other">Lost to another broker or the lender</option>
          <option value="paid_out">Paid out</option>
          <option value="declined">The client declined</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </Field>
      {resolving && (
        <div class="alert alert-info">
          Resolving this cancels every reminder still to go out on it.
        </div>
      )}
      <Field label="Balance estimate">
        <input value={balance} onInput={(e) => setBalance((e.target as HTMLInputElement).value)} />
      </Field>
      <Field
        label="Note"
        hint={status === 'lost_to_other'
          ? 'Where it went. A renewal lost with no reason teaches the brokerage nothing.'
          : 'Optional.'}
      >
        <textarea rows={3} value={note}
                  onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
      </Field>
    </Modal>
  );
}
