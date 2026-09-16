/**
 * Communication: the thread on a file, and sending from it.
 *
 * This exists because the alternative is worse. Before it, the client
 * workspace's "Email" button was a `mailto:` link — which opens the broker's
 * own mail client, goes around the consent gate entirely, and records
 * nothing. Every one of those is a problem:
 *
 *   The gate is the only thing standing between a brokerage and sending a
 *   commercial message to somebody who has unsubscribed. A send path that
 *   does not pass through it is a send path that will eventually break CASL.
 *
 *   A message that is not on the file did not happen, as far as the next
 *   person to pick it up is concerned — and "did anybody tell them about the
 *   appraisal" is a question asked constantly.
 *
 *   `last_contacted_at` and "awaiting reply" drive the dashboard. A broker
 *   emailing from Outlook makes both wrong.
 *
 * So: one composer, one path, `send()` does the gate, and a refusal is shown
 * as a refusal with the reason rather than a failure.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/pool.ts';
import { recordAudit } from '../../services/audit.ts';
import { asyncRoute, AppError, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';
import { can } from '../../domain/permissions.ts';
import { gateFor, send } from '../../services/messaging.ts';
import { renderTemplate, validateTemplate } from '../../domain/merge-fields.ts';
import { calculatorMergeValues } from '../../services/link-tracking.ts';
import { measureSegments } from '../../integrations/voipms.ts';
import { textToHtml } from '../../domain/signature.ts';
import { signatureFor } from '../../services/signature.ts';

/**
 * The sender's signature under an email, unless they turned it off for this
 * one or already placed {signature} in the body themselves. Texts never get
 * one: a signature costs a text message its second segment.
 */
async function withSignature(
  channel: 'email' | 'sms', include: boolean, source: string, bodyText: string, userId: string,
): Promise<{ text: string; html?: string; signature: { text: string; html: string } | null }> {
  if (channel !== 'email') return { text: bodyText, signature: null };
  const placed = source.includes('{signature}');
  const sig = include && !placed ? await signatureFor(userId) : null;
  return {
    text: sig ? `${bodyText}\n\n${sig.text}` : bodyText,
    html: textToHtml(bodyText) + (sig?.html ?? ''),
    signature: sig,
  };
}

export const messageRoutes: Router = Router();
messageRoutes.use(requireAuth);

/** Everything said to one client, in one list, with why anything was not. */
messageRoutes.get(
  '/customers/:id/messages',
  requirePermission('message.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const customerId = String(req.params.id);

    const customer = await queryOne<{
      id: string; first_name: string; last_name: string;
      email: string | null; phone_e164: string | null;
    }>(
      `SELECT id, first_name, last_name, email, phone_e164 FROM customers
        WHERE id = $1 AND organization_id = $2`,
      [customerId, user.organization_id]);
    if (!customer) throw notFound('That client');

    const { rows } = await query(
      `SELECT m.id, m.channel, m.direction, m.origin, m.purpose, m.subject, m.body_text,
              m.status, m.sent_at, m.delivered_at, m.failed_at, m.failure_reason,
              m.read_at, m.created_at, m.gate_decision, m.template_key,
              m.to_address, m.from_address,
              u.name AS sent_by_name,
              ca.name AS campaign_name,
              a.name AS automation_name
         FROM messages m
         LEFT JOIN users u ON u.id = m.sent_by
         LEFT JOIN campaigns ca ON ca.id = m.campaign_id
         LEFT JOIN automation_enrollments e ON e.id = m.automation_run_id
         LEFT JOIN automations a ON a.id = e.automation_id
        WHERE m.customer_id = $1 AND m.organization_id = $2
        ORDER BY m.created_at DESC
        LIMIT 200`,
      [customerId, user.organization_id]);

    // What the gate would say right now, for each channel, so the composer
    // can tell a broker before they write rather than after they press send.
    const [email, sms] = await Promise.all([
      gateFor(user.organization_id, customerId, 'email', 'transactional'),
      gateFor(user.organization_id, customerId, 'sms', 'transactional'),
    ]);
    const [emailMarketing, smsMarketing] = await Promise.all([
      gateFor(user.organization_id, customerId, 'email', 'marketing'),
      gateFor(user.organization_id, customerId, 'sms', 'marketing'),
    ]);

    const templates = await query(
      `SELECT key, name, channel, subject, body_text FROM templates
        WHERE organization_id = $1 AND active AND kind IN ('personal','appointment')
        ORDER BY name`, [user.organization_id]);

    res.json({
      customer,
      messages: rows.reverse(),
      can_send: can(user, 'message.send'),
      gates: {
        email: { ...email.decision, address: email.address,
                 marketing: emailMarketing.decision },
        sms: { ...sms.decision, address: sms.address, marketing: smsMarketing.decision },
      },
      templates: templates.rows,
    });
  }),
);

/**
 * Send one message to one client.
 *
 * The purpose is chosen by the sender and it matters: a rate update is
 * commercial whatever the broker calls it, and labelling one transactional
 * to get it past the gate is the thing this endpoint must not make easy. So
 * the screen asks, the gate decides, and the decision is recorded on the
 * message either way.
 */
messageRoutes.post(
  '/customers/:id/messages',
  requirePermission('message.send'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const customerId = String(req.params.id);
    const body = z.object({
      channel: z.enum(['email', 'sms']),
      purpose: z.enum(['transactional', 'marketing', 'service']).default('transactional'),
      subject: z.string().trim().optional(),
      body_text: z.string().trim().min(1, 'There is nothing to send.'),
      application_id: z.string().uuid().nullable().optional(),
      template_key: z.string().optional(),
      urgent: z.boolean().default(false),
      include_signature: z.boolean().default(true),
    }).parse(req.body);

    const customer = await queryOne<{ id: string; first_name: string; last_name: string }>(
      `SELECT id, first_name, last_name FROM customers
        WHERE id = $1 AND organization_id = $2`,
      [customerId, user.organization_id]);
    if (!customer) throw notFound('That client');

    if (body.channel === 'email' && !body.subject?.trim()) {
      throw new AppError('An email needs a subject.', 400);
    }

    // The merge fields are rendered here, through the same renderer every
    // other send uses, so a broker's ad-hoc message cannot reach a client
    // with a placeholder in it either.
    const issues = [
      ...validateTemplate(body.body_text),
      ...(body.subject ? validateTemplate(body.subject) : []),
    ];
    if (issues.length) {
      throw new AppError(issues[0]!.message, 400, 'invalid_template', issues);
    }

    const values = await mergeValues(user.organization_id, customerId,
                                     body.application_id ?? null, user);
    const rendered = renderTemplate(body.body_text, { values });
    const subject = body.subject ? renderTemplate(body.subject, { values }) : null;

    if (rendered.empty) {
      throw new AppError(
        `Nothing would be sent: every line needs ${rendered.missing.join(', ')}, and this `
        + 'client has no value for that.', 400, 'nothing_to_send', rendered.missing);
    }
    if (subject?.empty) {
      throw new AppError(
        `The subject needs ${subject.missing.join(', ')}, which this client has no value for.`,
        400, 'nothing_to_send', subject.missing);
    }

    const signed = await withSignature(body.channel, body.include_signature, body.body_text,
                                       rendered.text, user.id);

    const outcome = await send({
      organizationId: user.organization_id,
      customerId,
      applicationId: body.application_id ?? null,
      channel: body.channel,
      purpose: body.purpose,
      subject: subject?.text,
      bodyText: signed.text,
      bodyHtml: signed.html,
      origin: 'manual',
      sentBy: user.id,
      templateKey: body.template_key ?? null,
      mergeSnapshot: values,
      urgent: body.urgent,
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: outcome.ok ? 'message.send' : 'message.suppressed',
      entityType: 'customer',
      entityId: customerId,
      summary: outcome.ok
        ? `${body.channel === 'sms' ? 'Text' : 'Email'} sent to `
          + `${customer.first_name} ${customer.last_name}`
        : `${body.channel === 'sms' ? 'Text' : 'Email'} not sent — ${outcome.decision.reason}`,
    });

    // A suppressed send is a 200 with the reason, not an error: the broker
    // did nothing wrong, the system declined on the client's behalf, and it
    // is recorded on the file either way.
    res.json({
      ok: outcome.ok,
      status: outcome.status,
      message_id: outcome.messageId,
      reason: outcome.decision.reason,
      dropped: rendered.dropped,
    });
  }),
);

/** What a message will look like and, for a text, how many segments it is. */
messageRoutes.post(
  '/customers/:id/messages/preview',
  requirePermission('message.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      channel: z.enum(['email', 'sms']),
      subject: z.string().optional(),
      body_text: z.string(),
      application_id: z.string().uuid().nullable().optional(),
      include_signature: z.boolean().default(true),
    }).parse(req.body);

    const values = await mergeValues(user.organization_id, String(req.params.id),
                                     body.application_id ?? null, user);
    const rendered = renderTemplate(body.body_text, { values });
    const subject = body.subject ? renderTemplate(body.subject, { values }) : null;
    const signed = await withSignature(body.channel, body.include_signature, body.body_text,
                                       rendered.text, user.id);

    res.json({
      text: signed.text,
      html: signed.html ?? null,
      signature: signed.signature,
      subject: subject?.text ?? null,
      missing: [...new Set([...rendered.missing, ...(subject?.missing ?? [])])],
      dropped: rendered.dropped,
      empty: rendered.empty,
      issues: [
        ...validateTemplate(body.body_text),
        ...(body.subject ? validateTemplate(body.subject) : []),
      ],
      // One curly quote takes an SMS from 160 characters to 70, and a broker
      // has no way to know that without being told.
      segments: body.channel === 'sms' ? measureSegments(rendered.text) : null,
    });
  }),
);

/** The brokerage's inbox: what has come in, and what is waiting on a reply. */
messageRoutes.get(
  '/messages',
  requirePermission('message.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = z.object({
      filter: z.enum(['unread', 'inbound', 'awaiting_reply', 'suppressed', 'all'])
        .default('unread'),
      limit: z.coerce.number().int().min(1).max(200).default(60),
    }).parse(req.query);

    const params: unknown[] = [user.organization_id, q.limit];
    let where = `m.organization_id = $1`;
    if (q.filter === 'unread') where += ` AND m.direction = 'inbound' AND m.read_at IS NULL`;
    else if (q.filter === 'inbound') where += ` AND m.direction = 'inbound'`;
    else if (q.filter === 'suppressed') where += ` AND m.status = 'suppressed'`;
    else if (q.filter === 'awaiting_reply') {
      where += ` AND c.awaiting_reply_since IS NOT NULL`;
    }

    const { rows } = await query(
      `SELECT m.id, m.channel, m.direction, m.subject, m.body_text, m.status,
              m.created_at, m.read_at, m.gate_decision,
              c.id AS customer_id, c.first_name, c.last_name, c.awaiting_reply_since,
              app.id AS application_id
         FROM messages m
         JOIN customers c ON c.id = m.customer_id
         LEFT JOIN LATERAL (SELECT a.id FROM applications a WHERE a.customer_id = c.id
                             ORDER BY a.created_at DESC LIMIT 1) app ON TRUE
        WHERE ${where}
        ORDER BY m.created_at DESC LIMIT $2`,
      params);

    const unmatched = await query(
      `SELECT id, channel, from_address, body AS body_text, received_at, reason,
              candidate_ids
         FROM unmatched_messages WHERE organization_id = $1 AND resolved_at IS NULL
        ORDER BY received_at DESC LIMIT 25`, [user.organization_id]);

    res.json({
      messages: rows,
      // An inbound message from a number matching two clients is held rather
      // than attached to the wrong file. It needs somewhere to be seen.
      unmatched: unmatched.rows,
    });
  }),
);

messageRoutes.post(
  '/messages/:id/read',
  requirePermission('message.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    await query(
      `UPDATE messages SET read_at = now()
        WHERE id = $1 AND organization_id = $2 AND read_at IS NULL`,
      [req.params.id, user.organization_id]);
    res.json({ ok: true });
  }),
);

async function mergeValues(
  organizationId: string,
  customerId: string,
  applicationId: string | null,
  user: { id: string; name: string },
): Promise<Record<string, unknown>> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT c.first_name, c.last_name,
            app.portal_reference, app.amount_requested, app.transaction_type_key,
            app.property_city, app.property_province, app.closing_date,
            app.percent_complete, app.documents_outstanding, app.purpose,
            (app.closing_date - CURRENT_DATE) AS days_to_close,
            ren.maturity_date, (ren.maturity_date - CURRENT_DATE) AS days_to_maturity,
            ps.label AS stage_label, o.name AS organization_name,
            u.name AS user_name, p.mobile_phone AS user_cell, p.booking_url AS schedule_link
       FROM customers c
       JOIN organizations o ON o.id = c.organization_id
       LEFT JOIN users u ON u.id = $3
       LEFT JOIN user_profiles p ON p.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT a.* FROM applications a
          WHERE a.customer_id = c.id AND ($4::uuid IS NULL OR a.id = $4::uuid)
          ORDER BY a.created_at DESC LIMIT 1
       ) app ON TRUE
       LEFT JOIN LATERAL (
         SELECT r.* FROM renewal_records r WHERE r.customer_id = c.id
          ORDER BY r.maturity_date LIMIT 1
       ) ren ON TRUE
       LEFT JOIN pipeline_stages ps
              ON ps.organization_id = c.organization_id AND ps.key = app.stage_key
      WHERE c.id = $1 AND c.organization_id = $2`,
    [customerId, organizationId, user.id, applicationId]);

  return {
    ...(row ?? {}),
    user_first_name: String(row?.user_name ?? user.name).split(' ')[0],
    signature: (await signatureFor(user.id))?.text ?? null,
    ...calculatorMergeValues(organizationId, customerId, row?.transaction_type_key),
  };
}
