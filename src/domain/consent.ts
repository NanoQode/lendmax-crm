/**
 * The send gate.
 *
 * Every outbound email and SMS in this system — manual, automated, campaign —
 * passes through `evaluateSend`. There is no second path. That is the point:
 * a consent rule that lives in the campaign screen and not in the automation
 * engine is a rule that will be broken by the automation engine.
 *
 * WHAT IS STRUCTURE AND WHAT IS CONFIGURATION
 *
 * Structure (here, in code): that consent has a basis and a scope; that an
 * express basis does not expire and an implied one does; that a withdrawal
 * beats a grant regardless of dates; that transactional messages about a
 * mortgage the client asked us to arrange are not commercial electronic
 * messages and are not suppressed by a marketing unsubscribe; that a hard
 * bounce stops everything on that address.
 *
 * Configuration (passed in, sourced and dated): how long an implied basis
 * lasts, whether SMS marketing requires express consent in all cases, which
 * keywords mean stop. These are CASL and CRTC questions with dated answers,
 * verified by a person. They are not constants compiled into this file.
 *
 * THE DECISION IS ALWAYS RECORDED. `evaluateSend` returns a reason whether it
 * allows or refuses, and the caller writes it onto the message. Six months
 * later, "why did this client not get the renewal letter" has an answer that
 * does not require re-deriving anything.
 */

export type Channel = 'email' | 'sms';
export type Purpose = 'transactional' | 'marketing' | 'service';

export type ConsentRecord = {
  channel: Channel | 'phone' | 'mail' | 'any';
  purpose: 'transactional' | 'marketing' | 'credit_check' | 'service';
  basis: 'express' | 'implied' | 'withdrawn';
  granted: boolean;
  collected_at: Date | string;
  expires_at?: Date | string | null;
};

export type SuppressionRecord = {
  channel: Channel;
  scope: 'marketing' | 'all';
  reason: string;
  address?: string | null;
  removed_at?: Date | string | null;
};

export type ConsentRules = {
  /** How long an implied basis is treated as live. CASL-shaped, configured. */
  impliedConsentMonths: number;
  /** Whether a marketing SMS requires an express basis (implied is not enough). */
  smsMarketingRequiresExpress: boolean;
  /** Inbound words that mean stop. Lower-cased, compared whole. */
  stopKeywords: string[];
  /** Inbound words that mean resume. */
  startKeywords: string[];
  /**
   * Whether an unsubscribe from marketing email also stops marketing SMS.
   * A brokerage decision with a compliance dimension, so it is a setting with
   * a documented answer rather than an assumption.
   */
  unsubscribeAppliesAcrossChannels: boolean;
};

export const DEFAULT_CONSENT_RULES: ConsentRules = {
  impliedConsentMonths: 24,
  smsMarketingRequiresExpress: true,
  stopKeywords: ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'arret', 'arrêt'],
  startKeywords: ['start', 'unstop', 'yes', 'subscribe'],
  unsubscribeAppliesAcrossChannels: false,
};

export type SendDecision = {
  allowed: boolean;
  /** A stable code, for filtering and metrics. */
  code:
    | 'allowed_transactional'
    | 'allowed_express'
    | 'allowed_implied'
    | 'no_address'
    | 'consent_withdrawn'
    | 'no_consent'
    | 'implied_expired'
    | 'express_required'
    | 'suppressed'
    | 'hard_bounce'
    | 'customer_merged';
  /** A sentence, for the message record and the screen. */
  reason: string;
  /** Which consent record carried the decision, when one did. */
  basis?: 'express' | 'implied' | 'transactional';
  expiresAt?: string | null;
};

const asDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const addMonthsTo = (d: Date, months: number): Date => {
  const out = new Date(d.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
};

/**
 * The newest consent record for a channel and purpose.
 *
 * "Newest" is by collection time, not insertion order: a consent imported from
 * the portal after a later CRM withdrawal must not win because it was written
 * to the table second.
 */
export function currentConsent(
  consents: ConsentRecord[],
  channel: Channel,
  purpose: Purpose,
): ConsentRecord | null {
  const relevant = consents
    .filter((c) => c.channel === channel || c.channel === 'any')
    .filter((c) => c.purpose === purpose)
    .map((c) => ({ c, at: asDate(c.collected_at) }))
    .filter((x): x is { c: ConsentRecord; at: Date } => x.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  return relevant[0]?.c ?? null;
}

export type SendContext = {
  channel: Channel;
  purpose: Purpose;
  address: string | null | undefined;
  consents: ConsentRecord[];
  suppressions: SuppressionRecord[];
  rules?: ConsentRules;
  now?: Date;
  /** Set when the customer record has been merged away. */
  mergedInto?: string | null;
};

export function evaluateSend(ctx: SendContext): SendDecision {
  const rules = ctx.rules ?? DEFAULT_CONSENT_RULES;
  const now = ctx.now ?? new Date();

  if (!ctx.address || !String(ctx.address).trim()) {
    return { allowed: false, code: 'no_address', reason: `No ${ctx.channel} address on file.` };
  }
  if (ctx.mergedInto) {
    return {
      allowed: false,
      code: 'customer_merged',
      reason: 'This record was merged into another customer; send from the surviving record.',
    };
  }

  const live = ctx.suppressions.filter((s) => !asDate(s.removed_at));

  // A hard bounce or a complaint stops everything on this address, including
  // transactional mail. Continuing to send to an address that is bouncing is
  // how a sending domain's reputation is destroyed, and the client is not
  // receiving it either way.
  const hard = live.find(
    (s) => s.channel === ctx.channel && s.scope === 'all',
  );
  if (hard) {
    const isBounce = hard.reason === 'hard_bounce' || hard.reason === 'complaint' || hard.reason === 'invalid';
    return {
      allowed: false,
      code: isBounce ? 'hard_bounce' : 'suppressed',
      reason: isBounce
        ? `This ${ctx.channel} address is suppressed (${hard.reason.replace('_', ' ')}). Confirm a working address before sending.`
        : `This ${ctx.channel} address is suppressed (${hard.reason.replace('_', ' ')}).`,
    };
  }

  // Transactional messages are about the mortgage the client asked us to
  // arrange. A marketing unsubscribe does not stop them, and treating it as
  // though it did means a client who opted out of the newsletter stops being
  // told their conditions are outstanding.
  if (ctx.purpose === 'transactional') {
    const withdrawn = currentConsent(ctx.consents, ctx.channel, 'transactional');
    if (withdrawn && (withdrawn.basis === 'withdrawn' || !withdrawn.granted)) {
      return {
        allowed: false,
        code: 'consent_withdrawn',
        reason: `The client asked not to be contacted by ${ctx.channel} about this application.`,
      };
    }
    return {
      allowed: true,
      code: 'allowed_transactional',
      basis: 'transactional',
      reason: 'Transactional message about the client’s own application.',
    };
  }

  // Everything else is commercial or service content and needs a basis.
  const marketingSuppressed = live.find(
    (s) => s.scope === 'marketing' &&
      (s.channel === ctx.channel ||
        (rules.unsubscribeAppliesAcrossChannels && s.channel !== ctx.channel)),
  );
  if (marketingSuppressed) {
    return {
      allowed: false,
      code: 'suppressed',
      reason:
        marketingSuppressed.reason === 'stop_keyword'
          ? 'The client texted STOP.'
          : `The client unsubscribed from marketing (${marketingSuppressed.reason.replace('_', ' ')}).`,
    };
  }

  const consent = currentConsent(ctx.consents, ctx.channel, ctx.purpose);
  if (!consent || !consent.granted || consent.basis === 'withdrawn') {
    return {
      allowed: false,
      code: consent && consent.basis === 'withdrawn' ? 'consent_withdrawn' : 'no_consent',
      reason: consent && consent.basis === 'withdrawn'
        ? `The client withdrew consent for ${ctx.purpose} ${ctx.channel}.`
        : `No ${ctx.purpose} consent on file for ${ctx.channel}.`,
    };
  }

  if (consent.basis === 'express') {
    // An express basis does not expire on its own. An explicit expiry on the
    // record is still honoured — some are collected with one.
    const explicit = asDate(consent.expires_at ?? null);
    if (explicit && explicit.getTime() <= now.getTime()) {
      return {
        allowed: false,
        code: 'implied_expired',
        reason: `Express consent recorded with an expiry of ${explicit.toISOString().slice(0, 10)}, which has passed.`,
      };
    }
    return {
      allowed: true,
      code: 'allowed_express',
      basis: 'express',
      reason: 'Express consent on file.',
      expiresAt: explicit ? explicit.toISOString() : null,
    };
  }

  // Implied.
  if (ctx.channel === 'sms' && ctx.purpose === 'marketing' && rules.smsMarketingRequiresExpress) {
    return {
      allowed: false,
      code: 'express_required',
      reason: 'Marketing SMS requires express consent; only an implied basis is on file.',
    };
  }
  const collected = asDate(consent.collected_at);
  if (!collected) {
    return {
      allowed: false,
      code: 'no_consent',
      reason: 'Implied consent on file has no collection date, so its expiry cannot be established.',
    };
  }
  const expiry = asDate(consent.expires_at ?? null) ?? addMonthsTo(collected, rules.impliedConsentMonths);
  if (expiry.getTime() <= now.getTime()) {
    return {
      allowed: false,
      code: 'implied_expired',
      reason: `Implied consent lapsed on ${expiry.toISOString().slice(0, 10)}.`,
    };
  }
  return {
    allowed: true,
    code: 'allowed_implied',
    basis: 'implied',
    reason: `Implied consent, valid until ${expiry.toISOString().slice(0, 10)}.`,
    expiresAt: expiry.toISOString(),
  };
}

/**
 * Classify an inbound SMS body as an opt-out, an opt-in, or neither.
 *
 * Deliberately strict: the whole message must be the keyword, ignoring case,
 * punctuation and surrounding whitespace. A client who writes "please stop by
 * the office tomorrow" has not unsubscribed, and treating that as an opt-out
 * silently ends the brokerage's ability to reach them.
 */
export function classifyInboundKeyword(
  body: string | null | undefined,
  rules: ConsentRules = DEFAULT_CONSENT_RULES,
): 'stop' | 'start' | null {
  if (!body) return null;
  const normalised = body.trim().toLowerCase().replace(/[.!,;:'"]+$/g, '').trim();
  if (!normalised || normalised.includes(' ')) return null;
  if (rules.stopKeywords.includes(normalised)) return 'stop';
  if (rules.startKeywords.includes(normalised)) return 'start';
  return null;
}

/** The audience arithmetic a campaign screen must show rather than hide. */
export type AudienceBreakdown = {
  matched: number;
  eligible: number;
  suppressed: number;
  byReason: Record<string, number>;
};

export function summariseAudience(decisions: SendDecision[]): AudienceBreakdown {
  const byReason: Record<string, number> = {};
  let eligible = 0;
  for (const d of decisions) {
    if (d.allowed) eligible++;
    else byReason[d.code] = (byReason[d.code] ?? 0) + 1;
  }
  return {
    matched: decisions.length,
    eligible,
    suppressed: decisions.length - eligible,
    byReason,
  };
}
