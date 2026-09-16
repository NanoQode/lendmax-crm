/** Shared presentational pieces. */
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { avatarColour, initials } from '../lib/api.ts';

export function Badge({ tone = 'neutral', children }: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';
  children: ComponentChildren;
}) {
  return <span class={`badge${tone === 'neutral' ? '' : ` badge-${tone}`}`}>{children}</span>;
}

/**
 * Days to close.
 *
 * The label is always rendered; the dot is reinforcement. A CRM that says
 * "urgent" only in red is a CRM one broker in twelve cannot read.
 *
 * `settled` is not cosmetic. A funded file's closing date is in the past
 * because it closed — flagging that in red as "passed 21 days ago" trains
 * people to ignore the colour that is supposed to mean a deal is in trouble.
 */
export function Urgency({ value, settled = false }: {
  value: { days: number | null; urgency: string; label: string } | null | undefined;
  settled?: boolean;
}) {
  if (!value) return <span class="text-muted">—</span>;
  if (settled) {
    return (
      <span class="urgency urgency-none">
        <span class="dot" aria-hidden="true" />
        <span>{value.days === null ? 'No closing date' : 'Closed'}</span>
      </span>
    );
  }
  return (
    <span class={`urgency urgency-${value.urgency}`}>
      <span class="dot" aria-hidden="true" />
      <span>{value.label}</span>
    </span>
  );
}

/**
 * A person, as a face or as their initials.
 *
 * `src` is a picture they have uploaded. Everybody starts without one, so the
 * coloured initials are the normal case rather than a fallback for failure —
 * and if a picture ever fails to load, it quietly becomes them again.
 */
export function Avatar({ name, title, src }: { name: string; title?: string; src?: string | null }) {
  const [broken, setBroken] = useState(false);
  const label = title ?? name;
  if (src && !broken) {
    return (
      <img class="avatar avatar-photo" src={src} alt="" title={label} aria-label={label}
           loading="lazy" onError={() => setBroken(true)} />
    );
  }
  return (
    <span class="avatar" style={{ background: avatarColour(name) }} title={label} aria-label={label}>
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ people }: { people: Array<{ name: string; role?: string }> }) {
  if (!people.length) return <span class="text-muted">Unassigned</span>;
  return (
    <span class="avatar-stack">
      {people.slice(0, 3).map((p) => (
        <Avatar key={p.name + (p.role ?? '')} name={p.name}
                title={p.role ? `${p.name} — ${p.role}` : p.name} />
      ))}
      {people.length > 3 && (
        <span class="avatar" style={{ background: 'var(--grey-400)' }}
              title={people.slice(3).map((p) => p.name).join(', ')}>
          +{people.length - 3}
        </span>
      )}
    </span>
  );
}

export function Empty({ title, children, action }: {
  title: string; children?: ComponentChildren; action?: ComponentChildren;
}) {
  return (
    <div class="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

export function Skeleton({ rows = 5, height = 34 }: { rows?: number; height?: number }) {
  return (
    <div class="stack" style={{ gap: 8, padding: 14 }} aria-busy="true" aria-live="polite">
      <span class="visually-hidden">Loading</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} class="skeleton" style={{ height, width: i % 3 === 2 ? '72%' : '100%' }} />
      ))}
    </div>
  );
}

/**
 * A failure, shown as what it actually is.
 *
 * A refusal is not a fault. "Your account cannot open this" in a calm panel
 * with no retry button is the truth; the same thing in red with "Try again"
 * invites somebody to click it five times and then phone the office. Only a
 * genuine fault gets the red treatment, which is what keeps the red
 * treatment meaning something.
 */
export function ErrorNote({ error, onRetry, code, permission }: {
  error: string; onRetry?: () => void; code?: string; permission?: string;
}) {
  const refused = code === 'forbidden' || code === 'not_found';

  if (refused) {
    return (
      <div class="card">
        <div class="empty">
          <h3>{code === 'not_found' ? 'Not here' : 'Not something your account can open'}</h3>
          <p>{error}</p>
          {permission && (
            <p class="text-sm text-subtle">
              The permission is <code>{permission}</code>.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div class="alert alert-error" role="alert">
      <div>{error}</div>
      {onRetry && (
        <button class="btn btn-sm" style={{ marginTop: 9 }} onClick={onRetry}>Try again</button>
      )}
    </div>
  );
}

/**
 * A modal that behaves like one: Escape closes it, focus moves inside on open
 * and back to the trigger on close, and a click on the backdrop dismisses it.
 */
export function Modal({ title, onClose, children, footer, wide = false }: {
  title: string; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  // The latest close handler, read at key time. Depending on it directly
  // re-ran the setup below on every parent render — and the setup moves focus
  // to the first field, so typing in the third field jumped back to the first.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    const focusable = ref.current?.querySelector<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    const onKey = (e: KeyboardEvent) => {
      // Only the topmost dialog answers the keyboard: Escape in a dialog opened
      // from another closes that one, not both.
      const open = document.querySelectorAll('.modal');
      if (open[open.length - 1] !== ref.current) return;
      // Escape inside an open dropdown closes the dropdown, not the dialog
      // around it — the dropdown's own handler deals with it.
      if (e.key === 'Escape' && (e.target as HTMLElement)?.closest?.('[data-popover-open="true"]')) return;
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); }
      if (e.key === 'Tab' && ref.current) {
        // Trap: without it, Tab walks out of the dialog into the page behind,
        // which for a screen-reader user means the dialog silently vanishes.
        const items = [...ref.current.querySelectorAll<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]',
        )];
        if (!items.length) return;
        const first = items[0]!, last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      returnTo.current?.focus?.();
    };
  }, []);

  return (
    <div class="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class={`modal${wide ? ' modal-wide' : ''}`} ref={ref} role="dialog" aria-modal="true"
           aria-label={title}>
        <div class="modal-head"><h2>{title}</h2></div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, error, hint, children }: {
  // Rich rather than a plain string: the application form hangs a "corrected
  // by the brokerage · undo" marker off the label of the field it belongs to.
  label: ComponentChildren; error?: string; hint?: string; children: ComponentChildren;
}) {
  return (
    <div class="field">
      <label>{label}</label>
      {children}
      {hint && !error && <div class="text-sm text-muted" style={{ marginTop: 4 }}>{hint}</div>}
      {error && <div class="field-error">{error}</div>}
    </div>
  );
}

// ── Searchable select ──────────────────────────────────────────────────────

export type SelectOption = { value: string; label: string; hint?: string; disabled?: boolean };

/** Case- and accent-insensitive, so "gagnon" finds "Gagnón" and "mc" finds "McKay". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * The dropdown every select in the CRM uses: type to filter, arrow keys to
 * move, Enter to choose, Escape to close. A plain <select> cannot be searched,
 * and a staff list or a list of lenders is long enough that scrolling it is
 * the slow part of the job.
 *
 * The panel is position: fixed, placed against the trigger, so it is never
 * clipped by the scrolling body of a modal; it opens upwards when there is no
 * room below.
 */
export function SearchSelect({
  value, options, onChange, placeholder = 'Choose…', searchPlaceholder = 'Type to search…',
  ariaLabel, id, disabled = false, invalid = false, emptyText = 'Nothing matches that.',
}: {
  value: string | null | undefined;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; max: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useMemo(() => `ss-${Math.random().toString(36).slice(2, 9)}`, []);

  const selected = options.find((o) => o.value === value);
  const needle = fold(term.trim());
  const filtered = needle
    ? options.filter((o) => fold(`${o.label} ${o.hint ?? ''}`).includes(needle))
    : options;

  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 10;
    const above = r.top - 10;
    const up = below < 240 && above > below;
    setPos({
      left: Math.min(r.left, window.innerWidth - Math.max(r.width, 240) - 8),
      width: Math.max(r.width, 240),
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      max: Math.max(160, Math.min(340, up ? above : below)),
    });
  };

  const openPanel = (initial = '') => {
    if (disabled) return;
    place();
    setTerm(initial);
    const index = options.findIndex((o) => o.value === value);
    setActive(initial ? 0 : Math.max(0, index));
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    const onMove = (e: Event) => {
      // Scrolling the list itself is not a reason to reposition it.
      if (panelRef.current?.contains(e.target as Node)) return;
      place();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  useEffect(() => {
    panelRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (o: SelectOption) => {
    if (o.disabled) return;
    onChange(o.value);
    close();
  };

  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(filtered.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = filtered[active]; if (o) choose(o); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
  };

  const onTriggerKey = (e: KeyboardEvent) => {
    if (open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPanel();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Typing on the closed control starts a search, the way a native
      // select jumps to a letter.
      e.preventDefault();
      openPanel(e.key);
    }
  };

  return (
    <div class="ss" data-popover-open={open ? 'true' : undefined}>
      <button type="button" ref={triggerRef} id={id} disabled={disabled}
              class={`ss-trigger${invalid ? ' ss-invalid' : ''}`}
              aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
              aria-invalid={invalid || undefined}
              onClick={() => (open ? close() : openPanel())} onKeyDown={onTriggerKey}>
        <span class={selected ? 'ss-value' : 'ss-value ss-placeholder'}>
          {selected?.label ?? placeholder}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && pos && (
        <div ref={panelRef} class="ss-panel" data-popover-open="true"
             style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}>
          <input ref={inputRef} class="ss-search" value={term} placeholder={searchPlaceholder}
                 role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
                 aria-label={ariaLabel ? `Search ${ariaLabel.toLowerCase()}` : 'Search'}
                 aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
                 onInput={(e) => { setTerm((e.target as HTMLInputElement).value); setActive(0); }}
                 onKeyDown={onSearchKey} />
          <ul id={listId} role="listbox" class="ss-list" style={{ maxHeight: pos.max - 46 }}>
            {filtered.length === 0 && <li class="ss-empty">{emptyText}</li>}
            {filtered.map((o, i) => (
              <li key={o.value} id={`${listId}-${i}`} data-index={i} role="option"
                  aria-selected={o.value === value} aria-disabled={o.disabled || undefined}
                  class="ss-option" data-active={i === active}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); choose(o); }}>
                <span class="ss-check" aria-hidden="true">{o.value === value ? '✓' : ''}</span>
                <span class="ss-label">{o.label}</span>
                {o.hint && <span class="ss-hint">{o.hint}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** An on/off control that says what it is to a screen reader. */
export function Switch({ checked, onChange, label, disabled = false }: {
  checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean;
}) {
  return (
    <button type="button" role="switch" class="switch" aria-checked={checked} aria-label={label}
            disabled={disabled} onClick={(e) => { e.stopPropagation(); onChange(!checked); }}>
      <span class="switch-thumb" aria-hidden="true" />
    </button>
  );
}

export const Icon = ({ path, size = 16 }: { path: string; size?: number }) => (
  <svg class="nav-icon" width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true">
    <path d={path} />
  </svg>
);

export const ICONS = {
  dashboard: 'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
  customers: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87',
  board: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z',
  tasks: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  documents: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  compliance: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  renewals: 'M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4M21 3v5h-5M3 21v-5h5',
  reports: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  automations: 'M13 2L3 14h8l-1 8 10-12h-8z',
  campaigns: 'M3 11l18-8-8 18-2-7-8-3z',
  messages: 'M21 11.5a8.4 8.4 0 01-9 8.4 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.2a8.4 8.4 0 01-.9-3.8 8.4 8.4 0 018.4-9h.5a8.4 8.4 0 018 8v.5z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  plus: 'M12 5v14M5 12h14',
  back: 'M19 12H5M12 19l-7-7 7-7',
  integrations: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  staff: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  checklist: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 13l2 2 4-4',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
};
