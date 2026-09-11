-- ===========================================================================
-- 0012 — The constraints the importer's idempotency actually rests on.
--
-- The portal pushes the same application repeatedly by design: immediately on
-- every save, and again on a thirty-second reconciliation sweep. "Do not
-- insert this twice" therefore has to be enforced by the database, not by the
-- importer remembering to check — a check-then-insert is a race, and two
-- concurrent pushes of the same application is the normal case here rather
-- than a rare one.
-- ===========================================================================

-- One manifest entry per portal document per application. Without this, every
-- re-push adds the same document again and the outstanding-document count
-- climbs on its own.
CREATE UNIQUE INDEX documents_portal_unique_idx
  ON documents (application_id, storage_key)
  WHERE storage_driver = 'portal';

-- `domain_events.dedupe_key` is a PARTIAL unique index (WHERE dedupe_key IS
-- NOT NULL). Postgres will not use a partial index to arbitrate ON CONFLICT
-- unless the statement repeats the predicate, and the error it raises —
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" — sounds like a missing index rather than a missing WHERE.
-- A plain unique index removes the trap entirely; the column is only ever
-- written with a value, and a NULL would mean "this event cannot be
-- deduplicated", which is not a thing the importer should be able to say.
DROP INDEX domain_events_dedupe_idx;
ALTER TABLE domain_events ALTER COLUMN dedupe_key SET NOT NULL;
CREATE UNIQUE INDEX domain_events_dedupe_idx ON domain_events (dedupe_key);
