-- ─────────────────────────────────────────────────────────────────────────────
-- 0025 · Staff corrections to a client's answers
--
-- Until now the rule was absolute: the portal owned the client's answers and a
-- newer push replaced them wholesale (docs/field-map.md, rule 2). Brokers need
-- to correct what a client typed — a transposed postal code, an income the
-- client understated on the phone afterwards — and losing that correction to
-- the next mirror push is worse than not having it.
--
-- So the rule is now: THE CLIENT OWNS THE ANSWER, THE BROKERAGE OWNS THE
-- CORRECTION, AND THE CORRECTION WINS. `portal_data` still holds exactly what
-- the client said and is still replaced wholesale — nothing here writes to it.
-- What a broker changes is recorded against the path it changed, laid over the
-- portal's copy when the file is read, and re-applied after every push.
--
-- A scalar is pinned by itself, so a correction to one field does not freeze
-- the forty beside it. A list is pinned as a list: rows have no stable identity
-- across a client's edits, and pinning per row would silently reattach a
-- correction to a different debt.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE application_field_edits (
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- 'property.postal_code' for a field, 'liabilities' for a whole list.
  path           TEXT NOT NULL,
  -- Any JSON the form can hold: a string, a number, or a list of rows.
  value          JSONB,
  -- What the client had said at the moment it was corrected, so the screen can
  -- show both without going back to a push that may since have been replaced.
  portal_value   JSONB,
  edited_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  edited_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, path)
);
CREATE INDEX application_field_edits_app_idx ON application_field_edits (application_id, edited_at DESC);

-- Shown on the file so nobody has to wonder whether what they are reading is
-- the client's answer or a colleague's correction.
ALTER TABLE applications
  ADD COLUMN staff_edited_at TIMESTAMPTZ,
  ADD COLUMN staff_edited_by UUID REFERENCES users(id) ON DELETE SET NULL;
