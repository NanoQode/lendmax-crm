/**
 * Sending.
 *
 * One function, `send`, and no second path. Manual, automated and campaign
 * messages all come through here, because a consent rule that lives in the
 * campaign screen and not in the automation engine is a rule the automation
 * engine will break.
 *
 * What it does, in order:
 *   1. resolve the recipient and their consent state
 *   2. run the gate (src/domain/consent.ts) and record its decision either way
 *   3. respect quiet hours for anything that is not urgent
 *   4. write the message row BEFORE calling the provider
 *   5. call the provider, and record what it said
 *
 * Step 4 is the one that matters. A provider call that succeeds and then
 * crashes before the row is written is a client who was texted with no record
 * of it — which is worse than a row marked `sending` that a person can look at.
 */
import { randomUUID } from 'node:crypto';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import { log } from '../lib/logger.ts';
import {
  classifyInboundKeyword, evaluateSend, type Channel, type ConsentRecord, type ConsentRules,
  type Purpose, type SendDecision, type SuppressionRecord, DEFAULT_CONSENT_RULES,
} from '../domain/consent.ts';
import {
  isWithinQuietHours, nextSendableTime, type QuietHours, DEFAULT_QUIET_HOURS,
} from '../domain/dates.ts';
import { env } from '../config/env.ts';
import { sendEmail } from '../integrations/email.ts';
import { measureSegments, sendSms } from '../integrations/voipms.ts';
import { enqueue } from '../jobs/queue.ts';

export type SendInput = {
  organizationId: string;
  customerId: string;
  applicationId?: string | null;
  channel: Channel;
  purpose: Purpose;
  subject?: string;
  bodyText: string;
  bodyHtml?: string;
  /** manual | automation | campaign | system */
  origin?: 'manual' | 'automation' | 'campaign' | 'system';
  sentBy?: string | null;
  templateKey?: string | null;
  campaignId?: string | null;
  automationRunId?: string | null;
  mergeSnapshot?: Record<string, unknown>;
  /** Idempotency across retries and duplicate webhooks. */
  dedupeKey?: string;
  /**
   * Bypass quiet hours. For operational messages a person is waiting on — a
   * document link they asked for while on the phone. Never for marketing.
   */
  urgent?: boolean;
  /** Queue it rather than sending now. */
  scheduledFor?: Date;
};

export type SendOutcome = {
  ok: boolean;
  messageId?: string;
  status: 'sent' | 'queued' | 'scheduled' | 'suppressed' | 'failed';
  decision: SendDecision;
  error?: string;
  /** For SMS, so the composer can report what it cost. */
  segments?: number;
};

export async function loadSettings(organizationId: string): Promise<{
  consentRules: ConsentRules; quietHours: QuietHours; timezone: string;
}> {
  const { rows } = await query<{ key: string; value: Record<string, unknown> }>(
    `SELECT DISTINCT ON (key) key, value FROM settings
      WHERE organization_id = $1 AND key IN ('consent_rules','quiet_hours')
        AND effective_from <= CURRENT_DATE
      ORDER BY key, effective_from DESC`,
    [organizationId],
  );
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const org = await queryOne<{ timezone: string }>(
    'SELECT timezone FROM organizations WHERE id = $1', [organizationId],
  );
  return {
    consentRules: { ...DEFAULT_CONSENT_RULES, ...(byKey.get('consent_rules') ?? {}) } as ConsentRules,
    quietHours: { ...DEFAULT_QUIET_HOURS, ...(byKey.get('quiet_hours') ?? {}) } as QuietHours,
    timezone: org?.timezone ?? env.BROKERAGE_TIMEZONE,
  };
}

/**
 * Decide whether this message may go, without sending it.
 *
 * Exported so the campaign audience screen can show the arithmetic — matched,
 * eligible, suppressed and why — using exactly the logic that will run at send
 * time rather than an approximation of it.
 */
export async function gateFor(
  organizationId: string,
  customerId: string,
  channel: Channel,
  purpose: Purpose,
  rules?: ConsentRules,
): Promise<{ decision: SendDecision; address: string | null }> {
  const customer = await queryOne<{
    email: string | null; phone_e164: string | null; merged_into_id: string | null;
  }>(
    'SELECT email, phone_e164, merged_into_id FROM customers WHERE id = $1 AND organization_id = $2',
    [customerId, organizationId],
  );
  if (!customer) {
    return {
      address: null,
      decision: { allowed: false, code: 'no_address', reason: 'That customer does not exist.' },
    };
  }

  const address = channel === 'email' ? customer.email : customer.phone_e164;

  const [consents, suppressions] = await Promise.all([
    query<ConsentRecord>(
      `SELECT channel, purpose, basis, granted, collected_at, expires_at
         FROM consents WHERE customer_id = $1`,
      [customerId],
    ),
    query<SuppressionRecord>(
      `SELECT channel, scope, reason, address, removed_at FROM suppressions
        WHERE organization_id = $1 AND (customer_id = $2 OR lower(address) = lower($3))`,
      [organizationId, customerId, address ?? ''],
    ),
  ]);

  const consentRules = rules ?? (await loadSettings(organizationId)).consentRules;

  return {
    address,
    decision: evaluateSend({
      channel, purpose, address,
      consents: consents.rows,
      suppressions: suppressions.rows,
      rules: consentRules,
      mergedInto: customer.merged_into_id,
    }),
  };
}

export async function send(input: SendInput): Promise<SendOutcome> {
  const { organizationId, customerId, channel, purpose } = input;
  const settings = await loadSettings(organizationId);
  const { decision, address } = await gateFor(
    organizationId, customerId, channel, purpose, settings.consentRules,
  );

  // A refused send is still recorded. "Why did this client not get the renewal
  // letter" needs an answer six months later, and an absent row is not one.
  if (!decision.allowed) {
    const messageId = await recordMessage(input, {
      address: address ?? '(none)', status: 'suppressed', decision,
    });
    return { ok: false, messageId, status: 'suppressed', decision, error: decision.reason };
  }

  // Quiet hours. Marketing never overrides them; operational messages may,
  // and say so by setting `urgent`.
  const now = new Date();
  const mustWait =
    !input.urgent &&
    purpose !== 'transactional' &&
    isWithinQuietHours(now, settings.timezone, settings.quietHours);

  const scheduledFor = input.scheduledFor
    ?? (mustWait ? nextSendableTime(now, settings.timezone, settings.quietHours) : null);

  if (scheduledFor && scheduledFor.getTime() > now.getTime() + 30_000) {
    const messageId = await recordMessage(input, {
      address: address!, status: 'scheduled', decision, scheduledFor,
    });
    await enqueue('message.send', { messageId }, {
      organizationId,
      runAfter: scheduledFor,
      dedupeKey: `message.send:${messageId}`,
    });
    return { ok: true, messageId, status: 'scheduled', decision };
  }

  const messageId = await recordMessage(input, { address: address!, status: 'sending', decision });
  if (!messageId) {
    // A duplicate dedupe key. Somebody already sent this.
    return {
      ok: true, status: 'sent', decision,
      error: 'An identical message was already sent; this one was not sent again.',
    };
  }
  return deliver(messageId);
}

async function recordMessage(
  input: SendInput,
  extra: {
    address: string; status: string; decision: SendDecision; scheduledFor?: Date;
  },
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO messages
       (organization_id, customer_id, application_id, channel, direction, origin, purpose,
        to_address, subject, body_text, body_html, merge_snapshot, status, scheduled_for,
        gate_decision, template_key, campaign_id, automation_run_id, sent_by, dedupe_key, thread_id)
     VALUES ($1,$2,$3,$4,'outbound',$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,
             $20)
     ON CONFLICT (organization_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      input.organizationId, input.customerId, input.applicationId ?? null,
      input.channel === 'sms' ? 'sms' : 'email', input.origin ?? 'manual', input.purpose,
      extra.address, input.subject ?? null, input.bodyText, input.bodyHtml ?? null,
      JSON.stringify(input.mergeSnapshot ?? {}), extra.status, extra.scheduledFor ?? null,
      JSON.stringify(extra.decision), input.templateKey ?? null, input.campaignId ?? null,
      input.automationRunId ?? null, input.sentBy ?? null, input.dedupeKey ?? null,
      await threadFor(input),
    ],
  );
  return row?.id ?? '';
}

/** One thread per customer per channel, so a conversation stays a conversation. */
async function threadFor(input: SendInput): Promise<string | null> {
  if (input.channel !== 'sms') return null;
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM communication_threads
      WHERE customer_id = $1 AND channel = 'sms' LIMIT 1`,
    [input.customerId],
  );
  if (existing) return existing.id;
  const created = await queryOne<{ id: string }>(
    `INSERT INTO communication_threads (organization_id, customer_id, application_id, channel)
     VALUES ($1,$2,$3,'sms') RETURNING id`,
    [input.organizationId, input.customerId, input.applicationId ?? null],
  );
  return created?.id ?? null;
}

/**
 * Hand one recorded message to its provider.
 *
 * Separate from `send` so the worker can call it for a scheduled or retried
 * message without re-running the gate from scratch — though it does re-check
 * the decision, because consent can have changed between scheduling and
 * sending, and a client who unsubscribed yesterday must not receive a message
 * queued the day before.
 */
export async function deliver(messageId: string): Promise<SendOutcome> {
  const message = await queryOne<{
    id: string; organization_id: string; customer_id: string; channel: string;
    purpose: Purpose; to_address: string; subject: string | null; body_text: string;
    body_html: string | null; status: string; dedupe_key: string | null;
  }>('SELECT * FROM messages WHERE id = $1', [messageId]);

  if (!message) {
    return {
      ok: false, status: 'failed',
      decision: { allowed: false, code: 'no_address', reason: 'No such message.' },
      error: 'No such message.',
    };
  }
  if (message.status === 'sent' || message.status === 'delivered') {
    return {
      ok: true, messageId, status: 'sent',
      decision: { allowed: true, code: 'allowed_transactional', reason: 'Already sent.' },
    };
  }

  // Re-check. A message scheduled yesterday must not go to somebody who
  // unsubscribed this morning.
  const { decision } = await gateFor(
    message.organization_id, message.customer_id,
    message.channel === 'sms' ? 'sms' : 'email', message.purpose,
  );
  if (!decision.allowed) {
    await query(
      `UPDATE messages SET status = 'suppressed', gate_decision = $2::jsonb, failed_at = now(),
                           failure_reason = $3
        WHERE id = $1`,
      [messageId, JSON.stringify(decision), decision.reason],
    );
    return { ok: false, messageId, status: 'suppressed', decision, error: decision.reason };
  }

  const result = message.channel === 'sms'
    ? await sendSms(message.organization_id, { to: message.to_address, body: message.body_text })
    : await sendEmail(message.organization_id, {
        to: message.to_address,
        subject: message.subject ?? '(no subject)',
        text: message.body_text,
        html: message.body_html ?? undefined,
        idempotencyKey: message.dedupe_key ?? messageId,
      });

  const segments = 'segments' in result ? result.segments : undefined;

  if (!result.ok) {
    await query(
      `UPDATE messages SET status = 'failed', failed_at = now(), failure_reason = $2,
                           provider = $3
        WHERE id = $1`,
      [messageId, result.error ?? 'Unknown error',
       'provider' in result ? result.provider : 'voipms'],
    );
    // Only retryable failures go back on the queue. A bad address retried five
    // times is five identical failures and a delayed answer for the person
    // waiting on it.
    if (result.retryable) {
      await enqueue('message.send', { messageId }, {
        organizationId: message.organization_id,
        runAfter: new Date(Date.now() + 60_000),
        dedupeKey: `message.send:${messageId}`,
      });
    }
    return { ok: false, messageId, status: 'failed', decision, error: result.error, segments };
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE messages SET status = 'sent', sent_at = now(), provider = $2,
                           provider_message_id = $3
        WHERE id = $1`,
      [messageId, 'provider' in result ? result.provider : 'voipms',
       result.providerMessageId ?? null],
    );
    await client.query(
      `UPDATE customers SET last_contacted_at = now(), last_outbound_at = now(),
                            awaiting_reply_since = NULL
        WHERE id = $1`,
      [message.customer_id],
    );
    await client.query(
      `UPDATE communication_threads SET last_message_at = now()
        WHERE customer_id = $1 AND channel = $2`,
      [message.customer_id, message.channel === 'sms' ? 'sms' : 'email'],
    );
  });

  return { ok: true, messageId, status: 'sent', decision, segments };
}

/** What an SMS will cost before it is sent. */
export function previewSms(body: string): ReturnType<typeof measureSegments> {
  return measureSegments(body);
}

/**
 * Record an inbound message and attach it to a client.
 *
 * If the number matches more than one customer the message is HELD rather than
 * attached to the likeliest. A stranger's text on somebody's mortgage file is a
 * privacy incident, and guessing is how it happens.
 */
export async function receiveInbound(input: {
  organizationId: string;
  channel: 'sms' | 'mms';
  from: string;
  to: string | null;
  body: string;
  mediaUrls?: string[];
  provider: string;
  providerMessageId: string | null;
  receivedAt?: Date;
}): Promise<{ status: 'attached' | 'held' | 'duplicate'; customerId?: string; messageId?: string }> {
  // The provider delivers the same callback more than once. The external id is
  // what makes processing it idempotent.
  if (input.providerMessageId) {
    const seen = await queryOne<{ id: string }>(
      `SELECT id FROM messages WHERE provider = $1 AND provider_message_id = $2`,
      [input.provider, input.providerMessageId],
    );
    if (seen) return { status: 'duplicate', messageId: seen.id };
  }

  const { rows: matches } = await query<{ id: string }>(
    `SELECT id FROM customers
      WHERE organization_id = $1 AND phone_e164 = $2 AND merged_into_id IS NULL`,
    [input.organizationId, input.from],
  );

  if (matches.length !== 1) {
    await query(
      `INSERT INTO unmatched_messages (organization_id, channel, from_address, to_address, body,
                                       received_at, provider, provider_message_id, reason,
                                       candidate_ids, media)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()),$7,$8,$9,$10,$11::jsonb)`,
      [
        input.organizationId, input.channel, input.from, input.to, input.body,
        input.receivedAt ?? null, input.provider, input.providerMessageId,
        matches.length === 0 ? 'unknown' : 'ambiguous',
        matches.map((m) => m.id), JSON.stringify(input.mediaUrls ?? []),
      ],
    );
    log.warn('inbound message held', {
      reason: matches.length === 0 ? 'unknown number' : 'more than one client on that number',
      candidates: matches.length,
    });
    return { status: 'held' };
  }

  const customerId = matches[0]!.id;
  const messageId = await withTransaction(async (client) => {
    const thread = await client.query<{ id: string }>(
      `INSERT INTO communication_threads (organization_id, customer_id, channel, address)
       SELECT $1,$2,'sms',$3
        WHERE NOT EXISTS (SELECT 1 FROM communication_threads
                           WHERE customer_id = $2 AND channel = 'sms')
       RETURNING id`,
      [input.organizationId, customerId, input.to],
    );
    const threadId = thread.rows[0]?.id ?? (await client.query<{ id: string }>(
      `SELECT id FROM communication_threads WHERE customer_id = $1 AND channel = 'sms' LIMIT 1`,
      [customerId],
    )).rows[0]?.id ?? null;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO messages (organization_id, thread_id, customer_id, channel, direction, origin,
                             purpose, from_address, to_address, body_text, status, provider,
                             provider_message_id, created_at)
       VALUES ($1,$2,$3,$4,'inbound','manual','transactional',$5,$6,$7,'received',$8,$9,
               COALESCE($10::timestamptz, now()))
       RETURNING id`,
      [
        input.organizationId, threadId, customerId, input.channel, input.from, input.to,
        input.body, input.provider, input.providerMessageId, input.receivedAt ?? null,
      ],
    );

    await client.query(
      `UPDATE customers
          SET last_inbound_at = now(),
              -- Set only if nothing is already pending, so the clock runs from
              -- the FIRST unanswered message rather than the most recent one.
              awaiting_reply_since = COALESCE(awaiting_reply_since, now())
        WHERE id = $1`,
      [customerId],
    );
    await client.query(
      `UPDATE communication_threads SET last_message_at = now(), unread_count = unread_count + 1
        WHERE id = $1`,
      [threadId],
    );
    await client.query(
      `INSERT INTO domain_events (organization_id, event_type, customer_id, payload, dedupe_key)
       VALUES ($1,'message.received',$2,$3::jsonb,$4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        input.organizationId, customerId,
        JSON.stringify({ channel: input.channel, preview: input.body.slice(0, 120) }),
        `message.received:${input.provider}:${input.providerMessageId ?? randomUUID()}`,
      ],
    );
    return rows[0]!.id;
  });

  // STOP / START. Handled after the message is stored, so the word the client
  // actually sent is on the file whatever the CRM decided it meant.
  const rules = (await loadSettings(input.organizationId)).consentRules;
  const keyword = classifyInboundKeyword(input.body, rules);
  if (keyword) {
    await applyKeyword(input.organizationId, customerId, input.from, keyword, messageId);
  }

  return { status: 'attached', customerId, messageId };
}

/**
 * A client texting STOP, or START.
 *
 * Two records, not one: a consent row (the evidence — append-only, with the
 * message that carried it) and a suppression row (the fast answer the send
 * gate reads). Deriving the second from the first at send time would mean
 * scanning consent history for every recipient of every campaign.
 *
 * The scope is MARKETING, not everything. A client who stops the newsletter
 * has not asked to stop hearing that their conditions are outstanding, and
 * treating those as the same thing is how somebody misses their own closing.
 */
async function applyKeyword(
  organizationId: string,
  customerId: string,
  address: string,
  keyword: 'stop' | 'start',
  messageId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    if (keyword === 'stop') {
      await client.query(
        `INSERT INTO consents (organization_id, customer_id, channel, purpose, basis, granted,
                               source, source_detail, actor_kind, note)
         VALUES ($1,$2,'sms','marketing','withdrawn',false,'reply_stop',$3,'client',$4)`,
        [organizationId, customerId, messageId, 'The client texted a stop keyword.'],
      );
      await client.query(
        `INSERT INTO suppressions (organization_id, customer_id, address, channel, scope, reason, detail)
         VALUES ($1,$2,$3,'sms','marketing','stop_keyword',$4)
         ON CONFLICT (organization_id, channel, lower(address), scope)
           WHERE removed_at IS NULL DO NOTHING`,
        [organizationId, customerId, address, `Inbound message ${messageId}`],
      );
      // Anything mid-flight that would have texted them is stopped now rather
      // than at its next scheduled step.
      await client.query(
        `UPDATE automation_enrollments e
            SET status = 'stopped', stopped_at = now(), next_run_at = NULL,
                stopped_reason = 'The client texted STOP'
           FROM automations a
          WHERE a.id = e.automation_id AND e.customer_id = $1
            AND e.status IN ('active','paused') AND a.purpose = 'marketing'`,
        [customerId],
      );
      await client.query(
        `UPDATE messages SET status = 'suppressed',
                             failure_reason = 'Cancelled: the client texted STOP'
          WHERE customer_id = $1 AND status = 'scheduled' AND purpose <> 'transactional'`,
        [customerId],
      );
    } else {
      await client.query(
        `INSERT INTO consents (organization_id, customer_id, channel, purpose, basis, granted,
                               source, source_detail, actor_kind, note)
         VALUES ($1,$2,'sms','marketing','express',true,'reply_stop',$3,'client',$4)`,
        [organizationId, customerId, messageId, 'The client texted a start keyword.'],
      );
      await client.query(
        `UPDATE suppressions SET removed_at = now(),
                                 removed_reason = 'The client texted START'
          WHERE organization_id = $1 AND customer_id = $2 AND channel = 'sms'
            AND reason = 'stop_keyword' AND removed_at IS NULL`,
        [organizationId, customerId],
      );
    }

    await client.query(
      `INSERT INTO activity (organization_id, customer_id, kind, actor_kind, actor_name, summary)
       VALUES ($1,$2,'consent','client','Client',$3)`,
      [organizationId, customerId,
       keyword === 'stop'
         ? 'Texted STOP — marketing SMS suppressed'
         : 'Texted START — marketing SMS consent restored'],
    );
  });
  log.info('inbound keyword applied', { customerId, keyword });
}
