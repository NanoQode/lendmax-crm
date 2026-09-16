/**
 * Tasks — the rules, without a database.
 *
 * A task is a promise somebody made about a file: "call Rena at 4:30". Three
 * things about that shape this module:
 *
 *   1. A DATE IS NOT AN INSTANT. "Due Friday" and "due Friday at 4:30" are
 *      different promises. The first must not become overdue at breakfast, and
 *      only the second can be reminded about — you cannot be fifteen minutes
 *      early for a day.
 *   2. WHO DOES IT FOLLOWS FROM THE FILE. When an admin makes a task on
 *      somebody's client, it belongs to whoever that client is assigned to.
 *      That is not a courtesy default the form fills in; it is the rule, which
 *      is why the field showing it is read-only.
 *   3. A REMINDER IS SENT ONCE, for the time the task is currently set for.
 *      Moving a task re-arms it; moving it twice does not send two.
 */
import { instantToLocal, isValidZone, localToInstant } from './appointments.ts';

export {
  // The same wall-clock-to-instant arithmetic the appointment module uses,
  // re-exported so a caller here does not have to know that it lives there.
  instantToLocal, isValidZone, localToInstant,
};

export const CATEGORIES = [
  { key: 'follow_up', label: 'Follow-up' },
  { key: 'document_request', label: 'Document request' },
  { key: 'lender_submission', label: 'Lender submission' },
  { key: 'application_review', label: 'Application review' },
  { key: 'compliance', label: 'Compliance' },
  { key: 'condition', label: 'Condition' },
  { key: 'appointment', label: 'Appointment' },
  { key: 'closing_deadline', label: 'Closing deadline' },
  { key: 'renewal', label: 'Renewal' },
  { key: 'other', label: 'Other' },
] as const;
export type Category = typeof CATEGORIES[number]['key'];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as [Category, ...Category[]];

export const PRIORITIES = [
  { key: 'low', label: 'Low', rank: 3 },
  { key: 'normal', label: 'Normal', rank: 2 },
  { key: 'high', label: 'High', rank: 1 },
  { key: 'urgent', label: 'Urgent', rank: 0 },
] as const;
export type Priority = typeof PRIORITIES[number]['key'];
export const PRIORITY_KEYS = PRIORITIES.map((p) => p.key) as [Priority, ...Priority[]];

export const STATUSES = [
  { key: 'open', label: 'Open', open: true },
  { key: 'in_progress', label: 'In progress', open: true },
  { key: 'waiting', label: 'Waiting', open: true },
  { key: 'completed', label: 'Done', open: false },
  { key: 'cancelled', label: 'Cancelled', open: false },
] as const;
export type Status = typeof STATUSES[number]['key'];
export const STATUS_KEYS = STATUSES.map((s) => s.key) as [Status, ...Status[]];
export const OPEN_STATUSES = STATUSES.filter((s) => s.open).map((s) => s.key) as Status[];

export const isOpen = (status: string): boolean => OPEN_STATUSES.includes(status as Status);

export const categoryLabel = (key: string) =>
  CATEGORIES.find((c) => c.key === key)?.label ?? key.replace(/_/g, ' ');
export const priorityLabel = (key: string) => PRIORITIES.find((p) => p.key === key)?.label ?? key;
export const statusLabel = (key: string) => STATUSES.find((s) => s.key === key)?.label ?? key;

export const MAX_TITLE = 160;
export const MAX_DESCRIPTION = 4000;

// ── When it is due, and when to say so ─────────────────────────────────────

/** How long before a task starts its owner is told. */
export const REMINDER_MINUTES = 15;

/** The choices offered; 0 means "when it starts", null means no reminder at all. */
export const REMINDER_CHOICES = [
  { key: 'none', label: 'No reminder', minutes: null },
  { key: 'at', label: 'When it starts', minutes: 0 },
  { key: '15', label: '15 minutes before', minutes: 15 },
  { key: '30', label: '30 minutes before', minutes: 30 },
  { key: '60', label: '1 hour before', minutes: 60 },
  { key: '1440', label: 'The day before', minutes: 1440 },
] as const;

/**
 * The instant a task falls due.
 *
 * Null when there is no time: an all-day task is due on a date, and pretending
 * it is due at midnight makes every one of them overdue before anybody starts
 * work. A time that does not exist — the hour the clocks skip — is refused
 * rather than quietly moved.
 */
export function dueInstant(
  dueOn: string | null,
  dueTime: string | null,
  zone: string,
): Date | null {
  if (!dueOn || !dueTime) return null;
  return localToInstant(dueOn, dueTime, zone);
}

/**
 * When to send the reminder, or null if there is nothing to send.
 *
 * A task with no time cannot be reminded about, and neither can one that is
 * already finished.
 */
export function reminderInstant(
  dueAt: Date | null,
  minutesBefore: number | null,
  status: string,
): Date | null {
  if (!dueAt || minutesBefore === null || !isOpen(status)) return null;
  return new Date(dueAt.getTime() - minutesBefore * 60_000);
}

/**
 * Whether a reminder that is now due should actually go out.
 *
 * Two guards, both learned from the appointment module: one that has already
 * been sent is not sent again, and one whose moment passed long ago is
 * dropped rather than delivered stale — "your 9am task starts in 15 minutes"
 * at 4pm is worse than silence.
 */
export const REMINDER_GRACE_MINUTES = 120;

export function shouldRemind(
  task: { remind_at: Date | null; reminder_sent_at: Date | null; status: string },
  now: Date,
): boolean {
  if (!task.remind_at || task.reminder_sent_at || !isOpen(task.status)) return false;
  if (task.remind_at > now) return false;
  return now.getTime() - task.remind_at.getTime() <= REMINDER_GRACE_MINUTES * 60_000;
}

export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'this_week' | 'later' | 'someday';

export const BUCKETS: Array<{ key: DueBucket; label: string }> = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'this_week', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: 'someday', label: 'No date' },
];

/**
 * Which heading a task sits under.
 *
 * Compared in the reader's own day, not in UTC: a task due "today" at 9pm in
 * Toronto is already tomorrow by UTC, and filing it under Tomorrow would take
 * it off the list of the person who has to do it tonight.
 */
export function dueBucket(
  task: { due_on: string | null; due_at: Date | null; status: string },
  now: Date,
  zone: string,
): DueBucket {
  if (!task.due_on) return 'someday';
  const today = instantToLocal(now, zone).date;
  // A timed task is overdue the minute it passes; an all-day one only once the
  // day itself is over.
  if (task.due_at ? task.due_at < now : task.due_on < today) return 'overdue';
  if (task.due_on === today) return 'today';
  const tomorrow = addDaysIso(today, 1);
  if (task.due_on === tomorrow) return 'tomorrow';
  return task.due_on <= addDaysIso(today, 7) ? 'this_week' : 'later';
}

function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d! + days));
  return at.toISOString().slice(0, 10);
}

// ── Who it belongs to ──────────────────────────────────────────────────────

export type FileOwner = { user_id: string; name: string; role: string } | null;

export type OwnerDecision =
  | { assignee: string; source: 'file' | 'self'; note: string | null }
  | { refusal: string };

/**
 * Whose task this is.
 *
 * When a file is named, it belongs to whoever the file is assigned to — that
 * is what the read-only field on the form is showing, and it is why the field
 * is read-only. With no file, or a file nobody is assigned to, it belongs to
 * whoever is making it.
 *
 * A staff member cannot make work for somebody else at all: without
 * `manage_all`, a task is theirs whatever file it is on.
 */
export function ownerFor(input: {
  actorId: string;
  manageAll: boolean;
  fileOwner: FileOwner;
  hasFile: boolean;
}): OwnerDecision {
  if (!input.hasFile) return { assignee: input.actorId, source: 'self', note: null };
  if (!input.manageAll) return { assignee: input.actorId, source: 'self', note: null };
  if (!input.fileOwner) {
    return {
      assignee: input.actorId,
      source: 'self',
      note: 'Nobody is assigned to this file, so the task will be yours.',
    };
  }
  if (input.fileOwner.user_id === input.actorId) {
    return { assignee: input.actorId, source: 'file', note: null };
  }
  return {
    assignee: input.fileOwner.user_id,
    source: 'file',
    note: `${input.fileOwner.name} is assigned to this file, so the task will be theirs.`,
  };
}

// ── Validation ─────────────────────────────────────────────────────────────

export function titleRefusal(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return 'A task needs a title — what is it you have to do?';
  if (trimmed.length > MAX_TITLE) return `A title is at most ${MAX_TITLE} characters.`;
  return null;
}

/**
 * A time with no date is not a task, it is a wish.
 *
 * The other way round is fine: "sometime on Friday" is a real promise.
 */
export function scheduleRefusal(
  dueOn: string | null,
  dueTime: string | null,
  zone: string,
): string | null {
  if (dueTime && !dueOn) return 'Give the task a date as well as a time.';
  if (!dueOn) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return 'Use a date like 2026-09-18.';
  if (dueTime && !/^\d{1,2}:\d{2}$/.test(dueTime)) return 'Use a time like 16:30.';
  if (dueTime && !dueInstant(dueOn, dueTime, zone)) {
    return 'That time does not exist on that date — the clocks go forward. Pick another.';
  }
  return null;
}

/** A finished task is not rescheduled or re-finished; it is reopened first. */
export function transitionRefusal(from: string, to: string): string | null {
  if (from === to) return null;
  if (!STATUS_KEYS.includes(to as Status)) return `"${to}" is not a status a task can be in.`;
  if (!isOpen(from) && isOpen(to)) return null; // reopening is always allowed
  if (!isOpen(from)) {
    return `That task is ${statusLabel(from).toLowerCase()}. Reopen it before changing it.`;
  }
  return null;
}

/** What the reminder says, in one line. */
export function reminderSubject(task: { title: string; minutes: number }): string {
  if (task.minutes === 0) return `Starting now: ${task.title}`;
  if (task.minutes >= 1440) return `Tomorrow: ${task.title}`;
  return `In ${task.minutes} minutes: ${task.title}`;
}
