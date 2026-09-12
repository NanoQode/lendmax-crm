/**
 * Settings.
 *
 * Two kinds of thing, presented differently on purpose.
 *
 * A vocabulary is the brokerage's own language and is edited like a list.
 * A compliance-shaped setting is a legal question with a dated answer, so
 * its editor asks for the source alongside the value and shows what was in
 * force before — "what rule were we applying in March" has to be answerable
 * from this screen and not from a database.
 */
import { useState } from 'preact/hooks';
import { ApiError, formatDate, post, put, relativeTime } from '../lib/api.ts';
import { toast, useAsync, type Config, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Field, Modal, Skeleton } from '../components/ui.tsx';

type Section = 'brokerage' | 'pipeline' | 'people' | 'templates' | 'compliance';

export function SettingsAdminPage({ session }: { session: Session; config: Config | null }) {
  const [section, setSection] = useState<Section>('brokerage');
  const canManage = session.permissions.includes('settings.manage');

  const sections: Array<[Section, string, string]> = [
    ['brokerage', 'Brokerage', 'settings.view'],
    ['pipeline', 'Pipeline & lists', 'settings.view'],
    ['people', 'People', 'user.view'],
    ['templates', 'Templates', 'settings.view'],
    ['compliance', 'Compliance rules', 'settings.view'],
  ];

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <p>
            {canManage
              ? 'Anything a brokerage runs differently lives here. Compliance values carry the date they took effect and where they came from.'
              : 'You can see how the brokerage is configured. A technical admin makes changes.'}
          </p>
        </div>
      </div>

      <div class="tabs" role="tablist">
        {sections.filter(([, , p]) => session.permissions.includes(p)).map(([key, label]) => (
          <button key={key} class="tab" role="tab" aria-selected={section === key}
                  onClick={() => setSection(key)}>{label}</button>
        ))}
      </div>

      {section === 'brokerage' && <BrokerageSection canManage={canManage} />}
      {section === 'pipeline' && <VocabularySection canManage={canManage} />}
      {section === 'people' && <PeopleSection session={session} />}
      {section === 'templates' && <TemplateSection session={session} />}
      {section === 'compliance' && <ComplianceRulesSection canManage={canManage} />}
    </div>
  );
}

// ── Brokerage ──────────────────────────────────────────────────────────────

type SettingSpec = {
  key: string; name: string; description: string; caution: string;
  current: Record<string, unknown>; is_default: boolean;
  effective_from: string | null; source_note: string | null; updated_by_name: string | null;
  history: Array<{ value: unknown; effective_from: string; source_note: string | null;
                   updated_by_name: string | null }>;
};

type AdminPayload = {
  organization: Record<string, any>;
  settings: SettingSpec[];
  retention_policies: Array<Record<string, any>>;
  risk_factors: Array<Record<string, any>>;
  risk_evaluators: string[];
  can_edit: boolean;
};

function BrokerageSection({ canManage }: { canManage: boolean }) {
  const state = useAsync<AdminPayload>('/admin/settings');
  const [editing, setEditing] = useState(false);

  if (state.status === 'loading') return <Skeleton rows={4} height={60} />;
  if (state.status === 'error') return <ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} />;

  const org = state.data.organization;
  const address = state.data.settings.find((s) => s.key === 'mailing_address');

  return (
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <h2>The brokerage</h2>
          {canManage && (
            <button class="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
          )}
        </div>
        <div class="card-body">
          <dl class="detail-list">
            {([
              ['Name', org.name],
              ['Legal name', org.legal_name],
              ['Regulator', org.regulator],
              ['Licence number', org.licence_number],
              ['Home province', org.home_province],
              ['Timezone', org.timezone],
              ['Website', org.website],
              ['Main phone', org.main_phone],
              ['Support email', org.support_email],
            ] as Array<[string, string | null]>).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd class={value ? '' : 'text-muted'}>{value || 'Not set'}</dd>
              </div>
            ))}
          </dl>

          {!(address?.current as { address?: string })?.address && (
            <div class="alert alert-warn">
              No mailing address is set. CASL requires one on every commercial message, so no
              marketing campaign can be sent until it is — set it under Compliance rules.
            </div>
          )}
        </div>
      </div>

      <AuditChainCard />

      {editing && (
        <OrganizationForm organization={org} onClose={() => setEditing(false)}
                          onSaved={() => { setEditing(false); state.reload(); }} />
      )}
    </div>
  );
}

/**
 * The audit chain.
 *
 * The database refuses to update or delete an audit entry; this check is for
 * anything that went around the database. It is on the settings screen
 * rather than hidden in a diagnostics page because the person who needs to
 * run it is the one already here.
 */
function AuditChainCard() {
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const verify = async () => {
    setVerifying(true);
    try {
      const response = await post<{ message: string }>('/audit/verify');
      setResult(response.message);
    } catch (err) {
      setResult(err instanceof Error ? err.message : 'Verification failed.');
    } finally { setVerifying(false); }
  };

  return (
    <div class="card">
      <div class="card-head"><h2>Audit log</h2></div>
      <div class="card-body">
        <p class="text-sm text-muted" style={{ marginTop: 0 }}>
          Every entry carries the hash of the one before it. The database refuses to update or
          delete an entry; this check catches anything that went around the database.
        </p>
        <button class="btn btn-sm" onClick={verify} disabled={verifying}>
          {verifying ? 'Verifying…' : 'Verify the chain'}
        </button>
        {result && (
          <div class={`alert ${result.includes('intact') ? 'alert-info' : 'alert-error'}`}
               style={{ marginTop: 12, marginBottom: 0 }}>
            {result}
          </div>
        )}
      </div>
    </div>
  );
}

function OrganizationForm({ organization, onClose, onSaved }: {
  organization: Record<string, any>; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: String(organization.name ?? ''),
    legal_name: String(organization.legal_name ?? ''),
    regulator: String(organization.regulator ?? ''),
    licence_number: String(organization.licence_number ?? ''),
    home_province: String(organization.home_province ?? 'ON'),
    timezone: String(organization.timezone ?? 'America/Toronto'),
    website: String(organization.website ?? ''),
    main_phone: String(organization.main_phone ?? ''),
    support_email: String(organization.support_email ?? ''),
  });
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const text = (name: keyof typeof form, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input value={form[name]}
             onInput={(e) => set({ [name]: (e.target as HTMLInputElement).value } as never)} />
    </Field>
  );

  const save = async () => {
    setError('');
    try {
      await put('/admin/organization', form);
      toast('Saved.', 'ok');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    }
  };

  return (
    <Modal title="Brokerage details" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={save}>Save</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      {text('name', 'Name', 'How the brokerage signs its emails.')}
      {text('legal_name', 'Legal name')}
      <div class="grid-2">
        {text('regulator', 'Regulator', 'FSRA, RECA, BCFSA…')}
        {text('licence_number', 'Licence number')}
      </div>
      <div class="grid-2">
        <Field label="Home province">
          <select value={form.home_province}
                  onChange={(e) => set({ home_province: (e.target as HTMLSelectElement).value })}>
            {['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']
              .map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Timezone" hint="Every date the CRM shows is worked out in this zone.">
          <select value={form.timezone}
                  onChange={(e) => set({ timezone: (e.target as HTMLSelectElement).value })}>
            {['America/St_Johns', 'America/Halifax', 'America/Toronto', 'America/Winnipeg',
              'America/Regina', 'America/Edmonton', 'America/Vancouver']
              .map((z) => <option key={z} value={z}>{z.split('/')[1]?.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
      </div>
      {text('website', 'Website')}
      <div class="grid-2">
        {text('main_phone', 'Main phone')}
        {text('support_email', 'Support email')}
      </div>
    </Modal>
  );
}

// ── Vocabularies ───────────────────────────────────────────────────────────

const VOCABULARIES: Array<{ name: string; label: string; help: string;
                            columns: Array<{ key: string; label: string; type: string;
                                             options?: string[] }> }> = [
  {
    name: 'stages', label: 'Pipeline stages',
    help: 'The order files move in. One stage has to mean funded and one has to mean lost, '
      + 'or nothing can ever be closed.',
    columns: [
      { key: 'label', label: 'Name', type: 'text' },
      { key: 'category', label: 'Means', type: 'select',
        options: ['open', 'parked', 'won', 'lost'] },
      { key: 'probability', label: 'Likelihood %', type: 'number' },
    ],
  },
  {
    name: 'transaction_types', label: 'Transaction types',
    help: 'What a file is for. Used to choose which documents are asked for.',
    columns: [{ key: 'label', label: 'Name', type: 'text' }],
  },
  {
    name: 'dispositions', label: 'Lost reasons',
    help: 'Why a file did not go ahead. A reason removed from this list is deactivated, '
      + 'never deleted — last year’s lost files keep theirs.',
    columns: [
      { key: 'label', label: 'Name', type: 'text' },
      { key: 'requires_note', label: 'Needs a note', type: 'boolean' },
      { key: 'nurture_eligible', label: 'Can be nurtured', type: 'boolean' },
    ],
  },
  {
    name: 'document_categories', label: 'Document categories',
    help: 'What the CRM asks clients for, and which of those are sensitive.',
    columns: [
      { key: 'label', label: 'Name', type: 'text' },
      { key: 'group_key', label: 'Group', type: 'text' },
      { key: 'sensitive', label: 'Sensitive', type: 'boolean' },
      { key: 'client_visible', label: 'Client can see', type: 'boolean' },
    ],
  },
];

function VocabularySection({ canManage }: { canManage: boolean }) {
  const [which, setWhich] = useState(VOCABULARIES[0]!.name);
  const spec = VOCABULARIES.find((v) => v.name === which)!;
  const state = useAsync<{
    items: Array<Record<string, any>>; usage: Record<string, number>; can_edit: boolean;
  }>(`/admin/vocabularies/${which}`, [which]);

  const [draft, setDraft] = useState<Array<Record<string, any>> | null>(null);
  const [editingRules, setEditingRules] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const items = draft ?? (state.status === 'ready' ? state.data.items : []);
  const dirty = draft !== null;

  const save = async () => {
    setBusy(true); setError('');
    try {
      await put(`/admin/vocabularies/${which}`, { items });
      toast('Saved.', 'ok');
      setDraft(null);
      state.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    } finally { setBusy(false); }
  };

  const update = (index: number, patch: Record<string, unknown>) =>
    setDraft(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const move = (index: number, by: number) => {
    const next = [...items];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setDraft(next);
  };

  return (
    <div class="stack">
      <div class="tabs tabs-inner" role="tablist">
        {VOCABULARIES.map((v) => (
          <button key={v.name} class="tab" role="tab" aria-selected={which === v.name}
                  onClick={() => { setWhich(v.name); setDraft(null); }}>{v.label}</button>
        ))}
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h2>{spec.label}</h2>
            <p class="text-sm text-muted" style={{ margin: '3px 0 0' }}>{spec.help}</p>
          </div>
          {canManage && dirty && (
            <div class="row" style={{ gap: 8 }}>
              <button class="btn btn-sm" onClick={() => { setDraft(null); setError(''); }}>
                Discard
              </button>
              <button class="btn btn-sm btn-primary" disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>

        {error && <div class="card-body"><div class="alert alert-error">{error}</div></div>}

        {state.status === 'loading' && <div class="card-body"><Skeleton rows={4} /></div>}
        {state.status === 'error' && <ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} />}

        {state.status === 'ready' && (
          <div class="card-body-flush">
            {items.map((item, index) => {
              const used = state.data.usage[String(item.key)] ?? 0;
              return (
                <div key={String(item.key)}
                     class={`vocab-row${item.active === false ? ' vocab-inactive' : ''}`}>
                  {canManage && (
                    <div class="vocab-move">
                      <button class="btn btn-ghost btn-sm" disabled={index === 0}
                              onClick={() => move(index, -1)} title="Move up">↑</button>
                      <button class="btn btn-ghost btn-sm" disabled={index === items.length - 1}
                              onClick={() => move(index, 1)} title="Move down">↓</button>
                    </div>
                  )}
                  <div class="vocab-fields">
                    {spec.columns.map((column) => (
                      <Field key={column.key} label={column.label}>
                        {column.type === 'select' ? (
                          <select value={String(item[column.key] ?? '')} disabled={!canManage}
                                  onChange={(e) => update(index,
                                    { [column.key]: (e.target as HTMLSelectElement).value })}>
                            {column.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : column.type === 'boolean' ? (
                          <label class="check">
                            <input type="checkbox" checked={item[column.key] === true}
                                   disabled={!canManage}
                                   onChange={(e) => update(index,
                                     { [column.key]: (e.target as HTMLInputElement).checked })} />
                            <span class="text-sm">yes</span>
                          </label>
                        ) : (
                          <input type={column.type === 'number' ? 'number' : 'text'}
                                 value={String(item[column.key] ?? '')} disabled={!canManage}
                                 onInput={(e) => update(index, {
                                   [column.key]: column.type === 'number'
                                     ? Number((e.target as HTMLInputElement).value)
                                     : (e.target as HTMLInputElement).value,
                                 })} />
                        )}
                      </Field>
                    ))}
                  </div>
                  {which === 'stages' && (
                    <div class="vocab-rules">
                      <div class="text-sm text-muted">{describeRules(item.entry_rules)}</div>
                      {canManage && (
                        <button class="link-button text-sm"
                                onClick={() => setEditingRules(index)}>
                          Change what a file needs to enter
                        </button>
                      )}
                    </div>
                  )}
                  <div class="vocab-meta">
                    <code class="text-sm">{String(item.key)}</code>
                    <div class="text-sm text-muted">
                      {used > 0 ? `${used} record(s)` : 'unused'}
                    </div>
                    {canManage && (
                      <label class="check">
                        <input type="checkbox" checked={item.active !== false}
                               onChange={(e) => update(index,
                                 { active: (e.target as HTMLInputElement).checked })} />
                        <span class="text-sm">active</span>
                      </label>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {canManage && state.status === 'ready' && (
          <div class="card-body">
            <button class="btn btn-sm" onClick={() => setDraft([...items, {
              key: '', label: '', active: true,
              ...(which === 'stages' ? { category: 'open' } : {}),
            }])}>Add one</button>
            <p class="text-sm text-muted" style={{ marginTop: 8 }}>
              An entry you remove from the list is deactivated, not deleted — records that
              already use it keep it.
            </p>
          </div>
        )}
      </div>

      {canManage && dirty && items.some((i) => !String(i.key).trim()) && (
        <div class="alert alert-warn">
          A new entry needs a key: lower case, digits and underscores, and it never changes
          once records use it.
        </div>
      )}

      {editingRules !== null && items[editingRules] && (
        <EntryRulesForm
          stage={items[editingRules]!}
          onClose={() => setEditingRules(null)}
          onSave={(entry_rules) => { update(editingRules, { entry_rules }); setEditingRules(null); }}
        />
      )}
    </div>
  );
}

/**
 * What a file needs before it can enter a stage.
 *
 * The gate is configuration, not code: a brokerage that wants compliance
 * signed off before a file can be marked funded sets it here, and the
 * pipeline machine refuses the move with the list of what is missing.
 */
const ENTRY_RULES: Array<[string, string]> = [
  ['requireAppointment', 'An appointment has been booked'],
  ['requireScarlettDeal', 'The file has been pushed to Scarlett'],
  ['requireLostDisposition', 'A reason has been recorded'],
  ['requireFundingConfirmed', 'Funding is confirmed with final figures'],
  ['requireComplianceComplete', 'Compliance has approved the file'],
];

function describeRules(rules: Record<string, unknown> | null | undefined): string {
  if (!rules || Object.keys(rules).length === 0) return 'Anything can enter this stage.';
  const parts: string[] = [];
  if (rules.minPercentComplete) parts.push(`at least ${rules.minPercentComplete}% complete`);
  for (const [key, label] of ENTRY_RULES) {
    if (rules[key]) parts.push(label.toLowerCase());
  }
  return parts.length ? `Needs ${parts.join(', ')}` : 'Anything can enter this stage.';
}

function EntryRulesForm({ stage, onClose, onSave }: {
  stage: Record<string, any>; onClose: () => void;
  onSave: (rules: Record<string, unknown>) => void;
}) {
  const [rules, setRules] = useState<Record<string, unknown>>(stage.entry_rules ?? {});

  return (
    <Modal title={`Entering "${stage.label}"`} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={() => onSave(rules)}>Apply</button>
      </>
    }>
      <p class="text-sm text-muted">
        A move into this stage is refused unless all of these are true, and the refusal names
        every one that is missing rather than the first.
      </p>
      <Field label="Minimum application completeness (%)"
             hint="Leave blank for no minimum.">
        <input type="number" min={0} max={100}
               value={String(rules.minPercentComplete ?? '')}
               onInput={(e) => {
                 const raw = (e.target as HTMLInputElement).value;
                 const next = { ...rules };
                 if (raw === '') delete next.minPercentComplete;
                 else next.minPercentComplete = Number(raw);
                 setRules(next);
               }} />
      </Field>
      {ENTRY_RULES.map(([key, label]) => (
        <label key={key} class="check">
          <input type="checkbox" checked={rules[key] === true}
                 onChange={(e) => {
                   const next = { ...rules };
                   if ((e.target as HTMLInputElement).checked) next[key] = true;
                   else delete next[key];
                   setRules(next);
                 }} />
          <span>{label}</span>
        </label>
      ))}
      <p class="text-sm text-muted">
        Applies when you save the list.
      </p>
    </Modal>
  );
}

// ── People ─────────────────────────────────────────────────────────────────

type AdminUser = {
  id: string; email: string; name: string; role: string; active: boolean;
  mfa_enabled: boolean; last_login_at: string | null; created_at: string;
  locked_until: string | null; mobile_phone: string | null; title: string | null;
  licence_number: string | null; open_assignments: number;
  permission_overrides: Record<string, boolean>;
};

function PeopleSection({ session }: { session: Session }) {
  const state = useAsync<{
    users: AdminUser[];
    roles: Array<{ key: string; name: string; description: string; permissions: string[] }>;
    permissions: Record<string, string>;
    can_edit: boolean;
  }>('/admin/users');
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [adding, setAdding] = useState(false);
  const [showingRole, setShowingRole] = useState<string | null>(null);

  if (state.status === 'loading') return <Skeleton rows={4} height={60} />;
  if (state.status === 'error') return <ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} />;

  const d = state.data;

  return (
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <h2>People</h2>
          {d.can_edit && <button class="btn btn-sm" onClick={() => setAdding(true)}>Add somebody</button>}
        </div>
        <div class="card-body-flush">
          {d.users.map((u) => (
            <div key={u.id} class={`list-row${u.active ? '' : ' vocab-inactive'}`}>
              <div style={{ minWidth: 0 }}>
                <strong>{u.name}</strong>
                {u.id === session.user.id && <span class="text-sm text-muted"> · you</span>}
                {!u.active && <Badge tone="neutral">Deactivated</Badge>}
                {Object.keys(u.permission_overrides ?? {}).length > 0 && (
                  <Badge tone="warn">Exception</Badge>
                )}
                <div class="text-sm text-muted">
                  {u.email}
                  {u.title ? ` · ${u.title}` : ''}
                  {' · '}
                  {u.last_login_at ? `last in ${relativeTime(u.last_login_at)}` : 'never signed in'}
                  {u.open_assignments > 0 && ` · ${u.open_assignments} file(s)`}
                </div>
              </div>
              <div class="row" style={{ gap: 8 }}>
                <button class="link-button text-sm"
                        onClick={() => setShowingRole(u.role)}>{u.role.replace(/_/g, ' ')}</button>
                {d.can_edit && (
                  <button class="btn btn-sm" onClick={() => setEditing(u)}>Edit</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Roles</h2></div>
        <div class="card-body-flush">
          {d.roles.map((role) => (
            <div key={role.key} class="list-row">
              <div style={{ minWidth: 0 }}>
                <strong>{role.name}</strong>
                <div class="text-sm text-muted">{role.description}</div>
              </div>
              <button class="btn btn-sm btn-ghost" onClick={() => setShowingRole(role.key)}>
                {role.permissions.length} permissions
              </button>
            </div>
          ))}
        </div>
      </div>

      {showingRole && (
        <Modal title={d.roles.find((r) => r.key === showingRole)?.name ?? showingRole}
               onClose={() => setShowingRole(null)}
               footer={<button class="btn" onClick={() => setShowingRole(null)}>Close</button>}>
          <p class="text-sm text-muted">
            {d.roles.find((r) => r.key === showingRole)?.description}
          </p>
          <div class="permission-list">
            {(d.roles.find((r) => r.key === showingRole)?.permissions ?? []).map((p) => (
              <div key={p}>
                <code class="text-sm">{p}</code>
                <span class="text-sm text-muted"> {d.permissions[p]}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {adding && (
        <UserForm onClose={() => setAdding(false)}
                  onSaved={() => { setAdding(false); state.reload(); }} />
      )}
      {editing && (
        <UserForm user={editing} permissions={d.permissions}
                  onClose={() => setEditing(null)}
                  onSaved={() => { setEditing(null); state.reload(); }} />
      )}
    </div>
  );
}

const ROLE_OPTIONS = ['broker', 'underwriter', 'manager', 'compliance_manager', 'technical_admin'];

function UserForm({ user, permissions, onClose, onSaved }: {
  user?: AdminUser; permissions?: Record<string, string>;
  onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    email: user?.email ?? '',
    name: user?.name ?? '',
    role: user?.role ?? 'broker',
    title: user?.title ?? '',
    mobile_phone: user?.mobile_phone ?? '',
    licence_number: user?.licence_number ?? '',
    active: user?.active ?? true,
  });
  const [overrides, setOverrides] = useState<Record<string, boolean>>(
    user?.permission_overrides ?? {});
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [showOverrides, setShowOverrides] = useState(
    Object.keys(user?.permission_overrides ?? {}).length > 0);

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const changedOverrides = JSON.stringify(overrides)
    !== JSON.stringify(user?.permission_overrides ?? {});

  const save = async () => {
    setError('');
    try {
      if (user) {
        await put(`/admin/users/${user.id}`, {
          ...form,
          permission_overrides: changedOverrides ? overrides : undefined,
          override_reason: changedOverrides ? reason : undefined,
        });
      } else {
        const result = await post<{ note: string }>('/admin/users', form);
        toast(result.note, 'ok');
      }
      if (user) toast('Saved.', 'ok');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    }
  };

  return (
    <Modal title={user ? user.name : 'Add somebody'} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={save}>{user ? 'Save' : 'Add them'}</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}

      {!user && (
        <Field label="Email" hint="They set their own password from an invitation.">
          <input type="email" value={form.email} autofocus
                 onInput={(e) => set({ email: (e.target as HTMLInputElement).value })} />
        </Field>
      )}
      <Field label="Name">
        <input value={form.name}
               onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
      </Field>
      <Field label="Role">
        <select value={form.role}
                onChange={(e) => set({ role: (e.target as HTMLSelectElement).value })}>
          {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
        </select>
      </Field>
      <div class="grid-2">
        <Field label="Title"><input value={form.title}
          onInput={(e) => set({ title: (e.target as HTMLInputElement).value })} /></Field>
        <Field label="Mobile" hint="Used in email signatures.">
          <input value={form.mobile_phone}
                 onInput={(e) => set({ mobile_phone: (e.target as HTMLInputElement).value })} />
        </Field>
      </div>
      <Field label="Licence number">
        <input value={form.licence_number}
               onInput={(e) => set({ licence_number: (e.target as HTMLInputElement).value })} />
      </Field>

      {user && (
        <>
          <label class="check">
            <input type="checkbox" checked={form.active}
                   onChange={(e) => set({ active: (e.target as HTMLInputElement).checked })} />
            <span>
              Active
              <span class="text-sm text-muted d-block">
                Deactivating signs them out everywhere. Their files stay assigned to them and
                show up as unassigned work on the dashboard.
              </span>
            </span>
          </label>

          <button class="btn btn-sm" style={{ marginTop: 10 }}
                  onClick={() => setShowOverrides(!showOverrides)}>
            {showOverrides ? 'Hide' : 'Grant'} an exception to the role
          </button>

          {showOverrides && permissions && (
            <>
              <p class="text-sm text-muted" style={{ marginTop: 10 }}>
                An exception overrides what the role allows, for this person only. It is
                audited, and it should have an end in mind.
              </p>
              <div class="permission-list permission-pick">
                {Object.entries(permissions).map(([key, label]) => (
                  <label key={key} class="check">
                    <input type="checkbox" checked={overrides[key] === true}
                           onChange={(e) => {
                             const next = { ...overrides };
                             if ((e.target as HTMLInputElement).checked) next[key] = true;
                             else delete next[key];
                             setOverrides(next);
                           }} />
                    <span class="text-sm"><code>{key}</code> — {label}</span>
                  </label>
                ))}
              </div>
              {changedOverrides && (
                <Field label="Why" hint="Recorded in the audit log. Say when it should end.">
                  <input value={reason} placeholder="Covering the underwriter until 30 October"
                         onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
                </Field>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

// ── Templates ──────────────────────────────────────────────────────────────

function TemplateSection({ session }: { session: Session }) {
  const state = useAsync<{
    templates: Array<Record<string, any>>;
    merge_fields: Array<{ name: string; label: string; example: string }>;
    can_edit: boolean;
  }>('/admin/templates');
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const [adding, setAdding] = useState(false);

  if (state.status === 'loading') return <Skeleton rows={4} height={60} />;
  if (state.status === 'error') return <ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} />;

  return (
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <h2>Templates</h2>
          {state.data.can_edit && (
            <button class="btn btn-sm" onClick={() => setAdding(true)}>New template</button>
          )}
        </div>
        <div class="card-body-flush">
          {state.data.templates.length === 0 ? (
            <Empty title="No templates yet">
              A template is a message somebody sends often, with the client's details merged in.
            </Empty>
          ) : state.data.templates.map((t) => (
            <div key={t.id} class={`list-row${t.active ? '' : ' vocab-inactive'}`}>
              <div style={{ minWidth: 0 }}>
                <strong>{t.name}</strong>
                <Badge tone={t.channel === 'sms' ? 'info' : 'neutral'}>{t.channel}</Badge>
                {t.purpose === 'marketing' && <Badge tone="warn">Marketing</Badge>}
                <div class="text-sm text-muted">
                  {t.subject || String(t.body_text ?? '').slice(0, 70)}
                </div>
                <div class="text-sm text-subtle">
                  {(t.merge_fields ?? []).length} merge field(s) · sent {t.sends ?? 0} time(s)
                </div>
              </div>
              {state.data.can_edit && (
                <button class="btn btn-sm" onClick={() => setEditing(t)}>Edit</button>
              )}
            </div>
          ))}
        </div>
      </div>

      {(adding || editing) && (
        <TemplateForm template={editing ?? undefined} fields={state.data.merge_fields}
                      onClose={() => { setAdding(false); setEditing(null); }}
                      onSaved={() => { setAdding(false); setEditing(null); state.reload(); }} />
      )}
    </div>
  );
}

function TemplateForm({ template, fields, onClose, onSaved }: {
  template?: Record<string, any>;
  fields: Array<{ name: string; label: string; example: string }>;
  onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    key: String(template?.key ?? ''),
    name: String(template?.name ?? ''),
    channel: String(template?.channel ?? 'email'),
    kind: String(template?.kind ?? 'personal'),
    purpose: String(template?.purpose ?? 'transactional'),
    subject: String(template?.subject ?? ''),
    body_text: String(template?.body_text ?? ''),
    active: template?.active !== false,
  });
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<Array<{ message: string }>>([]);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const save = async () => {
    setError(''); setIssues([]);
    const key = form.key || form.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
    try {
      await put(`/admin/templates/${key}`, { ...form, key });
      toast('Saved.', 'ok');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setIssues((err.detail as Array<{ message: string }> | undefined) ?? []);
      } else setError('Could not save that.');
    }
  };

  return (
    <Modal title={template ? `Edit "${template.name}"` : 'New template'} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={save}>Save</button>
      </>
    }>
      {error && (
        <div class="alert alert-error">
          {error}
          {issues.length > 1 && <ul>{issues.map((i) => <li key={i.message}>{i.message}</li>)}</ul>}
        </div>
      )}
      <Field label="Name"><input value={form.name} autofocus
        onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} /></Field>
      <div class="grid-3">
        <Field label="Channel">
          <select value={form.channel}
                  onChange={(e) => set({ channel: (e.target as HTMLSelectElement).value })}>
            <option value="email">Email</option>
            <option value="sms">Text</option>
          </select>
        </Field>
        <Field label="Kind">
          <select value={form.kind}
                  onChange={(e) => set({ kind: (e.target as HTMLSelectElement).value })}>
            {['personal', 'campaign', 'system', 'document_request', 'appointment'].map((k) =>
              <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        <Field label="Purpose">
          <select value={form.purpose}
                  onChange={(e) => set({ purpose: (e.target as HTMLSelectElement).value })}>
            <option value="transactional">Transactional</option>
            <option value="service">Service</option>
            <option value="marketing">Marketing</option>
          </select>
        </Field>
      </div>
      {form.channel === 'email' && (
        <Field label="Subject"><input value={form.subject}
          onInput={(e) => set({ subject: (e.target as HTMLInputElement).value })} /></Field>
      )}
      <Field label="Message"
             hint="A line whose merge field has no value is left out entirely.">
        <textarea rows={8} value={form.body_text}
                  onInput={(e) => set({ body_text: (e.target as HTMLTextAreaElement).value })} />
      </Field>
      <details>
        <summary class="text-sm text-muted">Merge fields you can use</summary>
        <div class="merge-grid">
          {fields.map((f) => (
            <div key={f.name}>
              <code>{'{' + f.name + '}'}</code>
              <span class="text-sm text-muted"> {f.label} · e.g. {f.example}</span>
            </div>
          ))}
        </div>
      </details>
    </Modal>
  );
}

// ── Compliance rules ───────────────────────────────────────────────────────

/**
 * The dated settings.
 *
 * Each shows what it is, what it costs to get wrong, when the current value
 * took effect and where it came from. A value with no source is a guess
 * somebody will later rely on, so the editor asks for one and shows its
 * absence plainly rather than accepting it silently.
 */
function ComplianceRulesSection({ canManage }: { canManage: boolean }) {
  const state = useAsync<AdminPayload>('/admin/settings');
  const [editing, setEditing] = useState<SettingSpec | null>(null);
  const [editingRetention, setEditingRetention] = useState<Record<string, any> | null>(null);

  if (state.status === 'loading') return <Skeleton rows={5} height={70} />;
  if (state.status === 'error') return <ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} />;

  return (
    <div class="stack">
      {state.data.settings.map((spec) => (
        <div key={spec.key} class="card">
          <div class="card-head">
            <div>
              <h2>{spec.name}</h2>
              <p class="text-sm text-muted" style={{ margin: '3px 0 0' }}>{spec.description}</p>
            </div>
            <div class="row" style={{ gap: 8 }}>
              {spec.is_default && <Badge tone="warn">Never set</Badge>}
              {canManage && (
                <button class="btn btn-sm" onClick={() => setEditing(spec)}>Change</button>
              )}
            </div>
          </div>
          <div class="card-body">
            <pre class="setting-value">{JSON.stringify(spec.current, null, 2)}</pre>
            <div class="text-sm text-muted">
              {spec.is_default
                ? 'This is the built-in default. Nobody has set it for this brokerage.'
                : <>
                    In force since {formatDate(spec.effective_from)}
                    {spec.updated_by_name ? `, set by ${spec.updated_by_name}` : ''}.
                  </>}
            </div>
            {!spec.is_default && (
              <div class={`text-sm ${spec.source_note ? 'text-muted' : ''}`}
                   style={spec.source_note ? {} : { color: 'var(--warn-text)' }}>
                {spec.source_note
                  ? `Source: ${spec.source_note}`
                  : 'No source recorded. A compliance value with no source is a guess.'}
              </div>
            )}
            <div class="alert alert-warn" style={{ marginTop: 10 }}>{spec.caution}</div>
            {spec.history.length > 1 && (
              <details>
                <summary class="text-sm text-muted">
                  {spec.history.length} version(s) — what was in force before
                </summary>
                <div class="stack-tight" style={{ marginTop: 8 }}>
                  {spec.history.map((h, i) => (
                    <div key={i} class="text-sm">
                      <strong>{formatDate(h.effective_from)}</strong>
                      {h.updated_by_name ? ` · ${h.updated_by_name}` : ''}
                      <pre class="setting-value">{JSON.stringify(h.value)}</pre>
                      {h.source_note && <span class="text-muted">{h.source_note}</span>}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      ))}

      <div class="card">
        <div class="card-head"><h2>Retention</h2></div>
        <div class="card-body-flush">
          {state.data.retention_policies.map((p) => (
            <div key={p.key} class="list-row">
              <div style={{ minWidth: 0 }}>
                <strong>{p.name}</strong>
                <Badge tone={p.action === 'review' ? 'neutral' : 'danger'}>{p.action}</Badge>
                <div class="text-sm text-muted">
                  {Math.round(p.retain_months / 12 * 10) / 10} years from{' '}
                  {String(p.anchor).replace(/_/g, ' ')}
                </div>
                <div class="text-sm text-subtle">
                  {p.source_note ?? 'No source recorded'}
                </div>
              </div>
              {canManage && (
                <button class="btn btn-sm" onClick={() => setEditingRetention(p)}>Change</button>
              )}
            </div>
          ))}
        </div>
        <div class="card-body text-sm text-muted">
          Every policy here is set to review by default, which means the runner proposes and a
          person disposes. Nothing in this system deletes a mortgage record on a schedule
          nobody approved.
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Risk model</h2>
          <span class="text-sm text-muted">
            {state.data.risk_factors.filter((f) => f.active).length} active factor(s)
          </span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>Factor</th><th>Weight</th><th>How it is decided</th><th>Version</th></tr>
            </thead>
            <tbody>
              {state.data.risk_factors.map((f) => (
                <tr key={`${f.model_version}-${f.factor_key}`}
                    class={f.active ? '' : 'vocab-inactive'}>
                  <td data-primary data-label="Factor">
                    {f.label}
                    {f.description && (
                      <div class="text-sm text-muted">{f.description}</div>
                    )}
                  </td>
                  <td data-label="Weight" class="num">{Number(f.weight)}</td>
                  <td data-label="How it is decided">
                    <code class="text-sm">{f.evaluator}</code>
                    {Object.keys(f.parameters ?? {}).length > 0 && (
                      <div class="text-sm text-muted">{JSON.stringify(f.parameters)}</div>
                    )}
                  </td>
                  <td data-label="Version" class="num">v{f.model_version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="card-body text-sm text-muted">
          A factor's evaluator is one of a fixed set — {state.data.risk_evaluators.join(', ')} —
          because a rule engine that accepts expressions is one nobody can audit. Changing a
          weight does not re-rate anything already assessed: every assessment records the
          model version that produced it.
        </div>
      </div>

      {editing && (
        <SettingForm spec={editing} onClose={() => setEditing(null)}
                     onSaved={() => { setEditing(null); state.reload(); }} />
      )}
      {editingRetention && (
        <RetentionForm policy={editingRetention} onClose={() => setEditingRetention(null)}
                       onSaved={() => { setEditingRetention(null); state.reload(); }} />
      )}
    </div>
  );
}

function SettingForm({ spec, onClose, onSaved }: {
  spec: SettingSpec; onClose: () => void; onSaved: () => void;
}) {
  const [value, setValue] = useState(JSON.stringify(spec.current, null, 2));
  const [source, setSource] = useState(spec.source_note ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      setError('That is not valid JSON. Check the brackets and the commas.');
      return;
    }
    if (!source.trim()) {
      setError('Record where this value came from. A compliance value with no source is a '
        + 'guess somebody will later rely on.');
      return;
    }
    try {
      await put(`/settings/${spec.key}`, {
        value: parsed, source_note: source, effective_from: effectiveFrom,
      });
      toast('Saved.', 'ok');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    }
  };

  return (
    <Modal title={spec.name} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={save}>Save</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <div class="alert alert-warn">{spec.caution}</div>
      <Field label="Value">
        <textarea rows={10} class="mono" value={value}
                  onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)} />
      </Field>
      <Field label="Where this came from"
             hint="A citation, not a note. &ldquo;CASL s.10(9), checked 12 September 2026&rdquo;.">
        <input value={source}
               onInput={(e) => setSource((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="In force from"
             hint="The previous value is kept, so what was being applied before stays readable.">
        <input type="date" value={effectiveFrom}
               onInput={(e) => setEffectiveFrom((e.target as HTMLInputElement).value)} />
      </Field>
    </Modal>
  );
}

function RetentionForm({ policy, onClose, onSaved }: {
  policy: Record<string, any>; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: String(policy.name ?? ''),
    entity_type: String(policy.entity_type ?? ''),
    anchor: String(policy.anchor ?? 'created_at'),
    retain_months: Number(policy.retain_months ?? 84),
    action: String(policy.action ?? 'review'),
    source_note: String(policy.source_note ?? ''),
    active: policy.active !== false,
  });
  const [acknowledge, setAcknowledge] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const save = async () => {
    setError('');
    try {
      await put(`/admin/retention/${policy.key}`, {
        ...form, acknowledge_destructive: acknowledge,
      });
      toast('Saved.', 'ok');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    }
  };

  return (
    <Modal title={`Retention: ${policy.name}`} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={save}>Save</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <Field label="Name"><input value={form.name}
        onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} /></Field>
      <div class="grid-2">
        <Field label="Counted from"
               hint="Six years after the relationship ends is not six years after the row.">
          <select value={form.anchor}
                  onChange={(e) => set({ anchor: (e.target as HTMLSelectElement).value })}>
            {['funded_at', 'closed_at', 'last_activity_at', 'created_at', 'maturity_date']
              .map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        <Field label="Keep for (months)">
          <input type="number" value={form.retain_months}
                 onInput={(e) => set({
                   retain_months: Number((e.target as HTMLInputElement).value) })} />
        </Field>
      </div>
      <Field label="Then what">
        <select value={form.action}
                onChange={(e) => set({ action: (e.target as HTMLSelectElement).value })}>
          <option value="review">Propose it for review — a person decides</option>
          <option value="anonymise">Anonymise automatically</option>
          <option value="delete">Delete automatically</option>
        </select>
      </Field>
      {form.action !== 'review' && (
        <>
          <div class="alert alert-error">
            The runner will {form.action} records without anybody looking at them first. A
            legal hold still stops a file being touched, but nothing else will.
          </div>
          <label class="check">
            <input type="checkbox" checked={acknowledge}
                   onChange={(e) => setAcknowledge((e.target as HTMLInputElement).checked)} />
            <span>I understand this destroys records automatically.</span>
          </label>
        </>
      )}
      <Field label="Where the period came from"
             hint="Required for anything that destroys records.">
        <input value={form.source_note}
               onInput={(e) => set({ source_note: (e.target as HTMLInputElement).value })} />
      </Field>
    </Modal>
  );
}
