/**
 * LM Automation — the workflow list and the builder canvas.
 *
 * Laid out the way GoHighLevel's workflow builder is, because that is the
 * shape people who build automations already know:
 *
 *   · a canvas with the TRIGGERS across the top ("Add New Trigger" beside
 *     them — a workflow can start from several events), the actions running
 *     down the middle, and a "+" on every connector where the next one goes;
 *   · IF / ELSE splits the flow into side-by-side branches, each with its own
 *     "+", and a None path for clients who matched no branch;
 *   · everything is configured in a drawer that slides in from the right
 *     (workflow-forms.tsx);
 *   · a top bar with the name, the Builder / Settings / Enrollment History /
 *     Execution Logs tabs, Test workflow, Save, and the Draft ⟷ Publish switch.
 */
import { useEffect, useState } from 'preact/hooks';
import { ApiError, post, put, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, type Session } from '../lib/store.ts';
import { DataTable, recency, type Column } from '../components/data-table.tsx';
import { Badge, Empty, ErrorNote, Field, Modal, Skeleton } from '../components/ui.tsx';
import {
  describeNode, GROUP_TONE, nodeOf, removeNode, STATUS_LABEL, Svg, targetOf, useCatalogue,
  type Branch, type Catalogue, type Definition, type Issue, type Loaded, type Slot, type WfNode,
} from './workflow-shared.tsx';
import { Drawer, HistoryTab, LogsTab, SettingsTab, TestWorkflow, type DrawerState } from './workflow-forms.tsx';

// ── The list ───────────────────────────────────────────────────────────────

type Summary = {
  id: string; name: string; description: string | null; status: string; purpose: string;
  published_version: number | null; latest_version: number | null; trigger_types: string[] | null;
  active_enrollments: number; completed_enrollments: number; stopped_enrollments: number;
  total_enrollments: number; messages_sent: number; updated_at: string; last_enrolled_at: string | null;
};

export function WorkflowsList({ session }: { session: Session }) {
  const state = useAsync<{ automations: Summary[]; trigger_labels: Record<string, string> }>('/automations');
  const [creating, setCreating] = useState(false);
  const canEdit = session.permissions.includes('automation.edit');
  const canPublish = session.permissions.includes('automation.publish');

  const act = async (id: string, action: 'duplicate' | 'pause' | 'resume' | 'archive') => {
    try {
      if (action === 'duplicate') {
        const { id: copy } = await post<{ id: string }>(`/automations/${id}/duplicate`);
        toast('Copied as a draft.', 'ok');
        navigate(`/automations?id=${copy}`);
        return;
      }
      if (action === 'archive' && !confirm('Delete this workflow? It stops taking new clients and leaves the list. Clients already in it finish.')) return;
      await post(`/automations/${id}/status`, { status: action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'archived' });
      toast(action === 'pause' ? 'Paused — no new clients will enter.' : action === 'resume' ? 'Running again.' : 'Deleted.', 'ok');
      state.reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work.', 'error');
    }
  };

  const labels = state.status === 'ready' ? state.data.trigger_labels : {};
  const triggerText = (a: Summary) => (a.trigger_types ?? []).filter(Boolean).map((t) => labels[t] ?? t).join(', ');
  const columns: Column<Summary>[] = [
    { key: 'name', header: 'Name', primary: true,
      render: (a) => (
        <div>
          <div class="cell-strong">{a.name}</div>
          {a.description && <div class="cell-muted text-sm wf-clamp">{a.description}</div>}
        </div>
      ) },
    { key: 'status', header: 'Status', filter: { options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })) },
      render: (a) => (
        <span class="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          <Badge tone={a.status === 'active' ? 'ok' : a.status === 'paused' ? 'warn' : 'neutral'}>{STATUS_LABEL[a.status] ?? a.status}</Badge>
          {a.published_version && a.latest_version && a.latest_version > a.published_version
            ? <Badge tone="info">Unpublished changes</Badge> : null}
        </span>
      ) },
    { key: 'triggers', header: 'Triggers', value: triggerText, render: (a) => <span class="text-sm">{triggerText(a) || '—'}</span> },
    { key: 'total_enrollments', header: 'Total enrolled', align: 'right', filter: 'number' },
    { key: 'active_enrollments', header: 'Active', align: 'right', filter: 'number' },
    { key: 'updated_at', header: 'Last updated', filter: 'auto', filterValue: (a) => recency(a.updated_at),
      render: (a) => <span class="cell-muted">{relativeTime(a.updated_at)}</span> },
    { key: 'actions', header: '', sortable: false, searchable: false, filter: false,
      render: (a) => (
        <span class="row" style={{ gap: 2, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
          {canEdit && <button class="btn btn-ghost btn-sm" title="Duplicate" aria-label="Duplicate" onClick={() => act(a.id, 'duplicate')}><Svg name="copy" size={14} /></button>}
          {canPublish && a.status === 'active' && <button class="btn btn-ghost btn-sm" onClick={() => act(a.id, 'pause')}>Pause</button>}
          {canPublish && a.status === 'paused' && a.published_version ? <button class="btn btn-ghost btn-sm" onClick={() => act(a.id, 'resume')}>Resume</button> : null}
          {canPublish && <button class="btn btn-ghost btn-sm" title="Delete" aria-label="Delete" onClick={() => act(a.id, 'archive')}><Svg name="trash" size={14} /></button>}
        </span>
      ) },
  ];

  const rows = state.status === 'ready' ? state.data.automations : [];
  const published = rows.filter((r) => r.status === 'active').length;
  const running = rows.reduce((t, r) => t + (r.active_enrollments ?? 0), 0);

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>LM Automation</h1>
          <p>
            Workflows that run on their own: when something happens to a client, check anything on their file,
            then email, text, move the stage, assign, tag or ask for documents.
          </p>
        </div>
        {canEdit && (
          <button class="btn btn-primary" onClick={() => setCreating(true)}>
            <Svg name="plus" size={14} /> Create workflow
          </button>
        )}
      </div>

      {state.status === 'ready' && (
        <div class="wf-stats">
          <div><strong>{rows.length}</strong><span>Workflows</span></div>
          <div><strong>{published}</strong><span>Published</span></div>
          <div><strong>{running}</strong><span>Clients in a workflow now</span></div>
        </div>
      )}

      <div class="card">
        {state.status === 'error' ? (
          <div style={{ padding: 15 }}><ErrorNote error={state.error} code={state.code} permission={state.permission} onRetry={state.reload} /></div>
        ) : (
          <DataTable<Summary>
            label="Workflows" columns={columns} rows={rows} rowKey={(r) => r.id}
            loading={state.status === 'loading'} initialSort={{ key: 'updated_at', dir: 'desc' }}
            searchPlaceholder="Search workflows…"
            onRowClick={(r) => navigate(`/automations?id=${r.id}`)}
            empty={
              <Empty title="No workflows yet"
                     action={canEdit ? <button class="btn btn-primary" onClick={() => setCreating(true)}>Create workflow</button> : undefined}>
                Start from scratch or from a recipe.
              </Empty>
            } />
        )}
      </div>

      {creating && <CreateWorkflow onClose={() => setCreating(false)} />}
    </div>
  );
}

// ── Recipes ────────────────────────────────────────────────────────────────

const STOPS = [
  { field: 'stage_category', op: 'eq', value: 'lost', reason: 'The file was marked lost.' },
  { field: 'stage_category', op: 'eq', value: 'won', reason: 'The file funded.' },
];

const RECIPES: Array<{ name: string; description: string; definition: Definition }> = [
  {
    name: 'High-income purchase — fast track',
    description: 'When a purchase application with household income over $150,000 is submitted, tell the broker and create an urgent call task; everybody else gets the standard thank-you email.',
    definition: {
      triggers: [{ type: 'application.submitted', filters: [] }], entry_conditions: [], stop_conditions: STOPS,
      start_node: 'split',
      nodes: [
        { key: 'split', type: 'if_else', label: 'Purchase over $150k?', else_next: 'welcome',
          branches: [{ key: 'b1', name: 'Fast track', match: 'all', next: 'notify', conditions: [
            { field: 'purpose.purpose', op: 'eq', value: 'Purchase' },
            { field: 'calc.total_income', op: 'gt', value: 150000 }] }] },
        { key: 'notify', type: 'notify_user', label: 'Tell the broker', role: 'broker', title: 'Fast-track purchase: {first_name} {last_name}', next: 'task' },
        { key: 'task', type: 'create_task', label: 'Call within the hour', title: 'Call {first_name} {last_name} — fast-track purchase', priority: 'urgent', due_in_days: 0, assign_to: 'broker', category: 'follow_up', next: null },
        { key: 'welcome', type: 'send_email', label: 'Thank-you email', purpose: 'transactional',
          subject: 'We have your application, {first_name}', body: 'Hi {first_name},\n\nThank you — your application is with us and a broker will be in touch shortly.\n\n{signature}', next: null },
      ],
    },
  },
  {
    name: 'New lead — speed to lead',
    description: 'Assign a new lead by round robin if nobody has it, text them within minutes, and create a call task.',
    definition: {
      triggers: [{ type: 'customer.created', filters: [] }], entry_conditions: [], stop_conditions: STOPS,
      start_node: 'assign',
      nodes: [
        { key: 'assign', type: 'assign_user', label: 'Round robin', mode: 'round_robin', role: 'broker', only_if_unassigned: true, next: 'sms' },
        { key: 'sms', type: 'send_sms', label: 'First text', purpose: 'transactional', body: 'Hi {first_name}, this is {user_first_name} from Lendmax — thanks for reaching out. When is a good time for a quick call?', next: 'task' },
        { key: 'task', type: 'create_task', label: 'Call task', title: 'Call {first_name} {last_name}', priority: 'high', due_in_days: 0, assign_to: 'broker', category: 'follow_up', next: null },
      ],
    },
  },
  {
    name: 'Missed appointment — rebook',
    description: 'After a no-show, text a rebooking link, wait a day, and email if they still have nothing booked.',
    definition: {
      triggers: [{ type: 'appointment.no_show', filters: [] }], entry_conditions: [],
      stop_conditions: [...STOPS, { field: 'future_appointments', op: 'gt', value: 0, reason: 'They rebooked.' }],
      start_node: 'sms',
      nodes: [
        { key: 'sms', type: 'send_sms', label: 'Rebook text', purpose: 'transactional', body: 'Hi {first_name}, sorry we missed you. Pick another time here: {schedule_link}', next: 'wait' },
        { key: 'wait', type: 'wait', label: 'One day', days: 1, hours: 0, minutes: 0, business_hours_only: true, next: 'email' },
        { key: 'email', type: 'send_email', label: 'Follow-up email', purpose: 'transactional', subject: 'Still want to talk, {first_name}?', body: 'Hi {first_name},\n\nWe missed each other. You can book a time that suits you here: {schedule_link}\n\n{signature}', next: null },
      ],
    },
  },
  {
    name: 'Documents still outstanding',
    description: 'Two days after a document request is still open, remind the client; two days later, give the broker a call task.',
    definition: {
      triggers: [{ type: 'documents.outstanding', after_hours: 48, filters: [] }], entry_conditions: [],
      stop_conditions: [...STOPS, { field: 'documents_outstanding', op: 'eq', value: 0, reason: 'Everything arrived.' }],
      start_node: 'email',
      nodes: [
        { key: 'email', type: 'send_email', label: 'Reminder', purpose: 'transactional', subject: 'A few documents still to come', body: 'Hi {first_name},\n\nWe are still waiting on a few documents for your application. The link in our earlier email still works.\n\n{signature}', next: 'wait' },
        { key: 'wait', type: 'wait', label: 'Two days', days: 2, hours: 0, minutes: 0, business_hours_only: true, next: 'task' },
        { key: 'task', type: 'create_task', label: 'Call about documents', title: 'Call {first_name} about outstanding documents', priority: 'normal', due_in_days: 0, assign_to: 'broker', category: 'follow_up', next: null },
      ],
    },
  },
  {
    name: 'Closing countdown',
    description: 'Seven days before closing, email the client what happens next; if lender conditions are still outstanding, give the underwriter an urgent task.',
    definition: {
      triggers: [{ type: 'closing.approaching', offset_days: 7, filters: [] }], entry_conditions: [], stop_conditions: STOPS,
      start_node: 'email',
      nodes: [
        { key: 'email', type: 'send_email', label: 'One week to go', purpose: 'transactional', subject: 'One week to closing, {first_name}', body: 'Hi {first_name},\n\nYour closing is a week away. Here is what happens next.\n\n{signature}', next: 'split' },
        { key: 'split', type: 'if_else', label: 'Conditions outstanding?', else_next: null,
          branches: [{ key: 'b1', name: 'Outstanding', match: 'all', next: 'task', conditions: [{ field: 'conditions_outstanding', op: 'gt', value: 0 }] }] },
        { key: 'task', type: 'create_task', label: 'Clear conditions', title: 'Clear lender conditions before closing', priority: 'urgent', due_in_days: 2, assign_to: 'underwriter', category: 'follow_up', next: null },
      ],
    },
  },
];

function CreateWorkflow({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [recipe, setRecipe] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setBusy(true); setError('');
    try {
      const chosen = recipe === null ? null : RECIPES[recipe]!;
      const { id } = await post<{ id: string }>('/automations', {
        name: name.trim() || chosen?.name || 'New workflow',
        description: chosen?.description,
        definition: chosen?.definition ?? { triggers: [], entry_conditions: [], stop_conditions: STOPS, start_node: '', nodes: [] },
      });
      navigate(`/automations?id=${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that.');
      setBusy(false);
    }
  };

  return (
    <Modal title="Create workflow" onClose={onClose} wide footer={<>
      <button class="btn" onClick={onClose}>Cancel</button>
      <button class="btn btn-primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Continue'}</button>
    </>}>
      {error && <div class="alert alert-error">{error}</div>}
      <Field label="Workflow name">
        <input value={name} autofocus placeholder={recipe === null ? 'e.g. Purchase over $150k — fast track' : RECIPES[recipe]!.name}
               onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </Field>
      <div class="wf-recipes">
        <button type="button" class={`wf-recipe${recipe === null ? ' on' : ''}`} onClick={() => setRecipe(null)}>
          <strong>Start from scratch</strong>
          <span>An empty canvas: add a trigger, then the actions.</span>
        </button>
        {RECIPES.map((r, i) => (
          <button key={r.name} type="button" class={`wf-recipe${recipe === i ? ' on' : ''}`} onClick={() => setRecipe(i)}>
            <strong>{r.name}</strong>
            <span>{r.description}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// ── The editor ─────────────────────────────────────────────────────────────

export function WorkflowEditor({ id, session }: { id: string; session: Session }) {
  const state = useAsync<Loaded>(`/automations/${id}`, [id]);
  const catalogue = useCatalogue();
  const [def, setDef] = useState<Definition | null>(null);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<'builder' | 'settings' | 'history' | 'logs'>('builder');
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [busy, setBusy] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [problems, setProblems] = useState<{ issues: Issue[]; warningsOnly: boolean } | null>(null);
  const [testing, setTesting] = useState(false);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1);

  const canEdit = session.permissions.includes('automation.edit');
  const canPublish = session.permissions.includes('automation.publish');
  const loadedData = state.status === 'ready' ? state.data : null;

  useEffect(() => {
    if (!loadedData) return;
    const d = loadedData.definition;
    setDef(d ? { ...d, triggers: d.triggers ?? (d.trigger ? [d.trigger] : []), nodes: d.nodes ?? [], start_node: d.start_node ?? '',
                 entry_conditions: d.entry_conditions ?? [], stop_conditions: d.stop_conditions ?? [] }
             : { triggers: [], entry_conditions: [], stop_conditions: [], start_node: '', nodes: [] });
    setName(loadedData.automation.name);
    setIssues(loadedData.issues);
    setDirty(false);
  }, [loadedData]);

  // Leaving the page with unsaved work asks first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (state.status === 'error') return <div class="content-narrow"><ErrorNote error={state.error} code={state.code} permission={state.permission} onRetry={state.reload} /></div>;
  if (catalogue.status === 'error') return <div class="content-narrow"><ErrorNote error={catalogue.error} code={catalogue.code} permission={catalogue.permission} onRetry={catalogue.reload} /></div>;
  if (state.status !== 'ready' || catalogue.status !== 'ready' || !def) {
    return <div class="content-narrow"><Skeleton rows={6} height={60} /></div>;
  }

  const cat: Catalogue = catalogue.data;
  const loaded = state.data;
  const readOnly = !canEdit;
  const change = (next: Definition) => { setDef(next); setDirty(true); setHighlight(new Set()); };

  const payload = (): Definition => ({
    ...def,
    triggers: def.triggers.length ? def.triggers : [{ type: 'manual', filters: [] }],
    trigger: def.triggers[0] ?? { type: 'manual', filters: [] },
  });

  const save = async (quiet = false): Promise<boolean> => {
    setBusy('save');
    try {
      const result = await put<{ issues: Issue[] }>(`/automations/${id}`, { name: name.trim() || loaded.automation.name, definition: payload() });
      setIssues(result.issues);
      setDirty(false);
      if (!quiet) toast('Saved.', 'ok');
      return true;
    } catch (err) {
      toast(err instanceof ApiError ? saveError(err, def, cat) : 'Could not save.', 'error');
      return false;
    } finally {
      setBusy('');
    }
  };

  const publish = async (acknowledge = false) => {
    if (dirty && !(await save(true))) return;
    setBusy('publish');
    try {
      await post(`/automations/${id}/publish`, { acknowledge });
      toast('Published. The workflow is live.', 'ok');
      setProblems(null);
      state.reload();
    } catch (err) {
      if (err instanceof ApiError && err.body.needs_acknowledgement && Array.isArray(err.body.issues)) {
        setProblems({ issues: err.body.issues as Issue[], warningsOnly: true });
      } else if (err instanceof ApiError && Array.isArray(err.detail)) {
        setProblems({ issues: (err.detail as Issue[]).map((i) => ({ level: i.level ?? 'error', message: i.message, node: i.node })), warningsOnly: false });
      } else {
        toast(err instanceof ApiError ? err.message : 'Could not publish.', 'error');
      }
    } finally {
      setBusy('');
    }
  };

  const unpublish = async () => {
    setBusy('publish');
    try {
      await post(`/automations/${id}/status`, { status: 'paused' });
      toast('Back to draft — no new clients will enter. Clients already in it carry on.', 'ok');
      state.reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work.', 'error');
    } finally {
      setBusy('');
    }
  };

  const live = loaded.automation.status === 'active';
  const pending = live && (dirty || (loaded.draft_version ?? 0) > (loaded.automation.published_version ?? 0));
  const errorsByNode = new Map<string, string[]>();
  issues.filter((i) => i.node && i.level === 'error').forEach((i) => errorsByNode.set(i.node!, [...(errorsByNode.get(i.node!) ?? []), i.message]));

  return (
    <div class="wf-editor">
      <div class="wf-topbar">
        <div class="row wf-topbar-left">
          <button class="btn btn-ghost btn-sm" onClick={() => { if (!dirty || confirm('Leave without saving your changes?')) navigate('/automations'); }}>
            <Svg name="back" size={14} /> Workflows
          </button>
          <input class="wf-name" value={name} disabled={readOnly} aria-label="Workflow name"
                 onInput={(e) => { setName((e.target as HTMLInputElement).value); setDirty(true); }} />
          {dirty && <span class="wf-unsaved">Unsaved changes</span>}
        </div>
        <div class="wf-tabs" role="tablist">
          {([['builder', 'Builder'], ['settings', 'Settings'], ['history', 'Enrollment History'], ['logs', 'Execution Logs']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} class={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div class="row wf-topbar-right">
          <button class="btn btn-sm" onClick={() => setTesting(true)}><Svg name="test" size={14} /> Test workflow</button>
          {canEdit && <button class="btn btn-sm" disabled={!!busy || !dirty} onClick={() => save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>}
          {canPublish && (
            <div class="wf-publish">
              <span class={live ? '' : 'on'}>Draft</span>
              <button type="button" class="switch" role="switch" aria-checked={live} aria-label="Published"
                      disabled={!!busy} onClick={() => (live ? unpublish() : publish())}>
                <span class="switch-thumb" />
              </button>
              <span class={live ? 'on' : ''}>Publish</span>
            </div>
          )}
          {canPublish && pending && (
            <button class="btn btn-primary btn-sm" disabled={!!busy} onClick={() => publish()}>Publish changes</button>
          )}
        </div>
      </div>

      {tab === 'builder' && (
        <div class="wf-stage">
          <IssueStrip issues={issues} dirty={dirty} />
          <div class="wf-canvas">
            <div class="wf-zoom-inner" style={{ transform: `scale(${zoom})` }}>
              <Triggers def={def} cat={cat} readOnly={readOnly}
                        onAdd={() => setDrawer({ mode: 'pick-trigger' })}
                        onEdit={(index) => setDrawer({ mode: 'edit-trigger', index })} />
              <Flow slot={{ kind: 'start' }} def={def} cat={cat} readOnly={readOnly} errors={errorsByNode} highlight={highlight}
                    onAdd={(slot) => setDrawer({ mode: 'pick-action', slot })}
                    onEdit={(key) => setDrawer({ mode: 'edit-action', key })}
                    onRemove={(key) => {
                      const n = nodeOf(def, key);
                      if (n?.type === 'if_else' && (n.branches as Branch[]).some((b) => b.next)
                          && !confirm('Delete this If / Else and every step inside its branches? The None path is kept.')) return;
                      change(removeNode(def, key));
                    }} />
            </div>
            <div class="wf-zoom">
              <button class="btn btn-sm" onClick={() => setZoom(Math.max(0.4, Math.round((zoom - 0.1) * 10) / 10))} aria-label="Zoom out">−</button>
              <button class="btn btn-sm" onClick={() => setZoom(1)} title="Reset zoom">{Math.round(zoom * 100)}%</button>
              <button class="btn btn-sm" onClick={() => setZoom(Math.min(1.5, Math.round((zoom + 0.1) * 10) / 10))} aria-label="Zoom in">+</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <SettingsTab id={id} loaded={loaded} def={def} cat={cat} readOnly={readOnly} name={name}
                     onName={(v) => { setName(v); setDirty(true); }} onChange={change} onSaved={state.reload} />
      )}
      {tab === 'history' && <HistoryTab id={id} session={session} live={live} />}
      {tab === 'logs' && <LogsTab id={id} />}

      {drawer && (
        <Drawer drawer={drawer} def={def} cat={cat} readOnly={readOnly} automationId={id}
                onClose={() => setDrawer(null)} onChange={change} setDrawer={setDrawer} />
      )}

      {problems && (
        <Modal title={problems.warningsOnly ? 'Publish anyway?' : 'Not ready to publish'} onClose={() => setProblems(null)} footer={<>
          <button class="btn" onClick={() => setProblems(null)}>{problems.warningsOnly ? 'Cancel' : 'Close'}</button>
          {problems.warningsOnly && <button class="btn btn-primary" onClick={() => publish(true)}>Publish anyway</button>}
        </>}>
          <ul class="wf-issue-list">
            {problems.issues.map((i, n) => (
              <li key={n} class={i.level}>
                {i.message}
                {i.node && nodeOf(def, i.node) && (
                  <button class="link-button" style={{ marginLeft: 6 }}
                          onClick={() => { setProblems(null); setTab('builder'); setDrawer({ mode: 'edit-action', key: i.node! }); }}>
                    Open step
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {testing && (
        <TestWorkflow id={id} def={payload()} cat={cat} onClose={() => setTesting(false)}
                      onPath={(keys) => { setHighlight(new Set(keys)); setTab('builder'); }} />
      )}
    </div>
  );
}

/**
 * A refused save, said in terms of the canvas. The server names fields by
 * path ("nodes.3.url"), which means nothing to the person building; this
 * names the step instead.
 */
function saveError(err: ApiError, def: Definition, cat: Catalogue): string {
  const fields = Array.isArray(err.body.fields) ? err.body.fields as Array<{ field: string; message: string }> : [];
  if (!fields.length) return err.message;
  const lines = fields.map(({ field, message }) => {
    const step = /^nodes\.(\d+)\.(.+)$/.exec(field);
    const node = step ? def.nodes[Number(step[1])] : undefined;
    if (!node) return `${field}: ${message}`;
    const name = node.label || cat.actions.find((a) => a.type === node.type)?.label || node.type;
    return `${name} — ${(step?.[2] ?? '').replace(/_/g, ' ')}: ${message}`;
  });
  return `Could not save. ${lines.join('; ')}`;
}

function IssueStrip({ issues, dirty }: { issues: Issue[]; dirty: boolean }) {
  const [open, setOpen] = useState(false);
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  if (!issues.length) return null;
  return (
    <div class={`wf-issues ${errors.length ? 'bad' : 'warn'}`}>
      <button class="link-button" onClick={() => setOpen(!open)}>
        {[errors.length ? `${errors.length} problem${errors.length === 1 ? '' : 's'} to fix before publishing` : '',
          warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}
        {' '}{open ? '▴' : '▾'}
      </button>
      {dirty && <span class="text-sm text-muted"> · as of the last save</span>}
      {open && <ul class="wf-issue-list">{issues.map((i, n) => <li key={n} class={i.level}>{i.message}</li>)}</ul>}
    </div>
  );
}

// ── Canvas ─────────────────────────────────────────────────────────────────

function Triggers({ def, cat, readOnly, onAdd, onEdit }: {
  def: Definition; cat: Catalogue; readOnly: boolean; onAdd: () => void; onEdit: (i: number) => void;
}) {
  return (
    <div class="wf-triggers">
      {def.triggers.map((t, i) => {
        const spec = cat.triggers.find((x) => x.type === t.type);
        const setting = spec?.config === 'offset_days' ? `${t.offset_days ?? 0} day(s) before`
          : spec?.config === 'after_hours' ? `after ${t.after_hours ?? 0} hour(s)` : '';
        const filters = t.filters.length ? `${t.filters.length} filter${t.filters.length === 1 ? '' : 's'}` : '';
        return (
          <button key={i} type="button" class="wf-card wf-trigger" onClick={() => onEdit(i)}>
            <span class="wf-icon tone-yellow"><Svg name="bolt" /></span>
            <span class="wf-card-text">
              <span class="wf-kicker">Trigger</span>
              <strong>{t.label || spec?.label || t.type}</strong>
              <span class="text-sm text-muted">{[setting, filters].filter(Boolean).join(' · ') || spec?.group}</span>
            </span>
          </button>
        );
      })}
      {!readOnly && (
        <button type="button" class="wf-card wf-trigger wf-add-trigger" onClick={onAdd}>
          <Svg name="plus" /> Add New Trigger
        </button>
      )}
      {readOnly && !def.triggers.length && <div class="wf-card wf-trigger wf-add-trigger">No trigger</div>}
    </div>
  );
}

type FlowProps = {
  def: Definition; cat: Catalogue; readOnly: boolean; errors: Map<string, string[]>; highlight: Set<string>;
  onAdd: (slot: Slot) => void; onEdit: (key: string) => void; onRemove: (key: string) => void;
};

function Flow({ slot, ...props }: FlowProps & { slot: Slot }) {
  const { def, readOnly, highlight, onAdd, onEdit } = props;
  const node = nodeOf(def, targetOf(def, slot));

  return (
    <div class="wf-col">
      <div class={`wf-line${node && highlight.has(node.key) ? ' hot' : ''}`}>
        {!readOnly && (
          <button type="button" class="wf-plus" aria-label="Add action here" title="Add action" onClick={() => onAdd(slot)}>
            <Svg name="plus" size={14} />
          </button>
        )}
      </div>
      {!node ? (
        <div class="wf-end">END</div>
      ) : (
        <>
          <ActionCard node={node} {...props} />
          {node.type === 'if_else' ? (
            <div class="wf-split">
              {(node.branches as Branch[]).map((b) => (
                <div key={b.key} class="wf-branch-col">
                  <button type="button" class="wf-branch-pill" onClick={() => onEdit(node.key)} title="Edit conditions">{b.name}</button>
                  <Flow slot={{ kind: 'branch', key: node.key, branch: b.key }} {...props} />
                </div>
              ))}
              <div class="wf-branch-col">
                <span class="wf-branch-pill none">None</span>
                <Flow slot={{ kind: 'else', key: node.key }} {...props} />
              </div>
            </div>
          ) : node.type === 'branch' ? (
            <div class="wf-split">
              <div class="wf-branch-col"><span class="wf-branch-pill">Yes</span><Flow slot={{ kind: 'yes', key: node.key }} {...props} /></div>
              <div class="wf-branch-col"><span class="wf-branch-pill none">No</span><Flow slot={{ kind: 'no', key: node.key }} {...props} /></div>
            </div>
          ) : node.type === 'goto' || node.type === 'stop' ? (
            <div class="wf-col"><div class="wf-line" /><div class="wf-end">{node.type === 'goto' ? '↪ GO TO' : 'END'}</div></div>
          ) : (
            <Flow slot={{ kind: 'next', key: node.key }} {...props} />
          )}
        </>
      )}
    </div>
  );
}

function ActionCard({ node, def, cat, readOnly, errors, highlight, onEdit, onRemove }: FlowProps & { node: WfNode }) {
  const spec = cat.actions.find((a) => a.type === node.type);
  const problems = errors.get(node.key);
  const tone = node.type === 'if_else' || node.type === 'branch' ? 'orange' : GROUP_TONE[spec?.group ?? ''] ?? 'grey';
  return (
    <div class={`wf-card wf-action${problems ? ' has-error' : ''}${highlight.has(node.key) ? ' hot' : ''}`}>
      <button type="button" class="wf-card-main" onClick={() => onEdit(node.key)}>
        <span class={`wf-icon tone-${tone}`}><Svg name={spec?.icon ?? 'bolt'} /></span>
        <span class="wf-card-text">
          <strong>{node.label || spec?.label || node.type}</strong>
          <span class="text-sm text-muted">{describeNode(node, cat, def)}</span>
          {problems && <span class="wf-error-text">{problems[0]}</span>}
        </span>
      </button>
      {!readOnly && (
        <button type="button" class="wf-card-del" aria-label="Delete step" title="Delete" onClick={() => onRemove(node.key)}>
          <Svg name="trash" size={14} />
        </button>
      )}
    </div>
  );
}
