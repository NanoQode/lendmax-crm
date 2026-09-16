-- ─────────────────────────────────────────────────────────────────────────────
-- 0024 · Tasks — the instant a task falls due, and the reminder before it
--
-- The table has existed since 0003 with `due_on` (a date) and `due_time` (a
-- wall clock). Both stay: "due Friday" and "due Friday at 4:30" are different
-- promises and collapsing the first into midnight makes every all-day task
-- overdue by breakfast.
--
-- What is added is the INSTANT those two mean, so that a reminder can be sent
-- and an overdue task can be found without every query re-deriving it from a
-- date, a time and a timezone.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tasks
  -- NULL for an all-day task. You cannot be fifteen minutes early for a day.
  ADD COLUMN due_at           TIMESTAMPTZ,
  -- The zone the wall clock was typed in, kept so that moving the brokerage
  -- does not silently move every task already on the books.
  ADD COLUMN timezone         TEXT,
  -- NULL means the owner asked for no reminder; 0 means "when it starts".
  ADD COLUMN reminder_minutes INTEGER,
  ADD COLUMN reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN updated_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN cancelled_reason TEXT;

-- `remind_at` has been on the table since 0003 and nothing ever wrote to it.
-- It now holds the instant the reminder is due: due_at minus the minutes.

-- Fill in what can be derived. A task with no time gets no instant and no
-- reminder, which is correct rather than a gap.
UPDATE tasks t SET
  timezone = COALESCE(o.timezone, 'America/Toronto'),
  due_at = CASE WHEN t.due_on IS NOT NULL AND t.due_time IS NOT NULL
                THEN (t.due_on + t.due_time) AT TIME ZONE COALESCE(o.timezone, 'America/Toronto')
           END,
  reminder_minutes = CASE WHEN t.due_time IS NOT NULL THEN 15 END
  FROM organizations o
 WHERE o.id = t.organization_id;

UPDATE tasks SET remind_at = due_at - make_interval(mins => reminder_minutes)
 WHERE due_at IS NOT NULL AND reminder_minutes IS NOT NULL;

-- Anything already past keeps its silence: a reminder for a task that was due
-- last week is noise, so existing rows are marked as already reminded.
UPDATE tasks SET reminder_sent_at = now()
 WHERE remind_at IS NOT NULL AND remind_at <= now();

-- The one index the reminder tick runs on: what is due, not yet sent, still open.
CREATE INDEX tasks_reminder_idx ON tasks (remind_at)
  WHERE remind_at IS NOT NULL AND reminder_sent_at IS NULL
        AND status IN ('open', 'in_progress', 'waiting');

-- Sorting and filtering the list by the moment rather than the date.
CREATE INDEX tasks_due_at_idx ON tasks (organization_id, due_at)
  WHERE status IN ('open', 'in_progress', 'waiting');
