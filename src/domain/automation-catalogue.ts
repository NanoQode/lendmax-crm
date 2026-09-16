/**
 * What the workflow builder offers: every trigger and every action, grouped the
 * way the picker shows them, with the words a person reads.
 *
 * Served to the screen rather than written into it, so a trigger added to the
 * engine appears in the builder by adding one line here — and a test fails if
 * the engine knows a trigger or step this list does not.
 */
import type { TriggerType } from './automation.ts';

export type TriggerSpec = {
  type: TriggerType;
  label: string;
  group: string;
  description: string;
  /** The setting the trigger needs, if any. */
  config?: 'offset_days' | 'after_hours';
  /** Details of the event itself a filter can test, beyond the file's own facts. */
  event_fields?: Array<{ field: string; label: string; type: string }>;
};

export const TRIGGER_CATALOGUE: TriggerSpec[] = [
  { type: 'customer.created', group: 'Contact', label: 'Contact created',
    description: 'A new client is added — by hand, from the portal or through the API.',
    event_fields: [{ field: 'event.source', label: 'Source', type: 'text' }] },
  { type: 'customer.updated', group: 'Contact', label: 'Contact changed',
    description: 'Somebody edits the client’s contact details.',
    event_fields: [{ field: 'event.changed', label: 'Fields changed', type: 'text' }] },
  { type: 'tag.added', group: 'Contact', label: 'Contact tag added',
    description: 'A tag is put on the client.',
    event_fields: [{ field: 'event.tag', label: 'Tag', type: 'text' }] },
  { type: 'tag.removed', group: 'Contact', label: 'Contact tag removed',
    description: 'A tag is taken off the client.',
    event_fields: [{ field: 'event.tag', label: 'Tag', type: 'text' }] },
  { type: 'lead.assigned', group: 'Contact', label: 'Lead assigned',
    description: 'Somebody is put on the file — by hand, by round robin or by a workflow.',
    event_fields: [{ field: 'event.user_id', label: 'Assigned to', type: 'user' },
                   { field: 'event.role', label: 'As', type: 'text' }] },

  { type: 'application.created', group: 'Application', label: 'Application started',
    description: 'A new application or lead file is opened.' },
  { type: 'application.section_saved', group: 'Application', label: 'Application section saved',
    description: 'The client saves a step of the portal application.' },
  { type: 'application.submitted', group: 'Application', label: 'Application submitted',
    description: 'The client submits the application on the portal.' },
  { type: 'application.completed', group: 'Application', label: 'Application completed',
    description: 'Every required answer is in.' },
  { type: 'application.abandoned', group: 'Application', label: 'Application abandoned',
    description: 'An unsubmitted application has had no activity for a number of hours.',
    config: 'after_hours' },

  { type: 'stage.changed', group: 'Pipeline', label: 'Pipeline stage changed',
    description: 'A file moves to another stage.',
    event_fields: [{ field: 'event.from', label: 'From stage', type: 'stage' },
                   { field: 'event.to', label: 'To stage', type: 'stage' }] },
  { type: 'lender.submitted', group: 'Pipeline', label: 'Sent to Scarlett',
    description: 'The file is sent to Scarlett.' },
  { type: 'file.funded', group: 'Pipeline', label: 'File funded', description: 'The file funds.' },
  { type: 'file.lost', group: 'Pipeline', label: 'File lost', description: 'The file is marked lost.' },

  { type: 'appointment.booked', group: 'Appointments', label: 'Appointment booked',
    description: 'A meeting is booked with the client.' },
  { type: 'appointment.completed', group: 'Appointments', label: 'Appointment attended',
    description: 'The client attended.' },
  { type: 'appointment.no_show', group: 'Appointments', label: 'Appointment no-show',
    description: 'The client did not show.' },

  { type: 'document.requested', group: 'Documents', label: 'Documents requested',
    description: 'The client is sent a document request link.' },
  { type: 'document.uploaded', group: 'Documents', label: 'Document uploaded',
    description: 'The client uploads a document.',
    event_fields: [{ field: 'event.label', label: 'Document', type: 'text' }] },
  { type: 'documents.outstanding', group: 'Documents', label: 'Documents still outstanding',
    description: 'A document request is still open after a number of hours.', config: 'after_hours' },

  { type: 'message.received', group: 'Communication', label: 'Customer replied',
    description: 'The client sends an email or a text.',
    event_fields: [{ field: 'event.channel', label: 'Channel', type: 'text' },
                   { field: 'event.preview', label: 'Message text', type: 'text' }] },
  { type: 'consent.changed', group: 'Communication', label: 'Consent changed',
    description: 'The client unsubscribes, replies STOP or opts back in.' },

  { type: 'task.completed', group: 'Tasks', label: 'Task completed',
    description: 'A task on the file is marked done.',
    event_fields: [{ field: 'event.task_title', label: 'Task title', type: 'text' },
                   { field: 'event.category', label: 'Task category', type: 'text' }] },
  { type: 'task.overdue', group: 'Tasks', label: 'Task overdue',
    description: 'A task on the file passes its due time without being done.',
    event_fields: [{ field: 'event.task_title', label: 'Task title', type: 'text' }] },

  { type: 'closing.approaching', group: 'Dates', label: 'Closing date reminder',
    description: 'A number of days before the closing date.', config: 'offset_days' },
  { type: 'maturity.approaching', group: 'Dates', label: 'Maturity date reminder',
    description: 'A number of days before the mortgage matures.', config: 'offset_days' },
  { type: 'no_activity', group: 'Dates', label: 'No activity',
    description: 'An open file has had no activity for a number of hours.', config: 'after_hours' },

  { type: 'webhook.received', group: 'External', label: 'Inbound webhook',
    description: 'Another system calls this workflow’s webhook address with a client.' },
  { type: 'manual', group: 'External', label: 'Added manually',
    description: 'Somebody adds the client from the workflow or the client’s file, or another workflow does.' },
];

export type ActionSpec = { type: string; label: string; group: string; description: string; icon: string };

export const ACTION_CATALOGUE: ActionSpec[] = [
  { type: 'send_email', group: 'Communication', icon: 'mail', label: 'Send email',
    description: 'Email the client — written here or from a template.' },
  { type: 'send_sms', group: 'Communication', icon: 'sms', label: 'Send SMS',
    description: 'Text the client.' },
  { type: 'internal_email', group: 'Communication', icon: 'mail-staff', label: 'Send internal email',
    description: 'Email a staff member or any address.' },
  { type: 'notify_user', group: 'Communication', icon: 'bell', label: 'Internal notification',
    description: 'A notification in the CRM for somebody on the file.' },

  { type: 'add_tag', group: 'Contact', icon: 'tag', label: 'Add contact tag', description: 'Tag the client.' },
  { type: 'remove_tag', group: 'Contact', icon: 'tag-off', label: 'Remove contact tag', description: 'Untag the client.' },
  { type: 'update_contact', group: 'Contact', icon: 'user', label: 'Update contact field',
    description: 'Set the lead source, referral or preferred language.' },
  { type: 'add_note', group: 'Contact', icon: 'note', label: 'Add note', description: 'Write a note on the file.' },

  { type: 'set_stage', group: 'Pipeline', icon: 'pipeline', label: 'Move pipeline stage',
    description: 'Move the file to a stage. The stage’s rules still apply.' },
  { type: 'assign_user', group: 'Pipeline', icon: 'assign', label: 'Assign to user',
    description: 'Put a named person, or the next in the round robin, on the file.' },
  { type: 'create_task', group: 'Pipeline', icon: 'task', label: 'Create task',
    description: 'Add a task for somebody on the file.' },
  { type: 'request_documents', group: 'Pipeline', icon: 'doc', label: 'Request documents',
    description: 'Send the client an upload link for the checklist.' },

  { type: 'wait', group: 'Workflow', icon: 'clock', label: 'Wait',
    description: 'Pause for a time, or until a date on the file.' },
  { type: 'if_else', group: 'Workflow', icon: 'split', label: 'If / Else',
    description: 'Take a different path depending on the file.' },
  { type: 'goto', group: 'Workflow', icon: 'goto', label: 'Go to', description: 'Jump to another step.' },
  { type: 'enroll_automation', group: 'Workflow', icon: 'flow-in', label: 'Add to workflow',
    description: 'Start the client in another workflow.' },
  { type: 'stop_automation', group: 'Workflow', icon: 'flow-out', label: 'Remove from workflow',
    description: 'End the client’s place in other workflows.' },
  { type: 'stop', group: 'Workflow', icon: 'stop', label: 'End workflow', description: 'Stop here.' },

  { type: 'webhook', group: 'External', icon: 'webhook', label: 'Webhook',
    description: 'Send the client and file to another system.' },
];

export const OPERATORS = [
  { op: 'eq', label: 'is' },
  { op: 'ne', label: 'is not' },
  { op: 'in', label: 'is any of' },
  { op: 'not_in', label: 'is none of' },
  { op: 'gt', label: 'is greater than' },
  { op: 'gte', label: 'is at least' },
  { op: 'lt', label: 'is less than' },
  { op: 'lte', label: 'is at most' },
  { op: 'contains', label: 'contains' },
  { op: 'not_contains', label: 'does not contain' },
  { op: 'is_set', label: 'has a value' },
  { op: 'is_empty', label: 'is empty' },
];
