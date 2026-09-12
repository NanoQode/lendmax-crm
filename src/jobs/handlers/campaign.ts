/**
 * Sending a campaign, in paced batches.
 *
 * The handler takes one batch, sends it, and re-queues itself for the next
 * minute. Not a loop with a sleep in it: a worker asleep for an hour holds a
 * job lease it cannot renew, and a restart mid-sleep loses the campaign. A
 * job that re-queues itself survives a deploy.
 *
 * Every message goes through `send`, so the gate runs AGAIN at the moment of
 * sending. The audience was frozen possibly days ago; somebody who
 * unsubscribed in between must not receive this, and the recipient row
 * records that they did not and why.
 */
import { query, queryOne } from '../../db/pool.ts';
import { registerHandler } from '../worker.ts';
import { enqueue } from '../queue.ts';
import { log } from '../../lib/logger.ts';
import { send } from '../../services/messaging.ts';
import { renderCampaign, renderSms, BlockSchema, type Block } from '../../domain/blocks.ts';
import { renderTemplate } from '../../domain/merge-fields.ts';
import { footerFor } from '../../http/routes/campaigns.ts';
import { unsubscribeUrl } from '../../services/unsubscribe.ts';

/** How many go out per batch minute. Derived from the campaign's throttle. */
const BATCH_SECONDS = 60;

export function registerCampaignHandlers(): void {
  registerHandler('campaign.send', async (job) => {
    const campaignId = String((job.payload as { campaignId?: string }).campaignId ?? '');
    if (!campaignId) throw new Error('campaign.send needs a campaignId.');

    const campaign = await queryOne<{
      id: string; organization_id: string; name: string; channel: 'email' | 'sms';
      purpose: 'marketing' | 'service' | 'transactional'; blocks: unknown;
      subject: string | null; preheader: string | null; status: string;
      throttle_per_minute: number; from_name: string | null; reply_to: string | null;
      sender_id: string | null;
    }>(
      `SELECT c.id, c.organization_id, c.name, c.channel, c.purpose, c.blocks, c.subject,
              c.preheader, c.status, c.throttle_per_minute, c.from_name, c.reply_to,
              COALESCE(c.approved_by, c.created_by) AS sender_id
         FROM campaigns c WHERE c.id = $1`, [campaignId]);
    if (!campaign) return;

    // Paused or cancelled between batches: stop, leaving the remaining
    // recipients pending so a resume picks up exactly where this left off.
    if (campaign.status !== 'sending') {
      log.info('campaign is not sending; stopping', {
        campaign: campaign.name, status: campaign.status,
      });
      return;
    }

    const blocks: Block[] = [];
    for (const raw of Array.isArray(campaign.blocks) ? campaign.blocks : []) {
      const parsed = BlockSchema.safeParse(raw);
      if (parsed.success) blocks.push(parsed.data);
    }

    const footer = await footerFor(campaign.organization_id);
    const sender = await queryOne<{
      name: string; email: string; mobile_phone: string | null; booking_url: string | null;
    }>(
      `SELECT u.name, u.email, p.mobile_phone, p.booking_url
         FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.id = $1`, [campaign.sender_id]);

    const { rows: batch } = await query<{
      id: string; customer_id: string; address: string;
      first_name: string; last_name: string;
      portal_reference: string | null; maturity_date: string | null;
      stage_label: string | null; amount_requested: string | null;
      property_city: string | null; property_province: string | null;
      closing_date: string | null; days_to_close: number | null;
      days_to_maturity: number | null; organization_name: string;
    }>(
      `SELECT cr.id, cr.customer_id, cr.address, c.first_name, c.last_name,
              app.portal_reference, app.amount_requested, app.property_city,
              app.property_province, app.closing_date,
              (app.closing_date - CURRENT_DATE) AS days_to_close,
              ren.maturity_date, (ren.maturity_date - CURRENT_DATE) AS days_to_maturity,
              ps.label AS stage_label, o.name AS organization_name
         FROM campaign_recipients cr
         JOIN customers c ON c.id = cr.customer_id
         JOIN organizations o ON o.id = c.organization_id
         LEFT JOIN LATERAL (SELECT a.* FROM applications a WHERE a.customer_id = c.id
                             ORDER BY a.created_at DESC LIMIT 1) app ON TRUE
         LEFT JOIN LATERAL (SELECT r.* FROM renewal_records r WHERE r.customer_id = c.id
                             AND r.status IN ('upcoming','engaged','in_progress')
                             ORDER BY r.maturity_date LIMIT 1) ren ON TRUE
         LEFT JOIN pipeline_stages ps
                ON ps.organization_id = c.organization_id AND ps.key = app.stage_key
        WHERE cr.campaign_id = $1 AND cr.status = 'pending'
        ORDER BY cr.id
        LIMIT $2`,
      [campaign.id, Math.max(1, campaign.throttle_per_minute)]);

    if (!batch.length) {
      await query(
        `UPDATE campaigns SET status = 'completed', send_finished_at = now() WHERE id = $1`,
        [campaign.id]);
      log.info('campaign finished', { campaign: campaign.name });
      return;
    }

    for (const recipient of batch) {
      const values: Record<string, unknown> = {
        ...recipient,
        user_name: sender?.name,
        user_first_name: sender?.name?.split(' ')[0],
        user_cell: sender?.mobile_phone,
        schedule_link: sender?.booking_url,
        organization_name: recipient.organization_name,
      };

      const rendered: { text: string; html?: string } = campaign.channel === 'sms'
        ? renderSms(blocks, { values }, { purpose: campaign.purpose })
        : renderCampaign(blocks, { values }, {
          // Each recipient's own unsubscribe link. A commercial message whose
          // unsubscribe does not work is worse than one with none, and the
          // token is signed rather than stored so it cannot be guessed from
          // somebody else's.
          ...footer,
          unsubscribeUrl: unsubscribeUrl(campaign.organization_id, recipient.customer_id),
        }, {
          channel: 'email', purpose: campaign.purpose, preheader: campaign.preheader,
        });

      // The subject goes through the same renderer as the body. It was not,
      // once, and a campaign went out with "{first_name}, your mortgage
      // matures soon" in the most visible line of the email.
      const subject = campaign.subject
        ? renderTemplate(campaign.subject, { values })
        : null;
      if (campaign.channel === 'email' && subject?.empty) {
        await query(
          `UPDATE campaign_recipients
              SET status = 'suppressed',
                  suppress_reason = $2
            WHERE id = $1`,
          [recipient.id,
           `The subject line needs ${subject.missing.join(', ')}, which this client has no `
           + 'value for. Sending it with the placeholder showing would be worse.']);
        continue;
      }

      if (!rendered.text.trim()) {
        // Nothing survived the merge for this person: the drop rule removed
        // every line. Sending an empty message is worse than not sending.
        await query(
          `UPDATE campaign_recipients
              SET status = 'suppressed',
                  suppress_reason = 'Nothing left to send once the missing details were dropped.'
            WHERE id = $1`, [recipient.id]);
        continue;
      }

      // The gate runs again here. Somebody who unsubscribed since the
      // audience was frozen must not receive this.
      const outcome = await send({
        organizationId: campaign.organization_id,
        customerId: recipient.customer_id,
        channel: campaign.channel,
        purpose: campaign.purpose,
        subject: subject?.text ?? undefined,
        bodyText: rendered.text,
        bodyHtml: rendered.html,
        origin: 'campaign',
        campaignId: campaign.id,
        sentBy: campaign.sender_id ?? undefined,
        dedupeKey: `campaign:${campaign.id}:${recipient.customer_id}`,
      });

      await query(
        `UPDATE campaign_recipients
            SET status = $2, message_id = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() END,
                suppress_reason = CASE WHEN $2 = 'suppressed' THEN $4 ELSE suppress_reason END,
                failure_reason = CASE WHEN $2 = 'failed' THEN $4 ELSE failure_reason END
          WHERE id = $1`,
        [recipient.id,
         outcome.ok ? 'sent' : outcome.status === 'suppressed' ? 'suppressed' : 'failed',
         outcome.messageId ?? null,
         outcome.decision?.reason ?? outcome.error ?? null]);
    }

    log.info('campaign batch sent', { campaign: campaign.name, count: batch.length });

    // The next batch, a minute out. Re-queued rather than looped so a deploy
    // in the middle of a large send loses nothing.
    await enqueue('campaign.send', { campaignId: campaign.id }, {
      organizationId: campaign.organization_id,
      runAfter: new Date(Date.now() + BATCH_SECONDS * 1000),
      dedupeKey: `campaign.send:${campaign.id}:${Date.now()}`,
    });
  });
}
