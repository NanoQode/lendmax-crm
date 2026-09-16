/**
 * Send to Scarlett, from the file.
 *
 * One click opens a check of what would go; one more sends it. The check is
 * the point: "Scarlett rejected the deal" after the fact is an afternoon, "the
 * subject property has no province" beforehand is a minute. Everything that
 * would stop or change the push is said here before the button is live —
 * what is missing, what could not be mapped to a Scarlett code, whether it is
 * sandbox, and whether the file is already in Scarlett.
 */
import { useState } from 'preact/hooks';
import { ApiError, formatDateTime, money, post } from '../lib/api.ts';
import { navigate, toast, useAsync, type Session } from '../lib/store.ts';
import { Badge, ErrorNote, Modal, Skeleton } from '../components/ui.tsx';

type Preview = {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  unmapped: Array<{ menu: string; value: string }>;
  alreadyPushed: string | null;
  lastSyncedAt: string | null;
  archived: boolean;
  file: { client: string | null; reference: string | null; amount_requested: string | null; property: string | null };
  mode: 'sandbox' | 'live';
  configured: boolean;
  codesPulled: boolean;
  missing: string[];
  deal: Record<string, unknown> | null;
};

export function SendToScarlett({ applicationId, session, onClose, onSent }: {
  applicationId: string; session: Session; onClose: () => void; onSent: () => void;
}) {
  const preview = useAsync<Preview>(`/applications/${applicationId}/scarlett/preview`, [applicationId]);
  const [acceptUnmapped, setAcceptUnmapped] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [showPayload, setShowPayload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; blockers?: string[] } | null>(null);

  const canConfigure = session.permissions.includes('integration.manage');
  const [pulling, setPulling] = useState(false);

  // Scarlett's dropdowns are integers with no published list; until the tables
  // are pulled once, no answer on any file can be mapped and nothing can go.
  const pullCodes = async () => {
    setPulling(true); setError(null);
    try {
      const result = await post<{ message: string }>('/integrations/scarlett/codes');
      toast(result.message, 'ok');
      preview.reload();
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Could not pull the code tables.' });
    } finally {
      setPulling(false);
    }
  };

  const send = async () => {
    if (preview.status !== 'ready') return;
    setBusy(true); setError(null);
    try {
      const result = await post<{ dealId: string; unmapped: Preview['unmapped'] }>(
        `/applications/${applicationId}/scarlett/push`,
        { accept_unmapped: acceptUnmapped, overwrite: !!preview.data.alreadyPushed && overwrite });
      toast(`Sent to Scarlett — deal ${result.dealId}.`, 'ok');
      onSent();
    } catch (err) {
      const blockers = err instanceof ApiError ? (err.body.blockers as string[] | undefined) : undefined;
      setError({ message: err instanceof Error ? err.message : 'Could not send to Scarlett.', blockers });
      setBusy(false);
      // What changed on the server (a failed attempt, a deal id after all) is
      // worth showing rather than the check from before the click.
      preview.reload();
    }
  };

  const body = (() => {
    if (preview.status === 'loading') return <Skeleton rows={4} />;
    if (preview.status === 'error') {
      return <ErrorNote error={preview.error} code={preview.code} permission={preview.permission} onRetry={preview.reload} />;
    }
    const p = preview.data;

    if (!p.configured) {
      return (
        <div class="alert alert-warn">
          Scarlett is not connected yet{p.missing.length ? ` — missing ${p.missing.join(', ')}` : ''}.
          {canConfigure
            ? <> <button class="link-button" onClick={() => { onClose(); navigate('/integrations'); }}>Set it up under Integrations</button>.</>
            : ' Ask an admin to set it up under Settings → Integrations.'}
        </div>
      );
    }

    return (
      <>
        {error && (
          <div class="alert alert-error">
            {error.message}
            {error.blockers?.length ? <ul>{error.blockers.map((b) => <li key={b}>{b}</li>)}</ul> : null}
          </div>
        )}

        <dl style={{ margin: '0 0 12px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px' }}>
          <dt class="text-sm text-muted">Client</dt><dd style={{ margin: 0 }}>{p.file.client ?? '—'}</dd>
          <dt class="text-sm text-muted">Reference</dt><dd style={{ margin: 0 }}>{p.file.reference ?? '—'}</dd>
          <dt class="text-sm text-muted">Mortgage</dt><dd style={{ margin: 0 }}>{money(p.file.amount_requested)}</dd>
          <dt class="text-sm text-muted">Property</dt><dd style={{ margin: 0 }}>{p.file.property ?? '—'}</dd>
          <dt class="text-sm text-muted">Mode</dt>
          <dd style={{ margin: 0 }}>
            {p.mode === 'live' ? <Badge tone="ok">Live</Badge> : <Badge tone="warn">Sandbox — nothing is sent</Badge>}
          </dd>
        </dl>

        {p.archived && <div class="alert alert-warn">This file is archived. Restore it before sending it.</div>}

        {p.alreadyPushed && (
          <div class="alert alert-warn">
            Already in Scarlett as <strong>{p.alreadyPushed}</strong>
            {p.lastSyncedAt ? ` (last sent ${formatDateTime(p.lastSyncedAt)})` : ''}.
            <label class="check" style={{ marginBottom: 0 }}>
              <input type="checkbox" checked={overwrite}
                     onChange={(e) => setOverwrite((e.target as HTMLInputElement).checked)} />
              <span class="text-sm">Send again and overwrite that deal in Scarlett</span>
            </label>
          </div>
        )}

        {p.blockers.length > 0 ? (
          <div class="alert alert-error">
            <strong>Fix these on the file before it can be sent:</strong>
            <ul style={{ margin: '6px 0 0' }}>{p.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            {!p.codesPulled && canConfigure && (
              <button class="btn btn-sm" style={{ marginTop: 8 }} disabled={pulling} onClick={pullCodes}>
                {pulling ? 'Pulling code tables…' : 'Pull code tables now'}
              </button>
            )}
          </div>
        ) : (
          <div class="alert alert-ok">Everything Scarlett requires is on the file.</div>
        )}

        {p.unmapped.length > 0 && (
          <div class="alert alert-warn">
            <strong>{p.unmapped.length} answer{p.unmapped.length === 1 ? '' : 's'} could not be matched to a Scarlett code</strong>
            {' '}and would be left out of the deal:
            <ul style={{ margin: '6px 0' }}>
              {p.unmapped.map((u) => <li key={`${u.menu}:${u.value}`}>{u.menu}: “{u.value}”</li>)}
            </ul>
            <label class="check" style={{ marginBottom: 0 }}>
              <input type="checkbox" checked={acceptUnmapped}
                     onChange={(e) => setAcceptUnmapped((e.target as HTMLInputElement).checked)} />
              <span class="text-sm">Send without them — they can be filled in inside Scarlett</span>
            </label>
          </div>
        )}

        {p.warnings.length > 0 && (
          <div class="alert alert-info">
            <strong>Worth knowing:</strong>
            <ul style={{ margin: '6px 0 0' }}>{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}

        {p.deal && (
          <div>
            <button class="link-button text-sm" onClick={() => setShowPayload(!showPayload)}>
              {showPayload ? 'Hide' : 'Show'} exactly what will be sent
            </button>
            {showPayload && (
              <pre style={{ maxHeight: 260, overflow: 'auto', fontSize: 11.5, background: 'var(--info-surface)', padding: 10, borderRadius: 6 }}>
                {JSON.stringify(p.deal, null, 2)}
              </pre>
            )}
          </div>
        )}
      </>
    );
  })();

  const p = preview.status === 'ready' ? preview.data : null;
  const blocked = !p || !p.configured || p.archived || p.blockers.length > 0
    || (p.unmapped.length > 0 && !acceptUnmapped)
    || (!!p.alreadyPushed && !overwrite);
  const label = busy ? 'Sending…'
    : p?.mode === 'sandbox' ? 'Run a sandbox check'
    : p?.alreadyPushed ? 'Confirm and re-send' : 'Confirm and send';

  return (
    <Modal title={p?.alreadyPushed ? 'Re-send to Scarlett' : 'Send to Scarlett'} onClose={busy ? () => {} : onClose} wide footer={<>
      <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button class="btn btn-primary" onClick={send} disabled={busy || blocked}>{label}</button>
    </>}>
      {body}
    </Modal>
  );
}
