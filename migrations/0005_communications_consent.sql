-- ===========================================================================
-- 0005 — Communications, and the consent that governs them.
--
-- Consent and messages are in one migration because they are one mechanism.
-- Every send in this system passes a gate that reads consent and suppression
-- first (src/domain/consent.ts), and the gate's decision is recorded on the
-- message. So "why did this client get this" and "why did this client NOT get
-- this" both have answers, months later, without re-deriving anything.
--
-- CASL SHAPE, NOT CASL ADVICE. What is encoded here is structure: that consent
-- has a basis, an evidence trail, a date and a scope; that implied consent
-- expires and express consent does not; that an unsubscribe is honoured across
-- channels the brokerage configures it to cover. The actual rules — how long
-- an implied basis lasts, what counts as a business relationship — are
-- configuration with effective dates (settings key 'consent_rules'), verified
-- against CRTC guidance by a person, not constants compiled into this file.
-- ===========================================================================

-- ── Consent ────────────────────────────────────────────────────────────────
-- Append-only. A consent record is evidence; it is superseded, never edited.
-- The current state of any (customer, channel, purpose) is the newest row.
CREATE TABLE consents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  application_id   UUID REFERENCES applications(id) ON DELETE SET NULL,

  channel          TEXT NOT NULL CHECK (channel IN ('email','sms','phone','mail','any')),
  -- The distinction that matters most in this whole system. 'transactional' is
  -- about the mortgage the client asked us to arrange; 'marketing' is
  -- commercial electronic messaging. An application consent is the first and
  -- NEVER silently the second — which is why they cannot share a row.
  purpose          TEXT NOT NULL
                   CHECK (purpose IN ('transactional','marketing','credit_check','service')),
  -- express | implied | withdrawn. An implied basis carries an expiry; an
  -- express one does not.
  basis            TEXT NOT NULL CHECK (basis IN ('express','implied','withdrawn')),
  granted          BOOLEAN NOT NULL,
  expires_at       TIMESTAMPTZ,

  -- The evidence. Written at collection time and never recomputed: an agreement
  -- is to the text that was on screen, not to whatever that page says today.
  consent_text     TEXT,
  consent_version  TEXT,
  source           TEXT,              -- portal_application | crm | reply_stop | import | verbal
  source_detail    TEXT,              -- the page, the campaign, the inbound message id
  ip               INET,
  user_agent       TEXT,
  collected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_kind       TEXT NOT NULL DEFAULT 'client'
                   CHECK (actor_kind IN ('user','system','client','integration')),
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX consents_customer_idx ON consents (customer_id, channel, purpose, collected_at DESC);
CREATE INDEX consents_expiry_idx ON consents (expires_at) WHERE expires_at IS NOT NULL AND granted;

CREATE OR REPLACE FUNCTION consents_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'consents is append-only (attempted %). Record a superseding consent instead.', TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER consents_no_update BEFORE UPDATE ON consents
  FOR EACH ROW EXECUTE FUNCTION consents_is_append_only();
CREATE TRIGGER consents_no_delete BEFORE DELETE ON consents
  FOR EACH ROW EXECUTE FUNCTION consents_is_append_only();

-- The fast answer to "may we send". Derived from consents plus hard bounces
-- and complaints, maintained by the consent service, and consulted before
-- every send. It exists because scanning the consent history for 40,000
-- recipients at campaign time is the query that makes a campaign time out.
--
-- A suppression is never casually removed: `removed_at` and `removed_reason`
-- are filled in, the row stays, and re-adding somebody who unsubscribed
-- requires a new consent record to point at.
CREATE TABLE suppressions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE CASCADE,
  -- Kept alongside customer_id because a bounce suppresses an ADDRESS, which
  -- may later belong to a different customer record after a merge.
  address         TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('email','sms')),
  scope           TEXT NOT NULL DEFAULT 'marketing'
                  CHECK (scope IN ('marketing','all')),
  reason          TEXT NOT NULL
                  CHECK (reason IN ('unsubscribe','stop_keyword','complaint','hard_bounce',
                                    'manual','invalid','deceased')),
  detail          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  removed_at      TIMESTAMPTZ,
  removed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  removed_reason  TEXT
);
CREATE UNIQUE INDEX suppressions_active_idx
  ON suppressions (organization_id, channel, lower(address), scope)
  WHERE removed_at IS NULL;
CREATE INDEX suppressions_customer_idx ON suppressions (customer_id) WHERE removed_at IS NULL;

-- ── Threads and messages ───────────────────────────────────────────────────
-- One thread per (customer, channel). The SMS screen is a conversation, and a
-- conversation that restarts every time a different member of staff replies is
-- not one.
CREATE TABLE communication_threads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  application_id   UUID REFERENCES applications(id) ON DELETE SET NULL,
  channel          TEXT NOT NULL CHECK (channel IN ('email','sms')),
  -- The DID the client texts, so a reply goes back out of the number they know.
  address          TEXT,
  subject          TEXT,
  last_message_at  TIMESTAMPTZ,
  unread_count     INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX communication_threads_customer_idx ON communication_threads (customer_id, channel);
CREATE INDEX communication_threads_recent_idx ON communication_threads (organization_id, last_message_at DESC);
CREATE TRIGGER communication_threads_touch BEFORE UPDATE ON communication_threads
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id        UUID REFERENCES communication_threads(id) ON DELETE SET NULL,
  customer_id      UUID REFERENCES customers(id) ON DELETE CASCADE,
  application_id   UUID REFERENCES applications(id) ON DELETE SET NULL,

  channel          TEXT NOT NULL CHECK (channel IN ('email','sms','mms')),
  direction        TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  -- manual | automation | campaign | system. Visible in the timeline, because
  -- "did a person send this" is the first question anybody asks of a message.
  origin           TEXT NOT NULL DEFAULT 'manual'
                   CHECK (origin IN ('manual','automation','campaign','system')),
  -- The consent class this send was made under. Recorded on the message so the
  -- basis for sending it survives any later change to the client's consent.
  purpose          TEXT NOT NULL DEFAULT 'transactional'
                   CHECK (purpose IN ('transactional','marketing','service')),

  from_address     TEXT,
  to_address       TEXT NOT NULL,
  cc               TEXT,
  subject          TEXT,
  body_text        TEXT,
  body_html        TEXT,
  -- What the merge fields resolved to. Without it, a message sent from a
  -- template that has since been edited cannot be reproduced.
  merge_snapshot   JSONB,

  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('draft','queued','scheduled','sending','sent','delivered',
                                     'failed','bounced','suppressed','received')),
  scheduled_for    TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  failed_at        TIMESTAMPTZ,
  failure_reason   TEXT,
  -- Why a send did not happen. "Suppressed: unsubscribed from marketing on
  -- 2026-03-02" is an answer; a missing message is not.
  gate_decision    JSONB,

  provider         TEXT,
  provider_message_id TEXT,
  -- Provider webhooks are delivered more than once. This is what makes
  -- processing one idempotent.
  dedupe_key       TEXT,

  template_key     TEXT,
  campaign_id      UUID,
  automation_run_id UUID,
  sent_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  read_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_idx ON messages (thread_id, created_at DESC);
CREATE INDEX messages_customer_idx ON messages (customer_id, created_at DESC);
CREATE INDEX messages_app_idx ON messages (application_id, created_at DESC);
CREATE INDEX messages_status_idx ON messages (organization_id, status, created_at DESC);
CREATE INDEX messages_scheduled_idx ON messages (scheduled_for) WHERE status = 'scheduled';
CREATE UNIQUE INDEX messages_dedupe_idx ON messages (organization_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX messages_provider_idx ON messages (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE TRIGGER messages_touch BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE message_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename      TEXT,
  mime_type     TEXT,
  byte_size     BIGINT,
  storage_key   TEXT,
  -- An inbound MMS arrives as a URL at the provider that expires. It is fetched
  -- and stored; `remote_url` is kept only to diagnose a fetch that failed.
  remote_url    TEXT,
  fetched_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX message_attachments_message_idx ON message_attachments (message_id);

-- Provider callbacks, stored before they are acted on. A webhook that was
-- received but could not be processed is a bug to fix, not an event to lose.
CREATE TABLE webhook_events (
  id             BIGSERIAL PRIMARY KEY,
  provider       TEXT NOT NULL,
  event_type     TEXT,
  external_id    TEXT,
  payload        JSONB NOT NULL,
  signature_ok   BOOLEAN,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  process_error  TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX webhook_events_dedupe_idx ON webhook_events (provider, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX webhook_events_unprocessed_idx ON webhook_events (provider, received_at)
  WHERE processed_at IS NULL;

-- ── Templates ──────────────────────────────────────────────────────────────
CREATE TABLE templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('email','sms')),
  kind            TEXT NOT NULL DEFAULT 'personal'
                  CHECK (kind IN ('personal','campaign','system','document_request','appointment')),
  purpose         TEXT NOT NULL DEFAULT 'transactional'
                  CHECK (purpose IN ('transactional','marketing','service')),
  subject         TEXT,
  body_text       TEXT,
  body_html       TEXT,
  -- The merge fields this template actually uses, extracted at save time and
  -- validated against the registry. A template referring to a field that does
  -- not exist is caught when it is written, not when it is sent to a client.
  merge_fields    TEXT[] NOT NULL DEFAULT '{}',
  transaction_types TEXT[] NOT NULL DEFAULT '{}',
  active          BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
CREATE TRIGGER templates_touch BEFORE UPDATE ON templates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
