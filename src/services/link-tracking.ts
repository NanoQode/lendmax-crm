/**
 * Tracked links for calculators sent to clients.
 *
 * Ali's instruction (answer 29): "Track the url click under the Customer file
 * under log." So a calculator link in a message is not a bare rateshop.ca URL
 * — it is a signed redirect through the CRM that records the click against the
 * customer and then sends them on.
 *
 * Signed, not stored, for the same reasons as the unsubscribe token: no row
 * per recipient per send, nothing to clean up, and unforgeable. The difference
 * is that this token names a calculator as well as a customer, and the
 * signature covers both — otherwise anyone holding one client's link could
 * point it at any URL and have the CRM redirect to it. The destination is
 * additionally looked up in the closed calculator list rather than taken from
 * the link, so even a forged signature cannot turn this into an open redirect.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.ts';
import { calculatorFor, calculatorUrl, findCalculator } from '../domain/calculators.ts';

const PURPOSE = 'calc';

function sign(organizationId: string, customerId: string, slug: string): string {
  return createHmac('sha256', env.SESSION_SECRET)
    .update(`${PURPOSE}:${organizationId}:${customerId}:${slug}`)
    .digest('base64url')
    .slice(0, 32);
}

export function trackedCalculatorUrl(
  organizationId: string,
  customerId: string,
  slug: string,
): string {
  // Throws for an unknown slug rather than producing a link that 404s.
  calculatorUrl(slug);
  const token = `${customerId}.${slug}.${sign(organizationId, customerId, slug)}`;
  return `${env.PUBLIC_URL}/r/${token}`;
}

export type TrackedLink = { customerId: string; slug: string; destination: string };

/** What a token points at, or null if we did not issue it. */
export function verifyTrackedLink(
  token: string,
  organizationId: string,
): TrackedLink | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [customerId, slug, signature] = parts as [string, string, string];
  // The destination comes from our own list, never from the token.
  const calculator = findCalculator(slug);
  if (!calculator) return null;
  const expected = sign(organizationId, customerId, slug);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return { customerId, slug, destination: calculatorUrl(slug) };
}

/**
 * The calculator merge fields for one customer's file.
 *
 * Shared because there are three places a message gets rendered — the
 * automation engine, a broker composing by hand, and a campaign — and the
 * first version of this only wired the engine. A broker who typed
 * {calculator_link} got the whole line dropped, silently and correctly, which
 * is the worst kind of bug: the safety mechanism working perfectly on a value
 * that should never have been missing.
 */
export function calculatorMergeValues(
  organizationId: string,
  customerId: string,
  transactionTypeKey: unknown,
): { calculator_name: string; calculator_link: string | null } {
  const calculator = calculatorFor(
    typeof transactionTypeKey === 'string' ? transactionTypeKey : null,
  );
  return {
    calculator_name: calculator.name,
    calculator_link: customerId
      ? trackedCalculatorUrl(organizationId, customerId, calculator.slug)
      : null,
  };
}
