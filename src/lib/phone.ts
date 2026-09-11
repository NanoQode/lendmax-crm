/**
 * Phone numbers, normalised once.
 *
 * This exists because an inbound SMS arrives as +16475551234 and the client
 * typed (647) 555-1234 into the application. If those two do not resolve to the
 * same string, the message lands on no file — or, worse, the wrong one.
 *
 * Scope is deliberately North American (NANP). Lendmax lends in Canada; a
 * general-purpose international parser would be more code, another dependency,
 * and would still need the NANP rules written out to be correct here.
 */

export type ParsedPhone = {
  ok: boolean;
  e164?: string;
  national?: string;
  areaCode?: string;
  formatted?: string;
  reason?: string;
};

const DIGITS = /\d/g;

/** A trailing extension: "ext 220", "x220", "extension 220", "#220". */
const EXTENSION = /\s*(?:\b(?:ext|extension)\b\.?|\bx|#)\s*\d{1,6}\s*$/i;

/**
 * NANP validity is not "ten digits". The area code and the exchange code both
 * have to start 2-9, which is what rejects the placeholder numbers (000, 111)
 * and most typos that would otherwise be stored and silently never reached.
 */
export function parsePhone(input: string | null | undefined): ParsedPhone {
  if (!input) return { ok: false, reason: 'empty' };

  // An extension is not part of the number and must not become digits in it.
  // Anchored at the end and allowing `x220` with no space, which is how most
  // people write one — a word-boundary match after the `x` misses exactly that
  // case and turns a valid number into a thirteen-digit rejection.
  const withoutExtension = String(input).replace(EXTENSION, '');
  const digits = (withoutExtension.match(DIGITS) ?? []).join('');
  if (!digits) return { ok: false, reason: 'no digits' };

  let national: string;
  if (digits.length === 10) {
    national = digits;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    national = digits.slice(1);
  } else {
    return {
      ok: false,
      reason: `expected 10 digits (or 11 starting with 1), got ${digits.length}`,
    };
  }

  const areaCode = national.slice(0, 3);
  const exchange = national.slice(3, 6);
  if (!/^[2-9]/.test(areaCode)) {
    return { ok: false, reason: `area code ${areaCode} is not valid in North America` };
  }
  if (!/^[2-9]/.test(exchange)) {
    return { ok: false, reason: `exchange ${exchange} is not valid in North America` };
  }
  // N11 codes are service codes (411, 911), never subscriber area codes.
  if (/^\d11$/.test(areaCode)) {
    return { ok: false, reason: `${areaCode} is a service code, not an area code` };
  }

  return {
    ok: true,
    e164: `+1${national}`,
    national,
    areaCode,
    formatted: `(${areaCode}) ${exchange}-${national.slice(6)}`,
  };
}

/** E.164 or null. The form stored in `phone_e164` everywhere. */
export function toE164(input: string | null | undefined): string | null {
  const parsed = parsePhone(input);
  return parsed.ok ? parsed.e164! : null;
}

/** How a number is shown to a person. Falls back to the input when unparseable. */
export function formatPhone(input: string | null | undefined): string {
  const parsed = parsePhone(input);
  return parsed.ok ? parsed.formatted! : (input ?? '');
}

export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = toE164(a);
  const y = toE164(b);
  return x !== null && x === y;
}
