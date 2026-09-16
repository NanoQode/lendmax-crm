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
  'pipeline.view': 'View pipelines and their stages',
  'pipeline.move': 'Move files between pipeline stages',
  'pipeline.assign': 'Assign and reassign users to files',
  'pipeline.configure': 'Create, edit, activate and delete pipelines and their stages',

  // Work
  'task.view': 'View tasks',
  'task.manage': 'Create, edit and complete tasks',
  'task.view_all': "See everyone's tasks",
  'task.manage_all': 'Create and manage tasks for any staff member, on any file',
  'note.view': 'View notes',
  'note.create': 'Write notes',
  'note.view_compliance': 'Read compliance-only notes',
  'appointment.view': 'See appointments with their own clients',
  'appointment.manage': 'Book, reschedule and cancel appointments with their own clients',
  'appointment.view_all': "See everyone's appointments",
  'appointment.manage_all': 'Book and manage appointments with any client, for any staff member',

  // Documents
  'document.view': 'View the document list',
  'document.download': 'Open and download documents',
  'document.upload': 'Upload documents',
  'document.request': 'Request documents from a client',
  'document.review': 'Accept or reject documents',
  'document.delete': 'Archive documents',

  // Required documents — the checklist a client is asked for, by purpose
  'required_document.view': 'View the required-documents list',
  'required_document.manage': 'Create, edit, reorder and delete required documents',

  // Communication
  'message.view': 'Read client communication',
  'message.send': 'Send email and SMS to clients',
  'message.send_bulk': 'Send to more than one client at a time',
  'template.manage': 'Create and edit templates',

  // LM Chats — internal staff messaging, nothing to do with clients.
  'chat.use': 'Use LM Chats',
  'chat.admin': 'Run LM Chats: message any staff member, and create and manage groups',

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
  'api_key.manage': 'Create and revoke API keys for connected websites',
  'audit.view': 'Read the audit log',
  'activity.view_all': "View everyone's activity log",
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
  'pipeline.view',
  'pipeline.move', 'pipeline.assign',
  'task.view', 'task.manage', 'note.view', 'note.create',
  'appointment.view', 'appointment.manage',
  'document.view', 'document.download', 'document.upload', 'document.request',
  'required_document.view',
  'message.view', 'message.send',
  'chat.use',
  'automation.view', 'automation.control',
  'campaign.view',
  'compliance.view',
  'report.view',
];

const UNDERWRITER: Permission[] = [
  'customer.view', 'customer.edit', 'customer.view_all',
  'pii.view_financials', 'pii.view_sensitive',
  'pipeline.view',
  'pipeline.move',
  'task.view', 'task.manage', 'note.view', 'note.create',
  'appointment.view', 'appointment.manage',
  'document.view', 'document.download', 'document.upload', 'document.request', 'document.review',
  'required_document.view', 'required_document.manage',
  'message.view', 'message.send',
  'chat.use',
  'automation.view',
  'underwriting.manage', 'scarlett.push',
  'compliance.view', 'compliance.edit',
  'report.view',
];

const MANAGER: Permission[] = [
  'customer.view', 'customer.edit', 'customer.create', 'customer.view_all',
  'customer.merge', 'customer.export',
  'pii.view_financials',
  'pipeline.view',
  'pipeline.move', 'pipeline.assign', 'pipeline.configure',
  'task.view', 'task.manage', 'task.view_all', 'task.manage_all', 'note.view', 'note.create',
  'appointment.view', 'appointment.manage', 'appointment.view_all', 'appointment.manage_all',
  'document.view', 'document.download', 'document.upload', 'document.request', 'document.review',
  'required_document.view', 'required_document.manage',
  'message.view', 'message.send', 'message.send_bulk', 'template.manage',
  'chat.use', 'chat.admin',
  'automation.view', 'automation.edit', 'automation.publish', 'automation.control',
  'campaign.view', 'campaign.edit', 'campaign.send',
  'underwriting.manage', 'scarlett.push',
  'compliance.view',
  'report.view', 'report.view_team', 'report.view_all', 'report.export',
  'activity.view_all',
  'user.view', 'settings.view',
];

const COMPLIANCE_MANAGER: Permission[] = [
  'customer.view', 'customer.view_all',
  'pipeline.view',
  'pii.view_financials', 'pii.view_sensitive',
  'task.view', 'task.manage', 'task.view_all',
  'appointment.view', 'appointment.view_all',
  'note.view', 'note.create', 'note.view_compliance',
  'document.view', 'document.download', 'document.review',
  'required_document.view',
  'message.view',
  'chat.use',
  'automation.view',
  'campaign.view',
  'compliance.view', 'compliance.edit', 'compliance.review', 'compliance.fintrac',
  'compliance.legal_hold', 'compliance.export',
  'report.view', 'report.view_team', 'report.view_all', 'report.export',
  'audit.view', 'activity.view_all',
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
  // Correcting a file and asking the client for what is missing are writes,
  // not reads: neither opens a bank statement. Income, assets and liabilities
  // stay behind `pii.view_financials`, and downloading behind
  // `document.download`, as above.
  'customer.edit', 'customer.create',
  'document.request', 'document.upload',
  // Sending a file to Scarlett is the same kind of write; the preview does
  // not show the deal's financial detail without `pii.view_financials`.
  'scarlett.push',
  // Handing a lead to somebody reads nothing sensitive, and the person who
  // manages staff is the person who rebalances their work.
  'pipeline.view', 'pipeline.configure', 'pipeline.move',
  'pipeline.assign',
  // Admin makes work for anybody, on anybody's file — which is what the
  // read-only "assigned to" field on the task form is showing.
  'task.view', 'task.manage', 'task.view_all', 'task.manage_all', 'note.view',
  // Admin books for anybody, and for anybody's clients.
  'appointment.view', 'appointment.manage', 'appointment.view_all', 'appointment.manage_all',
  'document.view',
  'required_document.view', 'required_document.manage',
  'message.view',
  'chat.use', 'chat.admin',
  'automation.view', 'automation.edit', 'automation.publish', 'automation.control',
  'campaign.view',
  // Funding and what the staff make on it are the admin's alone. No staff
  // role sees the Funding tab or a commission percentage by default; a grant
  // under Staff is the only way anybody else does.
  'funding.view', 'funding.edit',
  'commission.view', 'commission.edit', 'commission.view_all',
  // Reading what has been collected from the client, on the Compliance tab.
  // Completing items and approving stay with compliance.
  'compliance.view',
  'scarlett.manage',
  'template.manage',
  'report.view', 'report.view_all',
  'user.view', 'user.manage', 'user.impersonate',
  'settings.view', 'settings.manage',
  'integration.manage', 'api_key.manage',
  'audit.view', 'activity.view_all',
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
    description: 'Team visibility, assignment, reporting and campaigns.',
    permissions: MANAGER,
  },
  compliance_manager: {
    name: 'Compliance Manager',
    description: 'Compliance review, FINTRAC, suitability, audit and legal hold.',
    permissions: COMPLIANCE_MANAGER,
  },
};

// ── Modules ────────────────────────────────────────────────────────────────

/**
 * Every permission, grouped by the module it belongs to.
 *
 * This is what the staff form renders as checkboxes and what an API key's
 * scopes are chosen from. A NEW MODULE ADDS ITSELF HERE, with its permissions
 * and a short label for each; `test/permissions.test.ts` fails if any
 * permission is left out of every module, so a module cannot ship without
 * appearing in the permission settings.
 *
 * `api` marks the permissions an API key may hold — the ones that have an
 * endpoint under /api/v1. A scope with nothing behind it would be a promise.
 */
export type ModuleSpec = {
  key: string;
  label: string;
  description: string;
  permissions: Array<{ id: Permission; label: string; api?: boolean }>;
};

export const MODULES: ModuleSpec[] = [
  {
    key: 'customers',
    label: 'Customers & leads',
    description: 'Client files, the pipeline board and renewals.',
    permissions: [
      { id: 'customer.view', label: 'View', api: true },
      { id: 'customer.create', label: 'Create', api: true },
      { id: 'customer.edit', label: 'Edit', api: true },
      { id: 'customer.delete', label: 'Archive / delete' },
      { id: 'customer.view_all', label: 'See files not assigned to them' },
      { id: 'customer.merge', label: 'Merge duplicates' },
      { id: 'customer.export', label: 'Export' },
    ],
  },
  {
    key: 'sensitive',
    label: 'Sensitive client data',
    description: 'Granted apart from the file itself: being able to open a file is not being able to read its income.',
    permissions: [
      { id: 'pii.view_financials', label: 'Income, assets & debts' },
      { id: 'pii.view_sensitive', label: 'ID & credit detail' },
    ],
  },
  {
    key: 'pipeline',
    label: 'Pipelines & assignment',
    description: 'The pipelines and their stages, moving files through them, and deciding who works them.',
    permissions: [
      { id: 'pipeline.view', label: 'View pipelines', api: true },
      { id: 'pipeline.move', label: 'Move stages', api: true },
      { id: 'pipeline.assign', label: 'Assign / reassign leads', api: true },
      { id: 'pipeline.configure', label: 'Create, edit & delete pipelines', api: true },
    ],
  },
  {
    key: 'tasks',
    label: 'Tasks & notes',
    description: 'Follow-up work and the notes on a file.',
    permissions: [
      { id: 'task.view', label: 'View tasks', api: true },
      { id: 'task.manage', label: 'Manage tasks', api: true },
      { id: 'task.view_all', label: "See everyone's", api: true },
      { id: 'task.manage_all', label: 'Create & manage for anyone', api: true },
      { id: 'note.view', label: 'View notes' },
      { id: 'note.create', label: 'Write notes' },
      { id: 'note.view_compliance', label: 'Compliance-only notes' },
    ],
  },
  {
    key: 'calendar',
    label: 'Appointments',
    description: 'Meetings with clients, their reminders, and Google Calendar.',
    permissions: [
      { id: 'appointment.view', label: 'See their own' },
      { id: 'appointment.manage', label: 'Book & manage for their clients' },
      { id: 'appointment.view_all', label: "See everyone's", api: true },
      { id: 'appointment.manage_all', label: 'Book & manage for anyone', api: true },
    ],
  },
  {
    key: 'documents',
    label: 'Documents',
    description: 'What clients upload and what the brokerage requests.',
    permissions: [
      { id: 'document.view', label: 'View list' },
      { id: 'document.download', label: 'Open / download' },
      { id: 'document.upload', label: 'Upload' },
      { id: 'document.request', label: 'Request from client' },
      { id: 'document.review', label: 'Accept / reject' },
      { id: 'document.delete', label: 'Archive' },
    ],
  },
  {
    key: 'required_documents',
    label: 'Required documents',
    description: 'The checklist of documents a client is asked for, for each application purpose.',
    permissions: [
      { id: 'required_document.view', label: 'View', api: true },
      { id: 'required_document.manage', label: 'Create, edit & delete', api: true },
    ],
  },
  {
    key: 'messages',
    label: 'Messages & templates',
    description: 'Email and SMS with clients.',
    permissions: [
      { id: 'message.view', label: 'Read' },
      { id: 'message.send', label: 'Send' },
      { id: 'message.send_bulk', label: 'Send to many' },
      { id: 'template.manage', label: 'Manage templates' },
    ],
  },
  {
    key: 'chats',
    label: 'LM Chats',
    description: 'Internal staff messaging. Staff talk to an admin; groups are made by an admin.',
    // No `api: true` anywhere, deliberately. A connected website has no
    // business reading what staff say to each other, so there is no /api/v1
    // endpoint behind either of these and therefore no scope to grant.
    permissions: [
      { id: 'chat.use', label: 'Use chats' },
      { id: 'chat.admin', label: 'Chat admin (message anyone, manage groups)' },
    ],
  },
  {
    key: 'automations',
    label: 'Automations',
    description: 'LM Automation: workflows that run on their own.',
    permissions: [
      { id: 'automation.view', label: 'View', api: true },
      { id: 'automation.edit', label: 'Create & edit' },
      { id: 'automation.publish', label: 'Publish' },
      { id: 'automation.control', label: 'Add clients, pause / resume', api: true },
    ],
  },
  {
    key: 'campaigns',
    label: 'Campaigns',
    description: 'Marketing sends to many clients.',
    permissions: [
      { id: 'campaign.view', label: 'View' },
      { id: 'campaign.edit', label: 'Create & edit' },
      { id: 'campaign.send', label: 'Send' },
    ],
  },
  {
    key: 'underwriting',
    label: 'Underwriting & Scarlett',
    description: 'Lender submissions and conditions.',
    permissions: [
      { id: 'underwriting.manage', label: 'Manage submissions' },
      { id: 'scarlett.push', label: 'Push to Scarlett' },
      { id: 'scarlett.manage', label: 'Repair Scarlett sync' },
    ],
  },
  {
    key: 'funding',
    label: 'Funding & commission',
    description: 'Closed deals and what they paid.',
    permissions: [
      { id: 'funding.view', label: 'View funding' },
      { id: 'funding.edit', label: 'Edit funding' },
      { id: 'commission.view', label: 'View own commission' },
      { id: 'commission.edit', label: 'Edit commission' },
      { id: 'commission.view_all', label: "Everyone's commission" },
    ],
  },
  {
    key: 'compliance',
    label: 'Compliance',
    description: 'Compliance files, FINTRAC and legal holds.',
    permissions: [
      { id: 'compliance.view', label: 'View' },
      { id: 'compliance.edit', label: 'Complete items' },
      { id: 'compliance.review', label: 'Approve / reject' },
      { id: 'compliance.fintrac', label: 'FINTRAC' },
      { id: 'compliance.legal_hold', label: 'Legal hold' },
      { id: 'compliance.export', label: 'Export package' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    description: 'Numbers on their own work, their team, or the brokerage.',
    permissions: [
      { id: 'report.view', label: 'Own work' },
      { id: 'report.view_team', label: 'Team' },
      { id: 'report.view_all', label: 'Whole brokerage' },
      { id: 'report.export', label: 'Export' },
    ],
  },
  {
    key: 'staff',
    label: 'Staff',
    description: 'Staff accounts, their permissions and round robin.',
    permissions: [
      { id: 'user.view', label: 'View staff', api: true },
      { id: 'user.manage', label: 'Add, edit, deactivate & delete', api: true },
      { id: 'user.impersonate', label: 'Sign in as another user' },
    ],
  },
  {
    key: 'settings',
    label: 'Settings & integrations',
    description: 'How the brokerage is configured, and the services it connects to.',
    permissions: [
      { id: 'settings.view', label: 'View settings' },
      { id: 'settings.manage', label: 'Change settings' },
      { id: 'integration.manage', label: 'Integrations & credentials' },
      { id: 'api_key.manage', label: 'API keys' },
    ],
  },
  {
    key: 'activity',
    label: 'Activity logs',
    description: 'What each person did in the last 30 days. Everybody sees their own.',
    permissions: [
      { id: 'activity.view_all', label: "See everyone's activity", api: true },
    ],
  },
  {
    key: 'system',
    label: 'Audit & system',
    description: 'The audit log and diagnostics.',
    permissions: [
      { id: 'audit.view', label: 'Read audit log' },
      { id: 'system.admin', label: 'System administration' },
    ],
  },
];

/** The permissions an API key may be given. */
export const API_PERMISSIONS: Permission[] = MODULES
  .flatMap((m) => m.permissions.filter((p) => p.api).map((p) => p.id));

/**
 * Store a person's permissions as their role plus the differences.
 *
 * The form sends the full set of ticked boxes; what is stored is only what
 * differs from the role, so a later change to a role's defaults still reaches
 * everybody who was not deliberately set apart from it.
 */
export function overridesFor(role: Role, effective: Iterable<string>): Record<string, boolean> {
  const wanted = new Set([...effective].filter((p) => PERMISSION_IDS.includes(p as Permission)));
  const base = new Set<string>(ROLES[role]?.permissions ?? []);
  const overrides: Record<string, boolean> = {};
  for (const id of PERMISSION_IDS) {
    if (wanted.has(id) && !base.has(id)) overrides[id] = true;
    if (!wanted.has(id) && base.has(id)) overrides[id] = false;
  }
  return overrides;
}

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
  return `Your account (${role}) cannot ${what[0]!.toLowerCase()}${what.slice(1)}. A technical admin can grant this under Staff.`;
}
