/**
 * LM Chats — the rules, with no database in sight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amendRefusal, ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, canOpenDirect, canPost, checkAttachment,
  checkPhoto, deleteRefusal, directKey, EDIT_WINDOW_MINUTES, editWindowClosesAt, editWindowRemaining,
  formatBytes, groupNameRefusal, isImage, leaveRefusal, manageRefusal, MAX_BODY_LENGTH,
  MUTE_FOREVER, messageRefusal, muteUntil, isMuted, PHOTO_ACCEPT, PHOTO_MAX_BYTES, postRefusal,
  previewOf, readLabel, readState, searchRefusal, snippetAround, titleFor, TYPING_EXPIRY_MS,
  TYPING_PING_MS, typingLabel,
} from '../src/domain/chats.ts';

const admin = { id: 'a', isAdmin: true };
const other = { id: 'b', isAdmin: true };
const broker = { id: 'c', isAdmin: false };
const broker2 = { id: 'd', isAdmin: false };

// ── Who may talk to whom ───────────────────────────────────────────────────

test('a one-to-one chat needs an admin on one side of it', () => {
  assert.equal(canOpenDirect(broker, admin), true);
  assert.equal(canOpenDirect(admin, broker), true);
  assert.equal(canOpenDirect(admin, other), true, 'two admins may talk');
  assert.match(canOpenDirect(broker, broker2) as string, /Staff message the admin/);
  assert.match(canOpenDirect(broker, broker) as string, /with yourself/);
});

test('a pair has one key, whichever way round it is asked', () => {
  const a = '9f1c0000-0000-0000-0000-000000000001';
  const b = '0a2b0000-0000-0000-0000-000000000002';
  assert.equal(directKey(a, b), directKey(b, a));
  assert.equal(directKey(a, b), `${b}:${a}`, 'sorted, so the key is the pair and not the order');
});

// ── Posting ────────────────────────────────────────────────────────────────

const member = { is_member: true, is_admin: false };
const adminMember = { is_member: true, is_admin: true };

test('the Community group is closed until an admin opens it', () => {
  const closed = { kind: 'community' as const, everyone_can_post: false };
  assert.match(postRefusal(closed, member)!, /Only an admin posts/);
  assert.equal(canPost(closed, adminMember), true);

  const opened = { kind: 'community' as const, everyone_can_post: true };
  assert.equal(canPost(opened, member), true);
});

test('a group is open to its members, and an admin can close it', () => {
  assert.equal(canPost({ kind: 'group', everyone_can_post: true }, member), true);
  assert.match(postRefusal({ kind: 'group', everyone_can_post: false }, member)!, /Only an admin posts/);
  assert.equal(canPost({ kind: 'group', everyone_can_post: false }, adminMember), true);
});

test('somebody who is not in a conversation cannot post to it, admin or not', () => {
  const outsider = { is_member: false, is_admin: true };
  assert.match(postRefusal({ kind: 'group', everyone_can_post: true }, outsider)!, /not in this conversation/);
});

test('a direct chat is open to both of its people', () => {
  // `everyone_can_post` is false on nothing that is direct, but the rule must
  // not depend on that: a one-to-one chat is two people talking.
  assert.equal(canPost({ kind: 'direct', everyone_can_post: false }, member), true);
});

// ── Leaving, managing, deleting ────────────────────────────────────────────

test('nobody leaves the Community group, and nobody deletes it', () => {
  const community = { kind: 'community' as const, everyone_can_post: false };
  assert.match(leaveRefusal(community, member)!, /Nobody leaves the Community group/);
  assert.match(leaveRefusal(community, adminMember)!, /Nobody leaves/, 'not even an admin');
  assert.match(deleteRefusal(community, adminMember)!, /cannot be deleted. Rename it instead/);
  assert.equal(manageRefusal(community, adminMember), null, 'but an admin still runs it');
});

test('a group can be left and, by an admin, removed', () => {
  const group = { kind: 'group' as const, everyone_can_post: true };
  assert.equal(leaveRefusal(group, member), null);
  assert.match(manageRefusal(group, member)!, /Only an admin manages groups/);
  assert.equal(deleteRefusal(group, adminMember), null);
});

test('a one-to-one chat is muted rather than left, and has nothing to manage', () => {
  const direct = { kind: 'direct' as const, everyone_can_post: true };
  assert.match(leaveRefusal(direct, member)!, /Mute it instead/);
  assert.match(manageRefusal(direct, adminMember)!, /no members to manage/);
});

// ── Muting ─────────────────────────────────────────────────────────────────

test('muting runs out on its own, except when it does not', () => {
  const now = new Date('2026-09-16T12:00:00Z');
  assert.equal(muteUntil('8h', now).toISOString(), '2026-09-16T20:00:00.000Z');
  assert.equal(muteUntil('1w', now).toISOString(), '2026-09-23T12:00:00.000Z');
  assert.equal(muteUntil('always', now).getTime(), MUTE_FOREVER.getTime());

  assert.equal(isMuted(muteUntil('8h', now), now), true);
  assert.equal(isMuted(muteUntil('8h', now), new Date('2026-09-17T12:00:00Z')), false);
  assert.equal(isMuted(null, now), false);
});

// ── Attachments ────────────────────────────────────────────────────────────

test('20 MB, and a type whose name agrees with what it claims to be', () => {
  assert.equal(ATTACHMENT_MAX_BYTES, 20 * 1024 * 1024);
  assert.deepEqual(checkAttachment('rates.pdf', 'application/pdf', 1024), { ok: true, extension: '.pdf' });
  assert.deepEqual(checkAttachment('book.XLSX',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 1024),
    { ok: true, extension: '.xlsx' }, 'the extension is compared in lower case');

  const big = checkAttachment('scan.pdf', 'application/pdf', 21 * 1024 * 1024);
  assert.equal(big.ok, false);
  assert.match((big as { reason: string }).reason, /21\.0 MB and the limit is 20 MB/);

  assert.equal(checkAttachment('empty.pdf', 'application/pdf', 0).ok, false);
});

test('an archive is not something staff pass to each other here', () => {
  const zip = checkAttachment('bundle.zip', 'application/zip', 1024);
  assert.equal(zip.ok, false);
  assert.match((zip as { reason: string }).reason, /cannot be sent in a chat/);
});

test('a file whose name disagrees with its type is refused, not renamed', () => {
  // The case that matters: an SVG is a script that runs if it is ever served
  // inline, and a browser will declare it as anything.
  const lying = checkAttachment('logo.svg', 'image/png', 1024);
  assert.equal(lying.ok, false);
  assert.match((lying as { reason: string }).reason, /named ".svg" but declares itself as image\/png/);
});

test('the file picker offers exactly what the checker accepts', () => {
  for (const extension of ATTACHMENT_ACCEPT.split(',')) {
    assert.match(extension, /^\.[a-z0-9]+$/, `"${extension}" is not an extension`);
  }
  assert.ok(ATTACHMENT_ACCEPT.includes('.xlsx'));
  assert.ok(ATTACHMENT_ACCEPT.includes('.pdf'));
  assert.equal(ATTACHMENT_ACCEPT.includes('.zip'), false);
});

test('images are recognised, sizes are readable', () => {
  assert.equal(isImage('image/jpeg'), true);
  assert.equal(isImage('application/pdf'), false);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(2_516_582), '2.4 MB');
});

// ── What the list shows ────────────────────────────────────────────────────

test('the preview says what the message was, or names the file', () => {
  assert.equal(previewOf(null), 'No messages yet');
  assert.equal(previewOf({ body: '  hello\n  there ' }), 'hello there');
  assert.equal(previewOf({ body: null, attachment_name: 'rates.pdf' }), '📎 rates.pdf');
  assert.equal(previewOf({ body: '', attachment_count: 3 }), '📎 3 files');

  const long = previewOf({ body: 'x'.repeat(500) });
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});

test('a direct chat is named by the other person, a group by its name', () => {
  assert.equal(titleFor({ kind: 'direct', name: null }, [{ name: 'Alex Admin' }]), 'Alex Admin');
  assert.equal(titleFor({ kind: 'group', name: 'Renewals' }, []), 'Renewals');
  assert.equal(titleFor({ kind: 'community', name: 'Community' }, []), 'Community');
});

// ── Validation ─────────────────────────────────────────────────────────────

test('a message must say something or carry something', () => {
  assert.match(messageRefusal('   ', 0)!, /Write something, or attach a file/);
  assert.equal(messageRefusal('', 1), null, 'a file on its own is a message');
  assert.equal(messageRefusal('hello', 0), null);
  assert.match(messageRefusal('x'.repeat(MAX_BODY_LENGTH + 1), 0)!, /the limit is 4000/);
});

test('a group needs a name that fits', () => {
  assert.match(groupNameRefusal('  ')!, /needs a name/);
  assert.match(groupNameRefusal('x'.repeat(61))!, /at most 60 characters/);
  assert.equal(groupNameRefusal('  Renewals push  '), null);
});

// ── Editing and taking back ────────────────────────────────────────────────

const minutes = (n: number) => n * 60_000;
const sentAt = (ago: number, sender = 'c') => ({
  sender_id: sender, created_at: new Date(NOW.getTime() - ago), kind: 'text',
});
const NOW = new Date('2026-09-16T12:00:00Z');

test('nineteen minutes, and only your own', () => {
  assert.equal(EDIT_WINDOW_MINUTES, 19);
  assert.equal(amendRefusal(sentAt(minutes(18)), 'c', NOW, 'edit'), null);
  assert.equal(amendRefusal(sentAt(minutes(18.9)), 'c', NOW, 'delete'), null);

  assert.match(amendRefusal(sentAt(minutes(19.1)), 'c', NOW, 'edit')!,
    /only be edited within 19 minutes/);
  assert.match(amendRefusal(sentAt(minutes(19.1)), 'c', NOW, 'delete')!,
    /only be deleted within 19 minutes/);
  assert.match(amendRefusal(sentAt(minutes(1)), 'someone-else', NOW, 'edit')!,
    /only edit your own messages/);
});

test('the window runs from when it was sent, not from the last edit', () => {
  // Otherwise editing every eighteen minutes would keep a message editable for
  // ever, and "fix a typo" would quietly become "rewrite history".
  const message = sentAt(minutes(18));
  assert.equal(editWindowRemaining(message, NOW), minutes(1));
  assert.equal(editWindowClosesAt(message).toISOString(), '2026-09-16T12:01:00.000Z');
  assert.equal(editWindowRemaining(sentAt(minutes(40)), NOW), 0, 'never negative');
});

test('a deleted message cannot be edited, and a system line belongs to nobody', () => {
  assert.match(
    amendRefusal({ ...sentAt(minutes(1)), deleted_at: new Date() }, 'c', NOW, 'edit')!,
    /already been deleted/);
  assert.match(
    amendRefusal({ sender_id: null, created_at: NOW, kind: 'system' }, 'c', NOW, 'edit')!,
    /not written by anybody/);
});

// ── Read receipts ──────────────────────────────────────────────────────────

test('read is the same fact the unread badge is built on', () => {
  const message = { created_at: new Date('2026-09-16T10:00:00Z'), sender_id: 'me' };
  const before = new Date('2026-09-16T09:00:00Z');
  const after = new Date('2026-09-16T11:00:00Z');

  assert.deepEqual(readState(message, [before, null]), { state: 'sent', read_by: 0, of: 2 });
  assert.deepEqual(readState(message, [after, before]), { state: 'partly_read', read_by: 1, of: 2 });
  assert.deepEqual(readState(message, [after, after]), { state: 'read', read_by: 2, of: 2 });
  // Reading at exactly the moment it arrived counts as having read it.
  assert.equal(readState(message, [message.created_at]).state, 'read');
  // A conversation with nobody else in it is not "read by all zero of them".
  assert.equal(readState(message, []).state, 'sent');
});

test('a tick always has words beside it', () => {
  assert.equal(readLabel({ state: 'sent', read_by: 0, of: 3 }, true), 'Sent');
  assert.equal(readLabel({ state: 'read', read_by: 1, of: 1 }, false), 'Read');
  assert.equal(readLabel({ state: 'read', read_by: 8, of: 8 }, true), 'Read by all 8');
  assert.equal(readLabel({ state: 'partly_read', read_by: 3, of: 8 }, true), 'Read by 3 of 8');
});

// ── Typing ─────────────────────────────────────────────────────────────────

test('who is typing reads as a sentence', () => {
  assert.equal(typingLabel([]), '');
  assert.equal(typingLabel(['Dana Broker']), 'Dana is typing…');
  assert.equal(typingLabel(['Dana Broker', 'Evan Broker']), 'Dana and Evan are typing…');
  assert.equal(typingLabel(['Dana B', 'Evan B', 'Mia M']), '3 people are typing…');
});

test('the ping is more frequent than the expiry, or the indicator would flicker', () => {
  assert.ok(TYPING_PING_MS < TYPING_EXPIRY_MS);
});

// ── Searching inside a conversation ────────────────────────────────────────

test('search needs something to go on', () => {
  assert.match(searchRefusal(' a ')!, /at least 2 characters/);
  assert.equal(searchRefusal('scarlett'), null);
});

test('a result shows the hit, not the first forty characters', () => {
  const body = `${'x'.repeat(200)} the Scarlett deal ${'y'.repeat(200)}`;
  const snippet = snippetAround(body, 'scarlett');
  assert.ok(snippet.includes('Scarlett'), 'the match survives');
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'), 'and is shown as an extract');
  assert.ok(snippet.length < 120);

  assert.equal(snippetAround('  short   one  ', 'short'), 'short   one'.replace(/\s+/g, ' '));
});

// ── Pictures ───────────────────────────────────────────────────────────────

test('a picture is an image, and small enough to put in a list', () => {
  assert.deepEqual(checkPhoto('face.jpg', 'image/jpeg', 200_000), { ok: true, extension: '.jpg' });
  assert.equal(checkPhoto('face.png', 'image/png', PHOTO_MAX_BYTES + 1).ok, false);

  const pdf = checkPhoto('face.pdf', 'application/pdf', 1000);
  assert.equal(pdf.ok, false);
  assert.match((pdf as { reason: string }).reason, /JPEG, PNG, WebP or HEIC/);

  // Animated avatars in a list of forty are a distraction.
  assert.equal(checkPhoto('spin.gif', 'image/gif', 1000).ok, false);
  // And the name must still agree with the type.
  assert.equal(checkPhoto('face.png', 'image/jpeg', 1000).ok, false);
  for (const extension of PHOTO_ACCEPT.split(',')) assert.match(extension, /^\.[a-z]+$/);
});
