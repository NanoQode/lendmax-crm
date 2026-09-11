/** Shared presentational pieces. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
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

export function Avatar({ name, title }: { name: string; title?: string }) {
  return (
    <span class="avatar" style={{ background: avatarColour(name) }} title={title ?? name}
          aria-label={title ?? name}>
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

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
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
export function Modal({ title, onClose, children, footer }: {
  title: string; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    const focusable = ref.current?.querySelector<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
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
  }, [onClose]);

  return (
    <div class="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal" ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <div class="modal-head"><h2>{title}</h2></div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, error, hint, children }: {
  label: string; error?: string; hint?: string; children: ComponentChildren;
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
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  plus: 'M12 5v14M5 12h14',
  back: 'M19 12H5M12 19l-7-7 7-7',
  integrations: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
};
