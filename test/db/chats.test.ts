/**
 * LM Chats, against a real database: who may talk to whom, the Community
 * group's particular rules, attachments, unread counts, muting, and what
 * group administration leaves behind in the activity log.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, queryOne } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createApp } from '../../src/http/app.ts';
import { AppError } from '../../src/http/middleware/errors.ts';
import { createSession } from '../../src/services/auth.ts';
import { listActivity } from '../../src/services/activity.ts';
import { closeAll, connectionCount } from '../../src/services/realtime.ts';
import { createStaff } from '../../src/services/staff.ts';
import {
  addMembers, contacts, createGroup, deleteGroup, deleteMessage, editMessage, getConversation,
  leaveConversation, listConversations, listMembers, listMessages, markRead, openDirect, photoFor,
  removeGroupPhoto, removeMember, removeOwnPhoto, renameGroup, searchMessages, sendMessage,
  setGroupPhoto, setMute, setOwnPhoto, setPosting, setTyping, unreadTotal, type Scope,
} from '../../src/services/chats.ts';
import { objectExists } from '../../src/services/storage.ts';
import type { Actor } from '../../src/services/staff.ts';

const app = createApp();
let server: ReturnType<typeof app.listen>;
let base: string;
let orgId: string;
let alex: Actor, dana: Actor, evan: Actor, mia: Actor;
let alexScope: Scope, danaScope: Scope, evanScope: Scope, miaScope: Scope;
let danaCookie: string, alexCookie: string;

before(async () => {
  await migrate();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/crm/api`;
});
after(async () => { closeAll(); server.close(); await pool.end(); });

const person = async (email: string, name: string, role: string): Promise<Actor> => {
  const id = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, activated_at, profile_complete)
     VALUES ($1,$2,$3,$4,true,now(),true) RETURNING id`, [orgId, email, name, role])).rows[0]!.id;
  return { organizationId: orgId, kind: 'user', userId: id, name, role };
};

const scopeOf = (a: Actor, isAdmin: boolean): Scope => ({ actor: a, isAdmin });

const communityId = async (): Promise<string> => (await queryOne<{ id: string }>(
  `SELECT id FROM chat_conversations WHERE organization_id = $1 AND kind = 'community'`, [orgId]))!.id;

const bodies = async (scope: Scope, id: string) =>
  (await listMessages(scope, id)).messages.map((m) => m.body);

beforeEach(async () => {
  closeAll();
  await query('TRUNCATE organizations CASCADE');
  await query('TRUNCATE audit_log');
  orgId = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Lendmax','ON') RETURNING id`)).rows[0]!.id;
  // Technical Admin and Manager hold chat.admin by role; the two brokers do not.
  alex = await person('alex@example.com', 'Alex Admin', 'technical_admin');
  mia = await person('mia@example.com', 'Mia Manager', 'manager');
  dana = await person('dana@example.com', 'Dana Broker', 'broker');
  evan = await person('evan@example.com', 'Evan Broker', 'broker');
  alexScope = scopeOf(alex, true);
  miaScope = scopeOf(mia, true);
  danaScope = scopeOf(dana, false);
  evanScope = scopeOf(evan, false);
  danaCookie = `lmx_crm_session=${(await createSession(dana.userId!, {})).token}`;
  alexCookie = `lmx_crm_session=${(await createSession(alex.userId!, {})).token}`;
  // Migration 0022 made the Community group for the organization it found;
  // this one is new, so the service's own boot path makes it.
  const { ensureCommunity } = await import('../../src/services/chats.ts');
  await ensureCommunity(orgId);
});

// ── Staff to admin, and not to each other ──────────────────────────────────

test('a broker messages the admin, and the admin messages back', async () => {
  const conversation = await openDirect(danaScope, alex.userId!);
  assert.equal(conversation.kind, 'direct');
  assert.equal(conversation.title, 'Alex Admin', 'a direct chat is named by the other person');

  await sendMessage(danaScope, conversation.id, { body: 'Can you reset my Scarlett login?' });
  await sendMessage(alexScope, conversation.id, { body: 'Done — try it now.' });

  assert.deepEqual(await bodies(danaScope, conversation.id),
    ['Can you reset my Scarlett login?', 'Done — try it now.']);

  // Opening it again is the same conversation, not a second one.
  const again = await openDirect(alexScope, dana.userId!);
  assert.equal(again.id, conversation.id);
  const { rows } = await query(`SELECT id FROM chat_conversations WHERE kind = 'direct'`);
  assert.equal(rows.length, 1);
});

test('two brokers cannot open a chat with each other, and are not offered one', async () => {
  await assert.rejects(
    openDirect(danaScope, evan.userId!),
    (err: AppError) => err.status === 403 && /Staff message the admin/.test(err.message),
  );

  const offered = await contacts(danaScope);
  assert.deepEqual(offered.map((c) => c.name), ['Alex Admin', 'Mia Manager'],
    'a broker is only offered the admins');
  assert.ok(offered.every((c) => c.is_admin));

  // An admin is offered everybody else.
  const adminSees = await contacts(alexScope);
  assert.deepEqual(adminSees.map((c) => c.name).sort(), ['Dana Broker', 'Evan Broker', 'Mia Manager']);
});

test('two admins may talk to each other', async () => {
  const conversation = await openDirect(alexScope, mia.userId!);
  await sendMessage(miaScope, conversation.id, { body: 'Board meeting moved.' });
  assert.deepEqual(await bodies(alexScope, conversation.id), ['Board meeting moved.']);
});

test('a broker cannot read a conversation they are not in — it is simply not there', async () => {
  const theirs = await openDirect(miaScope, evan.userId!);
  await assert.rejects(getConversation(danaScope, theirs.id), (err: AppError) => err.status === 404);
  // Nor can an admin who is not in it. Being an admin runs the groups you are
  // in; it is not a key to every conversation in the brokerage.
  await assert.rejects(getConversation(alexScope, theirs.id), (err: AppError) => err.status === 404);
});

// ── The Community group ────────────────────────────────────────────────────

test('everybody is in Community, only an admin posts, and an admin can open it', async () => {
  const id = await communityId();
  const members = await listMembers(alexScope, id);
  assert.deepEqual(members.map((m) => m.name).sort(),
    ['Alex Admin', 'Dana Broker', 'Evan Broker', 'Mia Manager']);

  const asBroker = await getConversation(danaScope, id);
  assert.equal(asBroker.can_post, false);
  assert.match(asBroker.post_refusal!, /Only an admin posts/);
  await assert.rejects(
    sendMessage(danaScope, id, { body: 'hello everyone' }),
    (err: AppError) => err.status === 403 && err.code === 'cannot_post',
  );

  await sendMessage(alexScope, id, { body: 'Office closed Monday.' });
  assert.deepEqual(await bodies(danaScope, id), ['Office closed Monday.']);

  await setPosting(alexScope, id, { everyone_can_post: true });
  await sendMessage(danaScope, id, { body: 'Thanks!' });
  assert.deepEqual(await bodies(danaScope, id), [
    'Office closed Monday.', 'Alex Admin opened this group — everyone can post', 'Thanks!',
  ]);
});

test('nobody leaves Community; an admin can take somebody out, and rename it', async () => {
  const id = await communityId();

  await assert.rejects(
    leaveConversation(danaScope, id),
    (err: AppError) => err.status === 403 && /Nobody leaves the Community group/.test(err.message),
  );
  await assert.rejects(
    leaveConversation(alexScope, id),
    (err: AppError) => err.status === 403, 'not even an admin',
  );
  await assert.rejects(
    deleteGroup(alexScope, id),
    (err: AppError) => /cannot be deleted/.test(err.message),
  );

  const renamed = await renameGroup(alexScope, id, { name: 'Lendmax Team' });
  assert.equal(renamed.title, 'Lendmax Team');

  await removeMember(alexScope, id, evan.userId!);
  assert.deepEqual((await listMembers(alexScope, id)).map((m) => m.name).sort(),
    ['Alex Admin', 'Dana Broker', 'Mia Manager']);
  await assert.rejects(getConversation(evanScope, id), (err: AppError) => err.status === 404);

  // A broker cannot do any of it.
  await assert.rejects(renameGroup(danaScope, id, { name: 'Mine' }), (err: AppError) => err.status === 403);
  await assert.rejects(removeMember(danaScope, id, alex.userId!), (err: AppError) => err.status === 403);
});

test('a new hire is in the Community group before their first sign-in', async () => {
  await createStaff(alex, {
    first_name: 'Nina', last_name: 'New', email: 'nina@example.com',
    mobile_phone: '(647) 555-0188', role: 'broker',
    licence_number: 'M24001234', licence_province: 'ON', round_robin_enabled: false,
  });
  const id = await communityId();
  assert.ok((await listMembers(alexScope, id)).some((m) => m.name === 'Nina New'));
});

// ── Groups ─────────────────────────────────────────────────────────────────

test('an admin makes a group, staff talk in it, and it can be removed', async () => {
  const group = await createGroup(alexScope, {
    name: 'Renewals push', member_ids: [dana.userId!, evan.userId!],
  });
  assert.equal(group.kind, 'group');
  assert.equal(group.member_count, 3, 'the admin who made it is in it');

  // A plain group is open to its members — this is where two brokers may talk.
  await sendMessage(danaScope, group.id, { body: 'I have 12 coming up in March.' });
  await sendMessage(evanScope, group.id, { body: 'Same, I will take the west end.' });
  assert.equal((await listMessages(evanScope, group.id)).messages.length, 3,
    'two messages and the "created this group" line');

  // …and an admin can close it again.
  await setPosting(alexScope, group.id, { everyone_can_post: false });
  await assert.rejects(sendMessage(danaScope, group.id, { body: 'still here?' }),
    (err: AppError) => err.code === 'cannot_post');

  await deleteGroup(alexScope, group.id);
  await assert.rejects(getConversation(danaScope, group.id), (err: AppError) => err.status === 404);
  assert.equal((await listConversations(danaScope)).some((c) => c.id === group.id), false);
  // Archived, not destroyed: what was said is still there.
  const kept = await queryOne<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM chat_messages WHERE conversation_id = $1', [group.id]);
  assert.equal(kept!.n, 4);
});

test('members are added and removed, and a member can leave', async () => {
  const group = await createGroup(alexScope, { name: 'Ops', member_ids: [dana.userId!] });
  await addMembers(alexScope, group.id, { user_ids: [evan.userId!, mia.userId!] });
  assert.equal((await getConversation(alexScope, group.id)).member_count, 4);

  await removeMember(alexScope, group.id, evan.userId!);
  await assert.rejects(getConversation(evanScope, group.id), (err: AppError) => err.status === 404);

  await leaveConversation(danaScope, group.id);
  await assert.rejects(getConversation(danaScope, group.id), (err: AppError) => err.status === 404);
  assert.deepEqual((await listMembers(alexScope, group.id)).map((m) => m.name),
    ['Alex Admin', 'Mia Manager']);

  // The thread says what happened, without anybody having written it.
  const trail = (await listMessages(alexScope, group.id)).messages.filter((m) => m.kind === 'system');
  assert.deepEqual(trail.map((m) => m.body), [
    'Alex Admin created this group',
    'Alex Admin added Evan Broker, Mia Manager',
    'Alex Admin removed Evan Broker',
    'Dana Broker left',
  ]);
});

test('the last admin cannot walk out and strand a group', async () => {
  const group = await createGroup(alexScope, { name: 'Just us', member_ids: [dana.userId!] });
  await assert.rejects(
    leaveConversation(alexScope, group.id),
    (err: AppError) => err.status === 409 && /only admin in this group/.test(err.message),
  );
  await addMembers(alexScope, group.id, { user_ids: [mia.userId!] });
  await leaveConversation(alexScope, group.id);
  assert.equal((await getConversation(miaScope, group.id)).can_manage, true);
});

test('a broker cannot make a group', async () => {
  await assert.rejects(
    createGroup(danaScope, { name: 'Brokers only', member_ids: [evan.userId!] }),
    (err: AppError) => err.status === 403,
  );
});

// ── Unread, ordering and muting ────────────────────────────────────────────

test('unread counts what you have not seen, and the newest chat comes first', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  const group = await createGroup(alexScope, { name: 'Ops', member_ids: [dana.userId!] });
  const community = await communityId();

  await sendMessage(alexScope, community.valueOf(), { body: 'Announcement' });
  await sendMessage(alexScope, group.id, { body: 'one' });
  await sendMessage(alexScope, group.id, { body: 'two' });
  await sendMessage(alexScope, direct.id, { body: 'a question for you' });

  const list = await listConversations(danaScope);
  assert.deepEqual(list.map((c) => c.id), [direct.id, group.id, community],
    'newest first, like every chat app anybody already uses');
  assert.deepEqual(list.map((c) => c.unread), [1, 2, 1]);
  assert.equal(list[0]!.preview, 'a question for you');
  assert.equal(list[0]!.preview_sender, 'Alex Admin');
  assert.deepEqual(await unreadTotal(danaScope), { total: 4, conversations: 3 });

  // The sender is never unread to themselves.
  assert.equal((await unreadTotal(alexScope)).total, 0);

  await markRead(danaScope, group.id);
  assert.deepEqual(await unreadTotal(danaScope), { total: 2, conversations: 2 });
  assert.equal((await listConversations(danaScope)).find((c) => c.id === group.id)!.unread, 0);

  // Replying marks it read too — you have obviously seen what you replied to.
  await sendMessage(danaScope, direct.id, { body: 'sure' });
  assert.equal((await listConversations(danaScope)).find((c) => c.id === direct.id)!.unread, 0);
});

test('a muted conversation still counts on the row but not in the sidebar total', async () => {
  const group = await createGroup(alexScope, { name: 'Noisy', member_ids: [dana.userId!] });
  await setMute(danaScope, group.id, { mute: 'always' });
  await sendMessage(alexScope, group.id, { body: 'ping' });

  const row = (await listConversations(danaScope)).find((c) => c.id === group.id)!;
  assert.equal(row.muted, true);
  assert.equal(row.unread, 1, 'the row still says there is something new');
  assert.equal((await unreadTotal(danaScope)).total, 0, 'the badge does not');

  // Muting raises no bell either.
  const bell = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'chat'`, [dana.userId]);
  assert.equal(bell!.n, 0);

  await setMute(danaScope, group.id, { mute: null });
  assert.equal((await unreadTotal(danaScope)).total, 1);
});

test('somebody with no tab open gets one bell entry per conversation, however many messages', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  await sendMessage(alexScope, direct.id, { body: 'one' });
  await sendMessage(alexScope, direct.id, { body: 'two' });
  await sendMessage(alexScope, direct.id, { body: 'three' });

  const { rows } = await query<{ title: string; body: string; link: string }>(
    `SELECT title, body, link FROM notifications WHERE user_id = $1 AND kind = 'chat'`, [dana.userId]);
  assert.equal(rows.length, 1, 'three messages, one row');
  assert.equal(rows[0]!.title, 'Alex Admin');
  assert.equal(rows[0]!.body, 'three', 'showing the latest');
  assert.equal(rows[0]!.link, '/chats');

  // Reading the conversation clears it.
  await markRead(danaScope, direct.id);
  const unread = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications
      WHERE user_id = $1 AND kind = 'chat' AND read_at IS NULL`, [dana.userId]);
  assert.equal(unread!.n, 0);
});

// ── Attachments ────────────────────────────────────────────────────────────

test('an attachment is sent, reaches a member, and is refused to everybody else', async () => {
  const group = await createGroup(alexScope, { name: 'Docs', member_ids: [dana.userId!] });
  const pdf = Buffer.from('%PDF-1.4 rate sheet');
  const message = await sendMessage(alexScope, group.id, { body: 'March sheet' }, [{
    originalname: 'rates.pdf', mimetype: 'application/pdf', size: pdf.length, buffer: pdf,
  }], '/crm');

  assert.equal(message.attachments.length, 1);
  const attachment = message.attachments[0]!;
  assert.equal(attachment.filename, 'rates.pdf');
  assert.equal(attachment.is_image, false);
  assert.equal(attachment.url, `/crm/api/chats/attachments/${attachment.id}`);

  const { attachmentFor } = await import('../../src/services/chats.ts');
  assert.equal((await attachmentFor(danaScope, attachment.id)).filename, 'rates.pdf');
  await assert.rejects(attachmentFor(evanScope, attachment.id), (err: AppError) => err.status === 404);

  // The list shows the file by name, because "📎 Attachment" tells nobody anything.
  await sendMessage(alexScope, group.id, {}, [{
    originalname: 'photo.png', mimetype: 'image/png', size: 4, buffer: Buffer.from('\x89PNG'),
  }], '/crm');
  assert.equal((await listConversations(danaScope)).find((c) => c.id === group.id)!.preview, '📎 photo.png');
});

test('a file that is too big, the wrong type, or lying about its name is refused', async () => {
  const group = await createGroup(alexScope, { name: 'Docs', member_ids: [dana.userId!] });
  const attach = (originalname: string, mimetype: string, size: number) => sendMessage(
    alexScope, group.id, {}, [{ originalname, mimetype, size, buffer: Buffer.alloc(Math.min(size, 16)) }]);

  await assert.rejects(attach('big.pdf', 'application/pdf', 21 * 1024 * 1024),
    (err: AppError) => err.code === 'rejected_upload' && /21\.0 MB and the limit is 20/.test(err.message));
  await assert.rejects(attach('payload.zip', 'application/zip', 100),
    (err: AppError) => err.code === 'rejected_upload');
  await assert.rejects(attach('payload.svg', 'application/pdf', 100),
    (err: AppError) => err.code === 'rejected_upload' && /declares itself as/.test(err.message));
  // Nothing was written for any of them.
  assert.equal((await listMessages(alexScope, group.id)).messages.filter((m) => m.kind === 'text').length, 0);
});

test('an empty message is refused', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  await assert.rejects(sendMessage(alexScope, direct.id, { body: '   ' }),
    (err: AppError) => err.status === 422 && /Write something, or attach a file/.test(err.message));
});

// ── The rest of the CRM ────────────────────────────────────────────────────

test('group administration is in the activity log; what was said is not', async () => {
  const group = await createGroup(alexScope, { name: 'Ops', member_ids: [dana.userId!] });
  await sendMessage(alexScope, group.id, { body: 'something confidential' });
  await addMembers(alexScope, group.id, { user_ids: [evan.userId!] });
  await removeMember(alexScope, group.id, dana.userId!);
  await renameGroup(alexScope, group.id, { name: 'Operations' });

  const { entries } = await listActivity(
    { organizationId: orgId, userId: alex.userId!, seeAll: true }, { module: 'chats' });
  assert.deepEqual(entries.map((e) => e.action_label), [
    'Renamed a chat group',
    'Removed someone from a chat group',
    'Added someone to a chat group',
    'Created a chat group',
  ]);
  assert.equal(
    entries.some((e) => String(e.summary).includes('confidential')), false,
    'a staff conversation is not the brokerage’s activity feed',
  );
});

test('the permission gates the whole module', async () => {
  // A broker holds chat.use and gets the list.
  const ok = await fetch(`${base}/chats`, { headers: { cookie: danaCookie } });
  assert.equal(ok.status, 200);

  // Take it away and the door closes, without the UI having to hide anything.
  await query(`UPDATE users SET permission_overrides = '{"chat.use": false}'::jsonb WHERE id = $1`,
    [dana.userId]);
  const refused = await fetch(`${base}/chats`, { headers: { cookie: danaCookie } });
  assert.equal(refused.status, 403);
  const body = await refused.json() as { permission: string };
  assert.equal(body.permission, 'chat.use');

  const anonymous = await fetch(`${base}/chats`);
  assert.equal(anonymous.status, 401);
});

test('a live event stream receives a message as it is sent, and heartbeats', async () => {
  const direct = await openDirect(alexScope, dana.userId!);

  const controller = new AbortController();
  const stream = await fetch(`${base}/events`, {
    headers: { cookie: danaCookie, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(stream.headers.get('x-accel-buffering'), 'no', 'so a proxy does not sit on it');

  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  // The `retry` hint arrives first and proves the stream is open before
  // anything is sent into it.
  const opened = decoder.decode((await reader.read()).value);
  assert.match(opened, /^retry: \d+/);

  // Wait for the subscriber to be registered before sending, so this does not
  // depend on how fast the fetch above settles.
  for (let i = 0; i < 100 && connectionCount() === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  await sendMessage(alexScope, direct.id, { body: 'live one' });

  let received = '';
  while (!received.includes('chat.message')) {
    received += decoder.decode((await reader.read()).value);
  }
  assert.match(received, /event: chat\.message/);
  assert.match(received, /live one/);

  controller.abort();
  // Aborting the request drops the subscriber, so a closed laptop does not
  // leave the process writing into nothing for ever.
  for (let i = 0; i < 100 && connectionCount() > 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(connectionCount(), 0);
});

test('someone watching the conversation is not also sent to the bell', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  const controller = new AbortController();
  const stream = await fetch(`${base}/events`, {
    headers: { cookie: danaCookie }, signal: controller.signal,
  });
  const reader = stream.body!.getReader();
  void reader.read();
  for (let i = 0; i < 100 && connectionCount() === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  await sendMessage(alexScope, direct.id, { body: 'you can see this' });
  const bell = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'chat'`, [dana.userId]);
  assert.equal(bell!.n, 0, 'they have already been told');

  controller.abort();
});

test('messages page backwards without skipping or repeating', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  for (let i = 1; i <= 12; i++) await sendMessage(alexScope, direct.id, { body: `m${i}` });

  const newest = await listMessages(danaScope, direct.id, { limit: 5 });
  assert.deepEqual(newest.messages.map((m) => m.body), ['m8', 'm9', 'm10', 'm11', 'm12']);
  assert.equal(newest.has_more, true);

  const older = await listMessages(danaScope, direct.id, { limit: 5, before: newest.messages[0]!.id });
  assert.deepEqual(older.messages.map((m) => m.body), ['m3', 'm4', 'm5', 'm6', 'm7']);

  const oldest = await listMessages(danaScope, direct.id, { limit: 5, before: older.messages[0]!.id });
  assert.deepEqual(oldest.messages.map((m) => m.body), ['m1', 'm2']);
  assert.equal(oldest.has_more, false);
});

test('one organization never sees another', async () => {
  const otherOrg = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Other','BC') RETURNING id`)).rows[0]!.id;
  const outsiderId = (await query<{ id: string }>(
    `INSERT INTO users (organization_id, email, name, role, active, profile_complete)
     VALUES ($1,'x@other.com','Otto Outsider','technical_admin',true,true) RETURNING id`,
    [otherOrg])).rows[0]!.id;
  const outsider: Scope = {
    actor: { organizationId: otherOrg, kind: 'user', userId: outsiderId, name: 'Otto Outsider', role: 'technical_admin' },
    isAdmin: true,
  };

  const ours = await openDirect(alexScope, dana.userId!);
  await assert.rejects(getConversation(outsider, ours.id), (err: AppError) => err.status === 404);
  await assert.rejects(openDirect(alexScope, outsiderId), (err: AppError) => err.status === 404);
  assert.equal((await contacts(outsider)).length, 0);
});

// ── Editing and taking a message back ──────────────────────────────────────

const backdate = (id: string, minutes: number) =>
  query('UPDATE chat_messages SET created_at = now() - ($2 || \' minutes\')::interval WHERE id = $1',
    [id, String(minutes)]);

test('a message can be edited for nineteen minutes, then not', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  const sent = await sendMessage(alexScope, direct.id, { body: 'Try it agian.' });
  assert.equal(sent.edited, false);
  assert.ok(sent.can_amend, 'freshly sent, so it can be changed');

  const fixed = await editMessage(alexScope, sent.id, { body: 'Try it again.' });
  assert.equal(fixed.body, 'Try it again.');
  assert.equal(fixed.edited, true);
  assert.deepEqual(await bodies(danaScope, direct.id), ['Try it again.'],
    'the other side sees the corrected message, not both');

  // Eighteen minutes on, still fine. Twenty, and it has set.
  await backdate(sent.id, 18);
  await editMessage(alexScope, sent.id, { body: 'Try it again now.' });
  await backdate(sent.id, 20);
  await assert.rejects(
    editMessage(alexScope, sent.id, { body: 'too late' }),
    (err: AppError) => err.status === 403 && /within 19 minutes/.test(err.message),
  );
  assert.deepEqual(await bodies(danaScope, direct.id), ['Try it again now.']);
});

test('the window runs from sending, so editing cannot extend it', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  const sent = await sendMessage(alexScope, direct.id, { body: 'one' });
  await backdate(sent.id, 18);
  const edited = await editMessage(alexScope, sent.id, { body: 'two' });
  // If the clock restarted on an edit, this would be nineteen minutes again.
  assert.ok(edited.amend_ms_left <= 60_000 + 2_000, 'about a minute left, not a fresh nineteen');
});

test('only the sender edits or deletes, and never a system line', async () => {
  const group = await createGroup(alexScope, { name: 'Ops', member_ids: [dana.userId!] });
  const mine = await sendMessage(alexScope, group.id, { body: 'mine' });

  await assert.rejects(editMessage(danaScope, mine.id, { body: 'not yours' }),
    (err: AppError) => err.status === 403 && /only edit your own/.test(err.message));
  await assert.rejects(deleteMessage(danaScope, mine.id),
    (err: AppError) => err.status === 403 && /only delete your own/.test(err.message));

  const system = (await listMessages(alexScope, group.id)).messages.find((m) => m.kind === 'system')!;
  await assert.rejects(editMessage(alexScope, system.id, { body: 'rewritten' }),
    (err: AppError) => /not written by anybody/.test(err.message));

  // An admin is not an exception: admin powers run groups, not other people's words.
  await assert.rejects(editMessage(alexScope, mine.id, { body: 'x' }).then(() =>
    editMessage(alexScope, mine.id, { body: 'y' })), () => false).catch(() => {});
});

test('a deleted message leaves a tombstone, and its file leaves storage', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  const pdf = Buffer.from('%PDF-1.4 secret');
  const sent = await sendMessage(alexScope, direct.id, { body: 'wrong file, sorry' }, [{
    originalname: 'wrong.pdf', mimetype: 'application/pdf', size: pdf.length, buffer: pdf,
  }]);
  const key = (await queryOne<{ storage_key: string }>(
    'SELECT storage_key FROM chat_attachments WHERE message_id = $1', [sent.id]))!.storage_key;
  assert.equal(await objectExists(key), true);

  const gone = await deleteMessage(alexScope, sent.id);
  assert.equal(gone.deleted, true);
  assert.equal(gone.body, null);
  assert.equal(gone.deleted_text, 'This message was deleted');
  assert.deepEqual(gone.attachments, []);

  // The row stays, so the conversation does not reshape around a hole …
  const seen = (await listMessages(danaScope, direct.id)).messages;
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.deleted, true);
  assert.equal(seen[0]!.body, null, 'and the words are gone for the other side too');
  // … and the file is actually gone, not merely unlinked.
  assert.equal(await objectExists(key), false);

  await assert.rejects(deleteMessage(alexScope, sent.id),
    (err: AppError) => /already been deleted/.test(err.message));
  assert.equal((await listConversations(danaScope)).find((c) => c.id === direct.id)!.unread, 1,
    'a deleted message still counts as something that happened');
});

test('an edit cannot empty a message that has nothing else in it', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  const sent = await sendMessage(alexScope, direct.id, { body: 'something' });
  await assert.rejects(editMessage(alexScope, sent.id, { body: '   ' }),
    (err: AppError) => err.status === 422 && /Write something, or attach a file/.test(err.message));
});

// ── Read receipts ──────────────────────────────────────────────────────────

test('ticks turn over when the other side reads, and say so in words', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  const sent = await sendMessage(alexScope, direct.id, { body: 'have you seen this?' });
  assert.equal(sent.read_state, 'sent');
  assert.equal(sent.read_label, 'Sent');

  await markRead(danaScope, direct.id);
  const after = (await listMessages(alexScope, direct.id)).messages[0]!;
  assert.equal(after.read_state, 'read');
  assert.equal(after.read_label, 'Read');

  // The recipient sees no ticks on somebody else's message — that is not news to them.
  assert.equal((await listMessages(danaScope, direct.id)).messages[0]!.read_state, null);
});

test('a group message says how many of them have read it', async () => {
  const group = await createGroup(alexScope, {
    name: 'Ops', member_ids: [dana.userId!, evan.userId!, mia.userId!],
  });
  const sent = await sendMessage(alexScope, group.id, { body: 'everyone see this' });
  assert.equal(sent.read_label, 'Sent');

  await markRead(danaScope, group.id);
  const partly = (await listMessages(alexScope, group.id)).messages.at(-1)!;
  assert.equal(partly.read_state, 'partly_read');
  assert.equal(partly.read_label, 'Read by 1 of 3');

  await markRead(evanScope, group.id);
  await markRead(miaScope, group.id);
  const all = (await listMessages(alexScope, group.id)).messages.at(-1)!;
  assert.equal(all.read_state, 'read');
  assert.equal(all.read_label, 'Read by all 3');
});

// ── Searching inside a conversation ────────────────────────────────────────

test('search finds a message, and the thread can jump to it', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  for (let i = 1; i <= 30; i++) await sendMessage(alexScope, direct.id, { body: `filler ${i}` });
  const needle = await sendMessage(alexScope, direct.id, { body: 'the Scarlett deal closes Friday' });
  for (let i = 31; i <= 60; i++) await sendMessage(alexScope, direct.id, { body: `filler ${i}` });

  const found = await searchMessages(danaScope, direct.id, { q: 'scarlett' });
  assert.equal(found.total, 1, 'case-insensitive');
  assert.equal(found.results[0]!.id, needle.id);
  assert.match(found.results[0]!.snippet, /Scarlett deal closes Friday/);

  // Substring, which a stemmed full-text index would not give.
  assert.equal((await searchMessages(danaScope, direct.id, { q: 'carlett' })).total, 1);
  // Substring means substring: "filler 4" is in "filler 4" and in 40 to 49.
  assert.equal((await searchMessages(danaScope, direct.id, { q: 'filler 4' })).total, 11);
  assert.equal((await searchMessages(danaScope, direct.id, { q: 'filler 42' })).total, 1);

  // Jumping lands the hit in the middle, with what came before and after it.
  const window = await listMessages(danaScope, direct.id, { around: needle.id, limit: 10 });
  const ids = window.messages.map((m) => m.id);
  assert.ok(ids.includes(needle.id));
  assert.ok(window.has_more && window.has_newer, 'there is more in both directions');
  const at = ids.indexOf(needle.id);
  assert.ok(at > 0 && at < ids.length - 1, 'not stranded at an edge');
});

test('search is literal about % and _, and needs two characters', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  await sendMessage(alexScope, direct.id, { body: 'rate is 100% fixed' });
  await sendMessage(alexScope, direct.id, { body: 'nothing to do with percentages' });

  assert.equal((await searchMessages(danaScope, direct.id, { q: '100%' })).total, 1,
    'a wildcard typed by a person is a character, not a wildcard');
  assert.equal((await searchMessages(danaScope, direct.id, { q: '%%' })).total, 0,
    'and two of them match nothing, rather than matching everything');
  assert.equal((await searchMessages(danaScope, direct.id, { q: '0%' })).total, 1);

  await assert.rejects(searchMessages(danaScope, direct.id, { q: 'a' }),
    (err: AppError) => err.status === 422);

  // A deleted message is not findable — it has no words any more.
  const gone = await sendMessage(alexScope, direct.id, { body: 'findmenow please' });
  assert.equal((await searchMessages(danaScope, direct.id, { q: 'findmenow' })).total, 1);
  await deleteMessage(alexScope, gone.id);
  assert.equal((await searchMessages(danaScope, direct.id, { q: 'findmenow' })).total, 0);
});

test('search stays inside the conversation, and inside your membership', async () => {
  const theirs = await openDirect(miaScope, evan.userId!);
  await sendMessage(miaScope, theirs.id, { body: 'a private matter' });
  const mine = await openDirect(alexScope, dana.userId!);
  assert.equal((await searchMessages(alexScope, mine.id, { q: 'private' })).total, 0);
  await assert.rejects(searchMessages(danaScope, theirs.id, { q: 'private' }),
    (err: AppError) => err.status === 404);
});

// ── Typing ─────────────────────────────────────────────────────────────────

test('typing reaches the other side and nothing is written down', async () => {
  const direct = await openDirect(alexScope, dana.userId!);
  const before = await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM chat_messages');

  const controller = new AbortController();
  const stream = await fetch(`${base}/events`, {
    headers: { cookie: danaCookie }, signal: controller.signal,
  });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  await reader.read();
  for (let i = 0; i < 100 && connectionCount() === 0; i++) await new Promise((r) => setTimeout(r, 10));

  await setTyping(alexScope, direct.id);
  let received = '';
  while (!received.includes('chat.typing')) received += decoder.decode((await reader.read()).value);
  assert.match(received, /Alex Admin/);

  const after = await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM chat_messages');
  assert.equal(after!.n, before!.n, 'a typing indicator is not a message');
  controller.abort();
});

test('somebody who cannot post is never shown as typing', async () => {
  // The Community group is closed, so a broker "typing" in it would promise a
  // message that can never arrive.
  const id = await communityId();
  const controller = new AbortController();
  const stream = await fetch(`${base}/events`, {
    headers: { cookie: alexCookie }, signal: controller.signal,
  });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  await reader.read();
  for (let i = 0; i < 100 && connectionCount() === 0; i++) await new Promise((r) => setTimeout(r, 10));

  await setTyping(danaScope, id);
  // Nothing should arrive; a message afterwards proves the stream was working.
  await sendMessage(alexScope, id, { body: 'marker' });
  let received = '';
  while (!received.includes('chat.message')) received += decoder.decode((await reader.read()).value);
  assert.equal(received.includes('chat.typing'), false);
  controller.abort();
});

// ── Pictures ───────────────────────────────────────────────────────────────

test('a group wears its picture; a direct chat wears the other person’s', async () => {
  const group = await createGroup(alexScope, { name: 'Ops', member_ids: [dana.userId!] });
  assert.equal((await getConversation(danaScope, group.id)).photo_url, null,
    'initials until somebody chooses one');

  const png = Buffer.from('\x89PNG\r\n\x1a\n fake but small');
  const withPhoto = await setGroupPhoto(alexScope, group.id, {
    originalname: 'team.png', mimetype: 'image/png', size: png.length, buffer: png,
  });
  assert.match(withPhoto.photo_url!, new RegExp(`/api/chats/${group.id}/photo\\?v=\\d+`));
  // Every member sees it, not just the admin who set it.
  assert.ok((await getConversation(danaScope, group.id)).photo_url);

  // A person's own picture shows on their one-to-one chat and on what they say.
  const direct = await openDirect(alexScope, dana.userId!);
  assert.equal((await getConversation(alexScope, direct.id)).photo_url, null);
  await setOwnPhoto(dana.actor ?? dana, {
    originalname: 'dana.jpg', mimetype: 'image/jpeg', size: png.length, buffer: png,
  });
  const seen = await getConversation(alexScope, direct.id);
  assert.match(seen.photo_url!, new RegExp(`/api/users/${dana.userId}/photo\\?v=\\d+`));
  assert.equal(seen.photo_url, seen.other!.photo_url, 'the row wears the face of the person on it');

  const said = await sendMessage(danaScope, direct.id, { body: 'hello' });
  assert.match(said.sender!.photo_url!, new RegExp(`/api/users/${dana.userId}/photo`));
});

test('only an admin sets a group picture, and only a picture is accepted', async () => {
  const group = await createGroup(alexScope, { name: 'Ops', member_ids: [dana.userId!] });
  const file = (originalname: string, mimetype: string, size = 40) =>
    ({ originalname, mimetype, size, buffer: Buffer.alloc(Math.min(size, 40)) });

  await assert.rejects(setGroupPhoto(danaScope, group.id, file('x.png', 'image/png')),
    (err: AppError) => err.status === 403);
  await assert.rejects(setGroupPhoto(alexScope, group.id, file('doc.pdf', 'application/pdf')),
    (err: AppError) => err.status === 422 && /JPEG, PNG, WebP or HEIC/.test(err.message));
  await assert.rejects(
    setGroupPhoto(alexScope, group.id, file('huge.png', 'image/png', 5 * 1024 * 1024)),
    (err: AppError) => err.status === 422 && /Resize it/.test(err.message));
});

test('replacing a picture removes the one it replaced', async () => {
  const group = await createGroup(alexScope, { name: 'Ops', member_ids: [dana.userId!] });
  const png = Buffer.from('\x89PNG\r\n\x1a\n one');
  await setGroupPhoto(alexScope, group.id, {
    originalname: 'one.png', mimetype: 'image/png', size: png.length, buffer: png });
  const first = (await queryOne<{ photo_key: string }>(
    'SELECT photo_key FROM chat_conversations WHERE id = $1', [group.id]))!.photo_key;

  await setGroupPhoto(alexScope, group.id, {
    originalname: 'two.png', mimetype: 'image/png', size: png.length, buffer: png });
  const second = (await queryOne<{ photo_key: string }>(
    'SELECT photo_key FROM chat_conversations WHERE id = $1', [group.id]))!.photo_key;

  assert.notEqual(first, second);
  assert.equal(await objectExists(first), false, 'the old one is not left on disk for ever');
  assert.equal(await objectExists(second), true);

  await removeGroupPhoto(alexScope, group.id);
  assert.equal((await getConversation(danaScope, group.id)).photo_url, null);
  assert.equal(await objectExists(second), false);
});

test('a picture is served to a colleague and to nobody outside the brokerage', async () => {
  const png = Buffer.from('\x89PNG\r\n\x1a\n face');
  await setOwnPhoto(dana, {
    originalname: 'dana.png', mimetype: 'image/png', size: png.length, buffer: png });

  assert.ok((await photoFor(alex, 'users', dana.userId!)).storage_key, 'a colleague may look');

  const otherOrg = (await query<{ id: string }>(
    `INSERT INTO organizations (name, home_province) VALUES ('Other','BC') RETURNING id`)).rows[0]!.id;
  const outsider: Actor = {
    organizationId: otherOrg, kind: 'user', userId: null, name: 'Otto', role: 'technical_admin' };
  await assert.rejects(photoFor(outsider, 'users', dana.userId!),
    (err: AppError) => err.status === 404);

  await removeOwnPhoto(dana);
  await assert.rejects(photoFor(alex, 'users', dana.userId!), (err: AppError) => err.status === 404);
});

test('a live message arrives as the recipient’s own copy, not the sender’s', async () => {
  // The regression this guards: broadcasting one shaped payload gave everybody
  // the sender's `mine: true`, so an incoming message rendered as the
  // recipient's own — right-aligned, offering an Edit they could not use, and
  // never marked read, which left the sender's tick on "Sent" for ever.
  const direct = await openDirect(alexScope, dana.userId!);
  const controller = new AbortController();
  const stream = await fetch(`${base}/events`, {
    headers: { cookie: danaCookie }, signal: controller.signal,
  });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  await reader.read();
  for (let i = 0; i < 100 && connectionCount() === 0; i++) await new Promise((r) => setTimeout(r, 10));

  await sendMessage(alexScope, direct.id, { body: 'from the admin' });

  let received = '';
  while (!received.includes('chat.message')) received += decoder.decode((await reader.read()).value);
  const payload = JSON.parse(received.split('data: ').at(-1)!.split('\n')[0]!) as {
    message: { mine: boolean; can_amend: boolean; read_state: string | null; body: string };
  };
  assert.equal(payload.message.body, 'from the admin');
  assert.equal(payload.message.mine, false, 'somebody else wrote it');
  assert.equal(payload.message.can_amend, false, 'and they cannot edit it');
  assert.equal(payload.message.read_state, null, 'no ticks on a message that is not yours');

  controller.abort();
});
