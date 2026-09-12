/**
 * Automations: the list, and the builder.
 *
 * The builder is a VERTICAL SEQUENCE, not a drag-around canvas. A canvas
 * looks impressive in a screenshot and is worse at the job: these sequences
 * are almost always a line with the occasional fork, the person editing one
 * is usually reading it rather than rearranging it, and a canvas is unusable
 * on a phone. So the steps run top to bottom in the order they happen, a
 * branch shows both of its paths inline, and the connector between two steps
 * is where you add the next one.
 *
 * Three things are on screen at all times because they are what the sequence
 * DOES rather than how it looks: what starts it, what stops it, and every
 * problem the validator has with it.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ApiError, formatDateTime, post, put, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, useRoute, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Field, Modal, Skeleton } from '../components/ui.tsx';

// ── Shapes, mirroring the server's definition schema ───────────────────────

type Condition = { field: string; op: string; value?: unknown; reason?: string };

type Node = {
  key: string; type: string; label?: string; next?: string | null;
  [more: string]: unknown;
};

type Definition = {
  trigger: { type: string; offset_days?: number; after_hours?: number; filters: Condition[] };
  entry_conditions: Condition[];
  stop_conditions: Array<Condition & { reason: string }>;
  start_node: string;
  nodes: Node[];
};

type Issue = { level: 'error' | 'warning'; message: string; node?: string };

type Catalogue = {
  triggers: Array<{ type: string; label: string }>;
  node_types: Array<{ type: string; label: string; icon: string }>;
  operators: Array<{ op: string; label: string }>;
  fields: Array<{ field: string; label: string; type: string; options?: string[] }>;
  merge_fields: Array<{ name: string; label: string; example: string }>;
  stages: Array<{ key: string; label: string; category: string }>;
};

type Summary = {
  id: string; key: string; name: string; description: string | null;
  status: string; purpose: string; published_version: number | null;
  latest_version: number | null; trigger_type: string | null;
  allow_reenrollment: boolean; reenrollment_cooldown_days: number | null;
  active_enrollments: number; completed_enrollments: number;
  stopped_enrollments: number; messages_sent: number; updated_at: string;
};

// ── The list ───────────────────────────────────────────────────────────────

export function AutomationsPage({ session }: { session: Session }) {
  const { query } = useRoute();
  const editing = query.get('id');
  if (editing) return <AutomationEditor id={editing} session={session} />;

  const state = useAsync<{ automations: Summary[]; trigger_labels: Record<string, string> }>(
    '/automations');
  const [creating, setCreating] = useState(query.get('new') === '1');
  const canEdit = session.permissions.includes('automation.edit');

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Automations</h1>
          <p>
            Sequences that run on their own. Each one records why it started, every step it
            took and the condition that ended it — and any of them can be stopped for one
            client from that client’s file.
          </p>
        </div>
        {canEdit && (
          <button class="btn btn-primary" onClick={() => setCreating(true)}>New automation</button>
        )}
      </div>

      {state.status === 'loading' && <Skeleton rows={4} height={76} />}
      {state.status === 'error' && <ErrorNote error={state.error} onRetry={state.reload} />}

      {state.status === 'ready' && (
        state.data.automations.length === 0 ? (
          <div class="card"><Empty title="No automations yet">
            Nothing runs on its own until somebody builds and publishes it.
          </Empty></div>
        ) : (
          <div class="stack">
            {['active', 'paused', 'draft'].map((group) => {
              const rows = state.data.automations.filter((a) => a.status === group);
              if (!rows.length) return null;
              return (
                <div key={group}>
                  <h2 class="section-heading">
                    {group === 'active' ? 'Running' : group === 'paused' ? 'Paused' : 'Drafts'}
                    <span class="text-muted"> · {rows.length}</span>
                  </h2>
                  <div class="stack-tight">
                    {rows.map((a) => (
                      <AutomationRow key={a.id} automation={a}
                                     triggerLabel={state.data.trigger_labels[a.trigger_type ?? ''] ?? a.trigger_type} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {creating && (
        <NewAutomation onClose={() => setCreating(false)}
                       onCreated={(id) => navigate(`/automations?id=${id}`)} />
      )}
    </div>
  );
}

function AutomationRow({ automation: a, triggerLabel }: {
  automation: Summary; triggerLabel: string | null;
}) {
  const unpublished = a.published_version !== null && a.latest_version !== a.published_version;
  return (
    <button class="flow-row" onClick={() => navigate(`/automations?id=${a.id}`)}>
      <div class="flow-row-main">
        <div class="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{a.name}</strong>
          {a.purpose === 'marketing' && <Badge tone="warn">Marketing</Badge>}
          {unpublished && <Badge tone="info">Unpublished changes</Badge>}
        </div>
        <div class="text-sm text-muted">
          {triggerLabel ? `Starts when: ${triggerLabel}` : 'No trigger set'}
          {a.description ? ` · ${a.description}` : ''}
        </div>
      </div>
      <div class="flow-row-stats">
        <span title="Clients part way through"><strong class="num">{a.active_enrollments}</strong> running</span>
        <span title="Clients who finished"><strong class="num">{a.completed_enrollments}</strong> finished</span>
        <span title="Sequences that met a stop condition"><strong class="num">{a.stopped_enrollments}</strong> stopped</span>
        <span title="Messages sent by this automation"><strong class="num">{a.messages_sent}</strong> sent</span>
      </div>
    </button>
  );
}

function NewAutomation({ onClose, onCreated }: {
  onClose: () => void; onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('transactional');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true); setError('');
    try {
      const created = await post<{ id: string }>('/automations', { name, purpose, description });
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that.');
      setBusy(false);
    }
  };

  return (
    <Modal title="New automation" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>
          {busy ? 'Creating…' : 'Create draft'}
        </button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <Field label="Name">
        <input value={name} autofocus placeholder="Outstanding document reminder"
               onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="What it is for" hint="Shown in the list, not to clients.">
        <input value={description}
               onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
      </Field>
      <Field
        label="Purpose"
        hint={purpose === 'marketing'
          ? 'Every message this sends is treated as commercial, and goes only to clients with a marketing consent on file.'
          : 'Transactional messages are about the mortgage the client asked us to arrange.'}
      >
        <select value={purpose} onChange={(e) => setPurpose((e.target as HTMLSelectElement).value)}>
          <option value="transactional">Transactional — about their own file</option>
          <option value="service">Service — renewals and account notices</option>
          <option value="marketing">Marketing — commercial content</option>
        </select>
      </Field>
    </Modal>
  );
}

// ── The editor ─────────────────────────────────────────────────────────────

type EditorPayload = {
  automation: Summary;
  versions: Array<{
    version: number; published_at: string | null; notes: string | null;
    published_by_name: string | null; running: number;
  }>;
  draft_version: number | null;
  definition: Definition | null;
  issues: Issue[];
};

function AutomationEditor({ id, session }: { id: string; session: Session }) {
  const state = useAsync<EditorPayload>(`/automations/${id}`, [id]);
  const catalogue = useAsync<Catalogue>('/automations/catalogue');
  const [definition, setDefinition] = useState<Definition | null>(null);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'build' | 'enrollments' | 'versions'>('build');

  useEffect(() => {
    if (state.status === 'ready' && state.data.definition && !dirty) {
      setDefinition(structuredClone(state.data.definition));
      setIssues(state.data.issues);
    }
  }, [state.status, state.status === 'ready' ? state.data.draft_version : null]);

  const canEdit = session.permissions.includes('automation.edit');
  const canPublish = session.permissions.includes('automation.publish');

  const change = (next: Definition) => { setDefinition(next); setDirty(true); };

  const save = async () => {
    if (!definition) return;
    setSaving(true);
    try {
      const result = await put<{ issues: Issue[] }>(`/automations/${id}`, { definition });
      setIssues(result.issues);
      setDirty(false);
      toast('Draft saved.', 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const publish = async (acknowledge = false) => {
    try {
      const result = await post<{ ok: boolean; needs_acknowledgement?: boolean; issues?: Issue[] }>(
        `/automations/${id}/publish`, { acknowledge });
      if (result.ok) { toast('Published. It is running now.', 'ok'); state.reload(); }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const warnings = (err.body as { issues?: Issue[] } | undefined)?.issues ?? [];
        const message = warnings.map((w) => `· ${w.message}`).join('\n\n');
        if (confirm(`Publish anyway?\n\n${message}`)) await publish(true);
        return;
      }
      if (err instanceof ApiError) setIssues((err.detail as Issue[] | undefined) ?? issues);
      toast(err instanceof ApiError ? err.message : 'Could not publish.', 'error');
    }
  };

  if (state.status === 'loading' || catalogue.status === 'loading') {
    return <div class="content-narrow"><Skeleton rows={6} height={60} /></div>;
  }
  if (state.status === 'error') {
    return <div class="content-narrow"><ErrorNote error={state.error} onRetry={state.reload} /></div>;
  }
  if (catalogue.status === 'error') {
    return <div class="content-narrow"><ErrorNote error={catalogue.error} onRetry={catalogue.reload} /></div>;
  }

  const a = state.data.automation;
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const unpublished = state.data.draft_version !== a.published_version;

  return (
    <div class="content">
      <div class="page-head">
        <div>
          <button class="btn btn-ghost btn-sm" onClick={() => navigate('/automations')}>
            ← All automations
          </button>
          <h1 style={{ marginTop: 6 }}>{a.name}</h1>
          <p>
            <Badge tone={a.status === 'active' ? 'ok' : a.status === 'paused' ? 'warn' : 'neutral'}>
              {a.status === 'active' ? 'Running' : a.status === 'paused' ? 'Paused' : 'Draft'}
            </Badge>
            {' '}
            {a.published_version
              ? `Version ${a.published_version} is live.`
              : 'Never published — nothing is running.'}
            {unpublished && ' There are unpublished changes.'}
          </p>
        </div>
        <div class="row" style={{ gap: 8 }}>
          {canEdit && (
            <button class="btn" disabled={!dirty || saving} onClick={save}>
              {saving ? 'Saving…' : dirty ? 'Save draft' : 'Saved'}
            </button>
          )}
          {canPublish && (
            <button class="btn btn-primary"
                    disabled={dirty || errors.length > 0 || (!unpublished && a.status === 'active')}
                    title={
                      dirty ? 'Save the draft first.'
                        : errors.length ? 'Fix the problems below.'
                        : !unpublished && a.status === 'active'
                          ? 'The live version already matches this draft.'
                          : ''
                    }
                    onClick={() => publish(false)}>
              {a.published_version ? 'Publish changes' : 'Publish'}
            </button>
          )}
          {canPublish && a.status === 'active' && (
            <AutomationStatusButton id={id} onChanged={state.reload} />
          )}
        </div>
      </div>

      <div class="tabs" role="tablist">
        {([['build', 'Build'], ['enrollments', `Clients (${a.active_enrollments})`],
           ['versions', 'Versions']] as const).map(([key, label]) => (
          <button key={key} class="tab" role="tab" aria-selected={tab === key}
                  onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === 'build' && definition && (
        <>
          <IssueList errors={errors} warnings={warnings} />
          <Builder
            definition={definition}
            catalogue={catalogue.data}
            readOnly={!canEdit}
            onChange={change}
          />
        </>
      )}

      {tab === 'enrollments' && <Enrollments id={id} session={session} />}

      {tab === 'versions' && (
        <div class="card">
          <div class="card-head"><h2>Versions</h2></div>
          <div class="card-body-flush">
            {state.data.versions.map((v) => (
              <div key={v.version} class="list-row">
                <div>
                  <strong>Version {v.version}</strong>
                  <div class="text-sm text-muted">
                    {v.published_at
                      ? `Published ${formatDateTime(v.published_at)}${v.published_by_name ? ` by ${v.published_by_name}` : ''}`
                      : 'Never published — this is the working draft'}
                  </div>
                </div>
                <div class="text-sm text-muted">
                  {v.running > 0
                    ? `${v.running} client(s) are still running this version`
                    : '—'}
                </div>
              </div>
            ))}
          </div>
          <div class="card-body text-sm text-muted">
            A published version is frozen. Editing this automation writes a new version, so a
            client part way through keeps receiving the sequence they started on.
          </div>
        </div>
      )}
    </div>
  );
}

function AutomationStatusButton({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [asking, setAsking] = useState(false);
  const [stopRunning, setStopRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  const pause = async () => {
    setBusy(true);
    try {
      const result = await post<{ enrollments_stopped: number }>(`/automations/${id}/status`,
        { status: 'paused', stop_running: stopRunning });
      toast(result.enrollments_stopped
        ? `Paused, and ended ${result.enrollments_stopped} running sequence(s).`
        : 'Paused. No new clients will be enrolled; the ones part way through will finish.', 'ok');
      setAsking(false);
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not pause.', 'error');
    } finally { setBusy(false); }
  };

  return (
    <>
      <button class="btn" onClick={() => setAsking(true)}>Pause</button>
      {asking && (
        <Modal title="Pause this automation" onClose={() => setAsking(false)} footer={
          <>
            <button class="btn" onClick={() => setAsking(false)}>Cancel</button>
            <button class="btn btn-primary" disabled={busy} onClick={pause}>Pause</button>
          </>
        }>
          <p>No new client will be enrolled.</p>
          <label class="check">
            <input type="checkbox" checked={stopRunning}
                   onChange={(e) => setStopRunning((e.target as HTMLInputElement).checked)} />
            <span>
              Also end the sequences already running.
              <span class="text-sm text-muted d-block">
                Without this, clients part way through finish normally — which is usually what
                you want, because abandoning somebody mid-sequence is a bigger surprise than
                letting the last message arrive.
              </span>
            </span>
          </label>
        </Modal>
      )}
    </>
  );
}

function IssueList({ errors, warnings }: { errors: Issue[]; warnings: Issue[] }) {
  if (!errors.length && !warnings.length) return null;
  return (
    <div class="stack-tight" style={{ marginBottom: 14 }}>
      {errors.length > 0 && (
        <div class="alert alert-error">
          <strong>{errors.length === 1 ? 'One problem' : `${errors.length} problems`} to fix before publishing</strong>
          <ul>{errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div class="alert alert-warn">
          <ul>{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ── The builder ────────────────────────────────────────────────────────────

function Builder({ definition, catalogue, readOnly, onChange }: {
  definition: Definition;
  catalogue: Catalogue;
  readOnly: boolean;
  onChange: (next: Definition) => void;
}) {
  const byKey = useMemo(
    () => new Map(definition.nodes.map((n) => [n.key, n])), [definition]);

  /** The order the steps actually happen in, following `next` from the start. */
  const order = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ node: Node; depth: number; branchLabel?: string }> = [];
    const walk = (key: string | null | undefined, depth: number, branchLabel?: string): void => {
      if (!key || seen.has(key)) return;
      const node = byKey.get(key);
      if (!node) return;
      seen.add(key);
      out.push({ node, depth, branchLabel });
      if (node.type === 'branch') {
        walk(node.if_true as string, depth + 1, 'If it is true');
        walk(node.if_false as string, depth + 1, 'Otherwise');
      } else {
        walk(node.next, depth);
      }
    };
    walk(definition.start_node, 0);
    // Anything the walk never reached is still shown — an orphan you cannot
    // see is an orphan you cannot delete.
    for (const node of definition.nodes) {
      if (!seen.has(node.key)) out.push({ node, depth: 0, branchLabel: 'Not connected' });
    }
    return out;
  }, [definition, byKey]);

  const replaceNode = (key: string, patch: Partial<Node>) =>
    onChange({
      ...definition,
      nodes: definition.nodes.map((n) => (n.key === key ? { ...n, ...patch } : n)),
    });

  const removeNode = (key: string) => {
    const node = byKey.get(key);
    if (!node) return;
    const successor = node.type === 'branch' ? null : (node.next ?? null);
    onChange({
      ...definition,
      start_node: definition.start_node === key ? (successor ?? '') : definition.start_node,
      nodes: definition.nodes
        .filter((n) => n.key !== key)
        // Rewire anything pointing at the removed step to what followed it,
        // so deleting a step in the middle does not sever the sequence.
        .map((n) => {
          const fixed: Node = { ...n };
          if (fixed.next === key) fixed.next = successor;
          if (fixed.if_true === key) fixed.if_true = successor;
          if (fixed.if_false === key) fixed.if_false = successor;
          return fixed;
        }),
    });
  };

  /** Insert a new step immediately after `afterKey` (or at the top). */
  const insertAfter = (afterKey: string | null, type: string, slot?: 'if_true' | 'if_false') => {
    const key = uniqueKey(type, definition.nodes.map((n) => n.key));
    const previous = afterKey ? byKey.get(afterKey) : null;
    const successor = !previous ? definition.start_node
      : slot ? (previous[slot] as string | null)
      : (previous.next ?? null);

    const node: Node = { ...defaultsFor(type, catalogue), key, next: successor ?? null };
    const nodes = [...definition.nodes, node];

    onChange({
      ...definition,
      start_node: afterKey ? definition.start_node : key,
      nodes: afterKey
        ? nodes.map((n) => (n.key === afterKey
          ? { ...n, [slot ?? 'next']: key }
          : n))
        : nodes,
    });
  };

  return (
    <div class="builder">
      <div class="builder-flow">
        <TriggerCard definition={definition} catalogue={catalogue} readOnly={readOnly}
                     onChange={onChange} />

        {!readOnly && <Connector onAdd={(type) => insertAfter(null, type)} catalogue={catalogue} />}

        {order.length === 0 && (
          <div class="card"><Empty title="No steps yet">
            Add the first thing this sequence should do.
          </Empty></div>
        )}

        {order.map(({ node, depth, branchLabel }) => (
          <div key={node.key} style={{ marginLeft: depth * 22 }}>
            {branchLabel && (
              <div class={`branch-label${branchLabel === 'Not connected' ? ' branch-orphan' : ''}`}>
                {branchLabel}
              </div>
            )}
            <StepCard
              node={node}
              catalogue={catalogue}
              readOnly={readOnly}
              isStart={node.key === definition.start_node}
              onChange={(patch) => replaceNode(node.key, patch)}
              onRemove={() => removeNode(node.key)}
            />
            {!readOnly && node.type !== 'stop' && node.type !== 'branch' && (
              <Connector onAdd={(type) => insertAfter(node.key, type)} catalogue={catalogue} />
            )}
            {!readOnly && node.type === 'branch' && (
              <div class="row" style={{ gap: 10, marginLeft: 22 }}>
                <Connector label="Add to the true path" catalogue={catalogue}
                           onAdd={(type) => insertAfter(node.key, type, 'if_true')} />
                <Connector label="Add to the other path" catalogue={catalogue}
                           onAdd={(type) => insertAfter(node.key, type, 'if_false')} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div class="builder-side">
        <StopConditions definition={definition} catalogue={catalogue} readOnly={readOnly}
                        onChange={onChange} />
        <MergeFieldList catalogue={catalogue} />
      </div>
    </div>
  );
}

function Connector({ onAdd, catalogue, label = 'Add a step' }: {
  onAdd: (type: string) => void; catalogue: Catalogue; label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div class="connector">
      <span class="connector-line" aria-hidden="true" />
      {open ? (
        <div class="connector-menu">
          {catalogue.node_types.map((t) => (
            <button key={t.type} class="connector-choice"
                    onClick={() => { onAdd(t.type); setOpen(false); }}>
              {t.label}
            </button>
          ))}
          <button class="connector-choice connector-cancel"
                  onClick={() => setOpen(false)}>Cancel</button>
        </div>
      ) : (
        <button class="connector-add" onClick={() => setOpen(true)}>+ {label}</button>
      )}
    </div>
  );
}

function StepCard({ node, catalogue, readOnly, isStart, onChange, onRemove }: {
  node: Node; catalogue: Catalogue; readOnly: boolean; isStart: boolean;
  onChange: (patch: Partial<Node>) => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const typeLabel = catalogue.node_types.find((t) => t.type === node.type)?.label ?? node.type;

  return (
    <div class={`step-card${open ? ' step-open' : ''}`}>
      <button class="step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class={`step-type step-${node.type}`}>{typeLabel}</span>
        <span class="step-summary">{describe(node, catalogue)}</span>
        {isStart && <Badge tone="accent">First</Badge>}
        <span class="step-chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>

      {open && (
        <div class="step-body">
          <StepFields node={node} catalogue={catalogue} readOnly={readOnly} onChange={onChange} />
          {!readOnly && (
            <div class="row-between" style={{ marginTop: 12 }}>
              <span class="text-sm text-muted">Step id: <code>{node.key}</code></span>
              <button class="btn btn-sm btn-danger" onClick={onRemove}>Remove this step</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepFields({ node, catalogue, readOnly, onChange }: {
  node: Node; catalogue: Catalogue; readOnly: boolean;
  onChange: (patch: Partial<Node>) => void;
}) {
  const text = (name: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input value={String(node[name] ?? '')} disabled={readOnly}
             onInput={(e) => onChange({ [name]: (e.target as HTMLInputElement).value })} />
    </Field>
  );
  const number = (name: string, label: string) => (
    <Field label={label}>
      <input type="number" min={0} value={Number(node[name] ?? 0)} disabled={readOnly}
             onInput={(e) => onChange({ [name]: Number((e.target as HTMLInputElement).value) })} />
    </Field>
  );

  switch (node.type) {
    case 'send_email':
    case 'send_sms':
      return (
        <>
          {node.type === 'send_email' && text('subject', 'Subject')}
          <Field
            label="Message"
            hint="A line whose merge field has no value is left out entirely — never sent blank
                  and never sent as zero."
          >
            <textarea rows={7} value={String(node.body ?? '')} disabled={readOnly}
                      onInput={(e) => onChange({ body: (e.target as HTMLTextAreaElement).value })} />
          </Field>
          <MessagePreview body={String(node.body ?? '')}
                          subject={node.type === 'send_email' ? String(node.subject ?? '') : undefined} />
        </>
      );

    case 'wait':
      return (
        <>
          <div class="grid-3">
            {number('days', 'Days')}
            {number('hours', 'Hours')}
            {number('minutes', 'Minutes')}
          </div>
          <label class="check">
            <input type="checkbox" checked={node.business_hours_only === true} disabled={readOnly}
                   onChange={(e) => onChange({
                     business_hours_only: (e.target as HTMLInputElement).checked })} />
            <span>
              Hold until working hours
              <span class="text-sm text-muted d-block">
                Without this, a two-day wait set on a Friday afternoon lands on Sunday.
              </span>
            </span>
          </label>
        </>
      );

    case 'branch':
      return (
        <>
          <ConditionEditor
            conditions={(node.conditions as Condition[]) ?? []}
            match={(node.match as 'all' | 'any') ?? 'all'}
            catalogue={catalogue}
            readOnly={readOnly}
            onChange={(conditions, match) => onChange({ conditions, match })}
          />
          <p class="text-sm text-muted">
            Both paths are shown under this step in the sequence above.
          </p>
        </>
      );

    case 'create_task':
      return (
        <>
          {text('title', 'Task title', 'Merge fields work here too.')}
          {text('description', 'Notes')}
          <div class="grid-3">
            <Field label="Priority">
              <select value={String(node.priority ?? 'normal')} disabled={readOnly}
                      onChange={(e) => onChange({ priority: (e.target as HTMLSelectElement).value })}>
                {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Due in (days)">
              <input type="number" min={0} value={Number(node.due_in_days ?? 1)} disabled={readOnly}
                     onInput={(e) => onChange({ due_in_days: Number((e.target as HTMLInputElement).value) })} />
            </Field>
            <Field label="Assign to"
                   hint="If nobody on the file holds that role, it goes to the broker.">
              <select value={String(node.assign_to ?? 'broker')} disabled={readOnly}
                      onChange={(e) => onChange({ assign_to: (e.target as HTMLSelectElement).value })}>
                {['broker', 'underwriter', 'manager', 'compliance'].map((r) =>
                  <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
          </div>
        </>
      );

    case 'notify_user':
      return (
        <>
          {text('title', 'Notification')}
          {text('body', 'Detail')}
          <Field label="Who">
            <select value={String(node.role ?? 'broker')} disabled={readOnly}
                    onChange={(e) => onChange({ role: (e.target as HTMLSelectElement).value })}>
              {['broker', 'underwriter', 'manager', 'compliance'].map((r) =>
                <option key={r} value={r}>The {r} on the file</option>)}
            </select>
          </Field>
        </>
      );

    case 'add_note':
      return (
        <Field label="Note">
          <textarea rows={3} value={String(node.body ?? '')} disabled={readOnly}
                    onInput={(e) => onChange({ body: (e.target as HTMLTextAreaElement).value })} />
        </Field>
      );

    case 'add_tag':
      return text('tag', 'Tag');

    case 'set_stage':
      return (
        <Field label="Move the file to"
               hint="An automation may not mark a file funded — that step is skipped and recorded.">
          <select value={String(node.stage_key ?? '')} disabled={readOnly}
                  onChange={(e) => onChange({ stage_key: (e.target as HTMLSelectElement).value })}>
            <option value="">Choose a stage…</option>
            {catalogue.stages.filter((s) => s.category !== 'won').map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </Field>
      );

    case 'stop':
      return text('reason', 'Why it ended', 'Shown on the client’s file.');

    default:
      return <p class="text-sm text-muted">Nothing to configure.</p>;
  }
}

function MessagePreview({ body, subject }: { body: string; subject?: string }) {
  const [preview, setPreview] = useState<{
    body: { text: string; dropped: string[]; empty: boolean };
    subject: { text: string } | null;
    issues: Array<{ field: string; message: string }>;
  } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    post('/automations/preview', { body, subject }).then((result) => {
      if (!cancelled) setPreview(result as never);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, body, subject]);

  if (!open) {
    return (
      <button class="btn btn-sm" onClick={() => setOpen(true)}>
        Preview with example values
      </button>
    );
  }

  return (
    <div class="preview">
      <div class="row-between">
        <strong class="text-sm">Preview</strong>
        <button class="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>Hide</button>
      </div>
      {!preview ? <Skeleton rows={2} /> : (
        <>
          {preview.issues.length > 0 && (
            <div class="alert alert-error">
              <ul>{preview.issues.map((i) => <li key={i.field}>{i.message}</li>)}</ul>
            </div>
          )}
          {preview.subject && <div class="preview-subject">{preview.subject.text}</div>}
          <pre class="preview-body">{preview.body.text || '(nothing would be sent)'}</pre>
          {preview.body.dropped.length > 0 && (
            <div class="text-sm text-muted">
              With no value for those fields, {preview.body.dropped.length} line(s) would be
              left out entirely.
            </div>
          )}
          {preview.body.empty && (
            <div class="alert alert-warn">
              With no values at all this message is empty, and nothing would be sent.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Trigger, conditions, stop conditions ───────────────────────────────────

function TriggerCard({ definition, catalogue, readOnly, onChange }: {
  definition: Definition; catalogue: Catalogue; readOnly: boolean;
  onChange: (next: Definition) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = catalogue.triggers.find((t) => t.type === definition.trigger.type)?.label
    ?? definition.trigger.type;

  return (
    <div class="step-card step-trigger">
      <button class="step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="step-type step-trigger-type">Starts when</span>
        <span class="step-summary">{label}</span>
        <span class="step-chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>
      {open && (
        <div class="step-body">
          <Field label="Trigger">
            <select value={definition.trigger.type} disabled={readOnly}
                    onChange={(e) => onChange({
                      ...definition,
                      trigger: { ...definition.trigger, type: (e.target as HTMLSelectElement).value },
                    })}>
              {catalogue.triggers.map((t) => (
                <option key={t.type} value={t.type}>{t.label}</option>
              ))}
            </select>
          </Field>

          {(definition.trigger.type === 'maturity.approaching'
            || definition.trigger.type === 'closing.approaching') && (
            <Field label="How many days ahead">
              <input type="number" min={0} value={definition.trigger.offset_days ?? 0}
                     disabled={readOnly}
                     onInput={(e) => onChange({
                       ...definition,
                       trigger: {
                         ...definition.trigger,
                         offset_days: Number((e.target as HTMLInputElement).value),
                       },
                     })} />
            </Field>
          )}

          <h3 class="sub-heading">Only for clients where…</h3>
          <p class="text-sm text-muted">
            Checked once, when the client enters. Leave empty for everybody the trigger matches.
          </p>
          <ConditionEditor
            conditions={definition.entry_conditions}
            catalogue={catalogue}
            readOnly={readOnly}
            onChange={(entry_conditions) => onChange({ ...definition, entry_conditions })}
          />
        </div>
      )}
    </div>
  );
}

function StopConditions({ definition, catalogue, readOnly, onChange }: {
  definition: Definition; catalogue: Catalogue; readOnly: boolean;
  onChange: (next: Definition) => void;
}) {
  const update = (index: number, patch: Partial<Condition & { reason: string }>) =>
    onChange({
      ...definition,
      stop_conditions: definition.stop_conditions.map((c, i) =>
        (i === index ? { ...c, ...patch } : c)),
    });

  return (
    <div class="card">
      <div class="card-head"><h2>Stop when</h2></div>
      <div class="card-body">
        <p class="text-sm text-muted">
          Checked before <em>every</em> step, not only at the start. This is what stops a
          document reminder going out after the documents arrive, or a nurture sequence
          continuing after the client funds.
        </p>

        {definition.stop_conditions.length === 0 && (
          <div class="alert alert-warn">
            Nothing stops this sequence. It will run to the end even if the client funds, is
            lost, or does the thing it is chasing them for.
          </div>
        )}

        <div class="stack-tight">
          {definition.stop_conditions.map((condition, index) => (
            <div key={index} class="stop-row">
              <ConditionRow
                condition={condition}
                catalogue={catalogue}
                readOnly={readOnly}
                onChange={(patch) => update(index, patch)}
                onRemove={() => onChange({
                  ...definition,
                  stop_conditions: definition.stop_conditions.filter((_, i) => i !== index),
                })}
              />
              <Field label="Reason a person reads"
                     hint="Shown on the client’s file as the reason the sequence ended.">
                <input value={condition.reason ?? ''} disabled={readOnly}
                       placeholder="Everything requested has arrived"
                       onInput={(e) => update(index, {
                         reason: (e.target as HTMLInputElement).value })} />
              </Field>
            </div>
          ))}
        </div>

        {!readOnly && (
          <button class="btn btn-sm" onClick={() => onChange({
            ...definition,
            stop_conditions: [...definition.stop_conditions,
              { field: 'stage_category', op: 'in', value: ['won', 'lost'],
                reason: 'The file was resolved' }],
          })}>Add a stop condition</button>
        )}
      </div>
    </div>
  );
}

function ConditionEditor({ conditions, match, catalogue, readOnly, onChange }: {
  conditions: Condition[];
  match?: 'all' | 'any';
  catalogue: Catalogue;
  readOnly: boolean;
  onChange: (conditions: Condition[], match: 'all' | 'any') => void;
}) {
  const current = match ?? 'all';
  return (
    <div class="stack-tight">
      {conditions.length > 1 && (
        <Field label="Match">
          <select value={current} disabled={readOnly}
                  onChange={(e) => onChange(conditions,
                    (e.target as HTMLSelectElement).value as 'all' | 'any')}>
            <option value="all">All of these</option>
            <option value="any">Any of these</option>
          </select>
        </Field>
      )}
      {conditions.map((condition, index) => (
        <ConditionRow
          key={index}
          condition={condition}
          catalogue={catalogue}
          readOnly={readOnly}
          onChange={(patch) => onChange(
            conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)), current)}
          onRemove={() => onChange(conditions.filter((_, i) => i !== index), current)}
        />
      ))}
      {!readOnly && (
        <button class="btn btn-sm" onClick={() => onChange(
          [...conditions, { field: catalogue.fields[0]!.field, op: 'eq', value: '' }], current)}>
          Add a condition
        </button>
      )}
    </div>
  );
}

function ConditionRow({ condition, catalogue, readOnly, onChange, onRemove }: {
  condition: Condition; catalogue: Catalogue; readOnly: boolean;
  onChange: (patch: Partial<Condition>) => void; onRemove: () => void;
}) {
  const spec = catalogue.fields.find((f) => f.field === condition.field);
  const needsValue = condition.op !== 'is_set' && condition.op !== 'is_empty';
  const isList = condition.op === 'in' || condition.op === 'not_in';

  return (
    <div class="condition-row">
      <select value={condition.field} disabled={readOnly}
              onChange={(e) => onChange({ field: (e.target as HTMLSelectElement).value })}>
        {catalogue.fields.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
      </select>

      <select value={condition.op} disabled={readOnly}
              onChange={(e) => onChange({ op: (e.target as HTMLSelectElement).value })}>
        {catalogue.operators.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </select>

      {needsValue && (
        spec?.type === 'stage' ? (
          <select value={String(condition.value ?? '')} disabled={readOnly}
                  onChange={(e) => onChange({ value: (e.target as HTMLSelectElement).value })}>
            <option value="">Choose…</option>
            {catalogue.stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        ) : spec?.options && !isList ? (
          <select value={String(condition.value ?? '')} disabled={readOnly}
                  onChange={(e) => onChange({ value: (e.target as HTMLSelectElement).value })}>
            <option value="">Choose…</option>
            {spec.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input
            type={spec?.type === 'number' ? 'number' : 'text'}
            disabled={readOnly}
            placeholder={isList ? 'won, lost' : ''}
            value={Array.isArray(condition.value)
              ? (condition.value as string[]).join(', ')
              : String(condition.value ?? '')}
            onInput={(e) => {
              const raw = (e.target as HTMLInputElement).value;
              onChange({
                value: isList
                  ? raw.split(',').map((s) => s.trim()).filter(Boolean)
                  : spec?.type === 'number' && raw !== '' ? Number(raw) : raw,
              });
            }}
          />
        )
      )}

      {!readOnly && (
        <button class="btn btn-sm btn-ghost" title="Remove" onClick={onRemove}>✕</button>
      )}
    </div>
  );
}

function MergeFieldList({ catalogue }: { catalogue: Catalogue }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="card">
      <div class="card-head">
        <h2>Merge fields</h2>
        <button class="btn btn-sm btn-ghost" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show all'}
        </button>
      </div>
      <div class="card-body">
        <p class="text-sm text-muted">
          Only these can be used in a message. Nothing sensitive is on the list — no date of
          birth, no income, no identification — so a template cannot reach it.
        </p>
        {open && (
          <div class="merge-grid">
            {catalogue.merge_fields.map((f) => (
              <div key={f.name}>
                <code>{'{' + f.name + '}'}</code>
                <div class="text-sm text-muted">{f.label} · e.g. {f.example}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Enrollments, on the automation ─────────────────────────────────────────

type EnrollmentRow = {
  id: string; status: string; current_node_key: string | null; next_run_at: string | null;
  enrolled_at: string; steps_completed: number; messages_sent: number;
  stopped_reason: string | null; last_error: string | null;
  customer_id: string; first_name: string; last_name: string;
  application_id: string | null; portal_reference: string | null;
};

function Enrollments({ id, session }: { id: string; session: Session }) {
  const [status, setStatus] = useState('active');
  const state = useAsync<{ enrollments: EnrollmentRow[] }>(
    `/automations/${id}/enrollments?status=${status}`, [id, status]);
  const canControl = session.permissions.includes('automation.control');

  return (
    <div class="card">
      <div class="card-head">
        <h2>Clients</h2>
        <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}>
          {['active', 'paused', 'completed', 'stopped', 'failed', 'all'].map((s) =>
            <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div class="card-body-flush">
        {state.status === 'loading' && <div class="card-body"><Skeleton rows={3} /></div>}
        {state.status === 'error' && <ErrorNote error={state.error} onRetry={state.reload} />}
        {state.status === 'ready' && (
          state.data.enrollments.length === 0 ? (
            <Empty title={`No ${status === 'all' ? '' : status} enrollments`}>
              Nobody is in this state.
            </Empty>
          ) : state.data.enrollments.map((e) => (
            <div key={e.id} class="list-row">
              <div>
                <button class="link-button"
                        onClick={() => e.application_id && navigate(`/applications/${e.application_id}`)}>
                  {e.first_name} {e.last_name}
                </button>
                <div class="text-sm text-muted">
                  {e.status === 'stopped' && e.stopped_reason
                    ? `Stopped — ${e.stopped_reason}`
                    : e.status === 'active'
                      ? `At "${e.current_node_key ?? '—'}"${e.next_run_at ? `, next ${relativeTime(e.next_run_at)}` : ''}`
                      : e.status}
                  {' · '}{e.steps_completed} step(s), {e.messages_sent} message(s)
                </div>
                {e.last_error && <div class="text-sm" style={{ color: 'var(--danger-text)' }}>{e.last_error}</div>}
              </div>
              {canControl && (e.status === 'active' || e.status === 'paused') && (
                <EnrollmentControls enrollment={e} onChanged={state.reload} compact />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── The controls, and the client's "Active automations" tab ────────────────

export function EnrollmentControls({ enrollment, onChanged, compact = false }: {
  enrollment: { id: string; status: string };
  onChanged: () => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState('');
  const [ending, setEnding] = useState(false);

  const act = async (action: string, reason?: string) => {
    setBusy(action);
    try {
      const result = await post<{ status: string; detail?: Record<string, unknown> }>(
        `/enrollments/${enrollment.id}/${action}`, { reason });
      toast(MESSAGES[action]?.(result) ?? 'Done.', 'ok');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work.', 'error');
    } finally {
      setBusy('');
      setEnding(false);
    }
  };

  const size = compact ? ' btn-sm' : '';
  return (
    <>
      <div class="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {enrollment.status === 'active' && (
          <button class={`btn${size}`} disabled={!!busy} onClick={() => act('pause')}>Pause</button>
        )}
        {enrollment.status === 'paused' && (
          <button class={`btn${size}`} disabled={!!busy} onClick={() => act('resume')}>Resume</button>
        )}
        <button class={`btn${size}`} disabled={!!busy} onClick={() => act('skip')}
                title="Move past the step it is sitting on without running it">
          Skip next step
        </button>
        <button class={`btn${size} btn-danger`} disabled={!!busy} onClick={() => setEnding(true)}>
          End
        </button>
      </div>

      {ending && (
        <EndEnrollment
          onClose={() => setEnding(false)}
          onEnd={(reason) => act('end', reason)}
        />
      )}
    </>
  );
}

const MESSAGES: Record<string, (result: { status: string; detail?: Record<string, unknown> }) => string> = {
  pause: () => 'Paused. It keeps its place — resuming picks up where it stopped.',
  resume: (r) => String(r.detail?.next_run_at)
    && new Date(String(r.detail?.next_run_at)).getTime() > Date.now() + 60_000
    ? `Resumed. The next step is still due ${formatDateTime(String(r.detail?.next_run_at))}.`
    : 'Resumed.',
  skip: (r) => r.detail?.now_at
    ? `Skipped "${String(r.detail?.skipped)}".`
    : 'Skipped the last step, so the sequence is finished.',
  end: () => 'Ended. Nothing further will be sent.',
  run: (r) => `Step run — ${r.status}.`,
};

function EndEnrollment({ onClose, onEnd }: {
  onClose: () => void; onEnd: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="End this sequence" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-danger" onClick={() => onEnd(reason)}>End it</button>
      </>
    }>
      <p>Nothing further will be sent to this client from this automation.</p>
      <Field label="Why" hint="Recorded on the file, so the next person reading it knows.">
        <input value={reason} autofocus placeholder="Spoke to them on the phone"
               onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
      </Field>
    </Modal>
  );
}

type ClientEnrollment = {
  id: string; status: string; automation_id: string; automation_name: string;
  purpose: string; enrolled_at: string; enrolled_reason: string | null;
  current_node_key: string | null; current_step_label: string | null;
  next_run_at: string | null; steps_completed: number; total_steps: number | null;
  messages_sent: number; stopped_reason: string | null; stopped_at: string | null;
  completed_at: string | null; last_error: string | null;
  steps: Array<{
    node_key: string; node_type: string; label: string; at: string;
    outcome: string; reason: string | null;
  }>;
};

/**
 * The client's "Automations" tab.
 *
 * Every sequence touching this person, every step it took, and the reason for
 * each — because "why did my client get that text" has to be answerable in
 * one screen, by the broker, while the client is still on the phone.
 */
export function ClientAutomations({ customerId, session }: {
  customerId: string; session: Session;
}) {
  const state = useAsync<{ enrollments: ClientEnrollment[] }>(
    `/customers/${customerId}/automations`, [customerId]);
  const canControl = session.permissions.includes('automation.control');

  if (state.status === 'loading') return <Skeleton rows={3} height={60} />;
  if (state.status === 'error') return <ErrorNote error={state.error} onRetry={state.reload} />;

  const live = state.data.enrollments.filter(
    (e) => e.status === 'active' || e.status === 'paused');
  const past = state.data.enrollments.filter(
    (e) => e.status !== 'active' && e.status !== 'paused');

  return (
    <div class="stack">
      {state.data.enrollments.length === 0 && (
        <div class="card"><Empty title="No automation is running for this client">
          Nothing has been sent to them automatically.
        </Empty></div>
      )}

      {live.map((e) => (
        <EnrollmentCard key={e.id} enrollment={e} canControl={canControl}
                        onChanged={state.reload} />
      ))}

      {past.length > 0 && (
        <div class="card">
          <div class="card-head"><h2>Finished</h2></div>
          <div class="card-body-flush">
            {past.map((e) => (
              <div key={e.id} class="list-row">
                <div>
                  <strong>{e.automation_name}</strong>
                  <div class="text-sm text-muted">
                    {e.status === 'stopped'
                      ? `Stopped ${relativeTime(e.stopped_at)} — ${e.stopped_reason ?? 'no reason recorded'}`
                      : `Finished ${relativeTime(e.completed_at)}`}
                    {' · '}{e.messages_sent} message(s) sent
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EnrollmentCard({ enrollment: e, canControl, onChanged }: {
  enrollment: ClientEnrollment; canControl: boolean; onChanged: () => void;
}) {
  const [showSteps, setShowSteps] = useState(false);
  return (
    <div class="card">
      <div class="card-head">
        <div>
          <h2>{e.automation_name}</h2>
          <div class="text-sm text-muted">
            Started {relativeTime(e.enrolled_at)}
            {e.enrolled_reason ? ` · ${e.enrolled_reason}` : ''}
          </div>
        </div>
        <Badge tone={e.status === 'paused' ? 'warn' : 'ok'}>
          {e.status === 'paused' ? 'Paused' : 'Running'}
        </Badge>
      </div>

      <div class="card-body">
        <div class="enrollment-now">
          <div>
            <div class="text-sm text-muted">Next step</div>
            <strong>{e.current_step_label ?? 'Nothing left'}</strong>
            <div class="text-sm text-muted">
              {e.status === 'paused'
                ? 'Held. Resuming puts it back where it was.'
                : e.next_run_at
                  ? `Due ${formatDateTime(e.next_run_at)}`
                  : 'Due now'}
            </div>
          </div>
          <div>
            <div class="text-sm text-muted">Progress</div>
            <strong class="num">
              {e.steps_completed}{e.total_steps ? ` of ${e.total_steps}` : ''} step(s)
            </strong>
            <div class="text-sm text-muted">{e.messages_sent} message(s) sent</div>
          </div>
        </div>

        {e.last_error && (
          <div class="alert alert-error">Last attempt failed: {e.last_error}</div>
        )}

        {canControl && (
          <div style={{ marginTop: 12 }}>
            <EnrollmentControls enrollment={e} onChanged={onChanged} />
          </div>
        )}
      </div>

      <div class="card-body-flush">
        <button class="btn btn-ghost btn-sm" style={{ margin: '0 16px 12px' }}
                onClick={() => setShowSteps(!showSteps)}>
          {showSteps ? 'Hide' : 'Show'} everything it has done ({e.steps.length})
        </button>
        {showSteps && (
          <div class="step-log">
            {e.steps.length === 0 && <div class="card-body text-sm text-muted">Nothing yet.</div>}
            {e.steps.map((s, i) => (
              <div key={i} class="step-log-row">
                <span class={`step-outcome outcome-${s.outcome}`}>{s.outcome}</span>
                <div>
                  <div><strong>{s.label}</strong></div>
                  {s.reason && <div class="text-sm text-muted">{s.reason}</div>}
                </div>
                <span class="text-sm text-muted">{formatDateTime(s.at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function uniqueKey(type: string, existing: string[]): string {
  const base = type.replace(/[^a-z]/g, '_');
  let n = 1;
  while (existing.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function defaultsFor(type: string, catalogue: Catalogue): Node {
  switch (type) {
    case 'send_email':
      return { key: '', type, purpose: 'transactional', subject: '', body: 'Hi {first_name},\n\n' };
    case 'send_sms':
      return { key: '', type, purpose: 'transactional', body: 'Hi {first_name}, ' };
    case 'wait':
      return { key: '', type, days: 1, hours: 0, minutes: 0, business_hours_only: true };
    case 'branch':
      return {
        key: '', type, match: 'all', if_true: null, if_false: null,
        conditions: [{ field: catalogue.fields[0]!.field, op: 'is_set' }],
      };
    case 'create_task':
      return {
        key: '', type, title: '', category: 'follow_up', priority: 'normal',
        due_in_days: 1, assign_to: 'broker',
      };
    case 'notify_user':
      return { key: '', type, role: 'broker', title: '' };
    case 'add_note':
      return { key: '', type, body: '', note_type: 'general' };
    case 'add_tag':
      return { key: '', type, tag: '' };
    case 'set_stage':
      return { key: '', type, stage_key: '' };
    default:
      return { key: '', type };
  }
}

function describe(node: Node, catalogue: Catalogue): string {
  switch (node.type) {
    case 'send_email':
      return String(node.subject || '').trim() || 'No subject yet';
    case 'send_sms':
      return String(node.body || '').split('\n')[0]?.slice(0, 70) || 'Nothing to send yet';
    case 'wait': {
      const parts = [
        Number(node.days) ? `${node.days} day(s)` : '',
        Number(node.hours) ? `${node.hours} hour(s)` : '',
        Number(node.minutes) ? `${node.minutes} minute(s)` : '',
      ].filter(Boolean);
      return (parts.join(' ') || 'no time at all')
        + (node.business_hours_only ? ', then working hours' : '');
    }
    case 'branch': {
      const conditions = (node.conditions as Condition[]) ?? [];
      if (!conditions.length) return 'Nothing to branch on yet';
      const first = conditions[0]!;
      const label = catalogue.fields.find((f) => f.field === first.field)?.label ?? first.field;
      const op = catalogue.operators.find((o) => o.op === first.op)?.label ?? first.op;
      return `${label} ${op} ${Array.isArray(first.value) ? first.value.join(', ') : String(first.value ?? '')}`
        + (conditions.length > 1 ? ` (+${conditions.length - 1} more)` : '');
    }
    case 'create_task':
      return String(node.title || 'No title yet');
    case 'notify_user':
      return `${String(node.title || 'No title yet')} → the ${String(node.role ?? 'broker')}`;
    case 'add_note':
      return String(node.body || 'Empty note').slice(0, 70);
    case 'add_tag':
      return String(node.tag ? `"${node.tag}"` : 'No tag yet');
    case 'set_stage': {
      const stage = catalogue.stages.find((s) => s.key === node.stage_key);
      return stage ? stage.label : 'No stage chosen';
    }
    case 'stop':
      return String(node.reason || 'The sequence ends here');
    default:
      return '';
  }
}
