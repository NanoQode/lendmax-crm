/**
 * LM Chats.
 *
 * Two panes: the conversations on the left, newest first, and the open one on
 * the right. On a phone it is one pane at a time, because a 380px column split
 * in two is two columns nobody can read.
 *
 * What the screen does NOT decide: who may talk to whom, who may post, what
 * cannot be left. Every one of those arrives on the conversation as
 * `can_post`, `can_leave`, `can_manage` and the sentence to show when the
 * answer is no. The server decides and the server refuses; this renders the
 * answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { del, get, patch, post, upload, avatarColour } from '../lib/api.ts';
import { navigate, toast, useDebounced, useRoute, type Session } from '../lib/store.ts';
import {
  askForNotifications, notificationState, notifyDesktop, onChatEvent, useChatUnread, useTitleBadge,
  type ChatEvent, type ChatMessage,
} from '../lib/chat-live.ts';
import { Avatar, Badge, Empty, ErrorNote, Field, Icon, ICONS, Modal, Skeleton, Switch } from '../components/ui.tsx';

// ── Shapes, as the server sends them ───────────────────────────────────────

export type Conversation = {
  id: string;
  kind: 'direct' | 'group' | 'community';
  title: string;
  name: string | null;
  everyone_can_post: boolean;
  created_at: string;
  last_message_at: string | null;
  unread: number;
  muted: boolean;
  muted_until: string | null;
  member_count: number;
  can_post: boolean;
  post_refusal: string | null;
  can_leave: boolean;
  can_manage: boolean;
  can_delete: boolean;
  preview: string;
  preview_sender: string | null;
  photo_url: string | null;
  other: {
    id: string; name: string; email: string; role: string | null; active: boolean;
    photo_url: string | null;
  } | null;
};

type Member = {
  id: string; name: string; email: string; role: string;
  is_admin: boolean; joined_at: string; is_you: boolean; photo_url: string | null;
};

type Contact = {
  id: string; name: string; email: string; role: string; is_admin: boolean;
  conversation_id: string | null; unread: number; photo_url: string | null;
};

type SearchHit = {
  id: string; created_at: string; snippet: string; sender_name: string | null; mine: boolean;
};

type Meta = {
  is_admin: boolean;
  attachment_accept: string;
  attachment_max_bytes: number;
  photo_accept: string;
  photo_max_bytes: number;
  edit_window_minutes: number;
  typing_ping_ms: number;
  mute_options: Array<{ key: string; label: string }>;
};

// ── Time, the way a chat reads it ──────────────────────────────────────────

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "14:32" today, "Yesterday", the weekday this week, a date before that. */
function listTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86_400_000);
  if (days === 0) return then.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return then.toLocaleDateString('en-CA', { weekday: 'short' });
  return then.toLocaleDateString('en-CA', { day: 'numeric', month: 'short' });
}

function dayLabel(iso: string): string {
  const then = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return then.toLocaleDateString('en-CA', {
    weekday: 'long', day: 'numeric', month: 'long',
    year: then.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });

const badgeLabel = (n: number) => (n > 99 ? '99+' : String(n));

/**
 * "Dana is typing…", "Dana and Evan are typing…", "3 people are typing…"
 *
 * The same rule as `typingLabel` in `domain/chats.ts`, restated here because
 * the front end does not share the server's module graph. It is composed from
 * several people at once, so the server cannot send it ready-made.
 */
function typingLabel(names: string[]): string {
  const first = names.map((n) => n.split(' ')[0] ?? n);
  if (first.length === 0) return '';
  if (first.length === 1) return `${first[0]} is typing…`;
  if (first.length === 2) return `${first[0]} and ${first[1]} are typing…`;
  return `${first.length} people are typing…`;
}

// ── The screen ─────────────────────────────────────────────────────────────

export function ChatsPage({ session }: { session: Session }) {
  const route = useRoute();
  const activeId = route.query.get('c');

  const [meta, setMeta] = useState<Meta | null>(null);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [starting, setStarting] = useState<'direct' | 'group' | null>(null);
  const unread = useChatUnread(true);
  useTitleBadge(unread);

  const loadList = useCallback(async () => {
    try {
      const data = await get<{ conversations: Conversation[] }>('/chats');
      setConversations(data.conversations);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your chats.');
    }
  }, []);

  useEffect(() => {
    void loadList();
    get<Meta>('/chats/meta').then(setMeta).catch(() => setMeta(null));
  }, [loadList]);

  // The list reorders and re-counts on anything the stream reports. It is a
  // refetch rather than a local edit because the unread numbers and the order
  // are the server's arithmetic, and two implementations of it would diverge.
  useEffect(() => onChatEvent(() => { void loadList(); }), [loadList]);

  const open = (id: string | null) => navigate(id ? `/chats?c=${id}` : '/chats', true);

  const filter = useDebounced(search, 150).trim().toLowerCase();
  const shown = useMemo(() => {
    if (!conversations) return null;
    if (!filter) return conversations;
    return conversations.filter((c) =>
      c.title.toLowerCase().includes(filter) || c.preview.toLowerCase().includes(filter));
  }, [conversations, filter]);

  const active = conversations?.find((c) => c.id === activeId) ?? null;

  return (
    <div class={`chat-layout${activeId ? ' chat-open' : ''}`}>
      <aside class="chat-list" aria-label="Conversations">
        <div class="chat-list-head">
          <div class="row-between">
            <h1>LM Chats</h1>
            <div class="row" style={{ gap: 4 }}>
              <button class="btn btn-sm" onClick={() => setStarting('direct')}>New chat</button>
              {meta?.is_admin && (
                <button class="btn btn-sm btn-primary" onClick={() => setStarting('group')}>New group</button>
              )}
            </div>
          </div>
          <input class="chat-search" type="search" placeholder="Search chats…" value={search}
                 aria-label="Search chats"
                 onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
          <NotificationsPrompt />
        </div>

        <div class="chat-rows">
          {error && <div style={{ padding: 12 }}><ErrorNote error={error} onRetry={loadList} /></div>}
          {!error && shown === null && <div style={{ padding: 12 }}><Skeleton rows={6} height={54} /></div>}
          {shown?.length === 0 && (
            <div class="chat-none">
              {filter ? `Nothing matches “${search}”.` : 'No chats yet. Start one with the admin.'}
            </div>
          )}
          {shown?.map((c) => (
            <button key={c.id} class={`chat-row${c.id === activeId ? ' active' : ''}`}
                    aria-current={c.id === activeId ? 'true' : undefined}
                    onClick={() => open(c.id)}>
              <ConversationAvatar conversation={c} />
              <span class="chat-row-main">
                <span class="chat-row-title">
                  <span class="chat-row-name">{c.title}</span>
                  {c.muted && <Icon path={ICONS.bell} size={12} />}
                </span>
                <span class="chat-row-preview">
                  {c.preview_sender && c.kind !== 'direct' && (
                    <span class="chat-row-who">{c.preview_sender.split(' ')[0]}: </span>
                  )}
                  {c.preview}
                </span>
              </span>
              <span class="chat-row-meta">
                <span class="chat-row-time">{listTime(c.last_message_at)}</span>
                {c.unread > 0 && (
                  <span class={`chat-unread${c.muted ? ' chat-unread-muted' : ''}`}
                        aria-label={`${c.unread} unread`}>{badgeLabel(c.unread)}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section class="chat-thread" aria-label="Conversation">
        {active
          ? <Thread key={active.id} conversation={active} meta={meta} session={session}
                    onBack={() => open(null)} onChanged={loadList} onGone={() => { open(null); void loadList(); }} />
          : (
            <div class="chat-placeholder">
              <Empty title="Pick a conversation">
                Staff message the admin here, and the admin messages anyone. Groups are made by an admin.
              </Empty>
            </div>
          )}
      </section>

      {starting === 'direct' && (
        <NewChatModal onClose={() => setStarting(null)}
                      onOpened={(id) => { setStarting(null); void loadList(); open(id); }} />
      )}
      {starting === 'group' && (
        <NewGroupModal onClose={() => setStarting(null)}
                       onCreated={(id) => { setStarting(null); void loadList(); open(id); }} />
      )}
    </div>
  );
}

function ConversationAvatar({ conversation }: { conversation: Conversation }) {
  if (conversation.photo_url) {
    return <Avatar name={conversation.title} src={conversation.photo_url} />;
  }
  if (conversation.kind === 'direct') {
    return <Avatar name={conversation.other?.name ?? conversation.title} />;
  }
  // A group with no picture wears an icon rather than initials: "RP" for
  // "Renewals push" reads like a person, and it is not one.
  const colour = conversation.kind === 'community' ? 'var(--accent)' : avatarColour(conversation.id);
  return (
    <span class="avatar chat-group-avatar" style={{ background: colour }} aria-hidden="true">
      <Icon path={conversation.kind === 'community' ? ICONS.staff : ICONS.messages} size={15} />
    </span>
  );
}

/** Offered once, acted on by a click. Never prompted on load. */
function NotificationsPrompt() {
  const [state, setState] = useState(notificationState);
  if (state !== 'default') return null;
  return (
    <button class="chat-notify-ask" onClick={async () => setState(await askForNotifications())}>
      <Icon path={ICONS.bell} size={13} />
      Turn on desktop notifications
    </button>
  );
}

// ── One conversation ───────────────────────────────────────────────────────

function Thread({ conversation, meta, session, onBack, onChanged, onGone }: {
  conversation: Conversation; meta: Meta | null; session: Session;
  onBack: () => void; onChanged: () => void; onGone: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [searching, setSearching] = useState(false);
  const [typing, setTyping] = useState<Array<{ id: string; name: string; until: number }>>([]);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);

  const id = conversation.id;

  const load = useCallback(async () => {
    try {
      const data = await get<{ messages: ChatMessage[]; has_more: boolean }>(`/chats/${id}/messages`);
      setMessages(data.messages);
      setHasMore(data.has_more);
      setHasNewer(false);
      atBottom.current = true;
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that conversation.');
    }
  }, [id]);

  useEffect(() => {
    setMessages(null);
    void load();
    get<{ members: Member[] }>(`/chats/${id}`).then((d) => setMembers(d.members)).catch(() => setMembers(null));
  }, [id, load]);

  // Reading is marked on open and again whenever the tab comes back, so a
  // conversation left on screen does not keep a badge nobody can clear.
  useEffect(() => {
    const read = () => { void post(`/chats/${id}/read`).then(onChanged).catch(() => {}); };
    read();
    const onFocus = () => { if (!document.hidden) read(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [id, onChanged]);

  // Live: append what arrives here, and tell the desktop about what does not.
  useEffect(() => onChatEvent((event: ChatEvent) => {
    if (event.conversation_id !== id && event.type !== 'chat.conversation') return;

    if (event.type === 'chat.removed' && event.conversation_id === id) {
      toast('That conversation is no longer available.', 'info');
      onGone();
      return;
    }

    // Somebody typing, and somebody stopping: the entry carries its own expiry
    // so a tab that never hears "stopped" does not show it for ever.
    if (event.type === 'chat.typing' && event.user_id) {
      const { user_id, name, until } = event;
      setTyping((current) => [
        ...current.filter((t) => t.id !== user_id && t.until > Date.now()),
        { id: user_id, name: name ?? 'Somebody', until: until ?? Date.now() + 7000 },
      ]);
      return;
    }

    // An edit or a delete replaces the message in place. Nothing moves, which
    // is the point: a corrected typo must not jump the thread.
    if ((event.type === 'chat.message.updated' || event.type === 'chat.message.deleted') && event.message) {
      const changed = event.message;
      // The server shapes the event for whoever receives it, so `mine` and the
      // edit window are already right. Only the ticks are left out of the
      // payload, so those are kept from the copy already on screen.
      setMessages((current) => current?.map((m) => (m.id === changed.id
        ? { ...changed, read_state: m.read_state, read_label: m.read_label }
        : m)) ?? current);
      return;
    }

    // Somebody read the conversation, so the ticks on my messages turn over.
    if (event.type === 'chat.read' && event.reader_id !== session.user.id) {
      void refreshReceipts();
      return;
    }

    if (event.type !== 'chat.message' || !event.message) return;
    const message = event.message;
    // They have clearly stopped typing: they have sent it.
    setTyping((current) => current.filter((t) => t.id !== message.sender?.id));
    setMessages((current) => {
      if (!current) return current;
      if (current.some((m) => m.id === message.id)) return current;
      return [...current, message];
    });
    if (!message.mine) {
      void post(`/chats/${id}/read`).catch(() => {});
      if (!conversation.muted) {
        notifyDesktop(
          conversation.kind === 'direct' ? message.sender?.name ?? conversation.title : conversation.title,
          message.body ?? (message.attachments[0] ? `📎 ${message.attachments[0].filename}` : ''),
          () => navigate(`/chats?c=${id}`),
        );
      }
    }
  }), [id, conversation.kind, conversation.title, conversation.muted, onGone, session.user.id]);

  /**
   * Re-read just the ticks.
   *
   * Cheaper and less disruptive than reloading the thread: the newest page is
   * fetched and only the read state is copied across, so nothing scrolls and
   * an open edit box is not thrown away.
   */
  const refreshReceipts = useCallback(async () => {
    try {
      const data = await get<{ messages: ChatMessage[] }>(`/chats/${id}/messages`);
      const states = new Map(data.messages.map((m) => [m.id, m]));
      setMessages((current) => current?.map((m) => {
        const fresh = states.get(m.id);
        return fresh ? { ...m, read_state: fresh.read_state, read_label: fresh.read_label } : m;
      }) ?? current);
    } catch { /* the ticks are not worth an error message */ }
  }, [id]);

  // Typing entries expire on a timer rather than on the next event, or the
  // last "… is typing" would sit there until somebody else typed.
  useEffect(() => {
    if (!typing.length) return;
    const timer = setInterval(
      () => setTyping((current) => current.filter((t) => t.until > Date.now())), 1000);
    return () => clearInterval(timer);
  }, [typing.length]);

  // Stay pinned to the newest unless the person has scrolled up to read back —
  // yanking somebody to the bottom mid-sentence is how a chat loses an
  // argument it was never having.
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  /**
   * Open the thread around one message.
   *
   * The window comes back with context either side, and the message is
   * highlighted for a few seconds — landing somebody in the middle of a
   * conversation with no indication of what they were looking for is a way of
   * making them search twice.
   */
  const jumpTo = async (messageId: string) => {
    try {
      const data = await get<{ messages: ChatMessage[]; has_more: boolean; has_newer: boolean }>(
        `/chats/${id}/messages?around=${messageId}&limit=40`);
      atBottom.current = false;
      setMessages(data.messages);
      setHasMore(data.has_more);
      setHasNewer(data.has_newer);
      setHighlighted(messageId);
      requestAnimationFrame(() => {
        document.getElementById(`msg-${messageId}`)?.scrollIntoView({ block: 'center' });
      });
      setTimeout(() => setHighlighted((current) => (current === messageId ? null : current)), 2500);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not open that message.', 'error');
    }
  };

  const loadOlder = async () => {
    if (!messages?.length) return;
    setLoadingMore(true);
    const el = scroller.current;
    const heightBefore = el?.scrollHeight ?? 0;
    try {
      const data = await get<{ messages: ChatMessage[]; has_more: boolean }>(
        `/chats/${id}/messages?before=${messages[0]!.id}`);
      setMessages((current) => [...data.messages, ...(current ?? [])]);
      setHasMore(data.has_more);
      // Hold the reader's place: without this, prepending jumps them to the
      // top of what they were already reading.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - heightBefore;
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load older messages.', 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const sent = (message: ChatMessage) => {
    atBottom.current = true;
    setMessages((current) => (current?.some((m) => m.id === message.id) ? current : [...(current ?? []), message]));
    onChanged();
  };

  const mute = async (option: string | null) => {
    setMenuOpen(false);
    try {
      await post(`/chats/${id}/mute`, { mute: option });
      toast(option ? 'Muted.' : 'Unmuted.', 'ok');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change that.', 'error');
    }
  };

  const leave = async () => {
    setMenuOpen(false);
    if (!confirm(`Leave “${conversation.title}”? You will stop seeing it.`)) return;
    try {
      await post(`/chats/${id}/leave`);
      toast(`You left ${conversation.title}.`, 'ok');
      onGone();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not leave that group.', 'error');
    }
  };

  const subtitle = conversation.kind === 'direct'
    ? (conversation.other?.active === false ? 'Inactive account' : conversation.other?.email ?? '')
    : `${conversation.member_count} member${conversation.member_count === 1 ? '' : 's'}` +
      (conversation.everyone_can_post ? '' : ' · only admins post');

  return (
    <>
      <header class="chat-head">
        <button class="btn btn-ghost btn-sm chat-back" onClick={onBack} aria-label="Back to chats">←</button>
        <ConversationAvatar conversation={conversation} />
        <div class="chat-head-text">
          <div class="chat-head-title">
            {conversation.title}
            {conversation.kind === 'community' && <Badge tone="accent">Everyone</Badge>}
            {conversation.muted && <Badge>Muted</Badge>}
          </div>
          <div class="chat-head-sub">{subtitle}</div>
        </div>
        <button class="btn btn-ghost btn-sm" aria-label="Search this conversation"
                aria-pressed={searching} onClick={() => setSearching((v) => !v)}>
          <Icon path={ICONS.search} size={16} />
        </button>
        <div style={{ position: 'relative' }}>
          <button class="btn btn-ghost btn-sm" aria-haspopup="menu" aria-expanded={menuOpen}
                  aria-label="Conversation options" onClick={() => setMenuOpen((v) => !v)}>⋯</button>
          {menuOpen && (
            <div class="menu" role="menu" style={{ right: 0 }}>
              <div class="menu-label">Notifications</div>
              {conversation.muted
                ? <button class="menu-item" role="menuitem" onClick={() => mute(null)}>Unmute</button>
                : (meta?.mute_options ?? []).map((o) => (
                    <button key={o.key} class="menu-item" role="menuitem" onClick={() => mute(o.key)}>
                      Mute {o.label.toLowerCase()}
                    </button>
                  ))}
              {conversation.can_manage && (
                <>
                  <div class="menu-sep" />
                  <button class="menu-item" role="menuitem"
                          onClick={() => { setMenuOpen(false); setManaging(true); }}>
                    Manage group
                  </button>
                </>
              )}
              {conversation.can_leave && (
                <>
                  <div class="menu-sep" />
                  <button class="menu-item" role="menuitem" onClick={leave}>Leave group</button>
                </>
              )}
            </div>
          )}
        </div>
      </header>

      {searching && (
        <ConversationSearch conversationId={id} onClose={() => setSearching(false)}
                            onJump={(messageId) => void jumpTo(messageId)} />
      )}

      <div class="chat-messages" ref={scroller} onScroll={onScroll}>
        {error && <div style={{ padding: 14 }}><ErrorNote error={error} onRetry={load} /></div>}
        {!error && messages === null && <div style={{ padding: 14 }}><Skeleton rows={5} height={44} /></div>}
        {messages?.length === 0 && (
          <div class="chat-none" style={{ marginTop: 28 }}>
            No messages yet. {conversation.can_post ? 'Say something.' : conversation.post_refusal}
          </div>
        )}
        {hasMore && (
          <div class="chat-older">
            <button class="btn btn-sm" disabled={loadingMore} onClick={loadOlder}>
              {loadingMore ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {messages?.map((message, i) => (
          <MessageRow key={message.id} message={message} previous={messages[i - 1] ?? null}
                      showSender={conversation.kind !== 'direct'}
                      editWindowMinutes={meta?.edit_window_minutes ?? 19}
                      highlighted={highlighted === message.id}
                      onChanged={(next) => {
                        setMessages((current) =>
                          current?.map((m) => (m.id === next.id ? next : m)) ?? current);
                        onChanged();
                      }} />
        ))}
        {hasNewer && (
          <div class="chat-older">
            <button class="btn btn-sm" onClick={() => { setHighlighted(null); void load(); }}>
              Jump to the latest
            </button>
          </div>
        )}
      </div>

      {typing.length > 0 && (
        <div class="chat-typing" aria-live="polite">
          <span class="chat-typing-dots" aria-hidden="true"><i /><i /><i /></span>
          {typingLabel(typing.map((t) => t.name))}
        </div>
      )}

      <Composer conversation={conversation} meta={meta} onSent={sent} />

      {managing && members && (
        <ManageGroup conversation={conversation} members={members} meta={meta} session={session}
                     onClose={() => setManaging(false)}
                     onChanged={(next) => { setMembers(next); onChanged(); void load(); }}
                     onRemoved={() => { setManaging(false); onGone(); }} />
      )}
    </>
  );
}

/** A tick, and the words beside it — never colour or shape alone. */
function ReadTicks({ message }: { message: ChatMessage }) {
  if (!message.read_state) return null;
  const seen = message.read_state !== 'sent';
  return (
    <span class={`chat-ticks chat-ticks-${message.read_state}`} title={message.read_label ?? ''}
          aria-label={message.read_label ?? ''}>
      <svg viewBox="0 0 20 12" width="17" height="11" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M1 6.5 L4.5 10 L11 2.5" />
        {seen && <path d="M8 6.5 L11.5 10 L18 2.5" />}
      </svg>
    </span>
  );
}

/** A message, with the day separator above it when the day has turned. */
function MessageRow({ message, previous, showSender, editWindowMinutes, highlighted, onChanged }: {
  message: ChatMessage; previous: ChatMessage | null; showSender: boolean;
  editWindowMinutes: number; highlighted: boolean;
  onChanged: (message: ChatMessage) => void;
}) {
  const [editing, setEditing] = useState(false);
  const newDay = !previous ||
    startOfDay(new Date(previous.created_at)) !== startOfDay(new Date(message.created_at));

  if (message.kind === 'system') {
    return (
      <>
        {newDay && <div class="chat-day">{dayLabel(message.created_at)}</div>}
        <div class="chat-system">{message.body}</div>
      </>
    );
  }

  const amendable = message.mine && message.can_amend;

  // Consecutive messages from the same person inside five minutes are one
  // block: repeating the name six times says nothing the first one did not.
  const sameRun = !newDay && previous?.kind === 'text' &&
    previous.sender?.id === message.sender?.id &&
    new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() < 5 * 60_000;

  if (message.deleted) {
    return (
      <>
        {newDay && <div class="chat-day">{dayLabel(message.created_at)}</div>}
        <div class={`chat-line${message.mine ? ' mine' : ''}`}>
          {!message.mine && <span class="chat-line-avatar" />}
          <div class="chat-bubble chat-bubble-deleted">
            <span class="chat-deleted">🚫 {message.deleted_text}</span>
            <time class="chat-time" dateTime={message.created_at}>{clockTime(message.created_at)}</time>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {newDay && <div class="chat-day">{dayLabel(message.created_at)}</div>}
      <div id={`msg-${message.id}`}
           class={`chat-line${message.mine ? ' mine' : ''}${sameRun ? ' run' : ''}${highlighted ? ' found' : ''}`}>
        {!message.mine && (
          <span class="chat-line-avatar">
            {!sameRun && <Avatar name={message.sender?.name ?? '?'} src={message.sender?.photo_url} />}
          </span>
        )}
        <div class="chat-bubble">
          {showSender && !message.mine && !sameRun && (
            <div class="chat-sender" style={{ color: avatarColour(message.sender?.id ?? '') }}>
              {message.sender?.name}
            </div>
          )}
          {message.attachments.map((a) => (
            <a key={a.id} class={`chat-attachment${a.is_image ? ' chat-attachment-image' : ''}`}
               href={a.url} target="_blank" rel="noreferrer">
              {a.is_image
                ? <img src={a.url} alt={a.filename} loading="lazy" />
                : (
                  <>
                    <Icon path={ICONS.documents} size={18} />
                    <span class="chat-attachment-text">
                      <span class="chat-attachment-name">{a.filename}</span>
                      <span class="chat-attachment-size">{a.size_label}</span>
                    </span>
                  </>
                )}
            </a>
          ))}
          {editing
            ? <EditBox message={message} onDone={(next) => { setEditing(false); if (next) onChanged(next); }} />
            : message.body && <div class="chat-body">{message.body}</div>}
          <span class="chat-foot">
            {message.edited && <span class="chat-edited" title="This message was edited">edited</span>}
            <time class="chat-time" dateTime={message.created_at}>{clockTime(message.created_at)}</time>
            <ReadTicks message={message} />
          </span>
        </div>

        {amendable && !editing && (
          <MessageActions message={message} editWindowMinutes={editWindowMinutes}
                          onEdit={() => setEditing(true)} onChanged={onChanged} />
        )}
      </div>
    </>
  );
}

/**
 * Edit and Delete, for as long as the window is open.
 *
 * The button disappears when the nineteen minutes are up, live — a tab left
 * open over lunch must not still offer an Edit that the server will refuse.
 */
function MessageActions({ message, editWindowMinutes, onEdit, onChanged }: {
  message: ChatMessage; editWindowMinutes: number;
  onEdit: () => void; onChanged: (message: ChatMessage) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(() => amendLeft(message));

  useEffect(() => {
    const timer = setInterval(() => setLeft(amendLeft(message)), 1000);
    return () => clearInterval(timer);
  }, [message.amend_until]);

  if (left <= 0) return null;

  const remove = async () => {
    setOpen(false);
    if (!confirm('Delete this message for everyone? They will see that it was deleted.')) return;
    setBusy(true);
    try {
      const data = await del<{ message: ChatMessage }>(`/chats/messages/${message.id}`);
      onChanged(data.message);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete that message.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const minutes = Math.ceil(left / 60_000);
  return (
    <div class="chat-actions">
      <button class="chat-actions-button" disabled={busy} aria-haspopup="menu" aria-expanded={open}
              aria-label="Message options" onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && (
        <div class="menu chat-actions-menu" role="menu">
          <button class="menu-item" role="menuitem" onClick={() => { setOpen(false); onEdit(); }}>
            Edit
          </button>
          <button class="menu-item" role="menuitem" onClick={remove}>Delete for everyone</button>
          <div class="menu-sep" />
          <div class="menu-label">
            {minutes === 1 ? 'Less than a minute left' : `${minutes} minutes left`}
            {' '}of {editWindowMinutes}
          </div>
        </div>
      )}
    </div>
  );
}

const amendLeft = (message: ChatMessage): number =>
  (message.amend_until ? new Date(message.amend_until).getTime() - Date.now() : 0);

/** The message, in place, as a box you can type in. Escape abandons it. */
function EditBox({ message, onDone }: {
  message: ChatMessage; onDone: (message: ChatMessage | null) => void;
}) {
  const [body, setBody] = useState(message.body ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy || !body.trim()) return;
    if (body.trim() === (message.body ?? '')) { onDone(null); return; }
    setBusy(true);
    try {
      const data = await patch<{ message: ChatMessage }>(
        `/chats/messages/${message.id}`, { body: body.trim() });
      onDone(data.message);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save that edit.', 'error');
      setBusy(false);
    }
  };

  return (
    <div class="chat-edit">
      <textarea class="chat-edit-input" rows={2} value={body} autofocus aria-label="Edit message"
                onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save(); }
                  if (e.key === 'Escape') onDone(null);
                }} />
      <div class="chat-edit-row">
        <button class="btn btn-sm" onClick={() => onDone(null)}>Cancel</button>
        <button class="btn btn-sm btn-primary" disabled={busy || !body.trim()} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/**
 * Find something said in this conversation.
 *
 * Debounced, and it never searches on one character — the server refuses
 * anyway, and a refusal shown while somebody is still typing reads as an error
 * they have made.
 */
function ConversationSearch({ conversationId, onClose, onJump }: {
  conversationId: string; onClose: () => void; onJump: (messageId: string) => void;
}) {
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState('');
  const debounced = useDebounced(term, 250);

  useEffect(() => {
    const q = debounced.trim();
    if (q.length < 2) { setHits(null); setError(''); return; }
    const controller = new AbortController();
    get<{ results: SearchHit[] }>(
      `/chats/${conversationId}/search?q=${encodeURIComponent(q)}`, controller.signal)
      .then((d) => { setHits(d.results); setError(''); })
      .catch((err: Error) => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, [debounced, conversationId]);

  return (
    <div class="chat-search-panel">
      <div class="chat-search-row">
        <input type="search" autofocus class="chat-search" value={term}
               placeholder="Search in this conversation…" aria-label="Search in this conversation"
               onInput={(e) => setTerm((e.target as HTMLInputElement).value)}
               onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} />
        <button class="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      {error && <div class="chat-none">{error}</div>}
      {!error && debounced.trim().length >= 2 && hits?.length === 0 && (
        <div class="chat-none">Nothing in this conversation matches “{debounced.trim()}”.</div>
      )}
      {hits && hits.length > 0 && (
        <div class="chat-hits">
          <div class="chat-hits-count">
            {hits.length === 1 ? '1 message' : `${hits.length} messages`}, newest first
          </div>
          {hits.map((hit) => (
            <button key={hit.id} class="chat-hit" onClick={() => { onJump(hit.id); onClose(); }}>
              <span class="chat-hit-who">
                {hit.mine ? 'You' : hit.sender_name ?? 'Someone'} · {listTime(hit.created_at)}
              </span>
              <span class="chat-hit-text">{hit.snippet}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Writing ────────────────────────────────────────────────────────────────

function Composer({ conversation, meta, onSent }: {
  conversation: Conversation; meta: Meta | null; onSent: (message: ChatMessage) => void;
}) {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const lastPing = useRef(0);

  useEffect(() => { setBody(''); setFiles([]); lastPing.current = 0; }, [conversation.id]);

  /**
   * "Still typing", at most once every few seconds.
   *
   * Throttled by the server's own advertised interval rather than a number
   * picked here, so the two ends cannot drift into an indicator that flickers
   * or one that sticks.
   */
  const ping = () => {
    const interval = meta?.typing_ping_ms ?? 3000;
    if (Date.now() - lastPing.current < interval) return;
    lastPing.current = Date.now();
    void post(`/chats/${conversation.id}/typing`).catch(() => { lastPing.current = 0; });
  };

  if (!conversation.can_post) {
    return <div class="chat-closed">{conversation.post_refusal}</div>;
  }

  const send = async () => {
    if (busy || (!body.trim() && files.length === 0)) return;
    setBusy(true);
    try {
      let message: ChatMessage;
      if (files.length) {
        const form = new FormData();
        form.set('body', body.trim());
        for (const file of files) form.append('files', file);
        message = (await upload<{ message: ChatMessage }>(`/chats/${conversation.id}/messages`, form)).message;
      } else {
        message = (await post<{ message: ChatMessage }>(
          `/chats/${conversation.id}/messages`, { body: body.trim() })).message;
      }
      setBody('');
      setFiles([]);
      lastPing.current = 0;
      onSent(message);
      input.current?.focus();
    } catch (err) {
      // The text stays in the box on a failure. Retyping a paragraph because
      // the wifi dropped is the worst thing a chat can do to somebody.
      toast(err instanceof Error ? err.message : 'Could not send that.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const limit = meta?.attachment_max_bytes ?? 20 * 1024 * 1024;
    const chosen: File[] = [];
    for (const file of Array.from(list)) {
      if (file.size > limit) {
        toast(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ` +
              `${Math.round(limit / 1024 / 1024)} MB.`, 'error');
        continue;
      }
      chosen.push(file);
    }
    setFiles((current) => [...current, ...chosen].slice(0, 5));
  };

  return (
    <div class="chat-composer">
      {files.length > 0 && (
        <div class="chat-pending">
          {files.map((file, i) => (
            <span key={`${file.name}-${i}`} class="chat-pending-file">
              <Icon path={ICONS.documents} size={13} />
              {file.name}
              <button class="chat-pending-x" aria-label={`Remove ${file.name}`}
                      onClick={() => setFiles((c) => c.filter((_, n) => n !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      <div class="chat-composer-row">
        <input ref={picker} type="file" multiple hidden accept={meta?.attachment_accept}
               onChange={(e) => {
                 addFiles((e.target as HTMLInputElement).files);
                 (e.target as HTMLInputElement).value = '';
               }} />
        <button class="btn btn-ghost chat-attach" aria-label="Attach a file"
                onClick={() => picker.current?.click()}>
          <Icon path={ICONS.documents} size={17} />
        </button>
        <textarea ref={input} class="chat-input" rows={1} value={body} placeholder="Write a message…"
                  aria-label="Message"
                  onInput={(e) => {
                    const el = e.target as HTMLTextAreaElement;
                    setBody(el.value);
                    if (el.value.trim()) ping();
                    // Grow with the text, to a point — a composer that eats the
                    // conversation is worse than one that scrolls.
                    el.style.height = 'auto';
                    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
                  }}
                  onKeyDown={(e) => {
                    // Enter sends, Shift+Enter is a new line — the convention
                    // everybody already has in their fingers.
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                  }} />
        <button class="btn btn-primary chat-send" disabled={busy || (!body.trim() && !files.length)}
                onClick={send} aria-label="Send">
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

// ── Starting something ─────────────────────────────────────────────────────

/** A searchable list of the people this person is allowed to message. */
function NewChatModal({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get<{ contacts: Contact[] }>('/chats/contacts')
      .then((d) => setContacts(d.contacts))
      .catch((err: Error) => { setError(err.message); setContacts([]); });
  }, []);

  const filter = search.trim().toLowerCase();
  const shown = (contacts ?? []).filter((c) =>
    !filter || c.name.toLowerCase().includes(filter) || c.email.toLowerCase().includes(filter));

  const start = async (contact: Contact) => {
    setBusy(true);
    try {
      const data = await post<{ conversation: Conversation }>('/chats/direct', { user_id: contact.id });
      onOpened(data.conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start that chat.');
      setBusy(false);
    }
  };

  return (
    <Modal title="New chat" onClose={onClose}>
      {error && <div class="alert alert-error">{error}</div>}
      <input class="chat-search" type="search" autofocus placeholder="Search staff…" value={search}
             aria-label="Search staff"
             onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
      {contacts === null && <Skeleton rows={4} />}
      {contacts?.length === 0 && !error && (
        <Empty title="Nobody to message">
          Staff message an admin here. There is no admin set up for chats yet — a technical admin
          grants “Chat admin” under Staff.
        </Empty>
      )}
      <div class="chat-picker">
        {shown.map((c) => (
          <button key={c.id} class="chat-pick" disabled={busy} onClick={() => start(c)}>
            <Avatar name={c.name} src={c.photo_url} />
            <span class="chat-pick-text">
              <span class="cell-strong">{c.name}</span>
              <span class="text-sm text-muted">{c.email}</span>
            </span>
            {c.is_admin && <Badge tone="accent">Admin</Badge>}
            {c.unread > 0 && <span class="chat-unread">{badgeLabel(c.unread)}</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function NewGroupModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [everyoneCanPost, setEveryoneCanPost] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await post<{ conversation: Conversation }>('/chats/groups', {
        name, member_ids: chosen, everyone_can_post: everyoneCanPost,
      });
      toast(`“${data.conversation.title}” created.`, 'ok');
      onCreated(data.conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that group.');
      setBusy(false);
    }
  };

  return (
    <Modal title="New group" onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn btn-primary" disabled={busy || !name.trim()} onClick={create}>
          {busy ? 'Creating…' : 'Create group'}
        </button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}
      <Field label="Group name">
        <input value={name} autofocus maxLength={60} placeholder="Renewals push"
               onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="Members" hint="You are in it either way — a group nobody administers cannot be managed.">
        <StaffPicker chosen={chosen} onChange={setChosen} />
      </Field>
      <label class="row" style={{ gap: 9, margin: 0 }}>
        <Switch checked={everyoneCanPost} onChange={setEveryoneCanPost}
                label="Everyone in the group can post" />
        <span class="text-sm">
          <strong>{everyoneCanPost ? 'Everyone can post' : 'Only admins can post'}</strong>{' '}
          <span class="text-muted">— you can change this later.</span>
        </span>
      </label>
    </Modal>
  );
}

/** Type to filter, tick to include — the searchable multi-select this module needs. */
function StaffPicker({ chosen, onChange, exclude = [] }: {
  chosen: string[]; onChange: (ids: string[]) => void; exclude?: string[];
}) {
  const [people, setPeople] = useState<Array<{ id: string; name: string; email: string; role: string }> | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    get<{ staff: Array<{ id: string; name: string; email: string; role: string; status: string }> }>('/staff')
      .then((d) => setPeople(d.staff.filter((s) => s.status === 'active' || s.status === 'invited')))
      .catch(() => setPeople([]));
  }, []);

  const filter = search.trim().toLowerCase();
  const shown = (people ?? [])
    .filter((p) => !exclude.includes(p.id))
    .filter((p) => !filter || p.name.toLowerCase().includes(filter) || p.email.toLowerCase().includes(filter));

  const toggle = (id: string) =>
    onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);

  return (
    <div class="staff-picker">
      <input type="search" placeholder="Search staff…" value={search} aria-label="Search staff"
             onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
      <div class="staff-picker-list">
        {people === null && <Skeleton rows={3} height={30} />}
        {shown.length === 0 && people !== null && (
          <div class="text-sm text-muted" style={{ padding: 8 }}>Nobody matches that.</div>
        )}
        {shown.map((p) => (
          <label key={p.id} class="staff-pick">
            <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />
            <Avatar name={p.name} />
            <span class="staff-pick-text">
              <span>{p.name}</span>
              <span class="text-sm text-muted">{p.email}</span>
            </span>
          </label>
        ))}
      </div>
      {chosen.length > 0 && (
        <div class="text-sm text-muted">{chosen.length} selected</div>
      )}
    </div>
  );
}

/**
 * A picture, with the buttons to change or remove it.
 *
 * Exported because the profile screen uses exactly the same control for a
 * person's own picture — the endpoints differ, nothing else does.
 */
export function PhotoPicker({ name, src, accept, maxBytes, onUpload, onRemove, hint }: {
  name: string; src: string | null; accept?: string; maxBytes?: number; hint?: string;
  onUpload: (file: File) => Promise<void>; onRemove: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const limit = maxBytes ?? 4 * 1024 * 1024;

  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    try { await what(); } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change that picture.', 'error');
    } finally { setBusy(false); }
  };

  return (
    <div class="photo-picker">
      <span class="photo-picker-face">
        <Avatar name={name} src={src} />
      </span>
      <div class="photo-picker-side">
        <div class="row" style={{ gap: 6 }}>
          <input ref={picker} type="file" hidden accept={accept ?? 'image/*'}
                 onChange={(e) => {
                   const el = e.target as HTMLInputElement;
                   const file = el.files?.[0];
                   el.value = '';
                   if (!file) return;
                   if (file.size > limit) {
                     toast(`That picture is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ` +
                           `${Math.round(limit / 1024 / 1024)} MB. Resize it and try again.`, 'error');
                     return;
                   }
                   void run(() => onUpload(file));
                 }} />
          <button class="btn btn-sm" disabled={busy} onClick={() => picker.current?.click()}>
            {src ? 'Change picture' : 'Upload a picture'}
          </button>
          {src && (
            <button class="btn btn-sm btn-ghost" disabled={busy} onClick={() => void run(onRemove)}>
              Remove
            </button>
          )}
        </div>
        <span class="text-sm text-muted">
          {hint ?? `JPEG, PNG, WebP or HEIC, up to ${Math.round(limit / 1024 / 1024)} MB.`}
        </span>
      </div>
    </div>
  );
}

// ── Running a group ────────────────────────────────────────────────────────

function ManageGroup({ conversation, members, meta, session, onClose, onChanged, onRemoved }: {
  conversation: Conversation; members: Member[]; meta: Meta | null; session: Session;
  onClose: () => void; onChanged: (members: Member[]) => void; onRemoved: () => void;
}) {
  const [name, setName] = useState(conversation.name ?? '');
  const [adding, setAdding] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (what: () => Promise<{ members?: Member[] }>, done: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await what();
      if (result.members) onChanged(result.members);
      else onChanged(members);
      toast(done, 'ok');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not do that.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remove “${conversation.title}”? Everybody stops seeing it. The messages are kept.`)) return;
    setBusy(true);
    try {
      await del(`/chats/${conversation.id}`);
      toast(`“${conversation.title}” removed.`, 'ok');
      onRemoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that group.');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Manage ${conversation.title}`} onClose={onClose} wide footer={
      <>
        {conversation.can_delete && (
          <button class="btn btn-danger" disabled={busy} onClick={remove}
                  style={{ marginRight: 'auto' }}>Remove group</button>
        )}
        <button class="btn" onClick={onClose}>Done</button>
      </>
    }>
      {error && <div class="alert alert-error">{error}</div>}

      <Field label="Group picture">
        <PhotoPicker
          name={conversation.title} src={conversation.photo_url}
          accept={meta?.photo_accept} maxBytes={meta?.photo_max_bytes}
          hint="Everybody in the group sees it. Without one, the group wears its icon."
          onUpload={async (file) => {
            const form = new FormData();
            form.set('photo', file);
            await upload(`/chats/${conversation.id}/photo`, form, undefined, 'PUT');
            toast('Picture updated.', 'ok');
            onChanged(members);
          }}
          onRemove={async () => {
            await del(`/chats/${conversation.id}/photo`);
            toast('Picture removed.', 'ok');
            onChanged(members);
          }} />
      </Field>

      <Field label="Group name">
        <div class="row" style={{ gap: 6 }}>
          <input value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <button class="btn" disabled={busy || !name.trim() || name.trim() === conversation.name}
                  onClick={() => run(
                    () => patch(`/chats/${conversation.id}`, { name }), 'Renamed.')}>Rename</button>
        </div>
      </Field>

      <label class="row" style={{ gap: 9, margin: '4px 0 0' }}>
        <Switch checked={conversation.everyone_can_post} disabled={busy}
                label="Everyone in the group can post"
                onChange={(value) => void run(
                  () => patch(`/chats/${conversation.id}`, { everyone_can_post: value }),
                  value ? 'Open to everyone.' : 'Closed to admins.')} />
        <span class="text-sm">
          <strong>{conversation.everyone_can_post ? 'Everyone can post' : 'Only admins can post'}</strong>{' '}
          <span class="text-muted">
            {conversation.everyone_can_post
              ? '— anybody in the group can write here.'
              : '— it reads as an announcement channel.'}
          </span>
        </span>
      </label>
      {conversation.kind === 'community' && (
        <p class="text-sm text-muted" style={{ marginTop: 4 }}>
          Everybody is in this group and nobody can leave it. New staff join automatically.
        </p>
      )}

      <div class="card" style={{ marginTop: 14 }}>
        <div class="card-head"><h2>Members ({members.length})</h2></div>
        <div class="chat-members">
          {members.map((m) => (
            <div key={m.id} class="chat-member">
              <Avatar name={m.name} src={m.photo_url} />
              <span class="chat-member-text">
                <span class="cell-strong">{m.name}{m.is_you ? ' (you)' : ''}</span>
                <span class="text-sm text-muted">{m.email}</span>
              </span>
              {m.is_admin && <Badge tone="accent">Admin</Badge>}
              {!m.is_you && (
                <button class="btn btn-ghost btn-sm" disabled={busy}
                        onClick={() => run(
                          () => del<{ members: Member[] }>(`/chats/${conversation.id}/members/${m.id}`),
                          `${m.name} removed.`)}>Remove</button>
              )}
            </div>
          ))}
        </div>
      </div>

      <Field label="Add members">
        <StaffPicker chosen={adding} onChange={setAdding} exclude={members.map((m) => m.id)} />
      </Field>
      <button class="btn btn-primary" disabled={busy || adding.length === 0}
              onClick={() => run(async () => {
                const result = await post<{ members: Member[] }>(
                  `/chats/${conversation.id}/members`, { user_ids: adding });
                setAdding([]);
                return result;
              }, 'Added.')}>
        Add {adding.length || ''} to the group
      </button>

      <p class="text-sm text-muted" style={{ marginTop: 12, marginBottom: 0 }}>
        Signed in as {session.user.name}. Adding and removing people is recorded in the activity log;
        what is said in the group is not.
      </p>
    </Modal>
  );
}
