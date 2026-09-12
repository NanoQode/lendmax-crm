/**
 * The API client.
 *
 * One place that knows how to talk to the server, so that error handling is
 * the same everywhere: the server always answers with `{ ok, error, code }`,
 * and this turns a failure into a thrown ApiError carrying the sentence the
 * server wrote. Components render that sentence rather than inventing
 * "Something went wrong", which is never true and never useful.
 */

export const BASE = (() => {
  // Derived from where the bundle is actually served rather than hard-coded,
  // so the app works if the mount point moves.
  const script = document.querySelector<HTMLScriptElement>('script[type=module][src*="/assets/"]');
  const src = script?.getAttribute('src') ?? '/crm/assets/app.js';
  return src.replace(/\/assets\/[^/]*$/, '');
})();

export class ApiError extends Error {
  status: number;
  code: string;
  fields?: Array<{ field: string; message: string }>;
  blockers?: Array<{ field: string; label: string; message: string }>;
  correlationId?: string;
  /**
   * The server's `detail`, and the whole body behind it.
   *
   * A refusal that lists what is wrong is only useful if the list survives
   * the throw — the publish route returns every validation issue in `detail`
   * and the screen shows them next to the steps they belong to.
   */
  detail?: unknown;
  body: Record<string, unknown>;

  constructor(message: string, status: number, code: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = extra.fields as ApiError['fields'];
    this.blockers = extra.blockers as ApiError['blockers'];
    this.correlationId = extra.correlationId as string | undefined;
    this.detail = extra.detail;
    this.body = extra;
  }
}

type Options = { method?: string; body?: unknown; signal?: AbortSignal };

let onUnauthenticated: (() => void) | null = null;
export const setUnauthenticatedHandler = (fn: () => void) => {
  onUnauthenticated = fn;
};

export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;
  let response: Response;
  try {
    response = await fetch(`${BASE}/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // A network failure is distinguishable from a server error, and saying so
    // saves somebody checking the wrong logs.
    throw new ApiError(
      'Could not reach the server. Check your connection and try again.',
      0, 'network_error',
    );
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    if (response.ok) return {} as T;
  }

  if (!response.ok || payload.ok === false) {
    if (response.status === 401) onUnauthenticated?.();
    throw new ApiError(
      (payload.error as string) ?? `Request failed (${response.status}).`,
      response.status,
      (payload.code as string) ?? 'error',
      payload,
    );
  }
  return payload as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });

// ── Formatting ─────────────────────────────────────────────────────────────

const CAD = new Intl.NumberFormat('en-CA', {
  style: 'currency', currency: 'CAD', maximumFractionDigits: 0,
});
const CAD_EXACT = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

/**
 * Money. An absent amount renders as an em dash, never as $0 — "we do not know
 * what they want" and "they want nothing" are different facts and a pipeline
 * total built on the second is wrong.
 */
export function money(value: unknown, exact = false): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return (exact ? CAD_EXACT : CAD).format(n);
}

export function compactMoney(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return CAD.format(n);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  // A calendar date is parsed as a calendar date. new Date('2026-10-15') is
  // UTC midnight, which renders as 14 October anywhere west of Greenwich.
  const iso = String(value).slice(0, 10);
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '—';
  return new Date(y, m - 1, d).toLocaleDateString('en-CA', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-CA', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  const future = seconds < 0;
  const s = Math.abs(seconds);
  const say = (n: number, unit: string) =>
    future ? `in ${n} ${unit}${n === 1 ? '' : 's'}` : `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return future ? 'in a moment' : 'just now';
  if (s < 3600) return say(Math.round(s / 60), 'minute');
  if (s < 86400) return say(Math.round(s / 3600), 'hour');
  if (s < 2_592_000) return say(Math.round(s / 86400), 'day');
  return formatDate(new Date(then).toISOString());
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

/** A stable colour per person, so the same face is the same colour everywhere. */
export function avatarColour(seed: string): string {
  const palette = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#10b981', '#f43f5e'];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}
