/**
 * The unsubscribe link.
 *
 * A commercial message whose unsubscribe does not work is worse than one
 * with none: it is a promise the brokerage made in writing and did not keep,
 * and it is the single most reliable way to turn an annoyed recipient into a
 * complaint.
 *
 * The token is SIGNED, NOT STORED. A random token in a table would need a
 * row per recipient per campaign, would have to survive the campaign being
 * deleted, and would still be guessable if it were short. An HMAC of the
 * customer id keyed on the server's own secret is none of those things: it
 * cannot be forged, it needs no storage, and it stays valid for as long as
 * the client keeps the email — which is exactly how long it must.
 *
 * It carries no expiry for that reason. An unsubscribe link that has expired
 * is an unsubscribe link that does not work.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.ts';

const PURPOSE = 'unsubscribe';

function sign(organizationId: string, customerId: string): string {
  return createHmac('sha256', env.SESSION_SECRET)
    .update(`${PURPOSE}:${organizationId}:${customerId}`)
    .digest('base64url')
    .slice(0, 32);
}

export function unsubscribeToken(organizationId: string, customerId: string): string {
  return `${customerId}.${sign(organizationId, customerId)}`;
}

export function unsubscribeUrl(organizationId: string, customerId: string): string {
  return `${env.PUBLIC_URL}/u/${unsubscribeToken(organizationId, customerId)}`;
}

/** The customer a token belongs to, or null if it was not issued by us. */
export function verifyUnsubscribeToken(
  token: string,
  organizationId: string,
): string | null {
  const [customerId, signature] = token.split('.');
  if (!customerId || !signature) return null;
  const expected = sign(organizationId, customerId);
  if (signature.length !== expected.length) return null;
  // Compared in constant time: a length-leaking comparison on a token that
  // identifies a person is worth avoiding even when the payoff is small.
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return customerId;
}
