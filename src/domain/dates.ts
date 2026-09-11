/**
 * Dates, and the arithmetic the whole CRM hangs off.
 *
 * Two kinds of time live here and they are not interchangeable:
 *
 *   A CALENDAR DATE is what a contract names — a closing date, a maturity
 *   date. It has no timezone. "Closes October 15" is October 15 for the broker
 *   in Toronto and the one in Vancouver, and giving it an instant makes it move
 *   overnight for one of them. These are 'YYYY-MM-DD' strings.
 *
 *   AN INSTANT is when something happened or will happen — a reminder, an
 *   appointment. These are Date objects in UTC, rendered into a zone for
 *   display.
 *
 * Everything below that takes "today" takes it as a parameter. A function that
 * reads the clock cannot be tested, and date arithmetic that cannot be tested
 * is date arithmetic that is wrong at the end of February.
 */

export type IsoDate = string; // YYYY-MM-DD

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is IsoDate {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parse an ISO date to a UTC-midnight Date. Throws on anything malformed. */
export function parseIsoDate(value: IsoDate): Date {
  if (!isIsoDate(value)) throw new Error(`Not a calendar date: ${JSON.stringify(value)}`);
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIsoDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

/** Today, in a named zone — not in the server's zone, which is UTC. */
export function todayIn(timezone: string, now: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = parseIsoDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/**
 * Add months, clamping to the end of the shorter month.
 *
 * A five-year term taken out on 31 August matures on 31 August. A six-month
 * renewal milestone counted back from 31 March lands on 30 September, not on
 * 1 October — which is what naive month arithmetic produces and what would put
 * a renewal letter in the wrong month for every client with a month-end date.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const d = parseIsoDate(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(Math.min(day, daysInMonth(d.getUTCFullYear(), d.getUTCMonth() + 1)));
  return toIsoDate(d);
}

/** Whole days from `from` to `to`. Negative when `to` is in the past. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const ms = parseIsoDate(to).getTime() - parseIsoDate(from).getTime();
  return Math.round(ms / 86_400_000);
}

// ── Days to close ──────────────────────────────────────────────────────────

export type Urgency = 'comfortable' | 'attention' | 'urgent' | 'overdue' | 'none';

export type DaysToClose = {
  days: number | null;
  urgency: Urgency;
  /** A sentence, because a colour is not an accessible way to say "overdue". */
  label: string;
};

/**
 * The number on the client header, the list, the board and the task engine.
 *
 * Urgency is returned as a word, never only as a colour: a broker with a
 * colour-vision deficiency must be able to read the same file the same way.
 * The thresholds are defaults and are overridable per brokerage.
 */
export function daysToClose(
  closingDate: IsoDate | null | undefined,
  today: IsoDate,
  thresholds: { attention: number; urgent: number } = { attention: 14, urgent: 7 },
): DaysToClose {
  if (!closingDate || !isIsoDate(closingDate)) {
    return { days: null, urgency: 'none', label: 'No closing date' };
  }
  const days = daysBetween(today, closingDate);

  if (days < 0) {
    const overdue = Math.abs(days);
    return {
      days,
      urgency: 'overdue',
      label: `Closing date passed ${overdue} day${overdue === 1 ? '' : 's'} ago`,
    };
  }
  if (days === 0) return { days, urgency: 'urgent', label: 'Closes today' };
  if (days === 1) return { days, urgency: 'urgent', label: 'Closes tomorrow' };

  const label = `Closes in ${days} days`;
  if (days <= thresholds.urgent) return { days, urgency: 'urgent', label };
  if (days <= thresholds.attention) return { days, urgency: 'attention', label };
  return { days, urgency: 'comfortable', label };
}

// ── Maturity ───────────────────────────────────────────────────────────────

export type MaturityResult = {
  date: IsoDate | null;
  source: 'calculated' | 'confirmed' | 'entered' | null;
  /** Why there is no date, when there is none. Surfaced, never swallowed. */
  reason?: string;
};

/**
 * Maturity from funding date plus term.
 *
 * Calculated is not the same as confirmed, and the difference is not academic:
 * a renewal campaign fired at a calculated guess tells a client something about
 * their own mortgage that may be wrong. The caller is handed the provenance and
 * the UI shows it; a person confirms it against the commitment.
 */
export function calculateMaturity(
  fundingDate: IsoDate | null | undefined,
  termMonths: number | null | undefined,
): MaturityResult {
  if (!fundingDate || !isIsoDate(fundingDate)) {
    return { date: null, source: null, reason: 'no funding date recorded' };
  }
  if (!termMonths || termMonths <= 0) {
    return { date: null, source: null, reason: 'no mortgage term recorded' };
  }
  return { date: addMonths(fundingDate, termMonths), source: 'calculated' };
}

export type RenewalMilestoneKey = 't_minus_6m' | 't_minus_3m' | 't_minus_45d';

export const RENEWAL_MILESTONES: Array<{
  key: RenewalMilestoneKey;
  label: string;
  offset: (maturity: IsoDate) => IsoDate;
}> = [
  { key: 't_minus_6m', label: '6 months before maturity', offset: (m) => addMonths(m, -6) },
  { key: 't_minus_3m', label: '3 months before maturity', offset: (m) => addMonths(m, -3) },
  { key: 't_minus_45d', label: '45 days before maturity', offset: (m) => addDays(m, -45) },
];

/**
 * The renewal schedule for one maturity date.
 *
 * Milestones already in the past are returned marked, not dropped. A mortgage
 * maturing in ten weeks has missed T-6m and T-3m, and the brokerage needs to
 * see that it is starting late rather than see two milestones silently absent.
 */
export function renewalSchedule(
  maturityDate: IsoDate,
  today: IsoDate,
): Array<{ key: RenewalMilestoneKey; label: string; dueOn: IsoDate; passed: boolean }> {
  return RENEWAL_MILESTONES.map((m) => {
    const dueOn = m.offset(maturityDate);
    return { key: m.key, label: m.label, dueOn, passed: daysBetween(today, dueOn) < 0 };
  });
}

// ── Business days ──────────────────────────────────────────────────────────

export type BusinessCalendar = {
  /** 0 = Sunday … 6 = Saturday. */
  workingDays: number[];
  /** Statutory holidays as ISO dates. Configured, never guessed. */
  holidays: IsoDate[];
  workdayStartHour: number;
  workdayEndHour: number;
};

export const DEFAULT_BUSINESS_CALENDAR: BusinessCalendar = {
  workingDays: [1, 2, 3, 4, 5],
  holidays: [],
  workdayStartHour: 9,
  workdayEndHour: 17,
};

export function isBusinessDay(date: IsoDate, calendar: BusinessCalendar): boolean {
  const dow = parseIsoDate(date).getUTCDay();
  if (!calendar.workingDays.includes(dow)) return false;
  return !calendar.holidays.includes(date);
}

export function addBusinessDays(date: IsoDate, count: number, calendar: BusinessCalendar): IsoDate {
  if (count === 0) return date;
  const step = count > 0 ? 1 : -1;
  let remaining = Math.abs(count);
  let cursor = date;
  // Bounded so a calendar with no working days configured fails loudly rather
  // than spinning forever.
  let guard = 0;
  while (remaining > 0) {
    if (++guard > 3650) {
      throw new Error('addBusinessDays: no business day found within ten years — check the calendar');
    }
    cursor = addDays(cursor, step);
    if (isBusinessDay(cursor, calendar)) remaining--;
  }
  return cursor;
}

/**
 * Business days between two dates, counting neither endpoint twice.
 *
 * This is what an SLA is measured in. "Client replied 18 hours ago" is not a
 * breach of a four-business-hour SLA if sixteen of those hours were Saturday,
 * and treating every elapsed hour as a working hour produces an alert list
 * every Monday morning that people learn to ignore.
 */
export function businessDaysBetween(from: IsoDate, to: IsoDate, calendar: BusinessCalendar): number {
  if (from === to) return 0;
  const backwards = daysBetween(from, to) < 0;
  const [start, end] = backwards ? [to, from] : [from, to];
  let count = 0;
  let cursor = start;
  while (cursor !== end) {
    cursor = addDays(cursor, 1);
    if (isBusinessDay(cursor, calendar)) count++;
  }
  return backwards ? -count : count;
}

// ── Quiet hours ────────────────────────────────────────────────────────────

export type QuietHours = {
  enabled: boolean;
  /** Local hour at which sending stops, e.g. 21 for 9pm. */
  startHour: number;
  /** Local hour at which it may resume, e.g. 8 for 8am. */
  endHour: number;
  /** When false, weekends are treated as sendable. */
  respectWeekends: boolean;
};

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: true,
  startHour: 21,
  endHour: 8,
  respectWeekends: false,
};

/** The local wall-clock hour and weekday of an instant, in a named zone. */
export function localParts(at: Date, timezone: string): { hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    // Intl renders midnight as "24" in some ICU versions; normalise it.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: Math.max(0, weekdays.indexOf(get('weekday'))),
  };
}

export function isWithinQuietHours(at: Date, timezone: string, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  const { hour, weekday } = localParts(at, timezone);
  if (quiet.respectWeekends && (weekday === 0 || weekday === 6)) return true;
  // A window that wraps midnight (21:00 → 08:00) is the normal case, so it is
  // the case handled first rather than the special one bolted on.
  return quiet.startHour > quiet.endHour
    ? hour >= quiet.startHour || hour < quiet.endHour
    : hour >= quiet.startHour && hour < quiet.endHour;
}

/**
 * The next instant a message may go out. Returns `at` unchanged when it is
 * already fine to send — the caller does not need to know whether it moved.
 */
export function nextSendableTime(at: Date, timezone: string, quiet: QuietHours): Date {
  if (!isWithinQuietHours(at, timezone, quiet)) return at;
  // Step forward in fifteen-minute increments rather than computing the zone
  // offset by hand: this stays correct across a daylight-saving boundary,
  // which arithmetic on a fixed offset does not.
  const cursor = new Date(at.getTime());
  for (let i = 0; i < 4 * 24 * 3; i++) {
    cursor.setTime(cursor.getTime() + 15 * 60_000);
    if (!isWithinQuietHours(cursor, timezone, quiet)) {
      // Land on the minute, not on whatever fifteen-minute offset we stopped at.
      cursor.setSeconds(0, 0);
      return cursor;
    }
  }
  throw new Error('nextSendableTime: no sendable window within three days — check quiet hours');
}
