-- ─────────────────────────────────────────────────────────────────────────────
-- 0023 · LM Chats — editing, deleting, read receipts, search and photos
--
--   · a message can be edited or taken back, but only by whoever sent it and
--     only for 19 minutes. A deleted message leaves a tombstone: the row stays
--     so the conversation does not silently reshape itself around a gap.
--   · read receipts need no table. "Read" is `chat_members.last_read_at` at or
--     past a message's `created_at`, which is the same fact the unread count is
--     already built on — one source, so a tick and a badge can never disagree.
--   · photos for a group and for a person, stored like every other upload:
--     an object key, never a public URL.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE chat_messages
  ADD COLUMN edited_at  TIMESTAMPTZ,
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Search runs inside one conversation, so the thread index already narrows it
-- to a few thousand rows and a scan of those is faster than maintaining a
-- full-text index — and ILIKE matches the middle of a word, which is what
-- somebody looking for "scarlett" in "scarlettdeal" expects.

-- ── Photos ─────────────────────────────────────────────────────────────────

-- `photo_url` has been on user_profiles since 0001 and nothing ever wrote to
-- it. It stays for an externally hosted picture; these are for one we hold.
ALTER TABLE user_profiles
  ADD COLUMN photo_key        TEXT,
  ADD COLUMN photo_mime       TEXT,
  ADD COLUMN photo_updated_at TIMESTAMPTZ;

-- A group's picture. A direct conversation has none: it shows the other
-- person, which is a property of who is looking rather than of the row.
ALTER TABLE chat_conversations
  ADD COLUMN photo_key        TEXT,
  ADD COLUMN photo_mime       TEXT,
  ADD COLUMN photo_updated_at TIMESTAMPTZ;
