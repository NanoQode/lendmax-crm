/**
 * Role-based access control.
 *
 * Three rules this module exists to enforce:
 *
 *   1. PERMISSIONS ARE CHECKED ON THE SERVER, EVERY TIME. The UI hides what
 *      you cannot do as a courtesy. A hidden button is not a permission.
 *   2. THE ROLE IS THE ANSWER, the override is the exception. One person
 *      needing one extra capability must not produce a sixth role.
 *   3. SENSITIVE DATA IS A SEPARATE GRANT from the record that contains it.
 *      Being able to open a file is not being able to read its credit report.
 *      A technical admin can run this system without reading anybody's income.
 */

export const PERMISSIONS = {
  // Customers and applications
  'customer.view': 'View customers and applications',
  'customer.edit': 'Edit customer and application details',
  'customer.create': 'Create customers',
  'customer.delete': 'Archive or delete customers',
  'customer.merge': 'Merge duplicate customer records',
  'customer.export': 'Export customer data',
  'customer.view_all': 'View files they are not assigned to',

  // Sensitive fields, granted apart from the record itself.
  'pii.view_sensitive': 'Reveal masked identification and credit detail',
  'pii.view_financials': 'View income, assets and liabilities',

  // Pipeline
  'pipeline.move': 'Move files between pipeline stages',
  'pipeline.assign': 'Assign and reassign users to files',
  'pipeline.configure': 'Configure stages, statuses and dispositions',

  // Work
  'task.view': 'View tasks',
  'task.manage': 'Create, edit and complete tasks',
  'note.view': 'View notes',
  'note.create': 'Write notes',
  'note.view_compliance': 'Read compliance-only notes',
  'appointment.manage': 'Book, reschedule and cancel appointments',

  // Documents
  'document.view': 'View the document list',
  'document.download': 'Open and download documents',
  'document.upload': 'Upload documents',
  'document.request': 'Request documents from a client',
  'document.review': 'Accept or reject documents',
  'document.delete': 'Archive documents',

  // Communication
  'message.view': 'Read client communication',
  'message.send': 'Send email and SMS to clients',
  'message.send_bulk': 'Send to more than one client at a time',
  'template.manage': 'Create and edit templates',

  // Automation
  'automation.view': 'View automations and enrollments',
  'automation.edit': 'Create and edit automations',
  'automation.publish': 'Publish an automation so it runs',
  'automation.control': 'Pause, resume or end an enrollment',

  // Campaigns
  'campaign.view': 'View campaigns',
  'campaign.edit': 'Create and edit campaigns',
  'campaign.send': 'Send or schedule a campaign',

  // Underwriting and lenders
  'underwriting.manage': 'Manage lender submissions and conditions',
  'scarlett.push': 'Push a deal to Scarlett',
  'scarlett.manage': 'Retry and repair Scarlett synchronisation',

  // Funding and money
  'funding.view': 'View funding details',
  'funding.edit': 'Record and amend funding details',
  'commission.view': 'View commission records',
  'commission.edit': 'Record and reconcile commission',
  'commission.view_all': 'View commission for the whole brokerage',

  // Compliance
  'compliance.view': 'View compliance records',
  'compliance.edit': 'Complete compliance items',
  'compliance.review': 'Approve or reject a compliance file',
  'compliance.fintrac': 'Work FINTRAC assessments and escalations',
  'compliance.legal_hold': 'Place and lift a legal hold',
  'compliance.export': 'Export a compliance package',

  // Reporting
  'report.view': 'View reports for their own work',
  'report.view_team': 'View reports across the team',
  'report.view_all': 'View reports across the brokerage',
  'report.export': 'Export reports',

  // Administration
  'user.view': 'View staff accounts',
  'user.manage': 'Create and edit staff accounts',
  'user.impersonate': 'Sign in as another user',
  'settings.view': 'View settings',
  'settings.manage': 'Change settings',
  'integration.manage': 'Configure integrations and credentials',
  'audit.view': 'Read the audit log',
  'system.admin': 'System administration and diagnostics',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_IDS = Object.keys(PERMISSIONS) as Permission[];

export type Role =
  | 'technical_admin'
  | 'broker'
  | 'underwriter'
  | 'manager'
  | 'compliance_manager';

export const ROLE_IDS: Role[] = [
  'technical_admin', 'broker', 'underwriter', 'manager', 'compliance_manager',
];

const BROKER: Permission[] = [
  'customer.view', 'customer.edit', 'customer.create',
  'pii.view_financials',
  'pipeline.move', 'pipeline.assign',
  'task.view', 'task.manage', 'note.view', 'note.create',
  'appointment.manage',
  'document.view', 'document.download', 'document.upload', 'document.request',
  'message.view', 'message.send',
  'automation.view', 'automation.control',
  'campaign.view',
  'funding.view',
  'commission.view',
  'compliance.view',
  'report.view',
];

const UNDERWRITER: Permission[] = [
  'customer.view', 'customer.edit', 'customer.view_all',
  'pii.view_financials', 'pii.view_sensitive',
  'pipeline.move',
  'task.view', 'task.manage', 'note.view', 'note.create',
  'appointment.manage',
  'document.view', 'document.download', 'document.upload', 'document.request', 'document.review',
  'message.view', 'message.send',
  'automation.view',
  'underwriting.manage', 'scarlett.push',
  'funding.view', 'funding.edit',
  'compliance.view', 'compliance.edit',
  'report.view',
];

const MANAGER: Permission[] = [
  'customer.view', 'customer.edit', 'customer.create', 'customer.view_all',
  'customer.merge', 'customer.export',
  'pii.view_financials',
  'pipeline.move', 'pipeline.assign', 'pipeline.configure',
  'task.view', 'task.manage', 'note.view', 'note.create',
  'appointment.manage',
  'document.view', 'document.download', 'document.upload', 'document.request', 'document.review',
  'message.view', 'message.send', 'message.send_bulk', 'template.manage',
  'automation.view', 'automation.edit', 'automation.publish', 'automation.control',
  'campaign.view', 'campaign.edit', 'campaign.send',
  'underwriting.manage', 'scarlett.push',
  'funding.view', 'funding.edit',
  'commission.view', 'commission.edit', 'commission.view_all',
  'compliance.view',
  'report.view', 'report.view_team', 'report.view_all', 'report.export',
  'user.view', 'settings.view',
];

const COMPLIANCE_MANAGER: Permission[] = [
  'customer.view', 'customer.view_all',
  'pii.view_financials', 'pii.view_sensitive',
  'task.view', 'task.manage',
  'note.view', 'note.create', 'note.view_compliance',
  'document.view', 'document.download', 'document.review',
  'message.view',
  'automation.view',
  'campaign.view',
  'funding.view',
  'commission.view', 'commission.view_all',
  'compliance.view', 'compliance.edit', 'compliance.review', 'compliance.fintrac',
  'compliance.legal_hold', 'compliance.export',
  'report.view', 'report.view_team', 'report.view_all', 'report.export',
  'audit.view',
  'user.view', 'settings.view',
];

/**
 * The technical admin runs the system; they do not read the client's bank
 * statements to do it. `pii.view_sensitive`, `pii.view_financials` and
 * `document.download` are deliberately absent — least privilege applies to the
 * person with the most access, or it is not a principle. An override grants
 * them where a genuine support need exists, and that grant is auditable.
 */
const TECHNICAL_ADMIN: Permission[] = [
  'customer.view', 'customer.view_all',
  'task.view', 'note.view',
  'document.view',
  'message.view',
  'automation.view', 'automation.edit', 'automation.publish', 'automation.control',
  'campaign.view',
  'scarlett.manage',
  'template.manage',
  'report.view', 'report.view_all',
  'user.view', 'user.manage', 'user.impersonate',
  'settings.view', 'settings.manage',
  'integration.manage',
  'audit.view',
  'system.admin',
];

export const ROLES: Record<Role, { name: string; description: string; permissions: Permission[] }> = {
  technical_admin: {
    name: 'Technical Admin',
    description:
      'Runs the system: users, integrations, automations, diagnostics. Deliberately not ' +
      'granted document download or sensitive financial detail — those are separate grants.',
    permissions: TECHNICAL_ADMIN,
  },
  broker: {
    name: 'Broker',
    description: 'Owns client relationships: leads, appointments, follow-up, their own pipeline.',
    permissions: BROKER,
  },
  underwriter: {
    name: 'Underwriter',
    description: 'Works the application: documents, conditions, lender submission, Scarlett.',
    permissions: UNDERWRITER,
  },
  manager: {
    name: 'Manager',
    description: 'Team visibility, assignment, reporting, campaigns and commission.',
    permissions: MANAGER,
  },
  compliance_manager: {
    name: 'Compliance Manager',
    description: 'Compliance review, FINTRAC, suitability, audit and legal hold.',
    permissions: COMPLIANCE_MANAGER,
  },
};

export type PermissionSubject = {
  role: Role;
  permission_overrides?: Record<string, boolean> | null;
  active?: boolean;
};

/** The effective permission set: the role, then the overrides on top. */
export function permissionsFor(user: PermissionSubject): Set<Permission> {
  if (user.active === false) return new Set();
  const set = new Set<Permission>(ROLES[user.role]?.permissions ?? []);
  for (const [id, granted] of Object.entries(user.permission_overrides ?? {})) {
    if (!PERMISSION_IDS.includes(id as Permission)) continue; // unknown ids are ignored, not trusted
    if (granted) set.add(id as Permission);
    else set.delete(id as Permission);
  }
  return set;
}

export function can(user: PermissionSubject, permission: Permission): boolean {
  return permissionsFor(user).has(permission);
}

export function canAll(user: PermissionSubject, permissions: Permission[]): boolean {
  const set = permissionsFor(user);
  return permissions.every((p) => set.has(p));
}

export function canAny(user: PermissionSubject, permissions: Permission[]): boolean {
  const set = permissionsFor(user);
  return permissions.some((p) => set.has(p));
}

/**
 * The message a refusal carries. It names the role and the capability, because
 * "Not authorised" sends somebody to the wrong person for the wrong fix.
 */
export function denialMessage(user: PermissionSubject, permission: Permission): string {
  const role = ROLES[user.role]?.name ?? user.role;
  const what = PERMISSIONS[permission] ?? permission;
  return `Your account (${role}) cannot ${what[0]!.toLowerCase()}${what.slice(1)}. A technical admin can grant this under Settings → Users.`;
}
