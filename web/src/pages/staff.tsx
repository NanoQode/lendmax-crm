/**
 * Staff.
 *
 * Who works here, what each person can open, and who takes the next lead.
 *
 * Three switches that sound alike and are not:
 *   · Round robin (for everybody) — whether new leads are handed out at all.
 *   · Round robin (per person)    — whether this person takes a turn. Off still
 *                                   lets an admin hand them a lead by hand.
 *   · Active / inactive           — whether they can sign in and be given
 *                                   leads at all. Deactivating asks who takes
 *                                   over their open work, so nothing is left
 *                                   with somebody who can no longer see it.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { del, fieldErrors, patch, post, put, relativeTime } from '../lib/api.ts';
import { toast, useAsync, type Session } from '../lib/store.ts';
import { DataTable, recency } from '../components/data-table.tsx';
import {
  Avatar, Badge, Empty, ErrorNote, Field, Icon, ICONS, Modal, SearchSelect, Skeleton, Switch,
  type SelectOption,
} from '../components/ui.tsx';
import { SignatureEditor } from '../components/signature-editor.tsx';

// ── Types ──────────────────────────────────────────────────────────────────

type Status = 'invited' | 'active' | 'inactive' | 'deleted';

export type StaffMember = {
  id: string; first_name: string; last_name: string | null; name: string; email: string;
  role: string; role_name: string; status: Status; round_robin_enabled: boolean;
  mobile_phone: string | null; title: string | null;
  licence_number: string | null; licence_province: string | null;
  permissions: string[]; has_custom_permissions: boolean;
  open_leads: number; open_tasks: number;
  last_login_at: string | null; last_auto_assigned_at: string | null;
  invited_at: string | null; activated_at: string | null;
  invite_expires_at: string | null; created_at: string;
};

type ModuleSpec = {
  key: string; label: string; description: string;
  permissions: Array<{ id: string; label: string; api?: boolean }>;
};

type Meta = {
  roles: Array<{ key: string; name: string; description: string; permissions: string[] }>;
  modules: ModuleSpec[];
  provinces: string[];
  invitation_valid_hours: number;
};

type Invitation = { sent: boolean; provider: string; error?: string; expires_at: string; link?: string };

type AssignmentState = {
  round_robin_enabled: boolean;
  rotation: Array<{ id: string; name: string; last_auto_assigned_at: string | null }>;
  next_up: { id: string; name: string } | null;
};

// ── The page ───────────────────────────────────────────────────────────────

const statusLabel = (p: StaffMember) =>
  p.status === 'invited' && p.invite_expires_at && new Date(p.invite_expires_at).getTime() < Date.now()
    ? 'Invite expired'
    : { active: 'Active', invited: 'Invited', inactive: 'Inactive', deleted: 'Deleted' }[p.status];

export function StaffPage({ session }: { session: Session }) {
  // Deleted staff are fetched only when asked for; everything else is
  // searched, filtered and sorted in the table.
  const [showDeleted, setShowDeleted] = useState(false);
  const meta = useAsync<Meta>('/staff/meta');
  const list = useAsync<{ staff: StaffMember[]; can_manage: boolean }>(
    `/staff?status=${showDeleted ? 'deleted' : 'all'}`, [showDeleted]);
  const [editing, setEditing] = useState<StaffMember | 'new' | null>(null);
  const [ending, setEnding] = useState<{ person: StaffMember; mode: 'deactivate' | 'delete' } | null>(null);
  const [invitation, setInvitation] = useState<{ person: string; email: string; result: Invitation } | null>(null);
  const [assignmentNonce, setAssignmentNonce] = useState(0);

  const canManage = list.status === 'ready' ? list.data.can_manage : session.permissions.includes('user.manage');
  const refresh = () => { list.reload(); setAssignmentNonce((n) => n + 1); };

  const toggleRoundRobin = async (person: StaffMember, next: boolean) => {
    try {
      await patch(`/staff/${person.id}`, { round_robin_enabled: next });
      toast(`${person.name} ${next ? 'now takes' : 'no longer takes'} a turn in round robin.`, 'ok');
      refresh();
    } catch (err) {
      const errors = fieldErrors(err, 'Could not change that.');
      toast(errors._ ?? Object.values(errors)[0] ?? 'Could not change that.', 'error');
    }
  };

  const reactivate = async (person: StaffMember) => {
    try {
      await post(`/staff/${person.id}/reactivate`);
      toast(`${person.name} is active again.`, 'ok');
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not reactivate them.', 'error');
    }
  };

  const resend = async (person: StaffMember) => {
    try {
      const { invitation: result } = await post<{ invitation: Invitation }>(`/staff/${person.id}/resend-invite`);
      setInvitation({ person: person.name, email: person.email, result });
      list.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send a new invitation.', 'error');
    }
  };

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Staff</h1>
          <p>Add people, choose what each of them can open, and decide who takes the next lead.</p>
        </div>
        {canManage && (
          <button class="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon path={ICONS.plus} /> Add staff
          </button>
        )}
      </div>

      <RoundRobinCard canManage={canManage} nonce={assignmentNonce} />

      <div class="card">
        {list.status === 'error' ? (
          <div style={{ padding: 15 }}>
            <ErrorNote error={list.error} code={list.code} permission={list.permission} onRetry={list.reload} />
          </div>
        ) : (
          <DataTable<StaffMember>
            label="Staff"
            rows={list.status === 'ready' ? list.data.staff : []}
            loading={list.status === 'loading'}
            rowKey={(p) => p.id}
            initialSort={{ key: 'name', dir: 'asc' }}
            searchPlaceholder="Search by name, email or role…"
            onRowClick={canManage && !showDeleted ? (p) => setEditing(p) : undefined}
            toolbar={
              <label class="check" style={{ margin: 0 }}>
                <input type="checkbox" checked={showDeleted}
                       onChange={(e) => setShowDeleted((e.target as HTMLInputElement).checked)} />
                <span class="text-sm">Show deleted staff</span>
              </label>
            }
            empty={
              <Empty title={showDeleted ? 'Nobody has been deleted' : 'No staff yet'}
                     action={canManage && !showDeleted
                       ? <button class="btn btn-primary" onClick={() => setEditing('new')}>Add staff</button>
                       : undefined}>
                {showDeleted ? undefined : 'Add the first person and they will get an email to activate their account.'}
              </Empty>
            }
            columns={[
              {
                key: 'name', header: 'Name', primary: true, value: (p) => p.name,
                render: (p) => (
                  <div class="row" style={{ gap: 10 }}>
                    <Avatar name={p.name} />
                    <div style={{ minWidth: 0 }}>
                      <div class="cell-strong">
                        {p.name}
                        {p.id === session.user.id && <span class="text-sm text-muted"> · you</span>}
                      </div>
                    </div>
                  </div>
                ),
              },
              { key: 'email', header: 'Email', value: (p) => p.email, render: (p) => <span class="text-sm">{p.email}</span> },
              {
                key: 'role', header: 'Role', filter: 'auto', value: (p) => p.role_name,
                render: (p) => (
                  <>
                    {p.role_name}
                    {p.has_custom_permissions && <span class="text-sm text-muted d-block">custom permissions</span>}
                  </>
                ),
              },
              {
                key: 'status', header: 'Status', filter: 'auto', value: statusLabel,
                render: (p) => <StatusBadge person={p} />,
              },
              {
                key: 'round_robin', header: 'Round robin', filter: 'auto',
                value: (p) => (p.round_robin_enabled ? 'On' : 'Off'),
                render: (p) => p.status === 'deleted' ? <span class="text-muted">—</span> : (
                  <span class="row" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
                    <Switch checked={p.round_robin_enabled} disabled={!canManage}
                            label={`Round robin for ${p.name}`}
                            onChange={(next) => toggleRoundRobin(p, next)} />
                    <span class="text-sm text-muted">
                      {!p.round_robin_enabled ? 'Off'
                        : p.status === 'active' ? 'In rotation'
                        : p.status === 'invited' ? 'After activation' : 'Paused while inactive'}
                    </span>
                  </span>
                ),
              },
              {
                key: 'open_leads', header: 'Open leads', filter: 'number', align: 'right', value: (p) => p.open_leads,
                render: (p) => (
                  <>
                    {p.open_leads}
                    {p.open_tasks > 0 && <span class="text-sm text-muted"> · {p.open_tasks} task{p.open_tasks === 1 ? '' : 's'}</span>}
                  </>
                ),
              },
              {
                key: 'last_login_at', header: 'Last sign-in', filter: 'auto',
                value: (p) => p.last_login_at, filterValue: (p) => recency(p.last_login_at),
                render: (p) => <span class="cell-muted">{p.last_login_at ? relativeTime(p.last_login_at) : 'Never'}</span>,
              },
              {
                key: 'actions', header: '', sortable: false, filter: false, searchable: false,
                render: (p) => (
                  <span onClick={(e) => e.stopPropagation()}>
                    {canManage && p.status !== 'deleted' && (
                      <RowMenu person={p} isSelf={p.id === session.user.id}
                               onEdit={() => setEditing(p)}
                               onResend={() => resend(p)}
                               onReactivate={() => reactivate(p)}
                               onDeactivate={() => setEnding({ person: p, mode: 'deactivate' })}
                               onDelete={() => setEnding({ person: p, mode: 'delete' })} />
                    )}
                  </span>
                ),
              },
            ]}
          />
        )}
      </div>

      {editing && meta.status === 'ready' && (
        <StaffForm meta={meta.data} person={editing === 'new' ? null : editing} isSelf={editing !== 'new' && editing.id === session.user.id}
                   onClose={() => setEditing(null)}
                   onDeactivate={(p) => { setEditing(null); setEnding({ person: p, mode: 'deactivate' }); }}
                   onReactivate={(p) => { setEditing(null); void reactivate(p); }}
                   onResend={(p) => { setEditing(null); void resend(p); }}
                   onSaved={(result) => {
                     setEditing(null);
                     refresh();
                     if (result.invitation) setInvitation({ person: result.staff.name, email: result.staff.email, result: result.invitation });
                     else toast(`${result.staff.name} saved.`, 'ok');
                   }} />
      )}
      {editing && meta.status === 'error' && (
        <Modal title="Staff" onClose={() => setEditing(null)}>
          <ErrorNote error={meta.error} code={meta.code} onRetry={meta.reload} />
        </Modal>
      )}

      {ending && (
        <HandoverModal person={ending.person} mode={ending.mode}
                       onClose={() => setEnding(null)}
                       onDone={(message) => { setEnding(null); toast(message, 'ok'); refresh(); }} />
      )}

      {invitation && (
        <InvitationResult {...invitation} hours={meta.status === 'ready' ? meta.data.invitation_valid_hours : 72}
                          onClose={() => setInvitation(null)} />
      )}
    </div>
  );
}

function StatusBadge({ person }: { person: StaffMember }) {
  if (person.status === 'active') return <Badge tone="ok">Active</Badge>;
  if (person.status === 'inactive') return <Badge>Inactive</Badge>;
  if (person.status === 'deleted') return <Badge tone="danger">Deleted</Badge>;
  const expired = person.invite_expires_at && new Date(person.invite_expires_at).getTime() < Date.now();
  return expired
    ? <Badge tone="warn">Invite expired</Badge>
    : <Badge tone="info">Invited</Badge>;
}

function RowMenu({ person, isSelf, onEdit, onResend, onReactivate, onDeactivate, onDelete }: {
  person: StaffMember; isSelf: boolean;
  onEdit: () => void; onResend: () => void; onReactivate: () => void;
  onDeactivate: () => void; onDelete: () => void;
}) {
  // Fixed rather than absolute: the table scrolls sideways on narrow screens,
  // and a menu inside a scrolling box is cut off at its edge.
  const [at, setAt] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const open = at !== null;
  const run = (fn: () => void) => () => { setAt(null); fn(); };
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    // Opens upwards near the bottom of the window, where there is no room
    // for it below.
    const room = window.innerHeight - r.bottom;
    setAt(room < 200
      ? { bottom: window.innerHeight - r.top + 4, right: window.innerWidth - r.right }
      : { top: r.bottom + 4, right: window.innerWidth - r.right });
  };
  useEffect(() => {
    if (!open) return;
    // Follows its button when the page scrolls, rather than closing — a
    // menu that vanishes on the slightest scroll loses the click.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);
  return (
    <div class="row-menu">
      <button ref={button} class="btn btn-ghost btn-sm" aria-haspopup="menu" aria-expanded={open}
              aria-label={`Actions for ${person.name}`}
              onClick={() => (open ? setAt(null) : place())}
              onKeyDown={(e) => { if (e.key === 'Escape') setAt(null); }}
              onBlur={(e) => {
                if (!(e.currentTarget.parentElement?.contains(e.relatedTarget as Node))) setAt(null);
              }}>
        <Icon path={ICONS.more} />
      </button>
      {open && (
        <div class="menu" role="menu"
             style={{ position: 'fixed', top: at.top ?? 'auto', bottom: at.bottom ?? 'auto', right: at.right }}>
          <button class="menu-item" role="menuitem" onClick={run(onEdit)}>Edit details & permissions</button>
          {person.status === 'invited' && (
            <button class="menu-item" role="menuitem" onClick={run(onResend)}>Send a new activation link</button>
          )}
          {person.status === 'inactive' && (
            <button class="menu-item" role="menuitem" onClick={run(onReactivate)}>Reactivate</button>
          )}
          {!isSelf && person.status !== 'inactive' && (
            <button class="menu-item" role="menuitem" onClick={run(onDeactivate)}>Deactivate…</button>
          )}
          {!isSelf && (
            <>
              <div class="menu-sep" />
              <button class="menu-item menu-danger" role="menuitem" onClick={run(onDelete)}>Delete…</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Round robin, for the whole brokerage ───────────────────────────────────

function RoundRobinCard({ canManage, nonce }: { canManage: boolean; nonce: number }) {
  const state = useAsync<AssignmentState>('/staff/assignment', [nonce]);
  const [busy, setBusy] = useState(false);

  if (state.status !== 'ready') return null;
  const d = state.data;

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      await put('/staff/assignment', { round_robin_enabled: next });
      toast(next ? 'Round robin is on. New leads are shared out in turn.' : 'Round robin is off. New leads will wait, unassigned, for somebody to hand them out.', 'ok');
      state.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change that.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="card rr-card" style={{ marginBottom: 14 }}>
      <div class="card-body rr-body">
        <div class="rr-text">
          <div class="row" style={{ gap: 10 }}>
            <Switch checked={d.round_robin_enabled} disabled={!canManage || busy}
                    label="Round robin assignment of new leads" onChange={toggle} />
            <strong>Round robin {d.round_robin_enabled ? 'is on' : 'is off'}</strong>
          </div>
          <p class="text-sm text-muted" style={{ margin: '6px 0 0' }}>
            {d.round_robin_enabled
              ? 'Every new lead — from the application portal, a connected website or typed in here — goes to the next person in turn. Only active staff with round robin switched on take a turn.'
              : 'New leads arrive unassigned and wait on the dashboard for somebody to hand them out. Staff can still be assigned leads by hand.'}
          </p>
        </div>
        {d.round_robin_enabled && (
          <div class="rr-queue" aria-label="Who takes the next leads, in order">
            {d.rotation.length === 0 ? (
              <div class="alert alert-warn mb-0">
                Nobody is in the rotation yet, so new leads will arrive unassigned. Switch round robin on for at
                least one active staff member below.
              </div>
            ) : (
              <>
                <div class="text-sm text-muted" style={{ marginBottom: 6 }}>Next leads go to</div>
                <ol class="rr-list">
                  {d.rotation.slice(0, 5).map((p, i) => (
                    <li key={p.id}>
                      <Avatar name={p.name} />
                      <span>{p.name}</span>
                      {i === 0 && <Badge tone="accent">Next</Badge>}
                    </li>
                  ))}
                  {d.rotation.length > 5 && <li class="text-sm text-muted">+{d.rotation.length - 5} more</li>}
                </ol>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Add / edit ─────────────────────────────────────────────────────────────

type FormState = {
  first_name: string; last_name: string; email: string; mobile_phone: string;
  role: string; title: string; licence_number: string; licence_province: string;
  round_robin_enabled: boolean;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME = /^\p{L}[\p{L}\p{M}' .-]*$/u;

/**
 * The checks the server will make, made first so the person hears about all
 * of them at once rather than one per round trip. The server still decides.
 */
function validate(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = (key: 'first_name' | 'last_name', label: string) => {
    const v = form[key].trim();
    if (!v) errors[key] = `${label} is required.`;
    else if (v.length > 60) errors[key] = `${label} can be at most 60 characters.`;
    else if (!NAME.test(v)) errors[key] = `${label} can contain letters, spaces, hyphens and apostrophes.`;
  };
  name('first_name', 'First name');
  name('last_name', 'Last name');
  if (!form.email.trim()) errors.email = 'Email is required.';
  else if (!EMAIL.test(form.email.trim())) errors.email = 'Enter a valid email address.';
  const digits = form.mobile_phone.replace(/\D/g, '');
  if (!form.mobile_phone.trim()) errors.mobile_phone = 'A mobile number is required.';
  else if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) {
    errors.mobile_phone = 'Enter a 10-digit Canadian number, e.g. (416) 555-0142.';
  }
  if (!form.role) errors.role = 'Choose a role.';
  if (form.role === 'broker' && !form.licence_number.trim()) {
    errors.licence_number = 'A broker needs their mortgage licence number on file.';
  }
  if (form.licence_number.trim() && !/^[A-Za-z0-9-]+$/.test(form.licence_number.trim())) {
    errors.licence_number = 'A licence number is letters, numbers and hyphens.';
  }
  if (form.licence_number.trim() && !form.licence_province) {
    errors.licence_province = 'Choose the province that issued the licence.';
  }
  if (form.title.length > 80) errors.title = 'Title can be at most 80 characters.';
  return errors;
}

function StaffForm({ meta, person, isSelf, onClose, onSaved, onDeactivate, onReactivate, onResend }: {
  meta: Meta; person: StaffMember | null; isSelf: boolean;
  onClose: () => void;
  onSaved: (result: { staff: StaffMember; invitation?: Invitation }) => void;
  onDeactivate: (p: StaffMember) => void;
  onReactivate: (p: StaffMember) => void;
  onResend: (p: StaffMember) => void;
}) {
  const roleDefaults = (role: string) => meta.roles.find((r) => r.key === role)?.permissions ?? [];

  const [form, setForm] = useState<FormState>({
    first_name: person?.first_name ?? '',
    last_name: person?.last_name ?? '',
    email: person?.email ?? '',
    mobile_phone: person?.mobile_phone ? formatNational(person.mobile_phone) : '',
    role: person?.role ?? 'broker',
    title: person?.title ?? '',
    licence_number: person?.licence_number ?? '',
    licence_province: person?.licence_province ?? 'ON',
    round_robin_enabled: person?.round_robin_enabled ?? true,
  });
  const [permissions, setPermissions] = useState<Set<string>>(
    new Set(person?.permissions ?? roleDefaults('broker')));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingSignature, setEditingSignature] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    const next = { ...form, [key]: value };
    setForm(next);
    if (touched) setErrors(validate(next));
  };
  const input = (key: keyof FormState) => (e: Event) => set(key, (e.target as HTMLInputElement).value as never);

  const defaults = useMemo(() => new Set(roleDefaults(form.role)), [form.role]);
  const customised = permissions.size !== defaults.size || [...permissions].some((p) => !defaults.has(p));

  const changeRole = (role: string) => {
    // The role is the template. Changing it starts from the new role's
    // defaults, rather than carrying exceptions across from a different job.
    // A new broker rotates by default; a new underwriter or admin does not.
    const next = { ...form, role, round_robin_enabled: person ? form.round_robin_enabled : role === 'broker' };
    setForm(next);
    if (touched) setErrors(validate(next));
    setPermissions(new Set(roleDefaults(role)));
  };

  const roleOptions: SelectOption[] = meta.roles.map((r) => ({ value: r.key, label: r.name, hint: r.description }));
  const provinceOptions: SelectOption[] = meta.provinces.map((p) => ({ value: p, label: p }));

  const submit = async (e?: Event) => {
    e?.preventDefault();
    setTouched(true);
    const local = validate(form);
    setErrors(local);
    if (Object.keys(local).length) {
      document.querySelector('.modal .field-error')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    setBusy(true);
    const body = {
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      email: form.email.trim(),
      mobile_phone: form.mobile_phone.trim(),
      role: form.role,
      title: form.title.trim(),
      licence_number: form.licence_number.trim(),
      licence_province: form.licence_number.trim() ? form.licence_province : '',
      round_robin_enabled: form.round_robin_enabled,
      permissions: [...permissions],
    };
    try {
      if (person) {
        const payload: Record<string, unknown> = { ...body };
        if (isSelf) delete payload.role; // the server refuses a change to one's own role
        const { staff } = await patch<{ staff: StaffMember }>(`/staff/${person.id}`, payload);
        onSaved({ staff });
      } else {
        const result = await post<{ staff: StaffMember; invitation: Invitation }>('/staff', body);
        onSaved(result);
      }
    } catch (err) {
      setErrors(fieldErrors(err, 'Could not save that.'));
      setBusy(false);
    }
  };

  const title = person ? `Edit ${person.name}` : 'Add staff';

  return (
    <Modal title={title} onClose={onClose} wide footer={
      <>
        {errors._ && <span class="text-sm" style={{ color: 'var(--danger-text)', marginRight: 'auto' }}>{errors._}</span>}
        {!errors._ && Object.keys(errors).length > 0 && (
          <span class="text-sm" style={{ color: 'var(--danger-text)', marginRight: 'auto' }}>
            {Object.keys(errors).length} field{Object.keys(errors).length === 1 ? ' needs' : 's need'} attention.
          </span>
        )}
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class="btn btn-primary" onClick={() => submit()} disabled={busy}>
          {busy ? 'Saving…' : person ? 'Save changes' : 'Add and send invitation'}
        </button>
      </>
    }>
      <form onSubmit={submit} noValidate>
        {!person && (
          <p class="text-sm text-muted" style={{ marginTop: 0 }}>
            They get an email with a link to choose a password. Until they use it, they cannot sign in
            and are not given any leads. The link lasts {meta.invitation_valid_hours} hours.
          </p>
        )}

        <h3 class="form-section">Personal details</h3>
        <div class="grid-2">
          <Field label="First name *" error={errors.first_name}>
            <input value={form.first_name} onInput={input('first_name')} autocomplete="off"
                   aria-invalid={!!errors.first_name} maxLength={60} autofocus />
          </Field>
          <Field label="Last name *" error={errors.last_name}>
            <input value={form.last_name} onInput={input('last_name')} autocomplete="off"
                   aria-invalid={!!errors.last_name} maxLength={60} />
          </Field>
        </div>
        <div class="grid-2">
          <Field label="Email *" error={errors.email}
                 hint={person?.status === 'active' ? 'This is what they sign in with.' : 'The invitation goes here.'}>
            <input type="email" value={form.email} onInput={input('email')} autocomplete="off"
                   aria-invalid={!!errors.email} maxLength={254} />
          </Field>
          <Field label="Mobile *" error={errors.mobile_phone} hint="Shown in their email signature.">
            <input type="tel" value={form.mobile_phone} onInput={input('mobile_phone')}
                   placeholder="(416) 555-0142" aria-invalid={!!errors.mobile_phone} maxLength={30} />
          </Field>
        </div>

        <h3 class="form-section">Role & licence</h3>
        <div class="grid-2">
          <Field label="Role *" error={errors.role}
                 hint={isSelf ? 'You cannot change your own role.' : meta.roles.find((r) => r.key === form.role)?.description}>
            <SearchSelect value={form.role} options={roleOptions} onChange={changeRole} ariaLabel="Role"
                          disabled={isSelf} invalid={!!errors.role} />
          </Field>
          <Field label="Title" error={errors.title}>
            <input value={form.title} onInput={input('title')} placeholder="Mortgage Agent, Level 2"
                   maxLength={80} />
          </Field>
        </div>
        <div class="grid-2">
          <Field label={`Licence number${form.role === 'broker' ? ' *' : ''}`} error={errors.licence_number}
                 hint={form.role === 'broker' ? 'Required for brokers and agents.' : undefined}>
            <input value={form.licence_number} onInput={input('licence_number')} placeholder="M23001234"
                   aria-invalid={!!errors.licence_number} maxLength={20} />
          </Field>
          <Field label="Licensing province" error={errors.licence_province}>
            <SearchSelect value={form.licence_province} options={provinceOptions}
                          onChange={(v) => set('licence_province', v)} ariaLabel="Licensing province"
                          invalid={!!errors.licence_province} />
          </Field>
        </div>

        <h3 class="form-section">Lead assignment</h3>
        <div class="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <Switch checked={form.round_robin_enabled} label="Take part in round robin"
                  onChange={(v) => set('round_robin_enabled', v)} />
          <div>
            <strong style={{ fontSize: 13 }}>Take part in round robin</strong>
            <div class="text-sm text-muted">
              {form.round_robin_enabled
                ? 'They take a turn when new leads arrive (once they are active).'
                : 'They are skipped when leads are handed out automatically. An admin can still assign them leads by hand.'}
            </div>
          </div>
        </div>

        <h3 class="form-section row-between">
          <span>Module permissions</span>
          <span class="row" style={{ gap: 8 }}>
            {customised
              ? <Badge tone="warn">Customised from {meta.roles.find((r) => r.key === form.role)?.name}</Badge>
              : <Badge>{meta.roles.find((r) => r.key === form.role)?.name} defaults</Badge>}
            {customised && (
              <button type="button" class="btn btn-sm" onClick={() => setPermissions(new Set(defaults))}>
                Reset to role defaults
              </button>
            )}
          </span>
        </h3>
        <PermissionGrid modules={meta.modules} value={permissions} defaults={defaults}
                        onChange={setPermissions} />

        {person && (
          <>
            <h3 class="form-section">Account</h3>
            <div class="row-between account-row">
              <div>
                <StatusBadge person={person} />
                <span class="text-sm text-muted" style={{ marginLeft: 8 }}>
                  {person.status === 'invited'
                    ? `Invited ${relativeTime(person.invited_at)}${person.invite_expires_at ? ` · link expires ${relativeTime(person.invite_expires_at)}` : ''}`
                    : person.status === 'inactive' ? 'Cannot sign in and is not given leads.'
                    : person.activated_at ? `Activated ${relativeTime(person.activated_at)}` : ''}
                </span>
              </div>
              <div class="row" style={{ gap: 8 }}>
                <button type="button" class="btn btn-sm" onClick={() => setEditingSignature(true)}>
                  Email signature…
                </button>
                {person.status === 'invited' && (
                  <button type="button" class="btn btn-sm" onClick={() => onResend(person)}>Send a new link</button>
                )}
                {person.status === 'inactive' && (
                  <button type="button" class="btn btn-sm" onClick={() => onReactivate(person)}>Reactivate</button>
                )}
                {!isSelf && person.status !== 'inactive' && (
                  <button type="button" class="btn btn-sm btn-danger" onClick={() => onDeactivate(person)}>
                    Deactivate…
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </form>

      {editingSignature && person && (
        <Modal title={`${person.name}’s email signature`} wide onClose={() => setEditingSignature(false)}
               footer={<button class="btn" onClick={() => setEditingSignature(false)}>Close</button>}>
          <p class="text-sm text-muted" style={{ marginTop: 0 }}>
            {person.first_name} can change this themselves under Your profile. Saving here replaces what they have.
          </p>
          <SignatureEditor path={`/staff/${person.id}/signature`} whose={person.first_name} />
        </Modal>
      )}
    </Modal>
  );
}

/** Format +14165550142 as (416) 555-0142 for editing. */
function formatNational(e164: string): string {
  const d = e164.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

/**
 * One row per module: a box for the whole module, and a box per action.
 * A dot marks a box that differs from the role, so an exception is visible
 * at a glance rather than discovered in an audit.
 */
export function PermissionGrid({ modules, value, defaults, onChange, disabled = false }: {
  modules: ModuleSpec[]; value: Set<string>; defaults?: Set<string>;
  onChange: (next: Set<string>) => void; disabled?: boolean;
}) {
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(value);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    onChange(next);
  };

  return (
    <div class="perm-grid">
      {modules.map((m) => {
        const ids = m.permissions.map((p) => p.id);
        const count = ids.filter((id) => value.has(id)).length;
        const all = count === ids.length;
        return (
          <div key={m.key} class="perm-module">
            <label class="perm-module-head">
              <input type="checkbox" checked={all} disabled={disabled}
                     ref={(el) => { if (el) el.indeterminate = count > 0 && !all; }}
                     onChange={(e) => toggle(ids, (e.target as HTMLInputElement).checked)} />
              <span>
                <strong>{m.label}</strong>
                <span class="text-sm text-muted d-block">{m.description}</span>
              </span>
              <span class="perm-count text-sm text-muted">{count}/{ids.length}</span>
            </label>
            <div class="perm-actions">
              {m.permissions.map((p) => {
                const on = value.has(p.id);
                const differs = defaults ? on !== defaults.has(p.id) : false;
                return (
                  <label key={p.id} class={`perm-action${differs ? ' perm-differs' : ''}`}
                         title={differs ? (on ? 'Added on top of the role' : 'Removed from the role') : p.id}>
                    <input type="checkbox" checked={on} disabled={disabled}
                           onChange={(e) => toggle([p.id], (e.target as HTMLInputElement).checked)} />
                    <span>{p.label}</span>
                    {differs && <span class="perm-dot" aria-label={on ? 'added' : 'removed'} />}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Deactivate / delete, with the handover ─────────────────────────────────

function HandoverModal({ person, mode, onClose, onDone }: {
  person: StaffMember; mode: 'deactivate' | 'delete';
  onClose: () => void; onDone: (message: string) => void;
}) {
  const work = useAsync<{ open_leads: number; open_tasks: number }>(`/staff/${person.id}/open-work`);
  const candidates = useAsync<{ staff: Array<{ id: string; name: string; role_name: string; open_leads: number; round_robin_enabled: boolean }> }>('/staff/assignable');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const hasWork = work.status === 'ready' && work.data.open_leads + work.data.open_tasks > 0;
  const options: SelectOption[] = candidates.status === 'ready'
    ? candidates.data.staff.filter((s) => s.id !== person.id).map((s) => ({
      value: s.id, label: s.name,
      hint: `${s.role_name} · ${s.open_leads} open lead${s.open_leads === 1 ? '' : 's'}${s.round_robin_enabled ? '' : ' · round robin off'}`,
    }))
    : [];

  const verb = mode === 'delete' ? 'Delete' : 'Deactivate';

  const confirm = async () => {
    if (hasWork && !to) { setError('Choose who takes over their leads.'); return; }
    setBusy(true);
    setError('');
    try {
      const body = hasWork ? { reassign_to: to } : {};
      const result = mode === 'delete'
        ? await del<{ handover: { leads_moved: number; tasks_moved: number; to: string | null } }>(`/staff/${person.id}`, body)
        : await post<{ handover: { leads_moved: number; tasks_moved: number; to: string | null } }>(`/staff/${person.id}/deactivate`, body);
      const h = result.handover;
      onDone(`${person.name} ${mode === 'delete' ? 'deleted' : 'deactivated'}.` +
        (h.to ? ` ${h.leads_moved} lead${h.leads_moved === 1 ? '' : 's'} and ${h.tasks_moved} task${h.tasks_moved === 1 ? '' : 's'} handed to ${h.to}.` : ''));
    } catch (err) {
      const f = fieldErrors(err, `Could not ${mode} them.`);
      setError(f.reassign_to ?? f._ ?? Object.values(f)[0] ?? `Could not ${mode} them.`);
      setBusy(false);
    }
  };

  return (
    <Modal title={`${verb} ${person.name}?`} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class={`btn ${mode === 'delete' ? 'btn-danger-solid' : 'btn-primary'}`} onClick={confirm}
                disabled={busy || work.status !== 'ready' || (hasWork && !to)}>
          {busy ? 'Working…' : hasWork ? `${verb} and hand over` : verb}
        </button>
      </>
    }>
      {work.status === 'loading' && <Skeleton rows={2} />}
      {work.status === 'error' && <ErrorNote error={work.error} onRetry={work.reload} />}
      {work.status === 'ready' && (
        <>
          <p style={{ marginTop: 0 }}>
            {mode === 'delete'
              ? `${person.first_name} will be removed from every staff list and signed out everywhere. Their name stays on the notes and history they wrote, which compliance needs.`
              : `${person.first_name} will be signed out everywhere, cannot sign in, and is not given any leads until reactivated.`}
          </p>
          {hasWork ? (
            <>
              <div class="alert alert-info">
                {person.first_name} has <strong>{work.data.open_leads} open lead{work.data.open_leads === 1 ? '' : 's'}</strong>
                {' '}and <strong>{work.data.open_tasks} open task{work.data.open_tasks === 1 ? '' : 's'}</strong>.
                {' '}Choose who takes all of them over. Funded and lost files keep {person.first_name} as their owner.
              </div>
              <Field label="Hand their leads to *" error={error}>
                <SearchSelect value={to} options={options} onChange={(v) => { setTo(v); setError(''); }}
                              placeholder={candidates.status === 'loading' ? 'Loading staff…' : 'Choose a staff member…'}
                              searchPlaceholder="Search staff by name or role…" ariaLabel="Hand their leads to"
                              invalid={!!error} emptyText="No active staff match that." />
              </Field>
              {candidates.status === 'ready' && options.length === 0 && (
                <div class="alert alert-warn">
                  There is nobody active to hand the work to. Add or reactivate somebody first.
                </div>
              )}
            </>
          ) : (
            <>
              <p class="text-sm text-muted">They have no open leads or tasks, so nothing needs handing over.</p>
              {error && <div class="alert alert-error">{error}</div>}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

// ── After an invitation ────────────────────────────────────────────────────

function InvitationResult({ person, email, result, hours, onClose }: {
  person: string; email: string; result: Invitation; hours: number; onClose: () => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.link!);
      toast('Activation link copied.', 'ok');
    } catch {
      toast('Could not copy — select the link and copy it by hand.', 'error');
    }
  };
  return (
    <Modal title={result.sent ? 'Invitation sent' : 'Invitation created — email not sent'} onClose={onClose}
           footer={<button class="btn btn-primary" onClick={onClose}>Done</button>}>
      {result.sent ? (
        <p style={{ marginTop: 0 }}>
          {person} has been emailed at <strong>{email}</strong> with a link to activate their account.
          It works once and expires in {hours} hours.
        </p>
      ) : (
        <>
          <div class="alert alert-warn">{result.error ?? 'The email could not be sent.'}</div>
          {result.link && (
            <>
              <p>Send {person} this activation link yourself. It works once and expires in {hours} hours — treat it like a password.</p>
              <div class="copy-box">
                <code>{result.link}</code>
                <button class="btn btn-sm" onClick={copy}><Icon path={ICONS.copy} /> Copy</button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
