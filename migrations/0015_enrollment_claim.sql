-- ===========================================================================
-- 0015 — One worker at a time on an enrollment.
--
-- Found by reading a client's automation log: the same wait step appeared
-- twice, three milliseconds apart, because two jobs for one enrollment were
-- claimed by two workers at once. The queue's dedupe key protects a single
-- job, not an enrollment that has several queued against it over its life —
-- a manual "run this step now" alongside a scheduled one is enough.
--
-- A duplicate SEND was already impossible: every message carries a dedupe key
-- of enrollment + node. A duplicate TASK, note, tag or stage move was not, and
-- two concurrent advances can also step over a node entirely.
--
-- So a step is claimed before it runs. `running_since` is the claim; a claim
-- older than the reclaim window belongs to a worker that died holding it, and
-- is taken over rather than stranding the client.
-- ===========================================================================

ALTER TABLE automation_enrollments ADD COLUMN running_since TIMESTAMPTZ;

-- The sweeper reads this too: an enrollment that is due, unclaimed, and has no
-- job is one whose job went missing.
CREATE INDEX automation_enrollments_claimed_idx ON automation_enrollments (running_since)
  WHERE running_since IS NOT NULL;
