/**
 * The dashboard.
 *
 * The KPI row is context. The block that earns the screen is "What to work on
 * next", which shows each suggestion with the evidence that produced it —
 * "Closes in 4 days; 2 lender conditions outstanding", not a number.
 */
import { useState } from 'preact/hooks';
import { compactMoney, formatDateTime, money } from '../lib/api.ts';
import { navigate, useAsync, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Skeleton } from '../components/ui.tsx';

type Dashboard = {
  scope: string;
  today: string;
  kpis: Record<string, number | string>;
  priorities: Array<{
    rule: string; priority: 'critical' | 'high' | 'medium' | 'low';
    action: string; reason: string; applicationId?: string;
  }>;
  appointments: Array<{
    id: string; starts_at: string; appointment_type: string; client_name: string;
    application_id: string | null; meeting_url: string | null;
  }>;
};

const KPIS: Array<{ key: string; label: string; format?: 'money' }> = [
  { key: 'active_files', label: 'Active files' },
  { key: 'new_this_week', label: 'New this week' },
  { key: 'closing_7_days', label: 'Closing in 7 days' },
  { key: 'volume_closing_30', label: 'Volume closing (30d)', format: 'money' },
  { key: 'awaiting_reply', label: 'Clients waiting' },
  { key: 'documents_outstanding', label: 'Docs outstanding' },
  { key: 'tasks_overdue', label: 'Tasks overdue' },
  { key: 'renewals_180', label: 'Renewals in 180d' },
  { key: 'unassigned', label: 'Unassigned' },
];

export function DashboardPage({ session }: { session: Session }) {
  const canSeeAll = session.permissions.includes('customer.view_all') ||
                    session.permissions.includes('report.view_all');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const state = useAsync<Dashboard>(`/dashboard?scope=${scope}`, [scope]);

  const firstName = session.user.name.split(' ')[0];

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Good {greeting()}, {firstName}</h1>
          <p>
            {state.status === 'ready'
              ? `${state.data.scope === 'mine' ? 'Your files' : 'The whole brokerage'} · ${state.data.today}`
              : 'Loading your files…'}
          </p>
        </div>
        {canSeeAll && (
          <div class="row" role="group" aria-label="Scope">
            <button class={`btn btn-sm${scope === 'mine' ? ' btn-primary' : ''}`}
                    onClick={() => setScope('mine')}>Mine</button>
            <button class={`btn btn-sm${scope === 'all' ? ' btn-primary' : ''}`}
                    onClick={() => setScope('all')}>Everyone</button>
          </div>
        )}
      </div>

      {state.status === 'error' && <ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} />}

      {state.status === 'loading' && (
        <div class="kpi-grid">
          {KPIS.map((k) => <div key={k.key} class="card kpi"><div class="skeleton" style={{ height: 48 }} /></div>)}
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <div class="kpi-grid">
            {KPIS.map((k) => {
              const raw = state.data.kpis[k.key];
              return (
                <div key={k.key} class="card kpi">
                  <div class="label">{k.label}</div>
                  <div class="value num">
                    {k.format === 'money' ? compactMoney(raw) : (raw ?? 0)}
                  </div>
                </div>
              );
            })}
          </div>

          <div class="grid-2" style={{ alignItems: 'start' }}>
            <div class="card">
              <div class="card-head">
                <h2>What to work on next</h2>
                <span class="text-sm text-muted">{state.data.priorities.length} item(s)</span>
              </div>
              <div class="card-body-flush">
                {state.data.priorities.length === 0 ? (
                  <Empty title="Nothing needs you right now">
                    No closings at risk, no clients waiting on a reply, and no overdue tasks
                    on your files.
                  </Empty>
                ) : (
                  state.data.priorities.map((p, i) => (
                    <button key={`${p.rule}-${i}`} class="priority-item"
                            onClick={() => p.applicationId && navigate(`/applications/${p.applicationId}`)}>
                      <span class={`priority-pill priority-${p.priority}`}>{p.priority}</span>
                      <span>
                        <div class="action">{p.action}</div>
                        <div class="reason">{p.reason}</div>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div class="card">
              <div class="card-head"><h2>Next 7 days</h2></div>
              <div class="card-body-flush">
                {state.data.appointments.length === 0 ? (
                  <Empty title="No appointments booked">
                    Meetings booked in the CRM — and synced to Google Calendar once that is
                    connected — appear here.
                  </Empty>
                ) : (
                  state.data.appointments.map((a) => (
                    <button key={a.id} class="priority-item"
                            onClick={() => a.application_id && navigate(`/applications/${a.application_id}`)}>
                      <span>
                        <div class="action">{a.client_name}</div>
                        <div class="reason">
                          {formatDateTime(a.starts_at)} · {a.appointment_type}
                        </div>
                      </span>
                      {a.meeting_url && <Badge tone="info">Meet</Badge>}
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>

          <div class="card" style={{ marginTop: 16 }}>
            <div class="card-head"><h2>This month</h2></div>
            <div class="card-body row" style={{ gap: 34, flexWrap: 'wrap' }}>
              <div>
                <div class="label text-sm text-muted">Funded</div>
                <div class="num" style={{ fontSize: 21, fontWeight: 620 }}>
                  {state.data.kpis.funded_this_month ?? 0}
                </div>
              </div>
              <div>
                <div class="label text-sm text-muted">Funded volume</div>
                <div class="num" style={{ fontSize: 21, fontWeight: 620 }}>
                  {money(state.data.kpis.funded_volume_this_month)}
                </div>
              </div>
              <div>
                <div class="label text-sm text-muted">Scarlett sync failures</div>
                <div class="num" style={{ fontSize: 21, fontWeight: 620 }}>
                  {state.data.kpis.scarlett_errors ?? 0}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}
