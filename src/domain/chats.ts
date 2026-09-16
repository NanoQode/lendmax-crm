/**
 * LM Chats — the rules, without a database.
 *
 * Internal staff messaging. Three things make it different from the client
 * messaging in `services/messaging.ts`, and all three live here:
 *
 *   1. STAFF DO NOT MESSAGE EACH OTHER ONE TO ONE. A direct conversation
 *      always has an admin on one side of it. Two brokers who need to talk do
 *      it in a group an admin made, where it is visible to the brokerage.
 *   2. THE COMMUNITY GROUP IS NOT A GROUP. Everyone is in it, nobody can
 *      leave it, only an admin can take somebody out of it, and by default
 *      only an admin speaks in it. It is an announcement channel that happens
 *      to be shaped like a chat.
 *   3. WHO MAY POST IS A PROPERTY OF THE CONVERSATION, not of the role. A
 *      group is open to its members; the Community is closed until an admin
 *      opens it.
 *
 * "Admin" here means the `chat.admin` permission, not a role — so the
 * brokerage can add or remove one under Staff without a code change.
 */

export const CHAT_KINDS = ['direct', 'group', 'community'] as const;
export type ChatKind = typeof CHAT_KINDS[number];

/** What the Community group is called before anybody renames it. */
export const DEFAULT_COMMUNITY_NAME = 'Community';

export const MAX_BODY_LENGTH = 4000;
export const MAX_GROUP_NAME = 60;

/** How much of a message the conversation list shows. */
export const PREVIEW_LENGTH = 120;

/** Page size for scrolling back through a conversation. */
export const MESSAGE_PAGE = 40;

// ── Attachments ────────────────────────────────────────────────────────────

/**
 * 20 MB, which is below the 25 MB the document uploader takes. Chat is not
 * where a client's file belongs, and a limit that is lower than the document
 * module's is a quiet reminder of that.
 */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * What staff may send each other. The MIME type and the extension must agree,
 * for the same reason they must in `domain/uploads.ts`: a browser will declare
 * anything, and an SVG is a script that runs if it is ever served inline.
 *
 * Archives are deliberately absent. Nothing in a brokerage's day needs a .zip
 * passed between staff, and an unscanned archive is the cheapest way to move
 * something executable through a system that has no scanner yet.
 */
const ATTACHMENT_TYPES = new Map<string, string[]>([
  ['application/pdf', ['.pdf']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/png', ['.png']],
  ['image/gif', ['.gif']],
  ['image/webp', ['.webp']],
  ['image/heic', ['.heic']],
  ['application/msword', ['.doc']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['.docx']],
  ['application/vnd.ms-excel', ['.xls']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['.xlsx']],
  ['application/vnd.ms-powerpoint', ['.ppt']],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ['.pptx']],
  ['text/csv', ['.csv']],
  ['text/plain', ['.txt']],
]);

/** The `accept` attribute for the file picker, from the one list above. */
export const ATTACHMENT_ACCEPT = [...ATTACHMENT_TYPES.values()].flat().join(',');

export type AttachmentCheck = { ok: true; extension: string } | { ok: false; reason: string };

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
};

export function checkAttachment(filename: string, mimeType: string, bytes: number): AttachmentCheck {
  if (bytes <= 0) return { ok: false, reason: 'That file is empty.' };
  if (bytes > ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      reason: `That file is ${(bytes / 1024 / 1024).toFixed(1)} MB and the limit is ` +
        `${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.`,
    };
  }
  const extension = extensionOf(filename);
  const allowed = ATTACHMENT_TYPES.get(mimeType.toLowerCase().split(';')[0]!.trim());
  if (!allowed) {
    return {
      ok: false,
      reason: `${mimeType || 'That file type'} cannot be sent in a chat. ` +
        'Send an image, a PDF, or an Office document.',
    };
  }
  if (!allowed.includes(extension)) {
    return {
      ok: false,
      reason: `The file is named "${extension}" but declares itself as ${mimeType}. Rename it and try again.`,
    };
  }
  return { ok: true, extension };
}

export const isImage = (mimeType: string): boolean => mimeType.toLowerCase().startsWith('image/');

// ── Photos ─────────────────────────────────────────────────────────────────

/**
 * A group's picture, and a person's.
 *
 * Smaller than a chat attachment on purpose: this is displayed at 26 pixels
 * in a list. Anything over a couple of megabytes is a photo nobody resized,
 * and serving it to every row of every conversation costs everybody.
 */
export const PHOTO_MAX_BYTES = 4 * 1024 * 1024;

const PHOTO_TYPES = new Map<string, string[]>([
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/png', ['.png']],
  ['image/webp', ['.webp']],
  ['image/heic', ['.heic']],
]);

export const PHOTO_ACCEPT = [...PHOTO_TYPES.values()].flat().join(',');

/** GIF is absent deliberately: an animated avatar in a list of forty is a distraction. */
export function checkPhoto(filename: string, mimeType: string, bytes: number): AttachmentCheck {
  if (bytes <= 0) return { ok: false, reason: 'That file is empty.' };
  if (bytes > PHOTO_MAX_BYTES) {
    return {
      ok: false,
      reason: `That picture is ${(bytes / 1024 / 1024).toFixed(1)} MB and the limit is ` +
        `${PHOTO_MAX_BYTES / 1024 / 1024} MB. Resize it and try again.`,
    };
  }
  const extension = extensionOf(filename);
  const allowed = PHOTO_TYPES.get(mimeType.toLowerCase().split(';')[0]!.trim());
  if (!allowed) return { ok: false, reason: 'A picture must be a JPEG, PNG, WebP or HEIC.' };
  if (!allowed.includes(extension)) {
    return {
      ok: false,
      reason: `The file is named "${extension}" but declares itself as ${mimeType}. Rename it and try again.`,
    };
  }
  return { ok: true, extension };
}

/** "2.4 MB" — for the attachment row, where the exact byte count helps nobody. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Who may talk to whom ───────────────────────────────────────────────────

export type Person = { id: string; isAdmin: boolean };

/**
 * A one-to-one conversation needs an admin on one side.
 *
 * Two admins may talk to each other — they are both the people this module
 * exists to reach. Two non-admins may not, whichever of them starts it.
 */
export function canOpenDirect(a: Person, b: Person): true | string {
  if (a.id === b.id) return 'You cannot start a chat with yourself.';
  if (a.isAdmin || b.isAdmin) return true;
  return 'Staff message the admin, not each other. Ask an admin to make a group if you need to talk as a team.';
}

/** The stable identity of a pair, so two people never end up with two threads. */
export function directKey(a: string, b: string): string {
  return [a, b].sort().join(':');
}

// ── What may be done to a conversation ─────────────────────────────────────

export type ConversationLike = {
  kind: ChatKind;
  everyone_can_post: boolean;
};

export type MembershipLike = {
  is_member: boolean;
  is_admin: boolean;
};

/**
 * Whether this person may send into this conversation, and why not if not.
 *
 * The Community group is the interesting case: membership is not permission
 * there. Everyone is a member and, until an admin opens it, only an admin
 * speaks.
 */
export function postRefusal(c: ConversationLike, m: MembershipLike): string | null {
  if (!m.is_member) return 'You are not in this conversation.';
  if (c.kind === 'community' && !c.everyone_can_post && !m.is_admin) {
    return 'Only an admin posts in this group. An admin can open it to everyone.';
  }
  if (c.kind === 'group' && !c.everyone_can_post && !m.is_admin) {
    return 'Only an admin posts in this group.';
  }
  return null;
}

export const canPost = (c: ConversationLike, m: MembershipLike): boolean => postRefusal(c, m) === null;

/** Nobody leaves the Community group. Everything else, a member may walk out of. */
export function leaveRefusal(c: ConversationLike, m: MembershipLike): string | null {
  if (!m.is_member) return 'You are not in this conversation.';
  if (c.kind === 'community') return 'Nobody leaves the Community group. Only an admin can remove someone.';
  if (c.kind === 'direct') return 'A one-to-one chat cannot be left. Mute it instead.';
  return null;
}

/** Only an admin makes, renames, empties or removes a group — including the Community one. */
export function manageRefusal(c: ConversationLike, m: MembershipLike): string | null {
  if (c.kind === 'direct') return 'A one-to-one chat has no members to manage.';
  if (!m.is_admin) return 'Only an admin manages groups.';
  return null;
}

/** The Community group is permanent: it can be renamed and emptied, never deleted. */
export function deleteRefusal(c: ConversationLike, m: MembershipLike): string | null {
  const managing = manageRefusal(c, m);
  if (managing) return managing;
  if (c.kind === 'community') return 'The Community group cannot be deleted. Rename it instead.';
  return null;
}

// ── Muting ─────────────────────────────────────────────────────────────────

/**
 * "Always" is stored as a date far enough out that no query has to special-case
 * it: muted is `muted_until > now()`, one comparison, everywhere.
 */
export const MUTE_FOREVER = new Date('9999-12-31T00:00:00.000Z');

export const MUTE_OPTIONS = [
  { key: '8h', label: 'For 8 hours', hours: 8 },
  { key: '1w', label: 'For a week', hours: 24 * 7 },
  { key: 'always', label: 'Until I turn it back on', hours: null },
] as const;
export type MuteOption = typeof MUTE_OPTIONS[number]['key'];
export const MUTE_KEYS = MUTE_OPTIONS.map((o) => o.key) as [MuteOption, ...MuteOption[]];

export function muteUntil(option: MuteOption, now: Date): Date {
  const found = MUTE_OPTIONS.find((o) => o.key === option);
  if (!found || found.hours === null) return MUTE_FOREVER;
  return new Date(now.getTime() + found.hours * 3_600_000);
}

export const isMuted = (mutedUntil: Date | null, now: Date): boolean =>
  !!mutedUntil && mutedUntil.getTime() > now.getTime();

// ── What the list shows ────────────────────────────────────────────────────

export type MessageLike = {
  body: string | null;
  attachment_name?: string | null;
  attachment_count?: number;
  kind?: string;
};

/**
 * The one line under a conversation's name.
 *
 * A message that is only a file says so with the filename, because "📎
 * Attachment" tells somebody scanning the list nothing they did not know.
 */
export function previewOf(message: MessageLike | null): string {
  if (!message) return 'No messages yet';
  const body = (message.body ?? '').replace(/\s+/g, ' ').trim();
  if (body) {
    return body.length > PREVIEW_LENGTH ? `${body.slice(0, PREVIEW_LENGTH - 1)}…` : body;
  }
  if (message.attachment_name) return `📎 ${message.attachment_name}`;
  if (message.attachment_count && message.attachment_count > 0) {
    return `📎 ${message.attachment_count} files`;
  }
  return 'No messages yet';
}

// ── Validation ─────────────────────────────────────────────────────────────

export function groupNameRefusal(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'A group needs a name.';
  if (trimmed.length > MAX_GROUP_NAME) return `A group name is at most ${MAX_GROUP_NAME} characters.`;
  return null;
}

/** A message must say something or carry something. An empty one is a mis-click. */
export function messageRefusal(body: string, attachments: number): string | null {
  const trimmed = body.trim();
  if (!trimmed && attachments === 0) return 'Write something, or attach a file.';
  if (trimmed.length > MAX_BODY_LENGTH) {
    return `That message is ${trimmed.length} characters and the limit is ${MAX_BODY_LENGTH}.`;
  }
  return null;
}

/** What a conversation is called for the person looking at it. */
export function titleFor(
  c: { kind: ChatKind; name: string | null },
  others: Array<{ name: string }>,
): string {
  if (c.kind === 'direct') return others[0]?.name ?? 'Direct message';
  return c.name ?? 'Group';
}

// ── Taking it back ─────────────────────────────────────────────────────────

/**
 * How long a message stays editable and deletable.
 *
 * Nineteen minutes from when it was SENT, not from the last edit — otherwise
 * editing repeatedly would keep a message editable for ever, and "you can fix
 * a typo for a few minutes" would quietly become "you can rewrite history".
 */
export const EDIT_WINDOW_MINUTES = 19;

export type OwnedMessage = {
  sender_id: string | null;
  created_at: Date;
  deleted_at?: Date | null;
  kind?: string;
};

export const editWindowClosesAt = (message: OwnedMessage): Date =>
  new Date(message.created_at.getTime() + EDIT_WINDOW_MINUTES * 60_000);

/** Milliseconds left to change it, floored at zero. */
export const editWindowRemaining = (message: OwnedMessage, now: Date): number =>
  Math.max(0, editWindowClosesAt(message).getTime() - now.getTime());

/**
 * Whether this person may still change this message, and why not if not.
 *
 * Only the sender, only inside the window, and never a system line — nobody
 * wrote "Alex added Dana", so nobody may edit it into something else.
 */
export function amendRefusal(
  message: OwnedMessage,
  viewerId: string,
  now: Date,
  verb: 'edit' | 'delete',
): string | null {
  if (message.kind === 'system') return 'That line was not written by anybody, so it cannot be changed.';
  if (message.deleted_at) return 'That message has already been deleted.';
  if (message.sender_id !== viewerId) {
    return verb === 'edit'
      ? 'You can only edit your own messages.'
      : 'You can only delete your own messages.';
  }
  if (editWindowRemaining(message, now) <= 0) {
    // Spelled out rather than built from the verb: "edit" + "d" is "editd".
    const past = verb === 'edit' ? 'edited' : 'deleted';
    return `A message can only be ${past} within ${EDIT_WINDOW_MINUTES} minutes of sending it.`;
  }
  return null;
}

export const canAmend = (message: OwnedMessage, viewerId: string, now: Date): boolean =>
  amendRefusal(message, viewerId, now, 'edit') === null;

/** What stands in a deleted message's place. The row stays; the words do not. */
export const DELETED_PLACEHOLDER = 'This message was deleted';

// ── Read receipts ──────────────────────────────────────────────────────────

export type ReadState = 'sent' | 'read' | 'partly_read';

/**
 * Who has seen a message, from the same `last_read_at` the unread badge uses.
 *
 * One source of truth deliberately: a separate per-message receipt table would
 * be a second answer to "has Dana seen this", and the day the two disagree is
 * the day nobody trusts either.
 *
 * `readers` is every OTHER member's last_read_at — null for somebody who has
 * never opened the conversation.
 */
export function readState(
  message: { created_at: Date; sender_id: string | null },
  readers: Array<Date | null>,
): { state: ReadState; read_by: number; of: number } {
  const of = readers.length;
  const read_by = readers.filter((at) => at !== null && at.getTime() >= message.created_at.getTime()).length;
  if (of === 0 || read_by === 0) return { state: 'sent', read_by, of };
  return { state: read_by === of ? 'read' : 'partly_read', read_by, of };
}

/** "Read", "Read by 3 of 8", or "Sent" — the tick always has words beside it. */
export function readLabel(result: { state: ReadState; read_by: number; of: number }, group: boolean): string {
  if (result.state === 'sent') return 'Sent';
  if (result.state === 'read') return group && result.of > 1 ? `Read by all ${result.of}` : 'Read';
  return `Read by ${result.read_by} of ${result.of}`;
}

// ── Typing ─────────────────────────────────────────────────────────────────

/**
 * A "still typing" ping is sent at most this often, and a received one is
 * believed for this long plus a margin. Both live here so the two ends cannot
 * drift into a indicator that sticks on screen for ever.
 */
export const TYPING_PING_MS = 3_000;
export const TYPING_EXPIRY_MS = 7_000;

/** "Dana is typing…", "Dana and Evan are typing…", "3 people are typing…" */
export function typingLabel(names: string[]): string {
  const first = names.map((n) => n.split(' ')[0] ?? n);
  if (first.length === 0) return '';
  if (first.length === 1) return `${first[0]} is typing…`;
  if (first.length === 2) return `${first[0]} and ${first[1]} are typing…`;
  return `${first.length} people are typing…`;
}

// ── Searching inside a conversation ────────────────────────────────────────

export const MIN_SEARCH_LENGTH = 2;
export const SEARCH_SNIPPET_PAD = 40;

export function searchRefusal(term: string): string | null {
  if (term.trim().length < MIN_SEARCH_LENGTH) {
    return `Type at least ${MIN_SEARCH_LENGTH} characters to search.`;
  }
  return null;
}

/**
 * A one-line extract around the first match, so a result list shows the hit
 * rather than the first forty characters of a long message.
 */
export function snippetAround(body: string, term: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(term.trim().toLowerCase());
  if (at < 0) return flat.slice(0, PREVIEW_LENGTH);
  const from = Math.max(0, at - SEARCH_SNIPPET_PAD);
  const to = Math.min(flat.length, at + term.trim().length + SEARCH_SNIPPET_PAD);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}
