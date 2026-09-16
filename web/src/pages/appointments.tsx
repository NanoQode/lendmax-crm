/**
 * Appointments — every meeting with a client: coming up, needing an outcome,
 * attended, missed and cancelled. A list with a filter on every column, or
 * the week at a glance.
 *
 * Staff see and book meetings with their own clients. An admin sees everyone's
 * and books on behalf of any staff member — choosing the staff member first,
 * so only that person's clients are offered.
 *
 * Each person connects their own Google Calendar here: meetings they host go
 * into it with a Meet link, their busy times are checked before booking, and
 * a meeting moved or deleted in Google follows here.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ApiError, fieldErrors, get, patch, post, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, useRoute, type Session } from '../lib/store.ts';
import {
  Badge, Empty, ErrorNote, Field, Icon, ICONS, Modal, SearchSelect, Skeleton, type SelectOption,
} from '../components/ui.tsx';
import { DataTable, emptyQuery, queryToParams, type Column, type TableQuery } from '../components/data-table.tsx';

// ── Shapes ─────────────────────────────────────────────────────────────────

export type Appointment = {
  id: string; starts_at: string; ends_at: string; timezone: string; duration_minutes: number;
  appointment_type: string; type_label: string; mode: string; mode_label: string;
  status: string; status_label: string; phase: 'upcoming' | 'live' | 'needs_outcome' | 'done' | 'cancelled';
  location: string | null; meeting_url: string | null; notes: string | null; outcome: string | null;
  customer_id: string; client_name: string; client_email: string | null; client_phone: string | null;
  application_id: string | null; portal_reference: string | null; stage_label: string | null; pipeline_name: string | null;
  host_id: string | null; host_name: string | null;
  created_by: string | null; booked_by_name: string | null; created_at: string;
  confirmed_at: string | null; cancelled_at: string | null; cancelled_reason: string | null;
  outcome_at: string | null; outcome_by_name: string | null; outcome_stage_label: string | null;
  outcome_stage_note: string | null; reminder_sent_at: string | null; reschedule_count: number;
  google: 'synced' | 'error' | 'pending' | 'off'; google_sync_error: string | null; google_html_link: string | null;
  host_google_connected: boolean; can_manage: boolean;
};

export type Meta = {
  types: Array<{ key: string; label: string; minutes: number }>;
  modes: Array<{ key: string; label: string }>;
  statuses: Array<{ key: string; label: string }>;
  durations: number[];
  reminder_minutes: number;
  timezone: string;
  can: { view_all: boolean; manage: boolean; manage_all: boolean };
  google: GoogleStatus | null;
  people: Array<{ id: string; name: string; active: boolean; archived: boolean }>;
};

type GoogleStatus = {
  mode: 'live' | 'sandbox'; available: boolean; unavailable_reason: string | null;
  connected: null | { email: string; connected_at: string; last_synced_at: string | null; needs_reconnect: boolean; last_error: string | null };
};

export type ChangeResult = {
  appointment: Appointment;
  stage: { moved_to: string | null; note: string | null } | null;
  google: { synced: boolean; error: string | null } | null;
  email: { status: string; reason: string | null } | null;
};

type ListResponse = {
  appointments: Appointment[]; total: number; timezone: string;
  tabs: Record<TabKey, number>;
};

const TABS = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'needs_outcome', label: 'Needs outcome' },
  { key: 'attended', label: 'Attended' },
  { key: 'missed', label: 'Missed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
] as const;
type TabKey = typeof TABS[number]['key'];

const STATUS_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'> = {
  booked: 'info', confirmed: 'accent', completed: 'ok', no_show: 'danger', cancelled: 'neutral', rescheduled: 'neutral',
};

// ── Formatting ─────────────────────────────────────────────────────────────

const inZone = (iso: string, zone: string, options: Intl.DateTimeFormatOptions) =>
  new Date(iso).toLocaleString('en-CA', { timeZone: zone, ...options });
export const dayLabel = (iso: string, zone: string) => inZone(iso, zone, { weekday: 'short', month: 'short', day: 'numeric' });
export const timeLabel = (iso: string, zone: string) => inZone(iso, zone, { hour: 'numeric', minute: '2-digit' });
const zoneShort = (iso: string, zone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(iso))
    .find((p) => p.type === 'timeZoneName')?.value ?? zone;
const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const localParts = (iso: string, zone: string) => {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return { date, time };
};

/** One sentence for what a change did: the file's stage, Google, the email. */
export function describeResult(result: ChangeResult, verb: string): string {
  const parts = [verb];
  if (result.stage?.moved_to) parts.push(`File moved to ${result.stage.moved_to}.`);
  else if (result.stage?.note) parts.push(result.stage.note);
  if (result.google?.error) parts.push('Google Calendar did not update — it will retry.');
  if (result.email?.status === 'sent' || result.email?.status === 'queued') parts.push('The client was emailed.');
  else if (result.email?.reason) parts.push(`No email sent: ${result.email.reason}`);
  return parts.join(' ');
}

// ── The page ───────────────────────────────────────────────────────────────

export function AppointmentsPage({ session }: { session: Session }) {
  const route = useRoute();
  const meta = useAsync<Meta>('/appointments/meta');
  const [view, setView] = useState<'list' | 'week'>(route.query.get('view') === 'week' ? 'week' : 'list');
  const [tab, setTab] = useState<TabKey>('upcoming');
  const [query, setQuery] = useState<TableQuery>(emptyQuery({ sort: 'starts_at', dir: 'asc' }));
  const [data, setData] = useState<ListResponse | null>(null);
  const [nonce, setNonce] = useState(0);
  const [openId, setOpenId] = useState<string | null>(route.query.get('open'));
  const [booking, setBooking] = useState<null | { followUp?: Appointment }>(route.query.get('new') === '1' ? {} : null);
  const [editing, setEditing] = useState<Appointment | null>(null);

  // A notification link to one appointment, while already on this page.
  const openParam = route.query.get('open');
  useEffect(() => { if (openParam) setOpenId(openParam); }, [openParam]);

  // Back from Google's consent screen.
  useEffect(() => {
    const outcome = route.query.get('google');
    if (!outcome) return;
    const message = route.query.get('message');
    if (outcome === 'connected') toast(`Google Calendar connected${message ? ` (${message})` : ''}. New meetings you host will appear in it.`, 'ok');
    else toast(message || 'Google Calendar was not connected.', 'error');
    navigate('/appointments', true);
    meta.reload();
  }, []);

  const m = meta.status === 'ready' ? meta.data : null;
  const reload = () => { setNonce((n) => n + 1); };

  const people = useMemo<SelectOption[]>(() => [
    { value: 'me', label: `Me (${session.user.name})` },
    ...(m?.people ?? []).filter((p) => p.id !== session.user.id)
      .map((p) => ({ value: p.id, label: p.archived ? `${p.name} (deleted)` : p.active ? p.name : `${p.name} (inactive)` })),
  ], [m, session.user.id, session.user.name]);

  const columns = useMemo<Column<Appointment>[]>(() => {
    const zone = m?.timezone ?? viewerZone();
    const cols: Column<Appointment>[] = [
      {
        key: 'when', header: 'When', sortKey: 'starts_at', param: 'when', width: '170px',
        filter: { options: [
          { value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' },
          { value: 'this_week', label: 'This week' }, { value: 'next_7', label: 'Next 7 days' },
          { value: 'last_7', label: 'Last 7 days' }, { value: 'last_30', label: 'Last 30 days' },
        ] },
        render: (a) => (
          <span title={a.timezone !== zone ? `${timeLabel(a.starts_at, a.timezone)} ${zoneShort(a.starts_at, a.timezone)} for the client` : undefined}>
            <div class="cell-strong">{dayLabel(a.starts_at, zone)}, {timeLabel(a.starts_at, zone)}</div>
            <div class="cell-muted text-sm">{relativeTime(a.starts_at)} · {a.duration_minutes} min</div>
          </span>
        ),
      },
      {
        key: 'client', header: 'Client', sortKey: 'client', param: 'client', primary: true,
        render: (a) => (
          <>
            <div class="cell-strong">{a.client_name}</div>
            <div class="cell-muted text-sm">{[a.portal_reference, a.stage_label].filter(Boolean).join(' · ') || '—'}</div>
          </>
        ),
      },
      {
        key: 'type', header: 'Type', sortKey: 'type', param: 'type',
        filter: { options: (m?.types ?? []).map((t) => ({ value: t.key, label: t.label })) },
        render: (a) => a.type_label,
      },
      {
        key: 'mode', header: 'How', sortKey: 'mode', param: 'mode',
        filter: { options: (m?.modes ?? []).map((x) => ({ value: x.key, label: x.label })) },
        render: (a) => <span class="text-sm">{a.mode_label}</span>,
      },
    ];
    if (m?.can.view_all) {
      cols.push({
        key: 'host', header: 'With', sortKey: 'host', param: 'host',
        filter: { options: people },
        render: (a) => a.host_id === session.user.id ? 'You' : a.host_name ?? '—',
      });
    }
    cols.push({
      key: 'status', header: 'Status', sortKey: 'status', param: 'status',
      filter: { options: (m?.statuses ?? []).filter((s) => s.key !== 'rescheduled').map((s) => ({ value: s.key, label: s.label })) },
      render: (a) => (
        <span class="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <Badge tone={STATUS_TONE[a.status]}>{a.phase === 'live' ? 'In progress' : a.status_label}</Badge>
          {a.phase === 'needs_outcome' && <Badge tone="warn">Needs outcome</Badge>}
        </span>
      ),
    });
    if (m?.can.view_all) {
      cols.push({
        key: 'booked_by', header: 'Booked by', sortKey: 'booked_by', param: 'booked_by',
        filter: { options: people },
        render: (a) => <span class="text-sm">{a.created_by === session.user.id ? 'You' : a.booked_by_name ?? '—'}</span>,
      });
    }
    cols.push({
      key: 'google', header: 'Google', param: 'google', sortable: false,
      filter: { options: [
        { value: 'synced', label: 'In Google Calendar' }, { value: 'error', label: 'Sync failed' },
        { value: 'off', label: 'Not in Google' },
      ] },
      render: (a) => a.google === 'synced' ? <Badge tone="ok">Synced</Badge>
        : a.google === 'error' ? <Badge tone="danger">Failed</Badge>
          : <span class="text-muted text-sm">—</span>,
    });
    return cols;
  }, [m, people, session.user.id]);

  const params = queryToParams(query, columns, { tab }).toString();
  const list = useAsync<ListResponse>(view === 'list' ? `/appointments?${params}` : null, [params, nonce, view]);
  useEffect(() => { if (list.status === 'ready') setData(list.data); }, [list]);

  const switchTab = (key: TabKey) => {
    setTab(key);
    // Upcoming reads soonest first; what has happened, most recent first.
    setQuery({ ...query, page: 1, sort: 'starts_at', dir: key === 'upcoming' ? 'asc' : 'desc' });
  };

  if (meta.status === 'error') {
    return <div class="content-narrow"><ErrorNote error={meta.error} code={meta.code} permission={meta.permission} onRetry={meta.reload} /></div>;
  }

  const canBook = !!m && (m.can.manage || m.can.manage_all);

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Appointments</h1>
          <p>
            {m?.can.view_all ? 'Every meeting with a client, for the whole team.' : 'Your meetings with your clients.'}
            {m && ` Clients and hosts are reminded ${m.reminder_minutes} minutes before.`}
          </p>
        </div>
        <div class="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div class="seg" role="group" aria-label="View">
            <button class={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>List</button>
            <button class={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>Week</button>
          </div>
          {canBook && (
            <button class="btn btn-primary" onClick={() => setBooking({})}>
              <Icon path={ICONS.plus} /> Book appointment
            </button>
          )}
        </div>
      </div>

      {m?.google && <GoogleCard status={m.google} onChanged={() => { meta.reload(); reload(); }} />}

      {view === 'list' ? (
        <>
          <div class="purpose-tabs" role="tablist" aria-label="Appointments">
            {TABS.map((t) => (
              <button key={t.key} class="purpose-tab" role="tab" aria-selected={tab === t.key} onClick={() => switchTab(t.key)}>
                {t.label} <span class={`n${t.key === 'needs_outcome' && (data?.tabs.needs_outcome ?? 0) > 0 ? ' n-warn' : ''}`}>
                  {data?.tabs[t.key] ?? '·'}
                </span>
              </button>
            ))}
          </div>
          <div class="card">
            {list.status === 'error' && !data ? (
              <div style={{ padding: 15 }}><ErrorNote error={list.error} code={list.code} permission={list.permission} onRetry={list.reload} /></div>
            ) : (
              <DataTable<Appointment>
                label="Appointments"
                columns={columns}
                rows={data?.appointments ?? []}
                total={data?.total ?? 0}
                rowKey={(a) => a.id}
                query={query}
                onQueryChange={setQuery}
                loading={list.status === 'loading'}
                initialSort={{ key: 'when', dir: 'asc' }}
                searchPlaceholder="Client, reference, host, notes or place…"
                onRowClick={(a) => setOpenId(a.id)}
                rowClass={(a) => (a.phase === 'cancelled' ? 'row-dim' : a.phase === 'needs_outcome' ? 'row-attention' : '')}
                empty={
                  <Empty title={tab === 'upcoming' ? 'Nothing booked' : 'No appointments here'}
                         action={canBook && tab === 'upcoming'
                           ? <button class="btn btn-primary" onClick={() => setBooking({})}>Book appointment</button> : undefined}>
                    {tab === 'upcoming'
                      ? 'Book a meeting with a client here or from their file. They get a confirmation and a reminder before it starts.'
                      : 'Appointments appear here as they happen.'}
                  </Empty>
                }
              />
            )}
          </div>
        </>
      ) : (
        <WeekView meta={m} session={session} nonce={nonce} onOpen={setOpenId} />
      )}

      {openId && (
        <AppointmentDetail id={openId} meta={m} session={session}
                           onClose={() => { setOpenId(null); if (route.query.get('open')) navigate('/appointments', true); }}
                           onChanged={reload}
                           onEdit={(a) => { setOpenId(null); setEditing(a); }}
                           onBookAgain={(a) => { setOpenId(null); setBooking({ followUp: a }); }} />
      )}
      {booking && m && (
        <BookingForm meta={m} session={session} followUp={booking.followUp}
                     onClose={() => setBooking(null)}
                     onDone={(result) => { setBooking(null); toast(describeResult(result, 'Appointment booked.'), 'ok'); reload(); }} />
      )}
      {editing && m && (
        <BookingForm meta={m} session={session} editing={editing}
                     onClose={() => setEditing(null)}
                     onDone={(result) => { setEditing(null); toast(describeResult(result, 'Appointment updated.'), 'ok'); reload(); }} />
      )}
    </div>
  );
}

// ── Google Calendar ────────────────────────────────────────────────────────

function GoogleCard({ status, onChanged }: { status: GoogleStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await post<{ url: string }>('/integrations/google/connect');
      window.location.href = url;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the Google sign-in.', 'error');
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!confirm('Disconnect Google Calendar? Meetings already in it stay there, but new ones will not be added.')) return;
    setBusy(true);
    try { await post('/integrations/google/disconnect'); toast('Google Calendar disconnected.', 'ok'); onChanged(); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not disconnect.', 'error'); }
    finally { setBusy(false); }
  };
  const syncNow = async () => {
    setBusy(true);
    try {
      const { applied } = await post<{ applied: number }>('/integrations/google/sync');
      toast(applied ? `${applied} change${applied === 1 ? '' : 's'} from Google applied.` : 'Up to date with Google Calendar.', 'ok');
      onChanged();
    } catch (err) { toast(err instanceof Error ? err.message : 'Could not reach Google.', 'error'); }
    finally { setBusy(false); }
  };

  const c = status.connected;
  const testMode = status.mode === 'sandbox';
  return (
    <div class={`google-card${c?.needs_reconnect ? ' google-card-warn' : ''}`}>
      <div class="google-card-icon" aria-hidden="true"><Icon path={ICONS.calendar} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {c ? (
          <>
            <div class="cell-strong">
              Google Calendar {c.needs_reconnect ? 'needs reconnecting' : 'connected'} · {c.email}
              {testMode && <> <Badge tone="warn">Test mode</Badge></>}
            </div>
            <div class="text-sm text-muted">
              {c.needs_reconnect
                ? `Google stopped accepting the connection${c.last_error ? ` (${c.last_error})` : ''}. Reconnect to keep meetings in your calendar.`
                : `Meetings you host go into this calendar with a Meet link; moves and deletions there come back here.${c.last_synced_at ? ` Last checked ${relativeTime(c.last_synced_at)}.` : ''}`}
            </div>
          </>
        ) : (
          <>
            <div class="cell-strong">Connect your Google Calendar {testMode && <Badge tone="warn">Test mode</Badge>}</div>
            <div class="text-sm text-muted">
              {status.available
                ? 'Meetings you host appear in your calendar with a Google Meet link, the client gets a calendar invite, and your busy times are checked before anyone books you.'
                : status.unavailable_reason}
              {testMode && ' Test mode: no real Google account is used.'}
            </div>
          </>
        )}
      </div>
      <div class="row" style={{ gap: 6 }}>
        {c && !c.needs_reconnect && <button class="btn btn-sm" disabled={busy} onClick={syncNow}>Check now</button>}
        {c && <button class="btn btn-sm" disabled={busy} onClick={disconnect}>Disconnect</button>}
        {(!c || c.needs_reconnect) && status.available && (
          <button class="btn btn-primary btn-sm" disabled={busy} onClick={connect}>{c ? 'Reconnect' : 'Connect Google Calendar'}</button>
        )}
      </div>
    </div>
  );
}

// ── Week ───────────────────────────────────────────────────────────────────

const startOfWeek = (d: Date) => {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};

function WeekView({ meta, session, nonce, onOpen }: {
  meta: Meta | null; session: Session; nonce: number; onOpen: (id: string) => void;
}) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [host, setHost] = useState(meta?.can.view_all ? '' : 'me');
  const from = weekStart.toISOString();
  const to = new Date(weekStart.getTime() + 7 * 86_400_000).toISOString();
  const qs = new URLSearchParams({ tab: 'all', from, to, sort: 'starts_at', dir: 'asc', page_size: '200' });
  if (host) qs.set('host', host);
  const state = useAsync<ListResponse>(`/appointments?${qs}`, [from, host, nonce]);
  const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * 86_400_000));
  const zone = viewerZone();
  const sameDay = (iso: string, d: Date) => new Date(iso).toDateString() === d.toDateString();
  const today = new Date().toDateString();

  return (
    <>
      <div class="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button class="btn btn-sm" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * 86_400_000))} aria-label="Previous week">←</button>
        <button class="btn btn-sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>This week</button>
        <button class="btn btn-sm" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * 86_400_000))} aria-label="Next week">→</button>
        <span class="cell-strong" style={{ marginLeft: 6 }}>
          {weekStart.toLocaleDateString('en-CA', { month: 'long', day: 'numeric' })} – {days[6]!.toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' })}
        </span>
        {meta?.can.view_all && (
          <div style={{ marginLeft: 'auto', minWidth: 220 }}>
            <SearchSelect value={host} onChange={setHost} ariaLabel="Whose week" searchPlaceholder="Search staff…"
                          options={[{ value: '', label: 'Everyone' }, { value: 'me', label: `Me (${session.user.name})` },
                                    ...meta.people.filter((p) => p.id !== session.user.id && !p.archived).map((p) => ({ value: p.id, label: p.name }))]} />
          </div>
        )}
      </div>
      {state.status === 'loading' && <Skeleton rows={3} height={90} />}
      {state.status === 'error' && <ErrorNote error={state.error} code={state.code} permission={state.permission} onRetry={state.reload} />}
      {state.status === 'ready' && (
        <div class="week">
          {days.map((day) => {
            const items = state.data.appointments.filter((a) => sameDay(a.starts_at, day));
            return (
              <div key={day.toISOString()} class={`week-day${day.toDateString() === today ? ' week-today' : ''}`}>
                <div class="week-head">
                  <span class="week-dow">{day.toLocaleDateString('en-CA', { weekday: 'short' })}</span>
                  <span class="week-date num">{day.getDate()}</span>
                </div>
                <div class="week-body">
                  {items.length === 0 && <div class="week-empty">—</div>}
                  {items.map((a) => (
                    <button key={a.id} class={`appointment appointment-${a.status}${a.phase === 'needs_outcome' ? ' appointment-attention' : ''}`} onClick={() => onOpen(a.id)}>
                      <span class="appointment-time">{timeLabel(a.starts_at, zone)}</span>
                      <span class="appointment-who">{a.client_name}</span>
                      <span class="appointment-type">{a.type_label}{meta?.can.view_all && a.host_name ? ` · ${a.host_id === session.user.id ? 'You' : a.host_name}` : ''}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── One appointment ────────────────────────────────────────────────────────

export function AppointmentDetail({ id, meta, session, onClose, onChanged, onEdit, onBookAgain }: {
  id: string; meta: Meta | null; session: Session; onClose: () => void; onChanged: () => void;
  onEdit: (a: Appointment) => void; onBookAgain: (a: Appointment) => void;
}) {
  const state = useAsync<{ appointment: Appointment }>(`/appointments/${id}`, [id]);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  if (state.status !== 'ready') {
    return (
      <Modal title="Appointment" onClose={onClose}>
        {state.status === 'loading' ? <Skeleton rows={4} /> : <ErrorNote error={state.error} code={state.code} permission={state.permission} onRetry={state.reload} />}
      </Modal>
    );
  }
  const a = state.data.appointment;
  const zone = a.timezone;
  const mine = viewerZone();

  const act = async (fn: () => Promise<ChangeResult | { appointment: Appointment }>, verb: string) => {
    setBusy(true);
    try {
      const result = await fn();
      toast('stage' in result ? describeResult(result as ChangeResult, verb) : verb, 'ok');
      onChanged();
      state.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const outcome = (o: 'attended' | 'missed') =>
    act(() => post<ChangeResult>(`/appointments/${a.id}/outcome`, { outcome: o }), o === 'attended' ? 'Marked attended.' : 'Marked missed.');

  const started = a.phase === 'live' || a.phase === 'needs_outcome';
  const open = a.status === 'booked' || a.status === 'confirmed';

  return (
    <Modal title={`${a.type_label} — ${a.client_name}`} onClose={onClose} wide
           footer={
             <div class="row" style={{ gap: 8, flexWrap: 'wrap', width: '100%' }}>
               {a.application_id && (
                 <button class="btn" onClick={() => navigate(`/applications/${a.application_id}`)}>Open client file</button>
               )}
               <span style={{ flex: 1 }} />
               {a.can_manage && open && started && (
                 <>
                   <button class="btn" disabled={busy} onClick={() => outcome('missed')}>Missed</button>
                   <button class="btn btn-primary" disabled={busy} onClick={() => outcome('attended')}>Attended</button>
                 </>
               )}
               {a.can_manage && open && (
                 <>
                   <button class="btn" disabled={busy} onClick={() => setCancelling(true)}>Cancel meeting</button>
                   <button class="btn" disabled={busy} onClick={() => onEdit(a)}>{started ? 'Reschedule' : 'Reschedule / edit'}</button>
                 </>
               )}
               {a.can_manage && open && !started && a.status === 'booked' && (
                 <button class="btn btn-primary" disabled={busy}
                         onClick={() => act(() => post(`/appointments/${a.id}/confirm`), 'Marked confirmed.')}>Client confirmed</button>
               )}
               {a.can_manage && (a.status === 'completed' || a.status === 'no_show') && (
                 <button class="btn" disabled={busy} onClick={() => outcome(a.status === 'completed' ? 'missed' : 'attended')}>
                   Change to {a.status === 'completed' ? 'missed' : 'attended'}
                 </button>
               )}
               {a.can_manage && !open && a.application_id && (meta?.can.manage || meta?.can.manage_all) && (
                 <button class="btn btn-primary" onClick={() => onBookAgain(a)}>Book again</button>
               )}
             </div>
           }>
      <div class="appointment-detail">
        <div class="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <Badge tone={STATUS_TONE[a.status]}>{a.phase === 'live' ? 'In progress' : a.status_label}</Badge>
          {a.phase === 'needs_outcome' && <Badge tone="warn">Needs outcome — did they attend?</Badge>}
          {a.reschedule_count > 0 && <Badge>Moved {a.reschedule_count}×</Badge>}
        </div>
        <dl class="detail-list">
          <dt>When</dt>
          <dd>
            {new Date(a.starts_at).toLocaleString('en-CA', { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {' '}{zoneShort(a.starts_at, zone)} · {a.duration_minutes} minutes
            {zone !== mine && <div class="text-sm text-muted">{timeLabel(a.starts_at, mine)} your time</div>}
          </dd>
          <dt>How</dt>
          <dd>
            {a.mode_label}
            {a.mode === 'video' && (a.meeting_url
              ? <> — <a href={a.meeting_url} target="_blank" rel="noopener noreferrer">{a.meeting_url}</a></>
              : <span class="text-muted"> — no link yet</span>)}
            {a.mode === 'phone' && ` — ${a.location ?? a.client_phone ?? 'no number'}`}
            {a.mode === 'in_person' && ` — ${a.location ?? 'no address'}`}
          </dd>
          <dt>With</dt><dd>{a.host_id === session.user.id ? 'You' : a.host_name ?? '—'}</dd>
          <dt>Client</dt>
          <dd>
            {a.client_name}{a.portal_reference ? ` · ${a.portal_reference}` : ''}
            <div class="text-sm text-muted">{[a.client_email, a.client_phone].filter(Boolean).join(' · ') || 'No email or phone'}</div>
            {a.stage_label && <div class="text-sm text-muted">Now at {a.pipeline_name ? `${a.pipeline_name} · ` : ''}{a.stage_label}</div>}
          </dd>
          <dt>Booked</dt><dd>{a.booked_by_name ? `by ${a.created_by === session.user.id ? 'you' : a.booked_by_name}, ` : ''}{relativeTime(a.created_at)}</dd>
          {open && (
            <>
              <dt>Reminder</dt>
              <dd>{a.reminder_sent_at ? `Sent ${relativeTime(a.reminder_sent_at)}` : `Emailed to the client and host ${meta?.reminder_minutes ?? 15} minutes before`}</dd>
            </>
          )}
          <dt>Google</dt>
          <dd>
            {a.google === 'synced' && <>In {a.host_name ?? 'the host'}’s Google Calendar{a.google_html_link && <> · <a href={a.google_html_link} target="_blank" rel="noopener noreferrer">Open</a></>}</>}
            {a.google === 'error' && (
              <span class="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--danger-text)' }}>Not updated: {a.google_sync_error}</span>
                {a.can_manage && <button class="link-button text-sm" disabled={busy}
                                         onClick={() => act(() => post(`/appointments/${a.id}/google-retry`), 'Tried Google again.')}>Retry</button>}
              </span>
            )}
            {a.google === 'pending' && 'Waiting to be added'}
            {a.google === 'off' && <span class="text-muted">{a.host_google_connected ? 'Not in Google Calendar' : `${a.host_id === session.user.id ? 'You haven’t' : `${a.host_name ?? 'The host'} hasn’t`} connected Google Calendar`}</span>}
          </dd>
          {(a.status === 'completed' || a.status === 'no_show') && (
            <>
              <dt>Outcome</dt>
              <dd>
                {a.status === 'completed' ? 'Attended' : 'Missed'}{a.outcome_by_name ? ` — recorded by ${a.outcome_by_name}` : ''}{a.outcome_at ? `, ${relativeTime(a.outcome_at)}` : ''}
                {a.outcome_stage_label && <div class="text-sm text-muted">File moved to {a.outcome_stage_label}</div>}
                {a.outcome_stage_note && <div class="text-sm text-muted">{a.outcome_stage_note}</div>}
                {a.outcome && <div class="text-sm">{a.outcome}</div>}
              </dd>
            </>
          )}
          {a.status === 'cancelled' && <><dt>Cancelled</dt><dd>{relativeTime(a.cancelled_at)}{a.cancelled_reason ? ` — ${a.cancelled_reason}` : ''}</dd></>}
          {a.notes && <><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{a.notes}</dd></>}
        </dl>
      </div>
      {cancelling && (
        <CancelForm appointment={a} onClose={() => setCancelling(false)}
                    onDone={(result) => { setCancelling(false); toast(describeResult(result, 'Appointment cancelled.'), 'ok'); onChanged(); state.reload(); }} />
      )}
    </Modal>
  );
}

function CancelForm({ appointment, onClose, onDone }: {
  appointment: Appointment; onClose: () => void; onDone: (r: ChangeResult) => void;
}) {
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErrors({});
    try { onDone(await post<ChangeResult>(`/appointments/${appointment.id}/cancel`, { reason, notify_client: notify })); }
    catch (err) { setErrors(fieldErrors(err, 'Could not cancel.')); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Cancel this meeting?" onClose={onClose}
           footer={<>
             <button class="btn" onClick={onClose}>Keep it</button>
             <button class="btn btn-danger" disabled={busy} onClick={submit}>Cancel meeting</button>
           </>}>
      <p class="text-sm" style={{ marginTop: 0 }}>
        {appointment.type_label} with {appointment.client_name}, {dayLabel(appointment.starts_at, appointment.timezone)} at {timeLabel(appointment.starts_at, appointment.timezone)}.
        {appointment.google === 'synced' && ' It is removed from Google Calendar too.'}
      </p>
      {errors._ && <div class="alert alert-error">{errors._}</div>}
      <Field label="Why?" error={errors.reason} hint="Kept on the file. Not sent to the client.">
        <input value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)}
               placeholder="Client asked to postpone" maxLength={500} />
      </Field>
      <label class="check">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify((e.target as HTMLInputElement).checked)}
               disabled={!appointment.client_email} />
        <span>{appointment.client_email ? `Email ${appointment.client_name} that it is cancelled` : 'The client has no email address'}</span>
      </label>
    </Modal>
  );
}

// ── Booking and editing ────────────────────────────────────────────────────

type Host = { id: string; name: string; role: string; timezone: string | null; google_connected: boolean; clients: number };
type File = { id: string; name: string; email: string | null; phone: string | null; reference: string | null;
              stage_label: string | null; pipeline_name: string | null; settled: boolean };
type Availability = { timezone: string; crm: Array<{ start: string; end: string; label: string }>;
                      google: Array<{ start: string; end: string; label: string }> | null; google_connected: boolean };

const ZONES = ['America/St_Johns', 'America/Halifax', 'America/Toronto', 'America/Winnipeg', 'America/Regina',
               'America/Edmonton', 'America/Vancouver'];

const todayIn = (zone: string) => localParts(new Date().toISOString(), zone).date;

/**
 * Book a meeting, or change one. The host comes first for someone booking
 * on behalf of others, because the host decides which clients are offered.
 */
export function BookingForm({ meta, session, editing, followUp, initial, onClose, onDone }: {
  meta: Meta; session: Session; editing?: Appointment; followUp?: Appointment;
  initial?: { application_id?: string; host?: string | null };
  onClose: () => void; onDone: (r: ChangeResult) => void;
}) {
  const source = editing ?? followUp;
  const zone0 = editing?.timezone ?? meta.timezone;
  const start0 = editing ? localParts(editing.starts_at, editing.timezone) : null;
  const [form, setForm] = useState({
    // Someone who books for others starts with the file's broker; everyone else hosts their own.
    host: editing?.host_id ?? followUp?.host_id ?? (meta.can.manage_all ? initial?.host : null)
      ?? (meta.can.manage || !meta.can.manage_all ? session.user.id : ''),
    application_id: editing?.application_id ?? followUp?.application_id ?? initial?.application_id ?? '',
    appointment_type: source?.appointment_type ?? 'discovery',
    mode: source?.mode ?? 'video',
    date: start0?.date ?? '',
    time: start0?.time ?? '',
    duration: String(editing?.duration_minutes ?? meta.types.find((t) => t.key === (source?.appointment_type ?? 'discovery'))?.minutes ?? 30),
    timezone: zone0,
    location: source?.location ?? '',
    meeting_url: source?.meeting_url && !source.meeting_url.startsWith('https://meet.google.com/') ? source.meeting_url : '',
    own_link: !!(source?.meeting_url && !source.meeting_url.startsWith('https://meet.google.com/')),
    notes: editing?.notes ?? '',
    notify: true,
  });
  const [durationTouched, setDurationTouched] = useState(!!editing);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyWarning, setBusyWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const hosts = useAsync<{ hosts: Host[] }>(meta.can.manage_all ? '/appointments/hosts' : null);
  const hostList = hosts.status === 'ready' ? hosts.data.hosts : [];
  const host = hostList.find((h) => h.id === form.host);
  const hostGoogle = host?.google_connected ?? (form.host === session.user.id ? !!meta.google?.connected && !meta.google.connected.needs_reconnect : false);
  const hostName = form.host === session.user.id ? 'You' : host?.name ?? 'The host';

  const files = useAsync<{ files: File[] }>(!editing && form.host ? `/appointments/files?host=${form.host}` : null, [form.host]);
  const fileList = files.status === 'ready' ? files.data.files : [];
  const file = fileList.find((f) => f.id === form.application_id);

  // A different host has different clients; a chosen file that is not theirs is cleared.
  useEffect(() => {
    if (!editing && files.status === 'ready' && form.application_id && !fileList.some((f) => f.id === form.application_id)) {
      set('application_id', '');
    }
  }, [files.status, form.host]);

  const avail = useAsync<Availability>(form.host && form.date
    ? `/appointments/availability?host=${form.host}&date=${form.date}&timezone=${encodeURIComponent(form.timezone)}${editing ? `&exclude=${editing.id}` : ''}`
    : null, [form.host, form.date, form.timezone]);

  const hostOptions: SelectOption[] = hostList.map((h) => ({
    value: h.id,
    label: h.id === session.user.id ? `${h.name} (you)` : h.name,
    hint: `${h.clients} client${h.clients === 1 ? '' : 's'}${h.google_connected ? ' · Google Calendar' : ''}`,
  }));
  const fileOptions: SelectOption[] = fileList.map((f) => ({
    value: f.id,
    label: `${f.name}${f.reference ? ` — ${f.reference}` : ''}`,
    hint: [f.pipeline_name, f.stage_label, f.email].filter(Boolean).join(' · '),
  }));
  const zoneOptions: SelectOption[] = [...new Set([form.timezone, host?.timezone, ...ZONES].filter(Boolean) as string[])]
    .map((z) => ({ value: z, label: `${z.replace('America/', '').replace('_', ' ')} (${zoneShort(new Date().toISOString(), z)})` }));

  const submit = async (allowConflict = false) => {
    setSaving(true); setErrors({}); if (!allowConflict) setBusyWarning(null);
    const body: Record<string, unknown> = {
      appointment_type: form.appointment_type,
      mode: form.mode,
      date: form.date || undefined,
      time: form.time || undefined,
      timezone: form.timezone,
      duration_minutes: Number(form.duration),
      location: form.mode === 'video' ? null : form.location,
      meeting_url: form.mode === 'video' && (form.own_link || !hostGoogle) ? form.meeting_url : null,
      notes: form.notes,
      notify_client: form.notify,
      allow_conflict: allowConflict,
    };
    try {
      if (editing) {
        if (meta.can.manage_all && form.host !== editing.host_id) body.user_id = form.host;
        onDone(await patch<ChangeResult>(`/appointments/${editing.id}`, body));
      } else {
        onDone(await post<ChangeResult>('/appointments', {
          ...body, application_id: form.application_id || undefined, user_id: form.host || undefined,
          follow_up_of: followUp?.id,
        }));
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'calendar_busy') setBusyWarning(err.message);
      else setErrors(fieldErrors(err, 'Could not save the appointment.'));
    } finally {
      setSaving(false);
    }
  };

  const clientEmail = editing?.client_email ?? file?.email ?? null;
  const title = editing ? `Change the meeting with ${editing.client_name}` : followUp ? `Book again with ${followUp.client_name}` : 'Book an appointment';
  const fmt = (iso: string) => timeLabel(iso, avail.status === 'ready' ? avail.data.timezone : form.timezone);

  return (
    <Modal title={title} onClose={onClose} wide
           footer={<>
             <button class="btn" onClick={onClose}>Cancel</button>
             <button class="btn btn-primary" disabled={saving} onClick={() => submit(false)}>
               {saving ? 'Saving…' : editing ? 'Save changes' : 'Book appointment'}
             </button>
           </>}>
      {errors._ && <div class="alert alert-error">{errors._}</div>}
      {busyWarning && (
        <div class="usage" role="alert">
          <div>{busyWarning}</div>
          <div class="row" style={{ gap: 8, marginTop: 8 }}>
            <button class="btn btn-sm btn-primary" disabled={saving} onClick={() => submit(true)}>Book anyway</button>
            <button class="btn btn-sm" onClick={() => setBusyWarning(null)}>Choose another time</button>
          </div>
        </div>
      )}
      <div class="form-grid">
        {meta.can.manage_all ? (
          <Field label="With (staff member)" error={errors.user_id}
                 hint={editing ? undefined : 'Only this person’s clients are offered below.'}>
            <SearchSelect value={form.host} onChange={(v) => set('host', v)} options={hostOptions}
                          placeholder={hosts.status === 'loading' ? 'Loading staff…' : 'Choose who the meeting is with'}
                          searchPlaceholder="Search staff…" ariaLabel="Staff member" invalid={!!errors.user_id} />
          </Field>
        ) : (
          <Field label="With"><div class="static-field">You</div></Field>
        )}
        {editing ? (
          <Field label="Client"><div class="static-field">{editing.client_name}{editing.portal_reference ? ` — ${editing.portal_reference}` : ''}</div></Field>
        ) : (
          <Field label="Client file" error={errors.application_id}
                 hint={form.host && files.status === 'ready' && !fileList.length
                   ? `${hostName === 'You' ? 'You have' : `${hostName} has`} no clients assigned yet.` : undefined}>
            <SearchSelect value={form.application_id} onChange={(v) => set('application_id', v)} options={fileOptions}
                          disabled={!form.host || !!followUp}
                          placeholder={!form.host ? 'Choose the staff member first' : files.status === 'loading' ? 'Loading clients…' : 'Choose the client'}
                          searchPlaceholder="Name, email or reference…" ariaLabel="Client file" invalid={!!errors.application_id} />
          </Field>
        )}
        <Field label="Type" error={errors.appointment_type}>
          <SearchSelect value={form.appointment_type} ariaLabel="Appointment type"
                        onChange={(v) => {
                          set('appointment_type', v);
                          if (!durationTouched) set('duration', String(meta.types.find((t) => t.key === v)?.minutes ?? 30));
                        }}
                        options={meta.types.map((t) => ({ value: t.key, label: t.label, hint: `${t.minutes} min` }))} />
        </Field>
        <Field label="How" error={errors.mode}>
          <div class="seg seg-full" role="radiogroup" aria-label="How">
            {meta.modes.map((x) => (
              <button key={x.key} type="button" role="radio" aria-checked={form.mode === x.key}
                      class={form.mode === x.key ? 'active' : ''} onClick={() => set('mode', x.key)}>{x.label}</button>
            ))}
          </div>
        </Field>
      </div>

      {form.mode === 'video' && (
        hostGoogle && !form.own_link ? (
          <div class="text-sm note-line">
            A Google Meet link is created in {hostName === 'You' ? 'your' : `${hostName}’s`} Google Calendar and sent to the client.{' '}
            <button class="link-button text-sm" onClick={() => set('own_link', true)}>Use another link (Zoom, Teams…)</button>
          </div>
        ) : (
          <Field label="Video link" error={errors.meeting_url}
                 hint={hostGoogle ? undefined : `${hostName === 'You' ? 'You haven’t' : `${hostName} hasn’t`} connected Google Calendar, so paste the link to use.`}>
            <input value={form.meeting_url} placeholder="https://zoom.us/j/…" type="url"
                   onInput={(e) => set('meeting_url', (e.target as HTMLInputElement).value)} />
            {hostGoogle && <button class="link-button text-sm" style={{ marginTop: 4 }} onClick={() => { set('own_link', false); set('meeting_url', ''); }}>Use Google Meet instead</button>}
          </Field>
        )
      )}
      {form.mode === 'phone' && (
        <Field label="Number to call" error={errors.location}
               hint={file?.phone || editing?.client_phone ? `Leave blank to call the client’s number (${file?.phone ?? editing?.client_phone}).` : 'The client has no phone number on file.'}>
          <input value={form.location} placeholder={file?.phone ?? editing?.client_phone ?? '+1 416 555 0142'}
                 onInput={(e) => set('location', (e.target as HTMLInputElement).value)} />
        </Field>
      )}
      {form.mode === 'in_person' && (
        <Field label="Address" error={errors.location}>
          <input value={form.location} placeholder="123 King St W, Toronto"
                 onInput={(e) => set('location', (e.target as HTMLInputElement).value)} />
        </Field>
      )}

      <div class="form-grid form-grid-4">
        <Field label="Date" error={errors.date}>
          <input type="date" value={form.date} min={todayIn(form.timezone)}
                 onInput={(e) => set('date', (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Start" error={errors.time ?? errors.starts_at}>
          <input type="time" value={form.time} step={300}
                 onInput={(e) => set('time', (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Length" error={errors.duration_minutes}>
          <SearchSelect value={form.duration} ariaLabel="Length"
                        onChange={(v) => { setDurationTouched(true); set('duration', v); }}
                        options={[...new Set([...meta.durations, Number(form.duration)])].sort((x, y) => x - y)
                          .map((d) => ({ value: String(d), label: d < 60 ? `${d} min` : `${d / 60} h`.replace('.5 h', ' h 30') }))} />
        </Field>
        <Field label="Time zone" error={errors.timezone}>
          <SearchSelect value={form.timezone} onChange={(v) => set('timezone', v)} options={zoneOptions} ariaLabel="Time zone" />
        </Field>
      </div>

      {form.host && form.date && (
        <div class="availability">
          <div class="text-sm cell-strong">{hostName === 'You' ? 'Your' : `${hostName}’s`} day</div>
          {avail.status === 'loading' && <div class="text-sm text-muted">Checking…</div>}
          {avail.status === 'ready' && (
            avail.data.crm.length || avail.data.google?.length ? (
              <ul>
                {[...avail.data.crm, ...(avail.data.google ?? [])].sort((x, y) => x.start.localeCompare(y.start)).map((b) => (
                  <li key={b.start + b.label}><span class="num">{fmt(b.start)}–{fmt(b.end)}</span> {b.label}</li>
                ))}
              </ul>
            ) : <div class="text-sm text-muted">Nothing booked that day{avail.data.google_connected ? ', and free in Google Calendar' : ''}.</div>
          )}
          {avail.status === 'ready' && !avail.data.google_connected && (
            <div class="text-sm text-muted">Google Calendar isn’t connected, so only CRM meetings are shown.</div>
          )}
        </div>
      )}

      <Field label="Notes (for staff only)" error={errors.notes}>
        <textarea rows={2} value={form.notes} maxLength={2000}
                  onInput={(e) => set('notes', (e.target as HTMLTextAreaElement).value)} />
      </Field>
      <label class="check">
        <input type="checkbox" checked={form.notify && !!clientEmail} disabled={!clientEmail}
               onChange={(e) => set('notify', (e.target as HTMLInputElement).checked)} />
        <span>
          {!clientEmail ? (form.application_id || editing ? 'The client has no email address, so no confirmation or reminder email can be sent.' : 'Email the client a confirmation')
            : editing ? 'If the time changes, email the client the new time' : `Email ${file?.name ?? 'the client'} a confirmation`}
        </span>
      </label>
    </Modal>
  );
}

// ── A file's appointments (the client page's tab) ──────────────────────────

export function FileAppointments({ applicationId, session, clientName, hostId = null, bookRequested = false, onBookingOpened, onChanged }: {
  applicationId: string; session: Session; clientName: string; hostId?: string | null;
  bookRequested?: boolean; onBookingOpened?: () => void; onChanged?: () => void;
}) {
  const meta = useAsync<Meta>('/appointments/meta');
  const [nonce, setNonce] = useState(0);
  const list = useAsync<ListResponse>(`/appointments?application_id=${applicationId}&tab=all&sort=starts_at&dir=desc&page_size=100`, [nonce]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [booking, setBooking] = useState<null | { followUp?: Appointment }>(null);
  const [editing, setEditing] = useState<Appointment | null>(null);
  const m = meta.status === 'ready' ? meta.data : null;
  // A booking changes the file's stage and next meeting, so the page around it reloads too.
  const reload = () => { setNonce((n) => n + 1); onChanged?.(); };
  // "Book appointment" in the file's header: a one-off request, handed back once taken.
  useEffect(() => { if (bookRequested) { setBooking({}); onBookingOpened?.(); } }, [bookRequested]);

  if (meta.status === 'error') return <ErrorNote error={meta.error} code={meta.code} permission={meta.permission} onRetry={meta.reload} />;
  const columns: Column<Appointment>[] = [
    { key: 'when', header: 'When', value: (a) => a.starts_at, primary: true, filter: false,
      render: (a) => <><div class="cell-strong">{dayLabel(a.starts_at, a.timezone)}, {timeLabel(a.starts_at, a.timezone)}</div>
                       <div class="cell-muted text-sm">{relativeTime(a.starts_at)}</div></> },
    { key: 'type', header: 'Type', value: (a) => a.type_label, filter: 'auto' },
    { key: 'mode', header: 'How', value: (a) => a.mode_label, filter: 'auto' },
    { key: 'host', header: 'With', value: (a) => a.host_name, filter: 'auto' },
    { key: 'status', header: 'Status', value: (a) => a.status_label, filter: 'auto',
      render: (a) => <Badge tone={STATUS_TONE[a.status]}>{a.phase === 'live' ? 'In progress' : a.status_label}</Badge> },
  ];
  return (
    <div class="card">
      <div class="card-head row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Appointments</h3>
        {m && (m.can.manage || m.can.manage_all) && (
          <button class="btn btn-primary btn-sm" onClick={() => setBooking({})}><Icon path={ICONS.plus} /> Book appointment</button>
        )}
      </div>
      {list.status === 'loading' && <Skeleton rows={2} />}
      {list.status === 'error' && <div style={{ padding: 15 }}><ErrorNote error={list.error} code={list.code} permission={list.permission} onRetry={list.reload} /></div>}
      {list.status === 'ready' && (
        <DataTable<Appointment> label={`Appointments with ${clientName}`} columns={columns} rows={list.data.appointments}
                                rowKey={(a) => a.id} compact initialSort={{ key: 'when', dir: 'desc' }}
                                onRowClick={(a) => setOpenId(a.id)}
                                empty={<Empty title="No appointments yet">Meetings with {clientName} appear here.</Empty>} />
      )}
      {openId && (
        <AppointmentDetail id={openId} meta={m} session={session} onClose={() => setOpenId(null)} onChanged={reload}
                           onEdit={(a) => { setOpenId(null); setEditing(a); }}
                           onBookAgain={(a) => { setOpenId(null); setBooking({ followUp: a }); }} />
      )}
      {booking && m && (
        <BookingForm meta={m} session={session} followUp={booking.followUp} initial={{ application_id: applicationId, host: hostId }}
                     onClose={() => setBooking(null)}
                     onDone={(r) => { setBooking(null); toast(describeResult(r, 'Appointment booked.'), 'ok'); reload(); }} />
      )}
      {editing && m && (
        <BookingForm meta={m} session={session} editing={editing} onClose={() => setEditing(null)}
                     onDone={(r) => { setEditing(null); toast(describeResult(r, 'Appointment updated.'), 'ok'); reload(); }} />
      )}
    </div>
  );
}

/** Used by the popup: book-again and reschedule need the meta without a page around them. */
export async function loadMeta(): Promise<Meta> {
  return get<Meta>('/appointments/meta');
}
