/**
 * Activity logs — what each person did in the last 30 days.
 *
 * Everybody sees their own. Somebody with "See everyone's activity" sees the
 * whole team and picks whose. Nothing here can be deleted: entries leave on
 * their own after 30 days. The compliance audit trail is separate and is
 * kept for as long as the retention policies say.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatDateTime, relativeTime } from '../lib/api.ts';
import { navigate, useAsync, type Session } from '../lib/store.ts';
import { Avatar, Badge, Empty, ErrorNote, SearchSelect, type SelectOption } from '../components/ui.tsx';
import { DataTable, emptyQuery, queryToParams, type Column, type TableQuery } from '../components/data-table.tsx';

type Entry = {
  id: string; at: string;
  actor_user_id: string | null; actor_name: string | null; actor_role: string | null;
  actor_role_name: string | null; actor_kind: 'user' | 'integration';
  action: string; action_label: string; module: string; module_label: string;
  application_id: string | null; client_name: string | null;
  summary: string; ip: string | null;
};

type Options = {
  retention_days: number;
  can_view_all: boolean;
  modules: Array<{ key: string; label: string }>;
  actions: Array<{ key: string; label: string; module: string }>;
  people: Array<{ id: string; name: string; role_name: string | null; status: string }>;
  integrations: boolean;
};

const PERIODS: SelectOption[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 days' },
];

const STATUS_NOTE: Record<string, string> = { inactive: 'inactive', invited: 'not activated', deleted: 'deleted' };

export function ActivityPage({ session }: { session: Session }) {
  const options = useAsync<Options>('/activity/options');
  const [query, setQuery] = useState<TableQuery>(emptyQuery({ sort: 'at', dir: 'desc' }));
  const [data, setData] = useState<{ entries: Entry[]; total: number } | null>(null);

  const o = options.status === 'ready' ? options.data : null;
  const seeAll = o?.can_view_all ?? false;
  const days = o?.retention_days ?? 30;

  const people = useMemo<SelectOption[]>(() => [
    { value: 'me', label: `Me (${session.user.name})` },
    ...(o?.people ?? [])
      .filter((p) => p.id !== session.user.id)
      .map((p) => ({
        value: p.id,
        label: STATUS_NOTE[p.status] ? `${p.name} (${STATUS_NOTE[p.status]})` : p.name,
        hint: p.role_name ?? undefined,
      })),
    ...(o?.integrations ? [{ value: '__integrations', label: 'Connected websites & integrations' }] : []),
  ], [o, session.user.id, session.user.name]);

  // The action list follows the module, when one is chosen.
  const module = query.filters.module ?? '';
  const actions = useMemo<SelectOption[]>(() => (o?.actions ?? [])
    .filter((a) => !module || a.module === module)
    .map((a) => ({ value: a.key, label: a.label })), [o, module]);

  const columns = useMemo<Column<Entry>[]>(() => [
    {
      key: 'at', header: 'When', sortKey: 'at', param: 'period', width: '150px',
      filter: { options: PERIODS },
      render: (r) => (
        <span title={`${new Date(r.at).toLocaleString('en-CA')}${r.ip ? ` · from ${r.ip}` : ''}`}>
          <div class="text-sm">{formatDateTime(r.at)}</div>
          <div class="cell-muted text-sm">{relativeTime(r.at)}</div>
        </span>
      ),
    },
    ...(seeAll ? [{
      key: 'actor', header: 'Person', sortKey: 'actor', param: 'user',
      filter: { options: people },
      render: (r: Entry) => (
        <span class="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <Avatar name={r.actor_name ?? '?'} />
          <span>
            <div class="cell-strong">{r.actor_user_id === session.user.id ? 'You' : r.actor_name ?? '—'}</div>
            <div class="cell-muted text-sm">{r.actor_role_name ?? ''}</div>
          </span>
        </span>
      ),
    } as Column<Entry>] : []),
    {
      key: 'module', header: 'Module', sortKey: 'module', param: 'module',
      filter: { options: (o?.modules ?? []).map((m) => ({ value: m.key, label: m.label })) },
      render: (r) => <Badge>{r.module_label}</Badge>,
    },
    {
      key: 'action', header: 'Action', sortKey: 'action', param: 'action',
      filter: { options: actions },
      render: (r) => <span class="cell-strong">{r.action_label}</span>,
    },
    {
      key: 'summary', header: 'Details', param: 'summary', sortable: false, primary: true, width: '34%',
      render: (r) => <span class="activity-summary">{r.summary}</span>,
    },
    {
      key: 'client', header: 'Client file', sortKey: 'client', param: 'client',
      render: (r) => r.application_id && r.client_name
        ? <button type="button" class="link-button" onClick={(e) => { e.stopPropagation(); navigate(`/applications/${r.application_id}`); }}>
            {r.client_name}
          </button>
        : <span class="text-muted">—</span>,
    },
  ], [o, seeAll, people, actions, session.user.id]);

  const params = queryToParams(query, columns).toString();
  const list = useAsync<{ entries: Entry[]; total: number }>(`/activity?${params}`, [params]);
  useEffect(() => { if (list.status === 'ready') setData(list.data); }, [list]);

  const whose = query.filters.actor ?? '';
  const setWhose = (value: string) => {
    const filters = { ...query.filters };
    if (value) filters.actor = value; else delete filters.actor;
    setQuery({ ...query, filters, page: 1 });
  };
  const whoseLabel = whose ? people.find((p) => p.value === whose)?.label : null;

  if (options.status === 'error') {
    return <div class="content-narrow"><ErrorNote error={options.error} code={options.code} permission={options.permission} onRetry={options.reload} /></div>;
  }

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Activity logs</h1>
          <p>
            {seeAll
              ? `What you and your staff did in the last ${days} days${whoseLabel ? ` — showing ${whoseLabel}` : ''}.`
              : `What you did in the last ${days} days.`}
          </p>
        </div>
        {seeAll && (
          <div class="activity-whose">
            <label class="text-sm text-muted" for="activity-whose">Whose activity</label>
            <SearchSelect id="activity-whose" value={whose} onChange={setWhose}
                          ariaLabel="Whose activity" searchPlaceholder="Search staff…"
                          options={[{ value: '', label: 'Everyone' }, ...people]} />
          </div>
        )}
      </div>

      <div class="activity-note text-sm">
        Entries can’t be edited or deleted. Each one is removed automatically {days} days after it happened,
        so this always shows the last {days} days. The compliance audit trail is kept separately, for as long
        as the retention settings require.
      </div>

      <div class="card">
        {list.status === 'error' && !data ? (
          <div style={{ padding: 15 }}><ErrorNote error={list.error} code={list.code} permission={list.permission} onRetry={list.reload} /></div>
        ) : (
          <DataTable<Entry>
            label="Activity logs"
            columns={columns}
            rows={data?.entries ?? []}
            total={data?.total ?? 0}
            rowKey={(r) => r.id}
            query={query}
            onQueryChange={setQuery}
            loading={list.status === 'loading'}
            initialSort={{ key: 'at', dir: 'desc' }}
            searchPlaceholder={seeAll ? 'Search people, actions, details or clients…' : 'Search actions, details or clients…'}
            onRowClick={(r) => { if (r.application_id) navigate(`/applications/${r.application_id}`); }}
            rowClass={(r) => (r.application_id ? '' : 'row-plain')}
            empty={
              <Empty title="No activity yet">
                {seeAll
                  ? `Sign-ins, changes and opened client files appear here as they happen, and stay for ${days} days.`
                  : `Your sign-ins, changes and the client files you open appear here, and stay for ${days} days.`}
              </Empty>
            }
          />
        )}
      </div>
    </div>
  );
}
