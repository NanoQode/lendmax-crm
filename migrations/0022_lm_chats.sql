-- ─────────────────────────────────────────────────────────────────────────────
-- 0022 · LM Chats — internal staff messaging
--
--   · conversations: one-to-one with an admin, groups an admin makes, and the
--     one permanent Community group every organization has
--   · membership, with the per-person read mark and mute that drive the unread
--     badge and whether a notification is raised
--   · messages, and their attachments in the same storage as documents
--
-- Two invariants are the database's job, not the application's, because the
-- application is not the only thing that will ever write here:
--   · a pair of people has at most one direct conversation (`direct_key`)
--   · an organization has exactly one Community group
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE chat_conversations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('direct', 'group', 'community')),
  -- Groups are named; a direct conversation is named by whoever you are
  -- talking to, which is a property of the reader, not of the row.
  name             TEXT,
  -- False on the Community group until an admin opens it up. A plain group is
  -- created open, because a group is where a team talks.
  everyone_can_post BOOLEAN NOT NULL DEFAULT true,
  -- The two user ids of a direct conversation, sorted and joined by ':'. NULL
  -- for groups. The unique index below is what stops a double-tap creating two
  -- threads between the same two people.
  direct_key       TEXT,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Denormalised so the conversation list can sort newest-first without
  -- touching chat_messages. Written by the same statement that inserts the
  -- message, inside its transaction.
  last_message_at  TIMESTAMPTZ,
  archived_at      TIMESTAMPTZ,
  CHECK ((kind = 'direct') = (direct_key IS NOT NULL))
);

CREATE UNIQUE INDEX chat_direct_key ON chat_conversations (organization_id, direct_key)
  WHERE direct_key IS NOT NULL;
CREATE UNIQUE INDEX chat_one_community ON chat_conversations (organization_id)
  WHERE kind = 'community';
CREATE INDEX chat_conversations_recent_idx
  ON chat_conversations (organization_id, last_message_at DESC NULLS LAST);

CREATE TRIGGER chat_conversations_touch BEFORE UPDATE ON chat_conversations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Membership ─────────────────────────────────────────────────────────────

-- Leaving a group deletes the row. The group's own message trail keeps the
-- record of who left and when, so nothing is lost by not keeping a tombstone.
CREATE TABLE chat_members (
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Everything at or before this instant has been seen. NULL means nothing
  -- has, which is what a new member of an old group should see: all of it
  -- unread, exactly as if the messages had just arrived.
  last_read_at    TIMESTAMPTZ,
  -- Muted while this is in the future. "Always" is stored as year 9999 so
  -- every query is one comparison and none of them special-case it.
  muted_until     TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX chat_members_user_idx ON chat_members (user_id);

-- ── Messages ───────────────────────────────────────────────────────────────

CREATE TABLE chat_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NULL for a system line ("Alex added Dana"), which nobody wrote.
  sender_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system')),
  body            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind = 'system' OR sender_id IS NOT NULL)
);
-- The one index the thread view needs: a conversation, newest first.
CREATE INDEX chat_messages_thread_idx ON chat_messages (conversation_id, created_at DESC, id DESC);
-- Counting unread per member: "since my last_read_at, not mine".
CREATE INDEX chat_messages_unread_idx ON chat_messages (conversation_id, created_at)
  WHERE kind = 'text';

-- Attachments live in the same object storage as documents and are reached the
-- same way: a short-lived signed grant for one person, never a permanent URL.
-- They are NOT rows in `documents` — a file passed between staff is not on a
-- client's file, and putting it there would corrupt the document trail.
CREATE TABLE chat_attachments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  byte_size      BIGINT NOT NULL,
  sha256         TEXT NOT NULL,
  storage_driver TEXT NOT NULL DEFAULT 'local',
  storage_key    TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_attachments_message_idx ON chat_attachments (message_id);

-- ── The Community group ────────────────────────────────────────────────────

-- Created here for every organization that already exists, and by
-- services/chats.ts at boot for one created later. Everyone active is in it,
-- and only an admin speaks in it until an admin says otherwise.
INSERT INTO chat_conversations (organization_id, kind, name, everyone_can_post)
SELECT o.id, 'community', 'Community', false FROM organizations o;

INSERT INTO chat_members (conversation_id, user_id)
SELECT c.id, u.id
  FROM chat_conversations c
  JOIN users u ON u.organization_id = c.organization_id AND u.active
 WHERE c.kind = 'community';
