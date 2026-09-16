/**
 * The public API, version 1 — what connected websites call.
 *
 *   Authorization: Bearer lmx_…      (or  X-API-Key: lmx_…)
 *
 * Every response is `{ ok: true, data }` or `{ ok: false, code, error, fields? }`.
 * Each endpoint names the permission it needs; a key without it gets a 403
 * that says which one, so whoever is wiring up the website knows what to ask
 * for. The routes are thin: the rules live in the services, the same ones the
 * admin panel uses, so the API cannot do anything the screens would refuse.
 *
 * Versioned in the path because a website someone else maintains cannot be
 * redeployed in step with this one. A breaking change is /api/v2, with v1 kept
 * working until nothing calls it.
 *
 * Documented in docs/API.md. A new module adds its endpoints here, its
 * permissions to MODULES with `api: true`, and its section to that document.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { queryOne } from '../../db/pool.ts';
import { API_PERMISSIONS, MODULES, PERMISSIONS, type Permission } from '../../domain/permissions.ts';
import { authenticateApiKey, type AuthenticatedKey } from '../../services/api-keys.ts';
import { assignLead, createLead } from '../../services/leads.ts';
import { enrol, publishedAutomation } from '../../services/automation-engine.ts';
import { emitEvent } from '../../services/events.ts';
import { recordAudit } from '../../services/audit.ts';
import { toE164 } from '../../lib/phone.ts';
import { randomUUID } from 'node:crypto';
import {
  findDuplicates, loadCustomer, searchCustomers, updateCustomer, type CustomerScope,
} from '../../services/customers.ts';
import {
  assignableStaff, assignmentSettings, createStaff, deactivateStaff, deleteStaff, getStaff,
  listStaff, reactivateStaff, resendInvitation, updateAssignmentSettings, updateStaff,
  type Actor,
} from '../../services/staff.ts';
import { getSignature, saveSignature } from '../../services/signature.ts';
import {
  addSuggested, checklistFor, createRequiredDocument, deleteRequiredDocument, getRequiredDocument,
  listRequiredDocuments, moveRequiredDocument, requiredDocumentsMeta, updateRequiredDocument,
} from '../../services/required-documents.ts';
import {
  createPipeline, createStage, deletePipeline, deleteStage, entryStage, getPipeline, moveStage, pipelineCatalogue,
  pipelineUsage, stageUsage, updatePipeline, updateStage,
} from '../../services/pipelines.ts';
import { moveFileToStage } from '../../services/stage-moves.ts';
import { activityOptions, listActivity, recordFileView } from '../../services/activity.ts';
import {
  appointmentMeta, availability, bookableFiles, bookableHosts, bookAppointment, cancelAppointment,
  confirmAppointment, getAppointment, listAppointments, recordOutcome, updateAppointment,
  type Scope as AppointmentScope,
} from '../../services/appointments.ts';
import {
  assignableFiles, createTask, getTask, listTasks, taskMeta, updateTask,
  type Scope as TaskScope,
} from '../../services/tasks.ts';
import { pool } from '../../db/pool.ts';
import { AppError, asyncRoute, fieldError, notFound } from '../middleware/errors.ts';

export const apiV1Routes: Router = Router();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: AuthenticatedKey;
    }
  }
}

function presentedKey(req: Request): string | undefined {
  const auth = req.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.get('x-api-key')?.trim() || undefined;
}

apiV1Routes.use(asyncRoute(async (req, res, next) => {
  const key = await authenticateApiKey(presentedKey(req), req.ip);
  if (!key) {
    res.status(401).json({
      ok: false, code: 'unauthenticated',
      error: 'Send a valid API key as "Authorization: Bearer lmx_…". Keys are created in the CRM under API access.',
    });
    return;
  }
  req.apiKey = key;
  next();
}));

// Per key, so one busy website cannot use up another's allowance.
apiV1Routes.use(rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.apiKey?.id ?? 'anonymous',
  message: { ok: false, code: 'rate_limited', error: 'More than 300 requests a minute from this key. Slow down.' },
}));

function requireScope(...anyOf: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (anyOf.some((p) => req.apiKey!.permissions.has(p))) {
      next();
      return;
    }
    res.status(403).json({
      ok: false, code: 'forbidden', permission: anyOf[0],
      error: `This API key needs the "${anyOf[0]}" permission (${PERMISSIONS[anyOf[0]!]}). ` +
             'An admin can add it under API access.',
    });
  };
}

const actor = (req: Request): Actor => ({
  organizationId: req.apiKey!.organizationId,
  kind: 'integration',
  userId: null,
  name: `API: ${req.apiKey!.name}`,
  ip: req.ip ?? null,
});

const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ ok: true, data });

// ── Discovery ──────────────────────────────────────────────────────────────

apiV1Routes.get('/', (req, res) => {
  ok(res, {
    version: 'v1',
    key: { name: req.apiKey!.name, permissions: [...req.apiKey!.permissions].sort() },
    documentation: 'docs/API.md in the CRM repository',
  });
});

/** Every module and its permissions, for a website building its own staff screen. */
apiV1Routes.get('/permissions', (_req, res) => {
  ok(res, {
    modules: MODULES.map((m) => ({
      key: m.key, label: m.label, description: m.description,
      permissions: m.permissions.map((p) => ({
        id: p.id, label: p.label, description: PERMISSIONS[p.id], api: API_PERMISSIONS.includes(p.id),
      })),
    })),
  });
});

// ── Staff ──────────────────────────────────────────────────────────────────

const StaffQuery = z.object({
  status: z.enum(['all', 'active', 'invited', 'inactive', 'deleted']).default('all'),
  q: z.string().max(100).optional(),
  role: z.string().max(40).optional(),
});

apiV1Routes.get('/staff', requireScope('user.view'), asyncRoute(async (req, res) => {
  ok(res, await listStaff(req.apiKey!.organizationId, StaffQuery.parse(req.query)));
}));

apiV1Routes.get('/staff/assignable', requireScope('pipeline.assign', 'user.view'), asyncRoute(async (req, res) => {
  ok(res, await assignableStaff(req.apiKey!.organizationId));
}));

apiV1Routes.get('/staff/:id', requireScope('user.view'), asyncRoute(async (req, res) => {
  ok(res, await getStaff(req.apiKey!.organizationId, String(req.params.id)));
}));

apiV1Routes.post('/staff', requireScope('user.manage'), asyncRoute(async (req, res) => {
  ok(res, await createStaff(actor(req), req.body), 201);
}));

apiV1Routes.patch('/staff/:id', requireScope('user.manage'), asyncRoute(async (req, res) => {
  ok(res, await updateStaff(actor(req), String(req.params.id), req.body));
}));

apiV1Routes.post('/staff/:id/deactivate', requireScope('user.manage'), asyncRoute(async (req, res) => {
  ok(res, await deactivateStaff(actor(req), String(req.params.id), req.body));
}));

apiV1Routes.post('/staff/:id/reactivate', requireScope('user.manage'), asyncRoute(async (req, res) => {
  ok(res, await reactivateStaff(actor(req), String(req.params.id)));
}));

apiV1Routes.post('/staff/:id/resend-invite', requireScope('user.manage'), asyncRoute(async (req, res) => {
  ok(res, await resendInvitation(actor(req), String(req.params.id)));
}));

apiV1Routes.delete('/staff/:id', requireScope('user.manage'), asyncRoute(async (req, res) => {
  ok(res, await deleteStaff(actor(req), String(req.params.id), req.body));
}));

apiV1Routes.get('/staff/:id/signature', requireScope('user.view'), asyncRoute(async (req, res) => {
  ok(res, await getSignature(req.apiKey!.organizationId, String(req.params.id)));
}));

apiV1Routes.put('/staff/:id/signature', requireScope('user.manage'), asyncRoute(async (req, res) => {
  ok(res, await saveSignature(actor(req), String(req.params.id), req.body));
}));

// ── Round robin ────────────────────────────────────────────────────────────

apiV1Routes.get('/assignment', requireScope('user.view'), asyncRoute(async (req, res) => {
  ok(res, await assignmentSettings(req.apiKey!.organizationId));
}));

apiV1Routes.put('/assignment', requireScope('user.manage'), asyncRoute(async (req, res) => {
  ok(res, await updateAssignmentSettings(actor(req), req.body));
}));

// ── Leads ──────────────────────────────────────────────────────────────────

apiV1Routes.post('/leads', requireScope('customer.create'), asyncRoute(async (req, res) => {
  ok(res, await createLead(actor(req), req.body, {
    defaultAssign: 'auto',
    mayAssignOthers: req.apiKey!.permissions.has('pipeline.assign'),
    source: `api:${req.apiKey!.name}`,
  }), 201);
}));

apiV1Routes.get('/leads/:id', requireScope('customer.view'), asyncRoute(async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw notFound('That lead');
  const lead = await queryOne(
    `SELECT a.id, a.customer_id, c.first_name, c.last_name, c.email, c.phone_e164 AS phone,
            a.stage_key, s.label AS stage_label, a.pipeline_id,
            (SELECT name FROM pipelines WHERE id = a.pipeline_id) AS pipeline_name,
            a.purpose, a.amount_requested, a.transaction_type_key,
            a.created_at, a.last_activity_at,
            (SELECT json_build_object('id', u.id, 'name', u.name)
               FROM assignments x JOIN users u ON u.id = x.user_id
              WHERE x.application_id = a.id AND x.role = 'broker' AND x.is_primary
                AND x.unassigned_at IS NULL LIMIT 1) AS assigned_to
       FROM applications a
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN pipeline_stages s ON s.organization_id = a.organization_id AND s.key = a.stage_key
      WHERE a.id = $1 AND a.organization_id = $2 AND a.archived_at IS NULL`,
    [id.data, req.apiKey!.organizationId]);
  if (!lead) throw notFound('That lead');
  void recordFileView(actor(req), id.data);
  ok(res, lead);
}));

apiV1Routes.post('/leads/:id/assign', requireScope('pipeline.assign'), asyncRoute(async (req, res) => {
  ok(res, await assignLead(actor(req), String(req.params.id), req.body));
}));

// ── Customers ──────────────────────────────────────────────────────────────
// A website that already knows somebody (a returning visitor, a signed-in
// client) looks them up before creating a second lead, and keeps their
// contact details current. A key acts for the brokerage, so it is not
// limited to one broker's files.

const customerScope = (req: Request): CustomerScope => ({ actor: actor(req), viewAll: true });

apiV1Routes.get('/customers', requireScope('customer.view'), asyncRoute(async (req, res) => {
  const q = z.object({
    q: z.string().max(100).optional(), email: z.string().max(200).optional(),
    phone: z.string().max(40).optional(),
  }).parse(req.query);
  const text = q.email ?? q.phone ?? q.q ?? '';
  if (text.trim().length < 2) throw fieldError('q', 'Give at least two characters of a name, email or phone.');
  ok(res, await searchCustomers(customerScope(req), text));
}));

apiV1Routes.get('/customers/:id', requireScope('customer.view'), asyncRoute(async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw notFound('That customer');
  const scope = customerScope(req);
  const customer = await loadCustomer(scope, id.data);
  const { rows: files } = await pool.query(
    `SELECT a.id, a.portal_reference, a.stage_key, s.label AS stage_label, a.transaction_type_key,
            a.amount_requested, a.created_at
       FROM applications a
       LEFT JOIN pipeline_stages s ON s.organization_id = a.organization_id AND s.key = a.stage_key
      WHERE a.customer_id = $1 AND a.archived_at IS NULL ORDER BY a.created_at DESC`,
    [id.data]);
  ok(res, { ...customer, files, possible_duplicates: await findDuplicates(scope, id.data) });
}));

apiV1Routes.patch('/customers/:id', requireScope('customer.edit'), asyncRoute(async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw notFound('That customer');
  ok(res, await updateCustomer(customerScope(req), id.data, req.body));
}));

// ── LM Automation ──────────────────────────────────────────────────────────
// A website can see which workflows exist, put a client into one that starts
// "manually", and fire a workflow's inbound webhook trigger. What a workflow
// then does runs through the same engine, gates and logs as everything else.

apiV1Routes.get('/automations', requireScope('automation.view'), asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.description, a.status, a.published_version,
            (SELECT COALESCE((SELECT array_agg(t->>'type') FROM jsonb_array_elements(v.definition->'triggers') t),
                             ARRAY[v.definition->'trigger'->>'type'])
               FROM automation_versions v WHERE v.automation_id = a.id AND v.version = a.published_version)
              AS triggers
       FROM automations a WHERE a.organization_id = $1 AND a.status <> 'archived' ORDER BY a.name`,
    [req.apiKey!.organizationId]);
  ok(res, rows);
}));

/** The client an inbound call names: by id, by email or by phone. */
async function findClient(organizationId: string, body: { customer_id?: string; application_id?: string; email?: string; phone?: string }) {
  if (body.application_id) {
    return queryOne<{ customer_id: string; application_id: string | null }>(
      `SELECT customer_id, id AS application_id FROM applications WHERE id = $1 AND organization_id = $2`,
      [body.application_id, organizationId]);
  }
  const phone = body.phone ? toE164(body.phone) : null;
  return queryOne<{ customer_id: string; application_id: string | null }>(
    `SELECT c.id AS customer_id, NULL::uuid AS application_id FROM customers c
      WHERE c.organization_id = $1 AND c.merged_into_id IS NULL
        AND (($2::uuid IS NOT NULL AND c.id = $2::uuid)
          OR ($3::text IS NOT NULL AND lower(c.email) = lower($3))
          OR ($4::text IS NOT NULL AND c.phone_e164 = $4))
      ORDER BY c.updated_at DESC LIMIT 1`,
    [organizationId, body.customer_id ?? null, body.email ?? null, phone]);
}

const ClientRef = z.object({
  customer_id: z.string().uuid().optional(),
  application_id: z.string().uuid().optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  data: z.record(z.unknown()).optional(),
}).refine((b) => b.customer_id || b.application_id || b.email || b.phone,
  'Say who: customer_id, application_id, email or phone.');

/**
 * Fire a workflow's "Inbound webhook" trigger. The event is recorded against
 * this workflow only; its filters can test anything sent in `data` as
 * `event.<key>`.
 */
apiV1Routes.post('/automations/:id/webhook', requireScope('automation.control'), asyncRoute(async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw notFound('That workflow');
  const body = ClientRef.parse(req.body ?? {});
  const organizationId = req.apiKey!.organizationId;
  const automation = await queryOne<{ id: string; name: string; status: string; listens: boolean }>(
    `SELECT a.id, a.name, a.status,
            EXISTS (SELECT 1 FROM automation_versions v, jsonb_array_elements(COALESCE(v.definition->'triggers', jsonb_build_array(v.definition->'trigger'))) t
                     WHERE v.automation_id = a.id AND v.version = a.published_version
                       AND t->>'type' = 'webhook.received') AS listens
       FROM automations a WHERE a.id = $1 AND a.organization_id = $2`, [id.data, organizationId]);
  if (!automation) throw notFound('That workflow');
  if (automation.status !== 'active' || !automation.listens) {
    throw new AppError('That workflow is not published with an Inbound webhook trigger.', 409, 'not_listening');
  }
  const client = await findClient(organizationId, body);
  if (!client) throw notFound('A client with those details');
  const flat = Object.fromEntries(Object.entries(body.data ?? {})
    .filter(([, v]) => v === null || typeof v !== 'object').slice(0, 50));
  const received = randomUUID();
  await emitEvent({
    organizationId, type: 'webhook.received', customerId: client.customer_id, applicationId: client.application_id,
    payload: { ...flat, automation_id: automation.id, source: req.apiKey!.name },
    dedupeKey: `webhook.received:${automation.id}:${received}`,
  });
  await recordAudit({
    organizationId, actor: { kind: 'integration', name: `API: ${req.apiKey!.name}`, ip: req.ip ?? null },
    action: 'automation.webhook', entityType: 'automation', entityId: automation.id,
    applicationId: client.application_id,
    summary: `Inbound webhook for "${automation.name}" from ${req.apiKey!.name}`,
  });
  ok(res, { received, customer_id: client.customer_id, note: 'The workflow picks this up within a minute.' }, 202);
}));

/** Put a client into a published workflow directly, whatever its triggers. */
apiV1Routes.post('/automations/:id/enrol', requireScope('automation.control'), asyncRoute(async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw notFound('That workflow');
  const body = ClientRef.parse(req.body ?? {});
  const organizationId = req.apiKey!.organizationId;
  const automation = await publishedAutomation(organizationId, id.data);
  if (!automation) throw notFound('A published, running version of that workflow');
  const client = await findClient(organizationId, body);
  if (!client) throw notFound('A client with those details');
  const enrollmentId = await enrol(automation, organizationId, client.customer_id, client.application_id,
    `Added through the API by ${req.apiKey!.name}`);
  if (!enrollmentId) throw new AppError('That client is already in this workflow, or cannot re-enter it.', 409, 'already_enrolled');
  await recordAudit({
    organizationId, actor: { kind: 'integration', name: `API: ${req.apiKey!.name}`, ip: req.ip ?? null },
    action: 'automation.enrol', entityType: 'automation_enrollment', entityId: enrollmentId,
    applicationId: client.application_id,
    summary: `Added a client to "${automation.name}" through the API`,
  });
  ok(res, { enrollment_id: enrollmentId }, 201);
}));

// ── Required documents ─────────────────────────────────────────────────────
// The application portal reads the checklist for a purpose from here.

// ── Tasks ──────────────────────────────────────────────────────────────────
//
// A website that books a callback can leave the task on the broker's list
// instead of an email nobody actions. The key's own permissions decide whose
// work it may see and make, exactly as a person's do.

const taskScope = (req: Request): TaskScope => ({
  actor: actor(req),
  viewAll: req.apiKey!.permissions.has('task.view_all'),
  // A key is not a person, so it never has a personal task list to manage.
  // Anything it does, it does for the brokerage — which is `manage_all`.
  manage: false,
  manageAll: req.apiKey!.permissions.has('task.manage_all'),
});
const readTasks = requireScope('task.view_all', 'task.manage_all');
const writeTasks = requireScope('task.manage_all');

apiV1Routes.get('/tasks/meta', readTasks, asyncRoute(async (req, res) => {
  ok(res, await taskMeta(taskScope(req)));
}));

apiV1Routes.get('/tasks/files', writeTasks, asyncRoute(async (req, res) => {
  ok(res, { files: await assignableFiles(taskScope(req), req.query) });
}));

apiV1Routes.get('/tasks', readTasks, asyncRoute(async (req, res) => {
  ok(res, await listTasks(taskScope(req), req.query));
}));

apiV1Routes.post('/tasks', writeTasks, asyncRoute(async (req, res) => {
  res.status(201).json({ ok: true, task: await createTask(taskScope(req), req.body) });
}));

apiV1Routes.get('/tasks/:id', readTasks, asyncRoute(async (req, res) => {
  ok(res, { task: await getTask(taskScope(req), String(req.params.id)) });
}));

apiV1Routes.patch('/tasks/:id', writeTasks, asyncRoute(async (req, res) => {
  ok(res, { task: await updateTask(taskScope(req), String(req.params.id), req.body) });
}));

apiV1Routes.get('/required-documents/meta', requireScope('required_document.view'), asyncRoute(async (req, res) => {
  ok(res, await requiredDocumentsMeta(req.apiKey!.organizationId));
}));

apiV1Routes.get('/required-documents', requireScope('required_document.view'), asyncRoute(async (req, res) => {
  ok(res, await listRequiredDocuments(req.apiKey!.organizationId, req.query));
}));

apiV1Routes.get('/required-documents/checklist', requireScope('required_document.view'), asyncRoute(async (req, res) => {
  const { purpose } = z.object({ purpose: z.string().max(40) }).parse(req.query);
  ok(res, await checklistFor(req.apiKey!.organizationId, purpose));
}));

apiV1Routes.post('/required-documents/suggested', requireScope('required_document.manage'), asyncRoute(async (req, res) => {
  ok(res, await addSuggested(actor(req), req.body));
}));

apiV1Routes.get('/required-documents/:id', requireScope('required_document.view'), asyncRoute(async (req, res) => {
  ok(res, await getRequiredDocument(req.apiKey!.organizationId, String(req.params.id)));
}));

apiV1Routes.post('/required-documents', requireScope('required_document.manage'), asyncRoute(async (req, res) => {
  ok(res, await createRequiredDocument(actor(req), req.body), 201);
}));

apiV1Routes.patch('/required-documents/:id', requireScope('required_document.manage'), asyncRoute(async (req, res) => {
  ok(res, await updateRequiredDocument(actor(req), String(req.params.id), req.body));
}));

apiV1Routes.post('/required-documents/:id/move', requireScope('required_document.manage'), asyncRoute(async (req, res) => {
  await moveRequiredDocument(actor(req), String(req.params.id), req.body);
  ok(res, { moved: true });
}));

apiV1Routes.delete('/required-documents/:id', requireScope('required_document.manage'), asyncRoute(async (req, res) => {
  await deleteRequiredDocument(actor(req), String(req.params.id));
  ok(res, { deleted: true });
}));

// ── Pipelines ──────────────────────────────────────────────────────────────

apiV1Routes.get('/pipelines', requireScope('pipeline.view'), asyncRoute(async (req, res) => {
  ok(res, await pipelineCatalogue(pool, req.apiKey!.organizationId));
}));

/** Which pipeline and first stage a new application with this purpose enters. */
apiV1Routes.get('/pipelines/for-purpose', requireScope('pipeline.view'), asyncRoute(async (req, res) => {
  const { purpose } = z.object({ purpose: z.string().max(40).optional() }).parse(req.query);
  const entry = await entryStage(pool, req.apiKey!.organizationId, purpose);
  ok(res, { pipeline: await getPipeline(req.apiKey!.organizationId, entry.pipelineId), entry_stage_key: entry.stageKey });
}));

apiV1Routes.get('/pipelines/:id', requireScope('pipeline.view'), asyncRoute(async (req, res) => {
  ok(res, await getPipeline(req.apiKey!.organizationId, String(req.params.id)));
}));

apiV1Routes.get('/pipelines/:id/usage', requireScope('pipeline.view'), asyncRoute(async (req, res) => {
  ok(res, await pipelineUsage(req.apiKey!.organizationId, String(req.params.id)));
}));

apiV1Routes.post('/pipelines', requireScope('pipeline.configure'), asyncRoute(async (req, res) => {
  ok(res, await createPipeline(actor(req), req.body), 201);
}));

apiV1Routes.patch('/pipelines/:id', requireScope('pipeline.configure'), asyncRoute(async (req, res) => {
  ok(res, await updatePipeline(actor(req), String(req.params.id), req.body));
}));

apiV1Routes.delete('/pipelines/:id', requireScope('pipeline.configure'), asyncRoute(async (req, res) => {
  ok(res, await deletePipeline(actor(req), String(req.params.id), req.body));
}));

apiV1Routes.post('/pipelines/:id/stages', requireScope('pipeline.configure'), asyncRoute(async (req, res) => {
  ok(res, await createStage(actor(req), String(req.params.id), req.body), 201);
}));

apiV1Routes.get('/stages/:id/usage', requireScope('pipeline.view'), asyncRoute(async (req, res) => {
  ok(res, await stageUsage(req.apiKey!.organizationId, String(req.params.id)));
}));

apiV1Routes.patch('/stages/:id', requireScope('pipeline.configure'), asyncRoute(async (req, res) => {
  ok(res, await updateStage(actor(req), String(req.params.id), req.body));
}));

apiV1Routes.post('/stages/:id/move', requireScope('pipeline.configure'), asyncRoute(async (req, res) => {
  await moveStage(actor(req), String(req.params.id), req.body);
  ok(res, { moved: true });
}));

apiV1Routes.delete('/stages/:id', requireScope('pipeline.configure'), asyncRoute(async (req, res) => {
  ok(res, await deleteStage(actor(req), String(req.params.id), req.body));
}));

/** Move a lead to a stage — in its pipeline, or in another one. Entry rules apply. */
apiV1Routes.post('/leads/:id/stage', requireScope('pipeline.move'), asyncRoute(async (req, res) => {
  const result = await moveFileToStage(actor(req), String(req.params.id), req.body, { mayForce: false });
  if (!result.ok) {
    res.status(422).json({ ok: false, code: 'stage_blocked', error: result.message, blockers: result.blockers });
    return;
  }
  ok(res, result);
}));

// ── Appointments ───────────────────────────────────────────────────────────
// A key acts for the brokerage, not for one person: it sees everyone's with
// appointment.view_all and books for anyone with appointment.manage_all. A
// booking with no user_id goes to the file's broker.

const appointmentScope = (req: Request): AppointmentScope => ({
  actor: actor(req),
  viewAll: req.apiKey!.permissions.has('appointment.view_all') || req.apiKey!.permissions.has('appointment.manage_all'),
  manage: false,
  manageAll: req.apiKey!.permissions.has('appointment.manage_all'),
});
const readAppointments = requireScope('appointment.view_all', 'appointment.manage_all');
const writeAppointments = requireScope('appointment.manage_all');

apiV1Routes.get('/appointments/meta', readAppointments, asyncRoute(async (req, res) => {
  const { google: _mine, ...meta } = await appointmentMeta(appointmentScope(req));
  ok(res, meta);
}));

apiV1Routes.get('/appointments', readAppointments, asyncRoute(async (req, res) => {
  ok(res, await listAppointments(appointmentScope(req), req.query));
}));

apiV1Routes.get('/appointments/hosts', writeAppointments, asyncRoute(async (req, res) => {
  ok(res, await bookableHosts(appointmentScope(req)));
}));

apiV1Routes.get('/appointments/files', writeAppointments, asyncRoute(async (req, res) => {
  if (!req.query.host) throw fieldError('host', 'Say whose clients: host=<staff id>.');
  ok(res, await bookableFiles(appointmentScope(req), req.query));
}));

apiV1Routes.get('/appointments/availability', writeAppointments, asyncRoute(async (req, res) => {
  if (!req.query.host) throw fieldError('host', 'Say whose calendar: host=<staff id>.');
  ok(res, await availability(appointmentScope(req), req.query));
}));

apiV1Routes.get('/appointments/:id', readAppointments, asyncRoute(async (req, res) => {
  ok(res, await getAppointment(appointmentScope(req), String(req.params.id)));
}));

apiV1Routes.post('/appointments', writeAppointments, asyncRoute(async (req, res) => {
  ok(res, await bookAppointment(appointmentScope(req), req.body), 201);
}));

apiV1Routes.patch('/appointments/:id', writeAppointments, asyncRoute(async (req, res) => {
  ok(res, await updateAppointment(appointmentScope(req), String(req.params.id), req.body));
}));

apiV1Routes.post('/appointments/:id/cancel', writeAppointments, asyncRoute(async (req, res) => {
  ok(res, await cancelAppointment(appointmentScope(req), String(req.params.id), req.body));
}));

apiV1Routes.post('/appointments/:id/confirm', writeAppointments, asyncRoute(async (req, res) => {
  ok(res, await confirmAppointment(appointmentScope(req), String(req.params.id)));
}));

apiV1Routes.post('/appointments/:id/outcome', writeAppointments, asyncRoute(async (req, res) => {
  ok(res, await recordOutcome(appointmentScope(req), String(req.params.id), req.body));
}));

// ── Activity logs ──────────────────────────────────────────────────────────
// Read-only: entries cannot be deleted, here or anywhere. A key reads
// everyone's (there is no "own" for a website), hence the one scope.

apiV1Routes.get('/activity', requireScope('activity.view_all'), asyncRoute(async (req, res) => {
  ok(res, await listActivity({ organizationId: req.apiKey!.organizationId, userId: null, seeAll: true }, req.query));
}));

apiV1Routes.get('/activity/options', requireScope('activity.view_all'), asyncRoute(async (req, res) => {
  ok(res, await activityOptions({ organizationId: req.apiKey!.organizationId, userId: null, seeAll: true }));
}));

apiV1Routes.use((_req, res) => {
  res.status(404).json({ ok: false, code: 'not_found', error: 'No such endpoint in API v1. See docs/API.md.' });
});
