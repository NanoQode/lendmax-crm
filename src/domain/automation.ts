/**
 * The automation definition, and the pure parts of running it.
 *
 * A published version is a frozen document: one or more triggers, entry
 * conditions, stop conditions, and a graph of steps. Everything in this file is
 * pure — given a definition and a snapshot of a file, it says what the next
 * step is and whether the enrollment should stop. The database work is in
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
import { ACTION_CATALOGUE } from './automation-catalogue.ts';

// ── Triggers ───────────────────────────────────────────────────────────────

export const TRIGGERS = [
  // Contacts and leads
  'customer.created',
  'customer.updated',
  'tag.added',
  'tag.removed',
  'lead.assigned',
  // The application
  'application.created',
  'application.section_saved',
  'application.submitted',
  'application.completed',
  'application.abandoned',
  // Pipeline
  'stage.changed',
  'file.funded',
  'file.lost',
  'lender.submitted',
  // Appointments
  'appointment.booked',
  'appointment.no_show',
  'appointment.completed',
  // Documents
  'document.requested',
  'document.uploaded',
  'documents.outstanding',
  // Communication
  'message.received',
  'consent.changed',
  // Tasks
  'task.completed',
  'task.overdue',
  // Dates and inactivity
  'closing.approaching',
  'maturity.approaching',
  'no_activity',
  // Outside the CRM
  'webhook.received',
  'manual',
] as const;
export type TriggerType = (typeof TRIGGERS)[number];

/**
 * Triggers that are not caused by somebody doing something, but by time
 * passing. The engine looks for them on its own tick (`emitTimeEvents`),
 * once per automation, because their settings — how many days, how many
 * hours — belong to the automation rather than to the event.
 */
export const TIME_TRIGGERS: TriggerType[] = [
  'closing.approaching', 'maturity.approaching', 'no_activity', 'documents.outstanding',
  'application.abandoned', 'task.overdue',
];

const Condition = z.object({
  field: z.string(),
  op: z.enum(['eq', 'ne', 'in', 'not_in', 'lt', 'lte', 'gt', 'gte', 'is_set', 'is_empty', 'contains',
              'not_contains']),
  value: z.unknown().optional(),
});
export type Condition = z.infer<typeof Condition>;

export const TriggerSchema = z.object({
  type: z.enum(TRIGGERS),
  /** For time-based triggers: how far ahead, in days. */
  offset_days: z.number().int().optional(),
  /** For documents.outstanding / no_activity / abandoned: how long, in hours. */
  after_hours: z.number().int().optional(),
  /**
   * Narrow the trigger — only when the new stage is `no_show`, only when the
   * tag is `vip`. Evaluated against the file's facts with the event's own
   * details added as `event.*`.
   */
  filters: z.array(Condition).default([]),
  /** A name a person gives this trigger on the canvas. */
  label: z.string().optional(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

// ── Steps ──────────────────────────────────────────────────────────────────

const BaseNode = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  next: z.string().nullable().optional(),
});

const ROLE = z.enum(['broker', 'underwriter', 'manager', 'compliance']);

export const NodeSchema = z.discriminatedUnion('type', [
  // ── Communication
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
    type: z.literal('internal_email'),
    /** A role on the file, a named staff member, or a typed address. */
    to: z.enum(['role', 'user', 'address']).default('role'),
    role: ROLE.default('broker'),
    user_id: z.string().uuid().optional(),
    address: z.string().email().optional(),
    subject: z.string().default(''),
    body: z.string().default(''),
  }),
  BaseNode.extend({
    type: z.literal('notify_user'),
    role: ROLE.default('broker'),
    user_id: z.string().uuid().optional(),
    title: z.string(),
    body: z.string().optional(),
  }),
  // ── Timing and logic
  BaseNode.extend({
    type: z.literal('wait'),
    minutes: z.number().int().min(0).default(0),
    hours: z.number().int().min(0).default(0),
    days: z.number().int().min(0).default(0),
    /** Hold until a working hour rather than firing at 3am on a Sunday. */
    business_hours_only: z.boolean().default(false),
    /**
     * Wait until a date on the file instead of for a length of time — "three
     * days before the closing date". Missing or already past: carries on now.
     */
    until_field: z.enum(['closing_date', 'maturity_date', 'next_appointment_at']).optional(),
    until_offset_days: z.number().int().optional(),
  }),
  BaseNode.extend({
    type: z.literal('branch'),
    conditions: z.array(Condition).default([]),
    /** All conditions, or any. */
    match: z.enum(['all', 'any']).default('all'),
    if_true: z.string().nullable(),
    if_false: z.string().nullable(),
  }),
  /**
   * If / else with as many branches as it needs. Checked top to bottom; the
   * first branch whose conditions hold is taken, and `else_next` when none do.
   */
  BaseNode.extend({
    type: z.literal('if_else'),
    branches: z.array(z.object({
      key: z.string().min(1),
      name: z.string().default('Branch'),
      match: z.enum(['all', 'any']).default('all'),
      conditions: z.array(Condition).default([]),
      next: z.string().nullable().default(null),
    })).min(1),
    else_next: z.string().nullable().default(null),
  }),
  BaseNode.extend({ type: z.literal('goto'), target: z.string().nullable().default(null) }),
  BaseNode.extend({ type: z.literal('stop'), reason: z.string().optional() }),
  // ── Contact
  BaseNode.extend({ type: z.literal('add_tag'), tag: z.string() }),
  BaseNode.extend({ type: z.literal('remove_tag'), tag: z.string() }),
  BaseNode.extend({
    type: z.literal('update_contact'),
    field: z.enum(['lead_source', 'referral_source', 'preferred_language']),
    value: z.string().default(''),
  }),
  BaseNode.extend({ type: z.literal('add_note'), body: z.string(), note_type: z.string().default('general') }),
  // ── Pipeline and people
  BaseNode.extend({ type: z.literal('set_stage'), stage_key: z.string() }),
  BaseNode.extend({
    type: z.literal('assign_user'),
    /** Round robin picks the next person in turn, as a new lead would. */
    mode: z.enum(['user', 'round_robin']).default('user'),
    user_id: z.string().uuid().optional(),
    role: z.enum(['broker', 'underwriter']).default('broker'),
    /** Leave a file that already has somebody in the role alone. */
    only_if_unassigned: z.boolean().default(true),
  }),
  BaseNode.extend({
    type: z.literal('create_task'),
    title: z.string(),
    description: z.string().optional(),
    category: z.string().default('follow_up'),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    due_in_days: z.number().int().optional(),
    assign_to: ROLE.default('broker'),
  }),
  BaseNode.extend({
    type: z.literal('request_documents'),
    /** Checklist entries by id; empty means every required entry for the file's purpose. */
    required_document_ids: z.array(z.string().uuid()).default([]),
    channel: z.enum(['email', 'sms', 'both']).default('email'),
    message: z.string().optional(),
    expires_in_days: z.number().int().min(1).max(90).default(21),
  }),
  // ── Workflows
  // Empty until somebody picks one, so a half-built draft still saves;
  // validateDefinition refuses to publish it that way.
  BaseNode.extend({ type: z.literal('enroll_automation'), automation_id: z.union([z.string().uuid(), z.literal('')]).default('') }),
  BaseNode.extend({
    type: z.literal('stop_automation'),
    /** A specific workflow, or every other one this client is in. */
    automation_id: z.string().uuid().nullable().default(null),
  }),
  // ── Outside the CRM
  BaseNode.extend({
    type: z.literal('webhook'),
    /** Checked by validateDefinition, not here, so a draft saves before the address is typed. */
    url: z.string().default(''),
    method: z.enum(['POST', 'PUT']).default('POST'),
    /** Sent as a header, for the receiving end to check. */
    secret: z.string().optional(),
  }),
]);
export type AutomationNode = z.infer<typeof NodeSchema>;

/**
 * The whole document.
 *
 * `triggers` is a list — a workflow can start from any of several events, as
 * in GoHighLevel. Older versions stored a single `trigger`; both are accepted
 * and both are always present after parsing, so the engine reads `triggers`
 * and nothing that still reads `trigger` breaks.
 */
export const DefinitionSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const d = { ...(raw as Record<string, unknown>) };
    if (!Array.isArray(d.triggers) || !d.triggers.length) {
      d.triggers = d.trigger ? [d.trigger] : [{ type: 'manual' }];
    }
    d.trigger = (d.triggers as unknown[])[0];
    return d;
  },
  z.object({
    trigger: TriggerSchema,
    triggers: z.array(TriggerSchema).min(1),
    entry_conditions: z.array(Condition).default([]),
    /**
     * Evaluated before EVERY step, not only at enrollment. This is the whole
     * safety mechanism: a condition true at enrollment and false three days
     * later must end the sequence at step three, not at step seven.
     */
    stop_conditions: z.array(Condition.extend({ reason: z.string() })).default([]),
    /** Empty on a brand-new workflow with nothing on the canvas yet. */
    start_node: z.string().default(''),
    nodes: z.array(NodeSchema).default([]),
  }),
);
export type AutomationDefinition = z.infer<typeof DefinitionSchema>;
/** A definition as written by hand (a recipe): one trigger or several. */
export type AutomationDefinitionInput = Omit<AutomationDefinition, 'trigger' | 'triggers'>
  & { trigger?: Trigger; triggers?: Trigger[] };

/** Every step a node can lead to, in the order the canvas draws them. */
export function successors(node: AutomationNode): Array<string | null | undefined> {
  switch (node.type) {
    case 'stop': return [];
    case 'branch': return [node.if_true, node.if_false];
    case 'if_else': return [...node.branches.map((b) => b.next), node.else_next];
    case 'goto': return [node.target];
    default: return [node.next];
  }
}

// ── Validation ─────────────────────────────────────────────────────────────

export type ValidationIssue = { level: 'error' | 'warning'; message: string; node?: string };

/** How a step is named in a message: its own label, else what kind of step it is. */
const nameOf = (node: AutomationNode) => {
  if (node.label) return `"${node.label}"`;
  const kind = ACTION_CATALOGUE.find((a) => a.type === node.type)?.label;
  return kind ? `The "${kind}" step` : `"${node.key}"`;
};

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

  if (!definition.nodes.length) {
    issues.push({ level: 'error', message: 'Add at least one action under the trigger.' });
  } else if (!keys.has(definition.start_node)) {
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
    for (const next of successors(node)) walk(next);
  };
  walk(definition.start_node);

  for (const node of definition.nodes) {
    if (!reachable.has(node.key)) {
      // A warning, not an error: an orphan is usually a step somebody is
      // still wiring up, and blocking the publish for it is unhelpful.
      issues.push({ level: 'warning', node: node.key, message: `${nameOf(node)} cannot be reached.` });
    }
  }

  // A cycle with no wait in it would run forever in one tick.
  for (const node of definition.nodes) {
    if (successors(node).includes(node.key)) {
      issues.push({ level: 'error', node: node.key, message: `${nameOf(node)} points at itself.` });
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

  for (const trigger of definition.triggers) {
    if ((trigger.type === 'closing.approaching' || trigger.type === 'maturity.approaching')
        && trigger.offset_days === undefined) {
      issues.push({ level: 'error', message: 'A date trigger needs to say how many days before.' });
    }
    if (['no_activity', 'documents.outstanding', 'application.abandoned'].includes(trigger.type)
        && !trigger.after_hours) {
      issues.push({ level: 'error', message: 'An inactivity trigger needs to say after how many hours.' });
    }
  }

  for (const node of definition.nodes) {
    const name = nameOf(node);
    switch (node.type) {
      case 'send_email':
        if (!node.template_key && !node.body) issues.push({ level: 'error', node: node.key, message: `${name} has nothing to send.` });
        if (!node.template_key && !node.subject) issues.push({ level: 'error', node: node.key, message: `${name} has no subject.` });
        break;
      case 'send_sms':
        if (!node.template_key && !node.body) issues.push({ level: 'error', node: node.key, message: `${name} has nothing to send.` });
        break;
      case 'internal_email':
        if (!node.subject || !node.body) issues.push({ level: 'error', node: node.key, message: `${name} needs a subject and a message.` });
        if (node.to === 'user' && !node.user_id) issues.push({ level: 'error', node: node.key, message: `${name} has nobody to send to.` });
        if (node.to === 'address' && !node.address) issues.push({ level: 'error', node: node.key, message: `${name} has no address.` });
        break;
      case 'wait':
        if (!node.until_field && node.minutes === 0 && node.hours === 0 && node.days === 0) {
          issues.push({ level: 'warning', node: node.key, message: `${name} waits for no time at all.` });
        }
        break;
      case 'branch':
        if (node.conditions.length === 0) issues.push({ level: 'error', node: node.key, message: `${name} branches on nothing.` });
        break;
      case 'if_else':
        node.branches.forEach((b) => {
          if (!b.conditions.length) {
            issues.push({ level: 'error', node: node.key, message: `The "${b.name}" branch of ${name.replace(/^The /, "the ")} has no conditions.` });
          }
        });
        break;
      case 'add_tag': case 'remove_tag':
        if (!node.tag.trim()) issues.push({ level: 'error', node: node.key, message: `${name} has no tag.` });
        break;
      case 'set_stage':
        if (!node.stage_key) issues.push({ level: 'error', node: node.key, message: `${name} has no stage.` });
        break;
      case 'assign_user':
        if (node.mode === 'user' && !node.user_id) issues.push({ level: 'error', node: node.key, message: `${name} has nobody to assign.` });
        break;
      case 'create_task':
        if (!node.title.trim()) issues.push({ level: 'error', node: node.key, message: `${name} has no title.` });
        break;
      case 'add_note':
        if (!node.body.trim()) issues.push({ level: 'error', node: node.key, message: `${name} is empty.` });
        break;
      case 'notify_user':
        if (!node.title.trim()) issues.push({ level: 'error', node: node.key, message: `${name} has no title.` });
        break;
      case 'goto':
        if (!node.target) issues.push({ level: 'error', node: node.key, message: `${name} does not say where to go.` });
        break;
      case 'enroll_automation':
        if (!node.automation_id) issues.push({ level: 'error', node: node.key, message: `${name} has no workflow to add the client to.` });
        break;
      case 'webhook':
        if (!URL.canParse(node.url) || new URL(node.url).hostname === '') {
          issues.push({ level: 'error', node: node.key, message: `${name} has no web address to call.` });
        } else if (!node.url.startsWith('https://')) {
          issues.push({ level: 'error', node: node.key, message: `${name} must call an https:// address.` });
        }
        break;
      default:
        break;
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
  const done = new Set<string>();
  const path: string[] = [];

  const visit = (key: string | null | undefined): string[] | null => {
    if (!key || done.has(key)) return null;
    const node = byKey.get(key);
    if (!node || node.type === 'wait' || node.type === 'stop') return null;
    if (visiting.has(key)) return [...path.slice(path.indexOf(key)), key];
    visiting.add(key);
    path.push(key);
    for (const next of successors(node)) {
      const found = visit(next);
      if (found) return found;
    }
    visiting.delete(key);
    done.add(key);
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

  // A list-valued fact (tags) matches on membership.
  if (Array.isArray(actual)) {
    const list = actual.map((v) => String(v).toLowerCase());
    const wanted = (Array.isArray(expected) ? expected : [expected]).map((v) => String(v ?? '').toLowerCase());
    switch (condition.op) {
      case 'is_set': return list.length > 0;
      case 'is_empty': return list.length === 0;
      case 'eq': case 'contains': case 'in': return wanted.some((w) => list.includes(w));
      case 'ne': case 'not_contains': case 'not_in': return !wanted.some((w) => list.includes(w));
      default: return false;
    }
  }

  switch (condition.op) {
    case 'is_set':
      return actual !== null && actual !== undefined && actual !== '' && actual !== false;
    case 'is_empty':
      return actual === null || actual === undefined || actual === '' || actual === false;
    case 'eq':
      return String(actual ?? '').toLowerCase() === String(expected ?? '').toLowerCase();
    case 'ne':
      return String(actual ?? '').toLowerCase() !== String(expected ?? '').toLowerCase();
    case 'in':
      return Array.isArray(expected) && expected.map(String).includes(String(actual ?? ''));
    case 'not_in':
      return Array.isArray(expected) && !expected.map(String).includes(String(actual ?? ''));
    case 'contains':
      return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'not_contains':
      return !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
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
      const a = Number(String(actual).replace(/[$,\s]/g, ''));
      const b = Number(String(expected).replace(/[$,\s]/g, ''));
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

/**
 * When a wait ends. A length of time from now, or a date on the file moved
 * by an offset. A date already past, or not on the file, ends the wait now —
 * a reminder three days before a closing that is tomorrow is late, not never.
 */
export function waitUntil(node: Extract<AutomationNode, { type: 'wait' }>, facts: Facts, now = new Date()): Date {
  if (node.until_field) {
    const raw = facts[node.until_field];
    const at = raw ? new Date(String(raw).length === 10 ? `${raw}T09:00:00` : String(raw)) : null;
    if (!at || Number.isNaN(at.getTime())) return now;
    at.setDate(at.getDate() + (node.until_offset_days ?? 0));
    return at.getTime() > now.getTime() ? at : now;
  }
  return new Date(now.getTime() + waitMs(node));
}

export function nodeByKey(
  definition: AutomationDefinition,
  key: string | null | undefined,
): AutomationNode | null {
  if (!key) return null;
  return definition.nodes.find((n) => n.key === key) ?? null;
}

/** Which branch of an if/else is taken, or null for "none of them". */
export function chosenBranch(node: Extract<AutomationNode, { type: 'if_else' }>, facts: Facts) {
  return node.branches.find((b) => evaluateConditions(b.conditions, facts, b.match)) ?? null;
}

/** Where a node sends the enrollment next, given the facts. */
export function nextKey(node: AutomationNode, facts: Facts): string | null {
  switch (node.type) {
    case 'stop': return null;
    case 'branch':
      return evaluateConditions(node.conditions, facts, node.match) ? node.if_true : node.if_false;
    case 'if_else': {
      const branch = chosenBranch(node, facts);
      return branch ? branch.next : node.else_next;
    }
    case 'goto': return node.target;
    default: return node.next ?? null;
  }
}
