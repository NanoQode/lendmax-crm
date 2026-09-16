-- ─────────────────────────────────────────────────────────────────────────────
-- 0018 · Required documents — what a client is asked for, by purpose
--
-- The admin's list: for each of the application's four purposes, the documents
-- a client will be asked for, what to tell them, and which file formats count.
-- The application's "request documents" step reads this list; each request
-- item keeps a copy of the wording it was sent with (below), so editing the
-- list tomorrow does not rewrite what a client was asked for yesterday.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE required_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL
                  CHECK (purpose IN ('purchase', 'renew', 'refinance', 'home_equity_line')),
  name            TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  -- What the client reads: what counts, how recent, from whom.
  description     TEXT CHECK (description IS NULL OR length(description) <= 1000),
  -- Keys from domain/required-documents.ts; never empty — a document that
  -- accepts no format cannot be supplied.
  formats         TEXT[] NOT NULL CHECK (cardinality(formats) > 0),
  -- Optional link to the document category an upload is filed under.
  category_key    TEXT,
  -- Required, or "if it applies to you" (a gift letter).
  required        BOOLEAN NOT NULL DEFAULT true,
  -- Asked of each applicant (pay stubs) rather than once per application.
  per_applicant   BOOLEAN NOT NULL DEFAULT false,
  position        INTEGER NOT NULL DEFAULT 0,
  -- Inactive: kept, but not asked for on new requests.
  active          BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Deleted from the list. Kept so a request that pointed at it still says
  -- where its wording came from.
  archived_at     TIMESTAMPTZ,
  archived_by     UUID REFERENCES users(id) ON DELETE SET NULL
);

-- The same document twice under one purpose is a mistake, not a choice.
CREATE UNIQUE INDEX required_documents_name_key
  ON required_documents (organization_id, purpose, lower(btrim(name))) WHERE archived_at IS NULL;
CREATE INDEX required_documents_list_idx
  ON required_documents (organization_id, purpose, position) WHERE archived_at IS NULL;
CREATE TRIGGER required_documents_touch BEFORE UPDATE ON required_documents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── For the application's request step, when it is built ───────────────────
-- A request item remembers which list entry it came from and the formats it
-- was asked in, so the upload page can refuse a Word file where a PDF was asked.
ALTER TABLE document_request_items
  ADD COLUMN required_document_id UUID REFERENCES required_documents(id) ON DELETE SET NULL,
  ADD COLUMN formats              TEXT[];
