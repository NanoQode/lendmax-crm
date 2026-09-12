/**
 * Reports.
 *
 * Every figure says what it counted. A conversion rate with no denominator
 * on screen is a number somebody will quote in a meeting and nobody can
 * check, and a dashboard full of those is worse than no dashboard.
 *
 * The charts are drawn as SVG from the data rather than by a charting
 * library: these are bars and a funnel, they have to be legible in both
 * themes and on a phone, and a 200KB dependency to draw a rectangle is a
 * dependency to keep patched for the life of the product.
 */
import { useState } from 'preact/hooks';
import { compactMoney, formatDate, money } from '../lib/api.ts';
import { useAsync, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Skeleton } from '../components/ui.tsx';

type Tab = 'pipeline' | 'volume' | 'team' | 'campaigns' | 'compliance';

export function ReportsPage({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>('pipeline');
  const [months, setMonths] = useState('12');

  const tabs: Array<[Tab, string, string | null]> = [
    ['pipeline', 'Pipeline', null],
    ['volume', 'Volume', null],
    ['team', 'People', 'report.view_team'],
    ['campaigns', 'Campaigns', 'campaign.view'],
    ['compliance', 'Compliance', 'compliance.view'],
  ];

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Reports</h1>
          <p>
            Built from what was recorded as it happened, not from where files are now —
            which is the only way to answer how long something took.
          </p>
        </div>
        <select value={months} onChange={(e) => setMonths((e.target as HTMLSelectElement).value)}>
          <option value="3">Last 3 months</option>
          <option value="6">Last 6 months</option>
          <option value="12">Last 12 months</option>
          <option value="24">Last 2 years</option>
        </select>
      </div>

      <div class="tabs" role="tablist">
        {tabs.filter(([, , permission]) =>
          !permission || session.permissions.includes(permission)).map(([key, label]) => (
          <button key={key} class="tab" role="tab" aria-selected={tab === key}
                  onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === 'pipeline' && <PipelineReport months={months} />}
      {tab === 'volume' && <VolumeReport months={months} />}
      {tab === 'team' && <TeamReport months={months} />}
      {tab === 'campaigns' && <CampaignReport months={months} />}
      {tab === 'compliance' && <ComplianceReport />}
    </div>
  );
}

// ── Pipeline ───────────────────────────────────────────────────────────────

function PipelineReport({ months }: { months: string }) {
  const state = useAsync<{
    dwell: Array<{ stage_key: string; label: string; files: number;
                   median_days: string | null; p90_days: string | null }>;
    funnel: Array<{ stage_key: string; label: string; reached: number }>;
    lost: Array<{ disposition: string; label: string; count: number }>;
    scope: { scope: string; forced: boolean };
  }>(`/reports/pipeline?months=${months}`, [months]);

  if (state.status === 'loading') return <Skeleton rows={4} height={80} />;
  if (state.status === 'error') return <ErrorNote error={state.error} onRetry={state.reload} />;

  const d = state.data;
  const top = d.funnel[0]?.reached ?? 0;
  const lostTotal = d.lost.reduce((s, l) => s + l.count, 0);

  return (
    <div class="stack">
      <ScopeNote scope={d.scope} />

      <div class="card">
        <div class="card-head">
          <h2>How far files get</h2>
          <span class="text-sm text-muted">
            Files that ever reached each stage, not files sitting in it now
          </span>
        </div>
        <div class="card-body">
          {d.funnel.length === 0 ? (
            <Empty title="No stage changes recorded in this period">
              A file that has never moved has no history to report on.
            </Empty>
          ) : d.funnel.map((stage) => (
            <div key={stage.stage_key} class="bar-row">
              <span class="bar-label">{stage.label}</span>
              <span class="bar-track">
                <span class="bar-fill"
                      style={{ width: `${top ? (stage.reached / top) * 100 : 0}%` }} />
              </span>
              <span class="bar-value num">
                {stage.reached}
                {top > 0 && stage.reached !== top && (
                  <span class="text-muted"> · {Math.round((stage.reached / top) * 100)}%</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>How long files sit</h2>
          <span class="text-sm text-muted">
            Median, and the slowest tenth — one file stuck for a year makes an average lie
          </span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>Stage</th><th>Files</th><th>Median</th><th>Slowest 10%</th></tr>
            </thead>
            <tbody>
              {d.dwell.map((row) => (
                <tr key={row.stage_key}>
                  <td data-primary data-label="Stage">{row.label}</td>
                  <td data-label="Files" class="num">{row.files}</td>
                  <td data-label="Median" class="num">
                    {row.median_days === null ? '—' : `${row.median_days} days`}
                  </td>
                  <td data-label="Slowest 10%" class="num">
                    {row.p90_days === null ? '—' : `${row.p90_days} days`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Why files were lost</h2>
          <span class="text-sm text-muted num">{lostTotal} file(s)</span>
        </div>
        <div class="card-body">
          {d.lost.length === 0 ? (
            <Empty title="Nothing lost in this period">Or nothing recorded as lost.</Empty>
          ) : d.lost.map((row) => (
            <div key={row.disposition} class="bar-row">
              <span class="bar-label">{row.label}</span>
              <span class="bar-track">
                <span class="bar-fill bar-lost"
                      style={{ width: `${lostTotal ? (row.count / lostTotal) * 100 : 0}%` }} />
              </span>
              <span class="bar-value num">{row.count}</span>
            </div>
          ))}
          {d.lost.some((l) => l.disposition === 'not recorded') && (
            <p class="text-sm text-muted">
              Files lost with no reason recorded teach the brokerage nothing. Requiring a
              disposition is a setting under Settings → Pipeline.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ScopeNote({ scope }: { scope: { scope: string; forced: boolean } }) {
  if (!scope.forced) return null;
  return (
    <div class="alert alert-info">
      These are your own files. A manager sees the brokerage.
    </div>
  );
}

// ── Volume ─────────────────────────────────────────────────────────────────

function VolumeReport({ months }: { months: string }) {
  const state = useAsync<{
    monthly: Array<{ month: string; files: number; volume: string; average: string;
                     average_rate: string }>;
    by_lender: Array<{ lender: string; files: number; volume: string }>;
    by_type: Array<{ type: string; files: number; volume: string }>;
    by_source: Array<{ source: string; files: number; volume: string }>;
    scope: { scope: string; forced: boolean };
  }>(`/reports/volume?months=${months}`, [months]);

  if (state.status === 'loading') return <Skeleton rows={4} height={80} />;
  if (state.status === 'error') return <ErrorNote error={state.error} onRetry={state.reload} />;

  const d = state.data;
  const peak = Math.max(1, ...d.monthly.map((m) => Number(m.volume ?? 0)));
  const total = d.monthly.reduce((s, m) => s + Number(m.volume ?? 0), 0);
  const files = d.monthly.reduce((s, m) => s + m.files, 0);

  return (
    <div class="stack">
      <ScopeNote scope={d.scope} />

      <div class="kpi-grid">
        <div class="card kpi">
          <div class="label">Funded volume</div>
          <div class="value num">{compactMoney(total)}</div>
          <div class="sub">across {files} file(s)</div>
        </div>
        <div class="card kpi">
          <div class="label">Average file</div>
          <div class="value num">{files ? compactMoney(total / files) : '—'}</div>
        </div>
        <div class="card kpi">
          <div class="label">Files a month</div>
          <div class="value num">
            {d.monthly.length ? (files / d.monthly.length).toFixed(1) : '—'}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Month by month</h2></div>
        <div class="card-body">
          {d.monthly.length === 0 ? (
            <Empty title="Nothing funded in this period" />
          ) : (
            <div class="column-chart">
              {d.monthly.map((m) => (
                <div key={m.month} class="column"
                     title={`${m.month}: ${money(m.volume)} across ${m.files} file(s)`}>
                  <span class="column-fill"
                        style={{ height: `${(Number(m.volume ?? 0) / peak) * 100}%` }} />
                  <span class="column-label">{m.month.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
          {d.monthly.length > 0 && (
            <div class="text-sm text-muted">
              Tallest bar is {money(peak)}. Average rate over the period:{' '}
              {(d.monthly.reduce((s, m) => s + Number(m.average_rate ?? 0), 0)
                / d.monthly.length).toFixed(2)}%.
            </div>
          )}
        </div>
      </div>

      <div class="grid-2" style={{ alignItems: 'start' }}>
        <BreakdownCard title="By lender" rows={d.by_lender.map((r) =>
          ({ key: r.lender, label: r.lender, files: r.files, volume: r.volume }))} />
        <BreakdownCard title="By transaction type" rows={d.by_type.map((r) =>
          ({ key: r.type, label: r.type, files: r.files, volume: r.volume }))} />
      </div>
      <BreakdownCard title="By lead source" rows={d.by_source.map((r) =>
        ({ key: r.source, label: r.source, files: r.files, volume: r.volume }))} />
    </div>
  );
}

function BreakdownCard({ title, rows }: {
  title: string;
  rows: Array<{ key: string; label: string; files: number; volume: string }>;
}) {
  const peak = Math.max(1, ...rows.map((r) => Number(r.volume ?? 0)));
  return (
    <div class="card">
      <div class="card-head"><h2>{title}</h2></div>
      <div class="card-body">
        {rows.length === 0 ? <Empty title="Nothing recorded" /> : rows.map((row) => (
          <div key={row.key} class="bar-row">
            <span class="bar-label">{row.label}</span>
            <span class="bar-track">
              <span class="bar-fill"
                    style={{ width: `${(Number(row.volume ?? 0) / peak) * 100}%` }} />
            </span>
            <span class="bar-value num">
              {compactMoney(row.volume)} <span class="text-muted">· {row.files}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── People ─────────────────────────────────────────────────────────────────

function TeamReport({ months }: { months: string }) {
  const state = useAsync<{
    people: Array<{
      id: string; name: string; role: string; open_files: number; funded: number;
      volume: string; lost: number; avg_days_to_fund: string | null;
    }>;
    months: number;
  }>(`/reports/team?months=${months}`, [months]);

  if (state.status === 'loading') return <Skeleton rows={4} height={60} />;
  if (state.status === 'error') return <ErrorNote error={state.error} onRetry={state.reload} />;

  return (
    <div class="card">
      <div class="card-head">
        <h2>The brokerage</h2>
        <span class="text-sm text-muted">Last {state.data.months} months</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Person</th><th>Open</th><th>Funded</th><th>Volume</th>
              <th>Lost</th><th>Days to fund</th>
            </tr>
          </thead>
          <tbody>
            {state.data.people.map((p) => (
              <tr key={p.id}>
                <td data-primary data-label="Person">
                  {p.name}
                  <span class="text-sm text-muted"> · {p.role}</span>
                </td>
                <td data-label="Open" class="num">{p.open_files}</td>
                <td data-label="Funded" class="num">{p.funded}</td>
                <td data-label="Volume" class="num">{compactMoney(p.volume)}</td>
                <td data-label="Lost" class="num">{p.lost}</td>
                <td data-label="Days to fund" class="num">
                  {p.avg_days_to_fund ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card-body text-sm text-muted">
        Counts only files where the person is the assigned broker. A file with two people on
        it counts once for each, so the columns do not sum to the brokerage total.
      </div>
    </div>
  );
}

// ── Campaigns ──────────────────────────────────────────────────────────────

function CampaignReport({ months }: { months: string }) {
  const state = useAsync<{
    campaigns: Array<{
      id: string; name: string; channel: string; purpose: string; send_started_at: string;
      recipients: number; suppressed: number; sent: number; opened: number; clicked: number;
      unsubscribed: number; applications: number; funded: number; funded_volume: string;
    }>;
  }>(`/reports/campaigns?months=${months}`, [months]);

  if (state.status === 'loading') return <Skeleton rows={4} height={60} />;
  if (state.status === 'error') return <ErrorNote error={state.error} onRetry={state.reload} />;

  if (state.data.campaigns.length === 0) {
    return <div class="card"><Empty title="No campaigns sent in this period" /></div>;
  }

  return (
    <div class="card">
      <div class="card-head">
        <h2>Campaigns</h2>
        <span class="text-sm text-muted">Ordered by what they produced, not by opens</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Campaign</th><th>Sent</th><th>Applications</th><th>Funded</th>
              <th>Volume</th><th>Opened</th><th>Unsubscribed</th>
            </tr>
          </thead>
          <tbody>
            {state.data.campaigns.map((c) => (
              <tr key={c.id}>
                <td data-primary data-label="Campaign">
                  {c.name}
                  <div class="text-sm text-muted">
                    {formatDate(c.send_started_at)} · {c.channel}
                    {c.suppressed > 0 && ` · ${c.suppressed} held back`}
                  </div>
                </td>
                <td data-label="Sent" class="num">{c.sent}</td>
                <td data-label="Applications" class="num">
                  <strong>{c.applications}</strong>
                </td>
                <td data-label="Funded" class="num"><strong>{c.funded}</strong></td>
                <td data-label="Volume" class="num">{compactMoney(c.funded_volume)}</td>
                <td data-label="Opened" class="num text-muted">
                  {c.sent ? `${Math.round((c.opened / c.sent) * 100)}%` : '—'}
                </td>
                <td data-label="Unsubscribed" class="num">
                  {c.unsubscribed > 0
                    ? <span style={{ color: 'var(--danger-text)' }}>{c.unsubscribed}</span>
                    : '0'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card-body text-sm text-muted">
        An open is a weak signal — images-off clients never register one, and a scanner can
        register several. Applications and fundings are the columns worth reading.
      </div>
    </div>
  );
}

// ── Compliance ─────────────────────────────────────────────────────────────

function ComplianceReport() {
  const state = useAsync<{
    cases: Record<string, number>;
    identity: Record<string, number>;
    risk: Array<{ rating: string; count: number }>;
    retention_policies: Array<{
      key: string; name: string; entity_type: string; anchor: string;
      retain_months: number; action: string; source_note: string | null;
    }>;
    retention_note: string;
  }>('/reports/compliance');

  if (state.status === 'loading') return <Skeleton rows={4} height={60} />;
  if (state.status === 'error') return <ErrorNote error={state.error} onRetry={state.reload} />;

  const d = state.data;
  const RATING_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
    low: 'ok', medium: 'warn', high: 'danger', 'not assessed': 'neutral',
    review_required: 'neutral',
  };

  return (
    <div class="stack">
      <div class="kpi-grid">
        {[
          ['Cases', d.cases.total],
          ['Approved', d.cases.approved],
          ['Awaiting review', d.cases.awaiting],
          ['On legal hold', d.cases.on_hold],
          ['Identities verified', d.identity.verified],
          ['Expired ID documents', d.identity.expired_documents],
        ].map(([label, value]) => (
          <div key={label as string} class="card kpi">
            <div class="label">{label}</div>
            <div class="value num">{value ?? 0}</div>
          </div>
        ))}
      </div>

      <div class="card">
        <div class="card-head"><h2>Risk ratings</h2></div>
        <div class="card-body row" style={{ gap: 20, flexWrap: 'wrap' }}>
          {d.risk.map((r) => (
            <div key={r.rating}>
              <Badge tone={RATING_TONE[r.rating] ?? 'neutral'}>
                {r.rating.replace(/_/g, ' ')}
              </Badge>
              <div class="num" style={{ fontSize: 22, fontWeight: 640, marginTop: 5 }}>
                {r.count}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Retention</h2></div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>Policy</th><th>From</th><th>Keep for</th><th>Then</th><th>Source</th></tr>
            </thead>
            <tbody>
              {d.retention_policies.map((p) => (
                <tr key={p.key}>
                  <td data-primary data-label="Policy">{p.name}</td>
                  <td data-label="From">{p.anchor.replace(/_/g, ' ')}</td>
                  <td data-label="Keep for" class="num">
                    {Math.round(p.retain_months / 12 * 10) / 10} years
                  </td>
                  <td data-label="Then">
                    <Badge tone={p.action === 'review' ? 'neutral' : 'warn'}>{p.action}</Badge>
                  </td>
                  <td data-label="Source" class={p.source_note ? '' : 'text-muted'}>
                    {p.source_note ?? 'Not recorded'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="card-body text-sm text-muted">{d.retention_note}</div>
      </div>
    </div>
  );
}
