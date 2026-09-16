/**
 * Activation — where the link in the invitation email lands.
 *
 * The person has no account they can use yet, so this renders outside the
 * shell, like sign-in. Choosing a password activates the account and signs
 * them in; the first-login profile comes next.
 */
import { useEffect, useState } from 'preact/hooks';
import { ApiError, fieldErrors, post } from '../lib/api.ts';
import { navigate, useRoute } from '../lib/store.ts';
import { Field, Skeleton } from '../components/ui.tsx';

type Invitation = {
  name: string; first_name: string | null; email: string; organization: string;
  expires_at: string; min_password_length: number;
};

/** A rough guide, not a gate: the server's rule is the length. */
function strength(password: string): { score: number; label: string } {
  let score = 0;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  const label = ['Too short', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong'][score] ?? 'Strong';
  return { score, label };
}

export function ActivatePage({ onActivated }: { onActivated: () => void }) {
  const { query } = useRoute();
  const token = query.get('token') ?? '';
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [problem, setProblem] = useState<{ message: string; code: string } | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setProblem({ code: 'invitation_invalid', message: 'This page needs the link from your invitation email. Open that email and click the button in it.' });
      return;
    }
    post<{ invitation: Invitation }>('/auth/invitation', { token })
      .then((d) => setInvitation(d.invitation))
      .catch((err: unknown) => setProblem({
        code: err instanceof ApiError ? err.code : 'error',
        message: err instanceof Error ? err.message : 'That link could not be checked.',
      }));
  }, [token]);

  const min = invitation?.min_password_length ?? 12;
  const meter = strength(password);

  const submit = async (e: Event) => {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (password.length < min) local.password = `Use at least ${min} characters.`;
    if (password !== confirmation) local.password_confirmation = 'The two passwords do not match.';
    setErrors(local);
    if (Object.keys(local).length) return;

    setBusy(true);
    try {
      await post('/auth/activate', { token, password, password_confirmation: confirmation });
      navigate('/', true);
      onActivated();
    } catch (err) {
      setErrors(fieldErrors(err, 'Could not activate your account.'));
      setBusy(false);
    }
  };

  return (
    <div class="login-page">
      <div class="login-card" style={{ maxWidth: 420 }}>
        <div class="brand">
          <span class="brand-mark">L</span>
          <span>Lendmax</span>
        </div>

        {!invitation && !problem && <Skeleton rows={3} />}

        {problem && (
          <>
            <h1>{problem.code === 'already_activated' ? 'Already activated' : 'This link cannot be used'}</h1>
            <p class="sub">{problem.message}</p>
            <button class="btn btn-primary" style={{ width: '100%' }} onClick={() => navigate('/', true)}>
              Go to sign in
            </button>
          </>
        )}

        {invitation && (
          <form onSubmit={submit} noValidate>
            <h1>Welcome, {invitation.first_name ?? invitation.name}</h1>
            <p class="sub">
              Choose a password to activate your {invitation.organization} CRM account.
              You will sign in as <strong>{invitation.email}</strong>.
            </p>

            {errors._ && <div class="alert alert-error" role="alert">{errors._}</div>}

            <Field label="New password" error={errors.password}
                   hint={`At least ${min} characters, and not your email address. A short phrase is easier to remember than a jumble.`}>
              <div class="password-wrap">
                <input type={show ? 'text' : 'password'} value={password} autocomplete="new-password"
                       autofocus aria-invalid={!!errors.password}
                       onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
                <button type="button" class="btn btn-ghost btn-sm password-toggle"
                        onClick={() => setShow(!show)} aria-pressed={show}>
                  {show ? 'Hide' : 'Show'}
                </button>
              </div>
            </Field>
            {password && (
              <div class="strength" aria-live="polite">
                <div class="strength-bar"><span style={{ width: `${(meter.score / 5) * 100}%` }}
                  data-level={meter.score < 2 ? 'low' : meter.score < 4 ? 'mid' : 'high'} /></div>
                <span class="text-sm text-muted">{meter.label}</span>
              </div>
            )}
            <Field label="Confirm password" error={errors.password_confirmation}>
              <input type={show ? 'text' : 'password'} value={confirmation} autocomplete="new-password"
                     aria-invalid={!!errors.password_confirmation}
                     onInput={(e) => setConfirmation((e.target as HTMLInputElement).value)} />
            </Field>

            <button class="btn btn-primary" style={{ width: '100%', marginTop: 6 }} disabled={busy}>
              {busy ? 'Activating…' : 'Activate my account'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
