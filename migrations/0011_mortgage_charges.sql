-- ===========================================================================
-- 0011 — Registered charges, as the portal actually models them.
--
-- WHY THIS CORRECTS 0002
--
-- The application tables in 0002 were built from the portal's generated field
-- dictionary (`lendmax-portal-fields.csv`), which described one mortgage per
-- property as a flat set of `mtg_*` columns plus a second-mortgage balance.
--
-- Reading the portal's live `lib/schema.js` shows that is no longer true. It
-- now uses a shared `mortgageFields()` repeater — up to three charges, on the
-- SUBJECT property as well as on each other property — and the request itself
-- carries a position:
--
--     purpose.request_position     1st / 2nd / 3rd
--     purpose.request_loan_type    Mortgage / Line of Credit
--     property.mortgages[]         the charges already registered
--     other_properties[].mortgages[]
--
-- This is not cosmetic. The portal's own comment on it:
--
--     "Loan to value is the money being asked for PLUS whatever stays
--      registered ahead of it, over the value of the house. A $100,000 second
--      behind a $400,000 first on a $625,000 house is 80%, not 16% — and 16%
--      is the number that gets a file sent to a lender who will decline it."
--
-- Flat columns cannot express three charges in position order, so they cannot
-- reproduce that figure. They are dropped rather than left in place: an unused
-- column that looks like it holds the mortgage is worse than no column, because
-- somebody will eventually read it.
--
-- `opening_balance` is carried because the portal asks for it deliberately —
-- the pair with the current balance is how fast a charge is being paid down,
-- and on a line of credit the gap between the limit and what is drawn is the
-- room already available, which is often exactly what the client came to ask
-- about.
-- ===========================================================================

ALTER TABLE applications ADD COLUMN request_position TEXT;    -- '1' | '2' | '3'
ALTER TABLE applications ADD COLUMN request_loan_type TEXT;   -- Mortgage | Line of Credit

CREATE TABLE application_mortgages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- NULL means the subject property. A charge on another property points at it.
  property_id     UUID REFERENCES application_properties(id) ON DELETE CASCADE,
  -- Order within that property, as entered.
  seq             INTEGER NOT NULL DEFAULT 0,

  position        TEXT,                    -- '1' | '2' | '3'
  loan_type       TEXT,                    -- Mortgage | Line of Credit
  lender          TEXT,
  balance         NUMERIC(14,2),
  opening_balance NUMERIC(14,2),
  rate            NUMERIC(9,6),            -- percent: 4.79 means 4.79%
  term            TEXT,
  maturity        DATE,
  payment         NUMERIC(14,2),
  frequency       TEXT,
  rate_type       TEXT,                    -- Fixed | Variable | Adjustable
  portal_path     TEXT
);
CREATE INDEX application_mortgages_app_idx ON application_mortgages (application_id, seq);
CREATE INDEX application_mortgages_property_idx ON application_mortgages (property_id);
-- Every charge with a maturity date is a renewal the brokerage already knows
-- about, whether or not we funded it.
CREATE INDEX application_mortgages_maturity_idx ON application_mortgages (maturity)
  WHERE maturity IS NOT NULL;

-- The flat columns the stale dictionary implied. No production data has ever
-- been written to them.
ALTER TABLE application_properties DROP COLUMN mtg_lender;
ALTER TABLE application_properties DROP COLUMN mtg_balance;
ALTER TABLE application_properties DROP COLUMN mtg_payment;
ALTER TABLE application_properties DROP COLUMN mtg_frequency;
ALTER TABLE application_properties DROP COLUMN mtg_rate;
ALTER TABLE application_properties DROP COLUMN mtg_type;
ALTER TABLE application_properties DROP COLUMN mtg_maturity;
ALTER TABLE application_properties DROP COLUMN mtg2_balance;
ALTER TABLE application_properties DROP COLUMN mtg2_payment;

-- ── Ratio inputs worth querying ────────────────────────────────────────────
-- The portal sends its whole ratio record, line items included, and the CRM
-- displays it as received. These few are promoted to columns because reports
-- filter and sort on them — "every file qualified above 5.25%" is a question
-- somebody asks after a rate rule changes, and it should not need a JSON scan.
ALTER TABLE applications ADD COLUMN qualifying_rate NUMERIC(9,6);
ALTER TABLE applications ADD COLUMN monthly_income NUMERIC(14,2);
ALTER TABLE applications ADD COLUMN shelter_cost NUMERIC(14,2);
ALTER TABLE applications ADD COLUMN other_debt_payments NUMERIC(14,2);
-- What stays registered ahead of the money being asked for. The difference
-- between an LTV a lender accepts and one that gets the file declined.
ALTER TABLE applications ADD COLUMN charges_ahead NUMERIC(14,2);
