-- ===========================================================================
-- 0001 — Foundation: who the brokerage is, who works there, what they may do,
--        what they did, and the queue that does work on their behalf.
--
-- Conventions used by every migration that follows, stated once here:
--
--   · Money is NUMERIC(14,2). Never a float. A float cent error compounds
--     through a commission split and nobody finds it until reconciliation.
--   · Rates are NUMERIC(9,6) stored AS A PERCENT — 5.29 means 5.29%. Storing
--     a rate as a fraction and a percent in different columns is the single
--     most reliable way to produce a mortgage payment that is off by 100x.
--   · TIMESTAMPTZ for anything that happened. DATE for legal dates a contract
--     names (closing, maturity, funding) — those are not instants and giving
--     them a timezone makes a closing date move overnight for a broker in BC.
--   · Enumerations that the brokerage may add to are TEXT + a lookup table.
--     Enumerations that are structural (a consent basis, a job state) are
--     CHECK constraints, because adding to them is a code change anyway.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Timestamp helper ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── The brokerage ──────────────────────────────────────────────────────────
-- One row in practice. It exists as a table rather than a settings key because
-- the province and the regulator drive compliance behaviour, and a compliance
-- rule keyed on a JSON blob is a rule nobody can index, constrain or join on.
CREATE TABLE organizations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  legal_name         TEXT,
  -- FSRA in Ontario. Held per-organization rather than assumed, because the
  -- architecture has to survive Lendmax licensing in a second province.
  regulator          TEXT,
  licence_number     TEXT,
  home_province      TEXT NOT NULL DEFAULT 'ON'
                     CHECK (home_province IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT')),
  timezone           TEXT NOT NULL DEFAULT 'America/Toronto',
  website            TEXT,
  main_phone         TEXT,
  support_email      TEXT,
  logo_url           TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE teams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- Who a file escalates to when it stalls, and who is auto-assigned as
  -- manager on files this team owns.
  manager_user_id UUID,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE TRIGGER teams_touch BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── People ─────────────────────────────────────────────────────────────────
-- `role` is the coarse answer and `permission_overrides` is the fine one. The
-- alternative — inventing a sixth role every time one person needs one extra
-- capability — is how RBAC systems become unauditable.
--
-- password_hash NULL is a real and useful state: a colleague can be assignable,
-- notifiable and named on a file before they have ever signed in.
CREATE TABLE users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id              UUID REFERENCES teams(id) ON DELETE SET NULL,
  email                TEXT NOT NULL,
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'broker'
                       CHECK (role IN ('technical_admin','broker','underwriter','manager','compliance_manager')),
  password_hash        TEXT,
  -- {permission_id: true|false}. Empty for almost everybody.
  permission_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  mfa_secret           TEXT,
  mfa_enabled          BOOLEAN NOT NULL DEFAULT false,
  active               BOOLEAN NOT NULL DEFAULT true,
  timezone             TEXT,
  -- Set false until the user completes the first-login profile that produces
  -- their signature. Nothing is sent from an account that has not done it.
  profile_complete     BOOLEAN NOT NULL DEFAULT false,
  last_login_at        TIMESTAMPTZ,
  failed_login_count   INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL
);
-- Case-insensitively unique: two accounts differing only by capitalisation is
-- two accounts one person signs into at random.
CREATE UNIQUE INDEX users_email_key ON users (organization_id, lower(email));
CREATE INDEX users_active_role_idx ON users (organization_id, active, role);
CREATE INDEX users_team_idx ON users (team_id) WHERE team_id IS NOT NULL;
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE teams ADD CONSTRAINT teams_manager_fk
  FOREIGN KEY (manager_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- The identity a client sees. Separate from `users` because it is edited by a
-- different person for a different reason: an admin manages the account, the
-- user manages how they appear in an email.
CREATE TABLE user_profiles (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name       TEXT,
  title              TEXT,
  licence_number     TEXT,
  licence_province   TEXT,
  mobile_phone       TEXT,
  direct_phone       TEXT,
  office_phone       TEXT,
  booking_url        TEXT,
  photo_url          TEXT,
  -- Rendered signature, both parts. Stored rather than generated at send time
  -- so that an email sent last year still shows the signature it was sent with.
  signature_html     TEXT,
  signature_text     TEXT,
  -- Quiet hours and working days for THIS user, when they differ from the
  -- brokerage's. Scheduling reads here first.
  working_hours      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER user_profiles_touch BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Sessions are rows, not self-contained signed tokens, so that they can be
-- revoked. A laptop goes missing; a stateless JWT cannot be taken back before
-- it expires, and a row can be deleted.
CREATE TABLE sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 of the cookie value. The cookie itself is never stored, so a
  -- database disclosure does not hand over live sessions.
  token_hash        TEXT NOT NULL UNIQUE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip                INET,
  user_agent        TEXT,
  revoked_at        TIMESTAMPTZ,
  revoked_reason    TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at DESC);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- ── Audit ──────────────────────────────────────────────────────────────────
-- Append-only and hash-chained: each row carries the digest of the row before
-- it, so a deletion or an edit anywhere in the history breaks the chain from
-- that point on and `verifyAuditChain()` says exactly where.
--
-- A trigger blocks UPDATE and DELETE outright. This is not paranoia about
-- colleagues; it is that a compliance file whose audit trail *can* be edited
-- is a compliance file whose audit trail has to be argued about.
CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Denormalised so a deleted account does not erase the history of what they
  -- did. The FK above is for joining; this is for reading.
  actor_name      TEXT,
  actor_role      TEXT,
  -- 'system' when the automation engine acted, 'client' for a borrower action
  -- on an upload link, 'user' otherwise.
  actor_kind      TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','system','client','integration')),
  action          TEXT NOT NULL,          -- stage.change, document.view, consent.revoke, …
  entity_type     TEXT,                   -- customer | application | document | …
  entity_id       TEXT,
  summary         TEXT NOT NULL,          -- a sentence a person can read
  before_json     JSONB,
  after_json      JSONB,
  ip              INET,
  session_id      UUID,
  -- Hash chain
  prev_hash       TEXT,
  row_hash        TEXT NOT NULL
);
CREATE INDEX audit_log_at_idx ON audit_log (organization_id, at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, at DESC);

CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted %). Record a correcting entry instead.', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ── Settings ───────────────────────────────────────────────────────────────
-- Configuration the brokerage owns, versioned. `effective_from` exists because
-- mortgage and compliance rules change on a date and the CRM must be able to
-- say what the rule WAS when a file was worked, not only what it is now.
CREATE TABLE settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value           JSONB NOT NULL,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  -- Where the value came from, for anything a regulator sets. "OSFI B-20,
  -- checked 2026-09-11" is a citation; "4.79" on its own is a guess.
  source_note     TEXT,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key, effective_from)
);
CREATE INDEX settings_key_idx ON settings (organization_id, key, effective_from DESC);
CREATE TRIGGER settings_touch BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Notifications ──────────────────────────────────────────────────────────
-- The one channel that always works: no provider, no consent, no valid address.
CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            TEXT NOT NULL DEFAULT 'info',
  title           TEXT NOT NULL,
  body            TEXT,
  link            TEXT,
  entity_type     TEXT,
  entity_id       TEXT,
  read_at         TIMESTAMPTZ,
  -- Set by the producer to something stable for the event. A duplicated
  -- webhook delivery then updates a row instead of ringing the bell twice.
  dedupe_key      TEXT
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, at DESC);
CREATE UNIQUE INDEX notifications_dedupe_key ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── Background jobs ────────────────────────────────────────────────────────
-- A Postgres-backed queue. Deliberately not Redis: the queue holds scheduled
-- client messages, and a queue that can lose its contents on restart is a queue
-- that silently stops following up on mortgage files.
--
-- `dedupe_key` makes enqueueing idempotent, which is what lets a webhook be
-- delivered twice — and it will be — without texting a client twice.
CREATE TABLE jobs (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  queue           TEXT NOT NULL DEFAULT 'default',
  kind            TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','running','succeeded','failed','dead','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 100,   -- lower runs first
  run_after       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  last_error      TEXT,
  dedupe_key      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);
CREATE INDEX jobs_claim_idx ON jobs (queue, state, run_after, priority)
  WHERE state = 'pending';
CREATE INDEX jobs_state_idx ON jobs (state, updated_at DESC);
-- Only *live* work is deduplicated. A job that has finished must not block the
-- same job being enqueued again next week.
CREATE UNIQUE INDEX jobs_dedupe_key ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('pending','running');
CREATE TRIGGER jobs_touch BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
