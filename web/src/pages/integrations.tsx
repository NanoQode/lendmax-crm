/**
 * Settings → Integrations.
 *
 * Every integration is rendered from the spec the server sends, so the screen
 * and the resolver cannot disagree about what a field is called or whether it
 * is required — a form that lists a field the backend ignores is how an admin
 * ends up certain they have configured something that is not configured.
 *
 * Secret fields always render EMPTY, and an empty secret means "leave what is
 * there". The browser therefore never holds a credential, and editing the
 * sending number cannot wipe the password by accident.
 */
import { useState } from 'preact/hooks';
import { ApiError, post, put, relativeTime } from '../lib/api.ts';
import { toast, useAsync, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Field, Modal, Skeleton } from '../components/ui.tsx';

type FieldSpec = {
  name: string; label: string; secret?: boolean; required?: boolean;
  type?: string; options?: Array<{ value: string; label: string }>;
  help?: string; placeholder?: string; envVar?: string;
};

type Integration = {
  spec: {
    key: string; name: string; summary: string; whenOff: string;
    fields: FieldSpec[]; testable: boolean;
  };
  enabled: boolean;
  configured: boolean;
  missing: string[];
  config: Record<string, unknown>;
  secrets: Record<string, { set: boolean; last4: string }>;
  source: Record<string, string>;
  decryptFailed: boolean;
  lastTest: { at: string | null; ok: boolean | null; message: string | null };
};

type Payload = {
  integrations: Integration[];
  jobs: Record<string, number>;
  scarlettCodes: { count: number; pulled: string | null } | null;
  canEdit: boolean;
};

export function IntegrationsPage({ session }: { session: Session }) {
  const state = useAsync<Payload>('/integrations');
  const [editing, setEditing] = useState<Integration | null>(null);
  const canEdit = session.permissions.includes('integration.manage');

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Integrations</h1>
          <p>
            What is connected, and exactly what is missing where it is not. A value saved here is
            held encrypted and overrides the server’s environment file — so a rotated credential
            needs no deploy.
          </p>
        </div>
      </div>

      {state.status === 'loading' && <Skeleton rows={5} height={80} />}
      {state.status === 'error' && <ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} />}

      {state.status === 'ready' && (
        <div class="stack">
          <QueueCard jobs={state.data.jobs} />

          {state.data.integrations.map((integration) => (
            <IntegrationCard
              key={integration.spec.key}
              integration={integration}
              canEdit={canEdit}
              scarlettCodes={
                integration.spec.key === 'scarlett' ? state.data.scarlettCodes : null
              }
              onEdit={() => setEditing(integration)}
              onChanged={state.reload}
            />
          ))}
        </div>
      )}

      {editing && (
        <EditIntegration
          integration={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); state.reload(); }}
        />
      )}
    </div>
  );
}

function QueueCard({ jobs }: { jobs: Record<string, number> }) {
  // `dead` and `overdue` are the two that mean something is wrong. The rest
  // are context.
  const bad = (jobs.dead ?? 0) + (jobs.overdue ?? 0);
  return (
    <div class="card">
      <div class="card-head">
        <h2>Background work</h2>
        <Badge tone={bad ? 'danger' : 'ok'}>{bad ? 'Needs attention' : 'Healthy'}</Badge>
      </div>
      <div class="card-body row" style={{ gap: 28, flexWrap: 'wrap' }}>
        {[
          ['Pending', jobs.pending ?? 0],
          ['Running', jobs.running ?? 0],
          ['Succeeded (7d)', jobs.succeeded ?? 0],
          ['Overdue', jobs.overdue ?? 0],
          ['Gave up', jobs.dead ?? 0],
        ].map(([label, value]) => (
          <div key={label as string}>
            <div class="text-sm text-muted">{label}</div>
            <div class="num" style={{
              fontSize: 20, fontWeight: 620,
              color: (label === 'Gave up' || label === 'Overdue') && Number(value) > 0
                ? 'var(--danger-text)' : undefined,
            }}>
              {value}
            </div>
          </div>
        ))}
      </div>
      {(jobs.dead ?? 0) > 0 && (
        <div class="card-body" style={{ paddingTop: 0 }}>
          <div class="alert alert-error" style={{ marginBottom: 0 }}>
            {jobs.dead} job(s) gave up after exhausting their retries. Scheduled messages and
            Scarlett pushes among them will not happen on their own.
          </div>
        </div>
      )}
    </div>
  );
}

function IntegrationCard({ integration, canEdit, scarlettCodes, onEdit, onChanged }: {
  integration: Integration;
  canEdit: boolean;
  scarlettCodes: { count: number; pulled: string | null } | null;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const { spec } = integration;

  const runTest = async () => {
    setBusy('test');
    try {
      const res = await post<{ result: { ok: boolean; message: string } }>(
        `/integrations/${spec.key}/test`,
      );
      toast(res.result.message, res.result.ok ? 'ok' : 'error');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The test failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const pullCodes = async () => {
    setBusy('codes');
    try {
      const res = await post<{ ok: boolean; message: string }>('/integrations/scarlett/codes');
      toast(res.message, res.ok ? 'ok' : 'error');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The pull failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggle = async () => {
    setBusy('toggle');
    try {
      await put(`/integrations/${spec.key}`, { enabled: !integration.enabled });
      toast(`${spec.name} ${integration.enabled ? 'switched off' : 'switched on'}`, 'ok');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change that.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const status = integration.decryptFailed
    ? { tone: 'danger' as const, label: 'Credentials unreadable' }
    : !integration.enabled
      ? { tone: 'neutral' as const, label: 'Off' }
      : integration.configured
        ? { tone: 'ok' as const, label: 'On' }
        : { tone: 'warn' as const, label: 'Incomplete' };

  return (
    <div class="card">
      <div class="card-head">
        <div>
          <h2>{spec.name}</h2>
          <div class="text-sm text-muted" style={{ marginTop: 2, maxWidth: 640 }}>{spec.summary}</div>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>

      <div class="card-body">
        {integration.decryptFailed && (
          <div class="alert alert-error">
            The stored credentials could not be decrypted. Either <code>CREDENTIALS_KEY</code> has
            changed since they were saved, or the row has been altered. Re-enter them below —
            nothing is sent through this integration until you do.
          </div>
        )}

        {!integration.enabled && (
          <div class="alert alert-info">{spec.whenOff}</div>
        )}

        {integration.enabled && integration.missing.length > 0 && (
          <div class="alert alert-warn">
            <strong>Not usable yet.</strong> Missing:{' '}
            {integration.missing
              .map((name) => spec.fields.find((f) => f.name === name)?.label ?? name)
              .join(', ')}.
          </div>
        )}

        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr',
                     gap: '6px 18px', fontSize: 13 }}>
          {spec.fields.map((field) => {
            const secret = integration.secrets[field.name];
            const value = integration.config[field.name];
            const source = integration.source[field.name];
            return (
              <>
                <dt key={`${field.name}-k`} class="text-muted" style={{ whiteSpace: 'nowrap' }}>
                  {field.label}
                </dt>
                <dd key={`${field.name}-v`} style={{ margin: 0 }}>
                  {field.secret ? (
                    secret?.set
                      ? <span>•••••••• {secret.last4 && <code>{secret.last4}</code>}</span>
                      : <span class="text-muted">Not set</span>
                  ) : value === '' || value === null || value === undefined ? (
                    <span class="text-muted">Not set</span>
                  ) : typeof value === 'boolean' ? (
                    value ? 'Yes' : 'No'
                  ) : (
                    String(value)
                  )}
                  {/* Where a value comes from, so .env and the database are
                      traceable rather than mysterious. */}
                  {source === 'environment' && (
                    <span class="text-sm text-muted"> — from <code>{field.envVar}</code></span>
                  )}
                </dd>
              </>
            );
          })}
        </dl>

        {spec.key === 'scarlett' && (
          <div class="alert alert-info" style={{ marginTop: 14, marginBottom: 0 }}>
            {scarlettCodes && scarlettCodes.count > 0 ? (
              <>
                <strong>{scarlettCodes.count} dropdown codes cached</strong>
                {scarlettCodes.pulled && <> — pulled {relativeTime(scarlettCodes.pulled)}</>}.
                A value that cannot be matched to one of these is left out of a push rather than
                guessed at.
              </>
            ) : (
              <>
                <strong>No dropdown codes have been pulled.</strong> Scarlett’s enums are integers
                with no published list, so until they are pulled every dropdown value is left out
                of a push.
              </>
            )}
          </div>
        )}

        {integration.lastTest.at && (
          <div class="text-sm text-muted" style={{ marginTop: 12 }}>
            Last test {relativeTime(integration.lastTest.at)}:{' '}
            <span style={{ color: integration.lastTest.ok ? 'var(--ok-text)' : 'var(--danger-text)' }}>
              {integration.lastTest.message}
            </span>
          </div>
        )}
      </div>

      {canEdit && (
        <div class="modal-foot" style={{ justifyContent: 'space-between' }}>
          <button class="btn btn-sm" onClick={toggle} disabled={busy !== null}>
            {integration.enabled ? 'Switch off' : 'Switch on'}
          </button>
          <div class="row">
            {spec.key === 'scarlett' && (
              <button class="btn btn-sm" onClick={pullCodes} disabled={busy !== null}>
                {busy === 'codes' ? 'Pulling…' : 'Pull code tables'}
              </button>
            )}
            {spec.testable && (
              <button class="btn btn-sm" onClick={runTest} disabled={busy !== null}>
                {busy === 'test' ? 'Testing…' : 'Test connection'}
              </button>
            )}
            <button class="btn btn-sm btn-primary" onClick={onEdit}>Edit</button>
          </div>
        </div>
      )}
    </div>
  );
}

function EditIntegration({ integration, onClose, onSaved }: {
  integration: Integration; onClose: () => void; onSaved: () => void;
}) {
  const { spec } = integration;
  const [config, setConfig] = useState<Record<string, unknown>>(() => ({ ...integration.config }));
  // Secrets start empty on purpose — see the note at the top of this file.
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(integration.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await put(`/integrations/${spec.key}`, { enabled, config, secrets });
      toast(`${spec.name} saved`, 'ok');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={spec.name}
      onClose={onClose}
      footer={<>
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </>}
    >
      {error && <div class="alert alert-error">{error}</div>}

      <Field label="Enabled" hint={enabled ? undefined : spec.whenOff}>
        <select value={enabled ? 'yes' : 'no'}
                onChange={(e) => setEnabled((e.target as HTMLSelectElement).value === 'yes')}>
          <option value="yes">On</option>
          <option value="no">Off</option>
        </select>
      </Field>

      {spec.fields.map((field) => {
        const secret = integration.secrets[field.name];
        const hint = [
          field.help,
          field.secret && secret?.set
            ? `Currently set${secret.last4 ? `, ending ${secret.last4}` : ''}. Leave blank to keep it.`
            : null,
          field.envVar && integration.source[field.name] === 'environment'
            ? `Inherited from ${field.envVar}. Anything saved here overrides it.`
            : null,
        ].filter(Boolean).join(' ');

        if (field.type === 'boolean') {
          return (
            <Field key={field.name} label={field.label} hint={hint}>
              <select value={config[field.name] ? 'yes' : 'no'}
                      onChange={(e) =>
                        setConfig((c) => ({ ...c, [field.name]: (e.target as HTMLSelectElement).value === 'yes' }))}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </Field>
          );
        }
        if (field.type === 'select') {
          return (
            <Field key={field.name} label={field.label} hint={hint}>
              <select value={String(config[field.name] ?? '')}
                      onChange={(e) =>
                        setConfig((c) => ({ ...c, [field.name]: (e.target as HTMLSelectElement).value }))}>
                <option value="">Not set</option>
                {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          );
        }
        return (
          <Field key={field.name} label={field.label + (field.required ? ' *' : '')} hint={hint}>
            <input
              type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'}
              autocomplete="off"
              placeholder={field.secret && secret?.set ? '•••••••• (unchanged)' : field.placeholder}
              value={field.secret ? (secrets[field.name] ?? '') : String(config[field.name] ?? '')}
              onInput={(e) => {
                const value = (e.target as HTMLInputElement).value;
                if (field.secret) setSecrets((s) => ({ ...s, [field.name]: value }));
                else setConfig((c) => ({ ...c, [field.name]: value }));
              }}
            />
          </Field>
        );
      })}

      <p class="text-sm text-muted mb-0">
        Credentials are encrypted before they are stored and are never sent back to this screen —
        only whether each is set and its last four characters.
      </p>
    </Modal>
  );
}
