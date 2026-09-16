/**
 * LM Automation — everything that opens beside or over the canvas: the
 * right-hand drawer (pick a trigger or action, configure it), the condition
 * builder, and the Settings, Enrollment History, Execution Logs and Test
 * panels.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError, formatDateTime, get, post, put, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, type Session } from '../lib/store.ts';
import { DataTable, recency, type Column } from '../components/data-table.tsx';
import { Badge, Empty, ErrorNote, Field, Modal, SearchSelect, Skeleton, type SelectOption } from '../components/ui.tsx';
import { EnrollmentControls } from './automations.tsx';
import {
  collect, defaultsFor, describeNode, GROUP_TONE, insertAt, newKey, nodeOf, removeNode, STATUS_LABEL, Svg, targetOf,
  type Branch, type Catalogue, type Condition, type Definition, type FactField, type Loaded, type Slot, type Trigger, type WfNode,
} from './workflow-shared.tsx';

export type DrawerState =
  | { mode: 'pick-action'; slot: Slot }
  | { mode: 'edit-action'; key: string }
  | { mode: 'pick-trigger' }
  | { mode: 'edit-trigger'; index: number }
  | null;

// ── The drawer ─────────────────────────────────────────────────────────────

export function Drawer({ drawer, def, cat, readOnly, automationId, onClose, onChange, setDrawer }: {
  drawer: NonNullable<DrawerState>; def: Definition; cat: Catalogue; readOnly: boolean; automationId: string;
  onClose: () => void; onChange: (def: Definition) => void; setDrawer: (d: DrawerState) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  let title = '';
  let body: any = null;

  if (drawer.mode === 'pick-action') {
    title = 'Actions';
    const hasContinuation = !!targetOf(def, drawer.slot);
    body = (
      <Picker
        items={cat.actions.map((a) => {
          const endOnly = hasContinuation && (a.type === 'stop' || a.type === 'goto');
          return { ...a, disabled: endOnly, note: endOnly ? 'Only at the end of a path' : undefined };
        })}
        onPick={(type) => {
          const node = defaultsFor(type, cat);
          onChange(insertAt(def, drawer.slot, node));
          setDrawer({ mode: 'edit-action', key: node.key });
        }} />
    );
  } else if (drawer.mode === 'pick-trigger') {
    title = 'Workflow Trigger';
    body = (
      <Picker items={cat.triggers.map((t) => ({ ...t, icon: 'bolt' }))}
              onPick={(type) => {
                const spec = cat.triggers.find((t) => t.type === type)!;
                const trigger: Trigger = { type, filters: [],
                  ...(spec.config === 'offset_days' ? { offset_days: 7 } : {}),
                  ...(spec.config === 'after_hours' ? { after_hours: 48 } : {}) };
                onChange({ ...def, triggers: [...def.triggers, trigger] });
                setDrawer({ mode: 'edit-trigger', index: def.triggers.length });
              }} />
    );
  } else if (drawer.mode === 'edit-trigger') {
    const trigger = def.triggers[drawer.index];
    if (!trigger) return null;
    title = 'Edit trigger';
    body = (
      <TriggerForm key={drawer.index} trigger={trigger} cat={cat} readOnly={readOnly} automationId={automationId}
                   onSave={(t) => { onChange({ ...def, triggers: def.triggers.map((x, i) => (i === drawer.index ? t : x)) }); onClose(); }}
                   onDelete={() => { onChange({ ...def, triggers: def.triggers.filter((_, i) => i !== drawer.index) }); onClose(); }}
                   onCancel={onClose} />
    );
  } else {
    const node = nodeOf(def, drawer.key);
    if (!node) return null;
    title = cat.actions.find((a) => a.type === node.type)?.label ?? 'Edit action';
    body = (
      <ActionForm key={node.key} node={node} def={def} cat={cat} readOnly={readOnly} automationId={automationId}
                  onSave={(n) => { onChange(collect({ ...def, nodes: def.nodes.map((x) => (x.key === n.key ? n : x)) })); onClose(); }}
                  onDelete={() => { onChange(removeNode(def, node.key)); onClose(); }}
                  onCancel={onClose} />
    );
  }

  return (
    <div class="wf-drawer-scrim" onClick={onClose}>
      <aside class="wf-drawer" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div class="wf-drawer-head">
          <h2>{title}</h2>
          <button class="btn btn-ghost btn-sm" aria-label="Close" onClick={onClose}><Svg name="x" /></button>
        </div>
        {body}
      </aside>
    </div>
  );
}

function Picker({ items, onPick }: {
  items: Array<{ type: string; label: string; group: string; description: string; icon: string; disabled?: boolean; note?: string }>;
  onPick: (type: string) => void;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = items.filter((i) => !needle || `${i.label} ${i.description} ${i.group}`.toLowerCase().includes(needle));
  const groups = [...new Set(shown.map((i) => i.group))];
  return (
    <div class="wf-drawer-body">
      <input type="search" placeholder="Search…" value={q} autofocus onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      {groups.map((g) => (
        <div key={g} class="wf-pick-group">
          <div class="wf-pick-title">{g}</div>
          {shown.filter((i) => i.group === g).map((i) => (
            <button key={i.type} type="button" class="wf-pick" disabled={i.disabled} onClick={() => onPick(i.type)}>
              <span class={`wf-icon tone-${i.icon === 'bolt' ? 'yellow' : GROUP_TONE[g] ?? 'grey'}`}><Svg name={i.icon} /></span>
              <span class="wf-card-text">
                <strong>{i.label}</strong>
                <span class="text-sm text-muted">{i.note ?? i.description}</span>
              </span>
            </button>
          ))}
        </div>
      ))}
      {!shown.length && <p class="text-sm text-muted">Nothing matches “{q}”.</p>}
    </div>
  );
}

function DrawerFooter({ readOnly, onSave, onDelete, onCancel, saveLabel = 'Save action' }: {
  readOnly: boolean; onSave: () => void; onDelete?: () => void; onCancel: () => void; saveLabel?: string;
}) {
  return (
    <div class="wf-drawer-foot">
      {!readOnly && onDelete ? <button class="btn btn-danger" onClick={onDelete}>Delete</button> : <span />}
      <div class="row" style={{ gap: 8 }}>
        <button class="btn" onClick={onCancel}>Cancel</button>
        {!readOnly && <button class="btn btn-primary" onClick={onSave}>{saveLabel}</button>}
      </div>
    </div>
  );
}

function TriggerForm({ trigger, cat, readOnly, automationId, onSave, onDelete, onCancel }: {
  trigger: Trigger; cat: Catalogue; readOnly: boolean; automationId: string;
  onSave: (t: Trigger) => void; onDelete: () => void; onCancel: () => void;
}) {
  const [t, setT] = useState<Trigger>(structuredClone(trigger));
  const spec = cat.triggers.find((x) => x.type === t.type);
  const base = location.pathname.replace(/\/automations.*$/, '');
  const webhookUrl = `${location.origin}${base}/api/v1/automations/${automationId}/webhook`;
  return (
    <>
      <div class="wf-drawer-body">
        <Field label="Choose a workflow trigger">
          <SearchSelect value={t.type} ariaLabel="Trigger" disabled={readOnly}
                        options={cat.triggers.map((x) => ({ value: x.type, label: x.label, hint: x.group }))}
                        onChange={(v) => {
                          const s = cat.triggers.find((x) => x.type === v);
                          setT({ type: v, filters: [], label: t.label,
                                 ...(s?.config === 'offset_days' ? { offset_days: 7 } : {}),
                                 ...(s?.config === 'after_hours' ? { after_hours: 48 } : {}) });
                        }} />
        </Field>
        {spec && <p class="text-sm text-muted">{spec.description}</p>}
        <Field label="Trigger name" hint="Shown on the canvas.">
          <input value={t.label ?? ''} disabled={readOnly} placeholder={spec?.label}
                 onInput={(e) => setT({ ...t, label: (e.target as HTMLInputElement).value })} />
        </Field>
        {spec?.config === 'offset_days' && (
          <Field label="Days before">
            <input type="number" min={0} max={365} value={t.offset_days ?? 0} disabled={readOnly}
                   onInput={(e) => setT({ ...t, offset_days: Number((e.target as HTMLInputElement).value) })} />
          </Field>
        )}
        {spec?.config === 'after_hours' && (
          <Field label="After how many hours" hint="48 hours is two days.">
            <input type="number" min={1} max={8760} value={t.after_hours ?? 48} disabled={readOnly}
                   onInput={(e) => setT({ ...t, after_hours: Number((e.target as HTMLInputElement).value) })} />
          </Field>
        )}
        {t.type === 'webhook.received' && (
          <div class="alert alert-info">
            <strong>Webhook URL</strong>
            <code class="wf-code">{webhookUrl}</code>
            POST with an API key that has Automations → “Add clients”, naming the client:
            <code class="wf-code">{'{ "email": "client@example.com", "data": { "score": 82 } }'}</code>
            Anything in <code>data</code> can be filtered on as <code>event.score</code>. The workflow must be published.
          </div>
        )}
        <h3 class="app-group-title" style={{ marginTop: 16 }}>Filters</h3>
        <p class="text-sm text-muted">Only start the workflow when these are true. Leave empty to start every time.</p>
        <ConditionEditor conditions={t.filters} match="all" cat={cat} readOnly={readOnly} extra={spec?.event_fields ?? []}
                         onChange={(filters) => setT({ ...t, filters })} />
      </div>
      <DrawerFooter readOnly={readOnly} onSave={() => onSave(t)} onDelete={onDelete} onCancel={onCancel} saveLabel="Save trigger" />
    </>
  );
}

/** A textarea that remembers its caret, so an inserted merge field lands where the person was typing. */
function MessageBox({ value, onChange, rows = 6, disabled, cat, placeholder }: {
  value: string; onChange: (v: string) => void; rows?: number; disabled?: boolean; cat: Catalogue; placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const options: SelectOption[] = cat.merge_fields.map((m) => ({ value: m.name, label: m.label, hint: `{${m.name}}` }));
  return (
    <>
      <textarea ref={ref} rows={rows} value={value} disabled={disabled} placeholder={placeholder}
                onBlur={(e) => { caret.current = (e.target as HTMLTextAreaElement).selectionStart; }}
                onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)} />
      {!disabled && (
        <div class="row" style={{ justifyContent: 'space-between', marginTop: 4, gap: 8 }}>
          <div style={{ width: 220 }}>
            <SearchSelect value="" placeholder="{ } Insert field" ariaLabel="Insert merge field" options={options}
                          onChange={(name) => {
                            if (!name) return;
                            const at = caret.current ?? value.length;
                            onChange(`${value.slice(0, at)}{${name}}${value.slice(at)}`);
                          }} />
          </div>
          <span class="text-sm text-muted">{value.length} characters</span>
        </div>
      )}
    </>
  );
}

const ROLE_OPTIONS: SelectOption[] = [
  { value: 'broker', label: 'Assigned broker' }, { value: 'underwriter', label: 'Underwriter' },
  { value: 'manager', label: 'Manager' }, { value: 'compliance', label: 'Compliance' },
];

function ActionForm({ node, def, cat, readOnly, automationId, onSave, onDelete, onCancel }: {
  node: WfNode; def: Definition; cat: Catalogue; readOnly: boolean; automationId: string;
  onSave: (n: WfNode) => void; onDelete: () => void; onCancel: () => void;
}) {
  const [n, setN] = useState<WfNode>(structuredClone(node));
  const set = (patch: Record<string, unknown>) => setN((prev) => ({ ...prev, ...patch }));
  const num = (e: Event) => Number((e.target as HTMLInputElement).value || 0);
  const text = (e: Event) => (e.target as HTMLInputElement).value;
  const users: SelectOption[] = cat.users.map((u) => ({ value: u.id, label: u.name, hint: u.role.replace(/_/g, ' ') }));
  const spec = cat.actions.find((a) => a.type === n.type);
  const branches = (n.branches ?? []) as Branch[];

  let fields: any = null;
  switch (n.type) {
    case 'send_email': case 'send_sms': {
      const channel = n.type === 'send_email' ? 'email' : 'sms';
      const templates = cat.templates.filter((t) => t.channel === channel);
      fields = (
        <>
          {templates.length > 0 && (
            <Field label="Template" hint="Or write the message below.">
              <SearchSelect value={n.template_key ?? ''} disabled={readOnly} ariaLabel="Template"
                            options={[{ value: '', label: 'No template — write it here' }, ...templates.map((t) => ({ value: t.key, label: t.name }))]}
                            onChange={(v) => set({ template_key: v || undefined })} />
            </Field>
          )}
          {!n.template_key && (
            <>
              {n.type === 'send_email' && (
                <Field label="Subject"><input value={n.subject ?? ''} disabled={readOnly} onInput={(e) => set({ subject: text(e) })} /></Field>
              )}
              <Field label="Message">
                <MessageBox value={n.body ?? ''} disabled={readOnly} cat={cat} rows={n.type === 'send_sms' ? 4 : 9}
                            onChange={(body) => set({ body })} />
              </Field>
            </>
          )}
          <Field label="Kind of message" hint="Marketing messages only go to clients with marketing consent.">
            <SearchSelect value={n.purpose ?? 'transactional'} disabled={readOnly} ariaLabel="Kind of message"
                          options={[{ value: 'transactional', label: 'About their mortgage (transactional)' },
                                    { value: 'service', label: 'Service' }, { value: 'marketing', label: 'Marketing' }]}
                          onChange={(v) => set({ purpose: v })} />
          </Field>
        </>
      );
      break;
    }
    case 'internal_email':
      fields = (
        <>
          <Field label="Send to">
            <SearchSelect value={n.to} disabled={readOnly} ariaLabel="Send to"
                          options={[{ value: 'role', label: 'Somebody on the file' }, { value: 'user', label: 'A staff member' }, { value: 'address', label: 'An email address' }]}
                          onChange={(v) => set({ to: v })} />
          </Field>
          {n.to === 'role' && <Field label="Who"><SearchSelect value={n.role} disabled={readOnly} ariaLabel="Role" options={ROLE_OPTIONS} onChange={(v) => set({ role: v })} /></Field>}
          {n.to === 'user' && <Field label="Staff member"><SearchSelect value={n.user_id ?? ''} disabled={readOnly} ariaLabel="Staff member" options={users} onChange={(v) => set({ user_id: v })} /></Field>}
          {n.to === 'address' && <Field label="Email address"><input type="email" value={n.address ?? ''} disabled={readOnly} onInput={(e) => set({ address: text(e) })} /></Field>}
          <Field label="Subject"><input value={n.subject ?? ''} disabled={readOnly} onInput={(e) => set({ subject: text(e) })} /></Field>
          <Field label="Message" hint="A link to the file is added at the end."><MessageBox value={n.body ?? ''} disabled={readOnly} cat={cat} onChange={(body) => set({ body })} /></Field>
        </>
      );
      break;
    case 'notify_user':
      fields = (
        <>
          <Field label="Who">
            <SearchSelect value={n.user_id ? `user:${n.user_id}` : n.role} disabled={readOnly} ariaLabel="Who"
                          options={[...ROLE_OPTIONS, ...users.map((u) => ({ ...u, value: `user:${u.value}` }))]}
                          onChange={(v) => (v.startsWith('user:') ? set({ user_id: v.slice(5) }) : set({ role: v, user_id: undefined }))} />
          </Field>
          <Field label="Title"><input value={n.title ?? ''} disabled={readOnly} onInput={(e) => set({ title: text(e) })} /></Field>
          <Field label="Details"><MessageBox value={n.body ?? ''} rows={3} disabled={readOnly} cat={cat} onChange={(body) => set({ body })} /></Field>
        </>
      );
      break;
    case 'wait':
      fields = (
        <>
          <div class="seg seg-full" style={{ marginBottom: 12 }}>
            <button type="button" class={!n.until_field ? 'active' : ''} disabled={readOnly} onClick={() => set({ until_field: undefined, until_offset_days: undefined })}>For a length of time</button>
            <button type="button" class={n.until_field ? 'active' : ''} disabled={readOnly} onClick={() => set({ until_field: 'closing_date', until_offset_days: -3 })}>Until a date on the file</button>
          </div>
          {!n.until_field ? (
            <div class="grid-3">
              <Field label="Days"><input type="number" min={0} value={n.days ?? 0} disabled={readOnly} onInput={(e) => set({ days: num(e) })} /></Field>
              <Field label="Hours"><input type="number" min={0} value={n.hours ?? 0} disabled={readOnly} onInput={(e) => set({ hours: num(e) })} /></Field>
              <Field label="Minutes"><input type="number" min={0} value={n.minutes ?? 0} disabled={readOnly} onInput={(e) => set({ minutes: num(e) })} /></Field>
            </div>
          ) : (
            <div class="grid-2">
              <Field label="Date">
                <SearchSelect value={n.until_field} disabled={readOnly} ariaLabel="Date"
                              options={[{ value: 'closing_date', label: 'Closing date' }, { value: 'maturity_date', label: 'Maturity date' }, { value: 'next_appointment_at', label: 'Next appointment' }]}
                              onChange={(v) => set({ until_field: v })} />
              </Field>
              <Field label="Days (negative = before)"><input type="number" value={n.until_offset_days ?? 0} disabled={readOnly} onInput={(e) => set({ until_offset_days: num(e) })} /></Field>
            </div>
          )}
          <label class="check"><input type="checkbox" checked={!!n.business_hours_only} disabled={readOnly} onChange={(e) => set({ business_hours_only: (e.target as HTMLInputElement).checked })} />
            <span class="text-sm">Then hold until working hours (never at night or on a Sunday)</span></label>
        </>
      );
      break;
    case 'if_else':
      fields = (
        <>
          <p class="text-sm text-muted">Branches are checked top to bottom; the first that matches is taken. A client who matches none goes down <strong>None</strong>.</p>
          {branches.map((b) => (
            <div key={b.key} class="wf-branch-edit">
              <div class="row" style={{ gap: 8, justifyContent: 'space-between', marginBottom: 8 }}>
                <input value={b.name} disabled={readOnly} aria-label="Branch name" style={{ fontWeight: 600, maxWidth: 260 }}
                       onInput={(e) => set({ branches: branches.map((x) => (x.key === b.key ? { ...x, name: text(e) } : x)) })} />
                {!readOnly && branches.length > 1 && (
                  <button class="btn btn-ghost btn-sm" onClick={() => {
                    if (b.next && !confirm('Delete this branch and every step inside it?')) return;
                    set({ branches: branches.filter((x) => x.key !== b.key) });
                  }}>Delete branch</button>
                )}
              </div>
              <ConditionEditor conditions={b.conditions} match={b.match} cat={cat} readOnly={readOnly}
                               onChange={(conditions, match) => set({ branches: branches.map((x) => (x.key === b.key ? { ...x, conditions, match: match ?? x.match } : x)) })} />
            </div>
          ))}
          {!readOnly && (
            <button class="btn btn-sm" onClick={() => set({ branches: [...branches, { key: newKey(), name: `Branch ${branches.length + 1}`, match: 'all', conditions: [{ field: cat.fields[0]?.field ?? 'stage_key', op: 'is_set' }], next: null }] })}>
              + Add branch
            </button>
          )}
        </>
      );
      break;
    case 'goto':
      fields = (
        <Field label="Go to step">
          <SearchSelect value={n.target ?? ''} disabled={readOnly} ariaLabel="Go to"
                        options={def.nodes.filter((x) => x.key !== n.key).map((x) => ({ value: x.key, label: x.label || cat.actions.find((a) => a.type === x.type)?.label || x.type, hint: describeNode(x, cat, def) }))}
                        onChange={(v) => set({ target: v })} />
        </Field>
      );
      break;
    case 'add_tag': case 'remove_tag':
      fields = (
        <Field label="Tag" hint="Pick one in use, or type a new one.">
          <input list="wf-tags" value={n.tag ?? ''} disabled={readOnly} onInput={(e) => set({ tag: text(e) })} />
          <datalist id="wf-tags">{cat.tags.map((tag) => <option key={tag} value={tag} />)}</datalist>
        </Field>
      );
      break;
    case 'update_contact':
      fields = (
        <>
          <Field label="Field">
            <SearchSelect value={n.field} disabled={readOnly} ariaLabel="Field"
                          options={[{ value: 'lead_source', label: 'Lead source' }, { value: 'referral_source', label: 'Referred by' }, { value: 'preferred_language', label: 'Preferred language' }]}
                          onChange={(v) => set({ field: v })} />
          </Field>
          <Field label="New value" hint="Fields like {purpose.purpose} are filled in."><input value={n.value ?? ''} disabled={readOnly} onInput={(e) => set({ value: text(e) })} /></Field>
        </>
      );
      break;
    case 'add_note':
      fields = <Field label="Note"><MessageBox value={n.body ?? ''} disabled={readOnly} cat={cat} onChange={(body) => set({ body })} /></Field>;
      break;
    case 'set_stage':
      fields = (
        <>
          <Field label="Move to stage">
            <SearchSelect value={n.stage_key ?? ''} disabled={readOnly} ariaLabel="Stage"
                          options={cat.stages.filter((s) => s.category !== 'won').map((s) => ({ value: s.key, label: s.label, hint: s.pipeline_name }))}
                          onChange={(v) => set({ stage_key: v })} />
          </Field>
          <p class="text-sm text-muted">The stage’s own rules still apply — a move they refuse is recorded and skipped. A workflow cannot mark a file funded.</p>
        </>
      );
      break;
    case 'assign_user':
      fields = (
        <>
          <div class="seg seg-full" style={{ marginBottom: 12 }}>
            <button type="button" class={n.mode === 'round_robin' ? 'active' : ''} disabled={readOnly} onClick={() => set({ mode: 'round_robin' })}>Round robin</button>
            <button type="button" class={n.mode === 'user' ? 'active' : ''} disabled={readOnly} onClick={() => set({ mode: 'user' })}>A specific user</button>
          </div>
          {n.mode === 'user' && <Field label="User"><SearchSelect value={n.user_id ?? ''} disabled={readOnly} ariaLabel="User" options={users} onChange={(v) => set({ user_id: v })} /></Field>}
          <Field label="As"><SearchSelect value={n.role} disabled={readOnly} ariaLabel="Role" options={[{ value: 'broker', label: 'Broker (owner)' }, { value: 'underwriter', label: 'Underwriter' }]} onChange={(v) => set({ role: v })} /></Field>
          <label class="check"><input type="checkbox" checked={!!n.only_if_unassigned} disabled={readOnly} onChange={(e) => set({ only_if_unassigned: (e.target as HTMLInputElement).checked })} />
            <span class="text-sm">Only if nobody has that role on the file yet</span></label>
        </>
      );
      break;
    case 'create_task':
      fields = (
        <>
          <Field label="Title"><input value={n.title ?? ''} disabled={readOnly} onInput={(e) => set({ title: text(e) })} /></Field>
          <Field label="Description"><MessageBox value={n.description ?? ''} rows={3} disabled={readOnly} cat={cat} onChange={(description) => set({ description })} /></Field>
          <div class="grid-3">
            <Field label="Assign to"><SearchSelect value={n.assign_to} disabled={readOnly} ariaLabel="Assign to" options={ROLE_OPTIONS} onChange={(v) => set({ assign_to: v })} /></Field>
            <Field label="Priority"><SearchSelect value={n.priority} disabled={readOnly} ariaLabel="Priority" options={['low', 'normal', 'high', 'urgent'].map((p) => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) }))} onChange={(v) => set({ priority: v })} /></Field>
            <Field label="Due in (days)"><input type="number" min={0} value={n.due_in_days ?? 0} disabled={readOnly} onInput={(e) => set({ due_in_days: num(e) })} /></Field>
          </div>
        </>
      );
      break;
    case 'request_documents': {
      const picked: string[] = n.required_document_ids ?? [];
      const purposes = [...new Set(cat.required_documents.map((d) => d.purpose))];
      const choosing = picked.length > 0 || n._choosing;
      fields = (
        <>
          <div class="seg seg-full" style={{ marginBottom: 12 }}>
            <button type="button" class={!choosing ? 'active' : ''} disabled={readOnly} onClick={() => set({ required_document_ids: [], _choosing: undefined })}>Every required document</button>
            <button type="button" class={choosing ? 'active' : ''} disabled={readOnly} onClick={() => set({ _choosing: true })}>Choose documents</button>
          </div>
          {!choosing ? (
            <p class="text-sm text-muted">Asks for every required entry on the Required Documents checklist for the file’s purpose.</p>
          ) : (
            <div class="permission-pick permission-list" style={{ maxHeight: 260 }}>
              {purposes.map((p) => (
                <div key={p}>
                  <div class="wf-pick-title">{p.replace(/_/g, ' ')}</div>
                  {cat.required_documents.filter((d) => d.purpose === p).map((d) => (
                    <label key={d.id} class="check">
                      <input type="checkbox" checked={picked.includes(d.id)} disabled={readOnly}
                             onChange={(e) => set({ required_document_ids: (e.target as HTMLInputElement).checked ? [...picked, d.id] : picked.filter((x) => x !== d.id) })} />
                      <span class="text-sm">{d.name}{d.required ? '' : ' · optional'}</span>
                    </label>
                  ))}
                </div>
              ))}
              {!cat.required_documents.length && <p class="text-sm text-muted">No Required Documents checklist yet.</p>}
            </div>
          )}
          <div class="grid-2">
            <Field label="Send by"><SearchSelect value={n.channel} disabled={readOnly} ariaLabel="Send by" options={[{ value: 'email', label: 'Email' }, { value: 'sms', label: 'Text' }, { value: 'both', label: 'Email and text' }]} onChange={(v) => set({ channel: v })} /></Field>
            <Field label="Link lasts (days)"><input type="number" min={1} max={90} value={n.expires_in_days ?? 21} disabled={readOnly} onInput={(e) => set({ expires_in_days: num(e) })} /></Field>
          </div>
          <Field label="Message (optional)"><MessageBox value={n.message ?? ''} rows={3} disabled={readOnly} cat={cat} onChange={(message) => set({ message })} /></Field>
        </>
      );
      break;
    }
    case 'enroll_automation': case 'stop_automation':
      fields = (
        <Field label={n.type === 'enroll_automation' ? 'Add to workflow' : 'Remove from'}>
          <SearchSelect value={n.automation_id ?? ''} disabled={readOnly} ariaLabel="Workflow"
                        options={[...(n.type === 'stop_automation' ? [{ value: '', label: 'Every other workflow' }] : []),
                                  ...cat.automations.filter((a) => a.id !== automationId).map((a) => ({ value: a.id, label: a.name, hint: STATUS_LABEL[a.status] ?? a.status }))]}
                        onChange={(v) => set({ automation_id: v || null })} />
        </Field>
      );
      break;
    case 'webhook':
      fields = (
        <>
          <Field label="URL" hint="https only. The client and file are sent as JSON."><input value={n.url ?? ''} disabled={readOnly} onInput={(e) => set({ url: text(e) })} /></Field>
          <Field label="Method"><SearchSelect value={n.method} disabled={readOnly} ariaLabel="Method" options={[{ value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }]} onChange={(v) => set({ method: v })} /></Field>
          <Field label="Signing secret (optional)" hint="Signs the body as an X-Lendmax-Signature HMAC header."><input value={n.secret ?? ''} disabled={readOnly} onInput={(e) => set({ secret: text(e) || undefined })} /></Field>
        </>
      );
      break;
    case 'stop':
      fields = <Field label="Reason (optional)"><input value={n.reason ?? ''} disabled={readOnly} onInput={(e) => set({ reason: text(e) })} /></Field>;
      break;
    case 'branch':
      fields = <ConditionEditor conditions={n.conditions ?? []} match={n.match} cat={cat} readOnly={readOnly} onChange={(conditions, match) => set({ conditions, match: match ?? n.match })} />;
      break;
    default:
      fields = null;
  }

  const clean = () => {
    const { _choosing, ...rest } = n;
    void _choosing;
    return rest as WfNode;
  };

  return (
    <>
      <div class="wf-drawer-body">
        {spec && <p class="text-sm text-muted" style={{ marginTop: 0 }}>{spec.description}</p>}
        <Field label="Action name"><input value={n.label ?? ''} disabled={readOnly} placeholder={spec?.label} onInput={(e) => set({ label: text(e) || undefined })} /></Field>
        {fields}
      </div>
      <DrawerFooter readOnly={readOnly} onSave={() => onSave(clean())} onDelete={onDelete} onCancel={onCancel} />
    </>
  );
}

// ── Conditions ─────────────────────────────────────────────────────────────

const OPS_FOR: Record<string, string[]> = {
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_set', 'is_empty'],
  enum: ['eq', 'ne', 'in', 'not_in', 'is_set', 'is_empty'],
  stage: ['eq', 'ne', 'in', 'not_in', 'is_set', 'is_empty'],
  pipeline: ['eq', 'ne', 'is_set'],
  user: ['eq', 'ne', 'is_set', 'is_empty'],
  boolean: ['is_set', 'is_empty'],
  tags: ['contains', 'not_contains', 'is_set', 'is_empty'],
  date: ['is_set', 'is_empty'],
  text: ['eq', 'ne', 'contains', 'not_contains', 'is_set', 'is_empty'],
};

export function ConditionEditor({ conditions, match, cat, readOnly, extra = [], withReason = false, onChange }: {
  conditions: Condition[]; match?: 'all' | 'any'; cat: Catalogue; readOnly: boolean;
  extra?: Array<{ field: string; label: string; type: string }>; withReason?: boolean;
  onChange: (conditions: Condition[], match?: 'all' | 'any') => void;
}) {
  const fields: FactField[] = [...extra.map((e) => ({ ...e, group: 'This event' })), ...cat.fields];
  return (
    <div class="wf-conditions">
      {match && conditions.length > 1 && (
        <div class="row text-sm" style={{ gap: 6, marginBottom: 6 }}>
          Match
          <div class="seg">
            <button type="button" class={match === 'all' ? 'active' : ''} disabled={readOnly} onClick={() => onChange(conditions, 'all')}>All (AND)</button>
            <button type="button" class={match === 'any' ? 'active' : ''} disabled={readOnly} onClick={() => onChange(conditions, 'any')}>Any (OR)</button>
          </div>
        </div>
      )}
      {conditions.map((c, i) => (
        <div key={i}>
          {i > 0 && <div class="wf-andor">{match === 'any' ? 'OR' : withReason ? 'OR' : 'AND'}</div>}
          <ConditionRow condition={c} fields={fields} cat={cat} readOnly={readOnly} withReason={withReason}
                        onChange={(next) => onChange(conditions.map((x, k) => (k === i ? next : x)), match)}
                        onRemove={() => onChange(conditions.filter((_, k) => k !== i), match)} />
        </div>
      ))}
      {!readOnly && (
        <button class="btn btn-sm" type="button"
                onClick={() => onChange([...conditions, { field: fields[0]?.field ?? 'stage_key', op: 'is_set', ...(withReason ? { reason: '' } : {}) }], match)}>
          + Add condition
        </button>
      )}
    </div>
  );
}

function ConditionRow({ condition: c, fields, cat, readOnly, withReason, onChange, onRemove }: {
  condition: Condition; fields: FactField[]; cat: Catalogue; readOnly: boolean; withReason: boolean;
  onChange: (c: Condition) => void; onRemove: () => void;
}) {
  const field = fields.find((f) => f.field === c.field);
  const type = field?.type ?? 'text';
  const ops = cat.operators.filter((o) => (OPS_FOR[type] ?? OPS_FOR.text!).includes(o.op));
  const needsValue = c.op !== 'is_set' && c.op !== 'is_empty';
  const multi = c.op === 'in' || c.op === 'not_in';

  const choices: SelectOption[] | null =
    type === 'enum' ? (field?.options ?? []).map((o) => ({ value: o, label: o }))
    : type === 'stage' ? cat.stages.map((s) => ({ value: s.key, label: s.label, hint: s.pipeline_name }))
    : type === 'pipeline' ? cat.pipelines.map((p) => ({ value: p.key, label: p.name }))
    : type === 'user' ? cat.users.map((u) => ({ value: u.id, label: u.name }))
    : null;

  let valueControl: any = null;
  if (needsValue) {
    if (choices && multi) {
      const list = Array.isArray(c.value) ? c.value.map(String) : [];
      valueControl = (
        <div class="wf-multi">
          {choices.map((o) => (
            <label key={o.value} class={`wf-chip${list.includes(o.value) ? ' on' : ''}`}>
              <input type="checkbox" checked={list.includes(o.value)} disabled={readOnly}
                     onChange={(e) => onChange({ ...c, value: (e.target as HTMLInputElement).checked ? [...list, o.value] : list.filter((v) => v !== o.value) })} />
              {o.label}
            </label>
          ))}
        </div>
      );
    } else if (choices) {
      valueControl = <SearchSelect value={String(c.value ?? '')} disabled={readOnly} ariaLabel="Value" options={choices} onChange={(v) => onChange({ ...c, value: v })} />;
    } else if (type === 'number') {
      valueControl = (
        <input inputMode="decimal" disabled={readOnly} placeholder="0"
               value={c.value === undefined ? '' : String(c.value)}
               onInput={(e) => {
                 const raw = (e.target as HTMLInputElement).value.replace(/[^0-9.\-]/g, '');
                 // Kept as typed while it is half a number ("80.", "-"), a number once it is one.
                 onChange({ ...c, value: raw === '' || !Number.isFinite(Number(raw)) || raw.endsWith('.') ? raw : Number(raw) });
               }} />
      );
    } else {
      valueControl = (
        <>
          <input value={String(c.value ?? '')} disabled={readOnly} list={type === 'tags' ? 'wf-cond-tags' : undefined}
                 onInput={(e) => onChange({ ...c, value: (e.target as HTMLInputElement).value })} />
          {type === 'tags' && <datalist id="wf-cond-tags">{cat.tags.map((t) => <option key={t} value={t} />)}</datalist>}
        </>
      );
    }
  }

  const fieldOptions: SelectOption[] = fields.map((f) => ({ value: f.field, label: f.label, hint: f.group }));

  return (
    <div class="wf-cond">
      <div class="wf-cond-field">
        <SearchSelect value={c.field} disabled={readOnly} ariaLabel="Field" options={fieldOptions}
                      searchPlaceholder="Search any field — income, purpose, stage…"
                      onChange={(v) => {
                        const f = fields.find((x) => x.field === v);
                        const allowed = OPS_FOR[f?.type ?? 'text'] ?? OPS_FOR.text!;
                        onChange({ ...c, field: v, op: allowed.includes(c.op) ? c.op : allowed[0]!, value: undefined });
                      }} />
      </div>
      <div class="wf-cond-op">
        <SearchSelect value={c.op} disabled={readOnly} ariaLabel="Operator"
                      options={ops.map((o) => ({ value: o.op, label: type === 'boolean' ? (o.op === 'is_set' ? 'is yes' : 'is no') : o.label }))}
                      onChange={(v) => onChange({ ...c, op: v, value: v === 'in' || v === 'not_in' ? [] : Array.isArray(c.value) ? undefined : c.value })} />
      </div>
      {needsValue && <div class="wf-cond-value">{valueControl}</div>}
      {!readOnly && <button class="btn btn-ghost btn-sm" aria-label="Remove condition" onClick={onRemove}><Svg name="x" size={14} /></button>}
      {withReason && (
        <div class="wf-cond-reason">
          <input value={c.reason ?? ''} disabled={readOnly} placeholder="Reason, recorded on the client’s file — e.g. “The file funded.”"
                 onInput={(e) => onChange({ ...c, reason: (e.target as HTMLInputElement).value })} />
        </div>
      )}
    </div>
  );
}

// ── Settings ───────────────────────────────────────────────────────────────

export function SettingsTab({ id, loaded, def, cat, readOnly, name, onName, onChange, onSaved }: {
  id: string; loaded: Loaded; def: Definition; cat: Catalogue; readOnly: boolean; name: string;
  onName: (v: string) => void; onChange: (d: Definition) => void; onSaved: () => void;
}) {
  const a = loaded.automation;
  const [form, setForm] = useState({
    description: a.description ?? '', purpose: a.purpose, allow_reenrollment: a.allow_reenrollment,
    reenrollment_cooldown_days: a.reenrollment_cooldown_days ?? 0,
  });
  const [busy, setBusy] = useState(false);

  const saveSettings = async () => {
    setBusy(true);
    try {
      await put(`/automations/${id}`, {
        name, description: form.description || null, purpose: form.purpose,
        allow_reenrollment: form.allow_reenrollment,
        reenrollment_cooldown_days: form.allow_reenrollment ? form.reenrollment_cooldown_days || null : null,
      });
      toast('Settings saved.', 'ok');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="content-narrow wf-settings">
      <div class="card">
        <div class="card-head"><h2>Workflow</h2>{!readOnly && <button class="btn btn-primary btn-sm" disabled={busy} onClick={saveSettings}>{busy ? 'Saving…' : 'Save settings'}</button>}</div>
        <div class="card-body">
          <Field label="Name"><input value={name} disabled={readOnly} onInput={(e) => onName((e.target as HTMLInputElement).value)} /></Field>
          <Field label="Description"><textarea rows={2} value={form.description} disabled={readOnly} onInput={(e) => setForm({ ...form, description: (e.target as HTMLTextAreaElement).value })} /></Field>
          <Field label="What this workflow sends" hint="A marketing workflow only messages clients with marketing consent, whatever each step says.">
            <SearchSelect value={form.purpose} disabled={readOnly} ariaLabel="Purpose"
                          options={[{ value: 'transactional', label: 'About the client’s mortgage (transactional)' }, { value: 'service', label: 'Service' }, { value: 'marketing', label: 'Marketing' }]}
                          onChange={(v) => setForm({ ...form, purpose: v })} />
          </Field>
          <label class="check">
            <input type="checkbox" checked={form.allow_reenrollment} disabled={readOnly} onChange={(e) => setForm({ ...form, allow_reenrollment: (e.target as HTMLInputElement).checked })} />
            <span class="text-sm">Allow re-entry — a client can go through this workflow more than once</span>
          </label>
          {form.allow_reenrollment && (
            <Field label="But not within (days)"><input type="number" min={0} value={form.reenrollment_cooldown_days} disabled={readOnly} onInput={(e) => setForm({ ...form, reenrollment_cooldown_days: Number((e.target as HTMLInputElement).value) })} /></Field>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h2>Only enrol clients when</h2><p class="text-sm text-muted mb-0">Checked once, when a trigger fires. Saved with the workflow — use Save in the top bar.</p></div></div>
        <div class="card-body">
          <ConditionEditor conditions={def.entry_conditions} cat={cat} readOnly={readOnly}
                           onChange={(entry_conditions) => onChange({ ...def, entry_conditions })} />
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h2>Goal — stop the workflow when</h2><p class="text-sm text-muted mb-0">Checked before every step. The first that is true ends the workflow for that client, and its reason is recorded. Saved with the workflow.</p></div></div>
        <div class="card-body">
          <ConditionEditor conditions={def.stop_conditions} cat={cat} readOnly={readOnly} withReason
                           onChange={(conditions) => onChange({ ...def, stop_conditions: conditions.map((c) => ({ ...c, reason: c.reason ?? '' })) as Definition['stop_conditions'] })} />
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Versions</h2></div>
        <div class="card-body-flush">
          <DataTable label="Versions" compact rows={loaded.versions} rowKey={(v) => String(v.version)}
            initialSort={{ key: 'version', dir: 'desc' }}
            columns={[
              { key: 'version', header: 'Version', render: (v) => `v${v.version}${v.version === a.published_version ? ' · live' : ''}` },
              { key: 'published_at', header: 'Published', value: (v) => v.published_at ?? '',
                render: (v) => (v.published_at ? `${formatDateTime(v.published_at)}${v.published_by_name ? ` by ${v.published_by_name}` : ''}` : 'Draft') },
              { key: 'running', header: 'Clients running it', align: 'right' },
            ]} />
        </div>
      </div>
    </div>
  );
}

// ── Enrollment history and logs ────────────────────────────────────────────

type EnrollmentRow = {
  id: string; status: string; current_node_key: string | null; next_run_at: string | null;
  enrolled_at: string; steps_completed: number; messages_sent: number; stopped_reason: string | null;
  last_error: string | null; customer_id: string; first_name: string; last_name: string;
  application_id: string | null; portal_reference: string | null;
};

export function HistoryTab({ id, session, live }: { id: string; session: Session; live: boolean }) {
  const state = useAsync<{ enrollments: EnrollmentRow[] }>(`/automations/${id}/enrollments?status=all&limit=200`, [id]);
  const canControl = session.permissions.includes('automation.control');
  const [adding, setAdding] = useState(false);

  const columns: Column<EnrollmentRow>[] = [
    { key: 'client', header: 'Client', primary: true, value: (e) => `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim(),
      render: (e) => <span class="cell-strong">{`${e.first_name ?? ''} ${e.last_name ?? ''}`.trim() || 'Unnamed'}</span> },
    { key: 'status', header: 'Status', filter: 'auto',
      render: (e) => <Badge tone={e.status === 'active' ? 'ok' : e.status === 'paused' ? 'warn' : e.status === 'failed' ? 'danger' : 'neutral'}>{e.status}</Badge> },
    { key: 'detail', header: 'Where / why', value: (e) => e.stopped_reason ?? e.current_node_key ?? '',
      render: (e) => (
        <span class="text-sm">
          {e.status === 'stopped' ? e.stopped_reason ?? 'Stopped' : e.status === 'active' && e.next_run_at ? `Next step ${relativeTime(e.next_run_at)}` : e.status}
          {e.last_error && <div style={{ color: 'var(--danger-text)' }}>{e.last_error}</div>}
        </span>
      ) },
    { key: 'steps_completed', header: 'Steps', align: 'right', filter: 'number' },
    { key: 'messages_sent', header: 'Messages', align: 'right', filter: 'number' },
    { key: 'enrolled_at', header: 'Enrolled', filter: 'auto', filterValue: (e) => recency(e.enrolled_at), render: (e) => relativeTime(e.enrolled_at) },
    { key: 'controls', header: '', sortable: false, filter: false, searchable: false,
      render: (e) => (canControl && (e.status === 'active' || e.status === 'paused')
        ? <span onClick={(ev) => ev.stopPropagation()}><EnrollmentControls enrollment={e} onChanged={state.reload} compact /></span> : null) },
  ];

  return (
    <div class="content-narrow">
      <div class="card">
        <div class="card-head">
          <h2>Enrollment history</h2>
          {canControl && live && <button class="btn btn-sm btn-primary" onClick={() => setAdding(true)}>+ Add a client</button>}
        </div>
        {state.status === 'error' ? <div class="card-body"><ErrorNote error={state.error} onRetry={state.reload} /></div> : (
          <DataTable label="Enrollments" columns={columns} rows={state.status === 'ready' ? state.data.enrollments : []}
                     rowKey={(e) => e.id} loading={state.status === 'loading'} initialSort={{ key: 'enrolled_at', dir: 'desc' }}
                     searchPlaceholder="Search clients…"
                     onRowClick={(e) => e.application_id && navigate(`/applications/${e.application_id}`)}
                     empty={<Empty title="Nobody has entered this workflow yet">{live ? 'Clients appear here as its triggers fire.' : 'Publish it to start taking clients.'}</Empty>} />
        )}
      </div>
      {adding && <AddClient id={id} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); state.reload(); }} />}
    </div>
  );
}

type ClientHit = { id: string; first_name: string | null; last_name: string | null; email: string | null; phone_e164: string | null };

function ClientSearch({ onPick }: { onPick: (c: ClientHit) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ClientHit[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    const t = setTimeout(() => {
      get<{ customers: ClientHit[] }>(`/customers/search?q=${encodeURIComponent(q)}`).then((d) => setRows(d.customers)).catch(() => setRows([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <>
      <input type="search" autofocus placeholder="Search a client by name, email or phone…" value={q}
             onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="wf-client-results">
        {rows.map((r) => (
          <button key={r.id} type="button" class="wf-client" onClick={() => onPick(r)}>
            <strong>{`${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Unnamed'}</strong>
            <span class="text-sm text-muted">{[r.email, r.phone_e164].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
        {q.trim().length >= 2 && !rows.length && <p class="text-sm text-muted">No clients match.</p>}
      </div>
    </>
  );
}

function AddClient({ id, onClose, onAdded }: { id: string; onClose: () => void; onAdded: () => void }) {
  const [error, setError] = useState('');
  const add = async (customerId: string) => {
    setError('');
    try {
      await post(`/automations/${id}/enrol`, { customer_id: customerId });
      toast('Added. The first step runs in a moment.', 'ok');
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that client.');
    }
  };
  return (
    <Modal title="Add a client to this workflow" onClose={onClose}>
      {error && <div class="alert alert-error">{error}</div>}
      <p class="text-sm text-muted">They start at the first step now, whatever the triggers say. The goal (stop) conditions still apply.</p>
      <ClientSearch onPick={(c) => add(c.id)} />
    </Modal>
  );
}

type ExecutionRow = {
  id: string; at: string; node_key: string; node_type: string; outcome: string; reason: string | null;
  enrollment_id: string; customer_id: string; first_name: string; last_name: string; application_id: string | null; label: string;
};

export function LogsTab({ id }: { id: string }) {
  const state = useAsync<{ executions: ExecutionRow[] }>(`/automations/${id}/executions?limit=500`, [id]);
  const columns: Column<ExecutionRow>[] = [
    { key: 'at', header: 'When', filter: 'auto', filterValue: (x) => recency(x.at), render: (x) => formatDateTime(x.at) },
    { key: 'client', header: 'Client', primary: true, value: (x) => `${x.first_name ?? ''} ${x.last_name ?? ''}`.trim() },
    { key: 'label', header: 'Step' },
    { key: 'outcome', header: 'Outcome', filter: 'auto', render: (x) => <span class={`step-outcome outcome-${x.outcome}`}>{x.outcome}</span> },
    { key: 'reason', header: 'Detail', render: (x) => <span class="text-sm">{x.reason ?? '—'}</span> },
  ];
  return (
    <div class="content-narrow">
      <div class="card">
        <div class="card-head"><h2>Execution logs</h2><button class="btn btn-sm" onClick={state.reload}>Refresh</button></div>
        {state.status === 'error' ? <div class="card-body"><ErrorNote error={state.error} onRetry={state.reload} /></div> : (
          <DataTable label="Execution logs" columns={columns} rows={state.status === 'ready' ? state.data.executions : []}
                     rowKey={(x) => String(x.id)} loading={state.status === 'loading'} initialSort={{ key: 'at', dir: 'desc' }}
                     onRowClick={(x) => x.application_id && navigate(`/applications/${x.application_id}`)}
                     empty={<Empty title="Nothing has run yet">Every step every client takes is recorded here, with why.</Empty>} />
        )}
      </div>
    </div>
  );
}

// ── Testing ────────────────────────────────────────────────────────────────

type TestResult = {
  facts: Record<string, unknown>;
  triggers: Array<{ label: string; type: string; filters_pass: boolean }>;
  entry_pass: boolean; stop_reason: string | null;
  steps: Array<{ key: string; type: string; label: string; outcome: string; detail: string }>;
};

export function TestWorkflow({ id, def, cat, onClose, onPath }: {
  id: string; def: Definition; cat: Catalogue; onClose: () => void; onPath: (keys: string[]) => void;
}) {
  const [client, setClient] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showFacts, setShowFacts] = useState(false);
  const factLabel = useMemo(() => new Map(cat.fields.map((f) => [f.field, f.label])), [cat]);

  const run = async (c: ClientHit) => {
    setClient(`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Unnamed');
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await post<TestResult>(`/automations/${id}/test`, { customer_id: c.id, definition: def }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not test that.');
    } finally {
      setBusy(false);
    }
  };

  const stepLabel = (s: TestResult['steps'][number]) => (s.label === s.type ? cat.actions.find((a) => a.type === s.type)?.label ?? s.type : s.label);

  return (
    <Modal title="Test workflow" onClose={onClose} wide footer={<>
      {result && <button class="btn" onClick={() => { onPath(result.steps.map((s) => s.key)); onClose(); }}>Show the path on the canvas</button>}
      <button class="btn btn-primary" onClick={onClose}>Done</button>
    </>}>
      <p class="text-sm text-muted">Walks the workflow on screen — including unsaved changes — against a real client’s file. Nothing is sent, created or moved.</p>
      {error && <div class="alert alert-error">{error}</div>}
      {!client ? <ClientSearch onPick={run} /> : (
        <div class="row" style={{ gap: 8, marginBottom: 10 }}>
          <strong>{client}</strong>
          <button class="link-button" onClick={() => { setClient(null); setResult(null); }}>Choose another client</button>
        </div>
      )}
      {busy && <Skeleton rows={4} />}
      {result && (
        <div class="stack">
          <div>
            <h3 class="app-group-title">Would they be enrolled?</h3>
            {result.triggers.map((t, i) => (
              <div key={i} class="text-sm">{t.filters_pass ? '✅' : '❌'} {cat.triggers.find((x) => x.type === t.type)?.label ?? t.type} — {t.filters_pass ? 'filters pass' : 'filters do not pass'}</div>
            ))}
            <div class="text-sm">{result.entry_pass ? '✅ Entry conditions pass' : '❌ Entry conditions do not pass'}</div>
            {result.stop_reason && <div class="text-sm">⛔ A goal is already met, so it would stop at once: {result.stop_reason}</div>}
          </div>
          <div>
            <h3 class="app-group-title">The path today</h3>
            <ol class="wf-test-path">
              {result.steps.map((s) => (
                <li key={s.key}><strong>{stepLabel(s)}</strong>{s.detail && <span class="text-muted"> — {s.detail}</span>}</li>
              ))}
              {!result.steps.length && <li class="text-muted">No actions yet.</li>}
            </ol>
          </div>
          <button class="link-button text-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setShowFacts(!showFacts)}>
            {showFacts ? 'Hide' : 'Show'} what the conditions saw
          </button>
          {showFacts && (
            <div class="wf-facts">
              {Object.entries(result.facts).map(([k, v]) => (
                <div key={k}><span class="text-muted">{factLabel.get(k) ?? k}</span><span>{String(v)}</span></div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
