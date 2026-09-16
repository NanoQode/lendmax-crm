/**
 * API access — keys for the websites and services that connect to the CRM.
 *
 * One key per website, each with only the permissions it needs. The key is
 * shown once, when it is made; after that the CRM only knows its first few
 * characters, so a lost key is replaced rather than recovered.
 */
import { useState } from 'preact/hooks';
import { BASE, fieldErrors, formatDateTime, post, relativeTime } from '../lib/api.ts';
import { toast, useAsync, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Field, Icon, ICONS, Modal, Skeleton } from '../components/ui.tsx';
import { PermissionGrid } from './staff.tsx';
import { DataTable, recency } from '../components/data-table.tsx';

type Key = {
  id: string; name: string; description: string | null; key_prefix: string; permissions: string[];
  created_at: string; created_by_name: string | null; last_used_at: string | null;
  last_used_ip: string | null; revoked_at: string | null; status: 'active' | 'revoked';
};
type ModuleSpec = { key: string; label: string; description: string; permissions: Array<{ id: string; label: string }> };

const ENDPOINTS: Array<[string, string, string, string]> = [
  ['GET', '/v1/', '—', 'Which key this is, and its permissions'],
  ['GET', '/v1/permissions', '—', 'Every module and permission'],
  ['POST', '/v1/leads', 'customer.create', 'Send in a lead; round robin assigns it'],
  ['GET', '/v1/leads/{id}', 'customer.view', 'A lead’s stage and owner'],
  ['POST', '/v1/leads/{id}/assign', 'pipeline.assign', 'Hand a lead to a staff member'],
  ['GET', '/v1/staff', 'user.view', 'List staff (filter by status, role, q)'],
  ['GET', '/v1/staff/assignable', 'user.view', 'Staff who can be given leads'],
  ['GET', '/v1/staff/{id}', 'user.view', 'One staff member'],
  ['POST', '/v1/staff', 'user.manage', 'Add staff; they are emailed an invitation'],
  ['PATCH', '/v1/staff/{id}', 'user.manage', 'Edit details, role, permissions, round robin'],
  ['POST', '/v1/staff/{id}/deactivate', 'user.manage', 'Deactivate; reassign_to takes their leads'],
  ['POST', '/v1/staff/{id}/reactivate', 'user.manage', 'Reactivate'],
  ['POST', '/v1/staff/{id}/resend-invite', 'user.manage', 'Send a new activation link'],
  ['DELETE', '/v1/staff/{id}', 'user.manage', 'Delete; reassign_to takes their leads'],
  ['GET', '/v1/staff/{id}/signature', 'user.view', 'Their email signature'],
  ['PUT', '/v1/staff/{id}/signature', 'user.manage', 'Set it: standard, or custom text with fields'],
  ['GET', '/v1/required-documents', 'required_document.view', 'The required-documents list (filter, sort, page)'],
  ['GET', '/v1/required-documents/checklist', 'required_document.view', 'What a client with ?purpose= is asked for'],
  ['POST', '/v1/required-documents', 'required_document.manage', 'Add a required document'],
  ['PATCH', '/v1/required-documents/{id}', 'required_document.manage', 'Edit one'],
  ['POST', '/v1/required-documents/{id}/move', 'required_document.manage', 'Move it up or down its list'],
  ['DELETE', '/v1/required-documents/{id}', 'required_document.manage', 'Remove it from the list'],
  ['GET', '/v1/assignment', 'user.view', 'Round robin on/off and who is next'],
  ['PUT', '/v1/assignment', 'user.manage', 'Turn round robin on or off'],
];

export function ApiAccessPage(_props: { session: Session }) {
  const state = useAsync<{ keys: Key[]; modules: ModuleSpec[] }>('/api-keys');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<Key | null>(null);
  const baseUrl = `${location.origin}${BASE}/api`;

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>API access</h1>
          <p>Connect other websites to the CRM. Each website gets its own key with only the permissions it needs.</p>
        </div>
        <button class="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon path={ICONS.plus} /> Create API key
        </button>
      </div>

      <div class="card" style={{ marginBottom: 14 }}>
        {state.status === 'loading' && <Skeleton rows={3} height={44} />}
        {state.status === 'error' && (
          <div style={{ padding: 15 }}>
            <ErrorNote error={state.error} code={state.code} permission={state.permission} onRetry={state.reload} />
          </div>
        )}
        {state.status === 'ready' && (
          <DataTable<Key>
            label="API keys"
            rows={state.data.keys}
            rowKey={(k) => k.id}
            initialSort={{ key: 'created_at', dir: 'desc' }}
            rowClass={(k) => (k.status === 'revoked' ? 'row-dim' : '')}
            empty={
              <Empty title="No API keys yet"
                     action={<button class="btn btn-primary" onClick={() => setCreating(true)}>Create the first key</button>}>
                A key lets a website send leads in, or manage staff, without anybody signing in.
              </Empty>
            }
            columns={[
              { key: 'name', header: 'Website / service', primary: true,
                value: (k) => `${k.name} ${k.description ?? ''}`,
                render: (k) => (
                  <>
                    <div class="cell-strong">{k.name}</div>
                    {k.description && <div class="cell-muted text-sm">{k.description}</div>}
                  </>
                ) },
              { key: 'key_prefix', header: 'Key', render: (k) => <code class="text-sm">{k.key_prefix}…</code> },
              { key: 'permissions', header: 'Permissions', filter: 'auto', value: (k) => k.permissions,
                render: (k) => (
                  <span class="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    {k.permissions.map((p) => <Badge key={p}>{p}</Badge>)}
                  </span>
                ) },
              { key: 'status', header: 'Status', filter: 'auto', value: (k) => (k.status === 'active' ? 'Active' : 'Revoked'),
                render: (k) => (k.status === 'active' ? <Badge tone="ok">Active</Badge> : <Badge tone="danger">Revoked</Badge>) },
              { key: 'last_used_at', header: 'Last used', filter: 'auto', filterValue: (k) => recency(k.last_used_at),
                render: (k) => (
                  <span class="cell-muted">
                    {k.last_used_at ? <span title={k.last_used_ip ?? ''}>{relativeTime(k.last_used_at)}</span> : 'Never'}
                  </span>
                ) },
              { key: 'created_at', header: 'Created', filter: 'auto', filterValue: (k) => k.created_by_name ?? 'Unknown',
                render: (k) => (
                  <span class="cell-muted">{formatDateTime(k.created_at)}{k.created_by_name ? ` · ${k.created_by_name}` : ''}</span>
                ) },
              { key: 'actions', header: '', sortable: false, filter: false, searchable: false,
                render: (k) => (k.status === 'active'
                  ? <button class="btn btn-sm btn-danger" onClick={() => setRevoking(k)}>Revoke</button>
                  : null) },
            ]}
          />
        )}
      </div>

      <div class="card">
        <div class="card-head"><h2>Quick reference</h2></div>
        <div class="card-body">
          <p class="text-sm mt-0">
            Base URL <code>{baseUrl}</code>. Send the key as <code>Authorization: Bearer lmx_…</code>.
            Every response is <code>{'{ ok: true, data }'}</code>, or <code>{'{ ok: false, code, error, fields }'}</code>
            {' '}with a sentence you can show. Call the API from your website’s server, never from JavaScript in a
            visitor’s browser — a key in a web page is a key published to everybody.
          </p>
          <DataTable label="API endpoints" compact pageSize={25}
            rows={ENDPOINTS.map(([method, path, needs, does]) => ({ method, path, needs, does }))}
            rowKey={(e) => e.method + e.path}
            columns={[
              { key: 'method', header: 'Method', filter: 'auto',
                render: (e) => <Badge tone={e.method === 'GET' ? 'info' : e.method === 'DELETE' ? 'danger' : 'accent'}>{e.method}</Badge> },
              { key: 'path', header: 'Path', primary: true, render: (e) => <code class="text-sm">{e.path}</code> },
              { key: 'needs', header: 'Needs', filter: 'auto', render: (e) => <code class="text-sm">{e.needs}</code> },
              { key: 'does', header: 'Does' },
            ]} />
          <p class="text-sm" style={{ marginBottom: 6 }}>Sending a lead from a website form:</p>
          <pre class="code-block">{`curl -X POST ${baseUrl}/v1/leads \\
  -H "Authorization: Bearer lmx_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"first_name":"Jane","last_name":"Doe","email":"jane@example.com",
       "phone":"416-555-0142","amount_requested":450000,
       "message":"Looking to refinance in the spring."}'`}</pre>
          <p class="text-sm text-muted mb-0">Full documentation: <code>docs/API.md</code>.</p>
        </div>
      </div>

      {creating && state.status === 'ready' && (
        <CreateKey modules={state.data.modules} onClose={() => setCreating(false)}
                   onCreated={(key, name) => { setCreating(false); setCreated({ key, name }); state.reload(); }} />
      )}
      {created && <KeyCreated secret={created.key} name={created.name} baseUrl={baseUrl}
                              onClose={() => setCreated(null)} />}
      {revoking && (
        <Modal title={`Revoke “${revoking.name}”?`} onClose={() => setRevoking(null)} footer={
          <>
            <button class="btn" onClick={() => setRevoking(null)}>Cancel</button>
            <button class="btn btn-danger-solid" onClick={async () => {
              try {
                await post(`/api-keys/${revoking.id}/revoke`);
                toast(`“${revoking.name}” revoked. It stops working immediately.`, 'ok');
                setRevoking(null);
                state.reload();
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Could not revoke it.', 'error');
              }
            }}>Revoke key</button>
          </>
        }>
          <p class="mt-0">
            Anything using this key stops working at once. This cannot be undone — to reconnect the website,
            create a new key and put it in the website’s settings.
          </p>
        </Modal>
      )}
    </div>
  );
}

function CreateKey({ modules, onClose, onCreated }: {
  modules: ModuleSpec[]; onClose: () => void; onCreated: (key: string, name: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [permissions, setPermissions] = useState<Set<string>>(new Set(['customer.create']));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const local: Record<string, string> = {};
    if (name.trim().length < 2) local.name = 'Name the website or service this key is for.';
    if (!permissions.size) local.permissions = 'Give the key at least one permission.';
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      const { key } = await post<{ key: string }>('/api-keys', {
        name: name.trim(), description: description.trim() || undefined, permissions: [...permissions],
      });
      onCreated(key, name.trim());
    } catch (err) {
      setErrors(fieldErrors(err, 'Could not create the key.'));
      setBusy(false);
    }
  };

  return (
    <Modal title="Create API key" onClose={onClose} wide footer={
      <>
        {errors._ && <span class="text-sm" style={{ color: 'var(--danger-text)', marginRight: 'auto' }}>{errors._}</span>}
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create key'}</button>
      </>
    }>
      <div class="grid-2">
        <Field label="Website or service *" error={errors.name}>
          <input value={name} placeholder="lendmax.ca contact form" maxLength={80} autofocus
                 onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Notes" error={errors.description}>
          <input value={description} placeholder="Who maintains it, where the key is stored" maxLength={300}
                 onInput={(e) => setDescription((e.target as HTMLInputElement).value)} />
        </Field>
      </div>
      <h3 class="form-section">What this key may do</h3>
      {errors.permissions && <div class="field-error" style={{ marginBottom: 8 }}>{errors.permissions}</div>}
      <PermissionGrid modules={modules} value={permissions} onChange={setPermissions} />
      <p class="text-sm text-muted">
        Only permissions with an API endpoint are listed. A key can never create technical admins or grant
        administrative permissions, even with “Add, edit, deactivate & delete”.
      </p>
    </Modal>
  );
}

function KeyCreated({ secret: value, name, baseUrl, onClose }: {
  secret: string; name: string; baseUrl: string; onClose: () => void;
}) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); toast('Key copied.', 'ok'); }
    catch { toast('Could not copy — select the key and copy it by hand.', 'error'); }
  };
  return (
    <Modal title={`Key for “${name}”`} onClose={onClose}
           footer={<button class="btn btn-primary" onClick={onClose}>I have stored it</button>}>
      <div class="alert alert-warn">
        Copy this key now. It is not shown again — the CRM keeps only a fingerprint of it.
      </div>
      <div class="copy-box">
        <code>{value}</code>
        <button class="btn btn-sm" onClick={copy}><Icon path={ICONS.copy} /> Copy</button>
      </div>
      <p class="text-sm text-muted">Test it:</p>
      <pre class="code-block">{`curl ${baseUrl}/v1/ -H "Authorization: Bearer ${value}"`}</pre>
    </Modal>
  );
}
