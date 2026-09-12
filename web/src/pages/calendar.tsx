/**
 * The calendar.
 *
 * A week at a time, because a broker's question is "what is my week" rather
 * than "what is October". Each appointment shows the client, the type and
 * whether they have confirmed — confirmation being the single field that
 * predicts a no-show.
 *
 * Times are rendered in the appointment's own zone when it differs from the
 * viewer's, labelled as such. "2pm" meant something to the client, and a
 * broker phoning at the wrong hour because the clocks moved is a small
 * failure that costs a whole meeting.
 */
import { useMemo, useState } from 'preact/hooks';
import { ApiError, formatDate, post } from '../lib/api.ts';
import { navigate, toast, useAsync, type Session } from '../lib/store.ts';
import { Badge, Empty, ErrorNote, Field, Modal, Skeleton } from '../components/ui.tsx';

type Appointment = {
  id: string; starts_at: string; ends_at: string; timezone: string;
  appointment_type: string; status: string; location: string | null;
  meeting_url: string | null; notes: string | null; outcome: string | null;
  google_event_id: string | null;
  customer_id: string; first_name: string; last_name: string;
  phone_e164: string | null; email: string | null;
  application_id: string | null; portal_reference: string | null;
  user_id: string | null; user_name: string | null;
};

export function CalendarPage({ session }: { session: Session }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [acting, setActing] = useState<Appointment | null>(null);
  const [rebooking, setRebooking] = useState<Appointment | null>(null);

  const from = weekStart.toISOString();
  const to = new Date(weekStart.getTime() + 7 * 86_400_000).toISOString();
  const state = useAsync<{
    appointments: Appointment[]; counts: Record<string, number>;
    timezone: string; google_connected: boolean;
  }>(`/calendar?from=${from}&to=${to}&scope=${scope}`, [from, scope]);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * 86_400_000)),
    [weekStart]);

  const canSeeAll = session.permissions.includes('customer.view_all');

  return (
    <div class="content">
      <div class="page-head">
        <div>
          <h1>Calendar</h1>
          <p>
            {weekLabel(weekStart)}
            {state.status === 'ready' && ` · times shown in ${state.data.timezone}`}
          </p>
        </div>
        <div class="row" style={{ gap: 8 }}>
          {canSeeAll && (
            <div class="row" role="group">
              <button class={`btn btn-sm${scope === 'mine' ? ' btn-primary' : ''}`}
                      onClick={() => setScope('mine')}>Mine</button>
              <button class={`btn btn-sm${scope === 'all' ? ' btn-primary' : ''}`}
                      onClick={() => setScope('all')}>Everyone</button>
            </div>
          )}
          <button class="btn btn-sm"
                  onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * 86_400_000))}>
            ←
          </button>
          <button class="btn btn-sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>
            This week
          </button>
          <button class="btn btn-sm"
                  onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * 86_400_000))}>
            →
          </button>
        </div>
      </div>

      {state.status === 'loading' && <Skeleton rows={3} height={90} />}
      {state.status === 'error' && <ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} />}

      {state.status === 'ready' && (
        <>
          <div class="kpi-grid">
            {[
              ['today', 'Today'],
              ['this_week', 'Next 7 days'],
              ['unconfirmed', 'Not confirmed'],
              ['no_shows_30d', 'No-shows (30d)'],
            ].map(([key, label]) => (
              <div key={key} class="card kpi">
                <div class="label">{label}</div>
                <div class="value num">{state.data.counts[key as string] ?? 0}</div>
              </div>
            ))}
          </div>

          {!state.data.google_connected && (
            <div class="alert alert-info" style={{ marginTop: 14 }}>
              Google Calendar is not connected, so these appointments live only in the CRM.
              Connect it under Integrations to have them appear in your own calendar.
            </div>
          )}

          <div class="week">
            {days.map((day) => {
              const dayAppointments = state.data.appointments.filter(
                (a) => sameDay(new Date(a.starts_at), day));
              return (
                <div key={day.toISOString()}
                     class={`week-day${isToday(day) ? ' week-today' : ''}`}>
                  <div class="week-head">
                    <span class="week-dow">{day.toLocaleDateString('en-CA', { weekday: 'short' })}</span>
                    <span class="week-date num">{day.getDate()}</span>
                  </div>
                  <div class="week-body">
                    {dayAppointments.length === 0 && <span class="week-empty">—</span>}
                    {dayAppointments.map((a) => (
                      <button key={a.id}
                              class={`appointment appointment-${a.status}`}
                              onClick={() => setActing(a)}>
                        <span class="appointment-time num">
                          {timeIn(a.starts_at, a.timezone)}
                          {a.timezone !== state.data.timezone && (
                            <span class="text-subtle"> {shortZone(a.timezone)}</span>
                          )}
                        </span>
                        <span class="appointment-who">{a.first_name} {a.last_name}</span>
                        <span class="appointment-type">
                          {a.appointment_type.replace(/_/g, ' ')}
                        </span>
                        {a.status === 'booked' && (
                          <span class="appointment-flag" title="Not confirmed">?</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {state.data.appointments.length === 0 && (
            <div class="card" style={{ marginTop: 14 }}>
              <Empty title="Nothing booked this week">
                Appointments booked from a client's file appear here.
              </Empty>
            </div>
          )}
        </>
      )}

      {acting && (
        <AppointmentDetail
          appointment={acting}
          onClose={() => setActing(null)}
          onRebook={() => { setRebooking(acting); setActing(null); }}
          onChanged={() => { setActing(null); state.reload(); }}
        />
      )}
      {rebooking && (
        <RebookForm appointment={rebooking} onClose={() => setRebooking(null)}
                    onRebooked={() => { setRebooking(null); state.reload(); }} />
      )}
    </div>
  );
}

function AppointmentDetail({ appointment: a, onClose, onRebook, onChanged }: {
  appointment: Appointment; onClose: () => void; onRebook: () => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  const past = new Date(a.starts_at) < new Date();

  const mark = async (status: string) => {
    setBusy(status); setError('');
    try {
      await post(`/appointments/${a.id}/outcome`, { status, reason: reason || undefined });
      toast(`Marked ${status.replace(/_/g, ' ')}.`, 'ok');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    } finally { setBusy(''); }
  };

  return (
    <Modal title={`${a.first_name} ${a.last_name}`} onClose={onClose} footer={
      <button class="btn" onClick={onClose}>Close</button>
    }>
      {error && <div class="alert alert-error">{error}</div>}

      <dl class="detail-list">
        <div><dt>When</dt><dd>
          {new Date(a.starts_at).toLocaleString('en-CA', {
            weekday: 'long', day: 'numeric', month: 'long',
            hour: 'numeric', minute: '2-digit', timeZone: a.timezone,
          })} <span class="text-muted">({shortZone(a.timezone)})</span>
        </dd></div>
        <div><dt>Type</dt><dd>{a.appointment_type.replace(/_/g, ' ')}</dd></div>
        <div><dt>Status</dt><dd>
          <Badge tone={a.status === 'no_show' ? 'danger'
            : a.status === 'confirmed' || a.status === 'completed' ? 'ok' : 'neutral'}>
            {a.status.replace(/_/g, ' ')}
          </Badge>
        </dd></div>
        {a.location && <div><dt>Where</dt><dd>{a.location}</dd></div>}
        {a.user_name && <div><dt>With</dt><dd>{a.user_name}</dd></div>}
        {a.notes && <div><dt>Notes</dt><dd>{a.notes}</dd></div>}
      </dl>

      {a.application_id && (
        <button class="btn btn-sm" style={{ marginBottom: 12 }}
                onClick={() => navigate(`/applications/${a.application_id}`)}>
          Open the file
        </button>
      )}

      {!cancelling ? (
        <div class="row" style={{ gap: 7, flexWrap: 'wrap' }}>
          {a.status === 'booked' && (
            <button class="btn btn-sm" disabled={!!busy}
                    onClick={() => mark('confirmed')}>Client confirmed</button>
          )}
          {past && a.status !== 'completed' && a.status !== 'no_show' && (
            <>
              <button class="btn btn-sm" disabled={!!busy}
                      onClick={() => mark('completed')}>It happened</button>
              <button class="btn btn-sm" disabled={!!busy}
                      onClick={() => mark('no_show')}>They did not show</button>
            </>
          )}
          <button class="btn btn-sm" onClick={onRebook}>Rebook</button>
          {a.status !== 'cancelled' && (
            <button class="btn btn-sm btn-danger"
                    onClick={() => setCancelling(true)}>Cancel</button>
          )}
        </div>
      ) : (
        <>
          <Field label="Why it was cancelled" hint="Recorded on the client's file.">
            <input value={reason} autofocus
                   onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
          </Field>
          <div class="row" style={{ gap: 8 }}>
            <button class="btn btn-sm" onClick={() => setCancelling(false)}>Back</button>
            <button class="btn btn-sm btn-danger" disabled={!reason || !!busy}
                    onClick={() => mark('cancelled')}>Cancel it</button>
          </div>
        </>
      )}

      {!past && a.status === 'booked' && (
        <p class="text-sm text-muted" style={{ marginTop: 12 }}>
          A client who has not confirmed is the one most likely not to arrive.
        </p>
      )}
    </Modal>
  );
}

function RebookForm({ appointment: a, onClose, onRebooked }: {
  appointment: Appointment; onClose: () => void; onRebooked: () => void;
}) {
  const [when, setWhen] = useState('');
  const [duration, setDuration] = useState('30');
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    try {
      await post(`/appointments/${a.id}/rebook`, {
        starts_at: new Date(when).toISOString(),
        duration_minutes: Number(duration),
      });
      toast('Rebooked. The no-show follow-up stops.', 'ok');
      onRebooked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rebook.');
    }
  };

  return (
    <Modal title={`Rebook ${a.first_name} ${a.last_name}`} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" disabled={!when} onClick={save}>Rebook</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <p class="text-sm text-muted">
        The original is kept and marked rescheduled, which is what lets any no-show
        follow-up stop the moment this is booked.
      </p>
      <Field label="New time">
        <input type="datetime-local" value={when} autofocus
               onInput={(e) => setWhen((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="Minutes">
        <select value={duration} onChange={(e) => setDuration((e.target as HTMLSelectElement).value)}>
          {['15', '30', '45', '60', '90'].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

// ── Dates ──────────────────────────────────────────────────────────────────

function startOfWeek(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  // Monday, because a broker's week starts on one.
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
  return copy;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function isToday(date: Date): boolean {
  return sameDay(date, new Date());
}

function weekLabel(start: Date): string {
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return `${formatDate(start.toISOString().slice(0, 10))} – ${formatDate(end.toISOString().slice(0, 10))}`;
}

function timeIn(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString('en-CA', {
    hour: 'numeric', minute: '2-digit', timeZone: timezone,
  });
}

function shortZone(timezone: string): string {
  return timezone.split('/').pop()?.replace(/_/g, ' ') ?? timezone;
}
