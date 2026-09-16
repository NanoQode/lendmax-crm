/**
 * LM Chats — conversations, membership, messages and their attachments.
 *
 * Internal staff messaging, and the only door into it is the admin panel:
 * there is no /api/v1 surface, because a connected website has no business
 * reading what staff say to each other.
 *
 * Every rule about who may talk to whom, who may post, and what cannot be left
 * lives in `domain/chats.ts` and is unit-tested there. This module does the
 * writing, and keeps the rest of the CRM in step:
 *
 *   · open tabs are told immediately (services/realtime.ts);
 *   · anybody who is not watching gets one bell notification per conversation,
 *     deduped, so a hundred messages do not become a hundred rows;
 *   · group administration — who was let in, who was taken out, who may post —
 *     goes to the audit trail and therefore the activity log. What was *said*
 *     never does. A staff conversation is not the brokerage's activity feed.
 */
import { Readable } from 'node:stream';
import { z } from 'zod';
import { env } from '../config/env.ts';
import { pool, query, queryOne, withTransaction, type Queryable } from '../db/pool.ts';
import {
  amendRefusal, canOpenDirect, checkAttachment, checkPhoto, DEFAULT_COMMUNITY_NAME, DELETED_PLACEHOLDER,
  deleteRefusal, directKey, editWindowClosesAt, editWindowRemaining, formatBytes,
  groupNameRefusal, isImage, leaveRefusal, manageRefusal, MAX_BODY_LENGTH,
  MESSAGE_PAGE, messageRefusal, MUTE_KEYS, muteUntil, postRefusal, previewOf, readLabel, readState,
  searchRefusal, snippetAround, titleFor, TYPING_EXPIRY_MS,
  type ChatKind, type MuteOption,
} from '../domain/chats.ts';
import { ROLES } from '../domain/permissions.ts';
import { AppError, notFound } from '../http/middleware/errors.ts';
import { log } from '../lib/logger.ts';
import { recordAudit } from './audit.ts';
import { publish, isConnected } from './realtime.ts';
import { deleteObject, putObject } from './storage.ts';
import type { Actor } from './staff.ts';

/**
 * The signed-in person, as this module needs them: who they are, and whether
 * they are a chat admin. `isAdmin` is the `chat.admin` permission, resolved by
 * the route — a role is never consulted here.
 */
export type Scope = {
  actor: Actor;
  isAdmin: boolean;
};

const me = (scope: Scope): string => {
  if (!scope.actor.userId) throw new AppError('Chats are for signed-in staff.', 403, 'forbidden');
  return scope.actor.userId;
};

const auditActor = (a: Actor) => ({
  userId: a.userId, name: a.name, role: a.role ?? null, kind: a.kind, ip: a.ip ?? null,
});

// ── Shapes ─────────────────────────────────────────────────────────────────

export type ConversationRow = {
  id: string;
  kind: ChatKind;
  name: string | null;
  everyone_can_post: boolean;
  created_at: Date;
  last_message_at: Date | null;
  muted_until: Date | null;
  last_read_at: Date | null;
  unread: number;
  member_count: number;
  last_body: string | null;
  last_kind: string | null;
  last_at: Date | null;
  last_sender_id: string | null;
  last_sender_name: string | null;
  last_attachment_name: string | null;
  photo_key: string | null;
  photo_updated_at: Date | null;
  other_id: string | null;
  other_name: string | null;
  other_email: string | null;
  other_role: string | null;
  other_active: boolean | null;
  other_photo_key: string | null;
  other_photo_at: Date | null;
};

export type Conversation = {
  id: string;
  kind: ChatKind;
  title: string;
  name: string | null;
  everyone_can_post: boolean;
  created_at: string;
  last_message_at: string | null;
  unread: number;
  muted: boolean;
  muted_until: string | null;
  member_count: number;
  can_post: boolean;
  post_refusal: string | null;
  can_leave: boolean;
  can_manage: boolean;
  can_delete: boolean;
  preview: string;
  preview_sender: string | null;
  /**
   * The face on the row: a group's own picture, or the other person's. Null
   * falls back to the coloured initials, which is what everybody starts with.
   */
  photo_url: string | null;
  other: {
    id: string; name: string; email: string; role: string | null; active: boolean;
    photo_url: string | null;
  } | null;
};

const shape = (r: ConversationRow, scope: Scope, basePath = env.BASE_PATH): Conversation => {
  const membership = { is_member: true, is_admin: scope.isAdmin };
  const post = postRefusal(r, membership);
  const other = r.other_id
    ? {
        id: r.other_id, name: r.other_name ?? 'Unknown', email: r.other_email ?? '',
        role: r.other_role, active: r.other_active ?? false,
        photo_url: photoUrl('users', r.other_id, r.other_photo_key, r.other_photo_at, basePath),
      }
    : null;
  return {
    id: r.id,
    kind: r.kind,
    title: titleFor(r, other ? [other] : []),
    name: r.name,
    everyone_can_post: r.everyone_can_post,
    created_at: r.created_at.toISOString(),
    last_message_at: r.last_message_at?.toISOString() ?? null,
    unread: r.unread,
    muted: !!r.muted_until && r.muted_until.getTime() > Date.now(),
    muted_until: r.muted_until?.toISOString() ?? null,
    member_count: r.member_count,
    can_post: post === null,
    post_refusal: post,
    can_leave: leaveRefusal(r, membership) === null,
    can_manage: manageRefusal(r, membership) === null,
    can_delete: deleteRefusal(r, membership) === null,
    preview: r.last_kind === 'system'
      ? (r.last_body ?? '')
      : previewOf(r.last_at ? { body: r.last_body, attachment_name: r.last_attachment_name } : null),
    preview_sender: r.last_kind === 'system' ? null : r.last_sender_name,
    // A direct conversation wears the other person's face; a group wears its
    // own if an admin has given it one.
    photo_url: r.kind === 'direct'
      ? (other?.photo_url ?? null)
      : photoUrl('chats', r.id, r.photo_key, r.photo_updated_at, basePath),
    other,
  };
};

/**
 * One query for the whole list.
 *
 * The unread count is a correlated subquery rather than a stored counter on
 * chat_members: a counter has to be right after every insert, every read mark,
 * every removal and every rollback, and the one that is wrong is the one
 * nobody can explain. Counting is cheap against `chat_messages_unread_idx` at
 * a brokerage's volume, and it cannot drift.
 */
const LIST_SQL = `
  SELECT c.id, c.kind, c.name, c.everyone_can_post, c.created_at, c.last_message_at,
         c.photo_key, c.photo_updated_at,
         mem.muted_until, mem.last_read_at,
         (SELECT COUNT(*) FROM chat_messages m
           WHERE m.conversation_id = c.id
             AND m.kind = 'text'
             AND m.sender_id IS DISTINCT FROM mem.user_id
             AND (mem.last_read_at IS NULL OR m.created_at > mem.last_read_at))::int AS unread,
         (SELECT COUNT(*) FROM chat_members x WHERE x.conversation_id = c.id)::int AS member_count,
         lm.body AS last_body, lm.kind AS last_kind, lm.created_at AS last_at,
         lm.sender_id AS last_sender_id, lu.name AS last_sender_name,
         la.filename AS last_attachment_name,
         o.id AS other_id, o.name AS other_name, o.email AS other_email,
         o.role AS other_role, o.active AS other_active,
         o.photo_key AS other_photo_key, o.photo_updated_at AS other_photo_at
    FROM chat_members mem
    JOIN chat_conversations c ON c.id = mem.conversation_id AND c.archived_at IS NULL
    LEFT JOIN LATERAL (
      SELECT m.id, m.body, m.kind, m.created_at, m.sender_id
        FROM chat_messages m WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1
    ) lm ON true
    LEFT JOIN users lu ON lu.id = lm.sender_id
    LEFT JOIN LATERAL (
      SELECT a.filename FROM chat_attachments a
       WHERE a.message_id = lm.id ORDER BY a.created_at, a.id LIMIT 1
    ) la ON true
    LEFT JOIN LATERAL (
      SELECT u.id, u.name, u.email, u.role, u.active, up.photo_key, up.photo_updated_at
        FROM chat_members om
        JOIN users u ON u.id = om.user_id
        LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE om.conversation_id = c.id AND om.user_id <> mem.user_id
       LIMIT 1
    ) o ON c.kind = 'direct'
   WHERE mem.user_id = $1 AND c.organization_id = $2`;

/**
 * Newest first, and a conversation with nothing in it sorts by when it was
 * made — so a group an admin has just created appears at the top, where they
 * are looking, rather than at the bottom where they are not.
 */
export async function listConversations(scope: Scope, basePath = env.BASE_PATH): Promise<Conversation[]> {
  const { rows } = await query<ConversationRow>(
    `${LIST_SQL} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id`,
    [me(scope), scope.actor.organizationId],
  );
  return rows.map((r) => shape(r, scope, basePath));
}

export async function getConversation(
  scope: Scope, id: string, basePath = env.BASE_PATH,
): Promise<Conversation> {
  const { rows } = await query<ConversationRow>(`${LIST_SQL} AND c.id = $3`, [
    me(scope), scope.actor.organizationId, id,
  ]);
  const row = rows[0];
  if (!row) throw notFound('That conversation');
  return shape(row, scope, basePath);
}

/** The total for the sidebar badge: everything unread that is not muted. */
export async function unreadTotal(scope: Scope): Promise<{ total: number; conversations: number }> {
  const row = await queryOne<{ total: number; conversations: number }>(
    `SELECT COALESCE(SUM(u.n), 0)::int AS total, COUNT(*) FILTER (WHERE u.n > 0)::int AS conversations
       FROM chat_members mem
       JOIN chat_conversations c ON c.id = mem.conversation_id AND c.archived_at IS NULL
       CROSS JOIN LATERAL (
         SELECT COUNT(*)::int AS n FROM chat_messages m
          WHERE m.conversation_id = c.id AND m.kind = 'text'
            AND m.sender_id IS DISTINCT FROM mem.user_id
            AND (mem.last_read_at IS NULL OR m.created_at > mem.last_read_at)
       ) u
      WHERE mem.user_id = $1 AND c.organization_id = $2
        AND (mem.muted_until IS NULL OR mem.muted_until <= now())`,
    [me(scope), scope.actor.organizationId],
  );
  return { total: row?.total ?? 0, conversations: row?.conversations ?? 0 };
}

// ── Membership helpers ─────────────────────────────────────────────────────

type Membership = {
  id: string;
  kind: ChatKind;
  name: string | null;
  everyone_can_post: boolean;
  is_member: boolean;
};

/** The conversation and whether this person is in it — the check every write starts with. */
async function membershipOf(scope: Scope, conversationId: string, client?: Queryable): Promise<Membership> {
  const runner = client ?? pool;
  const { rows } = await runner.query<Membership>(
    `SELECT c.id, c.kind, c.name, c.everyone_can_post,
            (mem.user_id IS NOT NULL) AS is_member
       FROM chat_conversations c
       LEFT JOIN chat_members mem ON mem.conversation_id = c.id AND mem.user_id = $2
      WHERE c.id = $1 AND c.organization_id = $3 AND c.archived_at IS NULL`,
    [conversationId, me(scope), scope.actor.organizationId],
  );
  const row = rows[0];
  // Membership is the whole of the read rule, for an admin as much as anybody.
  // Being a chat admin is the power to run the groups you are in; it is not a
  // key to every conversation in the brokerage.
  //
  // And a conversation somebody is not in is not "forbidden", it is not there:
  // telling a broker that a group exists but is closed to them is telling them
  // something they cannot act on and did not ask.
  if (!row || !row.is_member) throw notFound('That conversation');
  return row;
}

async function memberIds(conversationId: string, client?: Queryable): Promise<string[]> {
  const runner = client ?? pool;
  const { rows } = await runner.query<{ user_id: string }>(
    'SELECT user_id FROM chat_members WHERE conversation_id = $1', [conversationId],
  );
  return rows.map((r) => r.user_id);
}

/** Who is in a group, for the members panel. Ordered so admins read first. */
export async function listMembers(
  scope: Scope, conversationId: string, basePath = env.BASE_PATH,
): Promise<Array<{
  id: string; name: string; email: string; role: string; is_admin: boolean;
  joined_at: string; is_you: boolean; photo_url: string | null;
}>> {
  await membershipOf(scope, conversationId);
  const { rows } = await query<{
    id: string; name: string; email: string; role: string;
    permission_overrides: Record<string, boolean>; joined_at: Date;
    photo_key: string | null; photo_updated_at: Date | null;
  }>(
    `SELECT u.id, u.name, u.email, u.role, u.permission_overrides, mem.joined_at,
            up.photo_key, up.photo_updated_at
       FROM chat_members mem
       JOIN users u ON u.id = mem.user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE mem.conversation_id = $1
      ORDER BY u.name`,
    [conversationId],
  );
  return rows
    .map((r) => ({
      id: r.id, name: r.name, email: r.email, role: r.role,
      is_admin: isChatAdmin(r.role, r.permission_overrides),
      joined_at: r.joined_at.toISOString(),
      is_you: r.id === me(scope),
      photo_url: photoUrl('users', r.id, r.photo_key, r.photo_updated_at, basePath),
    }))
    .sort((a, b) => Number(b.is_admin) - Number(a.is_admin) || a.name.localeCompare(b.name));
}

// ── Messages ───────────────────────────────────────────────────────────────

export type Message = {
  id: string;
  conversation_id: string;
  kind: string;
  body: string | null;
  created_at: string;
  edited: boolean;
  edited_at: string | null;
  deleted: boolean;
  deleted_text: string | null;
  sender: { id: string; name: string; role: string | null; photo_url: string | null } | null;
  mine: boolean;
  /** Still inside the 19 minutes, and yours. */
  can_amend: boolean;
  amend_until: string | null;
  amend_ms_left: number;
  read_state: 'sent' | 'read' | 'partly_read' | null;
  read_label: string | null;
  attachments: Array<{
    id: string; filename: string; mime_type: string; byte_size: number;
    size_label: string; is_image: boolean; url: string;
  }>;
};

const MESSAGE_SQL = `
  SELECT m.id, m.conversation_id, m.kind, m.body, m.created_at, m.sender_id,
         m.edited_at, m.deleted_at,
         u.name AS sender_name, u.role AS sender_role,
         up.photo_key AS sender_photo_key, up.photo_updated_at AS sender_photo_at,
         COALESCE(
           (SELECT json_agg(json_build_object(
                     'id', a.id, 'filename', a.filename, 'mime_type', a.mime_type,
                     'byte_size', a.byte_size) ORDER BY a.created_at, a.id)
              FROM chat_attachments a WHERE a.message_id = m.id),
           '[]'::json) AS attachments
    FROM chat_messages m
    LEFT JOIN users u ON u.id = m.sender_id
    LEFT JOIN user_profiles up ON up.user_id = m.sender_id`;

type MessageRow = {
  id: string; conversation_id: string; kind: string; body: string | null; created_at: Date;
  edited_at: Date | null; deleted_at: Date | null;
  sender_id: string | null; sender_name: string | null; sender_role: string | null;
  sender_photo_key: string | null; sender_photo_at: Date | null;
  attachments: Array<{ id: string; filename: string; mime_type: string; byte_size: string | number }>;
};

/**
 * Where a picture is served from.
 *
 * The version in the query string is what makes a changed photo appear: the
 * URL is otherwise identical, and a browser that has cached the old one has no
 * reason to ask again.
 */
const photoUrl = (
  prefix: string, id: string, key: string | null, at: Date | null, basePath: string,
): string | null => (key ? `${basePath}/api/${prefix}/${id}/photo?v=${at?.getTime() ?? 0}` : null);

/** Every other member's last_read_at — what a tick is computed from. */
type Readers = { list: Array<Date | null>; group: boolean };

async function readersOf(conversationId: string, viewerId: string, group: boolean): Promise<Readers> {
  const { rows } = await query<{ last_read_at: Date | null }>(
    `SELECT mem.last_read_at FROM chat_members mem
       JOIN users u ON u.id = mem.user_id
      WHERE mem.conversation_id = $1 AND mem.user_id <> $2 AND u.active`,
    [conversationId, viewerId],
  );
  return { list: rows.map((r) => r.last_read_at), group };
}

const shapeMessage = (
  r: MessageRow, viewerId: string, basePath: string, readers?: Readers,
): Message => {
  const mine = r.sender_id === viewerId;
  const deleted = !!r.deleted_at;
  const now = new Date();
  // Ticks only on your own messages, as everywhere else: being told that you
  // have read your colleague's message is not news to you.
  const receipt = mine && !deleted && r.kind === 'text' && readers
    ? readState(r, readers.list)
    : null;
  const amendable = !deleted && mine && amendRefusal(r, viewerId, now, 'edit') === null;
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    kind: r.kind,
    body: deleted ? null : r.body,
    created_at: r.created_at.toISOString(),
    edited: !!r.edited_at,
    edited_at: r.edited_at?.toISOString() ?? null,
    deleted,
    deleted_text: deleted ? DELETED_PLACEHOLDER : null,
    sender: r.sender_id
      ? {
          id: r.sender_id, name: r.sender_name ?? 'Unknown', role: r.sender_role,
          photo_url: photoUrl('users', r.sender_id, r.sender_photo_key, r.sender_photo_at, basePath),
        }
      : null,
    mine,
    can_amend: amendable,
    // The client counts down from this rather than from a duration, so a tab
    // left open overnight does not still offer an Edit button.
    amend_until: !deleted && mine && r.kind === 'text' ? editWindowClosesAt(r).toISOString() : null,
    amend_ms_left: !deleted && mine && r.kind === 'text' ? editWindowRemaining(r, now) : 0,
    read_state: receipt?.state ?? null,
    read_label: receipt ? readLabel(receipt, readers?.group ?? false) : null,
    attachments: deleted ? [] : (r.attachments ?? []).map((a) => {
      const bytes = Number(a.byte_size);
      return {
        id: a.id,
        filename: a.filename,
        mime_type: a.mime_type,
        byte_size: bytes,
        size_label: formatBytes(bytes),
        is_image: isImage(a.mime_type),
        // The link is asked for, then used — same two steps as a document, so a
        // URL pasted anywhere is useless to anybody else.
        url: `${basePath}/api/chats/attachments/${a.id}`,
      };
    }),
  };
};

/**
 * A page of a conversation, oldest-last.
 *
 * Paged by the cursor of the oldest message on screen rather than by an
 * offset: an offset shifts under you every time somebody sends something while
 * you are scrolling back, and duplicates or skips a message.
 */
export async function listMessages(
  scope: Scope,
  conversationId: string,
  options: { before?: string | null; around?: string | null; limit?: number } = {},
  basePath = env.BASE_PATH,
): Promise<{ messages: Message[]; has_more: boolean; has_newer: boolean }> {
  const conversation = await membershipOf(scope, conversationId);
  const viewerId = me(scope);
  const limit = Math.min(Math.max(options.limit ?? MESSAGE_PAGE, 1), 100);
  const readers = await readersOf(conversationId, viewerId, conversation.kind !== 'direct');

  // Jumping to a search hit: a window either side of it, so the message lands
  // in the middle of the thread with its context rather than at the top edge.
  if (options.around) {
    const half = Math.max(2, Math.floor(limit / 2));
    const older = await pageOf(conversationId, options.around, 'before', half + 1, true);
    const newer = await pageOf(conversationId, options.around, 'after', half + 1, false);
    const has_more = older.length > half;
    const has_newer = newer.length > half;
    const window = [
      ...(has_more ? older.slice(0, half) : older).reverse(),
      ...(has_newer ? newer.slice(0, half) : newer),
    ];
    return {
      messages: window.map((r) => shapeMessage(r, viewerId, basePath, readers)),
      has_more, has_newer,
    };
  }

  const rows = await pageOf(conversationId, options.before ?? null, 'before', limit + 1, false);
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;
  return {
    messages: page.reverse().map((r) => shapeMessage(r, viewerId, basePath, readers)),
    has_more,
    // `before` pages backwards from the newest, so there is never anything newer.
    has_newer: false,
  };
}

/**
 * One page either side of a cursor.
 *
 * `(created_at, id)` as a row comparison rather than `created_at` alone: two
 * messages can share a millisecond, and a cursor that cannot tell them apart
 * either repeats one or loses one.
 */
async function pageOf(
  conversationId: string,
  cursorId: string | null,
  direction: 'before' | 'after',
  limit: number,
  inclusive: boolean,
): Promise<MessageRow[]> {
  const params: unknown[] = [conversationId];
  let where = '';
  if (cursorId) {
    params.push(cursorId);
    const operator = direction === 'before' ? (inclusive ? '<=' : '<') : (inclusive ? '>=' : '>');
    where = `AND (m.created_at, m.id) ${operator} (
               SELECT created_at, id FROM chat_messages WHERE id = $${params.length})`;
  }
  params.push(limit);
  const { rows } = await query<MessageRow>(
    `${MESSAGE_SQL} WHERE m.conversation_id = $1 ${where}
      ORDER BY m.created_at ${direction === 'before' ? 'DESC' : 'ASC'},
               m.id ${direction === 'before' ? 'DESC' : 'ASC'}
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

async function loadMessageRow(id: string, client?: Queryable): Promise<MessageRow> {
  const runner = client ?? pool;
  const { rows } = await runner.query<MessageRow>(`${MESSAGE_SQL} WHERE m.id = $1`, [id]);
  return rows[0]!;
}

/**
 * Send a message event to each person as THEIR copy of it.
 *
 * `mine`, the ticks and the edit window all depend on who is looking, so one
 * shared payload cannot be right for everybody: broadcasting the sender's copy
 * made a message arrive on the recipient's screen as their own — right-aligned,
 * offering an Edit they could not use — and, because it looked like theirs,
 * the thread never marked it read and the sender's tick never turned over.
 */
async function publishMessage(
  type: 'chat.message' | 'chat.message.updated' | 'chat.message.deleted',
  conversationId: string,
  row: MessageRow,
  recipients: string[],
): Promise<void> {
  for (const userId of recipients) {
    publish([userId], {
      type,
      conversation_id: conversationId,
      // No readers: a recipient sees no ticks on somebody else's message, and
      // the sender's own tabs refresh theirs when `chat.read` arrives.
      message: shapeMessage(row, userId, env.BASE_PATH),
    });
  }
}

export const SendInput = z.object({
  body: z.string().max(MAX_BODY_LENGTH + 1).default(''),
});

export type IncomingFile = { originalname: string; mimetype: string; size: number; buffer: Buffer };

/**
 * Send into a conversation.
 *
 * The attachments are stored before the transaction opens, because streaming
 * twenty megabytes to disk inside a transaction holds a database connection
 * for the length of an upload. If the insert then fails, the object is
 * orphaned in storage — which costs disk, where the other order costs the
 * brokerage a connection under load.
 */
export async function sendMessage(
  scope: Scope,
  conversationId: string,
  raw: unknown,
  files: IncomingFile[] = [],
  basePath = env.BASE_PATH,
): Promise<Message> {
  const input = SendInput.parse(raw ?? {});
  const userId = me(scope);
  const conversation = await membershipOf(scope, conversationId);

  const refusal = postRefusal(conversation, { is_member: conversation.is_member, is_admin: scope.isAdmin });
  if (refusal) throw new AppError(refusal, 403, 'cannot_post');

  const bad = messageRefusal(input.body, files.length);
  if (bad) throw new AppError(bad, 422, 'validation_failed');

  for (const file of files) {
    const check = checkAttachment(file.originalname, file.mimetype, file.size);
    if (!check.ok) throw new AppError(check.reason, 422, 'rejected_upload');
  }

  const stored = await Promise.all(files.map(async (file) => ({
    file,
    object: await putObject(Readable.from(file.buffer), {
      filename: file.originalname, mimeType: file.mimetype,
    }),
  })));

  const messageId = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO chat_messages (conversation_id, organization_id, sender_id, kind, body)
       VALUES ($1,$2,$3,'text',$4) RETURNING id`,
      [conversationId, scope.actor.organizationId, userId, input.body.trim() || null],
    );
    const id = rows[0]!.id;
    for (const { file, object } of stored) {
      await client.query(
        `INSERT INTO chat_attachments
           (message_id, filename, mime_type, byte_size, sha256, storage_driver, storage_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, file.originalname, file.mimetype, object.bytes, object.sha256, object.driver, object.key],
      );
    }
    // Sorting the list is this column's only job, and it is written by the
    // same statement that wrote the message so the two cannot disagree.
    await client.query('UPDATE chat_conversations SET last_message_at = now() WHERE id = $1', [conversationId]);
    // The sender has read what the sender just wrote.
    await client.query(
      'UPDATE chat_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId],
    );
    return id;
  });

  // The sender gets their own ticks straight away — "Sent", turning over as
  // people read it — rather than only after the next reload.
  const readers = await readersOf(conversationId, userId, conversation.kind !== 'direct');
  const row = await loadMessageRow(messageId);
  const message = shapeMessage(row, userId, basePath, readers);
  await fanOut(scope, conversationId, conversation, message, row);
  return message;
}

/**
 * Tell everybody else.
 *
 * Someone with a tab open is told over the event stream and that is enough —
 * they can see it. Someone who is not gets one bell notification per
 * conversation, keyed so a hundred messages update one row instead of
 * producing a hundred. A muted conversation raises nothing either way, which
 * is what muting means.
 */
async function fanOut(
  scope: Scope,
  conversationId: string,
  conversation: { kind: ChatKind; name: string | null },
  message: Message,
  row: MessageRow,
): Promise<void> {
  const senderId = me(scope);
  const { rows } = await query<{ user_id: string; muted: boolean; name: string }>(
    `SELECT mem.user_id, (mem.muted_until IS NOT NULL AND mem.muted_until > now()) AS muted, u.name
       FROM chat_members mem JOIN users u ON u.id = mem.user_id
      WHERE mem.conversation_id = $1 AND u.active`,
    [conversationId],
  );

  // Every member's tab is told, including the sender's other tabs, so the list
  // reorders and the thread appends everywhere at once — each as their own
  // copy. The unread count is theirs to recompute; sending it per person would
  // mean a query each for a number the client refreshes on the next list.
  await publishMessage('chat.message', conversationId, row, rows.map((r) => r.user_id));

  const title = conversation.kind === 'direct'
    ? scope.actor.name
    : `${conversation.name ?? 'Group'} · ${scope.actor.name}`;
  const preview = previewOf({
    body: message.body,
    attachment_name: message.attachments[0]?.filename ?? null,
  });

  for (const member of rows) {
    if (member.user_id === senderId || member.muted || isConnected(member.user_id)) continue;
    try {
      await query(
        `INSERT INTO notifications (organization_id, user_id, kind, title, body, link,
                                    entity_type, entity_id, dedupe_key, at, read_at)
         VALUES ($1,$2,'chat',$3,$4,$5,'chat_conversation',$6,$7, now(), NULL)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
         DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, at = now(), read_at = NULL`,
        [scope.actor.organizationId, member.user_id, title, preview, '/chats',
         conversationId, `chat:${conversationId}`],
      );
    } catch (err) {
      // A bell that cannot be rung must not lose the message that rang it.
      log.warn('could not raise a chat notification', { userId: member.user_id, error: err });
    }
  }
}

// ── Changing your mind ─────────────────────────────────────────────────────

export const EditInput = z.object({ body: z.string().max(MAX_BODY_LENGTH + 1) });

/** The message, and the conversation it is in, with membership already proved. */
async function ownMessage(scope: Scope, messageId: string): Promise<{
  row: { id: string; conversation_id: string; sender_id: string | null; created_at: Date;
         deleted_at: Date | null; kind: string; body: string | null };
  conversation: Membership;
}> {
  const row = await queryOne<{
    id: string; conversation_id: string; sender_id: string | null; created_at: Date;
    deleted_at: Date | null; kind: string; body: string | null;
  }>(
    `SELECT m.id, m.conversation_id, m.sender_id, m.created_at, m.deleted_at, m.kind, m.body
       FROM chat_messages m
       JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND c.organization_id = $2`,
    [messageId, scope.actor.organizationId],
  );
  if (!row) throw notFound('That message');
  const conversation = await membershipOf(scope, row.conversation_id);
  return { row, conversation };
}

/**
 * Edit a message, within nineteen minutes of sending it.
 *
 * The edit is not versioned. It is a typo window, not an audit surface — and a
 * chat that quietly kept every draft of what somebody nearly said would be a
 * worse thing to hand a brokerage than one that does not.
 */
export async function editMessage(
  scope: Scope, messageId: string, raw: unknown, basePath = env.BASE_PATH,
): Promise<Message> {
  const input = EditInput.parse(raw ?? {});
  const viewerId = me(scope);
  const { row, conversation } = await ownMessage(scope, messageId);

  const refusal = amendRefusal(row, viewerId, new Date(), 'edit');
  if (refusal) throw new AppError(refusal, 403, 'amend_window');

  const attachments = await queryOne<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM chat_attachments WHERE message_id = $1', [messageId]);
  const bad = messageRefusal(input.body, attachments?.n ?? 0);
  if (bad) throw new AppError(bad, 422, 'validation_failed');

  await query(
    'UPDATE chat_messages SET body = $2, edited_at = now() WHERE id = $1',
    [messageId, input.body.trim() || null],
  );

  const readers = await readersOf(row.conversation_id, viewerId, conversation.kind !== 'direct');
  const fresh = await loadMessageRow(messageId);
  await publishMessage('chat.message.updated', row.conversation_id, fresh,
    await memberIds(row.conversation_id));
  return shapeMessage(fresh, viewerId, basePath, readers);
}

/**
 * Take a message back, within the same nineteen minutes.
 *
 * The row stays and says so. Removing it outright would reshape the
 * conversation around a hole — a reply to nothing, and two people reading a
 * different thread from each other.
 *
 * Attachments go properly: the rows and the stored objects both. A file that
 * somebody has "deleted" and that is still on disk behind a URL is worse than
 * one they never sent.
 */
export async function deleteMessage(
  scope: Scope, messageId: string, basePath = env.BASE_PATH,
): Promise<Message> {
  const viewerId = me(scope);
  const { row, conversation } = await ownMessage(scope, messageId);

  const refusal = amendRefusal(row, viewerId, new Date(), 'delete');
  if (refusal) throw new AppError(refusal, 403, 'amend_window');

  const { rows: files } = await query<{ storage_key: string }>(
    'SELECT storage_key FROM chat_attachments WHERE message_id = $1', [messageId]);

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE chat_messages SET body = NULL, deleted_at = now(), deleted_by = $2 WHERE id = $1`,
      [messageId, viewerId],
    );
    await client.query('DELETE FROM chat_attachments WHERE message_id = $1', [messageId]);
  });

  for (const file of files) {
    // After the transaction: a storage failure must not undo the delete the
    // person asked for, and an orphaned object costs disk where the other way
    // round costs them their retraction.
    await deleteObject(file.storage_key).catch((err) =>
      log.warn('could not remove a deleted chat attachment', { key: file.storage_key, error: err }));
  }

  const readers = await readersOf(row.conversation_id, viewerId, conversation.kind !== 'direct');
  const fresh = await loadMessageRow(messageId);
  await publishMessage('chat.message.deleted', row.conversation_id, fresh,
    await memberIds(row.conversation_id));
  return shapeMessage(fresh, viewerId, basePath, readers);
}

// ── Searching inside a conversation ────────────────────────────────────────

export const SearchInput = z.object({
  q: z.string(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/**
 * Find a message in this conversation.
 *
 * ILIKE rather than full text: the corpus is one conversation, the thread
 * index already narrows it, and somebody searching "scarlett" expects to find
 * it inside "scarlettdeal" — which a stemmed index would not give them.
 */
export async function searchMessages(
  scope: Scope, conversationId: string, raw: unknown,
): Promise<{ results: Array<{
  id: string; created_at: string; snippet: string; sender_name: string | null; mine: boolean;
}>; total: number }> {
  const input = SearchInput.parse(raw ?? {});
  await membershipOf(scope, conversationId);
  const bad = searchRefusal(input.q);
  if (bad) throw new AppError(bad, 422, 'validation_failed');

  const viewerId = me(scope);
  const term = input.q.trim();
  // The escape makes a literal % or _ mean itself. Somebody searching for
  // "100%" should not match every message in the conversation.
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const { rows } = await query<{
    id: string; created_at: Date; body: string; sender_id: string | null; sender_name: string | null;
  }>(
    `SELECT m.id, m.created_at, m.body, m.sender_id, u.name AS sender_name
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
        AND m.body ILIKE $2 ESCAPE '\\'
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $3`,
    [conversationId, pattern, input.limit],
  );

  return {
    results: rows.map((r) => ({
      id: r.id,
      created_at: r.created_at.toISOString(),
      snippet: snippetAround(r.body, term),
      sender_name: r.sender_name,
      mine: r.sender_id === viewerId,
    })),
    total: rows.length,
  };
}

// ── Typing ─────────────────────────────────────────────────────────────────

/**
 * Who is typing, in memory and nowhere else.
 *
 * A typing indicator is true for about four seconds and worthless afterwards,
 * so writing it to Postgres would be paying a durable-storage price for
 * something that must not outlive the tab. It expires on its own, and a
 * process restart simply forgets — which is the correct amount of history for
 * "Dana is typing".
 */
const typingUntil = new Map<string, Map<string, number>>();

export async function setTyping(scope: Scope, conversationId: string): Promise<void> {
  const viewerId = me(scope);
  const conversation = await membershipOf(scope, conversationId);
  // Somebody who cannot post cannot be typing, and broadcasting that they are
  // would be a promise of a message that can never arrive.
  if (postRefusal(conversation, { is_member: true, is_admin: scope.isAdmin })) return;

  let byUser = typingUntil.get(conversationId);
  if (!byUser) typingUntil.set(conversationId, (byUser = new Map()));
  byUser.set(viewerId, Date.now() + TYPING_EXPIRY_MS);

  const others = (await memberIds(conversationId)).filter((id) => id !== viewerId);
  publish(others, {
    type: 'chat.typing',
    conversation_id: conversationId,
    user_id: viewerId,
    name: scope.actor.name,
    until: Date.now() + TYPING_EXPIRY_MS,
  });
}

/** Everything up to now has been seen. Idempotent, and cheap enough to call on focus. */
export async function markRead(scope: Scope, conversationId: string): Promise<{ unread: number }> {
  const userId = me(scope);
  await membershipOf(scope, conversationId);
  await query(
    'UPDATE chat_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId],
  );
  await query(
    `UPDATE notifications SET read_at = now()
      WHERE user_id = $1 AND dedupe_key = $2 AND read_at IS NULL`,
    [userId, `chat:${conversationId}`],
  );
  // Everybody in the conversation, not just this person's other tabs: their
  // badge clears, and the ticks on everybody else's messages turn over. Both
  // come from the same `last_read_at` that has just moved.
  publish(await memberIds(conversationId), {
    type: 'chat.read', conversation_id: conversationId, reader_id: userId,
  });
  return { unread: 0 };
}

// ── Muting ─────────────────────────────────────────────────────────────────

export const MuteInput = z.object({
  mute: z.enum(MUTE_KEYS).nullable().default(null),
});

/** Anybody may mute anything they are in, including the Community group. */
export async function setMute(scope: Scope, conversationId: string, raw: unknown): Promise<Conversation> {
  const input = MuteInput.parse(raw ?? {});
  const userId = me(scope);
  await membershipOf(scope, conversationId);
  const until = input.mute ? muteUntil(input.mute as MuteOption, new Date()) : null;
  await query(
    'UPDATE chat_members SET muted_until = $3 WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId, until],
  );
  publish([userId], { type: 'chat.conversation', conversation_id: conversationId });
  return getConversation(scope, conversationId);
}

// ── Starting a conversation ────────────────────────────────────────────────

/**
 * Who this person may start a chat with.
 *
 * For a staff member that is the admins, and nobody else — which is the rule
 * made visible rather than a refusal after the fact. For an admin it is
 * everybody.
 */
export async function contacts(scope: Scope, basePath = env.BASE_PATH): Promise<Array<{
  id: string; name: string; email: string; role: string; is_admin: boolean;
  conversation_id: string | null; unread: number; photo_url: string | null;
}>> {
  const userId = me(scope);
  const { rows } = await query<{
    id: string; name: string; email: string; role: string; permission_overrides: Record<string, boolean>;
    conversation_id: string | null; unread: number;
    photo_key: string | null; photo_updated_at: Date | null;
  }>(
    // $1 is the viewer as a uuid and $2 the same id as text. One parameter
    // used both ways resolves to a single type across the whole statement, and
    // the halves that wanted the other one fail with "uuid = text".
    `SELECT u.id, u.name, u.email, u.role, u.permission_overrides,
            up.photo_key, up.photo_updated_at,
            c.id AS conversation_id,
            COALESCE((SELECT COUNT(*) FROM chat_messages m
                       WHERE m.conversation_id = c.id AND m.kind = 'text'
                         AND m.sender_id IS DISTINCT FROM $1
                         AND (mem.last_read_at IS NULL OR m.created_at > mem.last_read_at)), 0)::int AS unread
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.id
       LEFT JOIN chat_conversations c
              ON c.organization_id = u.organization_id AND c.kind = 'direct'
             AND c.direct_key = CASE
                   WHEN $2 COLLATE "C" < u.id::text COLLATE "C"
                   THEN $2 || ':' || u.id::text
                   ELSE u.id::text || ':' || $2 END
       LEFT JOIN chat_members mem ON mem.conversation_id = c.id AND mem.user_id = $1
      WHERE u.organization_id = $3 AND u.active AND u.id <> $1
      ORDER BY u.name`,
    [userId, userId, scope.actor.organizationId],
  );

  const mine = { id: userId, isAdmin: scope.isAdmin };
  return rows
    .map((r) => ({
      ...r,
      is_admin: isChatAdmin(r.role, r.permission_overrides),
      photo_url: photoUrl('users', r.id, r.photo_key, r.photo_updated_at, basePath),
    }))
    .filter((r) => canOpenDirect(mine, { id: r.id, isAdmin: r.is_admin }) === true)
    .map(({ permission_overrides: _o, photo_key: _k, photo_updated_at: _a, ...r }) => r);
}

/**
 * Whether a user row is a chat admin, without loading their whole session.
 *
 * `domain/permissions.ts` is the authority on what a role grants and how an
 * override changes it; this asks it the one question this module needs.
 */
export function isChatAdmin(role: string, overrides: Record<string, boolean> | null): boolean {
  const override = overrides?.['chat.admin'];
  if (typeof override === 'boolean') return override;
  return ROLE_HAS_CHAT_ADMIN.has(role);
}

// Resolved once, from the role table itself, so granting `chat.admin` to a
// role in domain/permissions.ts is the whole change.
const ROLE_HAS_CHAT_ADMIN: Set<string> = new Set(
  Object.entries(ROLES)
    .filter(([, role]) => role.permissions.includes('chat.admin'))
    .map(([key]) => key),
);

/** Open — or reopen — the one-to-one conversation between this person and another. */
export async function openDirect(scope: Scope, otherUserId: string): Promise<Conversation> {
  const userId = me(scope);
  const other = await queryOne<{ id: string; name: string; role: string; permission_overrides: Record<string, boolean>; active: boolean }>(
    `SELECT id, name, role, permission_overrides, active FROM users
      WHERE id = $1 AND organization_id = $2`,
    [otherUserId, scope.actor.organizationId],
  );
  if (!other) throw notFound('That staff member');
  if (!other.active) throw new AppError(`${other.name}'s account is inactive.`, 409, 'inactive_user');

  const allowed = canOpenDirect(
    { id: userId, isAdmin: scope.isAdmin },
    { id: other.id, isAdmin: isChatAdmin(other.role, other.permission_overrides) },
  );
  if (allowed !== true) throw new AppError(allowed, 403, 'staff_to_staff');

  const key = directKey(userId, other.id);
  const id = await withTransaction(async (client) => {
    // ON CONFLICT against `chat_direct_key` rather than a select-then-insert:
    // two tabs opening the same chat at the same moment is an ordinary thing
    // to do and must not produce two threads.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO chat_conversations (organization_id, kind, direct_key, created_by)
       VALUES ($1,'direct',$2,$3)
       ON CONFLICT (organization_id, direct_key) WHERE direct_key IS NOT NULL
       DO UPDATE SET archived_at = NULL
       RETURNING id`,
      [scope.actor.organizationId, key, userId],
    );
    const conversationId = rows[0]!.id;
    await client.query(
      `INSERT INTO chat_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)
       ON CONFLICT DO NOTHING`,
      [conversationId, userId, other.id],
    );
    return conversationId;
  });

  publish([userId, other.id], { type: 'chat.conversation', conversation_id: id });
  return getConversation(scope, id);
}

// ── Groups ─────────────────────────────────────────────────────────────────

export const GroupInput = z.object({
  name: z.string().min(1),
  member_ids: z.array(z.string().uuid()).default([]),
  everyone_can_post: z.boolean().default(true),
});

function assertAdmin(scope: Scope): void {
  if (!scope.isAdmin) throw new AppError('Only an admin manages groups.', 403, 'forbidden');
}

export async function createGroup(scope: Scope, raw: unknown): Promise<Conversation> {
  assertAdmin(scope);
  const input = GroupInput.parse(raw ?? {});
  const userId = me(scope);
  const bad = groupNameRefusal(input.name);
  if (bad) throw new AppError(bad, 422, 'validation_failed');

  const members = await activeMembers(scope.actor.organizationId, input.member_ids);
  // The admin who made it is in it. A group its creator cannot see is a group
  // nobody administers.
  const ids = [...new Set([userId, ...members.map((m) => m.id)])];

  const id = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO chat_conversations (organization_id, kind, name, everyone_can_post, created_by)
       VALUES ($1,'group',$2,$3,$4) RETURNING id`,
      [scope.actor.organizationId, input.name.trim(), input.everyone_can_post, userId],
    );
    const conversationId = rows[0]!.id;
    for (const memberId of ids) {
      await client.query(
        'INSERT INTO chat_members (conversation_id, user_id, added_by) VALUES ($1,$2,$3)',
        [conversationId, memberId, userId],
      );
    }
    await system(client, conversationId, scope, `${scope.actor.name} created this group`);
    await recordAudit({
      organizationId: scope.actor.organizationId,
      actor: auditActor(scope.actor),
      action: 'chat.group_create',
      entityType: 'chat_conversation',
      entityId: conversationId,
      summary: `Created the chat group “${input.name.trim()}” with ${ids.length} member${ids.length === 1 ? '' : 's'}`,
    }, client);
    return conversationId;
  });

  publish(ids, { type: 'chat.conversation', conversation_id: id });
  return getConversation(scope, id);
}

async function activeMembers(organizationId: string, ids: string[]): Promise<Array<{ id: string; name: string }>> {
  if (!ids.length) return [];
  const { rows } = await query<{ id: string; name: string }>(
    'SELECT id, name FROM users WHERE organization_id = $1 AND active AND id = ANY($2::uuid[])',
    [organizationId, ids],
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new AppError(
      missing.length === 1
        ? 'One of those people is not active staff here.'
        : `${missing.length} of those people are not active staff here.`,
      422, 'validation_failed',
    );
  }
  return rows;
}

/** A line in the thread that nobody wrote: "Alex added Dana". */
async function system(client: Queryable, conversationId: string, scope: Scope, text: string): Promise<void> {
  await client.query(
    `INSERT INTO chat_messages (conversation_id, organization_id, sender_id, kind, body)
     VALUES ($1,$2,NULL,'system',$3)`,
    [conversationId, scope.actor.organizationId, text],
  );
  await client.query('UPDATE chat_conversations SET last_message_at = now() WHERE id = $1', [conversationId]);
}

export const RenameInput = z.object({ name: z.string().min(1) });

/** The Community group can be renamed — that is the one thing about it that is not fixed. */
export async function renameGroup(scope: Scope, conversationId: string, raw: unknown): Promise<Conversation> {
  const input = RenameInput.parse(raw ?? {});
  const conversation = await membershipOf(scope, conversationId);
  const refusal = manageRefusal(conversation, { is_member: conversation.is_member, is_admin: scope.isAdmin });
  if (refusal) throw new AppError(refusal, 403, 'forbidden');
  const bad = groupNameRefusal(input.name);
  if (bad) throw new AppError(bad, 422, 'validation_failed');

  const was = conversation.name;
  const name = input.name.trim();
  await withTransaction(async (client) => {
    await client.query('UPDATE chat_conversations SET name = $2 WHERE id = $1', [conversationId, name]);
    await system(client, conversationId, scope, `${scope.actor.name} renamed this group to “${name}”`);
    await recordAudit({
      organizationId: scope.actor.organizationId,
      actor: auditActor(scope.actor),
      action: 'chat.group_rename',
      entityType: 'chat_conversation',
      entityId: conversationId,
      summary: `Renamed the chat group “${was ?? 'Group'}” to “${name}”`,
    }, client);
  });

  publish(await memberIds(conversationId), { type: 'chat.conversation', conversation_id: conversationId });
  return getConversation(scope, conversationId);
}

export const PostingInput = z.object({ everyone_can_post: z.boolean() });

/** Open a group to everyone, or close it back to admins. */
export async function setPosting(scope: Scope, conversationId: string, raw: unknown): Promise<Conversation> {
  const input = PostingInput.parse(raw ?? {});
  const conversation = await membershipOf(scope, conversationId);
  const refusal = manageRefusal(conversation, { is_member: conversation.is_member, is_admin: scope.isAdmin });
  if (refusal) throw new AppError(refusal, 403, 'forbidden');

  const label = conversation.name ?? 'Group';
  await withTransaction(async (client) => {
    await client.query(
      'UPDATE chat_conversations SET everyone_can_post = $2 WHERE id = $1',
      [conversationId, input.everyone_can_post],
    );
    await system(client, conversationId, scope, input.everyone_can_post
      ? `${scope.actor.name} opened this group — everyone can post`
      : `${scope.actor.name} closed this group — only admins can post`);
    await recordAudit({
      organizationId: scope.actor.organizationId,
      actor: auditActor(scope.actor),
      action: 'chat.posting_changed',
      entityType: 'chat_conversation',
      entityId: conversationId,
      summary: input.everyone_can_post
        ? `Opened “${label}” to everyone`
        : `Closed “${label}” to admins only`,
    }, client);
  });

  publish(await memberIds(conversationId), { type: 'chat.conversation', conversation_id: conversationId });
  return getConversation(scope, conversationId);
}

export const MembersInput = z.object({ user_ids: z.array(z.string().uuid()).min(1) });

export async function addMembers(scope: Scope, conversationId: string, raw: unknown): Promise<Conversation> {
  const input = MembersInput.parse(raw ?? {});
  const conversation = await membershipOf(scope, conversationId);
  const refusal = manageRefusal(conversation, { is_member: conversation.is_member, is_admin: scope.isAdmin });
  if (refusal) throw new AppError(refusal, 403, 'forbidden');

  const people = await activeMembers(scope.actor.organizationId, input.user_ids);
  const added: string[] = [];
  await withTransaction(async (client) => {
    for (const person of people) {
      const { rowCount } = await client.query(
        `INSERT INTO chat_members (conversation_id, user_id, added_by) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [conversationId, person.id, me(scope)],
      );
      if (rowCount) added.push(person.name);
    }
    if (added.length) {
      await system(client, conversationId, scope,
        `${scope.actor.name} added ${added.join(', ')}`);
      await recordAudit({
        organizationId: scope.actor.organizationId,
        actor: auditActor(scope.actor),
        action: 'chat.member_add',
        entityType: 'chat_conversation',
        entityId: conversationId,
        summary: `Added ${added.join(', ')} to “${conversation.name ?? 'a chat group'}”`,
      }, client);
    }
  });

  publish(await memberIds(conversationId), { type: 'chat.conversation', conversation_id: conversationId });
  return getConversation(scope, conversationId);
}

/** Only an admin takes somebody out — of any group, the Community one included. */
export async function removeMember(scope: Scope, conversationId: string, userId: string): Promise<Conversation> {
  const conversation = await membershipOf(scope, conversationId);
  const refusal = manageRefusal(conversation, { is_member: conversation.is_member, is_admin: scope.isAdmin });
  if (refusal) throw new AppError(refusal, 403, 'forbidden');

  const person = await queryOne<{ name: string }>(
    'SELECT name FROM users WHERE id = $1 AND organization_id = $2',
    [userId, scope.actor.organizationId],
  );
  if (!person) throw notFound('That staff member');

  const before = await memberIds(conversationId);
  const removed = await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      'DELETE FROM chat_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId],
    );
    if (!rowCount) return false;
    await system(client, conversationId, scope, `${scope.actor.name} removed ${person.name}`);
    await recordAudit({
      organizationId: scope.actor.organizationId,
      actor: auditActor(scope.actor),
      action: 'chat.member_remove',
      entityType: 'chat_conversation',
      entityId: conversationId,
      summary: `Removed ${person.name} from “${conversation.name ?? 'a chat group'}”`,
    }, client);
    return true;
  });
  if (!removed) throw new AppError(`${person.name} is not in this group.`, 409, 'not_a_member');

  publish(before, { type: 'chat.conversation', conversation_id: conversationId });
  publish([userId], { type: 'chat.removed', conversation_id: conversationId });
  return getConversation(scope, conversationId);
}

/** Walking out of a group. Refused for the Community group, and for a direct chat. */
export async function leaveConversation(scope: Scope, conversationId: string): Promise<{ left: true }> {
  const userId = me(scope);
  const conversation = await membershipOf(scope, conversationId);
  const refusal = leaveRefusal(conversation, { is_member: conversation.is_member, is_admin: scope.isAdmin });
  if (refusal) throw new AppError(refusal, 403, 'cannot_leave');

  // A group nobody can administer is a group that can never be renamed, added
  // to, or removed. The last admin is asked to hand it over or remove it
  // rather than being allowed to strand it.
  if (scope.isAdmin && await isLastAdmin(conversationId, userId)) {
    throw new AppError(
      'You are the only admin in this group. Add another admin, or remove the group.',
      409, 'last_admin',
    );
  }

  const before = await memberIds(conversationId);
  await withTransaction(async (client) => {
    await client.query('DELETE FROM chat_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]);
    await system(client, conversationId, scope, `${scope.actor.name} left`);
    await recordAudit({
      organizationId: scope.actor.organizationId,
      actor: auditActor(scope.actor),
      action: 'chat.member_leave',
      entityType: 'chat_conversation',
      entityId: conversationId,
      summary: `Left the chat group “${conversation.name ?? 'a chat group'}”`,
    }, client);
  });

  publish(before, { type: 'chat.conversation', conversation_id: conversationId });
  publish([userId], { type: 'chat.removed', conversation_id: conversationId });
  return { left: true };
}

/** Whether this person is the only chat admin left in a group. */
async function isLastAdmin(conversationId: string, userId: string): Promise<boolean> {
  const { rows } = await query<{ role: string; permission_overrides: Record<string, boolean> }>(
    `SELECT u.role, u.permission_overrides FROM chat_members mem
       JOIN users u ON u.id = mem.user_id
      WHERE mem.conversation_id = $1 AND mem.user_id <> $2 AND u.active`,
    [conversationId, userId],
  );
  return !rows.some((r) => isChatAdmin(r.role, r.permission_overrides));
}

/**
 * Remove a group.
 *
 * Archived, not deleted: the messages stay for as long as the brokerage keeps
 * anything else, and the group stops appearing for everybody. Nothing in this
 * CRM removes a record because somebody is finished with it.
 */
export async function deleteGroup(scope: Scope, conversationId: string): Promise<{ removed: true }> {
  const conversation = await membershipOf(scope, conversationId);
  const refusal = deleteRefusal(conversation, { is_member: conversation.is_member, is_admin: scope.isAdmin });
  if (refusal) throw new AppError(refusal, 403, 'forbidden');

  const before = await memberIds(conversationId);
  await withTransaction(async (client) => {
    await client.query('UPDATE chat_conversations SET archived_at = now() WHERE id = $1', [conversationId]);
    await recordAudit({
      organizationId: scope.actor.organizationId,
      actor: auditActor(scope.actor),
      action: 'chat.group_delete',
      entityType: 'chat_conversation',
      entityId: conversationId,
      summary: `Removed the chat group “${conversation.name ?? 'a chat group'}”`,
    }, client);
  });

  publish(before, { type: 'chat.removed', conversation_id: conversationId });
  return { removed: true };
}

// ── Attachments ────────────────────────────────────────────────────────────

/** The stored object behind an attachment, once membership has been proved. */
export async function attachmentFor(scope: Scope, attachmentId: string): Promise<{
  filename: string; mime_type: string; byte_size: number; storage_key: string; storage_driver: string;
}> {
  const row = await queryOne<{
    filename: string; mime_type: string; byte_size: string; storage_key: string; storage_driver: string;
    conversation_id: string;
  }>(
    `SELECT a.filename, a.mime_type, a.byte_size, a.storage_key, a.storage_driver, m.conversation_id
       FROM chat_attachments a
       JOIN chat_messages m ON m.id = a.message_id
       JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE a.id = $1 AND c.organization_id = $2`,
    [attachmentId, scope.actor.organizationId],
  );
  if (!row) throw notFound('That attachment');
  // Being in the conversation is the whole of the access rule. An admin who is
  // not in a group does not get its files by being an admin.
  const member = await queryOne<{ one: number }>(
    'SELECT 1 AS one FROM chat_members WHERE conversation_id = $1 AND user_id = $2',
    [row.conversation_id, me(scope)],
  );
  if (!member) throw notFound('That attachment');
  return { ...row, byte_size: Number(row.byte_size) };
}

// ── Photos ─────────────────────────────────────────────────────────────────

export type StoredPhoto = {
  photo_key: string; photo_mime: string; photo_updated_at: Date;
};

/** Put a picture in storage after checking it, and hand back the old key to clean up. */
async function replacePhoto(
  file: IncomingFile,
  previousKey: string | null,
): Promise<{ key: string; mime: string; previousKey: string | null }> {
  const check = checkPhoto(file.originalname, file.mimetype, file.size);
  if (!check.ok) throw new AppError(check.reason, 422, 'rejected_upload');
  const object = await putObject(Readable.from(file.buffer), {
    filename: file.originalname, mimeType: file.mimetype,
  });
  return { key: object.key, mime: file.mimetype, previousKey };
}

const forget = (key: string | null) => {
  if (!key) return;
  void deleteObject(key).catch((err) => log.warn('could not remove an old photo', { key, error: err }));
};

/** A group's picture. Admin only, like everything else about a group. */
export async function setGroupPhoto(
  scope: Scope, conversationId: string, file: IncomingFile,
): Promise<Conversation> {
  const conversation = await membershipOf(scope, conversationId);
  const refusal = manageRefusal(conversation, { is_member: true, is_admin: scope.isAdmin });
  if (refusal) throw new AppError(refusal, 403, 'forbidden');

  const current = await queryOne<{ photo_key: string | null }>(
    'SELECT photo_key FROM chat_conversations WHERE id = $1', [conversationId]);
  const stored = await replacePhoto(file, current?.photo_key ?? null);

  await query(
    `UPDATE chat_conversations
        SET photo_key = $2, photo_mime = $3, photo_updated_at = now() WHERE id = $1`,
    [conversationId, stored.key, stored.mime],
  );
  forget(stored.previousKey);
  publish(await memberIds(conversationId), { type: 'chat.conversation', conversation_id: conversationId });
  return getConversation(scope, conversationId);
}

/** Back to the group's initial, which is what it had before anybody chose a picture. */
export async function removeGroupPhoto(scope: Scope, conversationId: string): Promise<Conversation> {
  const conversation = await membershipOf(scope, conversationId);
  const refusal = manageRefusal(conversation, { is_member: true, is_admin: scope.isAdmin });
  if (refusal) throw new AppError(refusal, 403, 'forbidden');

  const current = await queryOne<{ photo_key: string | null }>(
    'SELECT photo_key FROM chat_conversations WHERE id = $1', [conversationId]);
  await query(
    `UPDATE chat_conversations
        SET photo_key = NULL, photo_mime = NULL, photo_updated_at = now() WHERE id = $1`,
    [conversationId],
  );
  forget(current?.photo_key ?? null);
  publish(await memberIds(conversationId), { type: 'chat.conversation', conversation_id: conversationId });
  return getConversation(scope, conversationId);
}

/** Your own picture. Nobody sets anybody else's. */
export async function setOwnPhoto(actor: Actor, file: IncomingFile): Promise<{ photo_url: string | null }> {
  if (!actor.userId) throw new AppError('Sign in to change your picture.', 403, 'forbidden');
  const current = await queryOne<{ photo_key: string | null }>(
    'SELECT photo_key FROM user_profiles WHERE user_id = $1', [actor.userId]);
  const stored = await replacePhoto(file, current?.photo_key ?? null);

  await query(
    `INSERT INTO user_profiles (user_id, photo_key, photo_mime, photo_updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (user_id) DO UPDATE
        SET photo_key = EXCLUDED.photo_key, photo_mime = EXCLUDED.photo_mime,
            photo_updated_at = now()`,
    [actor.userId, stored.key, stored.mime],
  );
  forget(stored.previousKey);
  // Every conversation this person is in now shows a different face, so every
  // tab that can see them is told to re-read.
  const { rows } = await query<{ user_id: string }>(
    `SELECT DISTINCT other.user_id FROM chat_members mine
       JOIN chat_members other ON other.conversation_id = mine.conversation_id
      WHERE mine.user_id = $1`,
    [actor.userId],
  );
  publish(rows.map((r) => r.user_id), { type: 'chat.conversation', conversation_id: '' });
  return { photo_url: null };
}

export async function removeOwnPhoto(actor: Actor): Promise<void> {
  if (!actor.userId) throw new AppError('Sign in to change your picture.', 403, 'forbidden');
  const current = await queryOne<{ photo_key: string | null }>(
    'SELECT photo_key FROM user_profiles WHERE user_id = $1', [actor.userId]);
  await query(
    `UPDATE user_profiles SET photo_key = NULL, photo_mime = NULL, photo_updated_at = now()
      WHERE user_id = $1`,
    [actor.userId],
  );
  forget(current?.photo_key ?? null);
}

/**
 * The stored picture behind a photo URL.
 *
 * A colleague's face is not a secret inside the brokerage, so any signed-in
 * member of the same organization may fetch it — but only of the same
 * organization, which is why this takes the actor rather than trusting the id.
 */
export async function photoFor(
  actor: Actor, subject: 'users' | 'chats', id: string,
): Promise<{ storage_key: string; mime: string }> {
  const row = subject === 'users'
    ? await queryOne<{ photo_key: string | null; photo_mime: string | null }>(
        `SELECT up.photo_key, up.photo_mime FROM user_profiles up
           JOIN users u ON u.id = up.user_id
          WHERE up.user_id = $1 AND u.organization_id = $2`,
        [id, actor.organizationId])
    : await queryOne<{ photo_key: string | null; photo_mime: string | null }>(
        `SELECT photo_key, photo_mime FROM chat_conversations
          WHERE id = $1 AND organization_id = $2`,
        [id, actor.organizationId]);
  if (!row?.photo_key) throw notFound('That picture');
  return { storage_key: row.photo_key, mime: row.photo_mime ?? 'image/jpeg' };
}

// ── The Community group ────────────────────────────────────────────────────

/**
 * Every organization has one, and everybody active is in it.
 *
 * Run at boot and when staff are activated, so an organization created after
 * migration 0022 gets one too and a new hire is in it before their first
 * sign-in. Both halves are idempotent.
 */
export async function ensureCommunity(organizationId?: string): Promise<void> {
  const params = organizationId ? [organizationId] : [];
  const scoped = organizationId ? 'WHERE o.id = $1' : '';
  await query(
    `INSERT INTO chat_conversations (organization_id, kind, name, everyone_can_post)
     SELECT o.id, 'community', $${params.length + 1}, false FROM organizations o ${scoped}
     ON CONFLICT DO NOTHING`,
    [...params, DEFAULT_COMMUNITY_NAME],
  );
  await query(
    `INSERT INTO chat_members (conversation_id, user_id)
     SELECT c.id, u.id FROM chat_conversations c
       JOIN users u ON u.organization_id = c.organization_id AND u.active
      WHERE c.kind = 'community' ${organizationId ? 'AND c.organization_id = $1' : ''}
     ON CONFLICT DO NOTHING`,
    params,
  );
}

/**
 * A new or reactivated staff member joins the Community group.
 *
 * Called from the staff module rather than discovered by a nightly sweep,
 * because "the new hire cannot see the announcements until tomorrow" is a
 * support call.
 */
export async function joinCommunity(
  userId: string,
  organizationId: string,
  client?: Queryable,
): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO chat_members (conversation_id, user_id)
     SELECT c.id, $1 FROM chat_conversations c
      WHERE c.organization_id = $2 AND c.kind = 'community'
     ON CONFLICT DO NOTHING`,
    [userId, organizationId],
  );
}
