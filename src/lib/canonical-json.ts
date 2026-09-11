/**
 * A stable string for a JSON value: object keys sorted, recursively.
 *
 * This is not tidiness. Audit payloads are stored as `jsonb`, which normalises
 * the document — it reorders keys and drops insignificant whitespace. So
 * `JSON.stringify(value)` at write time and `JSON.stringify(rowReadBack)` at
 * verify time are different strings for the same data, and a hash chain over
 * them reports tampering on every entry carrying a payload with more than one
 * key. (That is not hypothetical: it is the bug this module was extracted to
 * fix.)
 *
 * Hashing a canonical form on both sides makes the digest a function of the
 * data rather than of how the driver happened to serialise it.
 *
 * It lives in lib/ with no imports so that it can be tested — and reused —
 * without pulling in the database or the environment.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
