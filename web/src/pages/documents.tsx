/**
 * The document review queue.
 *
 * An underwriter's screen rather than a broker's: what has arrived, what has
 * not been looked at, and what the scanner said about it. The order is
 * oldest first, because the point of a queue is that nothing sits in it.
 *
 * A document is never linked to directly. Every download goes through a
 * short-lived signed link tied to the person who asked for it, so a URL
 * pasted into a chat is useless to whoever receives it.
 */
import { useState } from 'preact/hooks';
import { ApiError, formatDateTime, get, post, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Field, Modal, Skeleton } from '../components/ui.tsx';

type Document = {
  id: string; category_key: string | null; category_label: string | null;
  filename: string; display_label: string | null; mime_type: string; byte_size: number;
  source: string; uploaded_at: string; review_status: string; review_note: string | null;
  scan_status: string; storage_driver: string; version: number;
  application_id: string | null; client_name: string | null; uploaded_by_name: string | null;
};

export function DocumentsPage({ session }: { session: Session }) {
  const [status, setStatus] = useState('pending');
  const state = useAsync<{ documents: Document[] }>(
    `/documents${status === 'all' ? '' : `?review_status=${status}`}`, [status]);
  const [reviewing, setReviewing] = useState<Document | null>(null);

  const canReview = session.permissions.includes('document.review');
  const canDownload = session.permissions.includes('document.download');

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Documents</h1>
          <p>
            What clients have sent, oldest first. A document nobody has looked at is a
            closing nobody is moving.
          </p>
        </div>
        <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}>
          <option value="pending">Not yet reviewed</option>
          <option value="accepted">Accepted</option>
          <option value="rejected">Rejected</option>
          <option value="all">Everything</option>
        </select>
      </div>

      {state.status === 'loading' && <Skeleton rows={5} height={58} />}
      {state.status === 'error' && (
        <ErrorNote error={state.error} code={state.code} permission={state.permission}
                   onRetry={state.reload} />
      )}

      {state.status === 'ready' && (
        <div class="card">
          <div class="card-head">
            <h2>{status === 'pending' ? 'Waiting to be reviewed' : 'Documents'}</h2>
            <span class="text-sm text-muted num">{state.data.documents.length}</span>
          </div>
          <div class="card-body-flush">
            {state.data.documents.length === 0 ? (
              <Empty title={status === 'pending' ? 'Nothing waiting' : 'Nothing here'}>
                {status === 'pending'
                  ? 'Every document that has arrived has been looked at.'
                  : 'No document is in that state.'}
              </Empty>
            ) : [...state.data.documents]
              .sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at))
              .map((doc) => (
                <div key={doc.id} class="list-row">
                  <div style={{ minWidth: 0 }}>
                    <strong>{doc.display_label ?? doc.filename}</strong>
                    {doc.version > 1 && (
                      <span class="text-sm text-muted"> · version {doc.version}</span>
                    )}
                    {doc.scan_status === 'skipped' && (
                      <Badge tone="warn">Not scanned</Badge>
                    )}
                    {doc.scan_status === 'infected' && <Badge tone="danger">Infected</Badge>}
                    <div class="text-sm text-muted">
                      {doc.client_name ?? 'No client'}
                      {doc.category_label ? ` · ${doc.category_label}` : ''}
                      {' · '}{formatBytes(doc.byte_size)}
                      {' · '}{doc.source === 'client_upload' ? 'sent by the client'
                        : `uploaded by ${doc.uploaded_by_name ?? 'staff'}`}
                      {' · '}{relativeTime(doc.uploaded_at)}
                    </div>
                    {doc.review_note && (
                      <div class="text-sm text-subtle">“{doc.review_note}”</div>
                    )}
                  </div>
                  <div class="row" style={{ gap: 7 }}>
                    <Badge tone={
                      doc.review_status === 'accepted' ? 'ok'
                        : doc.review_status === 'rejected' ? 'danger' : 'neutral'
                    }>{doc.review_status}</Badge>
                    {canDownload && <DownloadButton id={doc.id} />}
                    {doc.application_id && (
                      <button class="btn btn-sm btn-ghost"
                              onClick={() => navigate(
                                `/applications/${doc.application_id}?tab=documents`)}>
                        File
                      </button>
                    )}
                    {canReview && doc.review_status === 'pending' && (
                      <button class="btn btn-sm" onClick={() => setReviewing(doc)}>
                        Review
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
          {state.data.documents.some((d) => d.scan_status === 'skipped') && (
            <div class="card-body">
              <div class="alert alert-warn" style={{ marginBottom: 0 }}>
                Some of these were not scanned for malware — no scanner is connected. The
                system says <code>skipped</code> rather than <code>clean</code> so nothing
                here claims a check that did not happen.
              </div>
            </div>
          )}
        </div>
      )}

      {reviewing && (
        <ReviewForm document={reviewing} onClose={() => setReviewing(null)}
                    onDone={() => { setReviewing(null); state.reload(); }} />
      )}
    </div>
  );
}

/**
 * Downloads are two steps: ask for a link, then follow it.
 *
 * The link is short-lived and tied to the person who asked, so one pasted
 * into a chat is useless to whoever receives it.
 */
function DownloadButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button class="btn btn-sm" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const link = await get<{ url: string }>(`/documents/${id}/link`);
        window.open(link.url, '_blank', 'noopener');
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Could not open that.', 'error');
      } finally { setBusy(false); }
    }}>{busy ? '…' : 'Open'}</button>
  );
}

function ReviewForm({ document: doc, onClose, onDone }: {
  document: Document; onClose: () => void; onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const decide = async (review_status: 'accepted' | 'rejected') => {
    if (review_status === 'rejected' && !note.trim()) {
      setError('Say what is wrong with it. The client has to be told something they can act on.');
      return;
    }
    setBusy(true); setError('');
    try {
      await post(`/documents/${doc.id}/review`, { review_status, review_note: note || undefined });
      toast(review_status === 'accepted' ? 'Accepted.' : 'Rejected, with the reason.', 'ok');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
      setBusy(false);
    }
  };

  return (
    <Modal title={doc.display_label ?? doc.filename} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-danger" disabled={busy}
                onClick={() => decide('rejected')}>Reject</button>
        <button class="btn btn-primary" disabled={busy}
                onClick={() => decide('accepted')}>Accept</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <dl class="detail-list">
        <div><dt>Client</dt><dd>{doc.client_name ?? 'Not linked'}</dd></div>
        <div><dt>Category</dt><dd>{doc.category_label ?? 'Not categorised'}</dd></div>
        <div><dt>Sent</dt><dd>{formatDateTime(doc.uploaded_at)}</dd></div>
        <div><dt>Type</dt><dd>{doc.mime_type} · {formatBytes(doc.byte_size)}</dd></div>
        <div><dt>Scanned</dt><dd>{doc.scan_status}</dd></div>
      </dl>
      <Field
        label="Note"
        hint="Required when rejecting — it is what the client is told, so make it actionable."
      >
        <textarea rows={3} value={note} autofocus
                  onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
      </Field>
    </Modal>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
