-- ===========================================================================
-- 0013 — Scarlett's code tables, cached.
--
-- Scarlett's enums are integers and no list is published; the numbers come
-- from `dosconnect/dropdown-pull`, which returns every MenuCode with its
-- ItemValue/ItemLabel pairs. They are cached here rather than fetched per push
-- because a deal push should not depend on a second network call succeeding.
--
-- THE RULE THIS TABLE EXISTS TO SERVE: an enum that cannot be mapped is LEFT
-- OUT of the payload, never sent as a guess. A field Scarlett can default or
-- query later is recoverable; a wrong integer sent confidently is not. So a
-- deal arriving with no marital status means "we could not map it" and never
-- "single".
-- ===========================================================================

CREATE TABLE scarlett_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  menu_code       TEXT NOT NULL,
  item_value      TEXT NOT NULL,
  item_label      TEXT NOT NULL,
  -- Our own vocabulary, lower-cased and stripped, so a lookup does not depend
  -- on punctuation matching exactly ("Employed — salaried" vs "Employed -
  -- salaried").
  normalised      TEXT NOT NULL,
  pulled_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, menu_code, item_value)
);
CREATE INDEX scarlett_codes_lookup_idx ON scarlett_codes (organization_id, menu_code, normalised);

-- A local override, for the cases where our wording and theirs will never
-- normalise to the same string. Edited from Settings → Integrations → Scarlett
-- rather than by a deploy, because the person who knows the right answer is a
-- broker looking at both lists.
CREATE TABLE scarlett_code_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  menu_code       TEXT NOT NULL,
  our_value       TEXT NOT NULL,
  their_value     TEXT NOT NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, menu_code, our_value)
);
