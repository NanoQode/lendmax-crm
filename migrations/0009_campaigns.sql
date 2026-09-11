-- ===========================================================================
-- 0009 — Campaigns: database marketing, with the consent arithmetic visible.
--
-- The one screen this module exists to get right: an audience that says
--
--     2,431 contacts match this segment
--     2,210 eligible to email
--       221 suppressed — 180 no marketing consent, 33 unsubscribed, 8 bounced
--
-- rather than a single number. A campaign tool that shows only the matched
-- count teaches its users that consent is a detail that happens later.
-- ===========================================================================

CREATE TABLE campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  channel          TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
  purpose          TEXT NOT NULL DEFAULT 'marketing'
                   CHECK (purpose IN ('marketing','service','transactional')),
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','scheduled','sending','paused','completed','cancelled','failed')),

  subject          TEXT,
  preheader        TEXT,
  -- The drag-and-drop document: an ordered list of typed blocks. Rendered to
  -- HTML at send time by one renderer, so a block type gains a feature
  -- everywhere at once and no campaign holds raw pasted HTML.
  blocks           JSONB NOT NULL DEFAULT '[]'::jsonb,
  body_html        TEXT,
  body_text        TEXT,
  from_name        TEXT,
  from_address     TEXT,
  reply_to         TEXT,

  -- The filter, stored as structure rather than SQL. Re-runnable, explainable
  -- on screen, and incapable of becoming an injection surface.
  segment          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The counts at the moment of send, kept forever. A segment re-evaluated
  -- next month gives a different answer, and the question "who did this go to"
  -- has exactly one correct answer.
  audience_snapshot JSONB,

  scheduled_for    TIMESTAMPTZ,
  timezone         TEXT,
  send_started_at  TIMESTAMPTZ,
  send_finished_at TIMESTAMPTZ,
  -- Sends are paced. A brokerage's domain reputation does not survive 40,000
  -- messages in ninety seconds.
  throttle_per_minute INTEGER NOT NULL DEFAULT 120,

  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_status_idx ON campaigns (organization_id, status, scheduled_for);
CREATE TRIGGER campaigns_touch BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE campaign_recipients (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address        TEXT NOT NULL,
  -- 'suppressed' is a first-class outcome with a reason, not an absence. It is
  -- how the audience arithmetic above is reproduced after the fact.
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','suppressed','queued','sent','delivered',
                                   'bounced','failed','opened','clicked','unsubscribed')),
  suppress_reason TEXT,
  message_id     UUID REFERENCES messages(id) ON DELETE SET NULL,
  sent_at        TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ,
  opened_at      TIMESTAMPTZ,
  clicked_at     TIMESTAMPTZ,
  bounced_at     TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  failure_reason TEXT,
  UNIQUE (campaign_id, customer_id)
);
CREATE INDEX campaign_recipients_campaign_idx ON campaign_recipients (campaign_id, status);
CREATE INDEX campaign_recipients_customer_idx ON campaign_recipients (customer_id);
CREATE INDEX campaign_recipients_pending_idx ON campaign_recipients (campaign_id)
  WHERE status IN ('pending','queued');

-- Outcomes, not vanity metrics. An open is a weak signal and an attributed
-- application is not; both are recorded, and the reporting leads with the
-- second.
CREATE TABLE campaign_attributions (
  id             BIGSERIAL PRIMARY KEY,
  campaign_id    UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  application_id UUID REFERENCES applications(id) ON DELETE CASCADE,
  outcome        TEXT NOT NULL
                 CHECK (outcome IN ('application_started','appointment_booked','funded','replied')),
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  value_amount   NUMERIC(14,2),
  detail         JSONB,
  UNIQUE (campaign_id, customer_id, outcome)
);
CREATE INDEX campaign_attributions_campaign_idx ON campaign_attributions (campaign_id, outcome);
