/**
 * Campaigns: building the audience, and sending to it.
 *
 * THE AUDIENCE IS BUILT THROUGH THE SAME GATE EVERY OTHER SEND USES. Not a
 * similar check written for bulk — the same `evaluateSend` function, fed by
 * one query instead of three per person. A consent rule that lives in the
 * campaign screen and not in the gate is a rule the gate will break, and a
 * bulk path with its own consent logic is the most likely place in a CRM for
 * a CASL problem to originate.
 *
 * So this module does the set arithmetic and delegates every decision:
 *
 *   one query  → segment matches, with their consents and suppressions
 *   per person → evaluateSend, exactly as a single send would
 *   result     → a recipient row per person, INCLUDING the suppressed ones
 *
 * Suppressed recipients are rows, not absences. "Who did this go to" and
 * "why did this client not get it" are both questions with answers six
 * months later, and an absent row answers neither.
 */
import { query, queryOne, withTransaction } from '../db/pool.ts';
import {
  evaluateSend, type ConsentRecord, type ConsentRules, type SuppressionRecord,
} from '../domain/consent.ts';
import { buildSegment, type AudienceCount, type Segment } from '../domain/segment.ts';
import { loadSettings } from './messaging.ts';

/**
 * The FROM and JOINs a segment's fields are written against.
 *
 * One customer per row even when they have several applications: a campaign
 * sends to a person, not to a file, and a client with three applications
 * receiving three copies is the bug this DISTINCT ON prevents.
 */
const AUDIENCE_FROM = `
  FROM customers c
  LEFT JOIN LATERAL (
    SELECT a.* FROM applications a
     WHERE a.customer_id = c.id
     -- The file still in play first, judged by what its stage means rather
     -- than by its key, so a renamed or added stage is not misread.
     ORDER BY COALESCE((SELECT s.category NOT IN ('won','lost') FROM pipeline_stages s
                         WHERE s.organization_id = a.organization_id AND s.key = a.stage_key), true) DESC,
              a.created_at DESC
     LIMIT 1
  ) app ON TRUE
  LEFT JOIN pipeline_stages ps
         ON ps.organization_id = c.organization_id AND ps.key = app.stage_key
  LEFT JOIN pipelines pl ON pl.id = app.pipeline_id
  LEFT JOIN LATERAL (
    SELECT r.* FROM renewal_records r
     WHERE r.customer_id = c.id AND r.status IN ('upcoming','engaged','in_progress')
     ORDER BY r.maturity_date LIMIT 1
  ) ren ON TRUE
  LEFT JOIN LATERAL (
    SELECT f.confirmed FROM funding_records f
     JOIN applications fa ON fa.id = f.application_id
    WHERE fa.customer_id = c.id AND f.confirmed LIMIT 1
  ) fund ON TRUE
  LEFT JOIN LATERAL (
    SELECT asg.user_id FROM assignments asg
     WHERE asg.application_id = app.id AND asg.role = 'broker' AND asg.unassigned_at IS NULL
     ORDER BY asg.is_primary DESC LIMIT 1
  ) assign ON TRUE`;

export type AudienceMember = {
  customer_id: string;
  first_name: string;
  last_name: string;
  address: string | null;
  allowed: boolean;
  code: string;
  reason: string;
};

export type Audience = {
  members: AudienceMember[];
  count: AudienceCount;
};

/**
 * Who this campaign would go to, and who it would not, with the reason.
 *
 * `limit` caps how many members come back for the preview; the counts are
 * always for the whole audience, because a preview that shows fifty people
 * and a count of fifty when the real audience is four thousand is worse than
 * no preview.
 */
export async function buildAudience(
  organizationId: string,
  segment: Segment,
  channel: 'email' | 'sms',
  purpose: 'marketing' | 'service' | 'transactional',
  options: { limit?: number } = {},
): Promise<Audience> {
  const settings = await loadSettings(organizationId);
  const built = buildSegment(segment, 1);

  const { rows } = await query<{
    id: string; first_name: string; last_name: string;
    email: string | null; phone_e164: string | null; merged_into_id: string | null;
    consents: ConsentRecord[]; suppressions: SuppressionRecord[];
  }>(
    `SELECT DISTINCT ON (c.id)
            c.id, c.first_name, c.last_name, c.email, c.phone_e164, c.merged_into_id,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'channel', k.channel, 'purpose', k.purpose, 'basis', k.basis,
                        'granted', k.granted, 'collected_at', k.collected_at,
                        'expires_at', k.expires_at))
                        FROM consents k
                       WHERE k.customer_id = c.id
                          OR k.customer_id IN (SELECT m.id FROM customers m WHERE m.merged_into_id = c.id)),
                     '[]'::jsonb) AS consents,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'channel', s.channel, 'scope', s.scope, 'reason', s.reason,
                        'address', s.address, 'removed_at', s.removed_at))
                        FROM suppressions s
                       WHERE s.organization_id = c.organization_id
                         AND (s.customer_id = c.id
                              OR lower(s.address) = lower(COALESCE(c.email, c.phone_e164, '')))
                     ), '[]'::jsonb) AS suppressions
       ${AUDIENCE_FROM}
      WHERE c.organization_id = $1 AND c.merged_into_id IS NULL AND ${built.where}
      ORDER BY c.id`,
    [organizationId, ...built.params],
  );

  const members: AudienceMember[] = rows.map((row) => {
    const address = channel === 'email' ? row.email : row.phone_e164;
    const decision = evaluateSend({
      channel, purpose, address,
      consents: row.consents ?? [],
      suppressions: row.suppressions ?? [],
      mergedInto: row.merged_into_id,
      rules: settings.consentRules as ConsentRules,
    });
    return {
      customer_id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      address,
      allowed: decision.allowed,
      code: decision.code,
      reason: decision.reason,
    };
  });

  return { members: options.limit ? members.slice(0, options.limit) : members,
           count: countAudience(members) };
}

/** The counts, grouped by the reason people are held back. */
export function countAudience(members: AudienceMember[]): AudienceCount {
  const byReason = new Map<string, number>();
  let sendable = 0;
  for (const member of members) {
    if (member.allowed) { sendable++; continue; }
    const phrase = phraseFor(member);
    byReason.set(phrase, (byReason.get(phrase) ?? 0) + 1);
  }
  return {
    matched: members.length,
    sendable,
    suppressed: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * The gate's codes, in the words a person would use.
 *
 * Kept in step with `evaluateSend`'s actual codes — an earlier version of
 * this listed codes the gate has never emitted, so three real refusals were
 * all grouped under "cannot be sent this" and the screen said nothing useful
 * about any of them.
 */
const REASON_PHRASES: Record<string, string> = {
  no_address: 'have no address on file',
  no_consent: 'have no consent for this',
  implied_expired: 'have an implied consent that has lapsed',
  express_required: 'need express consent for this channel',
  consent_withdrawn: 'have withdrawn consent',
  customer_merged: 'were merged into another record',
};

/**
 * `suppressed` covers several different things — an unsubscribe, a texted
 * STOP, a hard bounce, a complaint — and grouping them tells a brokerage
 * nothing. The reason text names which, so it is read rather than the code.
 */
function phraseFor(member: AudienceMember): string {
  if (member.code !== 'suppressed') {
    return REASON_PHRASES[member.code] ?? 'cannot be sent this';
  }
  const reason = member.reason.toLowerCase();
  if (reason.includes('stop')) return 'texted STOP';
  if (reason.includes('bounce')) return 'have an address that bounced';
  if (reason.includes('complaint')) return 'reported a previous message as spam';
  if (reason.includes('unsubscribed')) return 'have unsubscribed';
  return 'are suppressed';
}

/**
 * Freeze the audience onto the campaign.
 *
 * Written as rows before a single message is sent, so the send is a matter
 * of walking a list rather than re-evaluating a segment that is moving under
 * it. A segment re-run tomorrow gives a different answer; "who did this go
 * to" has exactly one correct answer, and this is where it is recorded.
 */
export async function freezeAudience(
  campaignId: string,
  organizationId: string,
  segment: Segment,
  channel: 'email' | 'sms',
  purpose: 'marketing' | 'service' | 'transactional',
): Promise<AudienceCount> {
  const audience = await buildAudience(organizationId, segment, channel, purpose);

  await withTransaction(async (client) => {
    await client.query('DELETE FROM campaign_recipients WHERE campaign_id = $1', [campaignId]);
    // One statement rather than a round trip per recipient: an audience of
    // four thousand is four thousand round trips otherwise.
    if (audience.members.length) {
      await client.query(
        `INSERT INTO campaign_recipients (campaign_id, customer_id, address, status,
                                          suppress_reason)
         SELECT $1, v.customer_id::uuid, v.address, v.status, v.suppress_reason
           FROM (SELECT unnest($2::uuid[]) AS customer_id,
                        unnest($3::text[]) AS address,
                        unnest($4::text[]) AS status,
                        unnest($5::text[]) AS suppress_reason) v
         ON CONFLICT (campaign_id, customer_id) DO NOTHING`,
        [
          campaignId,
          audience.members.map((m) => m.customer_id),
          audience.members.map((m) => m.address ?? ''),
          audience.members.map((m) => (m.allowed ? 'pending' : 'suppressed')),
          audience.members.map((m) => (m.allowed ? null : m.reason)),
        ],
      );
    }
    await client.query(
      `UPDATE campaigns SET audience_snapshot = $2::jsonb WHERE id = $1`,
      [campaignId, JSON.stringify({ ...audience.count, frozen_at: new Date().toISOString() })],
    );
  });

  return audience.count;
}

/** What the campaign has actually done, read back from the recipient rows. */
export async function campaignResults(campaignId: string): Promise<{
  counts: Record<string, number>;
  suppressed_by_reason: Array<{ reason: string; count: number }>;
  attributions: Array<{ outcome: string; count: number; value: string | null }>;
}> {
  const [counts, reasons, attributions] = await Promise.all([
    queryOne<Record<string, number>>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status = 'suppressed')::int AS suppressed,
              count(*) FILTER (WHERE status IN ('sent','delivered','opened','clicked'))::int AS sent,
              count(*) FILTER (WHERE status IN ('delivered','opened','clicked'))::int AS delivered,
              count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
              count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked,
              count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
              count(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed,
              count(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM campaign_recipients WHERE campaign_id = $1`, [campaignId]),
    query<{ reason: string; count: number }>(
      `SELECT COALESCE(suppress_reason, 'No reason recorded') AS reason, count(*)::int AS count
         FROM campaign_recipients
        WHERE campaign_id = $1 AND status = 'suppressed'
        GROUP BY 1 ORDER BY 2 DESC`, [campaignId]),
    // The outcomes, which is what the reporting leads with. An open is a weak
    // signal; an attributed application is not.
    query<{ outcome: string; count: number; value: string | null }>(
      `SELECT outcome, count(*)::int AS count, sum(value_amount)::text AS value
         FROM campaign_attributions WHERE campaign_id = $1
        GROUP BY outcome ORDER BY outcome`, [campaignId]),
  ]);

  return {
    counts: counts ?? {},
    suppressed_by_reason: reasons.rows,
    attributions: attributions.rows,
  };
}
