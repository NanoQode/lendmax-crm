/**
 * Campaigns.
 *
 * The audience arithmetic is the centre of this screen, not a detail behind
 * a link. A brokerage that believes a campaign reached four thousand people
 * when it reached two thousand makes decisions on the first number, so the
 * send button sits under a sentence that says which is which and why the
 * difference exists.
 *
 * The composer is the same vertical block list as the automation builder,
 * for the same reasons: it reads in the order it renders, it works on a
 * phone, and there is no canvas to get lost in.
 */
import { useState } from 'preact/hooks';
import { ApiError, formatDate, post, put, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, useRoute, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Field, Modal, Skeleton } from '../components/ui.tsx';

type Summary = {
  id: string; name: string; description: string | null; channel: string; purpose: string;
  status: string; subject: string | null; scheduled_for: string | null;
  send_started_at: string | null; audience_snapshot: { matched?: number; sendable?: number } | null;
  updated_at: string; created_by_name: string | null;
  recipients: number; sent: number; suppressed: number; outcomes: number;
};

export function CampaignsPage({ session }: { session: Session }) {
  const { query } = useRoute();
  const id = query.get('id');
  if (id) return <CampaignEditor id={id} session={session} />;

  const state = useAsync<{ campaigns: Summary[]; can_edit: boolean; can_send: boolean }>(
    '/campaigns');
  const [creating, setCreating] = useState(false);

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Campaigns</h1>
          <p>
            One message to many clients. Every one shows who it actually reached and who was
            held back, with the reason.
          </p>
        </div>
        {state.status === 'ready' && state.data.can_edit && (
          <button class="btn btn-primary" onClick={() => setCreating(true)}>New campaign</button>
        )}
      </div>

      {state.status === 'loading' && <Skeleton rows={4} height={70} />}
      {state.status === 'error' && <ErrorNote error={state.error} onRetry={state.reload} />}

      {state.status === 'ready' && (
        state.data.campaigns.length === 0 ? (
          <div class="card"><Empty title="No campaigns yet">
            Nothing goes out to a list until somebody builds it, reviews the audience and
            sends it.
          </Empty></div>
        ) : (
          <div class="stack-tight">
            {state.data.campaigns.map((c) => (
              <button key={c.id} class="flow-row"
                      onClick={() => navigate(`/campaigns?id=${c.id}`)}>
                <div class="flow-row-main">
                  <div class="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{c.name}</strong>
                    <Badge tone={
                      c.status === 'sending' ? 'info' : c.status === 'completed' ? 'ok'
                        : c.status === 'paused' ? 'warn' : 'neutral'
                    }>{c.status}</Badge>
                    {c.purpose === 'marketing' && <Badge tone="warn">Marketing</Badge>}
                  </div>
                  <div class="text-sm text-muted">
                    {c.channel}
                    {c.subject ? ` · ${c.subject}` : ''}
                    {c.send_started_at ? ` · sent ${relativeTime(c.send_started_at)}` : ''}
                  </div>
                </div>
                <div class="flow-row-stats">
                  <span><strong class="num">{c.sent}</strong> sent</span>
                  <span><strong class="num">{c.suppressed}</strong> held back</span>
                  <span><strong class="num">{c.outcomes}</strong> outcomes</span>
                </div>
              </button>
            ))}
          </div>
        )
      )}

      {creating && (
        <NewCampaign onClose={() => setCreating(false)}
                     onCreated={(newId) => navigate(`/campaigns?id=${newId}`)} />
      )}
    </div>
  );
}

function NewCampaign({ onClose, onCreated }: {
  onClose: () => void; onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [channel, setChannel] = useState('email');
  const [purpose, setPurpose] = useState('marketing');
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    try {
      const created = await post<{ id: string }>('/campaigns', { name, channel, purpose });
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that.');
    }
  };

  return (
    <Modal title="New campaign" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" disabled={!name.trim()} onClick={save}>Create</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <Field label="Name" hint="Internal. Clients never see it.">
        <input value={name} autofocus
               onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </Field>
      <div class="grid-2">
        <Field label="Channel">
          <select value={channel} onChange={(e) => setChannel((e.target as HTMLSelectElement).value)}>
            <option value="email">Email</option>
            <option value="sms">Text</option>
          </select>
        </Field>
        <Field
          label="Purpose"
          hint={purpose === 'marketing'
            ? 'Goes only to clients with a marketing consent, and carries the address and unsubscribe CASL requires.'
            : 'About a mortgage the client asked us to arrange.'}
        >
          <select value={purpose} onChange={(e) => setPurpose((e.target as HTMLSelectElement).value)}>
            <option value="marketing">Marketing</option>
            <option value="service">Service</option>
            <option value="transactional">Transactional</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ── The editor ─────────────────────────────────────────────────────────────

type Block = { type: string; [more: string]: unknown };

type Criterion = { field: string; op: string; value?: unknown };

type EditorPayload = {
  campaign: Record<string, any>;
  blocks: Block[];
  block_problems: string[];
  segment_description: string;
  segment_issues: Array<{ message: string }>;
  audience: { matched: number; sendable: number;
              suppressed: Array<{ reason: string; count: number }> };
  audience_sentence: string | null;
  audience_sample: Array<{ customer_id: string; first_name: string; last_name: string;
                           allowed: boolean; reason: string }>;
  send_blockers: string[];
  results: {
    counts: Record<string, number>;
    suppressed_by_reason: Array<{ reason: string; count: number }>;
    attributions: Array<{ outcome: string; count: number; value: string | null }>;
  } | null;
  can_edit: boolean;
  can_send: boolean;
};

type Catalogue = {
  fields: Array<{ key: string; label: string; type: string; options?: string[]; help?: string }>;
  merge_fields: Array<{ name: string; label: string; example: string }>;
  stages: Array<{ key: string; label: string }>;
  block_types: Array<{ type: string; label: string }>;
};

function CampaignEditor({ id, session }: { id: string; session: Session }) {
  const state = useAsync<EditorPayload>(`/campaigns/${id}`, [id]);
  const catalogue = useAsync<Catalogue>('/campaigns/catalogue');
  const [tab, setTab] = useState<'content' | 'audience' | 'results'>('content');
  const [preview, setPreview] = useState(false);

  if (state.status === 'loading' || catalogue.status === 'loading') {
    return <div class="content-narrow"><Skeleton rows={5} height={60} /></div>;
  }
  if (state.status === 'error') {
    return <div class="content-narrow"><ErrorNote error={state.error} onRetry={state.reload} /></div>;
  }
  if (catalogue.status === 'error') {
    return <div class="content-narrow"><ErrorNote error={catalogue.error} onRetry={catalogue.reload} /></div>;
  }

  const d = state.data;
  const c = d.campaign;
  const sent = c.status === 'sending' || c.status === 'completed';

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <button class="btn btn-ghost btn-sm" onClick={() => navigate('/campaigns')}>
            ← All campaigns
          </button>
          <h1 style={{ marginTop: 6 }}>{c.name}</h1>
          <p>
            <Badge tone={c.status === 'completed' ? 'ok' : c.status === 'sending' ? 'info'
              : c.status === 'paused' ? 'warn' : 'neutral'}>{c.status}</Badge>
            {' '}{c.channel} · {c.purpose}
            {c.send_started_at && ` · started ${relativeTime(c.send_started_at)}`}
          </p>
        </div>
        <div class="row" style={{ gap: 8 }}>
          <button class="btn" onClick={() => setPreview(true)}>Preview</button>
          {d.can_send && c.status === 'sending' && (
            <PauseButton id={id} onChanged={state.reload} />
          )}
        </div>
      </div>

      <div class="tabs" role="tablist">
        {([['content', 'Content'], ['audience', 'Audience'],
           ...(d.results ? [['results', 'Results'] as const] : [])] as const)
          .map(([key, label]) => (
          <button key={key} class="tab" role="tab" aria-selected={tab === key}
                  onClick={() => setTab(key as never)}>{label}</button>
        ))}
      </div>

      {tab === 'content' && (
        <Composer campaign={c} blocks={d.blocks} problems={[...d.block_problems, ...d.send_blockers]}
                  catalogue={catalogue.data} readOnly={!d.can_edit || sent}
                  onSaved={state.reload} id={id} />
      )}

      {tab === 'audience' && (
        <AudienceTab data={d} catalogue={catalogue.data} id={id} session={session}
                     onChanged={state.reload} />
      )}

      {tab === 'results' && d.results && <ResultsTab results={d.results} id={id} />}

      {preview && (
        <PreviewModal id={id} channel={c.channel} onClose={() => setPreview(false)} />
      )}
    </div>
  );
}

function PauseButton({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button class="btn btn-danger" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const result = await post<{ remaining: number }>(`/campaigns/${id}/pause`);
        toast(`Paused with ${result.remaining} still to send.`, 'ok');
        onChanged();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Could not pause.', 'error');
      } finally { setBusy(false); }
    }}>Stop sending</button>
  );
}

// ── Content ────────────────────────────────────────────────────────────────

function Composer({ campaign, blocks, problems, catalogue, readOnly, id, onSaved }: {
  campaign: Record<string, any>; blocks: Block[]; problems: string[];
  catalogue: Catalogue; readOnly: boolean; id: string; onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Block[]>(blocks);
  const [subject, setSubject] = useState(String(campaign.subject ?? ''));
  const [preheader, setPreheader] = useState(String(campaign.preheader ?? ''));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const change = (next: Block[]) => { setDraft(next); setDirty(true); };

  const save = async () => {
    setBusy(true); setError('');
    try {
      await put(`/campaigns/${id}`, { blocks: draft, subject, preheader });
      toast('Saved.', 'ok');
      setDirty(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally { setBusy(false); }
  };

  return (
    <div class="stack">
      {problems.length > 0 && (
        <div class="alert alert-warn">
          <strong>Before this can be sent</strong>
          <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {error && <div class="alert alert-error">{error}</div>}

      {campaign.channel === 'email' && (
        <div class="card">
          <div class="card-body">
            <Field label="Subject" hint="Merge fields work here. A subject that cannot merge for a client means they are not sent it.">
              <input value={subject} disabled={readOnly}
                     onInput={(e) => { setSubject((e.target as HTMLInputElement).value); setDirty(true); }} />
            </Field>
            <Field label="Preview text" hint="The line most clients see next to the subject.">
              <input value={preheader} disabled={readOnly}
                     onInput={(e) => { setPreheader((e.target as HTMLInputElement).value); setDirty(true); }} />
            </Field>
          </div>
        </div>
      )}

      <div class="builder-flow">
        {draft.length === 0 && (
          <div class="card"><Empty title="Nothing in it yet">
            Add the first block. The footer with the address and the unsubscribe link is
            added automatically — you do not build it.
          </Empty></div>
        )}
        {draft.map((block, index) => (
          <div key={index}>
            <BlockCard block={block} readOnly={readOnly} fields={catalogue.merge_fields}
                       onChange={(patch) => change(draft.map((b, i) =>
                         (i === index ? { ...b, ...patch } : b)))}
                       onRemove={() => change(draft.filter((_, i) => i !== index))}
                       onMove={(by) => {
                         const next = [...draft];
                         const target = index + by;
                         if (target < 0 || target >= next.length) return;
                         [next[index], next[target]] = [next[target]!, next[index]!];
                         change(next);
                       }} />
            {!readOnly && (
              <AddBlock types={catalogue.block_types}
                        onAdd={(type) => change([
                          ...draft.slice(0, index + 1), defaultBlock(type),
                          ...draft.slice(index + 1)])} />
            )}
          </div>
        ))}
        {!readOnly && draft.length === 0 && (
          <AddBlock types={catalogue.block_types}
                    onAdd={(type) => change([defaultBlock(type)])} />
        )}
      </div>

      {!readOnly && (
        <div class="row" style={{ gap: 8 }}>
          <button class="btn btn-primary" disabled={!dirty || busy} onClick={save}>
            {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      )}
    </div>
  );
}

function AddBlock({ types, onAdd }: {
  types: Catalogue['block_types']; onAdd: (type: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div class="connector">
      <span class="connector-line" aria-hidden="true" />
      {open ? (
        <div class="connector-menu">
          {types.map((t) => (
            <button key={t.type} class="connector-choice"
                    onClick={() => { onAdd(t.type); setOpen(false); }}>{t.label}</button>
          ))}
          <button class="connector-choice connector-cancel"
                  onClick={() => setOpen(false)}>Cancel</button>
        </div>
      ) : (
        <button class="connector-add" onClick={() => setOpen(true)}>+ Add a block</button>
      )}
    </div>
  );
}

function BlockCard({ block, readOnly, fields, onChange, onRemove, onMove }: {
  block: Block; readOnly: boolean;
  fields: Catalogue['merge_fields'];
  onChange: (patch: Record<string, unknown>) => void;
  onRemove: () => void; onMove: (by: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`step-card${open ? ' step-open' : ''}`}>
      <button class="step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="step-type">{block.type.replace(/_/g, ' ')}</span>
        <span class="step-summary">{describeBlock(block)}</span>
        <span class="step-chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>
      {open && (
        <div class="step-body">
          <BlockFields block={block} readOnly={readOnly} fields={fields} onChange={onChange} />
          {!readOnly && (
            <div class="row-between" style={{ marginTop: 12 }}>
              <div class="row" style={{ gap: 6 }}>
                <button class="btn btn-sm btn-ghost" onClick={() => onMove(-1)}>↑</button>
                <button class="btn btn-sm btn-ghost" onClick={() => onMove(1)}>↓</button>
              </div>
              <button class="btn btn-sm btn-danger" onClick={onRemove}>Remove</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BlockFields({ block, readOnly, fields, onChange }: {
  block: Block; readOnly: boolean; fields: Catalogue['merge_fields'];
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const text = (name: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input value={String(block[name] ?? '')} disabled={readOnly}
             onInput={(e) => onChange({ [name]: (e.target as HTMLInputElement).value })} />
    </Field>
  );

  switch (block.type) {
    case 'heading':
      return (
        <>
          {text('text', 'Heading')}
          <Field label="Size">
            <select value={String(block.level ?? 2)} disabled={readOnly}
                    onChange={(e) => onChange({ level: Number((e.target as HTMLSelectElement).value) })}>
              <option value="1">Large</option>
              <option value="2">Medium</option>
              <option value="3">Small</option>
            </select>
          </Field>
        </>
      );
    case 'text':
      return (
        <>
          <Field label="Text"
                 hint="A line whose merge field has no value is left out entirely.">
            <textarea rows={6} value={String(block.text ?? '')} disabled={readOnly}
                      onInput={(e) => onChange({ text: (e.target as HTMLTextAreaElement).value })} />
          </Field>
          <details>
            <summary class="text-sm text-muted">Merge fields</summary>
            <div class="merge-grid">
              {fields.map((f) => (
                <div key={f.name}><code>{'{' + f.name + '}'}</code>
                  <span class="text-sm text-muted"> {f.label}</span></div>
              ))}
            </div>
          </details>
        </>
      );
    case 'button':
      return (
        <>
          {text('label', 'Button text')}
          {text('href', 'Link', 'Must start with https. Anything else is not rendered.')}
        </>
      );
    case 'image':
      return (
        <>
          {text('src', 'Image URL')}
          {text('alt', 'Alt text',
            'Required. Most people read this — images are off by default in many clients.')}
          {text('href', 'Links to (optional)')}
        </>
      );
    case 'rate_table':
      return (
        <>
          {text('caption', 'Caption')}
          <div class="stack-tight">
            {((block.rows as Array<Record<string, string>>) ?? []).map((row, i) => (
              <div key={i} class="condition-row">
                <input placeholder="Term" value={row.term ?? ''} disabled={readOnly}
                       onInput={(e) => onChange({
                         rows: (block.rows as Array<Record<string, string>>).map((r, j) =>
                           (j === i ? { ...r, term: (e.target as HTMLInputElement).value } : r)) })} />
                <input placeholder="Rate" value={row.rate ?? ''} disabled={readOnly}
                       onInput={(e) => onChange({
                         rows: (block.rows as Array<Record<string, string>>).map((r, j) =>
                           (j === i ? { ...r, rate: (e.target as HTMLInputElement).value } : r)) })} />
                <input placeholder="Note" value={row.note ?? ''} disabled={readOnly}
                       onInput={(e) => onChange({
                         rows: (block.rows as Array<Record<string, string>>).map((r, j) =>
                           (j === i ? { ...r, note: (e.target as HTMLInputElement).value } : r)) })} />
                <button class="btn btn-sm btn-ghost" disabled={readOnly}
                        onClick={() => onChange({
                          rows: (block.rows as unknown[]).filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            {!readOnly && (
              <button class="btn btn-sm" onClick={() => onChange({
                rows: [...((block.rows as unknown[]) ?? []), { term: '', rate: '' }] })}>
                Add a row
              </button>
            )}
          </div>
          <p class="text-sm text-muted">
            Rates in an email are a snapshot. Say what date they are from, in the caption.
          </p>
        </>
      );
    case 'spacer':
      return (
        <Field label="Height">
          <input type="number" value={Number(block.size ?? 24)} disabled={readOnly}
                 onInput={(e) => onChange({ size: Number((e.target as HTMLInputElement).value) })} />
        </Field>
      );
    case 'signature':
      return <p class="text-sm text-muted">
        Signs with the name and mobile of whoever sends the campaign.
      </p>;
    default:
      return <p class="text-sm text-muted">Nothing to configure.</p>;
  }
}

function defaultBlock(type: string): Block {
  switch (type) {
    case 'heading': return { type, text: '', level: 2 };
    case 'text': return { type, text: '' };
    case 'button': return { type, label: '', href: '' };
    case 'image': return { type, src: '', alt: '' };
    case 'rate_table': return { type, caption: '', rows: [] };
    case 'columns': return { type, columns: [{ text: '' }, { text: '' }] };
    case 'spacer': return { type, size: 24 };
    default: return { type };
  }
}

function describeBlock(block: Block): string {
  switch (block.type) {
    case 'heading': return String(block.text || 'No heading yet');
    case 'text': return String(block.text || 'Empty').split('\n')[0]!.slice(0, 70);
    case 'button': return String(block.label || 'No label yet');
    case 'image': return String(block.alt || 'No alt text');
    case 'rate_table': return `${((block.rows as unknown[]) ?? []).length} rate(s)`;
    case 'columns': return `${((block.columns as unknown[]) ?? []).length} columns`;
    case 'divider': return 'A line';
    case 'spacer': return `${block.size ?? 24}px of space`;
    case 'signature': return 'The sender’s name and number';
    default: return '';
  }
}

// ── Audience ───────────────────────────────────────────────────────────────

/**
 * The arithmetic, and the send.
 *
 * The sentence above the button is the whole point of the screen. The
 * confirmation carries the count it was shown, and the server refuses if the
 * audience has moved since — an audience frozen on Monday and sent on
 * Thursday against a segment that has changed is a different campaign than
 * the one somebody approved.
 */
function AudienceTab({ data, catalogue, id, session, onChanged }: {
  data: EditorPayload; catalogue: Catalogue; id: string; session: Session;
  onChanged: () => void;
}) {
  const [criteria, setCriteria] = useState<Criterion[]>(
    (data.campaign.segment?.criteria as Criterion[]) ?? []);
  const [match, setMatch] = useState<string>(String(data.campaign.segment?.match ?? 'all'));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  const sent = data.campaign.status === 'sending' || data.campaign.status === 'completed';

  const saveSegment = async () => {
    setBusy('save'); setError('');
    try {
      await put(`/campaigns/${id}`, { segment: { match, criteria } });
      setDirty(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    } finally { setBusy(''); }
  };

  const freeze = async () => {
    setBusy('freeze'); setError('');
    try {
      const result = await post<{ sentence: string }>(`/campaigns/${id}/audience`);
      toast(result.sentence, 'ok');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the audience.');
    } finally { setBusy(''); }
  };

  return (
    <div class="stack">
      {error && <div class="alert alert-error">{error}</div>}

      <div class="card">
        <div class="card-head">
          <h2>Who it goes to</h2>
          {data.can_edit && !sent && dirty && (
            <button class="btn btn-sm btn-primary" disabled={!!busy} onClick={saveSegment}>
              Save the filter
            </button>
          )}
        </div>
        <div class="card-body">
          <p class="text-sm text-muted">{data.segment_description}</p>

          {data.segment_issues.length > 0 && (
            <div class="alert alert-error">
              <ul>{data.segment_issues.map((i) => <li key={i.message}>{i.message}</li>)}</ul>
            </div>
          )}

          {criteria.length > 1 && (
            <Field label="Match">
              <select value={match} disabled={sent}
                      onChange={(e) => { setMatch((e.target as HTMLSelectElement).value); setDirty(true); }}>
                <option value="all">All of these</option>
                <option value="any">Any of these</option>
              </select>
            </Field>
          )}

          <div class="stack-tight">
            {criteria.map((criterion, index) => {
              const spec = catalogue.fields.find((f) => f.key === criterion.field);
              const needsValue = criterion.op !== 'is_set' && criterion.op !== 'is_empty';
              return (
                <div key={index}>
                  <div class="condition-row">
                    <select value={criterion.field} disabled={sent}
                            onChange={(e) => {
                              setCriteria(criteria.map((c, i) => (i === index
                                ? { ...c, field: (e.target as HTMLSelectElement).value } : c)));
                              setDirty(true);
                            }}>
                      {catalogue.fields.map((f) =>
                        <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                    <select value={criterion.op} disabled={sent}
                            onChange={(e) => {
                              setCriteria(criteria.map((c, i) => (i === index
                                ? { ...c, op: (e.target as HTMLSelectElement).value } : c)));
                              setDirty(true);
                            }}>
                      {OPERATORS.filter(([, , types]) =>
                        !types || types.includes(spec?.type ?? 'text')).map(([op, label]) =>
                        <option key={op} value={op}>{label}</option>)}
                    </select>
                    {needsValue && (
                      spec?.type === 'stage' ? (
                        <select value={String(criterion.value ?? '')} disabled={sent}
                                onChange={(e) => {
                                  setCriteria(criteria.map((c, i) => (i === index
                                    ? { ...c, value: (e.target as HTMLSelectElement).value } : c)));
                                  setDirty(true);
                                }}>
                          <option value="">Choose…</option>
                          {catalogue.stages.map((s) =>
                            <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                      ) : (
                        <input type={spec?.type === 'number' ? 'number' : 'text'} disabled={sent}
                               value={String(criterion.value ?? '')}
                               onInput={(e) => {
                                 const raw = (e.target as HTMLInputElement).value;
                                 setCriteria(criteria.map((c, i) => (i === index
                                   ? { ...c, value: spec?.type === 'number' && raw !== ''
                                       ? Number(raw) : raw } : c)));
                                 setDirty(true);
                               }} />
                      )
                    )}
                    {!sent && (
                      <button class="btn btn-sm btn-ghost" onClick={() => {
                        setCriteria(criteria.filter((_, i) => i !== index));
                        setDirty(true);
                      }}>✕</button>
                    )}
                  </div>
                  {spec?.help && <div class="text-sm text-subtle">{spec.help}</div>}
                </div>
              );
            })}
          </div>

          {!sent && data.can_edit && (
            <button class="btn btn-sm" style={{ marginTop: 10 }} onClick={() => {
              setCriteria([...criteria,
                { field: catalogue.fields[0]!.key, op: 'eq', value: '' }]);
              setDirty(true);
            }}>Add a filter</button>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>The arithmetic</h2>
          {sent && (
            <span class="text-sm text-muted">
              As it was when this was sent — a segment re-run today gives a different answer
            </span>
          )}
        </div>
        <div class="card-body">
          {dirty ? (
            <div class="alert alert-info">
              Save the filter to see who it reaches.
            </div>
          ) : (
            <>
              <p class="audience-sentence">
                {data.audience_sentence
                  ?? `${data.audience.sendable} of ${data.audience.matched} will receive this.`}
              </p>

              {data.audience.suppressed.length > 0 && (
                <div class="stack-tight" style={{ marginTop: 10 }}>
                  {data.audience.suppressed.map((s) => (
                    <div key={s.reason} class="suppress-row">
                      <span class="num">{s.count}</span>
                      <span>{s.reason}</span>
                    </div>
                  ))}
                </div>
              )}

              {data.audience_sample.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary class="text-sm text-muted">A sample of who matched</summary>
                  <div class="stack-tight" style={{ marginTop: 8 }}>
                    {data.audience_sample.map((m) => (
                      <div key={m.customer_id} class="text-sm">
                        <span class={m.allowed ? 'text-ok' : 'text-muted'}>
                          {m.allowed ? '✓' : '✕'}
                        </span>{' '}
                        {m.first_name} {m.last_name}
                        <span class="text-muted"> — {m.reason}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}

          {data.can_edit && !sent && (
            <div class="row" style={{ gap: 8, marginTop: 14 }}>
              <button class="btn" disabled={!!busy || dirty} onClick={freeze}>
                {busy === 'freeze' ? 'Building…' : 'Fix this audience'}
              </button>
              {data.can_send && (
                <button class="btn btn-primary"
                        disabled={data.send_blockers.length > 0 || data.audience.sendable === 0}
                        title={data.send_blockers[0] ?? ''}
                        onClick={() => setConfirming(true)}>
                  Send
                </button>
              )}
            </div>
          )}

          {data.send_blockers.length > 0 && !sent && (
            <div class="alert alert-warn" style={{ marginTop: 10 }}>
              <ul>{data.send_blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            </div>
          )}
        </div>
      </div>

      {confirming && (
        <ConfirmSend id={id} campaign={data.campaign} audience={data.audience}
                     sentence={data.audience_sentence}
                     onClose={() => setConfirming(false)}
                     onSent={() => { setConfirming(false); onChanged(); }} />
      )}
    </div>
  );
}

const OPERATORS: Array<[string, string, string[] | null]> = [
  ['eq', 'is', null],
  ['ne', 'is not', null],
  ['contains', 'contains', ['text']],
  ['gt', 'is more than', ['number', 'date']],
  ['gte', 'is at least', ['number', 'date']],
  ['lt', 'is less than', ['number', 'date']],
  ['lte', 'is at most', ['number', 'date']],
  ['within_days', 'in the last N days', ['date']],
  ['older_than_days', 'more than N days ago, or never', ['date']],
  ['is_set', 'has a value', null],
  ['is_empty', 'is empty', null],
];

function ConfirmSend({ id, campaign, audience, sentence, onClose, onSent }: {
  id: string; campaign: Record<string, any>;
  audience: { sendable: number; matched: number };
  sentence: string | null; onClose: () => void; onSent: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [typed, setTyped] = useState('');

  const send = async () => {
    setBusy(true); setError('');
    try {
      await post(`/campaigns/${id}/send`, { confirm_count: audience.sendable });
      toast('Sending. It is paced, so it will take a few minutes.', 'ok');
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send.');
      setBusy(false);
    }
  };

  return (
    <Modal title="Send this campaign" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary"
                disabled={busy || typed !== String(audience.sendable)} onClick={send}>
          {busy ? 'Sending…' : 'Send it'}
        </button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <p><strong>{sentence}</strong></p>
      <p class="text-sm text-muted">
        {campaign.purpose === 'marketing'
          ? 'Each one carries the brokerage address and a working unsubscribe link, as CASL requires.'
          : 'This is not a commercial message, so it carries no unsubscribe link.'}
        {' '}Sending is paced at {campaign.throttle_per_minute ?? 120} a minute, and can be
        stopped part way.
      </p>
      <Field label={`Type ${audience.sendable} to confirm`}
             hint="The number you are sending to, so it is a number somebody has read.">
        <input value={typed} autofocus
               onInput={(e) => setTyped((e.target as HTMLInputElement).value)} />
      </Field>
    </Modal>
  );
}

// ── Results and preview ────────────────────────────────────────────────────

function ResultsTab({ results, id }: {
  results: NonNullable<EditorPayload['results']>; id: string;
}) {
  const [showing, setShowing] = useState<string | null>(null);
  const c = results.counts;

  return (
    <div class="stack">
      <div class="kpi-grid">
        {[
          ['Sent', c.sent],
          ['Held back', c.suppressed],
          ['Opened', c.opened],
          ['Clicked', c.clicked],
          ['Bounced', c.bounced],
          ['Unsubscribed', c.unsubscribed],
        ].map(([label, value]) => (
          <div key={label as string} class="card kpi">
            <div class="label">{label}</div>
            <div class="value num">{value ?? 0}</div>
          </div>
        ))}
      </div>

      {results.attributions.length > 0 && (
        <div class="card">
          <div class="card-head">
            <h2>What it produced</h2>
            <span class="text-sm text-muted">The part that matters</span>
          </div>
          <div class="card-body row" style={{ gap: 26, flexWrap: 'wrap' }}>
            {results.attributions.map((a) => (
              <div key={a.outcome}>
                <div class="text-sm text-muted">{a.outcome.replace(/_/g, ' ')}</div>
                <div class="num" style={{ fontSize: 22, fontWeight: 640 }}>{a.count}</div>
                {a.value && <div class="text-sm text-muted">{a.value}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {results.suppressed_by_reason.length > 0 && (
        <div class="card">
          <div class="card-head"><h2>Who was held back, and why</h2></div>
          <div class="card-body-flush">
            {results.suppressed_by_reason.map((r) => (
              <div key={r.reason} class="list-row">
                <span>{r.reason}</span>
                <strong class="num">{r.count}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      <div class="card">
        <div class="card-head">
          <h2>Recipients</h2>
          <select value={showing ?? 'all'}
                  onChange={(e) => setShowing((e.target as HTMLSelectElement).value)}>
            <option value="all">Everyone</option>
            <option value="sent">Sent</option>
            <option value="suppressed">Held back</option>
            <option value="problem">Bounced or failed</option>
          </select>
        </div>
        <RecipientList id={id} status={showing ?? 'all'} />
      </div>
    </div>
  );
}

function RecipientList({ id, status }: { id: string; status: string }) {
  const state = useAsync<{ recipients: Array<Record<string, any>> }>(
    `/campaigns/${id}/recipients?status=${status}`, [id, status]);

  if (state.status === 'loading') return <div class="card-body"><Skeleton rows={3} /></div>;
  if (state.status === 'error') return <ErrorNote error={state.error} onRetry={state.reload} />;
  if (state.data.recipients.length === 0) {
    return <Empty title="Nobody in that group" />;
  }

  return (
    <div class="card-body-flush">
      {state.data.recipients.map((r) => (
        <div key={r.id} class="list-row">
          <div style={{ minWidth: 0 }}>
            <button class="link-button"
                    onClick={() => navigate(`/customers?id=${r.customer_id}`)}>
              {r.first_name} {r.last_name}
            </button>
            <div class="text-sm text-muted">
              {r.address}
              {r.suppress_reason ? ` — ${r.suppress_reason}` : ''}
              {r.failure_reason ? ` — ${r.failure_reason}` : ''}
            </div>
          </div>
          <Badge tone={r.status === 'suppressed' ? 'neutral'
            : r.status === 'bounced' || r.status === 'failed' ? 'danger' : 'ok'}>
            {r.status}
          </Badge>
        </div>
      ))}
    </div>
  );
}

function PreviewModal({ id, channel, onClose }: {
  id: string; channel: string; onClose: () => void;
}) {
  const [preview, setPreview] = useState<{
    subject: string | null; subject_missing: string[]; html: string; text: string;
    missing: string[]; dropped: string[]; against: string;
  } | null>(null);
  const [error, setError] = useState('');

  if (!preview && !error) {
    post(`/campaigns/${id}/preview`, {})
      .then((result) => setPreview(result as never))
      .catch(() => setError('Could not render a preview.'));
  }

  return (
    <Modal title="Preview" onClose={onClose}
           footer={<button class="btn" onClick={onClose}>Close</button>}>
      {error && <div class="alert alert-error">{error}</div>}
      {!preview ? <Skeleton rows={4} /> : (
        <>
          <p class="text-sm text-muted">Rendered against {preview.against}.</p>
          {preview.subject_missing.length > 0 && (
            <div class="alert alert-warn">
              The subject needs {preview.subject_missing.join(', ')}. A client with no value
              for that is not sent the campaign at all, rather than being sent a placeholder.
            </div>
          )}
          {preview.subject && (
            <div class="preview-subject">{preview.subject}</div>
          )}
          {channel === 'email' ? (
            <iframe class="email-preview" srcdoc={preview.html} sandbox=""
                    title="Email preview" />
          ) : (
            <pre class="preview-body">{preview.text}</pre>
          )}
          {preview.dropped.length > 0 && (
            <div class="text-sm text-muted">
              {preview.dropped.length} line(s) would be left out for a client with no value
              for the fields in them.
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
