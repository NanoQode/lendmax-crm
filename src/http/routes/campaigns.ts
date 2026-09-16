/**
 * Campaigns.
 *
 * Sending is a two-step act: the audience is frozen onto the campaign as
 * rows, and only then is the send started. Between the two, a person sees
 * the arithmetic — how many matched, how many will actually receive it, and
 * why the rest will not. A campaign screen that shows one number is how a
 * brokerage comes to believe it reached four thousand people when it reached
 * two.
 *
 * Nothing here decides whether a client may be sent a commercial message.
 * That is `evaluateSend`, the same function every other send in the CRM goes
 * through, and this module's job is to run it over a set and record what it
 * said.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../db/pool.ts';
import { recordAudit } from '../../services/audit.ts';
import { asyncRoute, AppError, notFound } from '../middleware/errors.ts';
import { requireAuth, requirePermission } from '../middleware/auth.ts';
import { can } from '../../domain/permissions.ts';
import {
  buildAudience, campaignResults, freezeAudience,
} from '../../services/campaigns.ts';
import {
  describeAudience, describeSegment, SEGMENT_FIELDS, validateSegment, type Segment,
} from '../../domain/segment.ts';
import {
  BlockSchema, renderCampaign, renderSms, sendBlockers, type Block, type Footer,
} from '../../domain/blocks.ts';
import { MERGE_FIELDS, renderTemplate, validateTemplate } from '../../domain/merge-fields.ts';
import { calculatorMergeValues } from '../../services/link-tracking.ts';
import { enqueue } from '../../jobs/queue.ts';
import { env } from '../../config/env.ts';
import { signatureFor } from '../../services/signature.ts';
import { pipelineOptions } from '../../services/pipelines.ts';

export const campaignRoutes: Router = Router();
campaignRoutes.use(requireAuth);

/**
 * The brokerage's own details, which a commercial message must carry.
 *
 * The mailing address lives in `settings` rather than on the organisation
 * row because, like every other compliance-shaped value in this system, it
 * is dated: a brokerage that moves office still has to be able to read what
 * address was on the mail it sent last year.
 */
export async function footerFor(organizationId: string): Promise<Footer> {
  const org = await queryOne<{
    name: string; licence_number: string | null; regulator: string | null;
  }>('SELECT name, licence_number, regulator FROM organizations WHERE id = $1',
     [organizationId]);
  const setting = await queryOne<{ value: { address?: string } }>(
    `SELECT value FROM settings
      WHERE organization_id = $1 AND key = 'mailing_address'
        AND effective_from <= CURRENT_DATE
      ORDER BY effective_from DESC LIMIT 1`, [organizationId]);
  return {
    organizationName: org?.name ?? 'Lendmax',
    physicalAddress: setting?.value?.address ?? null,
    brokerageLicence: org?.licence_number
      ? `${org.regulator ?? 'Licence'} ${org.licence_number}` : null,
    unsubscribeUrl: `${env.PUBLIC_URL}/u/{unsubscribe_token}`,
  };
}

// ── The list and the catalogue ─────────────────────────────────────────────

campaignRoutes.get(
  '/campaigns',
  requirePermission('campaign.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const { rows } = await query(
      `SELECT c.id, c.name, c.description, c.channel, c.purpose, c.status, c.subject,
              c.scheduled_for, c.send_started_at, c.send_finished_at, c.audience_snapshot,
              c.updated_at, u.name AS created_by_name,
              COALESCE(r.total, 0) AS recipients,
              COALESCE(r.sent, 0) AS sent,
              COALESCE(r.suppressed, 0) AS suppressed,
              COALESCE(a.outcomes, 0) AS outcomes
         FROM campaigns c
         LEFT JOIN users u ON u.id = c.created_by
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE status IN ('sent','delivered','opened','clicked'))::int AS sent,
                  count(*) FILTER (WHERE status = 'suppressed')::int AS suppressed
             FROM campaign_recipients cr WHERE cr.campaign_id = c.id
         ) r ON TRUE
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS outcomes FROM campaign_attributions ca
            WHERE ca.campaign_id = c.id
         ) a ON TRUE
        WHERE c.organization_id = $1 AND c.status <> 'cancelled'
        ORDER BY (c.status = 'sending') DESC, c.updated_at DESC`,
      [user.organization_id]);

    res.json({ campaigns: rows, can_edit: can(user, 'campaign.edit'),
               can_send: can(user, 'campaign.send') });
  }),
);

campaignRoutes.get(
  '/campaigns/catalogue',
  requirePermission('campaign.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const { pipelines, stages } = await pipelineOptions(user.organization_id);
    res.json({
      fields: Object.entries(SEGMENT_FIELDS).map(([key, spec]) => ({ key, ...spec, sql: undefined })),
      merge_fields: MERGE_FIELDS,
      stages,
      pipelines,
      block_types: [
        { type: 'heading', label: 'Heading' },
        { type: 'text', label: 'Paragraph' },
        { type: 'button', label: 'Button' },
        { type: 'image', label: 'Image' },
        { type: 'rate_table', label: 'Rate table' },
        { type: 'columns', label: 'Columns' },
        { type: 'divider', label: 'Divider' },
        { type: 'spacer', label: 'Space' },
        { type: 'signature', label: 'Signature' },
      ],
    });
  }),
);

// ── One campaign ───────────────────────────────────────────────────────────

campaignRoutes.get(
  '/campaigns/:id',
  requirePermission('campaign.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const campaign = await queryOne<{
      id: string; channel: 'email' | 'sms'; purpose: 'marketing' | 'service' | 'transactional';
      blocks: unknown; segment: Segment; subject: string | null; status: string;
      preheader: string | null; audience_snapshot: unknown;
    }>(
      `SELECT c.*, u.name AS created_by_name, a.name AS approved_by_name
         FROM campaigns c
         LEFT JOIN users u ON u.id = c.created_by
         LEFT JOIN users a ON a.id = c.approved_by
        WHERE c.id = $1 AND c.organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!campaign) throw notFound('That campaign');

    const blocks = parseBlocks(campaign.blocks);
    const footer = await footerFor(user.organization_id);

    // The audience is recomputed on every read of a draft, because a segment
    // written last week against a pipeline that has moved is a different
    // audience and the screen must not show the old number.
    const live = campaign.status === 'draft' || campaign.status === 'scheduled';
    const audience = live
      ? await buildAudience(user.organization_id, campaign.segment ?? {},
                            campaign.channel, campaign.purpose, { limit: 25 })
      : null;

    res.json({
      campaign,
      blocks: blocks.parsed,
      block_problems: blocks.problems,
      segment_description: describeSegment(campaign.segment ?? {}),
      segment_issues: validateSegment(campaign.segment ?? {}),
      audience: audience?.count ?? campaign_snapshot(campaign),
      audience_sentence: audience
        ? describeAudience(audience.count, campaign.channel)
        : null,
      audience_sample: audience?.members ?? [],
      send_blockers: [
        ...blocks.problems,
        ...(campaign.subject ? validateTemplate(campaign.subject).map((i) => i.message) : []),
        ...sendBlockers(blocks.parsed, {
          channel: campaign.channel, purpose: campaign.purpose,
          subject: campaign.subject, footer,
        }),
      ],
      results: campaign.status === 'draft' ? null : await campaignResults(campaign.id),
      can_edit: can(user, 'campaign.edit'),
      can_send: can(user, 'campaign.send'),
    });
  }),
);

function campaign_snapshot(campaign: { audience_snapshot?: unknown }): unknown {
  return campaign.audience_snapshot ?? { matched: 0, sendable: 0, suppressed: [] };
}

function parseBlocks(value: unknown): { parsed: Block[]; problems: string[] } {
  const problems: string[] = [];
  const parsed: Block[] = [];
  for (const [index, raw] of (Array.isArray(value) ? value : []).entries()) {
    const result = BlockSchema.safeParse(raw);
    if (result.success) parsed.push(result.data);
    // A block that no longer parses is named rather than silently dropped —
    // a campaign that renders without a section nobody noticed is worse than
    // one that says a section is broken.
    else problems.push(`Block ${index + 1} is not valid and will not be sent.`);
  }
  return { parsed, problems };
}

// ── Creating and editing ───────────────────────────────────────────────────

campaignRoutes.post(
  '/campaigns',
  requirePermission('campaign.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      name: z.string().trim().min(1, 'A campaign needs a name.'),
      channel: z.enum(['email', 'sms']).default('email'),
      purpose: z.enum(['marketing', 'service', 'transactional']).default('marketing'),
      description: z.string().trim().optional(),
    }).parse(req.body);

    const created = await queryOne<{ id: string }>(
      `INSERT INTO campaigns (organization_id, name, description, channel, purpose,
                              status, created_by, blocks, segment)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,'[]'::jsonb,'{}'::jsonb) RETURNING id`,
      [user.organization_id, body.name, body.description ?? null, body.channel,
       body.purpose, user.id]);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'campaign.create',
      entityType: 'campaign',
      entityId: created!.id,
      summary: `Campaign "${body.name}" created as a draft`,
    });

    res.status(201).json({ id: created!.id });
  }),
);

campaignRoutes.put(
  '/campaigns/:id',
  requirePermission('campaign.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      name: z.string().trim().min(1).optional(),
      description: z.string().trim().nullable().optional(),
      subject: z.string().trim().nullable().optional(),
      preheader: z.string().trim().nullable().optional(),
      from_name: z.string().trim().nullable().optional(),
      reply_to: z.string().trim().nullable().optional(),
      blocks: z.array(z.unknown()).optional(),
      segment: z.record(z.string(), z.unknown()).optional(),
      scheduled_for: z.string().nullable().optional(),
      throttle_per_minute: z.number().int().min(1).max(6000).optional(),
    }).parse(req.body);

    const campaign = await queryOne<{ id: string; status: string; name: string }>(
      `SELECT id, status, name FROM campaigns WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!campaign) throw notFound('That campaign');
    // Editing a campaign mid-send would change what the remaining half of the
    // audience receives, which makes "what did this campaign say" unanswerable.
    if (campaign.status === 'sending' || campaign.status === 'completed') {
      throw new AppError(
        `This campaign has already been ${campaign.status === 'sending' ? 'started' : 'sent'} `
        + 'and cannot be changed. Duplicate it instead.', 409, 'already_sent');
    }

    if (body.blocks) {
      const problems = parseBlocks(body.blocks).problems;
      if (problems.length) throw new AppError(problems[0]!, 400, 'invalid_block', problems);
    }
    if (body.segment) {
      const issues = validateSegment(body.segment as Segment);
      if (issues.length) throw new AppError(issues[0]!.message, 400, 'invalid_segment', issues);
    }

    const columns: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      columns[key] = key === 'blocks' || key === 'segment' ? JSON.stringify(value) : value;
    }
    const names = Object.keys(columns);
    if (names.length) {
      await query(
        `UPDATE campaigns SET ${names.map((n, i) =>
          `${n} = $${i + 2}${n === 'blocks' || n === 'segment' ? '::jsonb' : ''}`).join(', ')}
          WHERE id = $1`,
        [campaign.id, ...names.map((n) => columns[n])]);
    }

    res.json({ ok: true });
  }),
);

/** A preview against the example values, and against one real client. */
campaignRoutes.post(
  '/campaigns/:id/preview',
  requirePermission('campaign.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({ customer_id: z.string().uuid().optional() }).parse(req.body ?? {});

    const campaign = await queryOne<{
      id: string; channel: 'email' | 'sms'; purpose: 'marketing' | 'service' | 'transactional';
      blocks: unknown; preheader: string | null; subject: string | null;
    }>(
      `SELECT id, channel, purpose, blocks, preheader, subject FROM campaigns
        WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!campaign) throw notFound('That campaign');

    const blocks = parseBlocks(campaign.blocks).parsed;
    const footer = await footerFor(user.organization_id);

    const values = body.customer_id
      ? await mergeValuesFor(user.organization_id, body.customer_id, user)
      : exampleValues();

    const rendered = campaign.channel === 'sms'
      ? { html: '', ...renderSms(blocks, { values }, { purpose: campaign.purpose }),
          dropped: [], problems: [] }
      : renderCampaign(blocks, { values }, footer,
          { channel: 'email', purpose: campaign.purpose, preheader: campaign.preheader });

    // The subject is previewed through the same renderer the send uses, so a
    // merge field that will not resolve is visible here rather than in a
    // client's inbox.
    const subject = campaign.subject ? previewSubject(campaign.subject, values) : null;

    res.json({
      subject: subject?.text ?? null,
      subject_missing: subject?.missing ?? [],
      html: 'html' in rendered ? rendered.html : '',
      text: rendered.text,
      missing: rendered.missing,
      dropped: 'dropped' in rendered ? rendered.dropped : [],
      problems: 'problems' in rendered ? rendered.problems : [],
      against: body.customer_id ? 'a real client' : 'the example values',
    });
  }),
);

function previewSubject(template: string, values: Record<string, unknown>) {
  return renderTemplate(template, { values });
}

function exampleValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of MERGE_FIELDS) {
    values[field.name] = field.format === 'money' ? 785000
      : field.format === 'date' ? '2026-10-15'
      : field.format === 'days' ? 34
      : field.format === 'percent' ? 78
      : field.example;
  }
  return values;
}

async function mergeValuesFor(
  organizationId: string,
  customerId: string,
  user: { id?: string; name: string; email: string },
): Promise<Record<string, unknown>> {
  const signature = await signatureFor(user.id);
  const row = await queryOne<Record<string, unknown>>(
    `SELECT c.first_name, c.last_name,
            app.portal_reference, app.amount_requested, app.transaction_type_key,
            app.property_city, app.property_province, app.closing_date,
            app.percent_complete, app.documents_outstanding,
            (app.closing_date - CURRENT_DATE) AS days_to_close,
            ren.maturity_date, (ren.maturity_date - CURRENT_DATE) AS days_to_maturity,
            ps.label AS stage_label,
            o.name AS organization_name
       FROM customers c
       JOIN organizations o ON o.id = c.organization_id
       LEFT JOIN LATERAL (SELECT a.* FROM applications a WHERE a.customer_id = c.id
                           ORDER BY a.created_at DESC LIMIT 1) app ON TRUE
       LEFT JOIN LATERAL (SELECT r.* FROM renewal_records r WHERE r.customer_id = c.id
                           ORDER BY r.maturity_date LIMIT 1) ren ON TRUE
       LEFT JOIN pipeline_stages ps
              ON ps.organization_id = c.organization_id AND ps.key = app.stage_key
      WHERE c.id = $1 AND c.organization_id = $2`,
    [customerId, organizationId]);

  return {
    ...(row ?? {}),
    user_name: user.name,
    user_first_name: user.name.split(' ')[0],
    signature: signature?.text ?? null,
    user_signature_html: signature?.html ?? null,
    ...calculatorMergeValues(organizationId, customerId, row?.transaction_type_key),
  };
}

// ── Sending ────────────────────────────────────────────────────────────────

/**
 * Freeze the audience.
 *
 * Deliberately a separate act from sending. The rows are written, the
 * arithmetic comes back, and a person reads it before anything goes out.
 */
campaignRoutes.post(
  '/campaigns/:id/audience',
  requirePermission('campaign.edit'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const campaign = await queryOne<{
      id: string; channel: 'email' | 'sms'; purpose: 'marketing' | 'service' | 'transactional';
      segment: Segment; status: string;
    }>(
      `SELECT id, channel, purpose, segment, status FROM campaigns
        WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!campaign) throw notFound('That campaign');
    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      throw new AppError('The audience is already fixed for this campaign.', 409);
    }

    const count = await freezeAudience(
      campaign.id, user.organization_id, campaign.segment ?? {},
      campaign.channel, campaign.purpose);

    res.json({ ok: true, audience: count,
               sentence: describeAudience(count, campaign.channel) });
  }),
);

/**
 * Start the send.
 *
 * Re-checks everything rather than trusting the screen, then hands the work
 * to the queue in paced batches — a brokerage's sending domain does not
 * survive forty thousand messages in ninety seconds, and neither does its
 * relationship with its clients.
 */
campaignRoutes.post(
  '/campaigns/:id/send',
  requirePermission('campaign.send'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const body = z.object({
      confirm_count: z.number().int().optional(),
      test_to_self: z.boolean().default(false),
    }).parse(req.body ?? {});

    const campaign = await queryOne<{
      id: string; name: string; channel: 'email' | 'sms';
      purpose: 'marketing' | 'service' | 'transactional';
      blocks: unknown; subject: string | null; status: string;
      throttle_per_minute: number; segment: Segment;
    }>(
      `SELECT id, name, channel, purpose, blocks, subject, status, throttle_per_minute, segment
         FROM campaigns WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!campaign) throw notFound('That campaign');
    if (campaign.status === 'sending' || campaign.status === 'completed') {
      throw new AppError('This campaign has already been sent.', 409, 'already_sent');
    }

    const blocks = parseBlocks(campaign.blocks);
    const footer = await footerFor(user.organization_id);
    const subjectIssues = campaign.subject ? validateTemplate(campaign.subject) : [];
    const blockers = [
      ...blocks.problems,
      ...subjectIssues.map((i) => i.message),
      ...sendBlockers(blocks.parsed, {
        channel: campaign.channel, purpose: campaign.purpose,
        subject: campaign.subject, footer,
      }),
    ];
    if (blockers.length) {
      throw new AppError(
        blockers.length === 1 ? blockers[0]! : `${blockers.length} things stop this being sent.`,
        400, 'not_sendable', blockers);
    }

    const pending = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM campaign_recipients
        WHERE campaign_id = $1 AND status = 'pending'`, [campaign.id]);
    if (!pending?.count) {
      throw new AppError(
        'There is nobody to send this to. Rebuild the audience first.', 400, 'no_audience');
    }

    // The count the person saw must be the count being sent. An audience
    // frozen on Monday and sent on Thursday against a segment that has moved
    // is a different campaign than the one that was approved.
    if (body.confirm_count !== undefined && body.confirm_count !== pending.count) {
      throw new AppError(
        `The audience has changed since you looked: it is now ${pending.count}, `
        + `not ${body.confirm_count}. Review it and try again.`,
        409, 'audience_changed', { now: pending.count });
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE campaigns
            SET status = 'sending', send_started_at = now(), approved_by = $2, approved_at = now()
          WHERE id = $1`, [campaign.id, user.id]);
    });

    await enqueue('campaign.send', { campaignId: campaign.id }, {
      organizationId: user.organization_id,
      dedupeKey: `campaign.send:${campaign.id}`,
    });

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'campaign.send',
      entityType: 'campaign',
      entityId: campaign.id,
      summary: `"${campaign.name}" sent to ${pending.count} recipient(s), `
        + `paced at ${campaign.throttle_per_minute} a minute`,
    });

    res.json({ ok: true, sending: pending.count });
  }),
);

/** Stop a send that is running. */
campaignRoutes.post(
  '/campaigns/:id/pause',
  requirePermission('campaign.send'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const campaign = await queryOne<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM campaigns WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!campaign) throw notFound('That campaign');
    if (campaign.status !== 'sending') {
      throw new AppError('That campaign is not sending.', 409);
    }

    await query(`UPDATE campaigns SET status = 'paused' WHERE id = $1`, [campaign.id]);
    const remaining = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM campaign_recipients
        WHERE campaign_id = $1 AND status = 'pending'`, [campaign.id]);

    await recordAudit({
      organizationId: user.organization_id,
      actor: { userId: user.id, name: user.name, role: user.role, ip: req.ip },
      action: 'campaign.pause',
      entityType: 'campaign',
      entityId: campaign.id,
      summary: `"${campaign.name}" paused with ${remaining?.count ?? 0} still to send`,
    });

    res.json({ ok: true, remaining: remaining?.count ?? 0 });
  }),
);

campaignRoutes.post(
  '/campaigns/:id/resume',
  requirePermission('campaign.send'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const campaign = await queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM campaigns WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organization_id]);
    if (!campaign) throw notFound('That campaign');
    if (campaign.status !== 'paused') throw new AppError('That campaign is not paused.', 409);

    await query(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [campaign.id]);
    await enqueue('campaign.send', { campaignId: campaign.id }, {
      organizationId: user.organization_id,
      dedupeKey: `campaign.send:${campaign.id}:resume:${Date.now()}`,
    });
    res.json({ ok: true });
  }),
);

/** The recipient list, which is what "who did this go to" reads. */
campaignRoutes.get(
  '/campaigns/:id/recipients',
  requirePermission('campaign.view'),
  asyncRoute(async (req, res) => {
    const user = req.user!;
    const q = z.object({
      status: z.string().default('all'),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query);

    const params: unknown[] = [req.params.id, user.organization_id, q.limit];
    let filter = '';
    if (q.status === 'suppressed') filter = `AND cr.status = 'suppressed'`;
    else if (q.status === 'sent') filter = `AND cr.status IN ('sent','delivered','opened','clicked')`;
    else if (q.status === 'problem') filter = `AND cr.status IN ('bounced','failed')`;

    const { rows } = await query(
      `SELECT cr.id, cr.status, cr.address, cr.suppress_reason, cr.sent_at, cr.opened_at,
              cr.clicked_at, cr.failure_reason, cr.unsubscribed_at,
              c.id AS customer_id, c.first_name, c.last_name
         FROM campaign_recipients cr
         JOIN campaigns ca ON ca.id = cr.campaign_id
         JOIN customers c ON c.id = cr.customer_id
        WHERE cr.campaign_id = $1 AND ca.organization_id = $2 ${filter}
        ORDER BY cr.status, c.last_name LIMIT $3`,
      params);

    res.json({ recipients: rows });
  }),
);
