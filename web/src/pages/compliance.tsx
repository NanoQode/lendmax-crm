/**
 * Compliance: the review queue, and the tab on a file.
 *
 * The risk meter is the piece this screen exists for, and it is drawn as its
 * FACTORS with the meter beside them, not as a meter you can click to reveal
 * the factors. A rating a reviewer cannot defend is worse than no rating —
 * it looks like diligence and answers no question — so the explanation is
 * the primary content and the number is the summary.
 *
 * Nothing on this screen is client-facing, and nothing here is ever shown to
 * a client. The escalation control says "escalate to compliance" and stops
 * there; what happens next happens off-system.
 */
import { useState } from 'preact/hooks';
import { ApiError, formatDate, formatDateTime, money, post, put, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Field, Modal, Skeleton } from '../components/ui.tsx';

type ChecklistItem = {
  id: string; item_key: string; group_key: string | null; label: string;
  required: boolean; status: string; note: string | null;
  completed_at: string | null; completed_by_name: string | null;
  derived: boolean; derived_complete: boolean | null; evidence: string | null;
  complete: boolean;
};

type Factor = {
  key: string; label: string; triggered: boolean; value: string;
  weight: number; points: number; note: string; unknown: boolean;
};

type Risk = {
  id: string; score: string; rating: string; factors: Factor[]; model_version: number;
  computed_at: string; overridden: boolean; override_rating: string | null;
  override_reason: string | null; overridden_at: string | null; overridden_by_name: string | null;
};

type Payload = {
  case: {
    id: string; status: string; province: string; checklist_key: string | null;
    legal_hold: boolean;
  };
  checklist: ChecklistItem[];
  groups: string[];
  risk: Risk | null;
  fintrac: Record<string, unknown> | null;
  suitability: Record<string, unknown> | null;
  identities: Array<Record<string, unknown>>;
  applicants: Array<{ id: string; first_name: string; last_name: string }>;
  blockers: string[];
  can_approve: boolean;
  can_edit: boolean;
};

const GROUP_LABELS: Record<string, string> = {
  application: 'The application',
  consent: 'Consent',
  fintrac: 'FINTRAC',
  disclosure: 'Disclosure',
  suitability: 'Suitability',
  credit: 'Credit',
  income: 'Income',
  lender: 'Lender',
  property: 'Property',
  funding: 'Funding',
  file: 'The file',
  other: 'Other',
};

const RATING_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  low: 'ok', medium: 'warn', high: 'danger', review_required: 'neutral',
};
const RATING_LABEL: Record<string, string> = {
  low: 'Low', medium: 'Medium', high: 'High', review_required: 'Needs review',
};

// ── The tab on a file ──────────────────────────────────────────────────────

export function ComplianceTab({ applicationId, session }: {
  applicationId: string; session: Session;
}) {
  const state = useAsync<Payload>(`/applications/${applicationId}/compliance`, [applicationId]);
  const [editing, setEditing] = useState<'fintrac' | 'suitability' | 'identity' | null>(null);
  const [deciding, setDeciding] = useState(false);

  if (state.status === 'loading') return <Skeleton rows={6} height={54} />;
  if (state.status === 'error') return <ErrorNote error={state.error} onRetry={state.reload} />;

  const data = state.data;
  const rating = data.risk?.override_rating ?? data.risk?.rating ?? 'review_required';

  return (
    <div class="stack">
      <div class="grid-2" style={{ alignItems: 'start' }}>
        <RiskMeter risk={data.risk} applicationId={applicationId} session={session}
                   onChanged={state.reload} />

        <div class="card">
          <div class="card-head">
            <h2>Where this file stands</h2>
            <Badge tone={
              data.case.status === 'approved' ? 'ok'
                : data.case.status === 'rejected' ? 'danger'
                : data.case.status === 'changes_requested' ? 'warn' : 'neutral'
            }>
              {data.case.status.replace(/_/g, ' ')}
            </Badge>
          </div>
          <div class="card-body">
            {data.blockers.length === 0 ? (
              <p class="text-ok">Everything required is on file.</p>
            ) : (
              <>
                <p class="text-sm text-muted">
                  {data.blockers.length === 1
                    ? 'One thing is outstanding before this can be approved:'
                    : `${data.blockers.length} things are outstanding before this can be approved:`}
                </p>
                <ul class="blocker-list">
                  {data.blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
              </>
            )}

            {data.case.legal_hold && (
              <div class="alert alert-warn">
                <strong>Legal hold.</strong> Nothing on this file will be deleted or
                anonymised by retention while the hold stands.
              </div>
            )}

            <div class="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {session.permissions.includes('compliance.review') && (
                <button class="btn btn-primary" onClick={() => setDeciding(true)}>
                  Record a decision
                </button>
              )}
              {session.permissions.includes('compliance.legal_hold') && (
                <LegalHoldButton applicationId={applicationId} held={data.case.legal_hold}
                                 onChanged={state.reload} />
              )}
              {data.can_edit && (
                <EscalateButton applicationId={applicationId}
                                escalated={data.fintrac?.escalated === true}
                                onChanged={state.reload} />
              )}
            </div>
          </div>
        </div>
      </div>

      <Checklist items={data.checklist} groups={data.groups} canEdit={data.can_edit}
                 onChanged={state.reload} />

      <div class="grid-2" style={{ alignItems: 'start' }}>
        <FintracCard data={data} onEdit={() => setEditing('fintrac')} />
        <IdentityCard data={data} onAdd={() => setEditing('identity')} />
      </div>

      <SuitabilityCard data={data} onEdit={() => setEditing('suitability')} />

      {editing === 'fintrac' && (
        <FintracForm applicationId={applicationId} existing={data.fintrac}
                     onClose={() => setEditing(null)}
                     onSaved={() => { setEditing(null); state.reload(); }} />
      )}
      {editing === 'identity' && (
        <IdentityForm applicationId={applicationId} applicants={data.applicants}
                      onClose={() => setEditing(null)}
                      onSaved={() => { setEditing(null); state.reload(); }} />
      )}
      {editing === 'suitability' && (
        <SuitabilityForm applicationId={applicationId} existing={data.suitability}
                         onClose={() => setEditing(null)}
                         onSaved={() => { setEditing(null); state.reload(); }} />
      )}
      {deciding && (
        <DecisionForm applicationId={applicationId} blockers={data.blockers}
                      rating={rating}
                      onClose={() => setDeciding(false)}
                      onDecided={() => { setDeciding(false); state.reload(); }} />
      )}
    </div>
  );
}

/**
 * The meter, drawn as its factors.
 *
 * The unanswered ones come first and are marked as unanswered rather than
 * being shown as zero: "nobody has screened this" and "screened, no match"
 * are different facts, and a meter that renders them the same is the reason
 * a file nobody assessed reads as low risk.
 */
function RiskMeter({ risk, applicationId, session, onChanged }: {
  risk: Risk | null; applicationId: string; session: Session; onChanged: () => void;
}) {
  const [overriding, setOverriding] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!risk) {
    return (
      <div class="card">
        <div class="card-head"><h2>Risk</h2></div>
        <div class="card-body">
          <Empty title="Not assessed">This file has not been assessed.</Empty>
        </div>
      </div>
    );
  }

  const effective = risk.override_rating ?? risk.rating;
  const unanswered = risk.factors.filter((f) => f.unknown);
  const triggered = risk.factors.filter((f) => f.triggered && !f.unknown)
    .sort((a, b) => b.points - a.points);
  const clear = risk.factors.filter((f) => !f.triggered && !f.unknown);

  const reassess = async () => {
    setBusy(true);
    try {
      await post(`/applications/${applicationId}/risk/reassess`);
      toast('Reassessed.', 'ok');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not reassess.', 'error');
    } finally { setBusy(false); }
  };

  return (
    <div class="card">
      <div class="card-head">
        <h2>Risk</h2>
        <Badge tone={RATING_TONE[effective] ?? 'neutral'}>{RATING_LABEL[effective] ?? effective}</Badge>
      </div>
      <div class="card-body">
        <div class="risk-head">
          <div>
            <div class="risk-score num">{Number(risk.score)}</div>
            <div class="text-sm text-muted">points, model v{risk.model_version}</div>
          </div>
          <div class="text-sm text-muted">
            {risk.overridden ? (
              <>
                <strong>Rated {RATING_LABEL[risk.override_rating ?? ''] ?? risk.override_rating}
                  {' '}by {risk.overridden_by_name ?? 'a reviewer'}</strong>
                <div>{risk.override_reason}</div>
                <div class="text-subtle">
                  The model said {RATING_LABEL[risk.rating] ?? risk.rating}.
                </div>
              </>
            ) : (
              <>Computed {relativeTime(risk.computed_at)}. This is the model's suggestion —
                a person makes the determination.</>
            )}
          </div>
        </div>

        {unanswered.length > 0 && (
          <div class="alert alert-warn">
            <strong>{unanswered.length} determination(s) have not been made.</strong> An
            unanswered question is not a low-risk answer, so this file reads as needing review
            until they are.
          </div>
        )}

        <div class="factor-list">
          {[...unanswered, ...triggered, ...clear].map((f) => (
            <div key={f.key} class={`factor factor-${f.unknown ? 'unknown' : f.triggered ? 'on' : 'off'}`}>
              <span class="factor-mark" aria-hidden="true">
                {f.unknown ? '?' : f.triggered ? '●' : '○'}
              </span>
              <div>
                <div class="factor-label">
                  {f.label}
                  {f.triggered && <span class="factor-points num">+{f.points}</span>}
                </div>
                <div class="text-sm text-muted">{f.note}</div>
              </div>
            </div>
          ))}
        </div>

        <div class="row" style={{ gap: 8, marginTop: 12 }}>
          {session.permissions.includes('compliance.edit') && (
            <button class="btn btn-sm" disabled={busy} onClick={reassess}>
              {busy ? 'Reassessing…' : 'Reassess'}
            </button>
          )}
          {session.permissions.includes('compliance.review') && (
            <button class="btn btn-sm" onClick={() => setOverriding(true)}>
              Rate it yourself
            </button>
          )}
        </div>
      </div>

      {overriding && (
        <OverrideForm applicationId={applicationId} modelRating={risk.rating}
                      onClose={() => setOverriding(false)}
                      onSaved={() => { setOverriding(false); onChanged(); }} />
      )}
    </div>
  );
}

function OverrideForm({ applicationId, modelRating, onClose, onSaved }: {
  applicationId: string; modelRating: string; onClose: () => void; onSaved: () => void;
}) {
  const [rating, setRating] = useState(modelRating === 'review_required' ? 'medium' : modelRating);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const save = async () => {
    try {
      await post(`/applications/${applicationId}/risk/override`, { rating, reason });
      toast('Rating recorded.', 'ok');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    }
  };

  return (
    <Modal title="Rate this file" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={save}>Record the rating</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <p class="text-sm text-muted">
        Your rating is recorded beside the model's, not instead of it. The model said{' '}
        <strong>{RATING_LABEL[modelRating] ?? modelRating}</strong>.
      </p>
      <Field label="Rating">
        <select value={rating} onChange={(e) => setRating((e.target as HTMLSelectElement).value)}>
          {['low', 'medium', 'high', 'review_required'].map((r) =>
            <option key={r} value={r}>{RATING_LABEL[r]}</option>)}
        </select>
      </Field>
      <Field label="Why" hint="Read by the next reviewer, and by an auditor.">
        <textarea rows={3} value={reason} autofocus
                  onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
      </Field>
    </Modal>
  );
}

// ── The checklist ──────────────────────────────────────────────────────────

function Checklist({ items, groups, canEdit, onChanged }: {
  items: ChecklistItem[]; groups: string[]; canEdit: boolean; onChanged: () => void;
}) {
  const required = items.filter((i) => i.required);
  const done = required.filter((i) => i.complete || i.status === 'not_applicable').length;

  return (
    <div class="card">
      <div class="card-head">
        <h2>Checklist</h2>
        <span class="text-sm text-muted num">{done} of {required.length} required</span>
      </div>
      <div class="card-body-flush">
        {groups.map((group) => {
          const groupItems = items.filter((i) => (i.group_key ?? 'other') === group);
          if (!groupItems.length) return null;
          return (
            <div key={group}>
              <div class="checklist-group">{GROUP_LABELS[group] ?? group}</div>
              {groupItems.map((item) => (
                <ChecklistRow key={item.id} item={item} canEdit={canEdit} onChanged={onChanged} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChecklistRow({ item, canEdit, onChanged }: {
  item: ChecklistItem; canEdit: boolean; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const set = async (status: string) => {
    setBusy(true);
    try {
      await post(`/compliance/items/${item.id}`, { status });
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not change that.', 'error');
    } finally { setBusy(false); }
  };

  return (
    <div class={`checklist-row${item.complete ? ' checklist-done' : ''}`}>
      <span class={`checklist-mark${item.complete ? ' on' : ''}`} aria-hidden="true">
        {item.complete ? '✓' : item.status === 'not_applicable' ? '–' : ''}
      </span>
      <div>
        <div>
          {item.label}
          {!item.required && <span class="text-sm text-muted"> · optional</span>}
          {item.derived && (
            <span class="derived-tag" title="Answered by the file, not by a checkbox">
              from the file
            </span>
          )}
        </div>
        {item.evidence && <div class="text-sm text-muted">{item.evidence}</div>}
        {item.note && <div class="text-sm text-muted">“{item.note}”</div>}
        {item.completed_by_name && (
          <div class="text-sm text-subtle">
            {item.completed_by_name}, {formatDate(item.completed_at)}
          </div>
        )}
      </div>
      {canEdit && !item.derived && (
        <div class="row" style={{ gap: 6 }}>
          {item.complete || item.status === 'not_applicable' ? (
            <button class="btn btn-sm btn-ghost" disabled={busy}
                    onClick={() => set('outstanding')}>Undo</button>
          ) : (
            <>
              <button class="btn btn-sm" disabled={busy}
                      onClick={() => set('complete')}>Done</button>
              <button class="btn btn-sm btn-ghost" disabled={busy}
                      onClick={() => set('not_applicable')}>N/A</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── FINTRAC, identity, suitability ─────────────────────────────────────────

function FintracCard({ data, onEdit }: { data: Payload; onEdit: () => void }) {
  const f = data.fintrac ?? {};
  const complete = !!f.completed_at;

  const rows: Array<[string, string]> = [
    ['Purpose of the relationship', String(f.relationship_purpose ?? '—')],
    ['Third party', f.third_party_checked
      ? (f.third_party_present ? `Yes — ${String(f.third_party_detail ?? 'no detail')}` : 'No')
      : 'Not determined'],
    ['Entity borrower', complete
      ? (f.entity_borrower ? String(f.entity_name ?? 'Yes') : 'No')
      : 'Not determined'],
    ['PEP / HIO', f.pep_screened
      ? String(f.pep_result ?? 'screened').replace(/_/g, ' ')
      : 'Not screened'],
    ['Source of funds', String(f.source_of_funds ?? '—')],
    ['Source of wealth', String(f.source_of_wealth ?? '—')],
    ['Monitoring', String(f.monitoring_level ?? '—')],
  ];

  return (
    <div class="card">
      <div class="card-head">
        <h2>FINTRAC</h2>
        <Badge tone={complete ? 'ok' : 'neutral'}>
          {complete ? 'Completed' : 'Not completed'}
        </Badge>
      </div>
      <div class="card-body">
        <dl class="detail-list">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd class={value === '—' || value.startsWith('Not ') ? 'text-muted' : ''}>{value}</dd>
            </div>
          ))}
        </dl>
        {f.escalated === true && (
          <div class="alert alert-warn">
            Escalated to compliance {relativeTime(String(f.escalated_at))}.
          </div>
        )}
        {data.can_edit && (
          <button class="btn btn-sm" onClick={onEdit}>
            {complete ? 'Amend' : 'Complete the assessment'}
          </button>
        )}
      </div>
    </div>
  );
}

function IdentityCard({ data, onAdd }: { data: Payload; onAdd: () => void }) {
  const byApplicant = new Map(data.identities.map((i) => [String(i.applicant_id ?? ''), i]));

  return (
    <div class="card">
      <div class="card-head">
        <h2>Identity</h2>
        <span class="text-sm text-muted num">
          {data.identities.filter((i) => i.status === 'verified').length} of {data.applicants.length}
        </span>
      </div>
      <div class="card-body-flush">
        {data.applicants.length === 0 && (
          <Empty title="No applicants on this file">
            Identity is verified per person, so there is nobody to verify yet.
          </Empty>
        )}
        {data.applicants.map((a) => {
          const identity = byApplicant.get(a.id);
          return (
            <div key={a.id} class="list-row">
              <div>
                <strong>{a.first_name} {a.last_name}</strong>
                {identity ? (
                  <div class="text-sm text-muted">
                    {String(identity.method ?? '').replace(/_/g, ' ')}
                    {identity.document_type ? ` · ${String(identity.document_type)}` : ''}
                    {identity.id_number_last4 ? ` ending ${String(identity.id_number_last4)}` : ''}
                    {identity.verified_on ? ` · ${formatDate(String(identity.verified_on))}` : ''}
                    {identity.verified_by_name ? ` by ${String(identity.verified_by_name)}` : ''}
                  </div>
                ) : (
                  <div class="text-sm text-muted">Not verified.</div>
                )}
              </div>
              <Badge tone={identity?.status === 'verified' ? 'ok' : 'neutral'}>
                {identity ? String(identity.status) : 'pending'}
              </Badge>
            </div>
          );
        })}
      </div>
      {data.can_edit && data.applicants.length > 0 && (
        <div class="card-body">
          <button class="btn btn-sm" onClick={onAdd}>Record a verification</button>
          <p class="text-sm text-subtle" style={{ marginTop: 8 }}>
            Only the last four characters of a document number are kept. The CRM has no
            operational need for the whole one.
          </p>
        </div>
      )}
    </div>
  );
}

function SuitabilityCard({ data, onEdit }: { data: Payload; onEdit: () => void }) {
  const s = data.suitability;

  return (
    <div class="card">
      <div class="card-head">
        <h2>Suitability</h2>
        {s && <Badge tone={s.status === 'approved' ? 'ok' : s.status === 'submitted' ? 'info' : 'neutral'}>
          {String(s.status).replace(/_/g, ' ')}
        </Badge>}
      </div>
      <div class="card-body">
        {!s ? (
          <Empty title="No rationale yet">
            The test this has to pass: another qualified reviewer, a year from now, can read it
            and follow what was known, what was considered, and why the recommendation was made.
          </Empty>
        ) : (
          <>
            {s.ai_assisted === true && (
              <div class="alert alert-info">
                Drafted with AI assistance and adopted by {String(s.prepared_by_name ?? 'a broker')}.
              </div>
            )}
            <dl class="detail-list">
              {([
                ['What the client is trying to achieve', s.client_objective],
                ['Their circumstances', s.financial_circumstances],
                ['Their priorities', s.client_priorities],
                ['Constraints', s.constraints],
                ['Recommended', [s.recommended_lender, s.recommended_product].filter(Boolean).join(' — ')],
                ['Why it is appropriate', s.why_appropriate],
                ['Material costs', s.material_costs],
                ['Material risks', s.material_risks],
                ['Alternatives rejected', s.alternatives_rejected],
                ['Exit strategy', s.exit_strategy],
              ] as Array<[string, unknown]>).filter(([, v]) => v).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
            {Array.isArray(s.products_considered) && s.products_considered.length > 0 && (
              <>
                <h3 class="sub-heading">Products considered</h3>
                <div class="table-wrap">
                  <table class="data">
                    <thead><tr><th>Lender</th><th>Product</th><th>Rate</th><th>Why not</th></tr></thead>
                    <tbody>
                      {(s.products_considered as Array<Record<string, string>>).map((p, i) => (
                        <tr key={i}>
                          <td data-label="Lender">{p.lender ?? '—'}</td>
                          <td data-label="Product">{p.product ?? '—'}</td>
                          <td data-label="Rate">{p.rate ?? '—'}</td>
                          <td data-label="Why not">{p.why_not ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div class="text-sm text-subtle">
              {s.prepared_by_name ? `Prepared by ${String(s.prepared_by_name)}` : ''}
              {s.prepared_at ? `, ${formatDate(String(s.prepared_at))}` : ''}
            </div>
          </>
        )}
        {data.can_edit && s?.status !== 'approved' && (
          <button class="btn btn-sm" style={{ marginTop: 10 }} onClick={onEdit}>
            {s ? 'Edit the rationale' : 'Write the rationale'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── The forms ──────────────────────────────────────────────────────────────

function FintracForm({ applicationId, existing, onClose, onSaved }: {
  applicationId: string; existing: Record<string, unknown> | null;
  onClose: () => void; onSaved: () => void;
}) {
  const e = existing ?? {};
  const [form, setForm] = useState({
    relationship_purpose: String(e.relationship_purpose ?? ''),
    relationship_nature: String(e.relationship_nature ?? ''),
    third_party_checked: e.third_party_checked === true,
    third_party_present: e.third_party_present === true,
    third_party_detail: String(e.third_party_detail ?? ''),
    entity_borrower: e.entity_borrower === true,
    entity_name: String(e.entity_name ?? ''),
    entity_registration: String(e.entity_registration ?? ''),
    pep_screened: e.pep_screened === true,
    pep_result: String(e.pep_result ?? ''),
    pep_detail: String(e.pep_detail ?? ''),
    source_of_funds: String(e.source_of_funds ?? ''),
    source_of_funds_detail: String(e.source_of_funds_detail ?? ''),
    source_of_wealth: String(e.source_of_wealth ?? ''),
    monitoring_level: String(e.monitoring_level ?? 'standard'),
    monitoring_note: String(e.monitoring_note ?? ''),
  });
  const [owners, setOwners] = useState<Array<{ name: string; percent?: number; role?: string }>>(
    Array.isArray(e.beneficial_owners) ? e.beneficial_owners as never : []);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<string[]>([]);

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const save = async (complete: boolean) => {
    setError(''); setDetail([]);
    try {
      await put(`/applications/${applicationId}/fintrac`, {
        ...form,
        pep_result: form.pep_result || null,
        monitoring_level: form.monitoring_level || null,
        beneficial_owners: owners,
        complete,
      });
      toast(complete ? 'Assessment completed.' : 'Saved.', 'ok');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setDetail((err.detail as string[] | undefined) ?? []);
      } else setError('Could not save that.');
    }
  };

  return (
    <Modal title="FINTRAC assessment" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn" onClick={() => save(false)}>Save progress</button>
        <button class="btn btn-primary" onClick={() => save(true)}>Mark complete</button>
      </>
    }>
      {error && (
        <div class="alert alert-error">
          {error}
          {detail.length > 1 && <ul>{detail.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}

      <Field label="Purpose of the relationship"
             hint="What the client wants from us, in their terms.">
        <input value={form.relationship_purpose} autofocus
               onInput={(ev) => set({ relationship_purpose: (ev.target as HTMLInputElement).value })} />
      </Field>
      <Field label="Nature of the relationship">
        <input value={form.relationship_nature}
               onInput={(ev) => set({ relationship_nature: (ev.target as HTMLInputElement).value })} />
      </Field>

      <h3 class="sub-heading">Third party</h3>
      <label class="check">
        <input type="checkbox" checked={form.third_party_checked}
               onChange={(ev) => set({ third_party_checked: (ev.target as HTMLInputElement).checked })} />
        <span>I have determined whether a third party is involved</span>
      </label>
      {form.third_party_checked && (
        <>
          <label class="check">
            <input type="checkbox" checked={form.third_party_present}
                   onChange={(ev) => set({ third_party_present: (ev.target as HTMLInputElement).checked })} />
            <span>A third party is involved</span>
          </label>
          {form.third_party_present && (
            <Field label="Who, and how">
              <input value={form.third_party_detail}
                     onInput={(ev) => set({ third_party_detail: (ev.target as HTMLInputElement).value })} />
            </Field>
          )}
        </>
      )}

      <h3 class="sub-heading">The borrower</h3>
      <label class="check">
        <input type="checkbox" checked={form.entity_borrower}
               onChange={(ev) => set({ entity_borrower: (ev.target as HTMLInputElement).checked })} />
        <span>The borrower is a corporation or other entity</span>
      </label>
      {form.entity_borrower && (
        <>
          <div class="grid-2">
            <Field label="Entity name">
              <input value={form.entity_name}
                     onInput={(ev) => set({ entity_name: (ev.target as HTMLInputElement).value })} />
            </Field>
            <Field label="Registration number">
              <input value={form.entity_registration}
                     onInput={(ev) => set({ entity_registration: (ev.target as HTMLInputElement).value })} />
            </Field>
          </div>
          <Field label="Beneficial owners"
                 hint="Everyone who owns or controls 25% or more. Required before this can be completed.">
            <div class="stack-tight">
              {owners.map((owner, i) => (
                <div key={i} class="condition-row">
                  <input placeholder="Name" value={owner.name}
                         onInput={(ev) => setOwners(owners.map((o, j) =>
                           (j === i ? { ...o, name: (ev.target as HTMLInputElement).value } : o)))} />
                  <input type="number" placeholder="%" value={owner.percent ?? ''}
                         onInput={(ev) => setOwners(owners.map((o, j) =>
                           (j === i ? { ...o, percent: Number((ev.target as HTMLInputElement).value) } : o)))} />
                  <button class="btn btn-sm btn-ghost"
                          onClick={() => setOwners(owners.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button class="btn btn-sm" onClick={() => setOwners([...owners, { name: '' }])}>
                Add an owner
              </button>
            </div>
          </Field>
        </>
      )}

      <h3 class="sub-heading">PEP and HIO screening</h3>
      <label class="check">
        <input type="checkbox" checked={form.pep_screened}
               onChange={(ev) => set({ pep_screened: (ev.target as HTMLInputElement).checked })} />
        <span>Screening completed</span>
      </label>
      {form.pep_screened && (
        <>
          <Field label="Result">
            <select value={form.pep_result}
                    onChange={(ev) => set({ pep_result: (ev.target as HTMLSelectElement).value })}>
              <option value="">Choose…</option>
              <option value="none">No match</option>
              <option value="domestic">Domestic PEP</option>
              <option value="foreign">Foreign PEP</option>
              <option value="hio">Head of an international organisation</option>
              <option value="family">Family member</option>
              <option value="associate">Close associate</option>
            </select>
          </Field>
          {form.pep_result && form.pep_result !== 'none' && (
            <>
              <Field label="Detail">
                <input value={form.pep_detail}
                       onInput={(ev) => set({ pep_detail: (ev.target as HTMLInputElement).value })} />
              </Field>
              <div class="alert alert-warn">
                A match needs senior approval before the checklist item is complete, and
                enhanced monitoring.
              </div>
            </>
          )}
        </>
      )}

      <h3 class="sub-heading">Funds</h3>
      <Field label="Source of funds" hint="Where the money for this transaction comes from.">
        <input value={form.source_of_funds}
               onInput={(ev) => set({ source_of_funds: (ev.target as HTMLInputElement).value })} />
      </Field>
      <Field label="Source of wealth" hint="How the client accumulated their assets generally.">
        <input value={form.source_of_wealth}
               onInput={(ev) => set({ source_of_wealth: (ev.target as HTMLInputElement).value })} />
      </Field>
      <Field label="Ongoing monitoring">
        <select value={form.monitoring_level}
                onChange={(ev) => set({ monitoring_level: (ev.target as HTMLSelectElement).value })}>
          <option value="standard">Standard</option>
          <option value="enhanced">Enhanced</option>
        </select>
      </Field>
    </Modal>
  );
}

function IdentityForm({ applicationId, applicants, onClose, onSaved }: {
  applicationId: string; applicants: Payload['applicants'];
  onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    applicant_id: applicants[0]?.id ?? '',
    method: 'government_photo_id',
    method_detail: '',
    document_type: '',
    document_country: 'Canada',
    document_province: '',
    id_number_last4: '',
    document_expiry: '',
    verified_on: new Date().toISOString().slice(0, 10),
    status: 'verified',
    note: '',
  });
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const save = async () => {
    setError('');
    try {
      await post(`/applications/${applicationId}/identity`, {
        ...form,
        id_number_last4: form.id_number_last4 || undefined,
        document_expiry: form.document_expiry || undefined,
        method_detail: form.method_detail || undefined,
        document_type: form.document_type || undefined,
        document_province: form.document_province || undefined,
        note: form.note || undefined,
      });
      toast('Verification recorded.', 'ok');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    }
  };

  return (
    <Modal title="Record an identity verification" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={save}>Record it</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <Field label="Applicant">
        <select value={form.applicant_id}
                onChange={(e) => set({ applicant_id: (e.target as HTMLSelectElement).value })}>
          {applicants.map((a) =>
            <option key={a.id} value={a.id}>{a.first_name} {a.last_name}</option>)}
        </select>
      </Field>
      <Field label="Method" hint="The method is what has to be defensible, not the document.">
        <select value={form.method}
                onChange={(e) => set({ method: (e.target as HTMLSelectElement).value })}>
          <option value="government_photo_id">Government photo identification</option>
          <option value="credit_file">Credit file</option>
          <option value="dual_process">Dual process</option>
          <option value="affiliate_reliance">Reliance on an affiliate</option>
          <option value="agent_mandate">Agent or mandatary</option>
          <option value="other">Other</option>
        </select>
      </Field>
      <div class="grid-2">
        <Field label="Document type">
          <input value={form.document_type} placeholder="Driver's licence"
                 onInput={(e) => set({ document_type: (e.target as HTMLInputElement).value })} />
        </Field>
        <Field label="Issuing province or state">
          <input value={form.document_province}
                 onInput={(e) => set({ document_province: (e.target as HTMLInputElement).value })} />
        </Field>
      </div>
      <div class="grid-2">
        <Field label="Last four characters"
               hint="Only these are kept. Never record the whole number.">
          <input value={form.id_number_last4} maxLength={4}
                 onInput={(e) => set({ id_number_last4: (e.target as HTMLInputElement).value })} />
        </Field>
        <Field label="Expires">
          <input type="date" value={form.document_expiry}
                 onInput={(e) => set({ document_expiry: (e.target as HTMLInputElement).value })} />
        </Field>
      </div>
      <div class="grid-2">
        <Field label="Verified on">
          <input type="date" value={form.verified_on}
                 onInput={(e) => set({ verified_on: (e.target as HTMLInputElement).value })} />
        </Field>
        <Field label="Outcome">
          <select value={form.status}
                  onChange={(e) => set({ status: (e.target as HTMLSelectElement).value })}>
            <option value="verified">Verified</option>
            <option value="pending">Pending</option>
            <option value="failed">Could not verify</option>
            <option value="waived">Waived</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function SuitabilityForm({ applicationId, existing, onClose, onSaved }: {
  applicationId: string; existing: Record<string, unknown> | null;
  onClose: () => void; onSaved: () => void;
}) {
  const e = existing ?? {};
  const [form, setForm] = useState({
    client_objective: String(e.client_objective ?? ''),
    financial_circumstances: String(e.financial_circumstances ?? ''),
    client_priorities: String(e.client_priorities ?? ''),
    constraints: String(e.constraints ?? ''),
    recommended_lender: String(e.recommended_lender ?? ''),
    recommended_product: String(e.recommended_product ?? ''),
    why_appropriate: String(e.why_appropriate ?? ''),
    material_costs: String(e.material_costs ?? ''),
    material_risks: String(e.material_risks ?? ''),
    alternatives_rejected: String(e.alternatives_rejected ?? ''),
    exit_strategy: String(e.exit_strategy ?? ''),
    special_considerations: String(e.special_considerations ?? ''),
    ai_assisted: e.ai_assisted === true,
  });
  const [considered, setConsidered] = useState<Array<Record<string, string>>>(
    Array.isArray(e.products_considered) ? e.products_considered as never : []);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<string[]>([]);

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const area = (name: keyof typeof form, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <textarea rows={3} value={String(form[name])}
                onInput={(ev) => set({ [name]: (ev.target as HTMLTextAreaElement).value } as never)} />
    </Field>
  );

  const save = async (submit: boolean) => {
    setError(''); setDetail([]);
    try {
      await put(`/applications/${applicationId}/suitability`, {
        ...form, products_considered: considered, submit,
      });
      toast(submit ? 'Rationale submitted.' : 'Saved as a draft.', 'ok');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setDetail((err.detail as string[] | undefined) ?? []);
      } else setError('Could not save that.');
    }
  };

  return (
    <Modal title="Suitability rationale" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn" onClick={() => save(false)}>Save draft</button>
        <button class="btn btn-primary" onClick={() => save(true)}>Submit</button>
      </>
    }>
      {error && (
        <div class="alert alert-error">
          {error}
          {detail.length > 1 && <ul>{detail.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}
      <p class="text-sm text-muted">
        Written for one reader: another qualified reviewer, a year from now, who needs to
        follow what was known, what was considered, and why.
      </p>

      {area('client_objective', 'What the client is trying to achieve')}
      {area('financial_circumstances', 'Their circumstances')}
      {area('client_priorities', 'What matters most to them',
        'Rate, flexibility, speed, payment size — in their own order.')}
      {area('constraints', 'Constraints')}

      <h3 class="sub-heading">The recommendation</h3>
      <div class="grid-2">
        <Field label="Lender">
          <input value={form.recommended_lender}
                 onInput={(ev) => set({ recommended_lender: (ev.target as HTMLInputElement).value })} />
        </Field>
        <Field label="Product">
          <input value={form.recommended_product}
                 onInput={(ev) => set({ recommended_product: (ev.target as HTMLInputElement).value })} />
        </Field>
      </div>
      {area('why_appropriate', 'Why it is appropriate for them')}
      {area('material_costs', 'Material costs', 'Fees, penalties, the cost of the term.')}
      {area('material_risks', 'Material risks', 'Rate exposure, renewal risk, what happens if circumstances change.')}
      {area('alternatives_rejected', 'Alternatives rejected, and why')}
      {area('exit_strategy', 'Exit strategy')}

      <h3 class="sub-heading">Products considered</h3>
      <div class="stack-tight">
        {considered.map((p, i) => (
          <div key={i} class="condition-row">
            <input placeholder="Lender" value={p.lender ?? ''}
                   onInput={(ev) => setConsidered(considered.map((x, j) =>
                     (j === i ? { ...x, lender: (ev.target as HTMLInputElement).value } : x)))} />
            <input placeholder="Rate" value={p.rate ?? ''}
                   onInput={(ev) => setConsidered(considered.map((x, j) =>
                     (j === i ? { ...x, rate: (ev.target as HTMLInputElement).value } : x)))} />
            <input placeholder="Why not" value={p.why_not ?? ''}
                   onInput={(ev) => setConsidered(considered.map((x, j) =>
                     (j === i ? { ...x, why_not: (ev.target as HTMLInputElement).value } : x)))} />
            <button class="btn btn-sm btn-ghost"
                    onClick={() => setConsidered(considered.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button class="btn btn-sm" onClick={() => setConsidered([...considered, {}])}>
          Add a product that was considered
        </button>
      </div>

      <label class="check" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={form.ai_assisted}
               onChange={(ev) => set({ ai_assisted: (ev.target as HTMLInputElement).checked })} />
        <span>
          Drafted with AI assistance
          <span class="text-sm text-muted d-block">
            Recorded on the file. An AI draft is a draft — submitting it is you adopting it.
          </span>
        </span>
      </label>
    </Modal>
  );
}

function DecisionForm({ applicationId, blockers, rating, onClose, onDecided }: {
  applicationId: string; blockers: string[]; rating: string;
  onClose: () => void; onDecided: () => void;
}) {
  const [decision, setDecision] = useState(blockers.length ? 'changes_requested' : 'approved');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<string[]>([]);

  const save = async () => {
    setError(''); setDetail([]);
    try {
      await post(`/applications/${applicationId}/compliance/decision`, { decision, note });
      toast(`Recorded as ${decision.replace(/_/g, ' ')}.`, 'ok');
      onDecided();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setDetail((err.detail as string[] | undefined) ?? []);
      } else setError('Could not record that.');
    }
  };

  return (
    <Modal title="Record a compliance decision" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={save}>Record it</button>
      </>
    }>
      {error && (
        <div class="alert alert-error">
          {error}
          {detail.length > 0 && <ul>{detail.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}
      {blockers.length > 0 && (
        <div class="alert alert-warn">
          {blockers.length} thing(s) are outstanding, so this cannot be approved yet.
        </div>
      )}
      <p class="text-sm text-muted">
        The risk rating on this file is <strong>{RATING_LABEL[rating] ?? rating}</strong>.
      </p>
      <Field label="Decision">
        <select value={decision} onChange={(e) => setDecision((e.target as HTMLSelectElement).value)}>
          <option value="approved" disabled={blockers.length > 0}>Approve</option>
          <option value="changes_requested">Request changes</option>
          <option value="on_hold">Put on hold</option>
          <option value="rejected">Reject</option>
        </select>
      </Field>
      <Field label="Note"
             hint={decision === 'approved' ? 'Optional.' : 'Say what needs to change — a refusal with no reason cannot be acted on.'}>
        <textarea rows={3} value={note} autofocus
                  onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
      </Field>
    </Modal>
  );
}

function LegalHoldButton({ applicationId, held, onChanged }: {
  applicationId: string; held: boolean; onChanged: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const save = async () => {
    try {
      await post(`/applications/${applicationId}/compliance/hold`, { hold: !held, reason });
      toast(held ? 'Hold lifted.' : 'Hold placed.', 'ok');
      setAsking(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not do that.');
    }
  };

  return (
    <>
      <button class="btn" onClick={() => setAsking(true)}>
        {held ? 'Lift the legal hold' : 'Place a legal hold'}
      </button>
      {asking && (
        <Modal title={held ? 'Lift the legal hold' : 'Place a legal hold'}
               onClose={() => setAsking(false)} footer={
          <>
            <button class="btn" onClick={() => setAsking(false)}>Cancel</button>
            <button class="btn btn-primary" onClick={save}>
              {held ? 'Lift it' : 'Place it'}
            </button>
          </>
        }>
          {error && <div class="alert alert-error">{error}</div>}
          <p>
            {held
              ? 'Retention will treat this file normally again.'
              : 'Nothing on this file will be deleted or anonymised by retention while the hold stands.'}
          </p>
          <Field label="Reason" hint="A complaint, an audit, a regulatory request.">
            <input value={reason} autofocus
                   onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
          </Field>
        </Modal>
      )}
    </>
  );
}

function EscalateButton({ applicationId, escalated, onChanged }: {
  applicationId: string; escalated: boolean; onChanged: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  if (escalated) return <Badge tone="warn">Escalated to compliance</Badge>;

  const save = async () => {
    try {
      await post(`/applications/${applicationId}/compliance/escalate`, { note });
      toast('Escalated to compliance.', 'ok');
      setAsking(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not escalate.');
    }
  };

  return (
    <>
      <button class="btn" onClick={() => setAsking(true)}>Escalate to compliance</button>
      {asking && (
        <Modal title="Escalate to compliance" onClose={() => setAsking(false)} footer={
          <>
            <button class="btn" onClick={() => setAsking(false)}>Cancel</button>
            <button class="btn btn-primary" onClick={save}>Escalate</button>
          </>
        }>
          {error && <div class="alert alert-error">{error}</div>}
          <p>
            The compliance manager is notified and takes it from here. Nothing about this is
            visible to the client, and nothing is sent to them.
          </p>
          <Field label="What prompted it">
            <textarea rows={3} value={note} autofocus
                      onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
          </Field>
        </Modal>
      )}
    </>
  );
}

// ── The queue ──────────────────────────────────────────────────────────────

type QueueCase = {
  id: string; status: string; province: string; legal_hold: boolean; updated_at: string;
  application_id: string; portal_reference: string | null; stage_key: string;
  amount_requested: string | null; closing_date: string | null;
  first_name: string; last_name: string;
  model_rating: string | null; override_rating: string | null; score: string | null;
  escalated: boolean | null; fintrac_completed_at: string | null;
  outstanding_items: number; reviewer_name: string | null;
};

export function CompliancePage({ session }: { session: Session }) {
  const [status, setStatus] = useState('all');
  const state = useAsync<{ cases: QueueCase[]; counts: Record<string, number> }>(
    `/compliance?status=${status}`, [status]);

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Compliance</h1>
          <p>
            Every file's case, what is outstanding on it, and how it is rated. Nothing on
            these screens is visible to a client.
          </p>
        </div>
      </div>

      {state.status === 'loading' && <Skeleton rows={5} height={64} />}
      {state.status === 'error' && <ErrorNote error={state.error} onRetry={state.reload} />}

      {state.status === 'ready' && (
        <>
          <div class="kpi-grid">
            {[
              ['awaiting_review', 'Awaiting review'],
              ['in_progress', 'In progress'],
              ['changes_requested', 'Changes requested'],
              ['approved', 'Approved'],
              ['legal_hold', 'On legal hold'],
            ].map(([key, label]) => (
              <button key={key} class="card kpi kpi-button"
                      onClick={() => setStatus(key === 'legal_hold' ? 'all' : key as string)}>
                <div class="label">{label}</div>
                <div class="value num">{state.data.counts[key as string] ?? 0}</div>
              </button>
            ))}
          </div>

          <div class="card" style={{ marginTop: 16 }}>
            <div class="card-head">
              <h2>Files</h2>
              <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}>
                {['all', 'awaiting_review', 'in_progress', 'changes_requested', 'approved', 'on_hold']
                  .map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div class="card-body-flush">
              {state.data.cases.length === 0 ? (
                <Empty title="Nothing here">No file is in that state.</Empty>
              ) : state.data.cases.map((c) => {
                const rating = c.override_rating ?? c.model_rating;
                return (
                  <button key={c.id} class="priority-item"
                          onClick={() => navigate(`/applications/${c.application_id}?tab=compliance`)}>
                    <span class="row" style={{ gap: 8, minWidth: 0 }}>
                      {rating && (
                        <Badge tone={RATING_TONE[rating] ?? 'neutral'}>
                          {RATING_LABEL[rating] ?? rating}
                        </Badge>
                      )}
                      {c.escalated && <Badge tone="warn">Escalated</Badge>}
                      {c.legal_hold && <Badge tone="info">Hold</Badge>}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <div class="action">{c.first_name} {c.last_name}</div>
                      <div class="reason">
                        {c.portal_reference ?? 'No reference'}
                        {c.amount_requested ? ` · ${money(c.amount_requested)}` : ''}
                        {c.closing_date ? ` · closes ${formatDate(c.closing_date)}` : ''}
                        {' · '}
                        {c.outstanding_items === 0
                          ? 'nothing outstanding'
                          : `${c.outstanding_items} outstanding`}
                        {!c.fintrac_completed_at ? ' · FINTRAC not completed' : ''}
                      </div>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
