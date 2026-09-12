/**
 * Session, configuration, routing and theme.
 *
 * Deliberately small: hooks over a router library and a state library, because
 * the whole of this app's shared state is "who is signed in, what the
 * vocabularies are, and what is in the address bar". A dependency that manages
 * that is a dependency to upgrade rather than a problem solved.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import { ApiError, BASE, get, post, setUnauthenticatedHandler } from './api.ts';

// ── Routing ────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export function navigate(path: string, replace = false): void {
  const url = path.startsWith(BASE) ? path : `${BASE}${path}`;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  notify();
  // A route change is a new page; keeping the previous scroll position makes
  // the new one look like it failed to load.
  window.scrollTo(0, 0);
  document.querySelector('.content')?.scrollTo(0, 0);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', notify);
}

export function useRoute(): { path: string; query: URLSearchParams } {
  const read = () => ({
    path: location.pathname.slice(BASE.length) || '/',
    query: new URLSearchParams(location.search),
  });
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const fn = () => setRoute(read());
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, []);
  return route;
}

// ── Theme ──────────────────────────────────────────────────────────────────

export type ThemePref = 'light' | 'dark' | 'system';

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(
    () => (document.documentElement.dataset.themePref as ThemePref) ?? 'system',
  );

  const apply = useCallback((next: ThemePref) => {
    const dark = next === 'dark' ||
      (next === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themePref = next;
    try { localStorage.setItem('lmx-theme', next); } catch { /* private mode */ }
    setPref(next);
  }, []);

  // On "system", follow the OS while the tab is open rather than only at load.
  useEffect(() => {
    if (pref !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const fn = () => { document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light'; };
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [pref]);

  return [pref, apply];
}

// ── Session ────────────────────────────────────────────────────────────────

export type User = {
  id: string; name: string; email: string; role: string; role_name: string;
  organization_id: string; profile_complete: boolean; timezone: string | null;
};
export type Organization = { id: string; name: string; home_province: string; timezone: string };

export type Session = {
  user: User;
  organization: Organization | null;
  permissions: string[];
  profile: Record<string, unknown> | null;
};

export type Config = {
  stages: Array<{ key: string; label: string; position: number; category: string;
                  probability: number | null; colour: string | null; active: boolean }>;
  transaction_types: Array<{ key: string; label: string }>;
  lost_dispositions: Array<{ key: string; label: string; requires_note: boolean }>;
  document_categories: Array<{ key: string; label: string; group_key: string }>;
  users: Array<{ id: string; name: string; email: string; role: string }>;
  lenders: Array<{ id: string; name: string }>;
};

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'ready'; session: Session; config: Config | null };

export function useSession() {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const me = await get<Session & { ok: true }>('/auth/me');
      let config: Config | null = null;
      try {
        config = await get<Config>('/config');
      } catch {
        // The vocabularies are not worth blocking sign-in on; screens that
        // need them show their own empty state.
      }
      setState({ status: 'ready', session: me, config });
    } catch {
      setState({ status: 'anonymous' });
    }
  }, []);

  useEffect(() => {
    setUnauthenticatedHandler(() => setState({ status: 'anonymous' }));
    void load();
  }, [load]);

  const signOut = useCallback(async () => {
    try { await post('/auth/logout'); } catch { /* the cookie is going either way */ }
    setState({ status: 'anonymous' });
    navigate('/');
  }, []);

  return { state, reload: load, signOut };
}

/** Permission check, mirroring the server's. The server still asserts. */
export const allows = (permissions: string[], permission: string): boolean =>
  permissions.includes(permission);

// ── Data fetching ──────────────────────────────────────────────────────────

export type Async<T> =
  | { status: 'loading' }
  // `code` carries the server's own code, so a refusal can be rendered as a
  // refusal rather than as a fault. "You cannot open this" and "something
  // broke" are different facts and a red panel for both teaches a broker to
  // ignore red panels.
  | { status: 'error'; error: string; code?: string; permission?: string }
  | { status: 'ready'; data: T };

/**
 * A fetch tied to the component's life.
 *
 * The abort matters: a broker typing in the search box fires a request per
 * keystroke, and without it a slow early response can land after a fast later
 * one and put the wrong rows on screen.
 */
export function useAsync<T>(path: string | null, deps: unknown[] = []): Async<T> & { reload: () => void } {
  const [state, setState] = useState<Async<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    get<T>(path, controller.signal)
      .then((data) => setState({ status: 'ready', data }))
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        const api = err as ApiError;
        setState({
          status: 'error',
          error: err.message,
          code: api.code,
          permission: (api.body?.permission as string | undefined),
        });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  return { ...state, reload: () => setNonce((n) => n + 1) } as Async<T> & { reload: () => void };
}

/** Debounce, for the search box. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

// ── Toasts ─────────────────────────────────────────────────────────────────

export type Toast = { id: number; message: string; tone: 'ok' | 'error' | 'info' };
let toastId = 0;
const toastListeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];

export function toast(message: string, tone: Toast['tone'] = 'info'): void {
  const t: Toast = { id: ++toastId, message, tone };
  toasts = [...toasts, t];
  toastListeners.forEach((fn) => fn(toasts));
  // Errors stay longer: they usually need reading twice.
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((fn) => fn(toasts));
  }, tone === 'error' ? 7000 : 3800);
}

export function useToasts(): Toast[] {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    toastListeners.add(setList);
    return () => void toastListeners.delete(setList);
  }, []);
  return list;
}
