/**
 * The live half of LM Chats: one event stream for the whole tab.
 *
 * One `EventSource`, shared. The sidebar badge and the chats screen both
 * listen to it, so opening the screen does not open a second connection and
 * closing it does not cut the badge off.
 *
 * Everything here is a hint, never the truth. A dropped event costs a refresh,
 * not a message: the badge refetches on reconnect and on window focus, and the
 * thread reconciles against the server whenever it is opened.
 */
import { useEffect, useState } from 'preact/hooks';
import { BASE, get } from './api.ts';

export type ChatEvent = {
  type: 'chat.message' | 'chat.message.updated' | 'chat.message.deleted'
      | 'chat.read' | 'chat.typing' | 'chat.conversation' | 'chat.removed';
  conversation_id: string;
  message?: ChatMessage;
  /** chat.read: whose read mark moved, which is what turns a tick over. */
  reader_id?: string;
  /** chat.typing: who, and until when. */
  user_id?: string;
  name?: string;
  until?: number;
};

export type ChatMessage = {
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

type Listener = (event: ChatEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;

function open(): void {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource(`${BASE}/api/events`, { withCredentials: true });
  const TYPES = [
    'chat.message', 'chat.message.updated', 'chat.message.deleted',
    'chat.read', 'chat.typing', 'chat.conversation', 'chat.removed',
  ];
  for (const type of TYPES) {
    source.addEventListener(type, (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as ChatEvent;
        for (const fn of listeners) fn(data);
      } catch { /* a malformed frame is not worth taking the stream down for */ }
    });
  }
  // EventSource reconnects on its own; this only tells anybody listening that
  // there may have been a gap, so they can refetch rather than trust the cache.
  source.addEventListener('error', () => {
    for (const fn of listeners) fn({ type: 'chat.conversation', conversation_id: '' });
  });
}

function closeIfIdle(): void {
  if (listeners.size === 0 && source) {
    source.close();
    source = null;
  }
}

/** Listen while the component is mounted. The stream opens on the first listener. */
export function onChatEvent(fn: Listener): () => void {
  listeners.add(fn);
  open();
  return () => {
    listeners.delete(fn);
    closeIfIdle();
  };
}

// ── The badge ──────────────────────────────────────────────────────────────

/**
 * The unread number on the sidebar, and in the tab title.
 *
 * Refetched rather than incremented locally: a count kept by adding one per
 * event is wrong the moment the same person reads the conversation in another
 * tab, and being wrong in the direction of "you have unread messages" is the
 * one that costs somebody a search for a message that is not there.
 */
export function useChatUnread(enabled: boolean): number {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;

    const refresh = async () => {
      try {
        const data = await get<{ total: number }>('/chats/unread');
        if (!cancelled) setUnread(data.total);
      } catch { /* the badge is not worth an error message */ }
    };

    // Coalesced: ten messages arriving together are one refetch, not ten.
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 250) as unknown as number;
    };

    void refresh();
    const stop = onChatEvent((event) => {
      // A typing ping says nothing about unread counts, and there are a lot of
      // them. Refetching on each would be a request every three seconds per
      // person typing.
      if (event.type !== 'chat.typing') soon();
    });
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    // A backstop for anything the stream missed while the laptop was asleep.
    const poll = setInterval(refresh, 120_000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener('focus', onFocus);
      stop();
    };
  }, [enabled]);

  return unread;
}

/** "(3) Lendmax CRM" in the tab, so an unread chat is visible from another tab. */
export function useTitleBadge(unread: number): void {
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${base}` : base;
    return () => { document.title = base; };
  }, [unread]);
}

// ── Desktop notifications ──────────────────────────────────────────────────

export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

export const notificationState = (): NotificationPermissionState =>
  (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/**
 * Asked for on a click, never on load.
 *
 * A permission prompt nobody asked for is dismissed by reflex, and browsers
 * hold that dismissal against the site afterwards.
 */
export async function askForNotifications(): Promise<NotificationPermissionState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

/** Only when the tab is not the one being looked at — otherwise it is already on screen. */
export function notifyDesktop(title: string, body: string, onClick: () => void): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  try {
    const notification = new Notification(title, { body, tag: 'lmx-chat' });
    notification.onclick = () => { window.focus(); onClick(); notification.close(); };
  } catch { /* some browsers refuse outside a service worker; the badge still shows */ }
}
