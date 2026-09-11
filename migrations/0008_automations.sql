-- ===========================================================================
-- 0008 — The automation engine.
--
-- Event in, steps out, with the two properties that matter more than any
-- feature on the builder canvas:
--
--   VERSIONING. A published automation is frozen. An enrollment records the
--   version it is running, so editing a workflow never changes what an
--   already-enrolled client is going to receive next — and so "why did this
--   client get that message in March" can be answered by reading the version
--   that was live in March.
--
--   STOPPING. Most of the damage an automation engine does is not sending the
--   wrong message; it is continuing to send the right message after it stopped
--   being true. Missing-document reminders after the documents arrive. Lead
--   nurture after the client funded. No-show follow-ups after they rebooked.
--   So stop conditions are part of the definition, evaluated before every
--   step, and every enrollment records exactly which one ended it.
-- ===========================================================================

CREATE TABLE automations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','paused','archived')),
  published_version INTEGER,
  -- Belt and braces on top of consent: an automation that sends commercial
  -- content is marked as such, and the send gate refuses it for anybody
  -- without a marketing basis regardless of what the step says.
  purpose           TEXT NOT NULL DEFAULT 'transactional'
                    CHECK (purpose IN ('transactional','marketing','service')),
  -- One live enrollment per customer per automation, unless the automation
  -- explicitly allows re-enrollment (a renewal cycle does; an onboarding
  -- sequence does not).
  allow_reenrollment BOOLEAN NOT NULL DEFAULT false,
  reenrollment_cooldown_days INTEGER,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
CREATE INDEX automations_active_idx ON automations (organization_id, status);
CREATE TRIGGER automations_touch BEFORE UPDATE ON automations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE automation_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id  UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  -- { trigger: {...}, entry_conditions: [...], stop_conditions: [...],
  --   nodes: [...], edges: [...] }
  -- The whole graph in one document. It is read as a unit, written as a unit
  -- and never partially updated, so there is no state in which half a published
  -- automation is live.
  definition     JSONB NOT NULL,
  published_at   TIMESTAMPTZ,
  published_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Validation is a publish gate, not a save gate: a draft may be incomplete,
  -- a published version may not.
  validation     JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (automation_id, version)
);
CREATE INDEX automation_versions_published_idx ON automation_versions (automation_id, version DESC);

CREATE TABLE automation_enrollments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  automation_id      UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  automation_version INTEGER NOT NULL,
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  application_id     UUID REFERENCES applications(id) ON DELETE CASCADE,

  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','paused','completed','stopped','failed')),
  current_node_key   TEXT,
  next_run_at        TIMESTAMPTZ,
  -- Values the trigger captured at enrollment, so a step three days later
  -- renders from what was true when the client entered rather than re-reading
  -- a file that has since moved on.
  context            JSONB NOT NULL DEFAULT '{}'::jsonb,

  enrolled_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  enrolled_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  enrolled_reason    TEXT,
  completed_at       TIMESTAMPTZ,
  stopped_at         TIMESTAMPTZ,
  -- The specific stop condition, in words. "Stopped: documents received" is
  -- the difference between an engine people trust and one they turn off.
  stopped_reason     TEXT,
  stopped_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  steps_completed    INTEGER NOT NULL DEFAULT 0,
  messages_sent      INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The scheduler's index: what is due, soonest first.
CREATE INDEX automation_enrollments_due_idx ON automation_enrollments (next_run_at)
  WHERE status = 'active';
CREATE INDEX automation_enrollments_customer_idx ON automation_enrollments (customer_id, status);
CREATE INDEX automation_enrollments_app_idx ON automation_enrollments (application_id, status);
-- Duplicate-enrollment protection, enforced by the database rather than by the
-- engine remembering to check.
CREATE UNIQUE INDEX automation_enrollments_one_live_idx
  ON automation_enrollments (automation_id, customer_id)
  WHERE status IN ('active','paused');
CREATE TRIGGER automation_enrollments_touch BEFORE UPDATE ON automation_enrollments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Every step every enrollment took, and why. This is what the client's
-- "Active automations" tab reads, and what makes an automation debuggable.
CREATE TABLE automation_executions (
  id             BIGSERIAL PRIMARY KEY,
  enrollment_id  UUID NOT NULL REFERENCES automation_enrollments(id) ON DELETE CASCADE,
  node_key       TEXT NOT NULL,
  node_type      TEXT NOT NULL,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome        TEXT NOT NULL
                 CHECK (outcome IN ('executed','skipped','failed','branched','waiting','suppressed')),
  -- Why a branch went the way it did, or why a send was suppressed. Filled in
  -- for every non-trivial outcome.
  reason         TEXT,
  detail         JSONB,
  message_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
  task_id        UUID REFERENCES tasks(id) ON DELETE SET NULL,
  duration_ms    INTEGER
);
CREATE INDEX automation_executions_enrollment_idx ON automation_executions (enrollment_id, at DESC);
CREATE INDEX automation_executions_failures_idx ON automation_executions (at DESC)
  WHERE outcome = 'failed';

-- The event bus the engine consumes. Events are recorded first and matched to
-- triggers afterwards, which is what makes the engine replayable and what
-- stops a trigger-matching bug from destroying the event that exposed it.
CREATE TABLE domain_events (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type      TEXT NOT NULL,
  customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
  application_id  UUID REFERENCES applications(id) ON DELETE CASCADE,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  processed_at    TIMESTAMPTZ,
  process_error   TEXT,
  dedupe_key      TEXT
);
CREATE INDEX domain_events_unprocessed_idx ON domain_events (at) WHERE processed_at IS NULL;
CREATE INDEX domain_events_type_idx ON domain_events (organization_id, event_type, at DESC);
CREATE INDEX domain_events_app_idx ON domain_events (application_id, at DESC);
CREATE UNIQUE INDEX domain_events_dedupe_idx ON domain_events (dedupe_key) WHERE dedupe_key IS NOT NULL;
