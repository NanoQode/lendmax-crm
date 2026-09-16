/**
 * The answers, as the columns the rest of the CRM reads.
 *
 * `portal_data` is the record; these columns are the parts of it that the
 * board sorts on, the reports group by and the Scarlett payload is built from.
 * They are derived, never authored — which is why this is one pure function
 * rather than an UPDATE written out at each of the places that changes an
 * answer.
 *
 * Only the columns a CLIENT'S ANSWER can affect are here. The ratios, the
 * mirror hash and the portal's own status are the importer's and are not
 * recomputed when a broker corrects a field: a staff edit does not entitle
 * anybody to a second GDS worked out a different way.
 */

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

const money = (v: unknown): number | null => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const date = (v: unknown): string | null => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10)) ? s.slice(0, 10) : null;
};

/**
 * What is owed on the subject property today.
 *
 * The portal has no flat balance any more — it has a list of charges. Summed
 * here only so the list and the board have one number to show; the charges
 * themselves are the record. (The importer does the same thing, for the same
 * reason.)
 */
export function sumCharges(charges: unknown): number | null {
  if (!Array.isArray(charges) || !charges.length) return null;
  let total = 0;
  let any = false;
  for (const charge of charges) {
    const balance = money((charge as Record<string, unknown>)?.balance);
    if (balance === null) continue;
    any = true;
    total += balance;
  }
  return any ? total : null;
}

export type AnswerColumns = Record<string, string | number | null>;

/** The columns derived from a client's answers, whoever last changed them. */
export function columnsFromAnswers(data: Record<string, any>): AnswerColumns {
  const purpose = data?.purpose ?? {};
  const property = data?.property ?? {};
  const applicants = Array.isArray(data?.applicants) ? data.applicants : [];

  return {
    purpose: str(purpose.purpose),
    amount_requested: money(purpose.amount_requested),
    timing: str(purpose.timing),
    existing_lender: str(purpose.existing_lender),
    refi_reason: str(purpose.refi_reason),
    // Not a detail: the position decides whether the loan-to-value is this
    // money alone, or this money on top of a charge that stays ahead of it.
    request_position: str(purpose.request_position),
    request_loan_type: str(purpose.request_loan_type),
    /* `purpose.maturity_date` is deliberately absent.
     *
     * A client's declared maturity is a renewal opportunity, and the renewal
     * module reads `applications.maturity_date` alongside `maturity_source`.
     * Writing one here without the other would put a declared date into a
     * column the renewals list treats as confirmed. The importer computes the
     * same value and does not write it either. */

    property_street_number: str(property.street_number),
    property_street_name: str(property.street_name),
    property_unit: str(property.unit),
    property_city: str(property.city),
    property_province: str(property.province),
    property_postal_code: str(property.postal_code),
    property_type: str(property.home_type),
    property_occupancy: str(property.occupancy),
    purchase_price: money(property.purchase_price),
    property_value: money(property.property_value),
    down_payment: money(property.down_payment),
    down_payment_source: str(property.down_source),
    existing_balance: money(property.existing_balance) ?? sumCharges(property.mortgages),
    annual_taxes: money(property.annual_taxes),
    monthly_heat: money(property.monthly_heat),
    monthly_condo_fee: money(property.condo_fee),
    rental_income: money(property.rental_income),
    closing_date: date(property.closing_date),

    applicant_count: applicants.length,
  };
}

/** The columns above, as the `SET` half of an UPDATE plus its parameters. */
export function columnAssignments(columns: AnswerColumns, from = 1): {
  sql: string; params: unknown[];
} {
  const keys = Object.keys(columns);
  const params = keys.map((k) => columns[k] ?? null);
  const sql = keys.map((k, i) => `${k} = $${from + i}`).join(', ');
  return { sql, params };
}
