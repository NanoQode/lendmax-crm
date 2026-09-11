-- ===========================================================================
-- 0006 — Compliance: identity, risk, suitability, and the file package.
--
-- WHAT THIS IS AND IS NOT
--
-- This is a workflow, an evidence store and a review queue. It is not a
-- compliance oracle. Every threshold, every risk weight, every checklist item
-- and every retention period is CONFIGURATION with an effective date, verified
-- against FINTRAC, FSRA, CRTC and OPC guidance by a person who is accountable
-- for it. Nothing in this migration hard-codes a legal rule, and the one place
-- it would be tempting to — the risk score — is deliberately built so the score
-- can always be read back as its factors rather than as a number.
--
-- Two rules are structural rather than configurable, and both are here for the
-- same reason:
--
--   · A person, not the system, makes the determination. Every assessment has
--     a `decided_by` and the system's own suggestion is kept beside it, not
--     instead of it.
--   · Unusual-activity handling is routed, never announced. A file escalated
--     to compliance carries no client-visible artefact, and nothing in the
--     client-facing surface reads from these tables. Tipping off is the one
--     mistake a CRM can make here that cannot be corrected afterwards.
-- ===========================================================================

-- ── The case ───────────────────────────────────────────────────────────────
-- One per application. Opened when the file first needs compliance attention
-- and closed only by a compliance manager.
CREATE TABLE compliance_cases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id    UUID NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  status            TEXT NOT NULL DEFAULT 'not_started'
                    CHECK (status IN ('not_started','in_progress','awaiting_review',
                                      'changes_requested','approved','rejected','on_hold')),
  -- The province whose rules this file was worked under, stamped at open time.
  -- A file worked in 2026 under Ontario rules must still read as such after
  -- Lendmax licenses elsewhere.
  province          TEXT NOT NULL DEFAULT 'ON',
  checklist_key     TEXT,

  assigned_to       UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  review_note       TEXT,
  approved_at       TIMESTAMPTZ,

  -- Set when a file must not be deleted or purged: a complaint, an audit, a
  -- regulatory request. Checked by the retention job before anything is ever
  -- removed, and only a compliance manager can lift it.
  legal_hold        BOOLEAN NOT NULL DEFAULT false,
  legal_hold_reason TEXT,
  legal_hold_at     TIMESTAMPTZ,
  legal_hold_by     UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX compliance_cases_status_idx ON compliance_cases (organization_id, status, updated_at DESC);
CREATE INDEX compliance_cases_assigned_idx ON compliance_cases (assigned_to, status);
CREATE INDEX compliance_cases_hold_idx ON compliance_cases (legal_hold) WHERE legal_hold;
CREATE TRIGGER compliance_cases_touch BEFORE UPDATE ON compliance_cases
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Checklists ─────────────────────────────────────────────────────────────
-- The template is versioned and the instance records which version it was
-- completed against. A checklist that gains an item next year must not make
-- last year's approved files retroactively incomplete.
CREATE TABLE compliance_checklist_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  province        TEXT,
  transaction_types TEXT[] NOT NULL DEFAULT '{}',
  -- [{ key, group, label, help, required, evidence: 'document'|'attestation'|'field' }]
  items           JSONB NOT NULL DEFAULT '[]'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT true,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key, version)
);
CREATE TRIGGER compliance_checklist_templates_touch BEFORE UPDATE ON compliance_checklist_templates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE compliance_checklist_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compliance_case_id UUID NOT NULL REFERENCES compliance_cases(id) ON DELETE CASCADE,
  template_key       TEXT NOT NULL,
  template_version   INTEGER NOT NULL,
  item_key           TEXT NOT NULL,
  group_key          TEXT,
  label              TEXT NOT NULL,
  required           BOOLEAN NOT NULL DEFAULT true,
  status             TEXT NOT NULL DEFAULT 'outstanding'
                     CHECK (status IN ('outstanding','complete','not_applicable','rejected')),
  -- Who completed it and when. Per item, not per checklist: "the file was
  -- approved" is not the same evidence as "this person confirmed this item".
  completed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at       TIMESTAMPTZ,
  document_id        UUID REFERENCES documents(id) ON DELETE SET NULL,
  note               TEXT,
  position           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (compliance_case_id, item_key)
);
CREATE INDEX compliance_checklist_items_case_idx
  ON compliance_checklist_items (compliance_case_id, position);
CREATE INDEX compliance_checklist_items_outstanding_idx
  ON compliance_checklist_items (compliance_case_id) WHERE status = 'outstanding' AND required;

-- ── Identity verification (FINTRAC) ────────────────────────────────────────
-- Per person, not per file: a client verified last year is verified, and
-- re-asking for a passport on their refinance is a bad experience with no
-- compliance benefit. The method and its evidence are recorded because the
-- method is what has to be defensible.
CREATE TABLE identity_verifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  application_id    UUID REFERENCES applications(id) ON DELETE SET NULL,
  applicant_id      UUID REFERENCES application_applicants(id) ON DELETE SET NULL,

  method            TEXT NOT NULL
                    CHECK (method IN ('government_photo_id','credit_file','dual_process',
                                      'affiliate_reliance','agent_mandate','other')),
  method_detail     TEXT,
  -- Identifying details of the document shown. The NUMBER is deliberately not
  -- a plain column: see id_number_last4. A CRM has no operational need to hold
  -- a complete passport number, and holding one is a breach waiting to happen.
  document_type     TEXT,
  document_country  TEXT,
  document_province TEXT,
  id_number_last4   TEXT CHECK (id_number_last4 IS NULL OR id_number_last4 ~ '^[A-Za-z0-9]{1,4}$'),
  document_expiry   DATE,
  verified_on       DATE,
  verified_by       UUID REFERENCES users(id) ON DELETE SET NULL,

  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','verified','failed','expired','waived')),
  evidence_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX identity_verifications_customer_idx ON identity_verifications (customer_id, status);
CREATE INDEX identity_verifications_app_idx ON identity_verifications (application_id);
CREATE TRIGGER identity_verifications_touch BEFORE UPDATE ON identity_verifications
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── The FINTRAC assessment ─────────────────────────────────────────────────
-- The structured determinations a mortgage brokerage has to be able to show it
-- made. Each is a field with a decided_by, because "the system decided" is not
-- an answer any of these questions accepts.
CREATE TABLE fintrac_assessments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  compliance_case_id   UUID NOT NULL UNIQUE REFERENCES compliance_cases(id) ON DELETE CASCADE,
  application_id       UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,

  -- Relationship and purpose
  relationship_purpose TEXT,
  relationship_nature  TEXT,

  -- Third party determination
  third_party_checked      BOOLEAN NOT NULL DEFAULT false,
  third_party_present      BOOLEAN,
  third_party_detail       TEXT,

  -- Beneficial ownership, where the borrower is an entity
  entity_borrower          BOOLEAN NOT NULL DEFAULT false,
  entity_name              TEXT,
  entity_registration      TEXT,
  beneficial_owners        JSONB NOT NULL DEFAULT '[]'::jsonb,
  ownership_confirmed_at   TIMESTAMPTZ,

  -- PEP / HIO screening
  pep_screened             BOOLEAN NOT NULL DEFAULT false,
  pep_screened_at          TIMESTAMPTZ,
  pep_result               TEXT CHECK (pep_result IN ('none','domestic','foreign','hio','family','associate')),
  pep_detail               TEXT,
  pep_senior_approval_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  pep_senior_approval_at   TIMESTAMPTZ,

  -- Source of funds and wealth
  source_of_funds          TEXT,
  source_of_funds_detail   TEXT,
  source_of_wealth         TEXT,

  -- Ongoing monitoring
  monitoring_level         TEXT CHECK (monitoring_level IN ('standard','enhanced')),
  monitoring_note          TEXT,

  -- Escalation. Deliberately neutral wording, and nothing here is ever
  -- rendered on a client-facing surface or included in a client export.
  escalated                BOOLEAN NOT NULL DEFAULT false,
  escalated_at             TIMESTAMPTZ,
  escalated_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  escalation_note          TEXT,
  escalation_outcome       TEXT,
  escalation_closed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  escalation_closed_at     TIMESTAMPTZ,

  completed_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fintrac_assessments_app_idx ON fintrac_assessments (application_id);
CREATE INDEX fintrac_assessments_escalated_idx ON fintrac_assessments (organization_id, escalated_at DESC)
  WHERE escalated;
CREATE TRIGGER fintrac_assessments_touch BEFORE UPDATE ON fintrac_assessments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Risk assessment ────────────────────────────────────────────────────────
-- The risk meter, and the reason it is never a black box: `factors` holds every
-- contributing factor with its weight and the value that triggered it, so the
-- screen renders the explanation from the same data that produced the score.
-- A score whose factors cannot be listed is a score nobody can defend.
CREATE TABLE risk_assessments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  compliance_case_id  UUID NOT NULL REFERENCES compliance_cases(id) ON DELETE CASCADE,
  application_id      UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,

  -- The version of the factor model that produced this. A model change must
  -- not silently rewrite the meaning of a score recorded last quarter.
  model_key           TEXT NOT NULL,
  model_version       INTEGER NOT NULL DEFAULT 1,
  score               NUMERIC(7,2),
  rating              TEXT CHECK (rating IN ('low','medium','high','review_required')),
  -- [{ key, label, value, weight, points, note }]
  factors             JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- A person may disagree with the model, and that is a feature. What is not
  -- optional is saying why.
  overridden          BOOLEAN NOT NULL DEFAULT false,
  override_rating     TEXT CHECK (override_rating IN ('low','medium','high','review_required')),
  override_reason     TEXT,
  overridden_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  overridden_at       TIMESTAMPTZ,

  computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX risk_assessments_case_idx ON risk_assessments (compliance_case_id, computed_at DESC);
CREATE INDEX risk_assessments_current_idx ON risk_assessments (application_id)
  WHERE superseded_at IS NULL;

CREATE TABLE risk_factor_definitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_key       TEXT NOT NULL,
  model_version   INTEGER NOT NULL DEFAULT 1,
  factor_key      TEXT NOT NULL,
  label           TEXT NOT NULL,
  description     TEXT,
  weight          NUMERIC(7,2) NOT NULL DEFAULT 1,
  -- How the factor is evaluated: a named evaluator in src/domain/risk.ts plus
  -- its parameters. Not arbitrary code — a fixed set of evaluators, configured.
  evaluator       TEXT NOT NULL,
  parameters      JSONB NOT NULL DEFAULT '{}'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT true,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  source_note     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, model_key, model_version, factor_key)
);
CREATE TRIGGER risk_factor_definitions_touch BEFORE UPDATE ON risk_factor_definitions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Suitability ────────────────────────────────────────────────────────────
-- Structured narrative, not a checkbox. The test this table is designed to
-- pass: another qualified reviewer, a year later, can read it and follow what
-- was known, what was considered, and why the recommendation was made.
CREATE TABLE suitability_assessments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id        UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  compliance_case_id    UUID REFERENCES compliance_cases(id) ON DELETE CASCADE,

  client_objective      TEXT,
  financial_circumstances TEXT,
  client_priorities     TEXT,
  constraints           TEXT,
  -- [{ lender, product, rate, term, amortization, why_not }]
  products_considered   JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_product   TEXT,
  recommended_lender    TEXT,
  why_appropriate       TEXT,
  material_costs        TEXT,
  material_risks        TEXT,
  alternatives_rejected TEXT,
  exit_strategy         TEXT,
  special_considerations TEXT,

  prepared_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  prepared_at           TIMESTAMPTZ,
  reviewed_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at           TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','approved','changes_requested')),
  -- An AI draft is a draft. This records that one was used and that a named
  -- person adopted it; the system never signs a suitability rationale.
  ai_assisted           BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX suitability_app_idx ON suitability_assessments (application_id, created_at DESC);
CREATE TRIGGER suitability_touch BEFORE UPDATE ON suitability_assessments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Retention ──────────────────────────────────────────────────────────────
-- A framework, deliberately not a delete job with guessed rules. Policies are
-- configured, dated and sourced; the runner proposes and a person disposes.
-- Nothing in this system deletes a mortgage record on a schedule nobody
-- approved.
CREATE TABLE retention_policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  -- Retention starts from an event, not from row creation: "six years after
  -- the end of the client relationship" is not "six years after the row".
  anchor          TEXT NOT NULL
                  CHECK (anchor IN ('funded_at','closed_at','last_activity_at','created_at','maturity_date')),
  retain_months   INTEGER NOT NULL,
  -- What happens at the end: nothing automatic by default.
  action          TEXT NOT NULL DEFAULT 'review'
                  CHECK (action IN ('review','anonymise','delete')),
  source_note     TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
CREATE TRIGGER retention_policies_touch BEFORE UPDATE ON retention_policies
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
