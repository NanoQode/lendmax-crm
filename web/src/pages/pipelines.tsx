/**
 * Pipelines — the pipelines files move through, and each one's stages.
 *
 * Two screens: every pipeline (/pipelines), and one pipeline's stages
 * (/pipelines/:id). Each row has its active toggle. Nothing in use is deleted
 * without saying where its files go: the delete popups list what uses the
 * pipeline or stage and ask where its files should move.
 */
import { useEffect, useState } from 'preact/hooks';
import { del, fieldErrors, get, patch, post, relativeTime } from '../lib/api.ts';
import { navigate, toast, useAsync, type Config, type Session } from '../lib/store.ts';
import {
  Badge, Empty, ErrorNote, Field, Icon, ICONS, Modal, SearchSelect, Skeleton, Switch, type SelectOption,
} from '../components/ui.tsx';
import { DataTable } from '../components/data-table.tsx';

// ── Types ──────────────────────────────────────────────────────────────────

type Category = 'open' | 'parked' | 'won' | 'lost';

export type Stage = {
  id: string; pipeline_id: string; key: string; label: string; description: string | null;
  position: number; category: Category; category_label: string; probability: number | null;
  colour: string | null; entry_rules: Record<string, unknown>; active: boolean; files: number; updated_at: string;
};

export type Pipeline = {
  id: string; key: string; name: string; description: string | null; colour: string | null;
  is_default: boolean; position: number; active: boolean; purposes: string[]; purpose_labels: string[];
  stages: Stage[]; stage_count: number; files_open: number; files_total: number; problems: string[];
  updated_at: string; updated_by_name: string | null;
  appointment_stages: { booked: string | null; attended: string | null; missed: string | null };
};

type Catalogue = {
  pipelines: Pipeline[];
  categories: Array<{ key: Category; label: string; help: string }>;
  purposes: Array<{ key: string; label: string }>;
  can_manage: boolean;
};

type Usage = {
  files: number; files_open: number;
  by_stage: Array<{ key: string; label: string; category: Category; files: number }>;
  automations: Array<{ id: string; name: string; status: string }>;
  campaigns: Array<{ id: string; name: string; status: string }>;
  purposes: string[]; is_default: boolean;
};

const COLOURS = ['#6366f1', '#0ea5e9', '#14b8a6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#ef4444', '#64748b'];

const ENTRY_RULES: Array<[string, string]> = [
  ['requireAppointment', 'An appointment has been booked'],
  ['requireScarlettDeal', 'The file has been pushed to Scarlett'],
  ['blockedOnceScarlettPushed', 'Refuse files already pushed to Scarlett (no moving back)'],
  ['requireLostDisposition', 'A lost reason has been recorded'],
  ['requireFundingConfirmed', 'Funding is confirmed with final figures'],
  ['requireComplianceComplete', 'Compliance has approved the file'],
];

function describeRules(rules: Record<string, unknown> | null | undefined): string {
  if (!rules || Object.keys(rules).length === 0) return 'Anything can enter';
  const needs: string[] = [];
  if (rules.minPercentComplete) needs.push(`${rules.minPercentComplete}% complete`);
  if (rules.requireAppointment) needs.push('an appointment');
  if (rules.requireScarlettDeal) needs.push('a Scarlett deal');
  if (rules.requireLostDisposition) needs.push('a lost reason');
  if (rules.requireFundingConfirmed) needs.push('confirmed funding');
  if (rules.requireComplianceComplete) needs.push('compliance approval');
  const parts = needs.length ? [`Needs ${needs.join(', ')}`] : [];
  if (rules.blockedOnceScarlettPushed) parts.push('not after Scarlett');
  return parts.length ? parts.join(' · ') : 'Anything can enter';
}

const Dot = ({ colour }: { colour: string | null }) => (
  <span class="swatch" style={{ background: colour ?? 'var(--grey-400)' }} aria-hidden="true" />
);

// ── All pipelines ──────────────────────────────────────────────────────────

export function PipelinesPage({ session, onConfigChanged }: {
  session: Session; config: Config | null; onConfigChanged: () => void;
}) {
  const state = useAsync<Catalogue>('/pipelines');
  const [editing, setEditing] = useState<Pipeline | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Pipeline | null>(null);
  const [deactivating, setDeactivating] = useState<Pipeline | null>(null);
  void session;

  const changed = () => { state.reload(); onConfigChanged(); };

  if (state.status === 'loading') return <div class="content-narrow"><Skeleton rows={5} height={44} /></div>;
  if (state.status === 'error') {
    return <div class="content-narrow"><ErrorNote error={state.error} code={state.code} permission={state.permission} onRetry={state.reload} /></div>;
  }
  const d = state.data;

  const setActive = async (p: Pipeline, next: boolean) => {
    if (!next) { setDeactivating(p); return; }
    try {
      await patch(`/pipelines/${p.id}`, { active: true });
      toast(`“${p.name}” is active. Files can enter it again.`, 'ok');
      changed();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not activate it.', 'error');
    }
  };

  const makeDefault = async (p: Pipeline) => {
    try {
      await patch(`/pipelines/${p.id}`, { is_default: true, active: true });
      toast(`“${p.name}” is now the default pipeline.`, 'ok');
      changed();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not make it the default.', 'error');
    }
  };

  const unclaimed = d.purposes.filter((pp) => !d.pipelines.some((p) => p.active && p.purposes.includes(pp.key)));
  const defaultName = d.pipelines.find((p) => p.is_default)?.name ?? 'the default pipeline';

  return (
    <div class="content-narrow">
      <div class="page-head">
        <div>
          <h1>Pipelines</h1>
          <p>
            The pipelines files move through, and each one’s stages. A new application goes to the pipeline for its
            purpose; anything no pipeline claims goes to the default.
          </p>
        </div>
        {d.can_manage && (
          <button class="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon path={ICONS.plus} /> New pipeline
          </button>
        )}
      </div>

      {d.pipelines.some((p) => p.problems.length) && (
        <div class="alert alert-warn">
          {d.pipelines.flatMap((p) => p.problems).map((problem) => <div key={problem}>{problem}</div>)}
        </div>
      )}

      <div class="card routing-card" style={{ marginBottom: 14 }}>
        <div class="card-body">
          <strong>Where new applications go</strong>
          <div class="routing">
            {d.purposes.map((pp) => {
              const owner = d.pipelines.find((p) => p.active && p.purposes.includes(pp.key));
              return (
                <div key={pp.key} class="routing-row">
                  <span>{pp.label}</span>
                  <span class="text-muted" aria-hidden="true">→</span>
                  <span>{owner ? owner.name : <>{defaultName} <span class="text-muted text-sm">(default)</span></>}</span>
                </div>
              );
            })}
          </div>
          {unclaimed.length === d.purposes.length && (
            <p class="text-sm text-muted mb-0">Every purpose goes to the default. Create a pipeline and give it a purpose to split them.</p>
          )}
        </div>
      </div>

      <div class="card">
        <DataTable<Pipeline>
          label="Pipelines"
          rows={d.pipelines}
          rowKey={(p) => p.id}
          onRowClick={(p) => navigate(`/pipelines/${p.id}`)}
          rowClass={(p) => (p.active ? '' : 'row-dim')}
          empty={<Empty title="No pipelines" />}
          columns={[
            {
              key: 'name', header: 'Pipeline', primary: true, value: (p) => p.name,
              render: (p) => (
                <div>
                  <div class="row" style={{ gap: 6 }}>
                    <Dot colour={p.colour} />
                    <span class="cell-strong">{p.name}</span>
                    {p.is_default && <Badge tone="accent">Default</Badge>}
                    {p.problems.length > 0 && <Badge tone="warn">Needs attention</Badge>}
                  </div>
                  {p.description && <div class="text-sm text-muted">{p.description}</div>}
                </div>
              ),
            },
            {
              key: 'purposes', header: 'Takes', filter: 'auto',
              value: (p) => (p.purpose_labels.length ? p.purpose_labels : [p.is_default ? 'Everything else' : 'Nothing automatically']),
              render: (p) => (
                <span class="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                  {p.purpose_labels.map((l) => <Badge key={l} tone="info">{l}</Badge>)}
                  {p.is_default && <span class="text-sm text-muted">{p.purpose_labels.length ? '+ everything else' : 'Everything else'}</span>}
                  {!p.is_default && !p.purpose_labels.length && <span class="text-sm text-muted">Moved in by hand</span>}
                </span>
              ),
            },
            {
              key: 'stages', header: 'Stages', filter: 'number', align: 'right', value: (p) => p.stage_count,
              render: (p) => (
                <span class="stage-strip" title={p.stages.map((s) => s.label).join(' → ')}>
                  {p.stages.slice(0, 8).map((s) => <Dot key={s.id} colour={s.active ? s.colour : 'var(--border-strong)'} />)}
                  <span class="num">{p.stage_count}</span>
                </span>
              ),
            },
            { key: 'files_open', header: 'Open files', filter: 'number', align: 'right', value: (p) => p.files_open },
            { key: 'files_total', header: 'All files', filter: 'number', align: 'right', value: (p) => p.files_total },
            {
              key: 'active', header: 'Active', filter: 'auto', value: (p) => (p.active ? 'Active' : 'Inactive'),
              render: (p) => (
                <span class="row" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  <Switch checked={p.active} disabled={!d.can_manage || p.is_default}
                          label={`${p.name} active`} onChange={(next) => setActive(p, next)} />
                  <span class="text-sm">{p.active ? 'Active' : 'Inactive'}</span>
                </span>
              ),
            },
            {
              key: 'updated_at', header: 'Updated', filter: false, value: (p) => p.updated_at,
              render: (p) => <span class="text-sm text-muted" title={p.updated_by_name ?? ''}>{relativeTime(p.updated_at)}</span>,
            },
            {
              key: 'actions', header: '', sortable: false, filter: false, searchable: false,
              render: (p) => (
                <div class="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button class="btn btn-ghost btn-sm" onClick={() => navigate(`/pipelines/${p.id}`)}>Stages</button>
                  {d.can_manage && (
                    <>
                      {!p.is_default && <button class="btn btn-ghost btn-sm" onClick={() => makeDefault(p)}>Make default</button>}
                      <button class="btn btn-ghost btn-sm" onClick={() => setEditing(p)}>Edit</button>
                      <button class="btn btn-ghost btn-sm" style={{ color: 'var(--danger-text)' }}
                              disabled={p.is_default} title={p.is_default ? 'Make another pipeline the default first' : undefined}
                              onClick={() => setDeleting(p)}>Delete</button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>

      {editing && (
        <PipelineForm catalogue={d} pipeline={editing === 'new' ? null : editing}
                      onClose={() => setEditing(null)}
                      onSaved={(p, notices, created) => {
                        setEditing(null);
                        toast(created ? `“${p.name}” created. Now set up its stages.` : `“${p.name}” saved.`, 'ok');
                        for (const n of notices) toast(n, 'info');
                        changed();
                        if (created) navigate(`/pipelines/${p.id}`);
                      }} />
      )}
      {deactivating && (
        <DeactivatePipeline pipeline={deactivating} defaultName={defaultName} onClose={() => setDeactivating(null)}
                            onDone={() => { setDeactivating(null); changed(); }} />
      )}
      {deleting && (
        <DeletePipeline pipeline={deleting} all={d.pipelines} onClose={() => setDeleting(null)}
                        onDone={() => { setDeleting(null); changed(); }} />
      )}
    </div>
  );
}

// ── What uses it ───────────────────────────────────────────────────────────

function UsageList({ usage, what }: { usage: Usage; what: string }) {
  const refs = usage.automations.length + usage.campaigns.length;
  if (!usage.files && !refs && !usage.purposes.length) {
    return <p class="text-sm text-muted">Nothing uses this {what}.</p>;
  }
  return (
    <div class="usage">
      <div class="text-sm" style={{ fontWeight: 600, marginBottom: 6 }}>This {what} is in use</div>
      <ul>
        {usage.files > 0 && (
          <li>
            <strong>{usage.files} file{usage.files === 1 ? '' : 's'}</strong>
            {usage.files_open !== usage.files && ` (${usage.files_open} still open)`}
            {usage.by_stage.length > 1 && (
              <span class="text-muted"> — {usage.by_stage.map((s) => `${s.label}: ${s.files}`).join(', ')}</span>
            )}
          </li>
        )}
        {usage.purposes.length > 0 && <li>New <strong>{usage.purposes.join(', ')}</strong> applications come here</li>}
        {usage.automations.map((a) => (
          <li key={a.id}>Automation <a href={`/crm/automations?open=${a.id}`}
                                       onClick={(e) => { e.preventDefault(); navigate(`/automations?open=${a.id}`); }}>{a.name}</a>
            {' '}<Badge>{a.status}</Badge></li>
        ))}
        {usage.campaigns.map((c) => (
          <li key={c.id}>Campaign <a href={`/crm/campaigns`} onClick={(e) => { e.preventDefault(); navigate('/campaigns'); }}>{c.name}</a>
            {' '}<Badge>{c.status}</Badge></li>
        ))}
      </ul>
    </div>
  );
}

function DeactivatePipeline({ pipeline, defaultName, onClose, onDone }: {
  pipeline: Pipeline; defaultName: string; onClose: () => void; onDone: () => void;
}) {
  const usage = useAsync<Usage>(`/pipelines/${pipeline.id}/usage`);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await patch(`/pipelines/${pipeline.id}`, { active: false });
      toast(`“${pipeline.name}” is inactive. Nothing new enters it.`, 'ok');
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not deactivate it.', 'error');
      setBusy(false);
    }
  };
  return (
    <Modal title={`Deactivate “${pipeline.name}”?`} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class="btn btn-primary" onClick={confirm} disabled={busy || usage.status !== 'ready'}>Deactivate</button>
      </>
    }>
      {usage.status === 'loading' && <Skeleton rows={2} />}
      {usage.status === 'ready' && (
        <>
          <UsageList usage={usage.data} what="pipeline" />
          <ul class="consequences">
            <li>No new files enter it, and it is left out of the stage lists.</li>
            {usage.data.files > 0 && <li>The {usage.data.files} file(s) already in it stay where they are, and can still be moved out.</li>}
            {usage.data.purposes.length > 0 && <li>New {usage.data.purposes.join(', ')} applications go to {defaultName} instead, until you turn it back on.</li>}
            {(usage.data.automations.length + usage.data.campaigns.length) > 0 && (
              <li>The automations and campaigns above still name its stages — check them.</li>
            )}
          </ul>
        </>
      )}
    </Modal>
  );
}

function DeletePipeline({ pipeline, all, onClose, onDone }: {
  pipeline: Pipeline; all: Pipeline[]; onClose: () => void; onDone: () => void;
}) {
  const usage = useAsync<Usage>(`/pipelines/${pipeline.id}/usage`);
  const targets = all.filter((p) => p.id !== pipeline.id && p.active);
  const [target, setTarget] = useState(targets.find((p) => p.is_default)?.id ?? targets[0]?.id ?? '');
  const [map, setMap] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const hasFiles = usage.status === 'ready' && usage.data.files > 0;
  useEffect(() => {
    if (!hasFiles || !target) return;
    get<{ stage_map: Record<string, string | null> }>(`/pipelines/${pipeline.id}/suggest-map?target=${target}`)
      .then((r) => setMap(Object.fromEntries(Object.entries(r.stage_map).map(([k, v]) => [k, v ?? '']))))
      .catch(() => setMap({}));
  }, [target, hasFiles]);

  const targetStages: SelectOption[] = (all.find((p) => p.id === target)?.stages ?? [])
    .filter((s) => s.active).map((s) => ({ value: s.key, label: s.label, hint: s.category_label }));

  const confirm = async () => {
    setBusy(true);
    setErrors({});
    try {
      const result = await del<{ moved: number; purposes_now_default: string[] }>(`/pipelines/${pipeline.id}`,
        hasFiles ? { stage_map: map } : {});
      toast(`“${pipeline.name}” deleted${result.moved ? `; ${result.moved} file(s) moved` : ''}.` +
            (result.purposes_now_default.length ? ` ${result.purposes_now_default.join(', ')} now go to the default.` : ''), 'ok');
      onDone();
    } catch (err) {
      setErrors(fieldErrors(err, 'Could not delete it.'));
      setBusy(false);
    }
  };

  const incomplete = hasFiles && usage.status === 'ready' && usage.data.by_stage.some((s) => !map[s.key]);

  return (
    <Modal title={`Delete “${pipeline.name}”?`} wide onClose={onClose} footer={
      <>
        {errors._ && <span class="text-sm" style={{ color: 'var(--danger-text)', marginRight: 'auto' }}>{errors._}</span>}
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class="btn btn-danger-solid" onClick={confirm} disabled={busy || usage.status !== 'ready' || incomplete || (hasFiles && !target)}>
          {busy ? 'Working…' : hasFiles ? 'Move files and delete' : 'Delete'}
        </button>
      </>
    }>
      {usage.status === 'loading' && <Skeleton rows={3} />}
      {usage.status === 'ready' && (
        <>
          <UsageList usage={usage.data} what="pipeline" />
          {hasFiles ? (
            <>
              <p>It can’t be deleted with files in it. Choose where they go — each file’s history records the move.
                 Moving them doesn’t send anything to clients.</p>
              <Field label="Move its files to the pipeline">
                <SearchSelect value={target} ariaLabel="Target pipeline"
                              options={targets.map((p) => ({ value: p.id, label: p.name, hint: p.is_default ? 'Default' : undefined }))}
                              onChange={setTarget} />
              </Field>
              <div class="stage-map">
                {usage.data.by_stage.map((s) => (
                  <div key={s.key} class="stage-map-row">
                    <div><strong>{s.label}</strong> <span class="text-sm text-muted">{s.files} file{s.files === 1 ? '' : 's'}</span></div>
                    <span aria-hidden="true" class="text-muted">→</span>
                    <div>
                      <SearchSelect value={map[s.key] ?? ''} options={targetStages} ariaLabel={`Stage for files on ${s.label}`}
                                    placeholder="Choose a stage…" invalid={!!errors[`stage_map.${s.key}`]}
                                    onChange={(v) => setMap({ ...map, [s.key]: v })} />
                      {errors[`stage_map.${s.key}`] && <div class="field-error">{errors[`stage_map.${s.key}`]}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p class="text-sm">Its stages go with it. History that passed through it keeps its name.</p>
          )}
          {usage.data.purposes.length > 0 && (
            <p class="text-sm text-muted">New {usage.data.purposes.join(', ')} applications will go to the default pipeline.</p>
          )}
        </>
      )}
    </Modal>
  );
}

// ── Pipeline form ──────────────────────────────────────────────────────────

function PipelineForm({ catalogue, pipeline, onClose, onSaved }: {
  catalogue: Catalogue; pipeline: Pipeline | null; onClose: () => void;
  onSaved: (p: Pipeline, notices: string[], created: boolean) => void;
}) {
  const [form, setForm] = useState({
    name: pipeline?.name ?? '',
    description: pipeline?.description ?? '',
    colour: pipeline?.colour ?? COLOURS[0]!,
    purposes: new Set(pipeline?.purposes ?? []),
    is_default: pipeline?.is_default ?? false,
    active: pipeline?.active ?? true,
    copy_from: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => { setForm({ ...form, [k]: v }); setErrors({ ...errors, [k]: '' }); };

  const save = async () => {
    if (form.name.trim().length < 2) { setErrors({ name: 'Name the pipeline — at least 2 characters.' }); return; }
    setBusy(true);
    const body: Record<string, unknown> = {
      name: form.name.trim(), description: form.description.trim(), colour: form.colour,
      purposes: [...form.purposes],
    };
    if (!pipeline || form.is_default !== pipeline.is_default) body.is_default = form.is_default;
    if (!pipeline) { body.active = form.active; if (form.copy_from) body.copy_from = form.copy_from; }
    try {
      const result = pipeline
        ? await patch<{ pipeline: Pipeline; notices: string[] }>(`/pipelines/${pipeline.id}`, body)
        : await post<{ pipeline: Pipeline; notices: string[] }>('/pipelines', body);
      onSaved(result.pipeline, result.notices, !pipeline);
    } catch (err) {
      setErrors(fieldErrors(err, 'Could not save that.'));
      setBusy(false);
    }
  };

  return (
    <Modal title={pipeline ? `Edit “${pipeline.name}”` : 'New pipeline'} wide onClose={onClose} footer={
      <>
        {errors._ && <span class="text-sm" style={{ color: 'var(--danger-text)', marginRight: 'auto' }}>{errors._}</span>}
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : pipeline ? 'Save' : 'Create pipeline'}</button>
      </>
    }>
      <div class="grid-2">
        <Field label="Name *" error={errors.name}>
          <input value={form.name} maxLength={80} placeholder="Renewals" autofocus
                 onInput={(e) => set('name', (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Colour" error={errors.colour}>
          <ColourPicker value={form.colour} onChange={(c) => set('colour', c)} />
        </Field>
      </div>
      <Field label="Description" error={errors.description}>
        <input value={form.description} maxLength={500} placeholder="What this pipeline is for"
               onInput={(e) => set('description', (e.target as HTMLInputElement).value)} />
      </Field>

      <Field label="New applications it takes" error={errors.purposes}
             hint="A purpose goes to one pipeline. Ticking one another pipeline has moves it here.">
        <div class="format-options">
          {catalogue.purposes.map((pp) => {
            const owner = catalogue.pipelines.find((p) => p.id !== pipeline?.id && p.purposes.includes(pp.key));
            return (
              <label key={pp.key} class="format-option" title={owner ? `Currently goes to ${owner.name}` : undefined}>
                <input type="checkbox" checked={form.purposes.has(pp.key)}
                       onChange={(e) => {
                         const next = new Set(form.purposes);
                         if ((e.target as HTMLInputElement).checked) next.add(pp.key); else next.delete(pp.key);
                         set('purposes', next);
                       }} />
                {pp.label}
                {owner && form.purposes.has(pp.key) && <span class="text-sm text-muted">(from {owner.name})</span>}
              </label>
            );
          })}
        </div>
      </Field>

      {!pipeline && (
        <Field label="Start with" error={errors.copy_from}>
          <SearchSelect value={form.copy_from} ariaLabel="Start with"
                        options={[{ value: '', label: 'Starter stages', hint: 'New, In progress, Funded, Lost' },
                                  ...catalogue.pipelines.map((p) => ({ value: p.id, label: `A copy of ${p.name}’s stages`, hint: `${p.stage_count} stages` }))]}
                        onChange={(v) => set('copy_from', v)} />
        </Field>
      )}

      <div class="row" style={{ gap: 18, flexWrap: 'wrap' }}>
        <label class="row" style={{ gap: 8, margin: 0 }}>
          <Switch checked={form.is_default} label="Default pipeline" disabled={pipeline?.is_default}
                  onChange={(v) => setForm({ ...form, is_default: v, active: v ? true : form.active })} />
          <span class="text-sm"><strong>Default</strong> <span class="text-muted">— takes anything no other pipeline claims</span></span>
        </label>
        {!pipeline && (
          <label class="row" style={{ gap: 8, margin: 0 }}>
            <Switch checked={form.active} label="Active" disabled={form.is_default} onChange={(v) => set('active', v)} />
            <span class="text-sm"><strong>{form.active ? 'Active' : 'Inactive'}</strong></span>
          </label>
        )}
      </div>
      {pipeline?.is_default && (
        <p class="text-sm text-muted">This is the default. To change that, make another pipeline the default.</p>
      )}
    </Modal>
  );
}

function ColourPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div class="colour-picker" role="radiogroup" aria-label="Colour">
      {COLOURS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value.toLowerCase() === c}
                aria-label={c} class="colour-swatch" style={{ background: c }} onClick={() => onChange(c)} />
      ))}
      <input value={value} maxLength={7} aria-label="Colour hex" class="colour-hex"
             onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
    </div>
  );
}

// ── One pipeline's stages ──────────────────────────────────────────────────

export function PipelineDetailPage({ id, onConfigChanged }: { id: string; onConfigChanged: () => void }) {
  const state = useAsync<Catalogue>('/pipelines');
  const [editing, setEditing] = useState<Stage | 'new' | null>(null);
  const [editingPipeline, setEditingPipeline] = useState(false);
  const [deleting, setDeleting] = useState<Stage | null>(null);
  const [deactivating, setDeactivating] = useState<Stage | null>(null);

  const changed = () => { state.reload(); onConfigChanged(); };

  if (state.status === 'loading') return <div class="content-narrow"><Skeleton rows={5} height={44} /></div>;
  if (state.status === 'error') {
    return <div class="content-narrow"><ErrorNote error={state.error} code={state.code} permission={state.permission} onRetry={state.reload} /></div>;
  }
  const d = state.data;
  const pipeline = d.pipelines.find((p) => p.id === id);
  if (!pipeline) {
    return (
      <div class="content-narrow">
        <Empty title="That pipeline isn’t here" action={<button class="btn" onClick={() => navigate('/pipelines')}>All pipelines</button>}>
          It may have been deleted.
        </Empty>
      </div>
    );
  }

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast(ok, 'ok'); changed(); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not do that.', 'error'); }
  };

  const setActive = (s: Stage, next: boolean) => {
    if (!next && s.files > 0) { setDeactivating(s); return; }
    void act(() => patch(`/pipeline-stages/${s.id}`, { active: next }), `“${s.label}” is ${next ? 'active' : 'inactive'}.`);
  };

  return (
    <div class="content-narrow">
      <button class="btn btn-ghost btn-sm" style={{ marginBottom: 8 }} onClick={() => navigate('/pipelines')}>
        <Icon path={ICONS.back} size={14} /> Pipelines
      </button>
      <div class="page-head">
        <div>
          <h1 class="row" style={{ gap: 8 }}>
            <Dot colour={pipeline.colour} /> {pipeline.name}
            {pipeline.is_default && <Badge tone="accent">Default</Badge>}
            {!pipeline.active && <Badge>Inactive</Badge>}
          </h1>
          <p>
            {pipeline.description ? `${pipeline.description} · ` : ''}
            {pipeline.purpose_labels.length
              ? `Takes new ${pipeline.purpose_labels.join(', ')} applications${pipeline.is_default ? ', and anything no other pipeline claims' : ''}.`
              : pipeline.is_default ? 'Takes every application no other pipeline claims.' : 'Files are moved in by hand.'}
          </p>
        </div>
        <div class="row" style={{ gap: 8 }}>
          <button class="btn" onClick={() => navigate(`/pipeline?pipeline=${pipeline.id}`)}>
            <Icon path={ICONS.board} /> Board
          </button>
          {d.can_manage && <button class="btn" onClick={() => setEditingPipeline(true)}>Edit pipeline</button>}
          {d.can_manage && (
            <button class="btn btn-primary" onClick={() => setEditing('new')}><Icon path={ICONS.plus} /> Add stage</button>
          )}
        </div>
      </div>

      {pipeline.problems.length > 0 && (
        <div class="alert alert-warn">{pipeline.problems.map((p) => <div key={p}>{p}</div>)}</div>
      )}

      <div class="flow" aria-label="Stages in order">
        {pipeline.stages.map((s, i) => (
          <span key={s.id} class={`flow-step${s.active ? '' : ' flow-off'}`}>
            {i > 0 && <span class="flow-arrow" aria-hidden="true">›</span>}
            <span class="flow-chip" style={{ borderColor: s.colour ?? undefined }}>
              <Dot colour={s.colour} /> {s.label} <span class="text-muted num">{s.files}</span>
            </span>
          </span>
        ))}
      </div>

      <div class="card">
        <DataTable<Stage>
          label={`Stages of ${pipeline.name}`}
          rows={pipeline.stages}
          rowKey={(s) => s.id}
          initialSort={{ key: 'position', dir: 'asc' }}
          rowClass={(s) => (s.active ? '' : 'row-dim')}
          onRowClick={d.can_manage ? (s) => setEditing(s) : undefined}
          empty={<Empty title="No stages yet" />}
          columns={[
            {
              key: 'position', header: '#', filter: false, width: '64px', value: (s) => s.position,
              render: (s) => {
                const idx = pipeline.stages.findIndex((x) => x.id === s.id);
                return d.can_manage ? (
                  <span class="row" style={{ gap: 0 }} onClick={(e) => e.stopPropagation()}>
                    <span class="text-muted num" style={{ width: 18 }}>{idx + 1}</span>
                    <button class="btn btn-ghost btn-sm" disabled={idx === 0} aria-label={`Move ${s.label} up`}
                            onClick={() => act(() => post(`/pipeline-stages/${s.id}/move`, { direction: 'up' }))}>↑</button>
                    <button class="btn btn-ghost btn-sm" disabled={idx === pipeline.stages.length - 1} aria-label={`Move ${s.label} down`}
                            onClick={() => act(() => post(`/pipeline-stages/${s.id}/move`, { direction: 'down' }))}>↓</button>
                  </span>
                ) : <span class="text-muted num">{idx + 1}</span>;
              },
            },
            {
              key: 'label', header: 'Stage', primary: true,
              render: (s) => (
                <div>
                  <div class="row" style={{ gap: 6 }}><Dot colour={s.colour} /><span class="cell-strong">{s.label}</span></div>
                  {s.description && <div class="text-sm text-muted">{s.description}</div>}
                </div>
              ),
            },
            {
              key: 'category', header: 'Means', filter: 'auto', value: (s) => s.category_label,
              render: (s) => <Badge tone={s.category === 'won' ? 'ok' : s.category === 'lost' ? 'danger' : s.category === 'parked' ? 'neutral' : 'info'}>{s.category_label}</Badge>,
            },
            {
              key: 'probability', header: 'Win %', filter: 'number', align: 'right', value: (s) => s.probability,
              render: (s) => (s.probability === null ? <span class="text-muted">—</span> : `${s.probability}%`),
            },
            {
              key: 'rules', header: 'To enter', value: (s) => describeRules(s.entry_rules),
              render: (s) => <span class="text-sm">{describeRules(s.entry_rules)}</span>,
            },
            { key: 'files', header: 'Files', filter: 'number', align: 'right', value: (s) => s.files },
            {
              key: 'active', header: 'Active', filter: 'auto', value: (s) => (s.active ? 'Active' : 'Inactive'),
              render: (s) => (
                <span class="row" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  <Switch checked={s.active} disabled={!d.can_manage} label={`${s.label} active`}
                          onChange={(next) => setActive(s, next)} />
                  <span class="text-sm">{s.active ? 'Active' : 'Inactive'}</span>
                </span>
              ),
            },
            {
              key: 'actions', header: '', sortable: false, filter: false, searchable: false,
              render: (s) => d.can_manage ? (
                <div class="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button class="btn btn-ghost btn-sm" onClick={() => setEditing(s)}>Edit</button>
                  <button class="btn btn-ghost btn-sm" style={{ color: 'var(--danger-text)' }} onClick={() => setDeleting(s)}>Delete</button>
                </div>
              ) : null,
            },
          ]}
        />
      </div>

      <AppointmentStages pipeline={pipeline} canManage={d.can_manage}
                         onSave={(next) => act(() => patch(`/pipelines/${pipeline.id}`, { appointment_stages: next }),
                                               'Appointment stages saved.')} />

      {editing && (
        <StageForm pipeline={pipeline} categories={d.categories} stage={editing === 'new' ? null : editing}
                   onClose={() => setEditing(null)}
                   onSaved={(s, created) => { setEditing(null); toast(created ? `“${s.label}” added.` : `“${s.label}” saved.`, 'ok'); changed(); }} />
      )}
      {editingPipeline && (
        <PipelineForm catalogue={d} pipeline={pipeline} onClose={() => setEditingPipeline(false)}
                      onSaved={(p, notices) => { setEditingPipeline(false); toast(`“${p.name}” saved.`, 'ok'); for (const n of notices) toast(n, 'info'); changed(); }} />
      )}
      {deactivating && (
        <DeactivateStage stage={deactivating} onClose={() => setDeactivating(null)}
                         onDone={() => { setDeactivating(null); changed(); }} />
      )}
      {deleting && (
        <DeleteStage stage={deleting} all={d.pipelines} onClose={() => setDeleting(null)}
                     onDone={() => { setDeleting(null); changed(); }} />
      )}
    </div>
  );
}

function DeactivateStage({ stage, onClose, onDone }: { stage: Stage; onClose: () => void; onDone: () => void }) {
  const usage = useAsync<Usage>(`/pipeline-stages/${stage.id}/usage`);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Deactivate “${stage.label}”?`} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class="btn btn-primary" disabled={busy || usage.status !== 'ready'} onClick={async () => {
          setBusy(true);
          try {
            await patch(`/pipeline-stages/${stage.id}`, { active: false });
            toast(`“${stage.label}” is inactive.`, 'ok');
            onDone();
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Could not deactivate it.', 'error');
            setBusy(false);
          }
        }}>Deactivate</button>
      </>
    }>
      {usage.status === 'loading' && <Skeleton rows={2} />}
      {usage.status === 'ready' && (
        <>
          <UsageList usage={usage.data} what="stage" />
          <ul class="consequences">
            <li>No file can be moved into it, and it leaves the stage lists.</li>
            <li>The {usage.data.files} file(s) on it stay there — the board still shows them — until somebody moves them on.</li>
          </ul>
        </>
      )}
    </Modal>
  );
}

function DeleteStage({ stage, all, onClose, onDone }: { stage: Stage; all: Pipeline[]; onClose: () => void; onDone: () => void }) {
  const usage = useAsync<Usage>(`/pipeline-stages/${stage.id}/usage`);
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const several = all.filter((p) => p.active).length > 1;
  const options: SelectOption[] = all.filter((p) => p.active).flatMap((p) => p.stages
    .filter((s) => s.active && s.id !== stage.id)
    .map((s) => ({ value: s.key, label: several ? `${s.label} — ${p.name}` : s.label, hint: s.category_label })));
  const hasFiles = usage.status === 'ready' && usage.data.files > 0;

  return (
    <Modal title={`Delete “${stage.label}”?`} onClose={onClose} footer={
      <>
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class="btn btn-danger-solid" disabled={busy || usage.status !== 'ready' || (hasFiles && !to)} onClick={async () => {
          setBusy(true); setError('');
          try {
            const r = await del<{ moved: number }>(`/pipeline-stages/${stage.id}`, hasFiles ? { move_to: to } : {});
            toast(`“${stage.label}” deleted${r.moved ? `; ${r.moved} file(s) moved` : ''}.`, 'ok');
            onDone();
          } catch (err) {
            const f = fieldErrors(err, 'Could not delete it.');
            setError(f.move_to ?? f._ ?? Object.values(f)[0] ?? 'Could not delete it.');
            setBusy(false);
          }
        }}>{hasFiles ? 'Move files and delete' : 'Delete'}</button>
      </>
    }>
      {usage.status === 'loading' && <Skeleton rows={2} />}
      {usage.status === 'ready' && (
        <>
          <UsageList usage={usage.data} what="stage" />
          {hasFiles ? (
            <Field label={`Move its ${usage.data.files} file(s) to *`} error={error}
                   hint="Each file’s history records the move. Moving them doesn’t send anything to clients.">
              <SearchSelect value={to} options={options} ariaLabel="Move its files to" placeholder="Choose a stage…"
                            searchPlaceholder="Search stages…" invalid={!!error} onChange={(v) => { setTo(v); setError(''); }} />
            </Field>
          ) : (
            <>
              <p class="text-sm">Reports and the history of files that passed through it keep its name.</p>
              {error && <div class="alert alert-error">{error}</div>}
            </>
          )}
          {(usage.data.automations.length + usage.data.campaigns.length) > 0 && (
            <div class="alert alert-warn">The automations and campaigns above name this stage. After deleting it, change them — they won’t match it any more.</div>
          )}
        </>
      )}
    </Modal>
  );
}

// ── Stage form ─────────────────────────────────────────────────────────────

function StageForm({ pipeline, categories, stage, onClose, onSaved }: {
  pipeline: Pipeline; categories: Catalogue['categories']; stage: Stage | null;
  onClose: () => void; onSaved: (s: Stage, created: boolean) => void;
}) {
  const [form, setForm] = useState({
    label: stage?.label ?? '',
    description: stage?.description ?? '',
    category: stage?.category ?? 'open' as Category,
    probability: stage?.probability === null || stage?.probability === undefined ? '' : String(stage.probability),
    colour: stage?.colour ?? COLOURS[1]!,
    active: stage?.active ?? true,
  });
  const [rules, setRules] = useState<Record<string, unknown>>(stage?.entry_rules ?? {});
  const [showRules, setShowRules] = useState(Object.keys(stage?.entry_rules ?? {}).length > 0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => { setForm({ ...form, [k]: v }); setErrors({ ...errors, [k]: '' }); };

  const save = async () => {
    const e: Record<string, string> = {};
    if (form.label.trim().length < 2) e.label = 'Name the stage — at least 2 characters.';
    const p = form.probability === '' ? null : Number(form.probability);
    if (p !== null && (Number.isNaN(p) || p < 0 || p > 100)) e.probability = 'Between 0 and 100, or blank.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const body = {
      label: form.label.trim(), description: form.description.trim(), category: form.category,
      probability: p, colour: form.colour, active: form.active, entry_rules: rules,
    };
    try {
      const { stage: saved } = stage
        ? await patch<{ stage: Stage }>(`/pipeline-stages/${stage.id}`, body)
        : await post<{ stage: Stage }>(`/pipelines/${pipeline.id}/stages`, body);
      onSaved(saved, !stage);
    } catch (err) {
      setErrors(fieldErrors(err, 'Could not save that.'));
      setBusy(false);
    }
  };

  const categoryOptions: SelectOption[] = categories.map((c) => ({ value: c.key, label: c.label, hint: c.help }));

  return (
    <Modal title={stage ? `Edit “${stage.label}”` : `Add a stage to ${pipeline.name}`} wide onClose={onClose} footer={
      <>
        {errors._ && <span class="text-sm" style={{ color: 'var(--danger-text)', marginRight: 'auto' }}>{errors._}</span>}
        <button class="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button class="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : stage ? 'Save' : 'Add stage'}</button>
      </>
    }>
      <div class="grid-2">
        <Field label="Name *" error={errors.label}>
          <input value={form.label} maxLength={60} placeholder="Appraisal ordered" autofocus
                 onInput={(e) => set('label', (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="What it means *" error={errors.category}
               hint={categories.find((c) => c.key === form.category)?.help}>
          <SearchSelect value={form.category} options={categoryOptions} ariaLabel="What it means"
                        onChange={(v) => set('category', v as Category)} />
        </Field>
      </div>
      <div class="grid-2">
        <Field label="Chance of funding (%)" error={errors.probability}
               hint="For the weighted forecast. Blank leaves it out of the forecast.">
          <input type="number" min={0} max={100} value={form.probability} placeholder="e.g. 40"
                 onInput={(e) => set('probability', (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Colour" error={errors.colour}>
          <ColourPicker value={form.colour} onChange={(c) => set('colour', c)} />
        </Field>
      </div>
      <Field label="Description" error={errors.description} hint="For staff: what happens at this stage.">
        <input value={form.description} maxLength={500}
               onInput={(e) => set('description', (e.target as HTMLInputElement).value)} />
      </Field>

      <div class="row" style={{ gap: 10, marginBottom: 12 }}>
        <Switch checked={form.active} label="Active" onChange={(v) => set('active', v)} />
        <span class="text-sm"><strong>{form.active ? 'Active' : 'Inactive'}</strong>
          <span class="text-muted"> — {form.active ? 'files can be moved into it.' : 'nothing can be moved into it.'}</span></span>
      </div>

      <button type="button" class="btn btn-sm" onClick={() => setShowRules(!showRules)}>
        {showRules ? 'Hide' : 'Show'} what a file needs to enter ({describeRules(rules)})
      </button>
      {showRules && (
        <div class="rules-box">
          <p class="text-sm text-muted mt-0">A move into this stage is refused unless all of these are true, and the refusal lists every one that is missing.</p>
          <Field label="Minimum application completeness (%)" hint="Blank for no minimum.">
            <input type="number" min={0} max={100} value={String(rules.minPercentComplete ?? '')}
                   onInput={(e) => {
                     const raw = (e.target as HTMLInputElement).value;
                     const next = { ...rules };
                     if (raw === '') delete next.minPercentComplete; else next.minPercentComplete = Number(raw);
                     setRules(next);
                   }} />
          </Field>
          {ENTRY_RULES.map(([key, label]) => (
            <label key={key} class="check">
              <input type="checkbox" checked={rules[key] === true}
                     onChange={(e) => {
                       const next = { ...rules };
                       if ((e.target as HTMLInputElement).checked) next[key] = true; else delete next[key];
                       setRules(next);
                     }} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      )}
      {stage && <p class="text-sm text-muted">Key <code>{stage.key}</code> — automations and reports refer to it by this, so it never changes.</p>}
    </Modal>
  );
}

// ── Appointments ───────────────────────────────────────────────────────────

const APPOINTMENT_EVENTS = [
  { key: 'booked', label: 'When an appointment is booked',
    help: 'Moves forward only — a file already past this stage stays put. A file in Nurture comes back.' },
  { key: 'attended', label: 'When the client attends',
    help: 'Only while the file is still where booking left it; a file someone has moved on stays.' },
  { key: 'missed', label: 'When the client misses it',
    help: 'Same rule. Funded and Lost files are never moved by an appointment.' },
] as const;

/** Where the Appointments module moves this pipeline's files. */
function AppointmentStages({ pipeline, canManage, onSave }: {
  pipeline: Pipeline; canManage: boolean;
  onSave: (next: Pipeline['appointment_stages']) => void;
}) {
  const [draft, setDraft] = useState(pipeline.appointment_stages);
  useEffect(() => setDraft(pipeline.appointment_stages), [pipeline.appointment_stages]);
  const dirty = APPOINTMENT_EVENTS.some((e) => draft[e.key] !== pipeline.appointment_stages[e.key]);
  const options = [
    { value: '', label: 'Don’t move the file' },
    ...pipeline.stages.filter((s) => s.active).map((s) => ({ value: s.key, label: s.label, hint: s.category_label })),
  ];
  const label = (key: string | null) => (key ? pipeline.stages.find((s) => s.key === key)?.label ?? key : 'Don’t move');
  return (
    <div class="card" style={{ marginTop: 14 }}>
      <div class="card-head"><h3 style={{ margin: 0 }}>Appointments</h3></div>
      <div style={{ padding: '4px 16px 16px' }}>
        <p class="text-sm text-muted" style={{ marginTop: 0 }}>
          Where a file in {pipeline.name} moves when a meeting with the client is booked, attended or missed.
        </p>
        <div class="form-grid">
          {APPOINTMENT_EVENTS.map((e) => (
            <Field key={e.key} label={e.label} hint={e.help}>
              {canManage
                ? <SearchSelect value={draft[e.key] ?? ''} options={options} ariaLabel={e.label}
                                onChange={(v) => setDraft({ ...draft, [e.key]: v || null })} />
                : <div class="static-field">{label(pipeline.appointment_stages[e.key])}</div>}
            </Field>
          ))}
        </div>
        {canManage && dirty && (
          <div class="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button class="btn" onClick={() => setDraft(pipeline.appointment_stages)}>Undo</button>
            <button class="btn btn-primary" onClick={() => onSave(draft)}>Save</button>
          </div>
        )}
      </div>
    </div>
  );
}
