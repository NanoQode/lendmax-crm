/**
 * Activity logs — the rules, without a database.
 *
 * What counts as a person's activity, which module an action belongs to, and
 * what it is called on screen. The service (services/activity.ts) and the
 * backfill in migration 0020 both follow this; the test keeps them together.
 */
import { MODULES } from './permissions.ts';

/** How long the activity screen keeps anything. The compliance audit trail is separate. */
export const RETENTION_DAYS = 30;

/** Opening the same file again within this window is one entry, not ten. */
export const FILE_VIEW_WINDOW_MINUTES = 30;

/** The action a file view is recorded under. */
export const FILE_VIEW_ACTION = 'customer.opened';

/**
 * Staff activity only. The automation engine and a client on an upload link
 * are in the audit trail, but they are nobody's work to review here.
 */
export function isStaffActivity(actor: { kind?: string | null; userId?: string | null }): boolean {
  const kind = actor.kind ?? 'user';
  return kind === 'integration' || (kind === 'user' && !!actor.userId);
}

/** A person's own account, as opposed to managing somebody else's. */
const ACCOUNT_ACTIONS = new Set([
  'user.profile_updated', 'user.password_changed', 'user.signature_updated', 'user.activated',
]);

const MODULE_BY_PREFIX: Record<string, string> = {
  auth: 'account',
  user: 'staff',
  customer: 'customers', application: 'customers', renewal: 'customers', calculator: 'customers',
  assignment: 'pipeline', pipeline: 'pipeline', stage: 'pipeline',
  document: 'documents',
  required_document: 'required_documents',
  message: 'messages', template: 'messages', consent: 'messages',
  chat: 'chats',
  task: 'tasks', note: 'tasks',
  appointment: 'calendar',
  automation: 'automations',
  campaign: 'campaigns',
  scarlett: 'underwriting', underwriting: 'underwriting',
  funding: 'funding', commission: 'funding',
  compliance: 'compliance',
  report: 'reports',
  settings: 'settings', integration: 'settings', api_key: 'settings',
  audit: 'system',
  activity: 'activity',
};

export function moduleOf(action: string): string {
  if (ACCOUNT_ACTIONS.has(action)) return 'account';
  return MODULE_BY_PREFIX[action.split('.')[0] ?? ''] ?? 'other';
}

/** Every module an entry can be filed under, in the order the filter lists them. */
export const ACTIVITY_MODULES: Array<{ key: string; label: string }> = [
  { key: 'account', label: 'Sign-in & profile' },
  ...MODULES.filter((m) => m.key !== 'sensitive').map((m) => ({ key: m.key, label: m.label })),
  { key: 'other', label: 'Other' },
];

export const moduleLabel = (key: string): string =>
  ACTIVITY_MODULES.find((m) => m.key === key)?.label ?? key;

/** What an action is called on screen. Anything not listed is spelled out from its key. */
const ACTION_LABELS: Record<string, string> = {
  'auth.sign_in': 'Signed in',
  'auth.sign_out': 'Signed out',
  'auth.sign_in_failed': 'Failed sign-in',
  'user.create': 'Added a staff member',
  'user.update': 'Edited a staff member',
  'user.deactivate': 'Deactivated a staff member',
  'user.reactivate': 'Reactivated a staff member',
  'user.delete': 'Deleted a staff member',
  'user.invite_resent': 'Resent an invitation',
  'user.activated': 'Activated their account',
  'user.profile_updated': 'Updated their profile',
  'user.password_changed': 'Changed their password',
  'user.signature_updated': 'Updated their email signature',
  [FILE_VIEW_ACTION]: 'Opened a client file',
  'customer.create': 'Created a customer',
  'customer.edit': 'Edited a customer',
  'customer.delete': 'Deleted a customer',
  'customer.merge': 'Merged customers',
  'customer.export': 'Exported customers',
  'customer.duplicate_dismiss': 'Marked two customers as different people',
  'application.imported': 'Imported an application',
  'assignment.create': 'Assigned a lead',
  'assignment.round_robin': 'Changed round robin',
  'pipeline.create': 'Created a pipeline',
  'pipeline.update': 'Edited a pipeline',
  'pipeline.delete': 'Deleted a pipeline',
  'pipeline.stage_create': 'Added a stage',
  'pipeline.stage_update': 'Edited a stage',
  'pipeline.stage_delete': 'Deleted a stage',
  'pipeline.stage_reorder': 'Reordered stages',
  'pipeline.file_moved': 'Moved a file to another pipeline',
  'stage.change': 'Moved a file to a stage',
  'stage.changed': 'Moved a file to a stage',
  'document.upload': 'Uploaded a document',
  'document.review': 'Reviewed a document',
  'document.request': 'Requested documents',
  'document.delete': 'Deleted a document',
  'document.download': 'Downloaded a document',
  'required_document.create': 'Added a required document',
  'required_document.update': 'Edited a required document',
  'required_document.delete': 'Removed a required document',
  'required_document.reorder': 'Reordered required documents',
  'required_document.suggested': 'Added suggested documents',
  'message.send': 'Sent a message',
  'template.update': 'Edited a template',
  'consent.unsubscribe': 'Recorded an unsubscribe',
  'application.edit': 'Edited the application',
  'application.revert': 'Restored what the client answered',
  'application.archive': 'Archived a client file',
  'application.restore': 'Restored an archived client file',
  'task.create': 'Created a task',
  'task.update': 'Updated a task',
  'task.complete': 'Completed a task',
  'task.reopen': 'Reopened a task',
  'task.cancel': 'Cancelled a task',
  'task.reassign': 'Moved a task to somebody else',
  'task.reschedule': 'Moved a task to another time',
  'appointment.book': 'Booked an appointment',
  'appointment.rebook': 'Booked an appointment again',
  'appointment.update': 'Edited an appointment',
  'appointment.reschedule': 'Rescheduled an appointment',
  'appointment.cancel': 'Cancelled an appointment',
  'appointment.confirmed': 'Marked an appointment confirmed',
  'appointment.attended': 'Marked an appointment attended',
  'appointment.missed': 'Marked an appointment missed',
  'appointment.google_connected': 'Connected Google Calendar',
  'appointment.google_disconnected': 'Disconnected Google Calendar',
  'appointment.google_sync': 'Applied a change from Google Calendar',
  // Chats record who was let into what, never what anybody said. A staff
  // conversation is not the brokerage's activity feed.
  'chat.group_create': 'Created a chat group',
  'chat.group_rename': 'Renamed a chat group',
  'chat.group_delete': 'Removed a chat group',
  'chat.member_add': 'Added someone to a chat group',
  'chat.member_remove': 'Removed someone from a chat group',
  'chat.member_leave': 'Left a chat group',
  'chat.posting_changed': 'Changed who can post in a chat group',
  'automation.create': 'Created an automation',
  'automation.publish': 'Published an automation',
  'automation.status': 'Paused or resumed an automation',
  'automation.enrol': 'Enrolled a file in an automation',
  'automation.webhook': 'Started a workflow from its webhook',
  'campaign.create': 'Created a campaign',
  'campaign.send': 'Sent a campaign',
  'campaign.pause': 'Paused a campaign',
  'scarlett.push': 'Sent a file to Scarlett',
  'funding.record': 'Recorded funding',
  'funding.confirm': 'Confirmed funding',
  'commission.update': 'Updated commission',
  'settings.update': 'Changed settings',
  'settings.commission_split': 'Changed the commission split',
  'settings.organization': 'Changed brokerage details',
  'settings.retention': 'Changed retention',
  'settings.risk_model': 'Changed the risk model',
  'settings.vocabulary': 'Changed a list',
  'integration.update': 'Changed an integration',
  'api_key.create': 'Created an API key',
  'api_key.revoke': 'Revoked an API key',
  'audit.verify': 'Verified the audit trail',
};

export function actionLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const words = action.split('.').slice(1).join(' ').replace(/_/g, ' ').trim() || action;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The actions a filter can offer: the known ones, grouped by module. */
export const KNOWN_ACTIONS: Array<{ key: string; label: string; module: string }> =
  Object.entries(ACTION_LABELS).map(([key, label]) => ({ key, label, module: moduleOf(key) }));
