/**
 * Money, commission and renewal dates.
 *
 * All of it pure and all of it in one place because every function here is a
 * number somebody will be paid on, and a rounding decision made in three
 * different route handlers is a rounding decision made three different ways.
 *
 * THE RULE: cents, never floats, and every division states where the
 * remainder goes. `0.1 + 0.2` is not `0.3`, and a commission split that
 * silently loses a cent per file loses real money at volume — but worse, it
 * makes the splits not add up to the total, which is the thing a broker
 * notices and stops trusting.
 */

/** A dollar amount, in cents. */
export type Cents = number;

/** Parse money from the database (a NUMERIC arrives as a string) or a form. */
export function toCents(value: unknown): Cents | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  }
  const cleaned = String(value).replace(/[$,\s]/g, '');
  // `Number('')` is 0 and `Number('abc')` is NaN — but so is a string with no
  // digit at all, and returning 0 for "not a number" is how a blank field
  // becomes a zero-dollar mortgage.
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function fromCents(cents: Cents | null): string | null {
  return cents === null ? null : (cents / 100).toFixed(2);
}

/**
 * Commission from a basis-point rate.
 *
 * 85 bps on $500,000 is $4,250. Rounded half-up at the cent, because that is
 * what a lender's own statement does and a CRM that disagrees with the
 * statement by a cent generates a variance investigation over nothing.
 */
export function commissionFromBps(amount: Cents, bps: number): Cents {
  return Math.round((amount * bps) / 10_000);
}

export type Split = {
  party: string;
  user_id?: string | null;
  party_name?: string | null;
  /** A percentage of the gross. Mutually exclusive with a fixed amount. */
  percent?: number | null;
  /** A fixed amount in cents. Taken before the percentages are applied. */
  amount?: Cents | null;
};

export type SplitResult = {
  splits: Array<Split & { amount: Cents }>;
  /** What is left after every split. Zero when the splits are exhaustive. */
  remainder: Cents;
  problems: string[];
};

/**
 * Divide a commission.
 *
 * A fixed amount — a referral fee, typically — comes OFF THE TOP, and the
 * percentages then divide what is left. The alternative, applying the
 * percentages to the full gross and adding the fee on top, allocates more
 * money than exists: a $500 referral fee plus 70/30 of $4,352 comes to
 * $4,852, and a screen that shows that alongside a $4,352 commission is
 * showing somebody money that is not there. (This was exactly the bug: the
 * splits rendered correctly and the total was $500 too high.)
 *
 * The rounding remainder goes to the LARGEST share rather than being
 * dropped, so the parts always sum to the whole — a split table that does
 * not add up to the total is the first thing anybody checks and the fastest
 * way to lose their confidence.
 */
export function divideCommission(gross: Cents, splits: Split[]): SplitResult {
  const problems: string[] = [];

  const fixed = splits.filter((s) => s.amount !== null && s.amount !== undefined);
  const proportional = splits.filter((s) => s.amount === null || s.amount === undefined);

  const fixedTotal = fixed.reduce((sum, s) => sum + (s.amount ?? 0), 0);
  if (fixedTotal > gross) {
    problems.push(
      `The fixed amounts come to more than the commission itself `
      + `(${format(fixedTotal)} of ${format(gross)}).`);
  }

  const percentTotal = proportional.reduce((sum, s) => sum + (s.percent ?? 0), 0);
  if (proportional.length && Math.abs(percentTotal - 100) > 0.0001) {
    problems.push(
      percentTotal > 100
        ? `The percentages come to ${trim(percentTotal)}%, which is more than the whole.`
        : `The percentages come to ${trim(percentTotal)}%, leaving ${trim(100 - percentTotal)}% unallocated.`);
  }

  // What the percentages divide: the gross, less anything taken off the top.
  const pool = Math.max(gross - fixedTotal, 0);

  const computed: Array<Split & { amount: Cents }> = [
    ...fixed.map((s) => ({ ...s, amount: s.amount ?? 0 })),
    ...proportional.map((s) => ({
      ...s,
      amount: Math.round((pool * (s.percent ?? 0)) / 100),
    })),
  ];

  const allocated = computed.reduce((sum, s) => sum + s.amount, 0);
  const remainder = gross - allocated;

  // A rounding remainder of a cent or two is arithmetic; anything larger is
  // an unallocated share and stays visible as the remainder.
  if (remainder !== 0 && Math.abs(remainder) <= computed.length && computed.length) {
    const largest = computed.reduce((a, b) => (b.amount > a.amount ? b : a));
    largest.amount += remainder;
    return { splits: computed, remainder: 0, problems };
  }

  return { splits: computed, remainder, problems };
}

/** The signed difference between what arrived and what was expected. */
export function variance(expected: Cents | null, received: Cents | null): Cents | null {
  if (expected === null || received === null) return null;
  return received - expected;
}

/**
 * How a variance should be described.
 *
 * "Short by $312.50" is actionable. "-31250" is not, and neither is a red
 * cell with no number in it.
 */
export function describeVariance(
  expected: Cents | null,
  received: Cents | null,
): { amount: Cents | null; label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' } {
  if (expected === null && received === null) {
    return { amount: null, label: 'Nothing recorded', tone: 'neutral' };
  }
  if (received === null) {
    return { amount: null, label: `${format(expected!)} expected, nothing received yet`, tone: 'neutral' };
  }
  if (expected === null) {
    return { amount: null, label: `${format(received)} received, nothing was expected`, tone: 'warn' };
  }
  const diff = received - expected;
  if (diff === 0) return { amount: 0, label: 'Matches what was expected', tone: 'ok' };
  return {
    amount: diff,
    label: diff < 0
      ? `Short by ${format(-diff)}`
      : `Over by ${format(diff)}`,
    // Short is a problem; over is a question. Neither is silent.
    tone: diff < 0 ? 'danger' : 'warn',
  };
}

// ── Renewal dates ──────────────────────────────────────────────────────────

export type Milestone = { key: string; label: string; due_on: string; months_before: number };

/**
 * T-6 months, T-3 months, T-45 days by default — configuration, not law.
 *
 * Computed from the maturity date and stored as rows, so "which clients hit
 * T-45 tomorrow" is an index scan rather than a nightly recomputation of
 * everybody's dates.
 */
export const DEFAULT_MILESTONES: Array<{ key: string; label: string; days_before: number }> = [
  { key: 't_minus_6m', label: 'Six months out', days_before: 183 },
  { key: 't_minus_3m', label: 'Three months out', days_before: 91 },
  { key: 't_minus_45d', label: 'Forty-five days out', days_before: 45 },
];

export function milestonesFor(
  maturityDate: string,
  today: string,
  definitions = DEFAULT_MILESTONES,
): Array<{ key: string; label: string; due_on: string; past: boolean }> {
  return definitions.map((m) => {
    const due = addDays(maturityDate, -m.days_before);
    return { key: m.key, label: m.label, due_on: due, past: due < today };
  });
}

/**
 * The maturity date of a mortgage funded on a date with a term in months.
 *
 * Clamped to the end of the month: a five-year term from 31 August matures on
 * 31 August, and a three-month term from 30 November matures on 28 February,
 * not 2 March.
 */
export function maturityFrom(fundingDate: string, termMonths: number): string {
  const [y, m, d] = fundingDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + termMonths, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0))
    .getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

const CAD = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
function format(cents: Cents): string {
  return CAD.format(cents / 100);
}
function trim(n: number): string {
  return String(Math.round(n * 10_000) / 10_000);
}
