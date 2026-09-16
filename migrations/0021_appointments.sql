-- ─────────────────────────────────────────────────────────────────────────────
-- 0021 · Appointments — booking, Google Calendar, reminders, outcomes
--
-- The appointments table exists since 0003; this adds what the module needs:
--   · how the meeting happens (video / phone / in person)
--   · the 15-minute reminder, sent once per time the meeting is set for
--   · the attended / missed outcome, who recorded it, and where it moved the file
--   · per-person Google Calendar connections (tokens encrypted)
--   · per-pipeline stages that booking, attending and missing move a file to
--   · the four client emails, as editable templates
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE appointments
  ADD COLUMN mode               TEXT NOT NULL DEFAULT 'video'
                                CHECK (mode IN ('video', 'phone', 'in_person')),
  -- When the current start time was set — booking or the last reschedule.
  -- A reminder is only sent if the time was set before the reminder was due.
  ADD COLUMN time_set_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN reminder_sent_at   TIMESTAMPTZ,
  ADD COLUMN reschedule_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN outcome_at         TIMESTAMPTZ,
  ADD COLUMN outcome_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  -- What the outcome did to the file: the stage it moved to, or why not.
  ADD COLUMN outcome_stage_key  TEXT,
  ADD COLUMN outcome_stage_note TEXT,
  ADD COLUMN updated_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Whose Google Calendar holds the event (the host when it was pushed).
  ADD COLUMN google_owner_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN google_html_link   TEXT;

UPDATE appointments SET time_set_at = created_at;

CREATE INDEX appointments_reminder_idx ON appointments (starts_at)
  WHERE status IN ('booked', 'confirmed') AND reminder_sent_at IS NULL;
CREATE INDEX appointments_created_by_idx ON appointments (created_by, starts_at DESC);

-- "Ask me at the end" / "Not now" on the popup, per person.
CREATE TABLE appointment_prompt_snoozes (
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  until          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (appointment_id, user_id)
);

-- One Google Calendar per person. The tokens are AES-256-GCM encrypted with
-- CREDENTIALS_KEY, like every other credential in the database.
CREATE TABLE google_calendar_accounts (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  google_email     TEXT NOT NULL,
  calendar_id      TEXT NOT NULL DEFAULT 'primary',
  mode             TEXT NOT NULL CHECK (mode IN ('live', 'sandbox')),
  tokens           BYTEA NOT NULL,
  token_expires_at TIMESTAMPTZ,
  scopes           TEXT,
  connected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at   TIMESTAMPTZ,
  last_error       TEXT,
  last_error_at    TIMESTAMPTZ
);
CREATE INDEX google_calendar_accounts_org_idx ON google_calendar_accounts (organization_id);

-- Where booking, attending and missing move a file, per pipeline. Stage keys,
-- like everything else that names a stage; NULL means "don't move".
ALTER TABLE pipelines
  ADD COLUMN appointment_booked_stage_key   TEXT,
  ADD COLUMN appointment_attended_stage_key TEXT,
  ADD COLUMN appointment_missed_stage_key   TEXT;

-- Defaults from what each pipeline already has: its "Appointment Booked"
-- stage, its "Application" stage for attended, and its first active parked
-- stage (Nurture) for missed.
UPDATE pipelines p SET
  appointment_booked_stage_key = (
    SELECT s.key FROM pipeline_stages s
     WHERE s.pipeline_id = p.id AND s.archived_at IS NULL AND s.active
       AND (s.key = 'appointment_booked' OR s.key LIKE '%\_appointment\_booked' OR lower(s.label) = 'appointment booked')
     ORDER BY s.position LIMIT 1),
  appointment_attended_stage_key = (
    SELECT s.key FROM pipeline_stages s
     WHERE s.pipeline_id = p.id AND s.archived_at IS NULL AND s.active
       AND (s.key = 'application' OR s.key LIKE '%\_application' OR lower(s.label) = 'application')
     ORDER BY s.position LIMIT 1),
  appointment_missed_stage_key = (
    SELECT s.key FROM pipeline_stages s
     WHERE s.pipeline_id = p.id AND s.archived_at IS NULL AND s.active AND s.category = 'parked'
     ORDER BY s.position LIMIT 1)
 WHERE p.archived_at IS NULL;

-- The four client emails (confirmation, new time, cancelled, reminder) are
-- templates, created per organization by services/appointments.ts at boot so
-- a fresh install gets them too. Edited under Settings → Templates.
