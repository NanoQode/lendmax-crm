-- ===========================================================================
-- 0004 — Documents, document requests, and the client upload link.
--
-- The portal holds the files the client uploaded during the application. This
-- CRM holds everything the brokerage asks for AFTERWARDS, plus a manifest of
-- what the portal has — a manifest, not a second copy of somebody's passport.
-- Where a portal document is opened here it is streamed back through the
-- portal's own authenticated endpoint.
--
-- NOTHING IS PUBLICLY READABLE. There is no permanent URL for a document
-- anywhere in this system. Access is a short-lived signed grant, and every
-- grant is recorded, because "who looked at this client's bank statements" has
-- to have an answer.
-- ===========================================================================

CREATE TABLE document_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  label           TEXT NOT NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  -- Grouping for the client-facing checklist: identity, income, property, …
  group_key       TEXT,
  -- Some documents are on the file from the start but invisible to the
  -- borrower until a person asks for them. Putting "invoices for any deposit
  -- over $3,000" in front of a client unprompted reads as an accusation.
  client_visible  BOOLEAN NOT NULL DEFAULT true,
  -- Held to the stricter access rule and excluded from AI prompts and exports
  -- unless the workflow specifically requires it.
  sensitive       BOOLEAN NOT NULL DEFAULT false,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
CREATE TRIGGER document_categories_touch BEFORE UPDATE ON document_categories
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE documents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id     UUID REFERENCES applications(id) ON DELETE CASCADE,
  customer_id        UUID REFERENCES customers(id) ON DELETE CASCADE,
  applicant_id       UUID REFERENCES application_applicants(id) ON DELETE SET NULL,

  category_key       TEXT,
  -- What the file is called on disk vs what a person should see. Renaming a
  -- display label must never rename the stored object.
  filename           TEXT NOT NULL,
  display_label      TEXT,
  description        TEXT,
  mime_type          TEXT,
  byte_size          BIGINT,
  sha256             TEXT,

  -- Where the bytes are. 'portal' means the portal holds them and we hold only
  -- the manifest entry; storage_key is then the portal's own document id.
  storage_driver     TEXT NOT NULL DEFAULT 'local'
                     CHECK (storage_driver IN ('local','s3','portal')),
  storage_key        TEXT NOT NULL,

  source             TEXT NOT NULL DEFAULT 'staff_upload'
                     CHECK (source IN ('staff_upload','client_upload','portal','email','lender','system')),
  uploaded_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  review_status      TEXT NOT NULL DEFAULT 'pending'
                     CHECK (review_status IN ('pending','accepted','rejected','superseded')),
  reviewed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at        TIMESTAMPTZ,
  review_note        TEXT,

  -- Versioning: a replacement points at what it replaced rather than
  -- overwriting it. An underwriter has to be able to see the pay stub that was
  -- rejected as well as the one that was accepted.
  supersedes_id      UUID REFERENCES documents(id) ON DELETE SET NULL,
  version            INTEGER NOT NULL DEFAULT 1,

  -- Uploads are untrusted input. A document is not downloadable until it has
  -- been scanned; 'skipped' is an explicit, visible state for a deployment
  -- with no scanner configured, so that "not scanned" is never mistaken for
  -- "clean".
  scan_status        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (scan_status IN ('pending','clean','infected','failed','skipped')),
  scan_at            TIMESTAMPTZ,
  scan_detail        TEXT,

  document_request_item_id UUID,
  archived_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_app_idx ON documents (application_id, uploaded_at DESC) WHERE archived_at IS NULL;
CREATE INDEX documents_customer_idx ON documents (customer_id, uploaded_at DESC) WHERE archived_at IS NULL;
CREATE INDEX documents_review_idx ON documents (organization_id, review_status, uploaded_at DESC);
CREATE INDEX documents_category_idx ON documents (application_id, category_key);
CREATE TRIGGER documents_touch BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Who opened what, and when. Not derivable from the audit log's summary text,
-- and needed on its own for a privacy request or an access review.
CREATE TABLE document_access_log (
  id           BIGSERIAL PRIMARY KEY,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_kind   TEXT NOT NULL DEFAULT 'user',
  action       TEXT NOT NULL CHECK (action IN ('view','download','share','delete','export')),
  ip           INET,
  user_agent   TEXT
);
CREATE INDEX document_access_log_doc_idx ON document_access_log (document_id, at DESC);
CREATE INDEX document_access_log_user_idx ON document_access_log (user_id, at DESC);

-- ── Requests ───────────────────────────────────────────────────────────────
CREATE TABLE document_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id    UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  message           TEXT,
  channel           TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms','both')),
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','partial','completed','cancelled','expired')),

  -- The client's way in. A high-entropy token, stored hashed for the same
  -- reason session cookies are: the link is a bearer credential to somebody's
  -- financial documents.
  token_hash        TEXT NOT NULL UNIQUE,
  expires_at        TIMESTAMPTZ NOT NULL,
  first_opened_at   TIMESTAMPTZ,
  last_opened_at    TIMESTAMPTZ,
  open_count        INTEGER NOT NULL DEFAULT 0,
  completed_at      TIMESTAMPTZ,

  requested_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX document_requests_app_idx ON document_requests (application_id, status, created_at DESC);
CREATE INDEX document_requests_open_idx ON document_requests (organization_id, status, created_at)
  WHERE status IN ('open','partial');
CREATE TRIGGER document_requests_touch BEFORE UPDATE ON document_requests
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE document_request_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_request_id UUID NOT NULL REFERENCES document_requests(id) ON DELETE CASCADE,
  category_key        TEXT,
  label               TEXT NOT NULL,
  description         TEXT,
  applicant_id        UUID REFERENCES application_applicants(id) ON DELETE SET NULL,
  required            BOOLEAN NOT NULL DEFAULT true,
  status              TEXT NOT NULL DEFAULT 'outstanding'
                      CHECK (status IN ('outstanding','received','accepted','rejected','waived')),
  received_at         TIMESTAMPTZ,
  position            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX document_request_items_req_idx ON document_request_items (document_request_id, position);
CREATE INDEX document_request_items_status_idx ON document_request_items (status);

ALTER TABLE documents ADD CONSTRAINT documents_request_item_fk
  FOREIGN KEY (document_request_item_id) REFERENCES document_request_items(id) ON DELETE SET NULL;
