/**
 * Google Calendar — the wire.
 *
 * Two drivers behind one shape:
 *
 *   · live — Google's OAuth and Calendar v3 REST API, with the brokerage's
 *     own Google Cloud OAuth client (Integrations → Google Calendar).
 *   · sandbox — an in-memory stand-in with the same behaviour: events, Meet
 *     links, cancellations, busy times. It is what dev and the tests use, so
 *     booking and two-way sync can be exercised without a Google account.
 *     Nothing leaves the machine.
 *
 * GOOGLE_CALENDAR_MODE picks one; it is live in production. Which calendar an
 * event lands in, and what the CRM does when Google changes, is the service's
 * business (services/google-calendar.ts), not this file's.
 */
import { randomBytes } from 'node:crypto';
import { env } from '../config/env.ts';

export const SCOPES = [
  'openid', 'email',
  // Create, move and cancel the events the CRM books.
  'https://www.googleapis.com/auth/calendar.events',
  // Read busy times, so a booking does not land on somebody's dentist.
  'https://www.googleapis.com/auth/calendar.readonly',
];

export type OAuthClient = { clientId: string; clientSecret: string; redirectUri: string };

export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: Date; email?: string; scopes?: string };

export type EventInput = {
  appointmentId: string;
  summary: string;
  description: string;
  location?: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  attendees: Array<{ email: string; name?: string | null }>;
  /** Ask Google for a Meet link. */
  meet: boolean;
};

export type CalendarEvent = {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  startsAt: Date | null;
  endsAt: Date | null;
  meetUrl: string | null;
  htmlLink: string | null;
  appointmentId: string | null;
};

export type BusyBlock = { start: Date; end: Date };

export class GoogleError extends Error {
  readonly status: number;
  /** Refresh token revoked or expired: only reconnecting fixes it. */
  readonly reconnect: boolean;
  constructor(message: string, status = 0, reconnect = false) {
    super(message);
    this.status = status;
    this.reconnect = reconnect;
  }
}

export interface CalendarDriver {
  readonly mode: 'live' | 'sandbox';
  authUrl(client: OAuthClient | null, state: string): string;
  exchangeCode(client: OAuthClient | null, code: string, hint: { email: string }): Promise<Tokens & { email: string }>;
  refresh(client: OAuthClient | null, refreshToken: string): Promise<Tokens>;
  revoke(token: string): Promise<void>;
  createEvent(token: string, calendarId: string, input: EventInput): Promise<CalendarEvent>;
  updateEvent(token: string, calendarId: string, eventId: string, input: EventInput): Promise<CalendarEvent>;
  cancelEvent(token: string, calendarId: string, eventId: string): Promise<void>;
  /** Events changed since `since`, cancelled ones included. */
  changedSince(token: string, calendarId: string, since: Date): Promise<CalendarEvent[]>;
  busy(token: string, calendarId: string, from: Date, to: Date): Promise<BusyBlock[]>;
}

// ── Live ───────────────────────────────────────────────────────────────────

const API = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 10_000;

async function call<T>(url: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const response = await fetch(url, { ...init, headers, signal: controller.signal });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok) {
      const error = body.error as { message?: string } | string | undefined;
      const message = typeof error === 'string'
        ? `${error}${body.error_description ? `: ${String(body.error_description)}` : ''}`
        : error?.message ?? `Google answered ${response.status}.`;
      throw new GoogleError(message, response.status, error === 'invalid_grant' || response.status === 401 && !init.token);
    }
    return body as T;
  } catch (err) {
    if (err instanceof GoogleError) throw err;
    throw new GoogleError(err instanceof Error && err.name === 'AbortError'
      ? 'Google Calendar did not answer in time.' : `Could not reach Google Calendar: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

type GoogleEventBody = {
  id: string; status?: string; htmlLink?: string; hangoutLink?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  extendedProperties?: { private?: Record<string, string> };
};

function fromGoogle(e: GoogleEventBody): CalendarEvent {
  const video = e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? null;
  const at = (v?: { dateTime?: string; date?: string }) => (v?.dateTime ? new Date(v.dateTime) : v?.date ? new Date(v.date) : null);
  return {
    id: e.id,
    status: (e.status as CalendarEvent['status']) ?? 'confirmed',
    startsAt: at(e.start),
    endsAt: at(e.end),
    meetUrl: video,
    htmlLink: e.htmlLink ?? null,
    appointmentId: e.extendedProperties?.private?.lendmaxAppointmentId ?? null,
  };
}

function toGoogle(input: EventInput, withConference: boolean) {
  return {
    summary: input.summary,
    description: input.description,
    location: input.location ?? undefined,
    start: { dateTime: input.startsAt.toISOString(), timeZone: input.timezone },
    end: { dateTime: input.endsAt.toISOString(), timeZone: input.timezone },
    attendees: input.attendees.map((a) => ({ email: a.email, displayName: a.name ?? undefined })),
    extendedProperties: { private: { lendmaxAppointmentId: input.appointmentId } },
    ...(withConference ? {
      conferenceData: { createRequest: {
        requestId: `lmx-${input.appointmentId}-${randomBytes(4).toString('hex')}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      } },
    } : {}),
  };
}

const form = (values: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(values).toString(),
});

function emailFromIdToken(idToken: string | undefined): string | null {
  // Received straight from Google's token endpoint over TLS, so the payload
  // is Google's; it is read, not trusted for anything but the address shown.
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: string }).email ?? null;
  } catch { return null; }
}

const need = (client: OAuthClient | null): OAuthClient => {
  if (!client) {
    throw new GoogleError('Google Calendar is not set up yet. An admin adds the Google OAuth client under Integrations.');
  }
  return client;
};

const live: CalendarDriver = {
  mode: 'live',
  authUrl(client, state) {
    const c = need(client);
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: c.clientId, redirect_uri: c.redirectUri, response_type: 'code',
      scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
      include_granted_scopes: 'true', state,
    }).toString();
  },
  async exchangeCode(client, code) {
    const c = need(client);
    const t = await call<{ access_token: string; refresh_token?: string; expires_in: number; id_token?: string; scope?: string }>(
      'https://oauth2.googleapis.com/token',
      form({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: 'authorization_code' }));
    const email = emailFromIdToken(t.id_token);
    if (!email) throw new GoogleError('Google did not say which account was connected.');
    if (!t.refresh_token) {
      throw new GoogleError('Google did not grant offline access. Remove Lendmax from your Google account’s third-party access and connect again.');
    }
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(Date.now() + t.expires_in * 1000), email, scopes: t.scope };
  },
  async refresh(client, refreshToken) {
    const c = need(client);
    try {
      const t = await call<{ access_token: string; expires_in: number; scope?: string }>(
        'https://oauth2.googleapis.com/token',
        form({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token' }));
      return { accessToken: t.access_token, refreshToken: null, expiresAt: new Date(Date.now() + t.expires_in * 1000), scopes: t.scope };
    } catch (err) {
      if (err instanceof GoogleError && (err.status === 400 || err.status === 401)) {
        throw new GoogleError('Google no longer accepts this connection. Reconnect Google Calendar.', err.status, true);
      }
      throw err;
    }
  },
  async revoke(token) {
    await call('https://oauth2.googleapis.com/revoke', form({ token })).catch(() => undefined);
  },
  async createEvent(token, calendarId, input) {
    const url = `${API}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all&conferenceDataVersion=1`;
    return fromGoogle(await call<GoogleEventBody>(url, {
      method: 'POST', token, headers: { 'content-type': 'application/json' }, body: JSON.stringify(toGoogle(input, input.meet)),
    }));
  },
  async updateEvent(token, calendarId, eventId, input) {
    const url = `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all&conferenceDataVersion=1`;
    const body = toGoogle(input, false) as Record<string, unknown>;
    // Keep an existing Meet; add one only if the meeting became a video call.
    if (input.meet) {
      const current = fromGoogle(await call<GoogleEventBody>(
        `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { token }));
      if (!current.meetUrl) Object.assign(body, toGoogle(input, true));
    }
    return fromGoogle(await call<GoogleEventBody>(url, {
      method: 'PATCH', token, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
  },
  async cancelEvent(token, calendarId, eventId) {
    try {
      await call(`${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
                 { method: 'DELETE', token });
    } catch (err) {
      // Already gone is the outcome that was wanted.
      if (err instanceof GoogleError && (err.status === 404 || err.status === 410)) return;
      throw err;
    }
  },
  async changedSince(token, calendarId, since) {
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        updatedMin: since.toISOString(), showDeleted: 'true', singleEvents: 'true', maxResults: '250',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await call<{ items?: GoogleEventBody[]; nextPageToken?: string }>(
        `${API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, { token });
      out.push(...(page.items ?? []).map(fromGoogle));
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < 2500);
    return out;
  },
  async busy(token, calendarId, from, to) {
    const result = await call<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> }>(
      `${API}/freeBusy`, {
        method: 'POST', token, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calendarId }] }),
      });
    return (result.calendars?.[calendarId]?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  },
};

// ── Sandbox ────────────────────────────────────────────────────────────────

type SandboxEvent = CalendarEvent & { owner: string; updated: Date; attendees: string[]; summary: string };

/** Everything the sandbox holds, per process. Exposed for tests. */
export const sandbox = {
  events: new Map<string, SandboxEvent>(),
  busy: new Map<string, BusyBlock[]>(),
  /** Tokens are the account's address, so a token names whose calendar it is. */
  ownerOf(token: string): string { return token.replace(/^sandbox:/, ''); },
  /** Somebody moves the meeting in Google. */
  move(eventId: string, startsAt: Date, endsAt: Date) {
    const e = sandbox.events.get(eventId);
    if (e) Object.assign(e, { startsAt, endsAt, updated: new Date() });
  },
  /** Somebody deletes it in Google. */
  cancel(eventId: string) {
    const e = sandbox.events.get(eventId);
    if (e) Object.assign(e, { status: 'cancelled', updated: new Date() });
  },
  setBusy(email: string, blocks: BusyBlock[]) { sandbox.busy.set(email.toLowerCase(), blocks); },
  reset() { sandbox.events.clear(); sandbox.busy.clear(); },
};

const sandboxDriver: CalendarDriver = {
  mode: 'sandbox',
  authUrl(_client, state) {
    // Straight back to our own callback, as if Google had said yes.
    return `${env.PUBLIC_URL.replace(/\/$/, '')}/api/integrations/google/callback?` +
      new URLSearchParams({ code: 'sandbox', state }).toString();
  },
  async exchangeCode(_client, code, hint) {
    if (code !== 'sandbox') throw new GoogleError('That sign-in code was not accepted.', 400);
    const email = hint.email.toLowerCase();
    return { accessToken: `sandbox:${email}`, refreshToken: `sandbox-refresh:${email}`, expiresAt: new Date(Date.now() + 3_600_000), email, scopes: SCOPES.join(' ') };
  },
  async refresh(_client, refreshToken) {
    return { accessToken: `sandbox:${refreshToken.replace(/^sandbox-refresh:/, '')}`, refreshToken: null, expiresAt: new Date(Date.now() + 3_600_000) };
  },
  async revoke() { /* nothing to revoke */ },
  async createEvent(token, _calendarId, input) {
    const id = `sbx${randomBytes(8).toString('hex')}`;
    const event: SandboxEvent = {
      id, status: 'confirmed', startsAt: input.startsAt, endsAt: input.endsAt,
      meetUrl: input.meet ? `https://meet.google.com/sbx-${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}` : null,
      htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
      appointmentId: input.appointmentId, owner: sandbox.ownerOf(token), updated: new Date(),
      attendees: input.attendees.map((a) => a.email), summary: input.summary,
    };
    sandbox.events.set(id, event);
    return { ...event };
  },
  async updateEvent(token, _calendarId, eventId, input) {
    const e = sandbox.events.get(eventId);
    if (!e || e.owner !== sandbox.ownerOf(token)) throw new GoogleError('Not Found', 404);
    Object.assign(e, {
      startsAt: input.startsAt, endsAt: input.endsAt, summary: input.summary, updated: new Date(),
      status: 'confirmed', attendees: input.attendees.map((a) => a.email),
      meetUrl: e.meetUrl ?? (input.meet ? `https://meet.google.com/sbx-${randomBytes(2).toString('hex')}` : null),
    });
    return { ...e };
  },
  async cancelEvent(token, _calendarId, eventId) {
    const e = sandbox.events.get(eventId);
    if (e && e.owner === sandbox.ownerOf(token)) Object.assign(e, { status: 'cancelled', updated: new Date() });
  },
  async changedSince(token, _calendarId, since) {
    const owner = sandbox.ownerOf(token);
    return [...sandbox.events.values()].filter((e) => e.owner === owner && e.updated >= since).map((e) => ({ ...e }));
  },
  async busy(token, _calendarId, from, to) {
    const owner = sandbox.ownerOf(token);
    const events = [...sandbox.events.values()]
      .filter((e) => e.owner === owner && e.status !== 'cancelled' && e.startsAt && e.endsAt)
      .map((e) => ({ start: e.startsAt!, end: e.endsAt! }));
    return [...events, ...(sandbox.busy.get(owner) ?? [])].filter((b) => b.start < to && b.end > from);
  },
};

export function calendarDriver(): CalendarDriver {
  return env.GOOGLE_CALENDAR_MODE === 'live' ? live : sandboxDriver;
}
