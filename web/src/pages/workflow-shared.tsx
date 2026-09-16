/**
 * LM Automation — the pieces the list, the canvas and the drawer share: the
 * shapes, the icons, and the graph edits.
 *
 * A workflow is nodes with `next` pointers, drawn from `start_node` down. A "+"
 * on the canvas is a SLOT — the arrow it sits on — and every insert or delete
 * is a small rewrite of the pointer that arrow is. Steps nothing leads to any
 * more are dropped after each edit, so the saved definition is always exactly
 * what the canvas shows.
 */
import { useAsync } from '../lib/store.ts';

// ── Shapes ─────────────────────────────────────────────────────────────────

export type Condition = { field: string; op: string; value?: unknown; reason?: string };
export type Trigger = { type: string; label?: string; offset_days?: number; after_hours?: number; filters: Condition[] };
export type Branch = { key: string; name: string; match: 'all' | 'any'; conditions: Condition[]; next: string | null };
export type WfNode = { key: string; type: string; label?: string; next?: string | null; [more: string]: any };
export type Definition = {
  trigger?: Trigger; triggers: Trigger[];
  entry_conditions: Condition[]; stop_conditions: Array<Condition & { reason: string }>;
  start_node: string; nodes: WfNode[];
};
export type Issue = { level: 'error' | 'warning'; message: string; node?: string };

export type FactField = { field: string; label: string; type: string; group: string; options?: string[] };
export type Catalogue = {
  triggers: Array<{ type: string; label: string; group: string; description: string;
                    config?: 'offset_days' | 'after_hours'; event_fields?: Array<{ field: string; label: string; type: string }> }>;
  actions: Array<{ type: string; label: string; group: string; description: string; icon: string }>;
  operators: Array<{ op: string; label: string }>;
  fields: FactField[];
  merge_fields: Array<{ name: string; label: string; example: string }>;
  stages: Array<{ key: string; label: string; category: string; pipeline_name?: string }>;
  pipelines: Array<{ id: string; key: string; name: string; active: boolean }>;
  users: Array<{ id: string; name: string; role: string }>;
  automations: Array<{ id: string; name: string; status: string }>;
  templates: Array<{ key: string; name: string; channel: string }>;
  tags: string[];
  required_documents: Array<{ id: string; name: string; purpose: string; required: boolean }>;
};

export type Loaded = {
  automation: { id: string; name: string; description: string | null; status: string; purpose: string;
                published_version: number | null; allow_reenrollment: boolean; reenrollment_cooldown_days: number | null;
                active_enrollments: number; completed_enrollments: number; stopped_enrollments: number };
  versions: Array<{ version: number; published_at: string | null; published_by_name: string | null; running: number }>;
  draft_version: number | null;
  definition: Definition | null;
  issues: Issue[];
};

export const useCatalogue = () => useAsync<Catalogue>('/automations/catalogue');

export const STATUS_LABEL: Record<string, string> = { active: 'Published', draft: 'Draft', paused: 'Paused' };

// ── Icons ──────────────────────────────────────────────────────────────────

const PATHS: Record<string, string> = {
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  mail: 'M4 5h16v14H4z M4 6l8 7 8-7',
  'mail-staff': 'M4 5h16v14H4z M4 6l8 7 8-7 M17 15h4 M19 13v4',
  sms: 'M4 4h16v12H8l-4 4z',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4z M10 20h4',
  tag: 'M3 12V4h8l10 10-8 8z M7.5 7.5h.01',
  'tag-off': 'M3 12V4h8l10 10-8 8z M4 20 20 4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c0-4 4-6 8-6s8 2 8 6',
  note: 'M5 3h10l4 4v14H5z M9 12h6 M9 16h6',
  pipeline: 'M4 6h6v12H4z M14 6h6v7h-6z',
  assign: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21c0-4 3-6 7-6 M16 14l2 2 4-4',
  task: 'M4 4h16v16H4z M8 12l3 3 5-6',
  doc: 'M6 3h9l4 4v14H6z M14 3v5h5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  split: 'M12 3v6 M12 9 5 16v5 M12 9l7 7v5',
  goto: 'M4 17V9a4 4 0 0 1 4-4h9 M14 2l3 3-3 3',
  'flow-in': 'M3 12h12 M11 8l4 4-4 4 M17 4h4v16h-4',
  'flow-out': 'M9 12h12 M17 8l4 4-4 4 M7 4H3v16h4',
  stop: 'M6 6h12v12H6z',
  webhook: 'M9 17a4 4 0 1 1-2-6.9 M15 7a4 4 0 1 1 1.5 7.7 M12 11l-3 6h7',
  plus: 'M12 5v14 M5 12h14',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  copy: 'M8 8h12v12H8z M4 16V4h12',
  test: 'M9 3h6 M10 3v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3',
  back: 'M15 18l-6-6 6-6',
  x: 'M6 6l12 12 M18 6 6 18',
};

export function Svg({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {(PATHS[name] ?? PATHS.bolt!).split(' M').map((d, i) => <path key={i} d={i ? `M${d}` : d} />)}
    </svg>
  );
}

export const GROUP_TONE: Record<string, string> = {
  Communication: 'blue', Contact: 'green', Pipeline: 'purple', Workflow: 'orange', External: 'grey',
};

// ── The graph ──────────────────────────────────────────────────────────────

/** Where an arrow on the canvas comes from — the thing a "+" edits. */
export type Slot =
  | { kind: 'start' }
  | { kind: 'next'; key: string }
  | { kind: 'branch'; key: string; branch: string }
  | { kind: 'else'; key: string }
  | { kind: 'yes' | 'no'; key: string };

export const nodeOf = (def: Definition, key: string | null | undefined) => def.nodes.find((n) => n.key === key) ?? null;

export function targetOf(def: Definition, slot: Slot): string | null {
  if (slot.kind === 'start') return def.start_node || null;
  const node = nodeOf(def, slot.key);
  if (!node) return null;
  switch (slot.kind) {
    case 'next': return node.next ?? null;
    case 'branch': return (node.branches as Branch[]).find((b) => b.key === slot.branch)?.next ?? null;
    case 'else': return node.else_next ?? null;
    case 'yes': return node.if_true ?? null;
    case 'no': return node.if_false ?? null;
  }
}

function withTarget(def: Definition, slot: Slot, target: string | null): Definition {
  if (slot.kind === 'start') return { ...def, start_node: target ?? '' };
  return {
    ...def,
    nodes: def.nodes.map((n) => {
      if (n.key !== slot.key) return n;
      switch (slot.kind) {
        case 'next': return { ...n, next: target };
        case 'branch': return { ...n, branches: (n.branches as Branch[]).map((b) => (b.key === slot.branch ? { ...b, next: target } : b)) };
        case 'else': return { ...n, else_next: target };
        case 'yes': return { ...n, if_true: target };
        case 'no': return { ...n, if_false: target };
      }
    }),
  };
}

function successorsOf(n: WfNode): Array<string | null | undefined> {
  if (n.type === 'stop') return [];
  if (n.type === 'if_else') return [...(n.branches as Branch[]).map((b) => b.next), n.else_next];
  if (n.type === 'branch') return [n.if_true, n.if_false];
  if (n.type === 'goto') return [n.target];
  return [n.next];
}

/** Drop steps nothing leads to any more. */
export function collect(def: Definition): Definition {
  const keep = new Set<string>();
  const walk = (key: string | null | undefined) => {
    if (!key || keep.has(key)) return;
    const n = nodeOf(def, key);
    if (!n) return;
    keep.add(key);
    successorsOf(n).forEach(walk);
  };
  walk(def.start_node);
  return { ...def, nodes: def.nodes.filter((n) => keep.has(n.key)) };
}

export const newKey = () => `n_${Math.random().toString(36).slice(2, 8)}`;

/** Put a step on an arrow: what the arrow pointed at now follows the new step (an If/Else's None path). */
export function insertAt(def: Definition, slot: Slot, node: WfNode): Definition {
  const continuation = targetOf(def, slot);
  let placed: WfNode = node;
  if (node.type === 'if_else') placed = { ...node, else_next: continuation };
  else if (node.type !== 'stop' && node.type !== 'goto') placed = { ...node, next: continuation };
  return collect(withTarget({ ...def, nodes: [...def.nodes, placed] }, slot, node.key));
}

/** Take a step out: a plain step is closed over; an If/Else keeps its None path and drops its branches. */
export function removeNode(def: Definition, key: string): Definition {
  const node = nodeOf(def, key);
  if (!node) return def;
  const replacement = node.type === 'if_else' ? node.else_next ?? null
    : node.type === 'branch' || node.type === 'goto' || node.type === 'stop' ? null
    : node.next ?? null;
  const swap = (v: string | null | undefined) => (v === key ? replacement : v);
  const out: Definition = {
    ...def,
    start_node: def.start_node === key ? replacement ?? '' : def.start_node,
    nodes: def.nodes.filter((n) => n.key !== key).map((n) => {
      if (n.type === 'if_else') return { ...n, else_next: swap(n.else_next), branches: (n.branches as Branch[]).map((b) => ({ ...b, next: swap(b.next) })) };
      if (n.type === 'branch') return { ...n, if_true: swap(n.if_true), if_false: swap(n.if_false) };
      if (n.type === 'goto') return { ...n, target: n.target === key ? null : n.target };
      return { ...n, next: swap(n.next) };
    }),
  };
  return collect(out);
}

export function defaultsFor(type: string, cat: Catalogue): WfNode {
  const key = newKey();
  switch (type) {
    case 'send_email': return { key, type, purpose: 'transactional', subject: '', body: 'Hi {first_name},\n\n' };
    case 'send_sms': return { key, type, purpose: 'transactional', body: 'Hi {first_name}, ' };
    case 'internal_email': return { key, type, to: 'role', role: 'broker', subject: '', body: '' };
    case 'notify_user': return { key, type, role: 'broker', title: '' };
    case 'wait': return { key, type, days: 1, hours: 0, minutes: 0, business_hours_only: true };
    case 'if_else': return { key, type, else_next: null, branches: [{ key: newKey(), name: 'Branch 1', match: 'all', conditions: [{ field: cat.fields[0]?.field ?? 'stage_key', op: 'is_set' }], next: null }] };
    case 'goto': return { key, type, target: null };
    case 'add_tag': case 'remove_tag': return { key, type, tag: '' };
    case 'update_contact': return { key, type, field: 'lead_source', value: '' };
    case 'add_note': return { key, type, body: '', note_type: 'general' };
    case 'set_stage': return { key, type, stage_key: '' };
    case 'assign_user': return { key, type, mode: 'round_robin', role: 'broker', only_if_unassigned: true };
    case 'create_task': return { key, type, title: '', category: 'follow_up', priority: 'normal', due_in_days: 1, assign_to: 'broker' };
    case 'request_documents': return { key, type, required_document_ids: [], channel: 'email', expires_in_days: 21 };
    case 'enroll_automation': return { key, type, automation_id: '' };
    case 'stop_automation': return { key, type, automation_id: null };
    case 'webhook': return { key, type, url: 'https://', method: 'POST' };
    case 'stop': return { key, type, reason: '' };
    default: return { key, type };
  }
}

// ── Describing ─────────────────────────────────────────────────────────────

export function describeNode(n: WfNode, cat: Catalogue, def: Definition): string {
  const template = () => cat.templates.find((t) => t.key === n.template_key)?.name ?? n.template_key;
  switch (n.type) {
    case 'send_email': return n.template_key ? `Template: ${template()}` : n.subject || 'No subject yet';
    case 'send_sms': return n.template_key ? `Template: ${template()}` : String(n.body ?? '').slice(0, 60) || 'Nothing to send yet';
    case 'internal_email': return `To ${n.to === 'user' ? cat.users.find((u) => u.id === n.user_id)?.name ?? 'a user' : n.to === 'address' ? n.address ?? 'an address' : `the ${n.role}`}: ${n.subject || 'no subject'}`;
    case 'notify_user': return `${n.user_id ? cat.users.find((u) => u.id === n.user_id)?.name ?? 'A user' : `The ${n.role}`}: ${n.title || 'no title'}`;
    case 'wait':
      if (n.until_field) {
        const days = Number(n.until_offset_days ?? 0);
        return `Until ${Math.abs(days)} day(s) ${days < 0 ? 'before' : 'after'} the ${String(n.until_field).replace(/_at$/, '').replace(/_/g, ' ')}`;
      }
      return ([n.days ? `${n.days} day(s)` : '', n.hours ? `${n.hours} hour(s)` : '', n.minutes ? `${n.minutes} min` : ''].filter(Boolean).join(' ') || 'No time')
        + (n.business_hours_only ? ', then working hours' : '');
    case 'if_else': return `${(n.branches as Branch[]).length} branch(es) + None`;
    case 'goto': { const t = nodeOf(def, n.target); return `Go to "${t?.label ?? t?.type ?? 'nowhere yet'}"`; }
    case 'add_tag': case 'remove_tag': return n.tag ? `"${n.tag}"` : 'No tag yet';
    case 'update_contact': return `${String(n.field).replace(/_/g, ' ')} → ${n.value || '(empty)'}`;
    case 'add_note': return String(n.body ?? '').slice(0, 60) || 'Empty note';
    case 'set_stage': { const s = cat.stages.find((x) => x.key === n.stage_key); return s ? `${s.pipeline_name ? `${s.pipeline_name} · ` : ''}${s.label}` : 'No stage chosen'; }
    case 'assign_user': return n.mode === 'round_robin' ? `Round robin (${n.role})` : `${cat.users.find((u) => u.id === n.user_id)?.name ?? 'Nobody chosen'} (${n.role})`;
    case 'create_task': return n.title || 'No title yet';
    case 'request_documents': return n.required_document_ids?.length ? `${n.required_document_ids.length} document(s)` : 'Every required document for the purpose';
    case 'enroll_automation': return cat.automations.find((a) => a.id === n.automation_id)?.name ?? 'No workflow chosen';
    case 'stop_automation': return n.automation_id ? cat.automations.find((a) => a.id === n.automation_id)?.name ?? 'A workflow' : 'Every other workflow';
    case 'webhook': return `${n.method} ${n.url}`;
    case 'stop': return n.reason || 'The workflow ends here';
    case 'branch': return 'Yes / No';
    default: return '';
  }
}
