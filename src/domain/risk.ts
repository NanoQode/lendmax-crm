/**
 * The risk meter, and the reason it is never a number on its own.
 *
 * A compliance risk rating a brokerage cannot defend is worse than no rating:
 * it looks like diligence and answers no question. So this module is built
 * around one rule — THE SCORE IS ALWAYS READ BACK AS ITS FACTORS. Every
 * evaluator returns the value it saw, the weight configured for it, and a
 * sentence a person can check. The screen renders the explanation from the
 * same data that produced the number, so the two cannot disagree.
 *
 * Nothing here hard-codes a legal rule. The factors, their weights, the
 * thresholds between bands and even which evaluators run are configuration
 * with an effective date, held in `risk_factor_definitions`. The evaluators
 * are a closed set — configured, not arbitrary — because a rule engine that
 * accepts expressions is a rule engine nobody can audit.
 *
 * What this is NOT: a determination. FINTRAC expects a person to assess risk.
 * The model's suggestion is stored beside a person's rating, never instead of
 * it, and an override records who disagreed and why.
 */

export type RiskRating = 'low' | 'medium' | 'high' | 'review_required';

/** One configured factor. Comes from the database, never from code. */
export type FactorDefinition = {
  factor_key: string;
  label: string;
  description?: string | null;
  weight: number;
  evaluator: string;
  parameters: Record<string, unknown>;
};

/**
 * Everything an evaluator may read.
 *
 * Deliberately narrow, and deliberately free of anything that is not needed
 * to reach a rating: no SIN, no full identification number, no credit file.
 * A risk model reading a document it does not need is a risk model that has
 * made a copy of it.
 */
export type RiskFacts = {
  transactionTypeKey: string | null;
  amountRequested: number | null;
  propertyProvince: string | null;
  propertyCity: string | null;
  /** Citizenship / residency as declared, per applicant. */
  applicants: Array<Record<string, unknown>>;
  /** Document categories received on this file. */
  documentCategories: string[];
  /** Declared source of the down payment, from the application. */
  downPaymentSource: string | null;
  /**
   * The FINTRAC determinations, where they have been made.
   *
   * The companion fields matter as much as the answers. `entity_borrower` is
   * NOT NULL DEFAULT false in the schema, so the value alone cannot tell
   * "determined, and the borrower is a person" from "nobody has looked" — and
   * a risk meter that reports the second as the first is claiming diligence
   * that did not happen. Each flag factor names the field that says the
   * determination was actually made.
   */
  fintrac: {
    third_party_present?: boolean | null;
    third_party_checked?: boolean | null;
    entity_borrower?: boolean | null;
    ownership_confirmed_at?: string | null;
    completed_at?: string | null;
    pep_result?: string | null;
    pep_screened?: boolean | null;
    source_of_funds?: string | null;
  } | null;
  /** Previous funded files for this customer, newest first. */
  priorFundings: Array<{ funding_date: string | null; final_transaction_type: string | null }>;
  /** Today, as a calendar date, so the result is reproducible. */
  today: string;
};

/** What one factor contributed, and the evidence for it. */
export type EvaluatedFactor = {
  key: string;
  label: string;
  /** Did the factor apply at all. */
  triggered: boolean;
  /** What the evaluator actually saw. Rendered next to the factor. */
  value: string;
  weight: number;
  points: number;
  /** The sentence a reviewer reads. Always present, triggered or not. */
  note: string;
  /**
   * True when the evaluator could not tell. An unanswered question is not a
   * clean file — it is an unanswered question, and the meter says so rather
   * than quietly scoring it zero.
   */
  unknown: boolean;
};

export type RiskResult = {
  score: number;
  rating: RiskRating;
  factors: EvaluatedFactor[];
  /** The factors that could not be evaluated, by label. */
  unanswered: string[];
  /** One sentence naming the largest contributors. */
  summary: string;
};

type Evaluator = (
  facts: RiskFacts,
  parameters: Record<string, unknown>,
) => { triggered: boolean; value: string; note: string; unknown?: boolean };

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];

/**
 * The closed set.
 *
 * Adding one is a code change with a test, which is the point: a compliance
 * model that can be edited into a new shape from a settings screen is a model
 * whose behaviour last quarter cannot be reconstructed.
 */
export const EVALUATORS: Record<string, Evaluator> = {
  /** The transaction type is one of a configured list. */
  transaction_type_in: (facts, parameters) => {
    const values = strings(parameters.values);
    if (!facts.transactionTypeKey) {
      return {
        triggered: false, unknown: true, value: 'not recorded',
        note: 'The transaction type is not set on this file.',
      };
    }
    const hit = values.includes(facts.transactionTypeKey);
    return {
      triggered: hit,
      value: facts.transactionTypeKey,
      note: hit
        ? `This is a ${facts.transactionTypeKey.replace(/_/g, ' ')}.`
        : `This is a ${facts.transactionTypeKey.replace(/_/g, ' ')}, which is not on the list.`,
    };
  },

  /** Any applicant's field matches a configured list. */
  applicant_field_in: (facts, parameters) => {
    const field = String(parameters.field ?? '');
    const values = strings(parameters.values).map((v) => v.toLowerCase());
    if (!facts.applicants.length) {
      return {
        triggered: false, unknown: true, value: 'no applicants recorded',
        note: 'There are no applicants on this file to check.',
      };
    }
    const seen = facts.applicants.map((a) => String(a[field] ?? '').trim()).filter(Boolean);
    if (!seen.length) {
      return {
        triggered: false, unknown: true, value: 'not answered',
        note: `No applicant has answered "${field.replace(/_/g, ' ')}".`,
      };
    }
    const hit = seen.some((v) => values.includes(v.toLowerCase()));
    return {
      triggered: hit,
      value: seen.join(', '),
      note: hit
        ? `An applicant is recorded as "${seen.find((v) => values.includes(v.toLowerCase()))}".`
        : `Recorded as ${seen.join(', ')}.`,
    };
  },

  /**
   * A boolean determination on the FINTRAC assessment.
   *
   * `determined_by` names the field that says somebody actually made the
   * determination. Without it a column defaulting to false reads as a clean
   * answer, which is how a file nobody has assessed ends up looking assessed.
   */
  fintrac_flag: (facts, parameters) => {
    const flag = String(parameters.flag ?? '');
    const assessment = facts.fintrac;
    if (!assessment) {
      return {
        triggered: false, unknown: true, value: 'not determined',
        note: 'There is no FINTRAC assessment on this file.',
      };
    }
    const determinedBy = parameters.determined_by
      ? String(parameters.determined_by) : null;
    if (determinedBy) {
      const marker = assessment[determinedBy as keyof typeof assessment];
      if (marker === null || marker === undefined || marker === false) {
        return {
          triggered: false, unknown: true, value: 'not determined',
          note: `The "${flag.replace(/_/g, ' ')}" determination has not been made yet.`,
        };
      }
    }
    const value = assessment[flag as keyof typeof assessment];
    if (value === null || value === undefined) {
      return {
        triggered: false, unknown: true, value: 'not determined',
        note: `The "${flag.replace(/_/g, ' ')}" determination has not been made yet.`,
      };
    }
    return {
      triggered: value === true,
      value: value ? 'yes' : 'no',
      note: value
        ? 'Recorded as present on the FINTRAC assessment.'
        : 'Recorded as not present on the FINTRAC assessment.',
    };
  },

  /** Any PEP result other than "none". */
  fintrac_pep: (facts) => {
    const result = facts.fintrac?.pep_result;
    if (!result) {
      return {
        triggered: false, unknown: true, value: 'not screened',
        note: 'PEP screening has not been recorded.',
      };
    }
    return {
      triggered: result !== 'none',
      value: result,
      note: result === 'none'
        ? 'Screened, with no match.'
        : `Screened as ${result.replace(/_/g, ' ')}, which requires senior approval.`,
    };
  },

  /** The declared source of funds is missing or vague. */
  fintrac_source_unclear: (facts, parameters) => {
    const vague = strings(parameters.vague ?? ['cash', 'gift', 'other', 'unknown'])
      .map((v) => v.toLowerCase());
    const declared = (facts.fintrac?.source_of_funds ?? facts.downPaymentSource ?? '').trim();
    if (!declared) {
      return {
        triggered: false, unknown: true, value: 'not recorded',
        note: 'No source of funds has been recorded.',
      };
    }
    const hit = vague.some((v) => declared.toLowerCase().includes(v));
    return {
      triggered: hit,
      value: declared,
      note: hit
        ? `Declared as "${declared}", which needs supporting evidence.`
        : `Declared as "${declared}".`,
    };
  },

  /** None of the configured document categories has been received. */
  documents_missing: (facts, parameters) => {
    const categories = strings(parameters.categories);
    if (!categories.length) {
      return { triggered: false, value: 'no categories configured', note: 'Nothing to check.' };
    }
    const present = categories.filter((c) => facts.documentCategories.includes(c));
    return {
      triggered: present.length === 0,
      value: present.length ? present.join(', ') : 'none received',
      note: present.length
        ? `Verified by ${present.join(', ').replace(/_/g, ' ')}.`
        : `None of ${categories.join(', ').replace(/_/g, ' ')} is on file.`,
    };
  },

  /** A previous funded file within N months. */
  repeat_refinance: (facts, parameters) => {
    const months = Number(parameters.months ?? 12);
    const dated = facts.priorFundings.filter((f) => f.funding_date);
    if (!dated.length) {
      return {
        triggered: false,
        value: 'no previous funding',
        note: 'This is the first file we have funded for this client.',
      };
    }
    const cutoff = monthsBefore(facts.today, months);
    const recent = dated.filter((f) => (f.funding_date as string) >= cutoff);
    return {
      triggered: recent.length > 0,
      value: recent.length ? `${recent.length} within ${months} months` : 'none recent',
      note: recent.length
        ? `Funded ${recent.length} time(s) since ${cutoff}.`
        : `Last funded ${dated[0]!.funding_date}, outside the ${months}-month window.`,
    };
  },

  /** The amount is at or above a configured threshold. */
  amount_at_least: (facts, parameters) => {
    const threshold = Number(parameters.amount ?? 0);
    if (facts.amountRequested === null) {
      return {
        triggered: false, unknown: true, value: 'not recorded',
        note: 'No amount is recorded on this file.',
      };
    }
    return {
      triggered: facts.amountRequested >= threshold,
      value: formatMoney(facts.amountRequested),
      note: facts.amountRequested >= threshold
        ? `${formatMoney(facts.amountRequested)} is at or above ${formatMoney(threshold)}.`
        : `${formatMoney(facts.amountRequested)} is below ${formatMoney(threshold)}.`,
    };
  },

  /** The property is outside a configured list of provinces. */
  province_not_in: (facts, parameters) => {
    const values = strings(parameters.values);
    if (!facts.propertyProvince) {
      return {
        triggered: false, unknown: true, value: 'not recorded',
        note: 'No property province is recorded.',
      };
    }
    const outside = !values.includes(facts.propertyProvince);
    return {
      triggered: outside,
      value: facts.propertyProvince,
      note: outside
        ? `The property is in ${facts.propertyProvince}, outside ${values.join(', ')}.`
        : `The property is in ${facts.propertyProvince}.`,
    };
  },
};

/** The band thresholds. Configuration, with a stated default. */
export type RiskBands = { medium: number; high: number };
export const DEFAULT_BANDS: RiskBands = { medium: 3, high: 7 };

export function assessRisk(
  definitions: FactorDefinition[],
  facts: RiskFacts,
  bands: RiskBands = DEFAULT_BANDS,
): RiskResult {
  const factors: EvaluatedFactor[] = [];

  for (const definition of definitions) {
    const evaluator = EVALUATORS[definition.evaluator];
    if (!evaluator) {
      // A configured factor with no evaluator is a configuration error, and
      // it is surfaced rather than skipped — silently dropping a factor
      // changes the score without changing the explanation.
      factors.push({
        key: definition.factor_key,
        label: definition.label,
        triggered: false,
        value: 'not evaluated',
        weight: definition.weight,
        points: 0,
        note: `There is no evaluator called "${definition.evaluator}". This factor did not run.`,
        unknown: true,
      });
      continue;
    }
    const outcome = evaluator(facts, definition.parameters ?? {});
    factors.push({
      key: definition.factor_key,
      label: definition.label,
      triggered: outcome.triggered,
      value: outcome.value,
      weight: definition.weight,
      points: outcome.triggered ? definition.weight : 0,
      note: outcome.note,
      unknown: outcome.unknown === true,
    });
  }

  const score = round2(factors.reduce((sum, f) => sum + f.points, 0));
  const unanswered = factors.filter((f) => f.unknown).map((f) => f.label);

  // An unanswered question is not a low-risk answer. A file with open
  // determinations is sent for review rather than rated on what happens to
  // have been filled in.
  const rating: RiskRating = unanswered.length > 0
    ? 'review_required'
    : score >= bands.high ? 'high'
    : score >= bands.medium ? 'medium'
    : 'low';

  return { score, rating, factors, unanswered, summary: summarise(factors, rating, unanswered) };
}

function summarise(
  factors: EvaluatedFactor[],
  rating: RiskRating,
  unanswered: string[],
): string {
  const triggered = factors.filter((f) => f.triggered)
    .sort((a, b) => b.points - a.points);

  if (rating === 'review_required') {
    return `Needs review: ${unanswered.length} determination(s) have not been made — `
      + `${unanswered.slice(0, 3).join(', ')}`
      + (unanswered.length > 3 ? `, and ${unanswered.length - 3} more.` : '.');
  }
  if (!triggered.length) return 'No risk factor applies to this file.';
  const names = triggered.slice(0, 3).map((f) => f.label.toLowerCase());
  return `Driven by ${names.join(', ')}`
    + (triggered.length > 3 ? `, and ${triggered.length - 3} more.` : '.');
}

/** The rating a person should see when nothing has been assessed at all. */
export const UNASSESSED = {
  rating: 'review_required' as const,
  summary: 'This file has not been assessed.',
};

function monthsBefore(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  // Clamp to the end of the month, so 31 March minus one month is 28/29
  // February rather than 2 or 3 March.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0))
    .getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD', maximumFractionDigits: 0,
  }).format(n);
}
