-- ===========================================================================
-- 0007 — Lenders, submissions, funding, commission, renewals, Scarlett.
--
-- The back half of a mortgage file, which most CRMs treat as a status and a
-- date. It is not: it is where the brokerage's revenue is, where the renewal
-- that pays for the next five years comes from, and where the compliance file
-- is finally closed.
-- ===========================================================================

CREATE TABLE lenders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  short_name      TEXT,
  lender_type     TEXT CHECK (lender_type IN ('bank','credit_union','monoline','trust','mic','private','other')),
  -- Commission basis, as agreed with this lender. Stored, never assumed: the
  -- default that "everyone pays 85bps" is how a year of commission variance
  -- gets explained away instead of investigated.
  default_bps     NUMERIC(9,4),
  active          BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE TRIGGER lenders_touch BEFORE UPDATE ON lenders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE lender_submissions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id   UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  lender_id        UUID REFERENCES lenders(id) ON DELETE SET NULL,
  lender_name      TEXT NOT NULL,
  submitted_at     TIMESTAMPTZ,
  submitted_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','submitted','approved','conditional','declined','withdrawn','expired')),
  status_changed_at TIMESTAMPTZ,
  decision_note    TEXT,
  declined_reason  TEXT,
  -- The offer as it stands with this lender
  rate             NUMERIC(9,6),          -- percent: 4.89 means 4.89%
  rate_type        TEXT CHECK (rate_type IN ('fixed','variable','adjustable')),
  term_months      INTEGER,
  amortization_months INTEGER,
  amount           NUMERIC(14,2),
  commitment_expires_on DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lender_submissions_app_idx ON lender_submissions (application_id, submitted_at DESC);
CREATE INDEX lender_submissions_status_idx ON lender_submissions (organization_id, status);
CREATE TRIGGER lender_submissions_touch BEFORE UPDATE ON lender_submissions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Lender conditions. The thing that actually blocks a closing, and the reason
-- "closes in 4 days, 2 conditions outstanding" has to be a first-class query
-- rather than a note somebody wrote.
CREATE TABLE lender_conditions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_submission_id UUID NOT NULL REFERENCES lender_submissions(id) ON DELETE CASCADE,
  application_id       UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  label                TEXT NOT NULL,
  detail               TEXT,
  due_on               DATE,
  status               TEXT NOT NULL DEFAULT 'outstanding'
                       CHECK (status IN ('outstanding','submitted','satisfied','waived')),
  satisfied_at         TIMESTAMPTZ,
  satisfied_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  document_id          UUID REFERENCES documents(id) ON DELETE SET NULL,
  position             INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lender_conditions_app_idx ON lender_conditions (application_id, status);
CREATE INDEX lender_conditions_outstanding_idx ON lender_conditions (application_id, due_on)
  WHERE status = 'outstanding';
CREATE TRIGGER lender_conditions_touch BEFORE UPDATE ON lender_conditions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Funding ────────────────────────────────────────────────────────────────
-- Recorded, never derived. A lender routinely advances a different number from
-- the one requested, and reporting the request as the funding is the error
-- that compounds quietly for a year and then makes every historical figure and
-- every commission calculation wrong.
CREATE TABLE funding_records (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id       UUID NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  lender_id            UUID REFERENCES lenders(id) ON DELETE SET NULL,
  lender_name          TEXT,
  product_name         TEXT,

  approved_amount      NUMERIC(14,2),
  funded_amount        NUMERIC(14,2),
  rate                 NUMERIC(9,6),      -- percent
  rate_type            TEXT CHECK (rate_type IN ('fixed','variable','adjustable')),
  term_months          INTEGER,
  amortization_months  INTEGER,
  payment_frequency    TEXT,
  payment_amount       NUMERIC(14,2),

  -- Canadian insurance treatment, which drives the qualifying rules and the
  -- premium. Not a boolean: insured, insurable and uninsured are three
  -- different things with three different rate sheets.
  insurance_status     TEXT CHECK (insurance_status IN ('insured','insurable','uninsured')),
  insurer              TEXT CHECK (insurer IN ('CMHC','Sagen','Canada Guaranty')),
  insurance_premium    NUMERIC(14,2),

  funding_date         DATE,
  maturity_date        DATE,
  first_payment_date   DATE,

  lender_fee           NUMERIC(14,2),
  brokerage_fee        NUMERIC(14,2),
  other_fees           NUMERIC(14,2),
  other_fees_note      TEXT,

  final_transaction_type TEXT,
  confirmed            BOOLEAN NOT NULL DEFAULT false,
  confirmed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at         TIMESTAMPTZ,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX funding_records_date_idx ON funding_records (organization_id, funding_date DESC);
CREATE INDEX funding_records_maturity_idx ON funding_records (organization_id, maturity_date)
  WHERE maturity_date IS NOT NULL;
CREATE TRIGGER funding_records_touch BEFORE UPDATE ON funding_records
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Commission ─────────────────────────────────────────────────────────────
CREATE TABLE commission_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id    UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  funding_record_id UUID REFERENCES funding_records(id) ON DELETE SET NULL,

  source            TEXT NOT NULL DEFAULT 'lender'
                    CHECK (source IN ('lender','borrower','referral','volume_bonus','other')),
  lender_id         UUID REFERENCES lenders(id) ON DELETE SET NULL,
  lender_name       TEXT,
  basis_bps         NUMERIC(9,4),
  gross_expected    NUMERIC(14,2),
  gross_received    NUMERIC(14,2),
  expected_on       DATE,
  received_on       DATE,

  status            TEXT NOT NULL DEFAULT 'expected'
                    CHECK (status IN ('expected','submitted','awaiting_payment','received',
                                      'reconciled','variance','closed')),
  -- Signed: received minus expected. Stored rather than computed on read so a
  -- variance report is one index scan and so the number that was investigated
  -- is the number that was recorded.
  variance_amount   NUMERIC(14,2),
  variance_note     TEXT,
  reconciled_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  reconciled_at     TIMESTAMPTZ,
  document_id       UUID REFERENCES documents(id) ON DELETE SET NULL,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commission_records_app_idx ON commission_records (application_id);
CREATE INDEX commission_records_status_idx ON commission_records (organization_id, status, expected_on);
CREATE INDEX commission_records_outstanding_idx ON commission_records (organization_id, expected_on)
  WHERE status IN ('expected','submitted','awaiting_payment');
CREATE TRIGGER commission_records_touch BEFORE UPDATE ON commission_records
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- How one commission is divided. Rows, not columns, because the number of
-- parties varies and a schema with broker_split/brokerage_split/other_split
-- cannot express a three-way referral without another migration.
CREATE TABLE commission_splits (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_record_id UUID NOT NULL REFERENCES commission_records(id) ON DELETE CASCADE,
  party                TEXT NOT NULL CHECK (party IN ('broker','brokerage','referrer','house','other')),
  user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
  party_name           TEXT,
  percent              NUMERIC(7,4),
  amount               NUMERIC(14,2),
  paid_on              DATE,
  note                 TEXT
);
CREATE INDEX commission_splits_record_idx ON commission_splits (commission_record_id);
CREATE INDEX commission_splits_user_idx ON commission_splits (user_id);

-- ── Renewals ───────────────────────────────────────────────────────────────
-- A funded mortgage is a renewal opportunity with a known date. This table is
-- what turns that into work: the milestones, whether each was reached, and the
-- outcome — so the campaign stops the moment the file resolves.
CREATE TABLE renewal_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- The mortgage this renewal is for. Null when the maturity came from a
  -- client's declared existing mortgage rather than one we funded — which is
  -- still a renewal opportunity, and often the best one.
  application_id    UUID REFERENCES applications(id) ON DELETE SET NULL,
  funding_record_id UUID REFERENCES funding_records(id) ON DELETE SET NULL,

  maturity_date     DATE NOT NULL,
  maturity_source   TEXT NOT NULL DEFAULT 'calculated'
                    CHECK (maturity_source IN ('calculated','confirmed','entered','declared')),
  lender_name       TEXT,
  balance_estimate  NUMERIC(14,2),
  rate              NUMERIC(9,6),

  status            TEXT NOT NULL DEFAULT 'upcoming'
                    CHECK (status IN ('upcoming','engaged','in_progress','renewed_with_us',
                                      'lost_to_other','paid_out','declined','cancelled')),
  assigned_to       UUID REFERENCES users(id) ON DELETE SET NULL,
  -- The new file, once the renewal becomes a live application.
  renewal_application_id UUID REFERENCES applications(id) ON DELETE SET NULL,
  outcome_note      TEXT,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX renewal_records_maturity_idx ON renewal_records (organization_id, maturity_date)
  WHERE status IN ('upcoming','engaged','in_progress');
CREATE INDEX renewal_records_customer_idx ON renewal_records (customer_id, maturity_date DESC);
CREATE TRIGGER renewal_records_touch BEFORE UPDATE ON renewal_records
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- T-6 months, T-3 months, T-45 days. A row per milestone per renewal, created
-- when the renewal is opened, so "which clients hit T-45 tomorrow" is a query
-- and not a nightly recomputation of everybody's dates.
CREATE TABLE renewal_milestones (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  renewal_record_id UUID NOT NULL REFERENCES renewal_records(id) ON DELETE CASCADE,
  milestone_key     TEXT NOT NULL,        -- t_minus_6m | t_minus_3m | t_minus_45d
  due_on            DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','skipped','cancelled','failed')),
  completed_at      TIMESTAMPTZ,
  message_id        UUID REFERENCES messages(id) ON DELETE SET NULL,
  task_id           UUID REFERENCES tasks(id) ON DELETE SET NULL,
  skip_reason       TEXT,
  UNIQUE (renewal_record_id, milestone_key)
);
CREATE INDEX renewal_milestones_due_idx ON renewal_milestones (due_on, status)
  WHERE status = 'pending';

-- ── Scarlett sync ──────────────────────────────────────────────────────────
-- Every attempt, successful or not, with the payload that was sent. When a push
-- fails at 6pm on a Friday the question is always "what did we actually send",
-- and an integration that cannot answer it costs a weekend.
CREATE TABLE scarlett_syncs (
  id               BIGSERIAL PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id   UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  operation        TEXT NOT NULL CHECK (operation IN ('create','update','fetch_status','attach_document')),
  direction        TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  attempt          INTEGER NOT NULL DEFAULT 1,
  request_payload  JSONB,
  response_payload JSONB,
  http_status      INTEGER,
  ok               BOOLEAN NOT NULL DEFAULT false,
  -- An operational sentence, not a status code. "Scarlett rejected the deal
  -- because the subject property has no province" is actionable; "500" is not.
  error_message    TEXT,
  error_code       TEXT,
  scarlett_deal_id TEXT,
  duration_ms      INTEGER,
  actor_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scarlett_syncs_app_idx ON scarlett_syncs (application_id, at DESC);
CREATE INDEX scarlett_syncs_failures_idx ON scarlett_syncs (organization_id, at DESC) WHERE NOT ok;
