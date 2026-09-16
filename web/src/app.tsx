/** Routing, sign-in, and the screens that are not yet their own module. */
import { useEffect, useState } from 'preact/hooks';
import { ApiError, del, patch, post, put, relativeTime, upload } from './lib/api.ts';
import {
  navigate, toast, useAsync, useRoute, useSession, useToasts,
  type Config, type Session,
} from './lib/store.ts';
import { Shell } from './components/shell.tsx';
import { Badge, Empty, ErrorNote, Field, Icon, ICONS, SearchSelect, Skeleton } from './components/ui.tsx';
import { DashboardPage } from './pages/dashboard.tsx';
import { CustomersPage, PipelinePage } from './pages/customers.tsx';
import { ClientPage } from './pages/client.tsx';
import { IntegrationsPage } from './pages/integrations.tsx';
import { AutomationsPage } from './pages/automations.tsx';
import { CompliancePage } from './pages/compliance.tsx';
import { RenewalsPage } from './pages/funding.tsx';
import { ReportsPage } from './pages/reports.tsx';
import { AppointmentsPage } from './pages/appointments.tsx';
import { CampaignsPage } from './pages/campaigns.tsx';
import { SettingsAdminPage } from './pages/settings-admin.tsx';
import { DocumentsPage } from './pages/documents.tsx';
import { MessagesPage } from './pages/messages.tsx';
import { StaffPage } from './pages/staff.tsx';
import { ApiAccessPage } from './pages/api-access.tsx';
import { RequiredDocumentsPage } from './pages/required-documents.tsx';
import { ActivityPage } from './pages/activity.tsx';
import { ChatsPage, PhotoPicker } from './pages/chats.tsx';
import { TasksPage } from './pages/tasks.tsx';
import { PipelineDetailPage, PipelinesPage } from './pages/pipelines.tsx';
import { ActivatePage } from './pages/activate.tsx';
import { SignatureEditor } from './components/signature-editor.tsx';

export function App() {
  const { state, reload, signOut } = useSession();
  const toasts = useToasts();
  const { path } = useRoute();

  // The activation link is opened by somebody who cannot sign in yet — and,
  // when an admin tests a link, by somebody already signed in as someone
  // else. Either way it is its own page, outside the shell.
  const activating = path === '/activate';

  return (
    <>
      {activating && <ActivatePage onActivated={reload} />}
      {!activating && state.status === 'loading' && (
        <div class="login-page"><div class="login-card"><Skeleton rows={4} /></div></div>
      )}
      {!activating && state.status === 'anonymous' && <LoginPage onSignedIn={reload} />}
      {!activating && state.status === 'ready' && (
        <Shell session={state.session} config={state.config} onSignOut={signOut}>
          <Routes session={state.session} config={state.config} onProfileSaved={reload} onConfigChanged={reload} />
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

function Routes({ session, config, onProfileSaved, onConfigChanged }: {
  session: Session; config: Config | null; onProfileSaved: () => void | Promise<void>;
  onConfigChanged: () => void;
}) {
  const { path } = useRoute();
  const mustCompleteProfile = !session.user.profile_complete && path !== '/profile';

  // Nothing is sent to a client from an account with no signature, so the
  // profile is the first thing a new user sees — and the only thing, until it
  // is done. The address bar is corrected after render: navigating during
  // render changed the URL before this component was listening for it, so it
  // never re-rendered and a new user saw an empty page.
  useEffect(() => {
    if (mustCompleteProfile) navigate('/profile', true);
  }, [mustCompleteProfile]);
  if (mustCompleteProfile) return <ProfilePage session={session} onSaved={onProfileSaved} />;

  const pipeline = path.match(/^\/pipelines\/([0-9a-f-]{36})$/i);
  if (pipeline) return <PipelineDetailPage id={pipeline[1]!} onConfigChanged={onConfigChanged} />;

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
    case '/staff': return <StaffPage session={session} />;
    case '/api-access': return <ApiAccessPage session={session} />;
    case '/required-documents': return <RequiredDocumentsPage session={session} />;
    case '/activity': return <ActivityPage session={session} />;
    case '/pipelines': return <PipelinesPage session={session} config={config} onConfigChanged={onConfigChanged} />;
    case '/documents': return <DocumentsPage session={session} />;
    case '/messages': return <MessagesPage session={session} />;
    case '/chats': return <ChatsPage session={session} />;
    case '/automations': return <AutomationsPage session={session} />;
    case '/campaigns': return <CampaignsPage session={session} />;
    case '/renewals': return <RenewalsPage session={session} />;
    case '/compliance': return <CompliancePage session={session} />;
    case '/reports': return <ReportsPage session={session} />;
    case '/appointments': return <AppointmentsPage session={session} />;
    case '/calendar': return <Redirect to="/appointments?view=week" />;
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

function ProfilePage({ session, onSaved }: { session: Session; onSaved: () => void | Promise<void> }) {
  const p = (session.profile ?? {}) as Record<string, string | null>;
  const photo = p.photo ?? null;
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
      // The session is reloaded BEFORE moving on: going to the dashboard with
      // the old session still saying "profile incomplete" bounced straight
      // back here.
      await onSaved();
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
    <div class="content-narrow" style={{ maxWidth: first ? 620 : 860 }}>
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
          <Field label="Your picture"
                 hint="Shown beside your name in LM Chats. Without one, your initials are.">
            <PhotoPicker
              name={session.user.name} src={photo}
              onUpload={async (file) => {
                const form = new FormData();
                form.set('photo', file);
                await upload('/users/me/photo', form, undefined, 'PUT');
                toast('Picture updated.', 'ok');
                await onSaved();
              }}
              onRemove={async () => {
                await del('/users/me/photo');
                toast('Picture removed.', 'ok');
                await onSaved();
              }} />
          </Field>
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
              <SearchSelect value={form.licence_province} ariaLabel="Licence province"
                            options={['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT']
                              .map((p) => ({ value: p, label: p }))}
                            onChange={(v) => setForm((f) => ({ ...f, licence_province: v }))} />
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

      {first ? (
        <p class="text-sm text-muted" style={{ marginTop: 12 }}>
          Your email signature is built from these details. Once you have saved them you can change how
          it looks under <strong>Your profile</strong>.
        </p>
      ) : (
        <div class="card" style={{ marginTop: 16 }} id="signature">
          <div class="card-head">
            <div>
              <h2>Email signature</h2>
              <p class="text-sm text-muted mb-0">Added to the bottom of the emails you send from the CRM.</p>
            </div>
          </div>
          <div class="card-body"><SignatureEditor path="/auth/signature" /></div>
        </div>
      )}
    </div>
  );
}

// ── Integrations and settings ──────────────────────────────────────────────

/** An old address that has moved. Navigating while rendering is what blanked the page once; after is safe. */
function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, true); }, [to]);
  return null;
}
