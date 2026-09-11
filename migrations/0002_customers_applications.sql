-- ===========================================================================
-- 0002 — Customers, applications, and the pipeline.
--
-- THE AUTHORITATIVE RECORD RELATIONSHIP
--
-- apply.lendmax.ca owns the application: the answers, the documents, the
-- client's session. This CRM owns what the *brokerage* does about it — the
-- stage, who it belongs to, what somebody wrote after a call, when it closes,
-- whether it is compliant, whether it funded.
--
-- So an application row here is a mirror plus a workspace, keyed on the
-- portal's own reference (LMX-A-YYYYMM-NNNN), and there is exactly one of them
-- per portal application. Never two records for one client's one mortgage.
--
--   portal_data   the whole portal record, verbatim, so a new field in the
--                 portal's schema needs no migration here
--   the columns   the subset the CRM sorts, filters, reports and calculates
--                 on — which cannot live in JSON, because a board that has to
--                 read every row to draw a column does not stay fast
--
-- A CUSTOMER IS NOT AN APPLICATION. A person renews every few years, refinances
-- once, buys a rental later. Keyed the other way round, the renewal workflow
-- and the whole long-term client database are impossible.
-- ===========================================================================

-- ── Configurable vocabularies ──────────────────────────────────────────────
-- Tables, not CHECK constraints, because the brokerage adds to these without
-- a deploy. Each carries `position` (how it is ordered on screen) and `active`
-- (retired without breaking the files that already reference it — deleting a
-- stage does not delete the history of files that sat on it).

CREATE TABLE pipeline_stages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,          -- stable; automations reference this, not the label
  label           TEXT NOT NULL,
  position        INTEGER NOT NULL,
  -- What the stage means to reporting. 'open' counts in the pipeline, 'won'
  -- and 'lost' do not, 'parked' is nurture. Derived reporting keys off this
  -- rather than off the label, so renaming a stage never moves a number.
  category        TEXT NOT NULL DEFAULT 'open'
                  CHECK (category IN ('open','parked','won','lost')),
  -- Weighted forecast. NULL means "do not include", which is different from 0.
  probability     NUMERIC(5,2) CHECK (probability IS NULL OR (probability >= 0 AND probability <= 100)),
  -- Conditions a file must satisfy before it may enter. Checked server-side by
  -- the stage machine; see src/domain/pipeline.ts.
  entry_rules     JSONB NOT NULL DEFAULT '{}'::jsonb,
  colour          TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
CREATE INDEX pipeline_stages_order_idx ON pipeline_stages (organization_id, position);
CREATE TRIGGER pipeline_stages_touch BEFORE UPDATE ON pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE transaction_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  label           TEXT NOT NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  -- Maps onto the portal's four-value `purpose` so a mirrored application can
  -- be classified without a human. Several CRM types share one portal purpose
  -- (a first-time buyer and a plain purchase are both Purchase up there).
  portal_purpose  TEXT,
  -- Drives required documents, required application sections, which calculators
  -- are offered, and which compliance checklist is used.
  required_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
CREATE TRIGGER transaction_types_touch BEFORE UPDATE ON transaction_types
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE lost_dispositions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key                   TEXT NOT NULL,
  label                 TEXT NOT NULL,
  position              INTEGER NOT NULL DEFAULT 0,
  requires_note         BOOLEAN NOT NULL DEFAULT false,
  -- Reactivation is disposition-specific: "did not qualify" is worth another
  -- look in six months, "not interested" is not worth one at all.
  reactivation_days     INTEGER,
  nurture_eligible      BOOLEAN NOT NULL DEFAULT false,
  active                BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
CREATE TRIGGER lost_dispositions_touch BEFORE UPDATE ON lost_dispositions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Customers ──────────────────────────────────────────────────────────────
-- The person, across every mortgage they ever have with us.
CREATE TABLE customers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name        TEXT,
  last_name         TEXT,
  email             TEXT,
  -- E.164, always. Normalised on the way in by one function (see
  -- src/lib/phone.ts) so that an inbound SMS from +16475551234 finds the
  -- client who typed (647) 555-1234.
  phone_e164        TEXT,
  phone_raw         TEXT,
  date_of_birth     DATE,
  preferred_language TEXT NOT NULL DEFAULT 'en',
  -- Mailing/current address, distinct from any subject property.
  address_line1     TEXT,
  address_line2     TEXT,
  city              TEXT,
  province          TEXT,
  postal_code       TEXT,
  country           TEXT NOT NULL DEFAULT 'CA',

  lead_source       TEXT,
  referral_source   TEXT,
  utm               JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags              TEXT[] NOT NULL DEFAULT '{}',

  -- Denormalised activity stamps. These are read on every list screen and
  -- every staleness rule; computing them from the message table each time is
  -- the query that makes the customer list slow at 50,000 rows.
  last_contacted_at     TIMESTAMPTZ,
  last_inbound_at       TIMESTAMPTZ,
  last_outbound_at      TIMESTAMPTZ,
  -- Set when a client replies and cleared when somebody answers. This one
  -- column is what "clients waiting on us" costs to compute.
  awaiting_reply_since  TIMESTAMPTZ,

  -- Duplicate handling: a merged record is kept, not deleted, and points at
  -- its survivor. Every link that referenced it still resolves.
  merged_into_id    UUID REFERENCES customers(id) ON DELETE SET NULL,
  merged_at         TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX customers_email_idx ON customers (organization_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX customers_phone_idx ON customers (organization_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX customers_name_idx ON customers (organization_id, lower(last_name), lower(first_name));
CREATE INDEX customers_awaiting_idx ON customers (organization_id, awaiting_reply_since)
  WHERE awaiting_reply_since IS NOT NULL;
CREATE INDEX customers_active_idx ON customers (organization_id, updated_at DESC)
  WHERE merged_into_id IS NULL;
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Applications ───────────────────────────────────────────────────────────
CREATE TABLE applications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  -- ── the link to apply.lendmax.ca ──────────────────────────────────────
  portal_reference    TEXT UNIQUE,        -- LMX-A-YYYYMM-NNNN
  portal_id           BIGINT,
  portal_status       TEXT,               -- draft | in_progress | submitted | cancelled
  portal_data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The ratios arrive WITH their line items and are never recomputed here.
  -- The portal calculates a ratio once and records its own working; deriving a
  -- second version in the CRM produces two numbers that disagree, and the one
  -- on screen is then the one nobody trusts.
  portal_ratios       JSONB,
  portal_progress     JSONB,
  mirrored_at         TIMESTAMPTZ,
  mirror_hash         TEXT,

  -- ── what the client wants ─────────────────────────────────────────────
  transaction_type_key TEXT,
  purpose             TEXT,               -- the portal's own word
  amount_requested    NUMERIC(14,2),
  timing              TEXT,
  existing_lender     TEXT,
  refi_reason         TEXT,

  -- ── subject property (portal section 2) ───────────────────────────────
  property_street_number TEXT,
  property_street_name   TEXT,
  property_unit          TEXT,
  property_city          TEXT,
  property_province      TEXT,
  property_postal_code   TEXT,
  property_type          TEXT,
  property_occupancy     TEXT,
  purchase_price         NUMERIC(14,2),
  property_value         NUMERIC(14,2),
  down_payment           NUMERIC(14,2),
  down_payment_source    TEXT,
  existing_balance       NUMERIC(14,2),
  annual_taxes           NUMERIC(14,2),
  monthly_heat           NUMERIC(14,2),
  monthly_condo_fee      NUMERIC(14,2),
  rental_income          NUMERIC(14,2),

  -- ── the dates that drive everything ───────────────────────────────────
  -- DATE, not TIMESTAMPTZ: a closing date is a date in a contract, and giving
  -- it an instant makes it move overnight for anybody in another timezone.
  closing_date        DATE,
  maturity_date       DATE,
  -- Maturity is calculated from funding + term where both are known, and may
  -- then be corrected by a person. Which of the two it is has to be visible,
  -- because a renewal campaign fired off a calculated guess is a client told
  -- the wrong thing about their own mortgage.
  maturity_source     TEXT CHECK (maturity_source IN ('calculated','confirmed','entered')),

  -- ── pipeline ──────────────────────────────────────────────────────────
  stage_key           TEXT,
  stage_changed_at    TIMESTAMPTZ,
  -- A secondary status inside a stage, so every operational state does not
  -- become a Kanban column: "Waiting on Lender" inside Pushed to Scarlett.
  status_key          TEXT,
  lost_disposition_key TEXT,
  lost_reason_note    TEXT,
  lost_at             TIMESTAMPTZ,
  lost_to_competitor  TEXT,
  reactivate_after    DATE,

  -- ── completeness, computed by the portal and mirrored ─────────────────
  percent_complete    INTEGER NOT NULL DEFAULT 0 CHECK (percent_complete BETWEEN 0 AND 100),
  applicant_count     INTEGER NOT NULL DEFAULT 0,
  document_count      INTEGER NOT NULL DEFAULT 0,

  -- ── qualifying numbers, mirrored so lists can sort on them ────────────
  gds                 NUMERIC(7,3),
  tds                 NUMERIC(7,3),
  ltv                 NUMERIC(7,3),
  qualifying_payment  NUMERIC(14,2),

  -- ── Scarlett ──────────────────────────────────────────────────────────
  scarlett_deal_id    TEXT,
  scarlett_status     TEXT,
  scarlett_pushed_at  TIMESTAMPTZ,
  scarlett_pushed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  scarlett_synced_at  TIMESTAMPTZ,
  scarlett_sync_state TEXT CHECK (scarlett_sync_state IN ('never','ok','stale','error')),
  scarlett_last_error TEXT,

  -- ── denormalised operational stamps, for the list and the alerts ──────
  next_task_at        TIMESTAMPTZ,
  next_appointment_at TIMESTAMPTZ,
  last_activity_at    TIMESTAMPTZ,
  documents_outstanding INTEGER NOT NULL DEFAULT 0,

  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at         TIMESTAMPTZ
);
CREATE INDEX applications_stage_idx ON applications (organization_id, stage_key, closing_date)
  WHERE archived_at IS NULL;
CREATE INDEX applications_customer_idx ON applications (customer_id, created_at DESC);
CREATE INDEX applications_closing_idx ON applications (organization_id, closing_date)
  WHERE closing_date IS NOT NULL AND archived_at IS NULL;
CREATE INDEX applications_maturity_idx ON applications (organization_id, maturity_date)
  WHERE maturity_date IS NOT NULL;
CREATE INDEX applications_activity_idx ON applications (organization_id, last_activity_at DESC);
CREATE INDEX applications_scarlett_idx ON applications (scarlett_deal_id) WHERE scarlett_deal_id IS NOT NULL;
CREATE INDEX applications_portal_idx ON applications (portal_id) WHERE portal_id IS NOT NULL;
CREATE TRIGGER applications_touch BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Stage history. Append-only: this is what "average time in stage" and every
-- conversion metric are computed from, and a stage change that overwrites the
-- previous one destroys the only record of how long the file sat there.
CREATE TABLE stage_transitions (
  id              BIGSERIAL PRIMARY KEY,
  application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_stage_key  TEXT,
  to_stage_key    TEXT NOT NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_kind      TEXT NOT NULL DEFAULT 'user',
  reason          TEXT,
  -- How long the file sat on the stage it just left. Stored rather than derived
  -- so that a stage later renamed or retired does not break historical timing.
  seconds_in_from_stage BIGINT
);
CREATE INDEX stage_transitions_app_idx ON stage_transitions (application_id, at DESC);
CREATE INDEX stage_transitions_to_idx ON stage_transitions (to_stage_key, at DESC);

-- ── Assignment ─────────────────────────────────────────────────────────────
-- Many users to one file, each with a named part. A file has at most one
-- primary of each role, which the partial unique index enforces rather than
-- the application code remembering to.
CREATE TABLE assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL
                  CHECK (role IN ('broker','underwriter','manager','compliance','assistant')),
  is_primary      BOOLEAN NOT NULL DEFAULT false,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  unassigned_at   TIMESTAMPTZ,
  UNIQUE (application_id, user_id, role)
);
CREATE UNIQUE INDEX assignments_one_primary_idx
  ON assignments (application_id, role)
  WHERE is_primary AND unassigned_at IS NULL;
CREATE INDEX assignments_user_idx ON assignments (user_id, role) WHERE unassigned_at IS NULL;
CREATE INDEX assignments_app_idx ON assignments (application_id) WHERE unassigned_at IS NULL;

-- ── The application's own detail ───────────────────────────────────────────
-- Normalised out of portal_data, because GDS/TDS reporting, lender submission
-- payloads and document requirements all need to query across these — and a
-- JSONB array cannot be joined, indexed or aggregated usefully at scale.
--
-- Mirrored, never authored here: `portal_path` records where each row came
-- from so a re-mirror can replace it exactly.

CREATE TABLE application_applicants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id     UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  customer_id        UUID REFERENCES customers(id) ON DELETE SET NULL,
  position           INTEGER NOT NULL,          -- 0 is the primary applicant
  applicant_role     TEXT NOT NULL DEFAULT 'applicant'
                     CHECK (applicant_role IN ('applicant','co_applicant','guarantor')),
  first_name         TEXT,
  last_name          TEXT,
  email              TEXT,
  phone_e164         TEXT,
  date_of_birth      DATE,
  marital_status     TEXT,
  dependants         INTEGER,
  citizenship        TEXT,
  credit_self_report TEXT,
  -- Current address
  addr_street_number TEXT,
  addr_street_name   TEXT,
  addr_unit          TEXT,
  addr_city          TEXT,
  addr_province      TEXT,
  addr_postal        TEXT,
  residential_status TEXT,
  monthly_rent       NUMERIC(14,2),
  years_at_address   NUMERIC(6,2),
  prev_address       TEXT,
  portal_path        TEXT,
  UNIQUE (application_id, position)
);
CREATE INDEX application_applicants_app_idx ON application_applicants (application_id, position);
CREATE INDEX application_applicants_customer_idx ON application_applicants (customer_id);

CREATE TABLE application_employments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  applicant_id      UUID NOT NULL REFERENCES application_applicants(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL DEFAULT 0,
  -- 'primary' is the employment declared on the applicant record itself; the
  -- rest come from the portal's "other employment" repeater.
  slot              TEXT NOT NULL DEFAULT 'additional' CHECK (slot IN ('primary','additional')),
  status            TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Previous')),
  employment_type   TEXT,
  employment_basis  TEXT,
  employer          TEXT,
  job_title         TEXT,
  years             NUMERIC(6,2),
  annual_income     NUMERIC(14,2),
  income_frequency  TEXT,
  ended_on          DATE,
  portal_path       TEXT
);
CREATE INDEX application_employments_app_idx ON application_employments (application_id);
CREATE INDEX application_employments_applicant_idx ON application_employments (applicant_id);

CREATE TABLE application_incomes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  applicant_id     UUID REFERENCES application_applicants(id) ON DELETE SET NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  income_type      TEXT,
  amount           NUMERIC(14,2),
  frequency        TEXT,
  source           TEXT,
  years_receiving  NUMERIC(6,2),
  portal_path      TEXT
);
CREATE INDEX application_incomes_app_idx ON application_incomes (application_id);

CREATE TABLE application_assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  applicant_id      UUID REFERENCES application_applicants(id) ON DELETE SET NULL,
  position          INTEGER NOT NULL DEFAULT 0,
  asset_type        TEXT,
  value             NUMERIC(14,2),
  institution       TEXT,
  for_down_payment  BOOLEAN NOT NULL DEFAULT false,
  portal_path       TEXT
);
CREATE INDEX application_assets_app_idx ON application_assets (application_id);

CREATE TABLE application_liabilities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  applicant_id     UUID REFERENCES application_applicants(id) ON DELETE SET NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  liability_type   TEXT,
  lender           TEXT,
  balance          NUMERIC(14,2),
  monthly_payment  NUMERIC(14,2),
  -- Being paid out with the mortgage: excluded from TDS on the refinance it
  -- is being consolidated into, and that exclusion is the whole point of the
  -- deal. It is mirrored, never inferred.
  payoff           BOOLEAN NOT NULL DEFAULT false,
  portal_path      TEXT
);
CREATE INDEX application_liabilities_app_idx ON application_liabilities (application_id);

CREATE TABLE application_properties (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  applicant_id     UUID REFERENCES application_applicants(id) ON DELETE SET NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  street           TEXT,
  city             TEXT,
  province         TEXT,
  postal_code      TEXT,
  property_type    TEXT,
  occupancy        TEXT,
  value            NUMERIC(14,2),
  annual_taxes     NUMERIC(14,2),
  monthly_heat     NUMERIC(14,2),
  monthly_condo_fee NUMERIC(14,2),
  rental_income    NUMERIC(14,2),
  to_be_sold       BOOLEAN NOT NULL DEFAULT false,
  -- the mortgage(s) on it
  has_mortgage     BOOLEAN NOT NULL DEFAULT false,
  mtg_lender       TEXT,
  mtg_balance      NUMERIC(14,2),
  mtg_payment      NUMERIC(14,2),
  mtg_frequency    TEXT,
  mtg_rate         NUMERIC(9,6),          -- percent: 5.29 means 5.29%
  mtg_type         TEXT,
  mtg_maturity     DATE,
  mtg2_balance     NUMERIC(14,2),
  mtg2_payment     NUMERIC(14,2),
  portal_path      TEXT
);
CREATE INDEX application_properties_app_idx ON application_properties (application_id);
-- Every other property with a maturity date is a renewal opportunity the
-- brokerage already knows about and would otherwise never look at again.
CREATE INDEX application_properties_maturity_idx ON application_properties (mtg_maturity)
  WHERE mtg_maturity IS NOT NULL;
