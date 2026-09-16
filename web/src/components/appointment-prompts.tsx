/**
 * The "is it happening?" popup.
 *
 * When a meeting starts, whoever hosts it — and whoever booked it for them —
 * is asked whether the client is there. Attended or missed records the
 * outcome and moves the file along its pipeline; "ask me at the end" asks
 * again when it finishes; after that, "not now" waits half an hour. A meeting
 * nobody answers for stops asking after 12 hours and waits under
 * Appointments → Needs outcome.
 *
 * Polled every 30 seconds and whenever the window comes back into focus.
 */
import { useEffect, useState } from 'preact/hooks';
import { get, post } from '../lib/api.ts';
import { toast, type Session } from '../lib/store.ts';
import { Modal } from './ui.tsx';
import {
  BookingForm, describeResult, loadMeta, timeLabel, type Appointment, type ChangeResult, type Meta,
} from '../pages/appointments.tsx';

type Prompt = Appointment & { prompt: 'live' | 'ended'; booked_by_me: boolean };

export function AppointmentPrompts({ session }: { session: Session }) {
  const allowed = ['appointment.view', 'appointment.view_all', 'appointment.manage_all']
    .some((p) => session.permissions.includes(p));
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [busy, setBusy] = useState(false);
  const [rescheduling, setRescheduling] = useState<{ appointment: Appointment; meta: Meta } | null>(null);

  const poll = async () => {
    try { setPrompts((await get<{ prompts: Prompt[] }>('/appointments/prompts')).prompts); }
    catch { /* a missed poll is retried in 30 seconds */ }
  };

  useEffect(() => {
    if (!allowed) return;
    void poll();
    const id = setInterval(poll, 30_000);
    const onFocus = () => void poll();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [allowed]);

  const current = prompts[0];
  if (!allowed || (!current && !rescheduling)) return null;

  const done = (id: string) => setPrompts((list) => list.filter((p) => p.id !== id));

  const outcome = async (p: Prompt, o: 'attended' | 'missed') => {
    setBusy(true);
    try {
      const result = await post<ChangeResult>(`/appointments/${p.id}/outcome`, { outcome: o });
      toast(describeResult(result, `${p.client_name}: ${o === 'attended' ? 'attended' : 'missed'}.`), 'ok');
      done(p.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record that.', 'error');
    } finally { setBusy(false); }
  };

  const snooze = async (p: Prompt, until: 'end' | 'later') => {
    done(p.id);
    try { await post(`/appointments/${p.id}/snooze`, { until }); } catch { /* it will simply ask again */ }
  };

  const reschedule = async (p: Prompt) => {
    try {
      const meta = await loadMeta();
      done(p.id);
      setRescheduling({ appointment: p, meta });
    } catch (err) { toast(err instanceof Error ? err.message : 'Could not open the form.', 'error'); }
  };

  if (rescheduling) {
    return (
      <BookingForm meta={rescheduling.meta} session={session} editing={rescheduling.appointment}
                   onClose={() => setRescheduling(null)}
                   onDone={(r) => { setRescheduling(null); toast(describeResult(r, 'Appointment moved.'), 'ok'); void poll(); }} />
    );
  }

  const p = current!;
  const at = timeLabel(p.starts_at, p.timezone);
  const whose = p.booked_by_me && p.host_name ? ` with ${p.host_name}` : '';
  const live = p.prompt === 'live';
  return (
    <Modal title={live ? `Meeting in progress — ${p.client_name}` : `Did ${p.client_name} attend?`}
           onClose={() => void snooze(p, live ? 'end' : 'later')} wide
           footer={
             <div class="row" style={{ gap: 8, flexWrap: 'wrap', width: '100%' }}>
               <button class="btn btn-ghost" disabled={busy} onClick={() => void snooze(p, live ? 'end' : 'later')}>
                 {live ? 'Ask me at the end' : 'Not now'}
               </button>
               <button class="btn" disabled={busy} onClick={() => void reschedule(p)}>Reschedule</button>
               <span style={{ flex: 1 }} />
               <button class="btn btn-danger" disabled={busy} onClick={() => void outcome(p, 'missed')}>
                 {live ? 'Client didn’t show' : 'Missed'}
               </button>
               <button class="btn btn-primary" disabled={busy} onClick={() => void outcome(p, 'attended')}>
                 {live ? 'Client is here' : 'Attended'}
               </button>
             </div>
           }>
      <p style={{ marginTop: 0 }}>
        {live
          ? <>The {p.type_label.toLowerCase()}{whose} started at <strong>{at}</strong> — is {p.client_name} there?</>
          : <>The {p.type_label.toLowerCase()}{whose} at <strong>{at}</strong> has ended — did {p.client_name} attend?</>}
      </p>
      <p class="text-sm text-muted">
        {p.mode_label}
        {p.mode === 'video' && p.meeting_url && <> · <a href={p.meeting_url} target="_blank" rel="noopener noreferrer">Join the call</a></>}
        {p.mode === 'phone' && (p.location || p.client_phone) && <> · <a href={`tel:${p.location ?? p.client_phone}`}>{p.location ?? p.client_phone}</a></>}
        {p.mode === 'in_person' && p.location && ` · ${p.location}`}
      </p>
      <p class="text-sm text-muted" style={{ marginBottom: 0 }}>
        Attended or missed moves {p.client_name}’s file to the stage its pipeline sets for that
        {p.stage_label ? ` (it is at ${p.stage_label} now)` : ''}.
        {prompts.length > 1 && ` ${prompts.length - 1} more meeting${prompts.length === 2 ? '' : 's'} waiting after this one.`}
      </p>
    </Modal>
  );
}
