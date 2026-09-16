/**
 * Pipelines and stages as dropdown options, from the config every screen
 * already has. One helper so a stage reads the same way everywhere: its name,
 * and — once there is more than one pipeline — which pipeline it is in.
 */
import type { Config } from './store.ts';
import type { SelectOption } from '../components/ui.tsx';

export const STAGE_CATEGORY_LABELS: Record<string, string> = {
  open: 'In progress', parked: 'On hold', won: 'Won', lost: 'Lost',
};

/** More than one active pipeline — worth naming the pipeline beside a stage. */
export const hasSeveralPipelines = (config: Config | null) =>
  (config?.pipelines ?? []).filter((p) => p.active).length > 1;

/**
 * Stages a file may be moved to: active, in an active pipeline. Pass a
 * pipeline to limit it to that one.
 */
export function stageOptions(config: Config | null, opts: { pipelineId?: string; exclude?: string | null } = {}): SelectOption[] {
  const several = hasSeveralPipelines(config);
  return (config?.stages ?? [])
    .filter((s) => s.active && s.pipeline_active !== false)
    .filter((s) => !opts.pipelineId || s.pipeline_id === opts.pipelineId)
    .filter((s) => s.key !== opts.exclude)
    .map((s) => ({
      value: s.key,
      label: several && !opts.pipelineId ? `${s.label} — ${s.pipeline_name}` : s.label,
      hint: STAGE_CATEGORY_LABELS[s.category],
    }));
}

export function pipelineOptions(config: Config | null, opts: { activeOnly?: boolean } = {}): SelectOption[] {
  return (config?.pipelines ?? [])
    .filter((p) => !opts.activeOnly || p.active)
    .map((p) => ({ value: p.id, label: p.name, hint: p.is_default ? 'Default' : p.active ? undefined : 'Inactive' }));
}
