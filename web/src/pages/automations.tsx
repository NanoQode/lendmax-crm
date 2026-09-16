/**
 * LM Automation: the route, and the pieces used outside the builder.
 *
 * The list and the builder are in workflow-builder.tsx (with the drawer and
 * panels in workflow-forms.tsx). What stays here is what other screens use:
 * the pause / resume / skip / end controls on one client's enrollment, and
 * the client file's Automations tab.
 */
import { useState } from 'preact/hooks';
import { ApiError, formatDateTime, post, relativeTime } from '../lib/api.ts';
import { toast, useAsync, useRoute, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Field, Modal, Skeleton } from '../components/ui.tsx';
import { WorkflowEditor, WorkflowsList } from './workflow-builder.tsx';

export function AutomationsPage({ session }: { session: Session }) {
  const { query } = useRoute();
  const editing = query.get('id');
  return editing
    ? <WorkflowEditor key={editing} id={editing} session={session} />
    : <WorkflowsList session={session} />;
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
  if (state.status === 'error') return <ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} />;

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
