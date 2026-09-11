/**
 * VoIP.ms — SMS and MMS.
 *
 * Built against https://wiki.voip.ms/article/API_Overview. The API is a single
 * GET endpoint taking a `method` parameter and returning `{ status: 'success' }`
 * or `{ status: '<an error word>' }` — note that it answers HTTP 200 for
 * failures, so the HTTP status tells you almost nothing and the body has to be
 * read every time.
 *
 * Two things this module exists to get right:
 *
 *   SEGMENTS. A text over 160 characters is billed and delivered as multiple
 *   segments, and a single non-GSM character (a curly quote pasted from Word,
 *   an em dash, an emoji) drops the limit to 70. A broker who types 150
 *   characters and pastes one “ has just sent three segments. The composer is
 *   told before it happens.
 *
 *   ATTRIBUTION. An inbound message is matched on a normalised number. If it
 *   matches more than one client it is held for a person rather than attached
 *   to the likeliest — a stranger's text on a mortgage file is a privacy
 *   incident, and guessing is how it happens.
 */
import { log } from '../lib/logger.ts';
import { toE164 } from '../lib/phone.ts';
import { integrationReady } from '../services/integrations.ts';

export const BASE_URL = 'https://voip.ms/api/v1/rest.php';
const TIMEOUT_MS = 20_000;

export type SmsResult = {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  retryable?: boolean;
  segments?: number;
};

/**
 * GSM 03.38, the character set a single-segment SMS is encoded in.
 *
 * Anything outside it forces UCS-2 and a 70-character limit. This is the
 * difference between one segment and three, which is the difference between
 * the price a brokerage expects and the bill it gets.
 */
const GSM_CHARS = new Set(
  ('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
   '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà').split(''),
);
/** These cost two GSM characters each rather than one. */
const GSM_EXTENDED = new Set(['\f', '^', '{', '}', '\\', '[', '~', ']', '|', '€']);

export type SegmentInfo = {
  encoding: 'GSM-7' | 'UCS-2';
  characters: number;
  segments: number;
  /** Which characters forced UCS-2, so the composer can offer to replace them. */
  offenders: string[];
};

export function measureSegments(body: string): SegmentInfo {
  const offenders: string[] = [];
  let units = 0;
  for (const ch of body) {
    if (GSM_EXTENDED.has(ch)) units += 2;
    else if (GSM_CHARS.has(ch)) units += 1;
    else {
      units += 1;
      if (!offenders.includes(ch)) offenders.push(ch);
    }
  }
  if (offenders.length > 0) {
    // UCS-2 counts UTF-16 code units, so an emoji outside the BMP is two.
    const characters = [...body].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
    return {
      encoding: 'UCS-2',
      characters,
      segments: characters <= 70 ? 1 : Math.ceil(characters / 67),
      offenders,
    };
  }
  return {
    encoding: 'GSM-7',
    characters: units,
    segments: units <= 160 ? 1 : Math.ceil(units / 153),
    offenders: [],
  };
}

/** Replace the characters that quietly triple the cost of a message. */
export function toGsmSafe(body: string): string {
  return body
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/•/g, '*');
}

/** VoIP.ms wants bare digits, not E.164. */
function toVoipms(phone: string): string | null {
  const e164 = toE164(phone);
  if (!e164) return null;
  return e164.replace(/^\+1/, '');
}

async function callApi(
  values: Record<string, unknown>,
  method: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; body: Record<string, unknown>; error?: string; retryable?: boolean }> {
  const url = new URL(BASE_URL);
  url.searchParams.set('api_username', String(values.api_user));
  url.searchParams.set('api_password', String(values.api_password));
  url.searchParams.set('method', method);
  url.searchParams.set('content_type', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, body, error: `VoIP.ms returned HTTP ${res.status}.`, retryable: res.status >= 500 };
    }
    // VoIP.ms answers 200 with a status word. `status` is the real result.
    const status = String(body.status ?? '');
    if (status !== 'success') {
      return {
        ok: false, body,
        error: explainVoipmsStatus(status),
        // Only a few of its failures are worth another attempt.
        retryable: ['server_error', 'database_error', 'api_rate_limit'].includes(status),
      };
    }
    return { ok: true, body };
  } catch (err) {
    return {
      ok: false, body: {},
      error: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** VoIP.ms status words are terse. These are the ones an operator will hit. */
function explainVoipmsStatus(status: string): string {
  const known: Record<string, string> = {
    invalid_credentials: 'VoIP.ms rejected the API username or password.',
    ip_not_enabled: 'This server’s IP address is not on the VoIP.ms API allow-list. Add it in the VoIP.ms portal under Main Menu → SOAP and REST/JSON API.',
    api_not_enabled: 'API access is not enabled on the VoIP.ms account.',
    invalid_did: 'The sending number (DID) is not one this account owns.',
    invalid_dst: 'The destination number was rejected as invalid.',
    missing_dst: 'No destination number was supplied.',
    sms_toll_free_not_allowed: 'VoIP.ms refused the message: toll-free SMS is not enabled.',
    sms_failed: 'VoIP.ms could not deliver the message.',
    limit_reached: 'The VoIP.ms account has hit its sending limit.',
  };
  return known[status] ?? `VoIP.ms refused the message (${status || 'no status returned'}).`;
}

export type SendSmsInput = {
  to: string;
  body: string;
  /** Media URLs for MMS. VoIP.ms fetches these, so they must be reachable. */
  mediaUrls?: string[];
  /** Override the sending DID where the brokerage has several. */
  fromDid?: string;
};

export async function sendSms(organizationId: string, input: SendSmsInput): Promise<SmsResult> {
  const { ready, reason, values } = await integrationReady(organizationId, 'voipms');
  if (!ready) return { ok: false, error: reason ?? 'VoIP.ms is not configured.', retryable: false };

  const dst = toVoipms(input.to);
  if (!dst) {
    return { ok: false, error: `"${input.to}" is not a valid Canadian number.`, retryable: false };
  }
  const did = String(input.fromDid ?? values.default_did ?? '').replace(/\D/g, '');
  if (!did) return { ok: false, error: 'No sending number (DID) is configured.', retryable: false };

  const measured = measureSegments(input.body);
  const limit = Number(values.segment_limit ?? 0);
  if (limit > 0 && measured.segments > limit) {
    return {
      ok: false,
      segments: measured.segments,
      error:
        `This message is ${measured.segments} segments and the limit is ${limit}. ` +
        (measured.offenders.length
          ? `Replacing ${measured.offenders.map((c) => `"${c}"`).join(', ')} would shorten it.`
          : 'Shorten it, or raise the limit under Settings → Integrations.'),
      retryable: false,
    };
  }

  const isMms = Boolean(input.mediaUrls?.length);
  const result = await callApi(
    values,
    isMms ? 'sendMMS' : 'sendSMS',
    {
      did,
      dst,
      message: input.body,
      ...(isMms ? { media1: input.mediaUrls![0]! } : {}),
    },
  );

  if (!result.ok) {
    return { ok: false, error: result.error, retryable: result.retryable, segments: measured.segments };
  }
  return {
    ok: true,
    // VoIP.ms returns the id under `sms` or `mms` depending on the method.
    providerMessageId: String(result.body.sms ?? result.body.mms ?? ''),
    segments: measured.segments,
  };
}

/**
 * Settings → Integrations → Test.
 *
 * Deliberately `getDIDsInfo` rather than sending a message: a test that texts
 * somebody is a test people are reluctant to press, and this confirms the
 * credentials, the IP allow-list and the DID in one call without bothering
 * anyone.
 */
export async function testVoipms(
  organizationId: string,
): Promise<{ ok: boolean; message: string }> {
  const { ready, reason, values } = await integrationReady(organizationId, 'voipms');
  if (!ready) return { ok: false, message: reason ?? 'VoIP.ms is not configured.' };

  const result = await callApi(values, 'getDIDsInfo', {});
  if (!result.ok) return { ok: false, message: result.error ?? 'The call failed.' };

  const dids = Array.isArray(result.body.dids) ? (result.body.dids as Array<Record<string, unknown>>) : [];
  const configured = String(values.default_did ?? '').replace(/\D/g, '');
  const owned = dids.map((d) => String(d.did ?? '').replace(/\D/g, ''));

  if (configured && !owned.includes(configured)) {
    return {
      ok: false,
      message:
        `The credentials work, but ${configured} is not a number on this account. ` +
        (owned.length ? `Available: ${owned.join(', ')}.` : 'This account has no numbers.'),
    };
  }
  return {
    ok: true,
    message: `Connected. ${dids.length} number(s) on the account; sending as ${configured || owned[0] || 'none set'}.`,
  };
}

/**
 * The inbound callback.
 *
 * VoIP.ms delivers these as a GET with query parameters, and it will deliver
 * the same one more than once. `id` is what makes processing idempotent.
 */
export type InboundSms = {
  providerMessageId: string | null;
  from: string | null;
  to: string | null;
  body: string;
  mediaUrls: string[];
  receivedAt: Date;
};

export function parseInboundCallback(params: URLSearchParams): InboundSms {
  const media: string[] = [];
  for (const [key, value] of params.entries()) {
    if (/^media\d*$/.test(key) && value) media.push(value);
  }
  return {
    providerMessageId: params.get('id'),
    from: toE164(params.get('from') ?? ''),
    to: toE164(params.get('to') ?? ''),
    body: params.get('message') ?? '',
    mediaUrls: media,
    receivedAt: (() => {
      const raw = params.get('date');
      if (!raw) return new Date();
      const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
      return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    })(),
  };
}

export function logVoipms(message: string, context: Record<string, unknown> = {}): void {
  log.info(`voip.ms: ${message}`, context);
}
