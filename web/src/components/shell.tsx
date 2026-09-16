/** The frame: navigation, top bar, command palette, notifications. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { get, post, relativeTime } from '../lib/api.ts';
import { navigate, useRoute, useTheme, type Session, type Config } from '../lib/store.ts';
import { Avatar, Icon, ICONS } from './ui.tsx';
import { AppointmentPrompts } from './appointment-prompts.tsx';
import { useChatUnread } from '../lib/chat-live.ts';

type NavEntry = {
  path: string; label: string; icon: string; permission?: string; mobile?: boolean;
  /** Shown in the bottom bar on a phone, where the full label does not fit. */
  mobileLabel?: string;
  /** Draws the unread count beside the label, WhatsApp-style. */
  badge?: 'chat';
};

const NAV: Array<{ section?: string; items: NavEntry[] }> = [
  {
    items: [
      { path: '/', label: 'Dashboard', icon: ICONS.dashboard, mobile: true },
      { path: '/customers', label: 'Customers', icon: ICONS.customers, permission: 'customer.view', mobile: true },
      { path: '/pipeline', label: 'Pipeline', icon: ICONS.board, permission: 'customer.view' },
      { path: '/tasks', label: 'Tasks', icon: ICONS.tasks, permission: 'task.view', mobile: true },
      { path: '/appointments', label: 'Appointments', icon: ICONS.calendar, permission: 'appointment.view', mobile: true },
    ],
  },
  {
    section: 'Work',
    items: [
      { path: '/messages', label: 'Messages', icon: ICONS.messages, permission: 'message.view', mobile: true },
      { path: '/chats', label: 'LM Chats', icon: ICONS.staff, permission: 'chat.use',
        badge: 'chat', mobile: true, mobileLabel: 'Chats' },
      { path: '/documents', label: 'Documents', icon: ICONS.documents, permission: 'document.view' },
      { path: '/required-documents', label: 'Required documents', icon: ICONS.checklist, permission: 'required_document.view' },
      { path: '/automations', label: 'Automations', icon: ICONS.automations, permission: 'automation.view' },
      { path: '/campaigns', label: 'Campaigns', icon: ICONS.campaigns, permission: 'campaign.view' },
      { path: '/renewals', label: 'Renewals', icon: ICONS.renewals, permission: 'customer.view' },
    ],
  },
  {
    section: 'Oversight',
    items: [
      { path: '/compliance', label: 'Compliance', icon: ICONS.compliance, permission: 'compliance.view' },
      { path: '/reports', label: 'Reports', icon: ICONS.reports, permission: 'report.view' },
      { path: '/activity', label: 'Activity logs', icon: ICONS.activity },
      { path: '/pipelines', label: 'Manage pipelines', icon: ICONS.board, permission: 'pipeline.view' },
      { path: '/staff', label: 'Staff', icon: ICONS.staff, permission: 'user.view' },
      { path: '/integrations', label: 'Integrations', icon: ICONS.integrations, permission: 'settings.view' },
      { path: '/api-access', label: 'API access', icon: ICONS.key, permission: 'api_key.manage' },
      { path: '/settings', label: 'Settings', icon: ICONS.settings, permission: 'settings.view' },
    ],
  },
];

const visible = (items: NavEntry[], permissions: string[]) =>
  items.filter((i) => !i.permission || permissions.includes(i.permission));

const isCurrent = (path: string, current: string) =>
  path === '/' ? current === '/' : current === path || current.startsWith(`${path}/`);

export function Shell({ session, config, onSignOut, children }: {
  session: Session; config: Config | null; onSignOut: () => void; children: ComponentChildren;
}) {
  const { path } = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
      // A bare "/" opens search the way it does in every tool a broker already
      // uses — but not while they are typing into a field.
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const mobileItems = NAV.flatMap((g) => g.items).filter((i) => i.mobile);

  // One stream for the tab, opened only for somebody who has chats at all.
  const chatUnread = useChatUnread(session.permissions.includes('chat.use'));
  const badgeFor = (item: NavEntry) => (item.badge === 'chat' ? chatUnread : 0);

  return (
    <div class="shell">
      <nav class="sidebar" aria-label="Main">
        <div class="brand">
          <span class="brand-mark">L</span>
          <span>Lendmax</span>
        </div>
        {NAV.map((group, gi) => {
          const items = visible(group.items, session.permissions);
          if (!items.length) return null;
          return (
            <div key={gi}>
              {group.section && <div class="nav-section">{group.section}</div>}
              {items.map((item) => {
                const unread = badgeFor(item);
                return (
                  <a key={item.path} class="nav-item" href={`/crm${item.path}`}
                     aria-current={isCurrent(item.path, path) ? 'page' : undefined}
                     onClick={(e) => { e.preventDefault(); navigate(item.path); }}>
                    <Icon path={item.icon} />
                    <span>{item.label}</span>
                    {unread > 0 && (
                      <span class="nav-count" aria-label={`${unread} unread`}>
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div class="main">
        <TopBar session={session} onSignOut={onSignOut} onSearch={() => setPaletteOpen(true)} />
        <main class="content">{children}</main>
      </div>
      <AppointmentPrompts session={session} />

      <nav class="mobile-nav" aria-label="Main">
        {visible(mobileItems, session.permissions).map((item) => {
          const unread = badgeFor(item);
          return (
            <button key={item.path} class="mobile-nav-item"
                    aria-current={isCurrent(item.path, path) ? 'page' : undefined}
                    onClick={() => navigate(item.path)}>
              <span class="mobile-nav-icon">
                <Icon path={item.icon} size={19} />
                {unread > 0 && <span class="nav-dot" aria-label={`${unread} unread`} />}
              </span>
              <span>{item.mobileLabel ?? item.label}</span>
            </button>
          );
        })}
        <button class="mobile-nav-item" onClick={() => setPaletteOpen(true)}>
          <Icon path={ICONS.search} size={19} />
          <span>Search</span>
        </button>
      </nav>

      {paletteOpen && (
        <CommandPalette config={config} permissions={session.permissions}
                        onClose={() => setPaletteOpen(false)} />
      )}
    </div>
  );
}

function TopBar({ session, onSignOut, onSearch }: {
  session: Session; onSignOut: () => void; onSearch: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await get<{ unread: number }>('/notifications');
        if (!cancelled) setUnread(data.unread);
      } catch { /* the bell is not worth an error message */ }
    };
    void poll();
    const id = setInterval(poll, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return (
    <header class="topbar">
      <button class="search btn-ghost" onClick={onSearch}
              style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer' }}
              aria-label="Search customers and commands">
        <div class="search" style={{ pointerEvents: 'none' }}>
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input placeholder="Search clients, addresses, references…" readOnly tabIndex={-1} />
          <span class="kbd">⌘K</span>
        </div>
      </button>

      <div class="spacer" />

      <div style={{ position: 'relative' }}>
        <button class="btn btn-ghost" onClick={() => { setNotifOpen((v) => !v); setMenuOpen(false); }}
                aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
          <Icon path={ICONS.bell} />
          {unread > 0 && <span class="dot-indicator" />}
        </button>
        {notifOpen && <Notifications onClose={() => { setNotifOpen(false); setUnread(0); }} />}
      </div>

      <div style={{ position: 'relative' }}>
        <button class="btn btn-ghost" onClick={() => { setMenuOpen((v) => !v); setNotifOpen(false); }}
                aria-haspopup="menu" aria-expanded={menuOpen} style={{ gap: 8 }}>
          <Avatar name={session.user.name}
                  src={(session.profile as { photo?: string | null } | null)?.photo ?? null} />
          <span style={{ fontWeight: 550 }}>{session.user.name}</span>
        </button>
        {menuOpen && (
          <div class="menu" role="menu">
            <div style={{ padding: '7px 9px' }}>
              <div style={{ fontWeight: 570 }}>{session.user.name}</div>
              <div class="text-sm text-muted">{session.user.email}</div>
              <div class="text-sm text-muted">{session.user.role_name}</div>
            </div>
            <div class="menu-sep" />
            <button class="menu-item" role="menuitem"
                    onClick={() => { setMenuOpen(false); navigate('/profile'); }}>
              Your profile
            </button>
            <div class="menu-sep" />
            <div class="menu-label">Theme</div>
            {(['light', 'dark', 'system'] as const).map((t) => (
              <button key={t} class="menu-item" role="menuitemradio" aria-checked={theme === t}
                      onClick={() => setTheme(t)}>
                <span style={{ width: 14 }}>{theme === t ? '✓' : ''}</span>
                <span style={{ textTransform: 'capitalize' }}>{t}</span>
              </button>
            ))}
            <div class="menu-sep" />
            <button class="menu-item" role="menuitem" onClick={onSignOut}>Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}

function Notifications({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Array<Record<string, unknown>> | null>(null);

  useEffect(() => {
    get<{ notifications: Array<Record<string, unknown>> }>('/notifications')
      .then((d) => setItems(d.notifications))
      .catch(() => setItems([]));
  }, []);

  const markAll = async () => {
    try { await post('/notifications/read', {}); } catch { /* ignore */ }
    onClose();
  };

  return (
    <div class="menu" style={{ width: 330 }} role="dialog" aria-label="Notifications">
      <div class="row-between" style={{ padding: '7px 9px' }}>
        <strong style={{ fontSize: 13 }}>Notifications</strong>
        <button class="btn btn-ghost btn-sm" onClick={markAll}>Mark all read</button>
      </div>
      <div class="menu-sep" />
      {items === null && <div style={{ padding: 14 }} class="text-muted text-sm">Loading…</div>}
      {items?.length === 0 && (
        <div style={{ padding: '18px 14px' }} class="text-muted text-sm">
          Nothing new. Assignments, client replies and uploaded documents show up here.
        </div>
      )}
      {items?.map((n) => (
        <button key={String(n.id)} class="menu-item" style={{ alignItems: 'flex-start' }}
                onClick={() => {
                  if (typeof n.link === 'string' && n.link.startsWith('/')) {
                    navigate(n.link);
                  } else if (n.entity_type === 'application' && n.entity_id) {
                    navigate(`/applications/${n.entity_id}`);
                  }
                  onClose();
                }}>
          <div>
            <div style={{ fontWeight: n.read_at ? 400 : 600 }}>{String(n.title)}</div>
            {n.body ? <div class="text-sm text-muted">{String(n.body)}</div> : null}
            <div class="text-sm text-muted">{relativeTime(n.at as string)}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

type PaletteItem = { id: string; label: string; hint?: string; run: () => void };

function CommandPalette({ config, permissions, onClose }: {
  config: Config | null; permissions: string[]; onClose: () => void;
}) {
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<Array<Record<string, unknown>>>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Customer search is debounced and abortable: without the abort a slow early
  // response can land after a fast later one and show the wrong rows.
  useEffect(() => {
    if (term.trim().length < 2 || !permissions.includes('customer.view')) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const id = setTimeout(() => {
      get<{ customers: Array<Record<string, unknown>> }>(
        `/customers?q=${encodeURIComponent(term)}&limit=6`, controller.signal,
      ).then((d) => setResults(d.customers)).catch(() => { /* typing */ });
    }, 180);
    return () => { clearTimeout(id); controller.abort(); };
  }, [term, permissions]);

  const commands = useMemo<PaletteItem[]>(() => {
    const all: Array<PaletteItem & { permission?: string }> = [
      { id: 'go-dash', label: 'Go to Dashboard', hint: 'Navigate', run: () => navigate('/') },
      { id: 'go-cust', label: 'Go to Customers', hint: 'Navigate', permission: 'customer.view', run: () => navigate('/customers') },
      { id: 'go-pipe', label: 'Go to Pipeline', hint: 'Navigate', permission: 'customer.view', run: () => navigate('/pipeline') },
      { id: 'go-pipelines', label: 'Manage pipelines', hint: 'Navigate', permission: 'pipeline.view', run: () => navigate('/pipelines') },
      { id: 'go-appointments', label: 'Go to Appointments', hint: 'Navigate', permission: 'appointment.view', run: () => navigate('/appointments') },
      { id: 'new-appointment', label: 'Book an appointment', hint: 'Create', permission: 'appointment.manage', run: () => navigate('/appointments?new=1') },
      { id: 'go-tasks', label: 'Go to Tasks', hint: 'Navigate', permission: 'task.view', run: () => navigate('/tasks') },
      { id: 'new-cust', label: 'New customer', hint: 'Create', permission: 'customer.create', run: () => navigate('/customers?new=1') },
      { id: 'go-messages', label: 'Go to Messages', hint: 'Navigate', permission: 'message.view', run: () => navigate('/messages') },
      { id: 'go-docs', label: 'Go to Documents', hint: 'Navigate', permission: 'document.view', run: () => navigate('/documents') },
      { id: 'go-required-docs', label: 'Go to Required documents', hint: 'Navigate', permission: 'required_document.view', run: () => navigate('/required-documents') },
      { id: 'go-activity', label: 'Go to Activity logs', hint: 'Navigate', run: () => navigate('/activity') },
      { id: 'go-reports', label: 'Go to Reports', hint: 'Navigate', permission: 'report.view', run: () => navigate('/reports') },
      { id: 'go-auto', label: 'Go to Automations', hint: 'Navigate', permission: 'automation.view', run: () => navigate('/automations') },
      { id: 'new-auto', label: 'New automation', hint: 'Create', permission: 'automation.edit', run: () => navigate('/automations?new=1') },
      { id: 'go-compliance', label: 'Go to Compliance', hint: 'Navigate', permission: 'compliance.view', run: () => navigate('/compliance') },
      { id: 'go-settings', label: 'Go to Settings', hint: 'Navigate', permission: 'settings.view', run: () => navigate('/settings') },
      { id: 'go-staff', label: 'Go to Staff', hint: 'Navigate', permission: 'user.view', run: () => navigate('/staff') },
      { id: 'go-api', label: 'Go to API access', hint: 'Navigate', permission: 'api_key.manage', run: () => navigate('/api-access') },
    ];
    return all.filter((c) => !c.permission || permissions.includes(c.permission));
  }, [permissions]);

  const filteredCommands = commands.filter((c) =>
    c.label.toLowerCase().includes(term.toLowerCase()));

  const items: PaletteItem[] = [
    ...results.map((r) => ({
      id: `cust-${String(r.id)}`,
      label: `${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim() || 'Unnamed',
      hint: [r.stage_label, r.property_city].filter(Boolean).join(' · '),
      run: () => navigate(`/applications/${String(r.id)}`),
    })),
    ...filteredCommands,
  ];

  useEffect(() => { setActive(0); }, [term]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      items[active]?.run();
      onClose();
    }
  };

  return (
    <div class="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Search and commands">
        <input ref={inputRef} value={term} onKeyDown={onKey}
               onInput={(e) => setTerm((e.target as HTMLInputElement).value)}
               placeholder="Search clients, addresses, references, or type a command…"
               aria-label="Search" role="combobox" aria-expanded aria-controls="palette-results" />
        <div class="palette-results" id="palette-results" role="listbox">
          {items.length === 0 && (
            <div style={{ padding: '18px 14px' }} class="text-muted text-sm">
              {term.trim().length < 2
                ? 'Type at least two characters to search clients, or pick a command.'
                : `Nothing matches “${term}”.`}
            </div>
          )}
          {items.map((item, i) => (
            <button key={item.id} class="palette-item" data-active={i === active}
                    role="option" aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => { item.run(); onClose(); }}>
              <span>{item.label}</span>
              {item.hint && <span class="hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
