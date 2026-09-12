/**
 * Communication.
 *
 * One composer, one path. The gate's answer for this client is shown before
 * a word is typed rather than after send, because "you cannot text this
 * client, they replied STOP in March" is useful before you write the text
 * and merely annoying afterwards.
 *
 * A suppressed send is not an error. The broker did nothing wrong, the
 * system declined on the client's behalf, and it appears in the thread with
 * the reason — which is how the next person to open the file knows why the
 * client was never told.
 */
import { useState } from 'preact/hooks';
import { ApiError, formatDateTime, post, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Field, Skeleton } from '../components/ui.tsx';

type Message = {
  id: string; channel: string; direction: string; origin: string; purpose: string;
  subject: string | null; body_text: string | null; status: string;
  sent_at: string | null; delivered_at: string | null; failed_at: string | null;
  failure_reason: string | null; read_at: string | null; created_at: string;
  gate_decision: { reason?: string } | null; template_key: string | null;
  to_address: string | null; sent_by_name: string | null;
  campaign_name: string | null; automation_name: string | null;
};

type Gate = {
  allowed: boolean; code: string; reason: string; address: string | null;
  marketing: { allowed: boolean; reason: string };
};

type Payload = {
  customer: { id: string; first_name: string; last_name: string;
              email: string | null; phone_e164: string | null };
  messages: Message[];
  can_send: boolean;
  gates: { email: Gate; sms: Gate };
  templates: Array<{ key: string; name: string; channel: string; subject: string | null;
                     body_text: string }>;
};

export function CommunicationTab({ customerId, applicationId, session }: {
  customerId: string; applicationId: string; session: Session;
}) {
  const state = useAsync<Payload>(`/customers/${customerId}/messages`, [customerId]);
  const [composing, setComposing] = useState<'email' | 'sms' | null>(null);

  if (state.status === 'loading') return <Skeleton rows={4} height={60} />;
  if (state.status === 'error') {
    return <ErrorNote error={state.error} code={state.code} permission={state.permission}
                      onRetry={state.reload} />;
  }

  const d = state.data;

  return (
    <div class="stack">
      {d.can_send && (
        <div class="card">
          <div class="card-body">
            <div class="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button class="btn" disabled={composing === 'email'}
                      onClick={() => setComposing('email')}>Write an email</button>
              <button class="btn" disabled={composing === 'sms'}
                      onClick={() => setComposing('sms')}>Send a text</button>
              {d.customer.phone_e164 && (
                <a class="btn" href={`tel:${d.customer.phone_e164}`}>Call</a>
              )}
            </div>

            <div class="gate-summary">
              {(['email', 'sms'] as const).map((channel) => {
                const gate = d.gates[channel];
                return (
                  <div key={channel} class="gate-row">
                    <span class={`gate-mark ${gate.allowed ? 'on' : 'off'}`} aria-hidden="true">
                      {gate.allowed ? '✓' : '✕'}
                    </span>
                    <div>
                      <strong class="text-sm">
                        {channel === 'sms' ? 'Text' : 'Email'}
                        {gate.address ? ` · ${gate.address}` : ''}
                      </strong>
                      <div class="text-sm text-muted">{gate.reason}</div>
                      {gate.allowed && !gate.marketing.allowed && (
                        <div class="text-sm text-subtle">
                          Anything commercial: {gate.marketing.reason}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {composing && (
        <Composer channel={composing} customerId={customerId} applicationId={applicationId}
                  gate={d.gates[composing]} templates={d.templates}
                  onClose={() => setComposing(null)}
                  onSent={() => { setComposing(null); state.reload(); }} />
      )}

      <div class="card">
        <div class="card-head">
          <h2>Everything said to this client</h2>
          <span class="text-sm text-muted">{d.messages.length} message(s)</span>
        </div>
        <div class="card-body-flush">
          {d.messages.length === 0 ? (
            <Empty title="Nothing yet">
              Every email and text sent from the CRM appears here, including the ones the
              system declined to send and why.
            </Empty>
          ) : (
            <div class="thread">
              {d.messages.map((m) => <MessageRow key={m.id} message={m} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageRow({ message: m }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const suppressed = m.status === 'suppressed';
  const failed = m.status === 'failed';
  const inbound = m.direction === 'inbound';

  return (
    <div class={`message message-${inbound ? 'in' : 'out'}`
      + (suppressed ? ' message-suppressed' : '') + (failed ? ' message-failed' : '')}>
      <div class="message-meta">
        <span>
          {inbound ? 'From the client' : m.sent_by_name ?? 'The system'}
          {m.campaign_name ? ` · campaign "${m.campaign_name}"` : ''}
          {m.automation_name ? ` · automation "${m.automation_name}"` : ''}
          {m.origin === 'automation' && !m.automation_name ? ' · automation' : ''}
        </span>
        <span class="text-subtle">
          {m.channel === 'sms' ? 'Text' : 'Email'} · {relativeTime(m.created_at)}
        </span>
      </div>

      {m.subject && <div class="message-subject">{m.subject}</div>}
      <div class={`message-body${open ? '' : ' message-clamped'}`}
           onClick={() => setOpen(!open)}>
        {m.body_text}
      </div>

      {(suppressed || failed) && (
        <div class="message-note">
          <Badge tone={suppressed ? 'neutral' : 'danger'}>
            {suppressed ? 'Not sent' : 'Failed'}
          </Badge>{' '}
          {m.gate_decision?.reason ?? m.failure_reason ?? 'No reason recorded'}
        </div>
      )}
      {!suppressed && !failed && !inbound && (
        <div class="message-note text-subtle">
          {m.delivered_at ? `Delivered ${formatDateTime(m.delivered_at)}`
            : m.sent_at ? `Sent ${formatDateTime(m.sent_at)}`
            : 'Queued'}
        </div>
      )}
    </div>
  );
}

function Composer({ channel, customerId, applicationId, gate, templates, onClose, onSent }: {
  channel: 'email' | 'sms'; customerId: string; applicationId: string;
  gate: Gate; templates: Payload['templates'];
  onClose: () => void; onSent: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [purpose, setPurpose] = useState('transactional');
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<string[]>([]);
  const [preview, setPreview] = useState<{
    text: string; subject: string | null; missing: string[]; dropped: string[];
    empty: boolean; issues: Array<{ message: string }>;
    segments: { segments: number; encoding: string; characters: number;
                offenders: string[] } | null;
  } | null>(null);

  const usable = templates.filter((t) => t.channel === channel);
  const blocked = purpose === 'marketing' ? !gate.marketing.allowed : !gate.allowed;
  const blockedReason = purpose === 'marketing' ? gate.marketing.reason : gate.reason;

  const runPreview = async () => {
    try {
      const result = await post(`/customers/${customerId}/messages/preview`,
        { channel, subject, body_text: text, application_id: applicationId });
      setPreview(result as never);
    } catch { /* the preview is a convenience; its failure is not an error */ }
  };

  const submit = async () => {
    setBusy(true); setError(''); setDetail([]);
    try {
      const result = await post<{ ok: boolean; reason: string; dropped: string[] }>(
        `/customers/${customerId}/messages`, {
          channel, purpose, subject: subject || undefined, body_text: text,
          application_id: applicationId, urgent,
        });
      toast(result.ok ? 'Sent.' : `Not sent — ${result.reason}`, result.ok ? 'ok' : 'info');
      onSent();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setDetail((err.detail as string[] | undefined) ?? []);
      } else setError('Could not send that.');
      setBusy(false);
    }
  };

  return (
    <div class="card">
      <div class="card-head">
        <h2>{channel === 'sms' ? 'Text' : 'Email'} this client</h2>
        <button class="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
      </div>
      <div class="card-body">
        {error && (
          <div class="alert alert-error">
            {error}
            {detail.length > 1 && <ul>{detail.map((d) => <li key={d}>{d}</li>)}</ul>}
          </div>
        )}

        {blocked && (
          <div class="alert alert-warn">
            <strong>This will not be sent.</strong> {blockedReason} You can still write it —
            it is recorded on the file, with the reason, either way.
          </div>
        )}

        {usable.length > 0 && (
          <Field label="Start from a template">
            <select onChange={(e) => {
              const template = usable.find(
                (t) => t.key === (e.target as HTMLSelectElement).value);
              if (!template) return;
              setSubject(template.subject ?? '');
              setText(template.body_text);
              setPreview(null);
            }}>
              <option value="">Write it myself</option>
              {usable.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
          </Field>
        )}

        {channel === 'email' && (
          <Field label="Subject">
            <input value={subject} autofocus
                   onInput={(e) => { setSubject((e.target as HTMLInputElement).value);
                                     setPreview(null); }} />
          </Field>
        )}

        <Field
          label="Message"
          hint="Merge fields work here. A line whose field has no value is left out entirely."
        >
          <textarea rows={channel === 'sms' ? 4 : 9} value={text}
                    onInput={(e) => { setText((e.target as HTMLTextAreaElement).value);
                                      setPreview(null); }} />
        </Field>

        <Field
          label="What kind of message is this"
          hint={purpose === 'marketing'
            ? 'Commercial content. Goes only to clients with a marketing consent.'
            : 'About the mortgage this client asked us to arrange.'}
        >
          <select value={purpose}
                  onChange={(e) => setPurpose((e.target as HTMLSelectElement).value)}>
            <option value="transactional">About their own file</option>
            <option value="service">A service notice</option>
            <option value="marketing">Commercial — rates, news, an offer</option>
          </select>
        </Field>

        <div class="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button class="btn btn-sm" onClick={runPreview} disabled={!text.trim()}>
            Preview
          </button>
          <label class="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={urgent}
                   onChange={(e) => setUrgent((e.target as HTMLInputElement).checked)} />
            <span class="text-sm">
              Send now even inside quiet hours
              <span class="text-subtle d-block">
                For something they are waiting on. Never for anything commercial.
              </span>
            </span>
          </label>
        </div>

        {preview && (
          <div class="preview">
            {preview.issues.length > 0 && (
              <div class="alert alert-error">
                <ul>{preview.issues.map((i) => <li key={i.message}>{i.message}</li>)}</ul>
              </div>
            )}
            {preview.subject && <div class="preview-subject">{preview.subject}</div>}
            <pre class="preview-body">{preview.text || '(nothing would be sent)'}</pre>
            {preview.dropped.length > 0 && (
              <div class="text-sm text-muted">
                {preview.dropped.length} line(s) left out — no value for{' '}
                {preview.missing.join(', ')}.
              </div>
            )}
            {preview.segments && (
              <div class="text-sm text-muted">
                {preview.segments.characters} character(s),{' '}
                {preview.segments.segments} segment(s), {preview.segments.encoding}.
                {preview.segments.offenders.length > 0 && (
                  <>
                    {' '}A single curly quote or emoji drops the limit from 160 characters to
                    70 — replacing{' '}
                    {preview.segments.offenders.map((c) => `"${c}"`).join(', ')} would shorten
                    it.
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div class="row" style={{ gap: 8, marginTop: 14 }}>
          <button class="btn btn-primary" disabled={busy || !text.trim()} onClick={submit}>
            {busy ? 'Sending…' : blocked ? 'Record it anyway' : 'Send'}
          </button>
          <button class="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── The brokerage inbox ────────────────────────────────────────────────────

/**
 * What has come in, and what nobody has replied to.
 *
 * The unmatched list is the part worth having: an inbound text from a number
 * that matches two clients is held rather than attached to the wrong file,
 * and this is where somebody resolves it.
 */
export function MessagesPage({ session }: { session: Session }) {
  const [filter, setFilter] = useState('unread');
  const state = useAsync<{
    messages: Array<Record<string, any>>;
    unmatched: Array<{ id: string; channel: string; from_address: string;
                       body_text: string; received_at: string; reason: string }>;
  }>(`/messages?filter=${filter}`, [filter]);

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Messages</h1>
          <p>What has come in, and what is still waiting on a reply.</p>
        </div>
        <select value={filter} onChange={(e) => setFilter((e.target as HTMLSelectElement).value)}>
          <option value="unread">Unread</option>
          <option value="inbound">Everything inbound</option>
          <option value="awaiting_reply">Waiting on us</option>
          <option value="suppressed">Not sent</option>
          <option value="all">Everything</option>
        </select>
      </div>

      {state.status === 'loading' && <Skeleton rows={5} height={60} />}
      {state.status === 'error' && (
        <ErrorNote error={state.error} code={state.code} permission={state.permission}
                   onRetry={state.reload} />
      )}

      {state.status === 'ready' && (
        <div class="stack">
          {state.data.unmatched.length > 0 && (
            <div class="card">
              <div class="card-head">
                <h2>Could not be matched to a client</h2>
                <Badge tone="warn">{state.data.unmatched.length}</Badge>
              </div>
              <div class="card-body-flush">
                {state.data.unmatched.map((u) => (
                  <div key={u.id} class="list-row">
                    <div style={{ minWidth: 0 }}>
                      <strong>{u.from_address}</strong>
                      <div class="text-sm text-muted">{u.body_text}</div>
                      <div class="text-sm text-subtle">
                        {u.reason} · {relativeTime(u.received_at)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div class="card-body text-sm text-muted">
                Held rather than attached to a guess. A message on the wrong client's file is
                worse than one on nobody's.
              </div>
            </div>
          )}

          <div class="card">
            <div class="card-head"><h2>Messages</h2></div>
            <div class="card-body-flush">
              {state.data.messages.length === 0 ? (
                <Empty title="Nothing here" />
              ) : state.data.messages.map((m) => (
                <button key={m.id} class="priority-item"
                        onClick={() => m.application_id
                          && navigate(`/applications/${m.application_id}?tab=communication`)}>
                  <span>
                    <div class="action">
                      {m.first_name} {m.last_name}
                      {m.direction === 'inbound' && !m.read_at && (
                        <Badge tone="info">New</Badge>
                      )}
                      {m.status === 'suppressed' && <Badge tone="neutral">Not sent</Badge>}
                    </div>
                    <div class="reason">
                      {m.subject ? `${m.subject} — ` : ''}
                      {String(m.body_text ?? '').slice(0, 110)}
                    </div>
                    <div class="reason text-subtle">
                      {m.channel === 'sms' ? 'Text' : 'Email'} · {relativeTime(m.created_at)}
                      {m.awaiting_reply_since
                        && ` · waiting since ${relativeTime(m.awaiting_reply_since)}`}
                    </div>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
