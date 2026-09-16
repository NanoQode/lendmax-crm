/**
 * Google Calendar — each staff member's own calendar.
 *
 * A person connects once (OAuth, offline access). From then on:
 *   · every appointment they host is an event in their calendar, with the
 *     client invited and, for video calls, a Meet link;
 *   · their busy times are checked before anything is booked for them;
 *   · a meeting moved or deleted in Google is moved or cancelled here
 *     (services/appointments.ts applies what `changesFor` finds).
 *
 * Tokens are encrypted with CREDENTIALS_KEY. A refresh token Google stops
 * accepting marks the connection as needing a reconnect rather than failing
 * every booking quietly.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { env } from '../config/env.ts';
import { query, queryOne } from '../db/pool.ts';
import {
  calendarDriver, GoogleError, type BusyBlock, type CalendarEvent, type EventInput, type OAuthClient,
} from '../integrations/google-calendar.ts';
import { AppError } from '../http/middleware/errors.ts';
import { decryptSecrets, encryptSecrets, safeEqual } from '../lib/secrets.ts';
import { log } from '../lib/logger.ts';
import { recordAudit } from './audit.ts';
import { resolveIntegration } from './integrations.ts';

type Account = {
  user_id: string; organization_id: string; google_email: string; calendar_id: string; mode: string;
  tokens: Buffer; token_expires_at: Date | null; connected_at: Date; last_synced_at: Date | null;
  last_error: string | null; last_error_at: Date | null;
};

export type GoogleStatus = {
  mode: 'live' | 'sandbox';
  /** Whether a person can connect at all: the OAuth client is set up, or this is the sandbox. */
  available: boolean;
  unavailable_reason: string | null;
  connected: null | {
    email: string; connected_at: string; last_synced_at: string | null;
    needs_reconnect: boolean; last_error: string | null;
  };
};

async function oauthClient(organizationId: string): Promise<OAuthClient | null> {
  const google = await resolveIntegration(organizationId, 'google');
  const v = google.values;
  if (!v.client_id || !v.client_secret || !v.redirect_uri) return null;
  return { clientId: String(v.client_id), clientSecret: String(v.client_secret), redirectUri: String(v.redirect_uri) };
}

async function account(userId: string | null | undefined): Promise<Account | null> {
  if (!userId) return null;
  return queryOne<Account>('SELECT * FROM google_calendar_accounts WHERE user_id = $1', [userId]);
}

const needsReconnect = (a: Account) => !!a.last_error?.startsWith('reconnect:');

export async function googleStatus(organizationId: string, userId: string): Promise<GoogleStatus> {
  const driver = calendarDriver();
  const client = driver.mode === 'live' ? await oauthClient(organizationId) : null;
  const available = driver.mode === 'sandbox' || !!client;
  const a = await account(userId);
  return {
    mode: driver.mode,
    available,
    unavailable_reason: available ? null
      : 'Google Calendar is not set up yet. An admin adds the Google OAuth client under Integrations → Google Calendar.',
    connected: a ? {
      email: a.google_email,
      connected_at: a.connected_at.toISOString(),
      last_synced_at: a.last_synced_at?.toISOString() ?? null,
      needs_reconnect: needsReconnect(a),
      last_error: a.last_error?.replace(/^reconnect:\s*/, '') ?? null,
    } : null,
  };
}

/** Which of these people have a working connection. */
export async function connectedUsers(userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const { rows } = await query<{ user_id: string }>(
    `SELECT user_id FROM google_calendar_accounts
      WHERE user_id = ANY($1::uuid[]) AND (last_error IS NULL OR last_error NOT LIKE 'reconnect:%')`,
    [userIds]);
  return new Set(rows.map((r) => r.user_id));
}

// ── Connecting ─────────────────────────────────────────────────────────────

/** The OAuth state: who asked, and until when. Signed, so a callback cannot be replayed for somebody else. */
function signState(userId: string): string {
  const body = `${userId}.${Date.now() + 10 * 60_000}.${randomBytes(8).toString('hex')}`;
  const mac = createHmac('sha256', env.SESSION_SECRET).update(`google-calendar:${body}`).digest('base64url');
  return `${body}.${mac}`;
}

function readState(state: string): string | null {
  const parts = state.split('.');
  if (parts.length !== 4) return null;
  const [userId, expires, nonce, mac] = parts as [string, string, string, string];
  const expected = createHmac('sha256', env.SESSION_SECRET)
    .update(`google-calendar:${userId}.${expires}.${nonce}`).digest('base64url');
  if (!safeEqual(mac, expected) || Number(expires) < Date.now()) return null;
  return userId;
}

export async function connectUrl(organizationId: string, userId: string): Promise<string> {
  const driver = calendarDriver();
  const client = driver.mode === 'live' ? await oauthClient(organizationId) : null;
  try {
    return driver.authUrl(client, signState(userId));
  } catch (err) {
    throw new AppError((err as Error).message, 409, 'google_not_configured');
  }
}

export async function finishConnect(
  user: { id: string; organization_id: string; name: string; email: string; role: string },
  code: string, state: string, ip?: string | null,
): Promise<{ email: string }> {
  const who = readState(state);
  if (!who || who !== user.id) {
    throw new AppError('That Google sign-in link has expired or was meant for somebody else. Try connecting again.', 400, 'bad_state');
  }
  const driver = calendarDriver();
  const client = driver.mode === 'live' ? await oauthClient(user.organization_id) : null;
  const tokens = await driver.exchangeCode(client, code, { email: user.email });
  await query(
    `INSERT INTO google_calendar_accounts (user_id, organization_id, google_email, mode, tokens,
                                           token_expires_at, scopes, connected_at, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
     ON CONFLICT (user_id) DO UPDATE SET
       google_email = EXCLUDED.google_email, mode = EXCLUDED.mode, tokens = EXCLUDED.tokens,
       token_expires_at = EXCLUDED.token_expires_at, scopes = EXCLUDED.scopes,
       connected_at = now(), last_synced_at = now(), last_error = NULL, last_error_at = NULL`,
    [user.id, user.organization_id, tokens.email, driver.mode,
     encryptSecrets({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken ?? '' }),
     tokens.expiresAt, tokens.scopes ?? null]);
  await recordAudit({
    organizationId: user.organization_id,
    actor: { userId: user.id, name: user.name, role: user.role, kind: 'user', ip },
    action: 'appointment.google_connected',
    entityType: 'user',
    entityId: user.id,
    summary: `${user.name} connected Google Calendar (${tokens.email})${driver.mode === 'sandbox' ? ' — test mode' : ''}`,
  });
  return { email: tokens.email };
}

export async function disconnect(
  user: { id: string; organization_id: string; name: string; role: string }, ip?: string | null,
): Promise<void> {
  const a = await account(user.id);
  if (!a) return;
  try {
    const { refresh_token: refresh } = decryptSecrets(a.tokens);
    if (refresh) await calendarDriver().revoke(refresh);
  } catch { /* disconnecting must work even if the tokens are unreadable */ }
  await query('DELETE FROM google_calendar_accounts WHERE user_id = $1', [user.id]);
  await recordAudit({
    organizationId: user.organization_id,
    actor: { userId: user.id, name: user.name, role: user.role, kind: 'user', ip },
    action: 'appointment.google_disconnected',
    entityType: 'user',
    entityId: user.id,
    summary: `${user.name} disconnected Google Calendar (${a.google_email})`,
  });
}

// ── Tokens ─────────────────────────────────────────────────────────────────

async function markError(userId: string, message: string, reconnect: boolean): Promise<void> {
  await query(
    `UPDATE google_calendar_accounts SET last_error = $2, last_error_at = now() WHERE user_id = $1`,
    [userId, reconnect ? `reconnect: ${message}` : message]);
}

/** A usable access token for this person, refreshed when it is about to expire. */
async function tokenFor(a: Account): Promise<string> {
  if (needsReconnect(a)) {
    throw new GoogleError(`${a.google_email} needs to be reconnected to Google Calendar.`, 401, true);
  }
  const secrets = decryptSecrets(a.tokens);
  if (a.token_expires_at && a.token_expires_at.getTime() - Date.now() > 60_000 && secrets.access_token) {
    return secrets.access_token;
  }
  const driver = calendarDriver();
  const client = driver.mode === 'live' ? await oauthClient(a.organization_id) : null;
  try {
    const fresh = await driver.refresh(client, secrets.refresh_token ?? '');
    await query(
      `UPDATE google_calendar_accounts SET tokens = $2, token_expires_at = $3 WHERE user_id = $1`,
      [a.user_id, encryptSecrets({ access_token: fresh.accessToken, refresh_token: secrets.refresh_token ?? '' }),
       fresh.expiresAt]);
    return fresh.accessToken;
  } catch (err) {
    if (err instanceof GoogleError && err.reconnect) await markError(a.user_id, err.message, true);
    throw err;
  }
}

// ── Events ─────────────────────────────────────────────────────────────────

export type PushTarget = {
  id: string; organization_id: string; status: string; user_id: string | null;
  google_event_id: string | null; google_owner_id: string | null; google_calendar_id: string | null;
  meeting_url: string | null; mode: string;
};

export type PushResult = { synced: boolean; error: string | null; meetUrl: string | null };

/**
 * Make Google match the appointment: create, move, hand to another host's
 * calendar, or cancel. Records the outcome on the appointment either way.
 */
export async function pushAppointment(target: PushTarget, input: EventInput | null): Promise<PushResult> {
  const driver = calendarDriver();
  const open = target.status === 'booked' || target.status === 'confirmed';
  try {
    const host = await account(target.user_id);
    // An event in somebody else's calendar (the host changed, or it was
    // cancelled) comes out of that calendar first.
    if (target.google_event_id && target.google_owner_id
        && (!open || !host || target.google_owner_id !== target.user_id)) {
      const previous = await account(target.google_owner_id);
      if (previous) {
        await driver.cancelEvent(await tokenFor(previous), target.google_calendar_id ?? previous.calendar_id, target.google_event_id);
      }
      await query(
        `UPDATE appointments SET google_event_id = CASE WHEN $2 THEN NULL ELSE google_event_id END,
                                 google_owner_id = CASE WHEN $2 THEN NULL ELSE google_owner_id END,
                                 google_synced_at = now(), google_sync_error = NULL
          WHERE id = $1`, [target.id, open]);
      if (!open || !host) return { synced: !open, error: null, meetUrl: null };
      target = { ...target, google_event_id: null, google_owner_id: null };
    }
    if (!open) return { synced: false, error: null, meetUrl: null };
    if (!host || !input) return { synced: false, error: null, meetUrl: null };

    const token = await tokenFor(host);
    let event: CalendarEvent;
    try {
      event = target.google_event_id
        ? await driver.updateEvent(token, host.calendar_id, target.google_event_id, input)
        : await driver.createEvent(token, host.calendar_id, input);
    } catch (err) {
      // Deleted in Google behind our back: book it again rather than fail forever.
      if (err instanceof GoogleError && (err.status === 404 || err.status === 410) && target.google_event_id) {
        event = await driver.createEvent(token, host.calendar_id, input);
      } else throw err;
    }
    // A Meet link Google made replaces an earlier Meet link, never one a person typed.
    const ownLink = target.meeting_url && !target.meeting_url.startsWith('https://meet.google.com/');
    const meetUrl = target.mode === 'video' && !ownLink ? event.meetUrl : null;
    await query(
      `UPDATE appointments SET google_event_id = $2, google_calendar_id = $3, google_owner_id = $4,
                               google_html_link = $5, google_synced_at = now(), google_sync_error = NULL,
                               meeting_url = COALESCE($6, meeting_url)
        WHERE id = $1`,
      [target.id, event.id, host.calendar_id, host.user_id, event.htmlLink, meetUrl]);
    return { synced: true, error: null, meetUrl: meetUrl ?? target.meeting_url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query('UPDATE appointments SET google_sync_error = $2 WHERE id = $1', [target.id, message]);
    log.warn('google calendar push failed', { appointmentId: target.id, error: message });
    return { synced: false, error: message, meetUrl: null };
  }
}

/** Busy times in this person's Google Calendar, or null when they have none connected or Google is unreachable. */
export async function busyFor(userId: string, from: Date, to: Date): Promise<BusyBlock[] | null> {
  const a = await account(userId);
  if (!a) return null;
  try {
    return await calendarDriver().busy(await tokenFor(a), a.calendar_id, from, to);
  } catch (err) {
    log.warn('google busy lookup failed', { userId, error: (err as Error).message });
    return null;
  }
}

/**
 * What changed in this person's calendar since the last look, and a function
 * to call once it has been applied. Overlaps the last window by two minutes
 * so an edit made during the previous sync is not missed.
 */
export async function changesFor(userId: string): Promise<{ events: CalendarEvent[]; commit: () => Promise<void> } | null> {
  const a = await account(userId);
  if (!a || needsReconnect(a)) return null;
  const startedAt = new Date();
  const since = new Date((a.last_synced_at ?? new Date(Date.now() - 86_400_000)).getTime() - 2 * 60_000);
  try {
    const events = await calendarDriver().changedSince(await tokenFor(a), a.calendar_id, since);
    return {
      events,
      commit: async () => {
        await query(
          `UPDATE google_calendar_accounts SET last_synced_at = $2, last_error = NULL, last_error_at = NULL
            WHERE user_id = $1`, [userId, startedAt]);
      },
    };
  } catch (err) {
    if (!(err instanceof GoogleError && err.reconnect)) await markError(userId, (err as Error).message, false);
    throw err;
  }
}

export async function connectedAccounts(): Promise<Array<{ user_id: string; organization_id: string; name: string }>> {
  const { rows } = await query<{ user_id: string; organization_id: string; name: string }>(
    `SELECT g.user_id, g.organization_id, u.name FROM google_calendar_accounts g JOIN users u ON u.id = g.user_id
      WHERE (g.last_error IS NULL OR g.last_error NOT LIKE 'reconnect:%') AND u.archived_at IS NULL`);
  return rows;
}
