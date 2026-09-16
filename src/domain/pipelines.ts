/**
 * Pipeline rules that need no database: what makes a pipeline usable, how a
 * key is made, and where a file should land when its stage goes away.
 *
 * The stage machine (domain/pipeline.ts) decides whether one file may enter
 * one stage. This decides whether a pipeline's stages, taken together, are a
 * pipeline anything can move through.
 */
import type { StageCategory } from './pipeline.ts';

export const STAGE_CATEGORIES: Array<{ key: StageCategory; label: string; help: string }> = [
  { key: 'open', label: 'In progress', help: 'Being worked. Counts in the pipeline and the forecast.' },
  { key: 'parked', label: 'On hold / nurture', help: 'Not lost, not active — revisited later.' },
  { key: 'won', label: 'Won (funded)', help: 'The deal closed. Counts as funded in every report.' },
  { key: 'lost', label: 'Lost', help: 'Not going ahead. Needs a reason.' },
];

/** "Private Lending — Alberta" → "private_lending_alberta". */
export function slugKey(text: string, max = 40): string {
  const slug = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max).replace(/_+$/g, '');
  return slug || 'stage';
}

/** A key not already taken, by adding _2, _3… */
export function uniqueKey(base: string, taken: Set<string>, max = 60): string {
  const root = base.slice(0, max);
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) {
    const candidate = `${root.slice(0, max - String(i).length - 1)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type StageShape = { key?: string; label: string; category: StageCategory; active: boolean };

/**
 * What an active pipeline must have, as sentences. Empty means it is usable.
 *
 * Somewhere to start (an open stage), somewhere to finish well (won) and
 * somewhere to finish badly (lost). Without the first, a new file has no
 * stage to land on; without the others, a file can never be closed.
 */
export function pipelineProblems(stages: StageShape[], pipelineName = 'This pipeline'): string[] {
  const active = stages.filter((s) => s.active);
  const problems: string[] = [];
  if (!active.some((s) => s.category === 'open')) {
    problems.push(`${pipelineName} needs at least one active “In progress” stage — it is where new files start.`);
  }
  if (!active.some((s) => s.category === 'won')) {
    problems.push(`${pipelineName} needs at least one active “Won” stage, or nothing in it can ever be funded.`);
  }
  if (!active.some((s) => s.category === 'lost')) {
    problems.push(`${pipelineName} needs at least one active “Lost” stage, or nothing in it can be closed as lost.`);
  }
  return problems;
}

/** The stage a new file lands on: the first active in-progress stage. */
export function entryStageOf<T extends { category: StageCategory; active: boolean; position: number }>(
  stages: T[],
): T | null {
  return [...stages].filter((s) => s.active && s.category === 'open')
    .sort((a, b) => a.position - b.position)[0] ?? null;
}

/**
 * Where files on a stage that is going away should go, as a suggestion the
 * admin confirms: the same name in the target pipeline, else the first active
 * stage that means the same thing, else where new files start.
 */
export function suggestTarget<T extends { key: string; label: string; category: StageCategory; active: boolean; position: number }>(
  from: { label: string; category: StageCategory },
  candidates: T[],
): T | null {
  const usable = candidates.filter((c) => c.active).sort((a, b) => a.position - b.position);
  const norm = (s: string) => s.trim().toLowerCase();
  return usable.find((c) => norm(c.label) === norm(from.label))
    ?? usable.find((c) => c.category === from.category)
    ?? entryStageOf(usable);
}

/** The stages a brand-new pipeline starts with, when it is not copied from another. */
export const STARTER_STAGES: Array<{
  label: string; category: StageCategory; probability: number | null; colour: string;
  entry_rules: Record<string, unknown>;
}> = [
  { label: 'New', category: 'open', probability: 10, colour: '#6366f1', entry_rules: {} },
  { label: 'In progress', category: 'open', probability: 40, colour: '#0ea5e9', entry_rules: {} },
  { label: 'Funded', category: 'won', probability: 100, colour: '#10b981',
    entry_rules: { requireFundingConfirmed: true, requireComplianceComplete: true } },
  { label: 'Lost', category: 'lost', probability: 0, colour: '#ef4444', entry_rules: { requireLostDisposition: true } },
];
