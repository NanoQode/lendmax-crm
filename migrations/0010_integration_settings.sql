-- ===========================================================================
-- 0010 — Integration credentials, configurable from the dashboard.
--
-- WHY THIS IS NOT JUST .env
--
-- Environment variables need a deploy and a person with shell access to
-- change. That is the wrong shape for a brokerage: when VoIP.ms rotates a
-- password or Scarlett issues a new key, the technical admin should be able to
-- paste it in, press Test, and see it work — at 7pm, without a release.
--
-- HOW THE SECRETS ARE HELD
--
-- `secrets_encrypted` is AES-256-GCM ciphertext over a JSON object, keyed by
-- CREDENTIALS_KEY (32 bytes, base64, from the environment). So:
--
--   · a database dump does not contain usable credentials
--   · the key lives in one place, not scattered through a dozen columns
--   · GCM authenticates as well as encrypts, so a tampered row fails to
--     decrypt rather than silently yielding different bytes
--
-- The key stays in the environment on purpose. Putting the key that protects
-- the credentials in the same database as the credentials protects nothing.
--
-- `config` holds everything that is NOT a secret — the sending DID, the base
-- URL, the mode — so those can be read, indexed and shown without touching the
-- cipher at all.
--
-- ENVIRONMENT REMAINS A FALLBACK. A value set here wins; where nothing is set
-- here, the .env value is used. That keeps an existing deployment working
-- through the change, and keeps a local development box configurable without a
-- database round trip.
-- ===========================================================================

CREATE TABLE integration_settings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- scarlett | voipms | email | google | portal | ai | storage
  integration_key   TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT false,

  -- Non-secret configuration. Readable, shown in full on screen.
  config            JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- AES-256-GCM over a JSON object of the secret fields.
  secrets_encrypted BYTEA,
  -- Which secret keys are present, and the last four characters of each, so
  -- the screen can say "API key ending 8f2c, set on 4 March" without ever
  -- decrypting anything to render a page.
  secrets_preview   JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- The result of the last connection test. Stored rather than recomputed,
  -- because a test costs an external call and the admin screen is opened far
  -- more often than credentials change.
  last_test_at      TIMESTAMPTZ,
  last_test_ok      BOOLEAN,
  last_test_message TEXT,

  -- Set when the process could not decrypt this row — a rotated or lost
  -- CREDENTIALS_KEY. Surfaced loudly rather than degrading into "integration
  -- not configured", which would send somebody to re-enter credentials that
  -- are in fact still there.
  decrypt_failed    BOOLEAN NOT NULL DEFAULT false,

  updated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, integration_key)
);
CREATE TRIGGER integration_settings_touch BEFORE UPDATE ON integration_settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Portal mirror bookkeeping ──────────────────────────────────────────────
-- The portal pushes from the first answer, not on submit, and runs a
-- thirty-second reconciliation sweep on top of an immediate push. So the same
-- change arrives more than once by design, and the CRM has to be able to say
-- what it last accepted.
ALTER TABLE applications ADD COLUMN portal_current_section TEXT;
ALTER TABLE applications ADD COLUMN portal_current_section_label TEXT;
ALTER TABLE applications ADD COLUMN portal_lead_source TEXT;
ALTER TABLE applications ADD COLUMN portal_lead_campaign TEXT;
ALTER TABLE applications ADD COLUMN portal_document_manifest JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Every push received, accepted or not. When a broker asks why a file looks
-- wrong, the first question is what the portal actually sent.
ALTER TABLE applications ADD COLUMN last_mirror_status TEXT;

CREATE TABLE portal_mirror_log (
  id              BIGSERIAL PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  application_id  UUID REFERENCES applications(id) ON DELETE CASCADE,
  reference       TEXT NOT NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload_hash    TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('created','updated','unchanged','rejected','failed')),
  changed_fields  JSONB,
  error           TEXT,
  duration_ms     INTEGER
);
CREATE INDEX portal_mirror_log_ref_idx ON portal_mirror_log (reference, at DESC);
CREATE INDEX portal_mirror_log_failures_idx ON portal_mirror_log (at DESC)
  WHERE outcome IN ('rejected','failed');

-- ── Duplicate review ───────────────────────────────────────────────────────
-- The importer flags rather than merges. Merging two people's mortgage files
-- because they share an address is not undoable, so it is a decision a person
-- takes with both records in front of them.
CREATE TABLE duplicate_candidates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  duplicate_of_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- Which signals matched: email, phone, name+address …
  matched_on      TEXT[] NOT NULL DEFAULT '{}',
  confidence      NUMERIC(5,2),
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','merged','dismissed')),
  resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, duplicate_of_id)
);
CREATE INDEX duplicate_candidates_open_idx ON duplicate_candidates (organization_id, status, created_at DESC);

-- ── Inbound messages that could not be attributed ──────────────────────────
-- If an inbound number matches more than one contact, the message is held here
-- rather than attached to the wrong client. Attaching a stranger's text to a
-- mortgage file is a privacy incident, and guessing is how it happens.
CREATE TABLE unmatched_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL CHECK (channel IN ('sms','mms','email')),
  from_address    TEXT NOT NULL,
  to_address      TEXT,
  body            TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider        TEXT,
  provider_message_id TEXT,
  -- 'ambiguous' when several customers share the number, 'unknown' when none do.
  reason          TEXT NOT NULL CHECK (reason IN ('ambiguous','unknown')),
  candidate_ids   UUID[] NOT NULL DEFAULT '{}',
  resolved_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  media           JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX unmatched_messages_open_idx ON unmatched_messages (organization_id, received_at DESC)
  WHERE resolved_at IS NULL;
