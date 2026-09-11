-- ===========================================================================
-- 0003 — Tasks, notes, appointments, and the activity timeline.
-- ===========================================================================

CREATE TABLE tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id   UUID REFERENCES applications(id) ON DELETE CASCADE,
  customer_id      UUID REFERENCES customers(id) ON DELETE CASCADE,
  parent_task_id   UUID REFERENCES tasks(id) ON DELETE CASCADE,

  title            TEXT NOT NULL,
  description      TEXT,
  category         TEXT NOT NULL DEFAULT 'follow_up'
                   CHECK (category IN ('follow_up','document_request','lender_submission',
                                       'application_review','compliance','condition',
                                       'appointment','closing_deadline','renewal','other')),
  priority         TEXT NOT NULL DEFAULT 'normal'
                   CHECK (priority IN ('low','normal','high','urgent')),
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','in_progress','waiting','completed','cancelled')),
  -- DATE + optional time, not a single timestamp. "Due Friday" and "due Friday
  -- at 2pm" are different promises, and collapsing the first into midnight
  -- makes every all-day task overdue by breakfast.
  due_on           DATE,
  due_time         TIME,
  remind_at        TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  completed_by     UUID REFERENCES users(id) ON DELETE SET NULL,

  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Which automation, if any, produced this. A task the engine created must be
  -- cancellable by the engine when the reason for it goes away.
  source_kind      TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source_kind IN ('manual','automation','system','rule')),
  source_ref       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_app_idx ON tasks (application_id, status, due_on);
CREATE INDEX tasks_customer_idx ON tasks (customer_id, status, due_on);
-- The index the dashboard lives on: open work, soonest first.
CREATE INDEX tasks_open_due_idx ON tasks (organization_id, due_on, due_time)
  WHERE status IN ('open','in_progress','waiting');
CREATE INDEX tasks_source_idx ON tasks (source_kind, source_ref) WHERE source_ref IS NOT NULL;
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A task can be owned by more than one person.
CREATE TABLE task_assignees (
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_assignees_user_idx ON task_assignees (user_id);

-- ── Notes ──────────────────────────────────────────────────────────────────
-- Authored, unlike the log, which is recorded. A compliance note is held to a
-- stricter rule than a sales note: see note_revisions below.
CREATE TABLE notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id  UUID REFERENCES applications(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  note_type       TEXT NOT NULL DEFAULT 'general'
                  CHECK (note_type IN ('sales','underwriting','compliance','call',
                                       'meeting','lender','general')),
  -- 'team' is everyone; 'compliance' is the compliance role only; 'private' is
  -- the author. Enforced server-side on every read, never by hiding a button.
  visibility      TEXT NOT NULL DEFAULT 'team'
                  CHECK (visibility IN ('team','compliance','private')),
  pinned          BOOLEAN NOT NULL DEFAULT false,
  author_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  author_name     TEXT,
  mentions        UUID[] NOT NULL DEFAULT '{}',
  edited_at       TIMESTAMPTZ,
  -- Compliance notes are not hard-deleted; they are withdrawn, and the
  -- withdrawal is itself the record.
  deleted_at      TIMESTAMPTZ,
  deleted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notes_app_idx ON notes (application_id, pinned DESC, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX notes_customer_idx ON notes (customer_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER notes_touch BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Every previous version of a note that was edited. Cheap, and it is the
-- difference between "the note says X" and "the note has always said X".
CREATE TABLE note_revisions (
  id          BIGSERIAL PRIMARY KEY,
  note_id     UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  edited_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  edited_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX note_revisions_note_idx ON note_revisions (note_id, edited_at DESC);

-- ── Appointments ───────────────────────────────────────────────────────────
CREATE TABLE appointments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id     UUID REFERENCES applications(id) ON DELETE CASCADE,
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id            UUID REFERENCES users(id) ON DELETE SET NULL,

  appointment_type   TEXT NOT NULL DEFAULT 'discovery',
  -- The instant, plus the zone it was agreed in. Both: the instant is what the
  -- reminder fires on, and the zone is what "2pm" meant to the client. Storing
  -- only the instant loses the ability to say "2pm your time" correctly after
  -- a daylight-saving change.
  starts_at          TIMESTAMPTZ NOT NULL,
  ends_at            TIMESTAMPTZ NOT NULL,
  timezone           TEXT NOT NULL DEFAULT 'America/Toronto',
  location           TEXT,
  meeting_url        TEXT,

  status             TEXT NOT NULL DEFAULT 'booked'
                     CHECK (status IN ('booked','confirmed','completed','no_show','cancelled','rescheduled')),
  -- A rebooked appointment points at the one it replaced, which is how the
  -- no-show follow-up knows to stop.
  rescheduled_from_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  confirmed_at       TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ,
  cancelled_reason   TEXT,
  no_show_at         TIMESTAMPTZ,
  outcome            TEXT,
  notes              TEXT,

  -- Google Calendar
  google_event_id    TEXT,
  google_calendar_id TEXT,
  google_synced_at   TIMESTAMPTZ,
  google_sync_error  TEXT,

  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX appointments_when_idx ON appointments (organization_id, starts_at)
  WHERE status IN ('booked','confirmed');
CREATE INDEX appointments_user_idx ON appointments (user_id, starts_at DESC);
CREATE INDEX appointments_customer_idx ON appointments (customer_id, starts_at DESC);
CREATE INDEX appointments_app_idx ON appointments (application_id, starts_at DESC);
-- Idempotent calendar sync: one CRM appointment is at most one Google event.
CREATE UNIQUE INDEX appointments_google_event_idx ON appointments (google_event_id)
  WHERE google_event_id IS NOT NULL;
CREATE TRIGGER appointments_touch BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── The timeline ───────────────────────────────────────────────────────────
-- One stream per file, holding a readable sentence for everything that
-- happened to it: a stage change, a document approved, an SMS, a call, an
-- email delivered, an automation enrolled.
--
-- `kind` is the machine's word and `summary` is the person's. Both are stored:
-- a log you can filter and a log you can read are different requirements, and
-- deriving either from the other goes wrong.
CREATE TABLE activity (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id  UUID REFERENCES applications(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            TEXT NOT NULL,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name      TEXT,
  actor_kind      TEXT NOT NULL DEFAULT 'user'
                  CHECK (actor_kind IN ('user','system','client','integration')),
  summary         TEXT NOT NULL,
  detail          JSONB,
  entity_type     TEXT,
  entity_id       TEXT
);
CREATE INDEX activity_app_idx ON activity (application_id, at DESC);
CREATE INDEX activity_customer_idx ON activity (customer_id, at DESC);
CREATE INDEX activity_kind_idx ON activity (organization_id, kind, at DESC);
