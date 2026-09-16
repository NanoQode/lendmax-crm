/**
 * Tasks.
 *
 * The list of what somebody has promised to do, and the form that makes one.
 *
 * The one thing on this screen that is not obvious: when an admin picks a
 * client, the "Assigned to" field fills itself in and cannot be typed into.
 * That is not the form being unhelpful — whose task it is follows from whose
 * client it is, and showing the answer before the task is made is the point.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { del, get, patch, post, formatDateTime, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, useRoute, type Session } from '../lib/store.ts';
import {
  DataTable, emptyQuery, queryToParams, type Column, type TableQuery,
} from '../components/data-table.tsx';
import {
  Badge, Empty, ErrorNote, Field, Icon, ICONS, Modal, SearchSelect, Skeleton,
  type SelectOption,
} from '../components/ui.tsx';

// ── What the server sends ──────────────────────────────────────────────────

export type Task = {
  id: string;
  title: string;
  description: string | null;
  category: string; category_label: string;
  priority: string; priority_label: string;
  status: string; status_label: string;
  open: boolean;
  due_on: string | null;
  due_time: string | null;
  due_at: string | null;
  due_label: string | null;
  timezone: string;
  bucket: 'overdue' | 'today' | 'tomorrow' | 'this_week' | 'later' | 'someday';
  overdue: boolean;
  reminder_minutes: number | null;
  reminder_sent: boolean;
  completed_at: string | null;
  completed_by_name: string | null;
  cancelled_reason: string | null;
  created_at: string;
  created_by_name: string | null;
  source_kind: string;
  application_id: string | null;
  customer_id: string | null;
  client_name: string | null;
  portal_reference: string | null;
  stage_label: string | null;
  pipeline_name: string | null;
  owner: { id: string; name: string; email: string | null } | null;
  mine: boolean;
  can_manage: boolean;
};

type ClientFile = {
  id: string; name: string; email: string | null; reference: string | null;
  stage_label: string | null; pipeline_name: string | null; settled: boolean; open_tasks: number;
  owner: { id: string; name: string; role: string | null } | null;
};

type Meta = {
  categories: ReadonlyArray<{ key: string; label: string }>;
  priorities: ReadonlyArray<{ key: string; label: string }>;
  statuses: ReadonlyArray<{ key: string; label: string }>;
  reminder_choices: ReadonlyArray<{ key: string; label: string; minutes: number | null }>;
  buckets: ReadonlyArray<{ key: string; label: string }>;
  default_reminder_minutes: number;
  timezone: string;
  can_manage_all: boolean;
  view_all: boolean;
};

type ListPayload = {
  tasks: Task[];
  total: number;
  tabs: Record<string, number>;
  timezone: string;
};

const TABS = [
  { key: 'open', label: 'To do' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'completed', label: 'Done' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
] as const;

const BUCKET_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'> = {
  overdue: 'danger', today: 'warn', tomorrow: 'info', this_week: 'neutral',
  later: 'neutral', someday: 'neutral',
};
const PRIORITY_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'> = {
  urgent: 'danger', high: 'warn', normal: 'neutral', low: 'neutral',
};

/** "Today at 4:30 p.m." reads better on a row than the full sentence. */
function shortWhen(task: Task): string {
  if (!task.due_on) return 'No date';
  const time = task.due_time
    ? new Date(task.due_at!).toLocaleTimeString('en-CA', {
        hour: 'numeric', minute: '2-digit', timeZone: task.timezone })
    : null;
  const label = { overdue: null, today: 'Today', tomorrow: 'Tomorrow' }[task.bucket as string]
    ?? new Date(`${task.due_on}T12:00:00Z`).toLocaleDateString('en-CA',
      { weekday: 'short', day: 'numeric', month: 'short' });
  if (label) return time ? `${label} at ${time}` : label;
  // Overdue says how late, which is the thing somebody needs to know.
  return `${relativeTime(task.due_at ?? `${task.due_on}T23:59:59`)}`;
}

// ── The screen ─────────────────────────────────────────────────────────────

export function TasksPage({ session }: { session: Session }) {
  const route = useRoute();
  const [tab, setTab] = useState<string>(route.query.get('tab') ?? 'open');
  const [query, setQuery] = useState<TableQuery>(() => emptyQuery({ sort: 'when', dir: 'asc' }));
  const [editing, setEditing] = useState<Partial<Task> | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const meta = useAsync<Meta>('/tasks/meta');
  const m = meta.status === 'ready' ? meta.data : null;
  const canManage = session.permissions.includes('task.manage')
    || session.permissions.includes('task.manage_all');

  const columns = useMemo<Column<Task>[]>(() => [
    {
      key: 'title', header: 'Task', primary: true, sortable: true, sortKey: 'title',
      render: (t) => (
        <div>
          <div class="cell-strong">{t.title}</div>
          {t.description && <div class="text-sm text-muted cell-clip">{t.description}</div>}
        </div>
      ),
    },
    {
      key: 'when', header: 'When', sortable: true, sortKey: 'due', param: 'bucket',
      filter: { options: (m?.buckets ?? []).map((b) => ({ value: b.key, label: b.label })) },
      value: (t) => t.due_at ?? t.due_on ?? '',
      render: (t) => (
        <span class={`task-when${t.overdue ? ' text-danger' : ''}`}>
          {shortWhen(t)}
          {t.due_time && t.reminder_minutes !== null && t.open && (
            <span class="text-sm text-muted" title={`Reminder ${t.reminder_minutes} minutes before`}>
              {' '}· 🔔
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'client', header: 'Client', sortable: true, sortKey: 'client', filter: false,
      render: (t) => (t.client_name
        ? (
          <button class="link-button" onClick={(e) => {
            e.stopPropagation();
            if (t.application_id) navigate(`/applications/${t.application_id}`);
          }}>{t.client_name}</button>
        )
        : <span class="text-muted">—</span>),
    },
    {
      key: 'owner', header: 'Assigned to', sortable: true, sortKey: 'owner', param: 'owner',
      filter: m?.view_all ? { options: [{ value: 'me', label: 'Me' }] } : false,
      render: (t) => (t.owner
        ? <span class={t.mine ? '' : 'text-muted'}>{t.mine ? 'You' : t.owner.name}</span>
        : <span class="text-muted">Unassigned</span>),
    },
    {
      key: 'priority', header: 'Priority', param: 'priority', sortable: true, sortKey: 'priority',
      filter: { options: (m?.priorities ?? []).map((p) => ({ value: p.key, label: p.label })) },
      render: (t) => (t.priority === 'normal'
        ? <span class="text-muted">—</span>
        : <Badge tone={PRIORITY_TONE[t.priority] ?? 'neutral'}>{t.priority_label}</Badge>),
    },
    {
      key: 'category', header: 'Type', param: 'category', filter:
        { options: (m?.categories ?? []).map((c) => ({ value: c.key, label: c.label })) },
      render: (t) => <span class="text-sm">{t.category_label}</span>,
    },
    {
      key: 'status', header: 'Status', param: 'status', sortable: true, sortKey: 'status',
      filter: { options: (m?.statuses ?? []).map((s) => ({ value: s.key, label: s.label })) },
      render: (t) => <Badge tone={t.status === 'completed' ? 'ok' : t.open ? 'info' : 'neutral'}>
        {t.status_label}
      </Badge>,
    },
    {
      key: 'done', header: '', filter: false, width: '46px',
      render: (t) => (t.open && t.can_manage
        ? (
          <input type="checkbox" style={{ width: 16 }} aria-label={`Complete ${t.title}`}
                 onClick={(e) => e.stopPropagation()}
                 onChange={() => void complete(t)} />
        )
        : null),
    },
  ], [m]);

  const params = queryToParams(query, columns, { tab });
  const list = useAsync<ListPayload>(`/tasks?${params.toString()}`, [nonce]);
  const data = list.status === 'ready' ? list.data : null;
  const reload = () => setNonce((n) => n + 1);

  const switchTab = (next: string) => {
    setTab(next);
    setQuery({ ...query, page: 1 });
    navigate(next === 'open' ? '/tasks' : `/tasks?tab=${next}`, true);
  };

  const complete = async (task: Task) => {
    try {
      await post(`/tasks/${task.id}/complete`);
      toast(`“${task.title}” done.`, 'ok');
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not complete that task.', 'error');
      reload();
    }
  };

  return (
    <div>
      <div class="page-head">
        <div>
          <h1>Tasks</h1>
          <p>
            What you have promised to do, soonest first.
            {m?.can_manage_all ? ' A task on somebody’s client goes to whoever that client belongs to.' : ''}
          </p>
        </div>
        {canManage && (
          <button class="btn btn-primary" onClick={() => setEditing({})}>
            <Icon path={ICONS.plus} /> New task
          </button>
        )}
      </div>

      <div class="purpose-tabs" role="tablist" aria-label="Tasks">
        {TABS.map((t) => (
          <button key={t.key} class="purpose-tab" role="tab" aria-selected={tab === t.key}
                  onClick={() => switchTab(t.key)}>
            {t.label}{' '}
            <span class={`n${t.key === 'overdue' && (data?.tabs.overdue ?? 0) > 0 ? ' n-warn' : ''}`}>
              {data?.tabs[t.key] ?? '·'}
            </span>
          </button>
        ))}
      </div>

      <div class="card">
        {list.status === 'error' && !data ? (
          <div style={{ padding: 15 }}>
            <ErrorNote error={list.error} code={list.code} permission={list.permission}
                       onRetry={list.reload} />
          </div>
        ) : (
          <DataTable<Task>
            label="Tasks"
            columns={columns}
            rows={data?.tasks ?? []}
            total={data?.total ?? 0}
            rowKey={(t) => t.id}
            query={query}
            onQueryChange={setQuery}
            loading={list.status === 'loading'}
            initialSort={{ key: 'when', dir: 'asc' }}
            searchPlaceholder="Task, client or reference…"
            onRowClick={(t) => setOpenId(t.id)}
            rowClass={(t) => (t.overdue ? 'row-attention' : !t.open ? 'row-dim' : '')}
            empty={
              <Empty title={tab === 'open' ? 'Nothing to do' : 'Nothing here'}
                     action={canManage && tab === 'open'
                       ? <button class="btn btn-primary" onClick={() => setEditing({})}>New task</button>
                       : undefined}>
                {tab === 'open'
                  ? 'Tasks you create — and any an admin creates for you — appear here, with a reminder before each one starts.'
                  : 'Tasks appear here as they are worked through.'}
              </Empty>
            }
          />
        )}
      </div>

      {editing && m && (
        <TaskForm meta={m} initial={editing} session={session}
                  onClose={() => setEditing(null)}
                  onSaved={() => { setEditing(null); reload(); }} />
      )}
      {openId && m && (
        <TaskDetail id={openId} meta={m} onClose={() => setOpenId(null)}
                    onChanged={reload}
                    onEdit={(task) => { setOpenId(null); setEditing(task); }} />
      )}
    </div>
  );
}

// ── One task ───────────────────────────────────────────────────────────────

function TaskDetail({ id, meta, onClose, onChanged, onEdit }: {
  id: string; meta: Meta; onClose: () => void; onChanged: () => void;
  onEdit: (task: Task) => void;
}) {
  const state = useAsync<{ task: Task }>(`/tasks/${id}`);
  const task = state.status === 'ready' ? state.data.task : null;
  const [busy, setBusy] = useState(false);

  const change = async (body: Record<string, unknown>, said: string) => {
    setBusy(true);
    try {
      await patch(`/tasks/${id}`, body);
      toast(said, 'ok');
      onChanged();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change that task.', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal title={task?.title ?? 'Task'} onClose={onClose} footer={
      task && task.can_manage ? (
        <>
          <button class="btn" onClick={() => onEdit(task)}>Edit</button>
          {task.open ? (
            <>
              <button class="btn" disabled={busy}
                      onClick={() => change({ status: 'cancelled' }, 'Task cancelled.')}>
                Cancel task
              </button>
              <button class="btn btn-primary" disabled={busy}
                      onClick={() => change({ status: 'completed' }, 'Task done.')}>
                Mark done
              </button>
            </>
          ) : (
            <button class="btn btn-primary" disabled={busy}
                    onClick={() => change({ status: 'open' }, 'Task reopened.')}>
              Reopen
            </button>
          )}
        </>
      ) : <button class="btn" onClick={onClose}>Close</button>
    }>
      {state.status === 'loading' && <Skeleton rows={4} />}
      {state.status === 'error' && <ErrorNote error={state.error} code={state.code} />}
      {task && (
        <>
          <div class="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            <Badge tone={task.status === 'completed' ? 'ok' : task.open ? 'info' : 'neutral'}>
              {task.status_label}
            </Badge>
            {task.overdue && <Badge tone="danger">Overdue</Badge>}
            {task.priority !== 'normal' && (
              <Badge tone={PRIORITY_TONE[task.priority] ?? 'neutral'}>{task.priority_label}</Badge>
            )}
            <Badge>{task.category_label}</Badge>
            {task.source_kind === 'automation' && <Badge tone="accent">From an automation</Badge>}
          </div>

          {task.description && <p style={{ whiteSpace: 'pre-wrap' }}>{task.description}</p>}

          <dl class="detail-list">
            <dt>When</dt>
            <dd>
              {task.due_label ?? 'No date — it sits under “No date” until you give it one'}
              {task.due_time && task.reminder_minutes !== null && (
                <div class="text-sm text-muted">
                  {task.reminder_sent
                    ? 'Reminder sent'
                    : `Reminder ${task.reminder_minutes === 0 ? 'when it starts'
                        : `${task.reminder_minutes} minutes before`}`}
                </div>
              )}
            </dd>
            <dt>Assigned to</dt>
            <dd>{task.mine ? `You${task.owner ? ` (${task.owner.name})` : ''}` : task.owner?.name ?? 'Nobody'}</dd>
            {task.client_name && (
              <>
                <dt>Client</dt>
                <dd>
                  <button class="link-button" onClick={() => {
                    if (task.application_id) navigate(`/applications/${task.application_id}`);
                  }}>{task.client_name}</button>
                  {task.stage_label && <span class="text-sm text-muted"> · {task.stage_label}</span>}
                  {task.portal_reference && <div class="text-sm text-muted">{task.portal_reference}</div>}
                </dd>
              </>
            )}
            <dt>Created</dt>
            <dd>
              {formatDateTime(task.created_at)}
              {task.created_by_name && !task.mine ? ` by ${task.created_by_name}` : ''}
              {task.created_by_name && task.mine && task.created_by_name !== task.owner?.name
                ? ` by ${task.created_by_name}` : ''}
            </dd>
            {task.completed_at && (
              <>
                <dt>Done</dt>
                <dd>{formatDateTime(task.completed_at)}
                  {task.completed_by_name ? ` by ${task.completed_by_name}` : ''}</dd>
              </>
            )}
          </dl>
        </>
      )}
    </Modal>
  );
}

// ── Making one ─────────────────────────────────────────────────────────────

export function TaskForm({ meta, initial, session, fixedApplicationId, onClose, onSaved }: {
  meta: Meta; initial: Partial<Task>; session: Session;
  /** Set when the form is opened from a client file: the client is not a choice. */
  fixedApplicationId?: string | null;
  onClose: () => void; onSaved: (task: Task) => void;
}) {
  const editing = !!initial.id;
  const [form, setForm] = useState({
    title: initial.title ?? '',
    description: initial.description ?? '',
    application_id: initial.application_id ?? fixedApplicationId ?? '',
    category: initial.category ?? 'follow_up',
    priority: initial.priority ?? 'normal',
    due_on: initial.due_on ?? '',
    due_time: initial.due_time ?? '',
    reminder: String(initial.reminder_minutes ?? meta.default_reminder_minutes),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  // The client list: their own files, or every file for somebody who makes
  // work for other people. Fetched once and filtered in the dropdown — a
  // brokerage's open files are hundreds, not thousands, and a request per
  // keystroke buys nothing at that size.
  const files = useAsync<{ files: ClientFile[] }>(fixedApplicationId ? null : '/tasks/files');
  const fileList = files.status === 'ready' ? files.data.files : [];

  /**
   * Whose task this will be.
   *
   * Asked of the server rather than worked out here, so the field cannot drift
   * from the rule that decides it. It appears the moment a client is chosen,
   * and it is read-only because the answer is not the admin's to pick.
   */
  const [owner, setOwner] = useState<{ name: string; note: string | null } | null>(null);
  useEffect(() => {
    if (!form.application_id) { setOwner(null); return; }
    let cancelled = false;
    get<{ owner: { name: string }; note: string | null }>(
      `/tasks/owner?application_id=${form.application_id}`)
      .then((d) => { if (!cancelled) setOwner({ name: d.owner.name, note: d.note }); })
      .catch(() => { if (!cancelled) setOwner(null); });
    return () => { cancelled = true; };
  }, [form.application_id]);

  const fileOptions: SelectOption[] = [
    { value: '', label: 'No client — a note to yourself' },
    ...fileList.map((f) => ({
      value: f.id,
      label: f.name,
      // The owner's name is in the hint as well as in the read-only field
      // below, so an admin scanning the list can see whose work each one is
      // before they pick.
      hint: [f.reference, f.stage_label, f.owner ? `· ${f.owner.name}` : null]
        .filter(Boolean).join(' · ') || undefined,
    })),
  ];

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const body = {
      title: form.title,
      description: form.description || undefined,
      application_id: form.application_id || null,
      category: form.category,
      priority: form.priority,
      due_on: form.due_on || null,
      due_time: form.due_time || null,
      reminder_minutes: form.due_time
        ? (form.reminder === 'none' ? null : Number(form.reminder))
        : null,
    };
    try {
      const saved = editing
        ? await patch<{ task: Task }>(`/tasks/${initial.id}`, body)
        : await post<{ task: Task }>('/tasks', body);
      toast(editing ? 'Task saved.' : 'Task created.', 'ok');
      onSaved(saved.task);
    } catch (err) {
      const e2 = err as { fields?: Array<{ field: string; message: string }>; message?: string };
      if (e2.fields?.length) {
        setErrors(Object.fromEntries(e2.fields.map((f) => [f.field, f.message])));
      } else {
        setErrors({ _: e2.message ?? 'Could not save that task.' });
      }
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? 'Edit task' : 'New task'} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" form="task-form" disabled={busy || !form.title.trim()}>
          {busy ? 'Saving…' : editing ? 'Save task' : 'Create task'}
        </button>
      </>
    }>
      <form id="task-form" onSubmit={submit}>
        {errors._ && <div class="alert alert-error">{errors._}</div>}

        <Field label="What needs doing" error={errors.title}>
          <input value={form.title} autofocus required maxLength={160}
                 placeholder="Call the customer about the rate hold"
                 onInput={(e) => set('title', (e.target as HTMLInputElement).value)} />
        </Field>

        <Field label="Notes" hint="Anything you will want in front of you when you start.">
          <textarea rows={3} value={form.description}
                    onInput={(e) => set('description', (e.target as HTMLTextAreaElement).value)} />
        </Field>

        {!fixedApplicationId && (
          <Field label="Client" error={errors.application_id}
                 hint={meta.can_manage_all
                   ? 'Every file, with whoever it belongs to.'
                   : 'The files assigned to you.'}>
            <SearchSelect
              value={form.application_id}
              options={fileOptions}
              onChange={(v) => set('application_id', v)}
              ariaLabel="Client"
              placeholder={files.status === 'loading' ? 'Loading your files…' : 'No client — a note to yourself'}
              searchPlaceholder="Search clients…"
            />
          </Field>
        )}

        {/*
          The read-only answer to "whose task is this". It appears only once a
          client is chosen, because before that there is nothing to say.
        */}
        {owner && (
          <Field label="Assigned to">
            <input value={owner.name} readOnly disabled class="static-field" aria-readonly="true" />
            {owner.note && <div class="text-sm text-muted" style={{ marginTop: 4 }}>{owner.note}</div>}
          </Field>
        )}

        <div class="grid-2">
          <Field label="Date" error={errors.due_on}>
            <input type="date" value={form.due_on}
                   onInput={(e) => set('due_on', (e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Time" error={errors.due_time}
                 hint={form.due_time ? undefined : 'Leave empty for a whole-day task.'}>
            <input type="time" value={form.due_time} disabled={!form.due_on}
                   onInput={(e) => set('due_time', (e.target as HTMLInputElement).value)} />
          </Field>
        </div>

        {form.due_time && (
          <Field label="Remind me" hint={`Sent to whoever the task belongs to, in ${meta.timezone}.`}>
            <SearchSelect
              value={form.reminder}
              options={meta.reminder_choices.map((c) => ({
                value: c.minutes === null ? 'none' : String(c.minutes), label: c.label,
              }))}
              onChange={(v) => set('reminder', v)}
              ariaLabel="Reminder"
            />
          </Field>
        )}

        <div class="grid-2">
          <Field label="Type">
            <SearchSelect value={form.category} ariaLabel="Type"
                          options={meta.categories.map((c) => ({ value: c.key, label: c.label }))}
                          onChange={(v) => set('category', v)} />
          </Field>
          <Field label="Priority">
            <SearchSelect value={form.priority} ariaLabel="Priority"
                          options={meta.priorities.map((p) => ({ value: p.key, label: p.label }))}
                          onChange={(v) => set('priority', v)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

// ── The tab on a client file ───────────────────────────────────────────────

/** The same list and the same form, narrowed to one file. */
export function FileTasks({ applicationId, session }: {
  applicationId: string; session: Session;
}) {
  const [nonce, setNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const meta = useAsync<Meta>('/tasks/meta');
  const m = meta.status === 'ready' ? meta.data : null;
  const list = useAsync<ListPayload>(
    `/tasks?application_id=${applicationId}&tab=all&page_size=100&sort=due`, [nonce]);
  const tasks = list.status === 'ready' ? list.data.tasks : [];
  const canManage = session.permissions.includes('task.manage')
    || session.permissions.includes('task.manage_all');

  const complete = async (task: Task) => {
    try {
      await post(`/tasks/${task.id}/complete`);
      toast(`“${task.title}” done.`, 'ok');
      setNonce((n) => n + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not complete that task.', 'error');
    }
  };

  return (
    <div class="card">
      <div class="card-head">
        <div>
          <h2>Tasks</h2>
          <p class="text-sm text-muted mb-0">Work promised on this file.</p>
        </div>
        {canManage && (
          <button class="btn btn-sm btn-primary" onClick={() => setCreating(true)}>New task</button>
        )}
      </div>
      {list.status === 'loading' && <div style={{ padding: 14 }}><Skeleton rows={3} /></div>}
      {list.status === 'error' && (
        <div style={{ padding: 14 }}>
          <ErrorNote error={list.error} code={list.code} permission={list.permission} />
        </div>
      )}
      {list.status === 'ready' && tasks.length === 0 && (
        <Empty title="Nothing on this file">
          A task here is a promise about this client — a call to make, a document to chase.
        </Empty>
      )}
      {tasks.map((t) => (
        <div key={t.id} class="row" style={{ padding: '10px 15px', borderBottom: '1px solid var(--border)' }}>
          {t.open && t.can_manage && (
            <input type="checkbox" style={{ width: 16, flex: '0 0 auto' }}
                   aria-label={`Complete ${t.title}`} onChange={() => void complete(t)} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div class={`cell-strong${t.open ? '' : ' text-muted'}`}>{t.title}</div>
            <div class="text-sm text-muted">
              {shortWhen(t)}
              {t.owner && ` · ${t.mine ? 'You' : t.owner.name}`}
              {t.category !== 'follow_up' && ` · ${t.category_label}`}
            </div>
          </div>
          {t.overdue && <Badge tone="danger">Overdue</Badge>}
          {!t.open && <Badge tone={t.status === 'completed' ? 'ok' : 'neutral'}>{t.status_label}</Badge>}
        </div>
      ))}

      {creating && m && (
        <TaskForm meta={m} initial={{}} session={session} fixedApplicationId={applicationId}
                  onClose={() => setCreating(false)}
                  onSaved={() => { setCreating(false); setNonce((n) => n + 1); }} />
      )}
    </div>
  );
}
