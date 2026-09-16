/**
 * The email signature editor — used on "Your profile", and by an admin
 * editing somebody else's from the Staff screen.
 *
 * Standard or custom. Custom is a few lines of text with fields, **bold**
 * and automatic links — not an HTML editor, so nobody can paste in something
 * that breaks in Outlook or reaches a client's inbox as raw markup. The
 * preview is rendered by the server, by the same code that renders the
 * signature on a real email.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { fieldErrors, get, post, put, relativeTime } from '../lib/api.ts';
import { toast } from '../lib/store.ts';
import { ErrorNote, Skeleton } from './ui.tsx';

type SignatureState = {
  mode: 'standard' | 'custom';
  source: string;
  standard_source: string;
  html: string;
  text: string;
  updated_at: string | null;
  fields: Array<{ token: string; label: string }>;
  limits: { characters: number; lines: number };
};

export function SignatureEditor({ path, whose = 'your', onSaved }: {
  /** '/auth/signature' for your own, '/staff/{id}/signature' for somebody else's. */
  path: string;
  whose?: string;
  onSaved?: () => void;
}) {
  const [saved, setSaved] = useState<SignatureState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [mode, setMode] = useState<'standard' | 'custom'>('standard');
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<{ html: string; text: string; problems: string[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const load = () => {
    get<{ signature: SignatureState }>(path)
      .then(({ signature }) => {
        setSaved(signature);
        setMode(signature.mode);
        setSource(signature.mode === 'custom' ? signature.source : signature.standard_source);
        setPreview({ html: signature.html, text: signature.text, problems: [] });
      })
      .catch((err: Error) => setLoadError(err.message));
  };
  useEffect(load, [path]);

  // Live preview, debounced, and only ever showing the latest answer.
  useEffect(() => {
    if (!saved) return;
    const controller = new AbortController();
    const id = setTimeout(() => {
      post<{ html: string; text: string; problems: string[] }>(`${path}/preview`, { mode, source })
        .then((p) => { if (!controller.signal.aborted) setPreview(p); })
        .catch(() => { /* the preview is a convenience */ });
    }, 250);
    return () => { clearTimeout(id); controller.abort(); };
  }, [mode, source, saved]);

  if (loadError) return <ErrorNote error={loadError} onRetry={() => { setLoadError(''); load(); }} />;
  if (!saved) return <Skeleton rows={3} />;

  const dirty = mode !== saved.mode || (mode === 'custom' && source !== saved.source);

  const insert = (token: string) => {
    const el = textarea.current;
    const text = `{${token}}`;
    if (!el) { setSource(source + text); return; }
    const start = el.selectionStart ?? source.length;
    const end = el.selectionEnd ?? source.length;
    const next = source.slice(0, start) + text + source.slice(end);
    setSource(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length); });
  };

  const chooseMode = (next: 'standard' | 'custom') => {
    setMode(next);
    setError('');
    // Starting a custom one from the standard one is easier than a blank box.
    if (next === 'custom' && (saved.mode !== 'custom' || !source.trim())) {
      setSource(saved.mode === 'custom' ? saved.source : saved.standard_source);
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const { signature } = await put<{ signature: SignatureState }>(path, { mode, source: mode === 'custom' ? source : undefined });
      setSaved(signature);
      setPreview({ html: signature.html, text: signature.text, problems: [] });
      toast(`${whose === 'your' ? 'Your' : `${whose}’s`} signature is saved. New emails use it from now on.`, 'ok');
      onSaved?.();
    } catch (err) {
      const errors = fieldErrors(err, 'Could not save the signature.');
      setError(errors.source ?? errors._ ?? Object.values(errors)[0] ?? 'Could not save the signature.');
    } finally {
      setBusy(false);
    }
  };

  const problems = preview?.problems ?? [];
  const over = source.length > saved.limits.characters;

  return (
    <div class="sig-editor">
      <div class="segmented" role="radiogroup" aria-label="Signature type">
        <button type="button" role="radio" aria-checked={mode === 'standard'}
                onClick={() => chooseMode('standard')}>
          <strong>Standard</strong>
          <span>Built from {whose === 'your' ? 'your' : 'their'} profile, and keeps itself up to date</span>
        </button>
        <button type="button" role="radio" aria-checked={mode === 'custom'}
                onClick={() => chooseMode('custom')}>
          <strong>Custom</strong>
          <span>Written {whose === 'your' ? 'your' : 'their'} own way</span>
        </button>
      </div>

      <div class="sig-body">
        {mode === 'custom' && (
          <div class="sig-source">
            <label for="sig-source">Signature</label>
            <textarea id="sig-source" ref={textarea} rows={8} value={source}
                      aria-invalid={!!error || problems.length > 0 || over}
                      onInput={(e) => { setSource((e.target as HTMLTextAreaElement).value); setError(''); }} />
            <div class="row-between text-sm text-muted" style={{ marginTop: 4 }}>
              <span><code>**bold**</code> · links and emails are linked for you · a line whose field is empty is left out</span>
              <span style={over ? { color: 'var(--danger-text)' } : undefined}>
                {source.length}/{saved.limits.characters}
              </span>
            </div>
            <div class="sig-fields" aria-label="Insert a field">
              <span class="text-sm text-muted">Insert:</span>
              {saved.fields.map((f) => (
                <button key={f.token} type="button" class="chip" onClick={() => insert(f.token)}
                        title={`Adds {${f.token}} — filled from the profile`}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div class="sig-preview-wrap">
          <div class="text-sm text-muted" style={{ marginBottom: 6 }}>
            How it looks at the bottom of an email
          </div>
          <div class="sig-preview" aria-live="polite">
            <p class="sig-preview-body">Hi Sarah,<br /><br />Thanks for sending those through — I’ll be in touch shortly.</p>
            {preview?.html
              // Rendered by the server from escaped text; see domain/signature.ts.
              ? <div dangerouslySetInnerHTML={{ __html: preview.html }} />
              : <p class="text-muted text-sm">Nothing to show yet — fill in the profile fields it uses.</p>}
          </div>
          {mode === 'standard' && (
            <p class="text-sm text-muted" style={{ marginBottom: 0 }}>
              Change the name, title, licence or numbers in the profile and this follows.
            </p>
          )}
        </div>
      </div>

      {(error || problems.length > 0) && (
        <div class="alert alert-error" style={{ marginTop: 12 }}>{error || problems[0]}</div>
      )}

      <div class="row-between" style={{ marginTop: 14 }}>
        <span class="text-sm text-muted">
          {saved.updated_at ? `Last changed ${relativeTime(saved.updated_at)}` : 'Using the standard signature'}
        </span>
        <div class="row" style={{ gap: 8 }}>
          {dirty && (
            <button type="button" class="btn" disabled={busy} onClick={() => {
              setMode(saved.mode);
              setSource(saved.mode === 'custom' ? saved.source : saved.standard_source);
              setError('');
            }}>Discard changes</button>
          )}
          <button type="button" class="btn btn-primary" disabled={busy || !dirty || over}
                  onClick={save}>
            {busy ? 'Saving…' : 'Save signature'}
          </button>
        </div>
      </div>
    </div>
  );
}
