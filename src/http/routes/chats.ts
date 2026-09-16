/**
 * LM Chats — the staff-only endpoints, and the event stream behind them.
 *
 * `chat.use` gates everything; `chat.admin` is read once per request and
 * handed to the service as `isAdmin`, so the rules live in one place and a
 * route never decides who somebody is.
 *
 * There is no counterpart under /api/v1. That is deliberate and documented in
 * `domain/permissions.ts`: a connected website cannot hold a scope that does
 * not exist.
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import {
  ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, EDIT_WINDOW_MINUTES, MUTE_OPTIONS,
  PHOTO_ACCEPT, PHOTO_MAX_BYTES, TYPING_PING_MS,
} from '../../domain/chats.ts';
import { can } from '../../domain/permissions.ts';
import {
  addMembers, attachmentFor, contacts, createGroup, deleteGroup, deleteMessage, editMessage,
  getConversation, leaveConversation, listConversations, listMembers, listMessages, markRead,
  openDirect, photoFor, removeGroupPhoto, removeMember, removeOwnPhoto, renameGroup, searchMessages,
  sendMessage, setGroupPhoto, setMute, setOwnPhoto, setPosting, setTyping, unreadTotal,
  type IncomingFile, type Scope,
} from '../../services/chats.ts';
import { subscribe } from '../../services/realtime.ts';
import { getObjectStream } from '../../services/storage.ts';
import { AppError, asyncRoute } from '../middleware/errors.ts';
import { actorOf, requireAuth, requirePermission } from '../middleware/auth.ts';

export const chatRoutes: Router = Router();

const UUID = z.string().uuid();

/** The 20 MB ceiling is enforced here, and again per file in the domain check. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 5 },
});

/** A picture is one file and a quarter of the size. */
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_MAX_BYTES, files: 1 },
});

const oneFile = (req: Request): IncomingFile => {
  const file = (req as { file?: IncomingFile }).file;
  if (!file) throw new AppError('No picture was attached.', 422, 'validation_failed');
  return file;
};

const scopeOf = (req: Request): Scope => ({
  actor: actorOf(req),
  isAdmin: can(req.user!, 'chat.admin'),
});

const filesOf = (req: { files?: unknown }): IncomingFile[] =>
  Array.isArray(req.files) ? (req.files as IncomingFile[]) : [];

/**
 * A stored picture, streamed.
 *
 * Cached hard and privately: the URL carries the version the picture was
 * changed at, so a new one is a new URL and an old one can be kept for a day
 * without anybody ever seeing a stale face.
 */
async function sendPhoto(res: Response, file: { storage_key: string; mime: string }): Promise<void> {
  res.setHeader('Content-Type', file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  getObjectStream(file.storage_key)
    .on('error', () => {
      if (!res.headersSent) res.status(404).json({ ok: false, code: 'not_found', error: 'That picture is missing.' });
      else res.destroy();
    })
    .pipe(res);
}

// ── People's pictures ──────────────────────────────────────────────────────

/**
 * Anybody signed in can see a colleague's face; only you can change yours.
 *
 * These live on /users rather than /chats because a profile picture is not a
 * chat concept — the chat module is simply the first thing to show one.
 */
chatRoutes.get(
  '/users/:id/photo',
  requireAuth,
  asyncRoute(async (req, res) => {
    // "me" resolves to whoever is asking, so the profile screen can show the
    // picture it has just uploaded without knowing its own id.
    const id = req.params.id === 'me' ? req.user!.id : UUID.parse(req.params.id);
    await sendPhoto(res, await photoFor(actorOf(req), 'users', id));
  }),
);

chatRoutes.put(
  '/users/me/photo',
  requireAuth,
  photoUpload.single('photo'),
  asyncRoute(async (req, res) => {
    await setOwnPhoto(actorOf(req), oneFile(req));
    res.json({ ok: true });
  }),
);

chatRoutes.delete(
  '/users/me/photo',
  requireAuth,
  asyncRoute(async (req, res) => {
    await removeOwnPhoto(actorOf(req));
    res.json({ ok: true });
  }),
);

// ── The event stream ───────────────────────────────────────────────────────

/**
 * One long-lived GET per tab. Mounted at the top of the router, before the
 * per-conversation paths, because it is not one of them and because an
 * unmatched `/chats/:id` would otherwise try to load a conversation called
 * "events".
 *
 * It intentionally holds the response open, so it uses neither `asyncRoute`
 * nor `res.json`.
 */
chatRoutes.get(
  '/events',
  requireAuth,
  requirePermission('chat.use'),
  (req, res) => {
    const user = req.user!;
    const unsubscribe = subscribe(user.id, user.organization_id, res);
    // Both events fire in practice — `close` when the tab goes away, `aborted`
    // when a proxy drops it — and dropping twice is harmless.
    req.on('close', unsubscribe);
    req.on('aborted', unsubscribe);
  },
);

// ── Everything else needs a signed-in chat user ────────────────────────────

chatRoutes.use('/chats', requireAuth, requirePermission('chat.use'));

chatRoutes.get(
  '/chats/meta',
  asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      is_admin: can(req.user!, 'chat.admin'),
      attachment_accept: ATTACHMENT_ACCEPT,
      attachment_max_bytes: ATTACHMENT_MAX_BYTES,
      photo_accept: PHOTO_ACCEPT,
      photo_max_bytes: PHOTO_MAX_BYTES,
      edit_window_minutes: EDIT_WINDOW_MINUTES,
      typing_ping_ms: TYPING_PING_MS,
      mute_options: MUTE_OPTIONS.map((o) => ({ key: o.key, label: o.label })),
    });
  }),
);

chatRoutes.get(
  '/chats',
  asyncRoute(async (req, res) => {
    res.json({ ok: true, conversations: await listConversations(scopeOf(req)) });
  }),
);

/** The number on the sidebar. Its own endpoint so the shell need not load the list. */
chatRoutes.get(
  '/chats/unread',
  asyncRoute(async (req, res) => {
    res.json({ ok: true, ...(await unreadTotal(scopeOf(req))) });
  }),
);

chatRoutes.get(
  '/chats/contacts',
  asyncRoute(async (req, res) => {
    res.json({ ok: true, contacts: await contacts(scopeOf(req)) });
  }),
);

/** Open the one-to-one chat with somebody, creating it the first time. */
chatRoutes.post(
  '/chats/direct',
  asyncRoute(async (req, res) => {
    const body = z.object({ user_id: UUID }).parse(req.body ?? {});
    res.json({ ok: true, conversation: await openDirect(scopeOf(req), body.user_id) });
  }),
);

chatRoutes.post(
  '/chats/groups',
  asyncRoute(async (req, res) => {
    res.status(201).json({ ok: true, conversation: await createGroup(scopeOf(req), req.body) });
  }),
);

// ── Attachments ────────────────────────────────────────────────────────────

/**
 * Served straight from the session rather than through a signed link.
 *
 * The documents module signs a per-user grant because a document leaves the
 * system the moment its URL does. A chat attachment cannot: every request
 * re-proves membership of the conversation, and the reply is never cached by
 * anything shared.
 *
 * Images render in the thread, so they go inline; everything else downloads.
 * Nothing scriptable is in the accepted list — no SVG, no HTML — and
 * `nosniff` keeps a browser from deciding otherwise.
 */
chatRoutes.get(
  '/chats/attachments/:id',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    const file = await attachmentFor(scopeOf(req), id);
    const inline = file.mime_type.toLowerCase().startsWith('image/');
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Length', String(file.byte_size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${file.filename.replace(/["\\]/g, '')}"`,
    );
    getObjectStream(file.storage_key)
      .on('error', () => {
        if (!res.headersSent) res.status(404).json({ ok: false, code: 'not_found', error: 'That file is missing.' });
        else res.destroy();
      })
      .pipe(res);
  }),
);

// ── Messages a person wants back ───────────────────────────────────────────

/**
 * Edit or delete one message. Whose it is and how long ago it was sent are
 * the service's business; this only routes.
 *
 * Mounted before `/chats/:id` so "messages" is never read as a conversation id.
 */
chatRoutes.patch(
  '/chats/messages/:messageId',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.messageId);
    res.json({ ok: true, message: await editMessage(scopeOf(req), id, req.body) });
  }),
);

chatRoutes.delete(
  '/chats/messages/:messageId',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.messageId);
    res.json({ ok: true, message: await deleteMessage(scopeOf(req), id) });
  }),
);

// ── One conversation ───────────────────────────────────────────────────────

chatRoutes.get(
  '/chats/:id',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    const scope = scopeOf(req);
    const conversation = await getConversation(scope, id);
    res.json({ ok: true, conversation, members: await listMembers(scope, id) });
  }),
);

chatRoutes.get(
  '/chats/:id/messages',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    const q = z.object({
      before: UUID.optional(),
      // Centre the page on this message, for jumping to a search hit.
      around: UUID.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).parse(req.query);
    const page = await listMessages(scopeOf(req), id, q, env.BASE_PATH);
    res.json({ ok: true, ...page });
  }),
);

/**
 * Send. Multipart when there is a file, JSON when there is not — multer
 * passes a JSON body through untouched, so one handler serves both.
 */
chatRoutes.post(
  '/chats/:id/messages',
  upload.array('files', 5),
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    const message = await sendMessage(scopeOf(req), id, req.body, filesOf(req), env.BASE_PATH);
    res.status(201).json({ ok: true, message });
  }),
);

/** Find something said in this conversation. `?q=` and an optional `?limit=`. */
chatRoutes.get(
  '/chats/:id/search',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    res.json({ ok: true, ...(await searchMessages(scopeOf(req), id, req.query)) });
  }),
);

/**
 * "I am typing."
 *
 * Answers 204 and writes nothing durable. The client sends it at most once
 * every few seconds while somebody is actually typing, and it expires on its
 * own — see `TYPING_EXPIRY_MS`.
 */
chatRoutes.post(
  '/chats/:id/typing',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    await setTyping(scopeOf(req), id);
    res.status(204).end();
  }),
);

// ── Pictures ───────────────────────────────────────────────────────────────

/** A group's picture. Served to any member; set by an admin. */
chatRoutes.get(
  '/chats/:id/photo',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    await sendPhoto(res, await photoFor(actorOf(req), 'chats', id));
  }),
);

chatRoutes.put(
  '/chats/:id/photo',
  photoUpload.single('photo'),
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    res.json({ ok: true, conversation: await setGroupPhoto(scopeOf(req), id, oneFile(req)) });
  }),
);

chatRoutes.delete(
  '/chats/:id/photo',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    res.json({ ok: true, conversation: await removeGroupPhoto(scopeOf(req), id) });
  }),
);

chatRoutes.post(
  '/chats/:id/read',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    res.json({ ok: true, ...(await markRead(scopeOf(req), id)) });
  }),
);

/** `{ "mute": "8h" | "1w" | "always" }`, or `{ "mute": null }` to turn it back on. */
chatRoutes.post(
  '/chats/:id/mute',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    res.json({ ok: true, conversation: await setMute(scopeOf(req), id, req.body) });
  }),
);

chatRoutes.post(
  '/chats/:id/leave',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    res.json({ ok: true, ...(await leaveConversation(scopeOf(req), id)) });
  }),
);

// ── Group administration ───────────────────────────────────────────────────

/** Rename, or open and close posting. Both are admin-only, checked in the service. */
chatRoutes.patch(
  '/chats/:id',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    const body = z.object({
      name: z.string().optional(),
      everyone_can_post: z.boolean().optional(),
    }).parse(req.body ?? {});
    if (body.name === undefined && body.everyone_can_post === undefined) {
      throw new AppError('Nothing to change.', 422, 'validation_failed');
    }
    const scope = scopeOf(req);
    let conversation = await getConversation(scope, id);
    if (body.name !== undefined) conversation = await renameGroup(scope, id, { name: body.name });
    if (body.everyone_can_post !== undefined) {
      conversation = await setPosting(scope, id, { everyone_can_post: body.everyone_can_post });
    }
    res.json({ ok: true, conversation });
  }),
);

chatRoutes.post(
  '/chats/:id/members',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    const scope = scopeOf(req);
    const conversation = await addMembers(scope, id, req.body);
    res.json({ ok: true, conversation, members: await listMembers(scope, id) });
  }),
);

chatRoutes.delete(
  '/chats/:id/members/:userId',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    const userId = UUID.parse(req.params.userId);
    const scope = scopeOf(req);
    const conversation = await removeMember(scope, id, userId);
    res.json({ ok: true, conversation, members: await listMembers(scope, id) });
  }),
);

chatRoutes.delete(
  '/chats/:id',
  asyncRoute(async (req, res) => {
    const id = UUID.parse(req.params.id);
    res.json({ ok: true, ...(await deleteGroup(scopeOf(req), id)) });
  }),
);
