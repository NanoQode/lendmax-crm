/**
 * Appointments — the rules, without a database.
 *
 * What an appointment can be, how "2:30 pm in Toronto" becomes an instant,
 * when the attended / missed popup asks, and whether booking or an outcome
 * moves the file along its pipeline. The service (services/appointments.ts)
 * does the writing; everything here is unit-tested.
 */

export const APPOINTMENT_TYPES = [
  { key: 'discovery', label: 'Discovery call', minutes: 30 },
  { key: 'application_review', label: 'Application review', minutes: 45 },
  { key: 'document_review', label: 'Document review', minutes: 30 },
  { key: 'rate_review', label: 'Rate & renewal review', minutes: 30 },
  { key: 'signing', label: 'Signing', minutes: 60 },
  { key: 'other', label: 'Other', minutes: 30 },
] as const;
export type AppointmentType = typeof APPOINTMENT_TYPES[number]['key'];
export const APPOINTMENT_TYPE_KEYS = APPOINTMENT_TYPES.map((t) => t.key) as [AppointmentType, ...AppointmentType[]];

export const MODES = [
  { key: 'video', label: 'Video call' },
  { key: 'phone', label: 'Phone call' },
  { key: 'in_person', label: 'In person' },
] as const;
export type Mode = typeof MODES[number]['key'];
export const MODE_KEYS = MODES.map((m) => m.key) as [Mode, ...Mode[]];

/**
 * `completed` is what the screens call Attended and `no_show` is Missed —
 * the stored words predate this module and the automations listen for them.
 */
export const STATUSES = [
  { key: 'booked', label: 'Booked' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'completed', label: 'Attended' },
  { key: 'no_show', label: 'Missed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'rescheduled', label: 'Rescheduled' },
] as const;
export type Status = typeof STATUSES[number]['key'];
export const OPEN_STATUSES: Status[] = ['booked', 'confirmed'];

export const DURATIONS = [15, 30, 45, 60, 90, 120];

/** Reminders go this long before the start. */
export const REMINDER_MINUTES = 15;

/** The popup stops asking about a meeting this long after it started; it waits under "Needs outcome". */
export const PROMPT_WINDOW_HOURS = 12;

/** "Not now" on an ended meeting asks again after this. */
export const PROMPT_SNOOZE_MINUTES = 30;

export const typeLabel = (key: string) => APPOINTMENT_TYPES.find((t) => t.key === key)?.label
  ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const modeLabel = (key: string) => MODES.find((m) => m.key === key)?.label ?? key;
export const statusLabel = (key: string) => STATUSES.find((s) => s.key === key)?.label ?? key;

/**
 * The client emails, as they are first created. Transactional: they are about
 * a meeting the client agreed to, so CASL consent does not apply — a hard
 * bounce or a withdrawn transactional consent still stops them. A line whose
 * field has no value is dropped (merge-fields.ts), so a phone appointment
 * with no number leaves that line out rather than sending a blank.
 */
export const DEFAULT_TEMPLATES = [
  {
    key: 'appointment_confirmation', name: 'Appointment — confirmation',
    subject: 'Your {appointment_type} with {appointment_host} — {appointment_date}',
    body: 'Hi {first_name},\n\nYour {appointment_type} with {appointment_host} is booked for {appointment_date} at {appointment_time} ({appointment_duration}).\n\n{appointment_where}\n\nIf the time no longer works, just reply to this email and we\'ll find another.\n\n{signature}',
  },
  {
    key: 'appointment_rescheduled', name: 'Appointment — new time',
    subject: 'New time: your {appointment_type} on {appointment_date}',
    body: 'Hi {first_name},\n\nYour {appointment_type} with {appointment_host} has moved to {appointment_date} at {appointment_time} ({appointment_duration}).\n\n{appointment_where}\n\nIf this doesn\'t suit you, reply to this email.\n\n{signature}',
  },
  {
    key: 'appointment_cancelled', name: 'Appointment — cancelled',
    subject: 'Cancelled: your {appointment_type} on {appointment_date}',
    body: 'Hi {first_name},\n\nYour {appointment_type} with {appointment_host} on {appointment_date} at {appointment_time} has been cancelled.\n\nReply to this email whenever you\'d like to book another time.\n\n{signature}',
  },
  {
    key: 'appointment_reminder', name: 'Appointment — 15-minute reminder',
    subject: 'Starting soon: your {appointment_type} with {appointment_host}',
    body: 'Hi {first_name},\n\nA quick reminder that your {appointment_type} with {appointment_host} starts at {appointment_time} today.\n\n{appointment_where}\n\n{signature}',
  },
] as const;
export type TemplateKey = typeof DEFAULT_TEMPLATES[number]['key'];

// ── Time ───────────────────────────────────────────────────────────────────

/** Offset of `zone` from UTC at `instant`, in minutes (Toronto in summer: -240). */
export function zoneOffsetMinutes(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

export function isValidZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); return true; } catch { return false; }
}

/**
 * The instant a wall-clock time in a zone refers to: "2026-11-01 01:30 in
 * Toronto". Returns null for a time that does not exist (the hour skipped
 * when the clocks go forward) rather than quietly booking the wrong hour.
 * In the repeated hour when the clocks go back, the first one is meant.
 */
export function localToInstant(date: string, time: string, zone: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!d || !t || !isValidZone(zone)) return null;
  const [y, mo, da, h, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const wall = Date.UTC(y, mo - 1, da, h, mi);
  if (new Date(wall).getUTCDate() !== da) return null; // 31 February
  // Try the offsets either side of the wall time; the earliest that maps back
  // to the same wall clock wins.
  const candidates = [...new Set([
    zoneOffsetMinutes(new Date(wall - 36 * 3_600_000), zone),
    zoneOffsetMinutes(new Date(wall), zone),
    zoneOffsetMinutes(new Date(wall + 36 * 3_600_000), zone),
  ])].map((offset) => new Date(wall - offset * 60_000))
    .filter((instant) => zoneOffsetMinutes(instant, zone) * 60_000 + instant.getTime() === wall)
    .sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? null;
}

/** The wall-clock date and time of an instant in a zone: { date: '2026-09-18', time: '14:30' }. */
export function instantToLocal(instant: Date, zone: string): { date: string; time: string } {
  const shifted = new Date(instant.getTime() + zoneOffsetMinutes(instant, zone) * 60_000);
  const iso = shifted.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** "Thursday, September 18, 2026" in the appointment's zone. */
export function formatDay(instant: Date, zone: string): string {
  return instant.toLocaleDateString('en-CA', {
    timeZone: zone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

/** "2:30 p.m. EDT" in the appointment's zone — the zone is named, so nobody guesses. */
export function formatTime(instant: Date, zone: string): string {
  return instant.toLocaleTimeString('en-CA', {
    timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minutes` : ''}`;
}

/** Where the client should be, in one sentence for an email. */
export function whereText(input: {
  mode: string; location: string | null; meeting_url: string | null; host_name: string | null;
  client_phone: string | null;
}): string | null {
  const host = input.host_name ?? 'We';
  if (input.mode === 'video') {
    return input.meeting_url ? `Join the video call: ${input.meeting_url}` : null;
  }
  if (input.mode === 'phone') {
    const number = input.location || input.client_phone;
    return number ? `${host} will call you at ${number}.` : `${host} will call you.`;
  }
  return input.location ? `We'll meet at ${input.location}.` : null;
}

// ── The popup ──────────────────────────────────────────────────────────────

export type PromptPhase = 'live' | 'ended';

/**
 * Whether to ask "is it happening?" about a meeting, and which question.
 * While it runs: is the client there? After it ends: did they come? Past the
 * window it stops asking and waits in the "Needs outcome" list instead.
 */
export function promptPhase(
  appointment: { status: string; starts_at: Date; ends_at: Date },
  now: Date,
  snoozedUntil?: Date | null,
): PromptPhase | null {
  if (!OPEN_STATUSES.includes(appointment.status as Status)) return null;
  if (now < appointment.starts_at) return null;
  if (now.getTime() - appointment.starts_at.getTime() > PROMPT_WINDOW_HOURS * 3_600_000) return null;
  if (snoozedUntil && now < snoozedUntil) return null;
  return now < appointment.ends_at ? 'live' : 'ended';
}

// ── Moving the file ────────────────────────────────────────────────────────

export type StageRef = { key: string; label: string; position: number; category: string; pipeline_id: string };

export type MoveDecision = { move: StageRef } | { skip: string | null };

const settled = (s: StageRef) => s.category === 'won' || s.category === 'lost';

/**
 * Booking moves the file forward to the pipeline's "appointment booked"
 * stage — never backwards past it, and never out of Funded or Lost. A file
 * parked in Nurture, or sitting on the missed stage, comes back into play.
 */
export function bookingMove(input: {
  current: StageRef | null; booked: StageRef | null; missedKey: string | null;
}): MoveDecision {
  const { current, booked } = input;
  if (!booked || !current) return { skip: null };
  if (current.key === booked.key) return { skip: null };
  if (current.pipeline_id !== booked.pipeline_id) return { skip: null };
  if (settled(current)) return { skip: `The file is ${current.label}, so it stays there.` };
  const comesBack = current.category === 'parked' || current.key === input.missedKey;
  if (current.position > booked.position && !comesBack) {
    return { skip: `The file is already past ${booked.label} (at ${current.label}), so it stays there.` };
  }
  return { move: booked };
}

/**
 * Attended or missed moves the file to the stage its pipeline names — but
 * only while the file is still where booking left it. A file that has since
 * moved on (to Scarlett, say) is somebody's deliberate work and is left.
 */
export function outcomeMove(input: {
  current: StageRef | null; target: StageRef | null; booked: StageRef | null; outcome: 'attended' | 'missed';
}): MoveDecision {
  const { current, target, booked } = input;
  if (!target || !current) return { skip: null };
  if (current.key === target.key) return { skip: null };
  if (current.pipeline_id !== target.pipeline_id) {
    return { skip: 'The file has moved to another pipeline, so it stays where it is.' };
  }
  if (settled(current)) return { skip: `The file is ${current.label}, so it stays there.` };
  if (booked) {
    if (current.position > booked.position) {
      return { skip: `The file has already moved past ${booked.label} (to ${current.label}), so it stays there.` };
    }
  } else if (input.outcome === 'attended' && current.position > target.position) {
    return { skip: `The file is already past ${target.label} (at ${current.label}), so it stays there.` };
  }
  return { move: target };
}
