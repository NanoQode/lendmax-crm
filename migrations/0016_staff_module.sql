-- ─────────────────────────────────────────────────────────────────────────────
-- 0016 · Staff module: invitations, activation, round robin, archive, API keys
--
-- Before this, a staff account was created with no password and no way to set
-- one, so nobody added through the screen could ever sign in. An account now
-- moves through: invited → activated (they chose a password from the emailed
-- link) → active / inactive → archived ("deleted" on screen, kept because
-- their name is on notes, audit rows and funded files).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN first_name            TEXT,
  ADD COLUMN last_name             TEXT,
  -- Takes part in automatic assignment of new leads. Off does not hide them
  -- from the manual assign list; inactive does.
  ADD COLUMN round_robin_enabled   BOOLEAN NOT NULL DEFAULT false,
  -- The rotation is "whoever was handed a lead longest ago", not an index into
  -- a list, so switching somebody on or off never makes the order skip.
  ADD COLUMN last_auto_assigned_at TIMESTAMPTZ,
  ADD COLUMN invited_at            TIMESTAMPTZ,
  -- NULL until they set a password from their invitation. Sign-in refuses an
  -- account that has not been activated.
  ADD COLUMN activated_at          TIMESTAMPTZ,
  ADD COLUMN deactivated_at        TIMESTAMPTZ,
  ADD COLUMN archived_at           TIMESTAMPTZ,
  ADD COLUMN archived_by           UUID REFERENCES users(id) ON DELETE SET NULL;

UPDATE users
   SET first_name = split_part(btrim(name), ' ', 1),
       last_name  = NULLIF(btrim(substr(btrim(name), length(split_part(btrim(name), ' ', 1)) + 1)), '');

-- An account that already has a password was activated the old way (the seed's
-- --admin, or by hand). Leaving it unactivated would lock out whoever is
-- running the system today.
UPDATE users SET activated_at = COALESCE(last_login_at, created_at)
 WHERE password_hash IS NOT NULL;

UPDATE users SET deactivated_at = updated_at WHERE NOT active;

-- An archived account frees its email address, so the same person can be
-- invited again later without resurrecting the old row.
DROP INDEX users_email_key;
CREATE UNIQUE INDEX users_email_key ON users (organization_id, lower(email))
  WHERE archived_at IS NULL;

CREATE INDEX users_round_robin_idx ON users (organization_id, last_auto_assigned_at)
  WHERE round_robin_enabled AND active AND archived_at IS NULL;

-- ── Routing that already existed is preserved ──────────────────────────────
-- A broker rule that sent every file to one person becomes a rotation of one:
-- that person joins round robin and the files keep going to them. Rules with
-- conditions (by province, by type) are left exactly as they are. Anybody
-- already named in a rotation keeps their place, because the per-person switch
-- now decides who rotates.
UPDATE users u SET round_robin_enabled = true
 WHERE EXISTS (
   SELECT 1 FROM assignment_rules r
    WHERE r.organization_id = u.organization_id AND r.active
      AND ((r.role = 'broker' AND r.mode = 'fixed' AND r.applies_when = '{}'::jsonb
            AND r.fixed_user_id = u.id)
        OR (r.mode = 'round_robin' AND u.id = ANY (r.candidates))));

UPDATE assignment_rules
   SET mode = 'round_robin', candidates = '{}', fixed_user_id = NULL
 WHERE role = 'broker' AND mode IN ('fixed', 'round_robin') AND applies_when = '{}'::jsonb;

-- ── Invitations ────────────────────────────────────────────────────────────
-- The token itself is only ever in the email. The database holds its SHA-256,
-- so a copy of the database cannot be used to activate somebody's account.
CREATE TABLE user_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  -- Superseded by a resend, or cancelled when the account was deactivated.
  revoked_at      TIMESTAMPTZ,
  email_sent      BOOLEAN NOT NULL DEFAULT false,
  email_error     TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_invitations_open_idx ON user_invitations (user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- ── API keys ───────────────────────────────────────────────────────────────
-- One per connected website or service, each limited to the permissions it was
-- given. Only the hash is stored; the key is shown once, when it is created.
CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  -- The first characters of the key, so a person can tell which key a log
  -- line or a config file refers to without the key being stored.
  key_prefix      TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  permissions     TEXT[] NOT NULL DEFAULT '{}',
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  last_used_ip    TEXT,
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX api_keys_org_idx ON api_keys (organization_id, created_at DESC);
