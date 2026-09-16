-- ─────────────────────────────────────────────────────────────────────────────
-- 0017 · Email signatures that staff can edit
--
-- signature_html / signature_text existed since 0001 and nothing wrote them.
-- A person now either keeps the standard signature (built from their profile)
-- or writes their own. What they wrote is kept in signature_source; the two
-- rendered parts are rebuilt whenever it or the profile changes, and every
-- sent message keeps its own copy in its body.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE user_profiles
  ADD COLUMN signature_mode       TEXT NOT NULL DEFAULT 'standard'
                                  CHECK (signature_mode IN ('standard', 'custom')),
  ADD COLUMN signature_source     TEXT,
  ADD COLUMN signature_updated_at TIMESTAMPTZ;
