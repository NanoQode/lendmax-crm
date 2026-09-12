/** Routing, sign-in, and the screens that are not yet their own module. */
import { useState } from 'preact/hooks';
import { ApiError, patch, post, put, relativeTime } from './lib/api.ts';
import {
  navigate, toast, useAsync, useRoute, useSession, useToasts,
  type Config, type Session,
} from './lib/store.ts';
import { Shell } from './components/shell.tsx';
import { Badge, Empty, ErrorNote, Field, Icon, ICONS, Skeleton } from './components/ui.tsx';
import { DashboardPage } from './pages/dashboard.tsx';
import { CustomersPage, PipelinePage } from './pages/customers.tsx';
import { ClientPage } from './pages/client.tsx';
import { IntegrationsPage } from './pages/integrations.tsx';
import { AutomationsPage } from './pages/automations.tsx';
import { CompliancePage } from './pages/compliance.tsx';
import { RenewalsPage } from './pages/funding.tsx';
import { ReportsPage } from './pages/reports.tsx';
import { CalendarPage } from './pages/calendar.tsx';
import { CampaignsPage } from './pages/campaigns.tsx';
import { SettingsAdminPage } from './pages/settings-admin.tsx';
import { DocumentsPage } from './pages/documents.tsx';
import { MessagesPage } from './pages/messages.tsx';

export function App() {
  const { state, reload, signOut } = useSession();
  const toasts = useToasts();

  return (
    <>
      {state.status === 'loading' && (
        <div class="login-page"><div class="login-card"><Skeleton rows={4} /></div></div>
      )}
      {state.status === 'anonymous' && <LoginPage onSignedIn={reload} />}
      {state.status === 'ready' && (
        <Shell session={state.session} config={state.config} onSignOut={signOut}>
          <Routes session={state.session} config={state.config} onProfileSaved={reload} />
        </Shell>
      )}

      <div class="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} class={`toast${t.tone === 'error' ? ' toast-error' : t.tone === 'ok' ? ' toast-ok' : ''}`}>
            {t.message}
          </div>
        ))}
      </div>
    </>
  );
}

function Routes({ session, config, onProfileSaved }: {
  session: Session; config: Config | null; onProfileSaved: () => void;
}) {
  const { path } = useRoute();

  // Nothing is sent to a client from an account with no signature, so the
  // profile is the first thing a new user sees — and the only thing, until it
  // is done.
  if (!session.user.profile_complete && path !== '/profile') {
    navigate('/profile', true);
    return null;
  }

  const client = path.match(/^\/applications\/([0-9a-f-]{36})$/i);
  if (client) return <ClientPage id={client[1]!} session={session} config={config} />;

  switch (path) {
    case '/': return <DashboardPage session={session} />;
    case '/customers': return <CustomersPage session={session} config={config} />;
    case '/pipeline': return <PipelinePage session={session} />;
    case '/tasks': return <TasksPage session={session} />;
    case '/profile': return <ProfilePage session={session} onSaved={onProfileSaved} />;
    case '/integrations': return <IntegrationsPage session={session} />;
    case '/settings': return <SettingsAdminPage session={session} config={config} />;
    case '/documents': return <DocumentsPage session={session} />;
    case '/messages': return <MessagesPage session={session} />;
    case '/automations': return <AutomationsPage session={session} />;
    case '/campaigns': return <CampaignsPage session={session} />;
    case '/renewals': return <RenewalsPage session={session} />;
    case '/compliance': return <CompliancePage session={session} />;
    case '/reports': return <ReportsPage session={session} />;
    case '/calendar': return <CalendarPage session={session} />;
    default:
      return (
        <Empty title="No such page"
               action={<button class="btn btn-primary" onClick={() => navigate('/')}>Back to the dashboard</button>}>
          <code>{path}</code> is not a screen in this CRM.
        </Empty>
      );
  }
}


// ── Sign in ────────────────────────────────────────────────────────────────

function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/login', { email, password });
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
      setBusy(false);
    }
  };

  return (
    <div class="login-page">
      <form class="login-card" onSubmit={submit}>
        <div class="brand">
          <span class="brand-mark">L</span>
          <span>Lendmax</span>
        </div>
        <h1>Sign in to the CRM</h1>
        <p class="sub">Mortgage files, documents and compliance.</p>

        {error && <div class="alert alert-error" role="alert">{error}</div>}

        <Field label="Email">
          <input type="email" value={email} autocomplete="username" required autofocus
                 onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Password">
          <input type="password" value={password} autocomplete="current-password" required
                 onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </Field>
        <button class="btn btn-primary" style={{ width: '100%', marginTop: 6 }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p class="text-sm text-muted" style={{ textAlign: 'center', marginTop: 16, marginBottom: 0 }}>
          Accounts are created by a technical admin. If you are locked out, ask them to reset it.
        </p>
      </form>
    </div>
  );
}

// ── Profile ────────────────────────────────────────────────────────────────

function ProfilePage({ session, onSaved }: { session: Session; onSaved: () => void }) {
  const p = (session.profile ?? {}) as Record<string, string | null>;
  const [form, setForm] = useState({
    name: session.user.name,
    display_name: p.display_name ?? '',
    title: p.title ?? '',
    licence_number: p.licence_number ?? '',
    licence_province: p.licence_province ?? 'ON',
    mobile_phone: p.mobile_phone ?? '',
    direct_phone: p.direct_phone ?? '',
    booking_url: p.booking_url ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const first = !session.user.profile_complete;

  const set = (k: string) => (e: Event) =>
    setForm((f) => ({ ...f, [k]: (e.target as HTMLInputElement).value }));

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await put('/auth/profile', form);
      toast('Profile saved', 'ok');
      onSaved();
      if (first) navigate('/');
    } catch (err) {
      // Field-level messages where the server gave them, so the person is not
      // left guessing which of nine inputs it objected to.
      if (err instanceof ApiError && err.fields) {
        setErrors(Object.fromEntries(err.fields.map((f) => [f.field, f.message])));
      } else {
        setErrors({ _: err instanceof Error ? err.message : 'Could not save your profile.' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="content-narrow" style={{ maxWidth: 620 }}>
      <div class="page-head">
        <div>
          <h1>{first ? 'Set up your profile' : 'Your profile'}</h1>
          <p>
            {first
              ? 'Your signature is built from this, and nothing is sent to a client from an account without one.'
              : 'This is what a client sees when you email them.'}
          </p>
        </div>
      </div>

      <form class="card" onSubmit={submit}>
        <div class="card-body">
          {errors._ && <div class="alert alert-error">{errors._}</div>}
          <div class="grid-2">
            <Field label="Full name" error={errors.name}>
              <input value={form.name} onInput={set('name')} required />
            </Field>
            <Field label="Display name" hint="How you sign off — “Sarah” rather than “Sarah Johnson”.">
              <input value={form.display_name} onInput={set('display_name')} />
            </Field>
          </div>
          <Field label="Title">
            <input value={form.title} onInput={set('title')} placeholder="Mortgage Agent, Level 2" />
          </Field>
          <div class="grid-2">
            <Field label="Licence number" error={errors.licence_number}>
              <input value={form.licence_number} onInput={set('licence_number')} />
            </Field>
            <Field label="Licence province">
              <select value={form.licence_province} onChange={set('licence_province')}>
                {['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'].map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </Field>
          </div>
          <div class="grid-2">
            <Field label="Mobile" error={errors.mobile_phone}
                   hint="Used in the “or just call me at…” line.">
              <input value={form.mobile_phone} onInput={set('mobile_phone')} placeholder="(416) 555-0142" />
            </Field>
            <Field label="Direct line">
              <input value={form.direct_phone} onInput={set('direct_phone')} />
            </Field>
          </div>
          <Field label="Booking link" error={errors.booking_url}
                 hint="Where a client books time with you. Used as {schedule_link} in templates.">
            <input value={form.booking_url} onInput={set('booking_url')}
                   placeholder="https://calendar.app.google/…" />
          </Field>
        </div>
        <div class="modal-foot">
          <button class="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : first ? 'Save and continue' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Tasks ──────────────────────────────────────────────────────────────────

function TasksPage({ session }: { session: Session }) {
  const [due, setDue] = useState('all');
  const state = useAsync<{ tasks: Array<Record<string, any>> }>(`/tasks?due=${due}&status=active`, [due]);

  const complete = async (id: string) => {
    try {
      await patch(`/tasks/${id}`, { status: 'completed' });
      toast('Task completed', 'ok');
      state.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not complete that task.', 'error');
    }
  };

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div><h1>Tasks</h1><p>Your open work, soonest first.</p></div>
        <div class="row" role="group" aria-label="Filter">
          {[['all', 'All'], ['overdue', 'Overdue'], ['today', 'Today'], ['week', 'This week']].map(([k, l]) => (
            <button key={k} class={`btn btn-sm${due === k ? ' btn-primary' : ''}`}
                    onClick={() => setDue(k!)}>{l}</button>
          ))}
        </div>
      </div>

      <div class="card">
        {state.status === 'loading' && <Skeleton rows={4} />}
        {state.status === 'error' && <div style={{ padding: 15 }}><ErrorNote error={state.error} code={state.code} permission={state.permission}
                     onRetry={state.reload} /></div>}
        {state.status === 'ready' && state.data.tasks.length === 0 && (
          <Empty title="Nothing open">Tasks assigned to you appear here.</Empty>
        )}
        {state.status === 'ready' && state.data.tasks.map((t) => (
          <div key={t.id} class="row" style={{ padding: '11px 15px', borderBottom: '1px solid var(--border)' }}>
            <input type="checkbox" style={{ width: 16, flex: '0 0 auto' }}
                   aria-label={`Complete ${t.title}`} onChange={() => complete(t.id)} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div class="cell-strong">{t.title}</div>
              <div class="text-sm text-muted">
                {t.client_name ? `${t.client_name} · ` : ''}
                {String(t.category).replace(/_/g, ' ')}
                {t.due_on ? ` · due ${relativeTime(t.due_on)}` : ''}
              </div>
            </div>
            {t.overdue && <Badge tone="danger">Overdue</Badge>}
            {t.application_id && (
              <button class="btn btn-ghost btn-sm"
                      onClick={() => navigate(`/applications/${t.application_id}`)}>Open file</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Integrations and settings ──────────────────────────────────────────────


