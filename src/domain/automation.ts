/**
 * The automation definition, and the pure parts of running it.
 *
 * A published version is a frozen document: a trigger, entry conditions, stop
 * conditions, and a graph of nodes. Everything in this file is pure — given a
 * definition and a snapshot of a file, it says what the next step is and
 * whether the enrollment should stop. The database work is in
 * services/automation-engine.ts.
 *
 * Pure because stopping is the part that matters and the part that is hard to
 * test any other way. Most of the damage an automation engine does is not
 * sending the wrong message; it is continuing to send the right message after
 * it stopped being true — a missing-document reminder after the documents
 * arrive, lead nurture after the client funds, a no-show follow-up after they
 * rebooked.
 */
import { z } from 'zod';

// ── The definition ─────────────────────────────────────────────────────────

export const TRIGGERS = [
  'customer.created',
  'application.created',
  'application.section_saved',
  'application.submitted',
  'application.completed',
  'application.abandoned',
  'stage.changed',
  'appointment.booked',
  'appointment.no_show',
  'appointment.completed',
  'document.requested',
  'document.uploaded',
  'documents.outstanding',
  'closing.approaching',
  'lender.submitted',
  'lender.status_changed',
  'file.funded',
  'file.lost',
  'maturity.approaching',
  'task.overdue',
  'no_activity',
  'message.received',
  'consent.changed',
  'manual',
] as const;
export type TriggerType = (typeof TRIGGERS)[number];

const Condition = z.object({
  field: z.string(),
  op: z.enum(['eq', 'ne', 'in', 'not_in', 'lt', 'lte', 'gt', 'gte', 'is_set', 'is_empty', 'contains']),
  value: z.unknown().optional(),
});
export type Condition = z.infer<typeof Condition>;

const BaseNode = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  next: z.string().nullable().optional(),
});

export const NodeSchema = z.discriminatedUnion('type', [
  BaseNode.extend({
    type: z.literal('send_email'),
    template_key: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    purpose: z.enum(['transactional', 'marketing', 'service']).default('transactional'),
  }),
  BaseNode.extend({
    type: z.literal('send_sms'),
    template_key: z.string().optional(),
    body: z.string().optional(),
    purpose: z.enum(['transactional', 'marketing', 'service']).default('transactional'),
  }),
  BaseNode.extend({
    type: z.literal('wait'),
    minutes: z.number().int().min(0).default(0),
    hours: z.number().int().min(0).default(0),
    days: z.number().int().min(0).default(0),
    /** Hold until a working hour rather than firing at 3am on a Sunday. */
    business_hours_only: z.boolean().default(false),
  }),
  BaseNode.extend({
    type: z.literal('branch'),
    conditions: z.array(Condition).default([]),
    /** All conditions, or any. */
    match: z.enum(['all', 'any']).default('all'),
    if_true: z.string().nullable(),
    if_false: z.string().nullable(),
  }),
  BaseNode.extend({
    type: z.literal('create_task'),
    title: z.string(),
    description: z.string().optional(),
    category: z.string().default('follow_up'),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    due_in_days: z.number().int().optional(),
    assign_to: z.enum(['broker', 'underwriter', 'manager', 'compliance']).default('broker'),
  }),
  BaseNode.extend({
    type: z.literal('notify_user'),
    role: z.enum(['broker', 'underwriter', 'manager', 'compliance']).default('broker'),
    title: z.string(),
    body: z.string().optional(),
  }),
  BaseNode.extend({ type: z.literal('add_note'), body: z.string(), note_type: z.string().default('general') }),
  BaseNode.extend({ type: z.literal('add_tag'), tag: z.string() }),
  BaseNode.extend({ type: z.literal('set_stage'), stage_key: z.string() }),
  BaseNode.extend({ type: z.literal('stop'), reason: z.string().optional() }),
]);
export type AutomationNode = z.infer<typeof NodeSchema>;

export const DefinitionSchema = z.object({
  trigger: z.object({
    type: z.enum(TRIGGERS),
    /** For time-based triggers: how far ahead, in days. */
    offset_days: z.number().int().optional(),
    /** For documents.outstanding / no_activity: how long, in hours. */
    after_hours: z.number().int().optional(),
    /** Narrow the trigger, e.g. only when the new stage is `no_show`. */
    filters: z.array(Condition).default([]),
  }),
  entry_conditions: z.array(Condition).default([]),
  /**
   * Evaluated before EVERY step, not only at enrollment. This is the whole
   * safety mechanism: a condition true at enrollment and false three days
   * later must end the sequence at step three, not at step seven.
   */
  stop_conditions: z.array(
    Condition.extend({ reason: z.string() }),
  ).default([]),
  start_node: z.string(),
  nodes: z.array(NodeSchema).min(1),
});
export type AutomationDefinition = z.infer<typeof DefinitionSchema>;

// ── Validation ─────────────────────────────────────────────────────────────

export type ValidationIssue = { level: 'error' | 'warning'; message: string; node?: string };

/**
 * Checked before publishing, never before saving.
 *
 * A draft may be half-finished; a published version may not, because a
 * published version runs against real clients unattended.
 */
export function validateDefinition(definition: AutomationDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const keys = new Set<string>();

  for (const node of definition.nodes) {
    if (keys.has(node.key)) {
      issues.push({ level: 'error', node: node.key, message: `Two steps share the key "${node.key}".` });
    }
    keys.add(node.key);
  }

  if (!keys.has(definition.start_node)) {
    issues.push({ level: 'error', message: `The first step "${definition.start_node}" does not exist.` });
  }

  const reachable = new Set<string>();
  const walk = (key: string | null | undefined): void => {
    if (!key || reachable.has(key)) return;
    const node = definition.nodes.find((n) => n.key === key);
    if (!node) {
      issues.push({ level: 'error', message: `A step points at "${key}", which does not exist.` });
      return;
    }
    reachable.add(key);
    if (node.type === 'branch') { walk(node.if_true); walk(node.if_false); }
    else if (node.type !== 'stop') walk(node.next);
  };
  walk(definition.start_node);

  for (const node of definition.nodes) {
    if (!reachable.has(node.key)) {
      // A warning, not an error: an orphan is usually a step somebody is
      // still wiring up, and blocking the publish for it is unhelpful.
      issues.push({ level: 'warning', node: node.key, message: `"${node.key}" cannot be reached.` });
    }
  }

  // A cycle with no wait in it would run forever in one tick.
  for (const node of definition.nodes) {
    if (node.type !== 'branch' && node.type !== 'stop' && node.next === node.key) {
      issues.push({ level: 'error', node: node.key, message: `"${node.key}" points at itself.` });
    }
  }
  const cycle = findInstantCycle(definition);
  if (cycle) {
    issues.push({
      level: 'error',
      message: `These steps loop with no wait between them: ${cycle.join(' → ')}. ` +
        'Add a wait, or the sequence spins.',
    });
  }

  for (const node of definition.nodes) {
    if ((node.type === 'send_email' || node.type === 'send_sms')
        && !node.template_key && !node.body) {
      issues.push({ level: 'error', node: node.key, message: `"${node.key}" has nothing to send.` });
    }
    if (node.type === 'send_email' && !node.template_key && !node.subject) {
      issues.push({ level: 'error', node: node.key, message: `"${node.key}" has no subject.` });
    }
    if (node.type === 'wait' && node.minutes === 0 && node.hours === 0 && node.days === 0) {
      issues.push({ level: 'warning', node: node.key, message: `"${node.key}" waits for no time at all.` });
    }
    if (node.type === 'branch' && node.conditions.length === 0) {
      issues.push({ level: 'error', node: node.key, message: `"${node.key}" branches on nothing.` });
    }
  }

  if (!definition.stop_conditions.length) {
    // The single most consequential omission an automation can have.
    issues.push({
      level: 'warning',
      message:
        'There are no stop conditions. This sequence will run to the end even if the client ' +
        'funds, is lost, or does the thing it is chasing them for.',
    });
  }

  return issues;
}

/** A loop with no wait on it — the one that spins rather than running slowly. */
function findInstantCycle(definition: AutomationDefinition): string[] | null {
  const byKey = new Map(definition.nodes.map((n) => [n.key, n]));
  const visiting = new Set<string>();
  const path: string[] = [];

  const visit = (key: string | null | undefined): string[] | null => {
    if (!key) return null;
    const node = byKey.get(key);
    if (!node || node.type === 'wait' || node.type === 'stop') return null;
    if (visiting.has(key)) return [...path.slice(path.indexOf(key)), key];
    visiting.add(key);
    path.push(key);
    const nexts = node.type === 'branch' ? [node.if_true, node.if_false] : [node.next];
    for (const next of nexts) {
      const found = visit(next);
      if (found) return found;
    }
    visiting.delete(key);
    path.pop();
    return null;
  };
  return visit(definition.start_node);
}

// ── Evaluating conditions ──────────────────────────────────────────────────

/** The facts a condition may test. Assembled once per step by the engine. */
export type Facts = Record<string, unknown>;

export function evaluateCondition(condition: Condition, facts: Facts): boolean {
  const actual = facts[condition.field];
  const expected = condition.value;

  switch (condition.op) {
    case 'is_set':
      return actual !== null && actual !== undefined && actual !== '';
    case 'is_empty':
      return actual === null || actual === undefined || actual === '';
    case 'eq':
      return String(actual ?? '') === String(expected ?? '');
    case 'ne':
      return String(actual ?? '') !== String(expected ?? '');
    case 'in':
      return Array.isArray(expected) && expected.map(String).includes(String(actual ?? ''));
    case 'not_in':
      return Array.isArray(expected) && !expected.map(String).includes(String(actual ?? ''));
    case 'contains':
      return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'lt': case 'lte': case 'gt': case 'gte': {
      // A comparison against something that is not a number is FALSE, not an
      // error and not true. "percent_complete < 100" must not fire for a file
      // whose percentage is unknown — that is how a client with no data gets
      // chased for not finishing a form they never started.
      //
      // The null check is separate and comes first because `Number(null)` and
      // `Number('')` are both 0, which is finite, so the isFinite test alone
      // lets an absent value through as a zero.
      if (actual === null || actual === undefined || actual === '') return false;
      if (expected === null || expected === undefined || expected === '') return false;
      const a = Number(actual);
      const b = Number(expected);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (condition.op === 'lt') return a < b;
      if (condition.op === 'lte') return a <= b;
      if (condition.op === 'gt') return a > b;
      return a >= b;
    }
    default:
      return false;
  }
}

export function evaluateConditions(
  conditions: Condition[],
  facts: Facts,
  match: 'all' | 'any' = 'all',
): boolean {
  if (!conditions.length) return true;
  return match === 'all'
    ? conditions.every((c) => evaluateCondition(c, facts))
    : conditions.some((c) => evaluateCondition(c, facts));
}

/** The first stop condition that is true, with the reason a person reads. */
export function firstStopReason(
  definition: AutomationDefinition,
  facts: Facts,
): string | null {
  for (const condition of definition.stop_conditions) {
    if (evaluateCondition(condition, facts)) return condition.reason;
  }
  return null;
}

/** How long a wait node waits, in milliseconds. */
export function waitMs(node: Extract<AutomationNode, { type: 'wait' }>): number {
  return ((node.days * 24 + node.hours) * 60 + node.minutes) * 60_000;
}

export function nodeByKey(
  definition: AutomationDefinition,
  key: string | null | undefined,
): AutomationNode | null {
  if (!key) return null;
  return definition.nodes.find((n) => n.key === key) ?? null;
}

/** Where a node sends the enrollment next, given the facts. */
export function nextKey(node: AutomationNode, facts: Facts): string | null {
  if (node.type === 'stop') return null;
  if (node.type === 'branch') {
    return evaluateConditions(node.conditions, facts, node.match) ? node.if_true : node.if_false;
  }
  return node.next ?? null;
}
