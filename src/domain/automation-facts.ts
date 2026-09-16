/**
 * What an automation condition can test about a file, and the list the builder
 * offers. Pure — the database read is `services/automation-facts.ts`.
 *
 * Two kinds of fact:
 *
 *   · THE FILE — its stage, pipeline, tags, dates and counts, read from the
 *     CRM's own columns.
 *
 *   · THE APPLICATION — every answer on the portal's form, with the
 *     brokerage's corrections laid over the client's own, under
 *     `purpose.*`, `property.*` and `applicant.*` (the primary borrower), plus
 *     figures worked out from them under `calc.*` — total household income,
 *     total debt, loan-to-value. So "purpose is Purchase and income is over
 *     $120,000" is two conditions a person picks from a list, not a query.
 *
 * The builder's field list is generated from the same portal schema the form
 * renders from, so a question added to the application is available to
 * automations without anybody touching this file.
 */
import type { Facts } from './automation.ts';
import { SECTIONS, type FormField } from './application-form.ts';

// ── The field list ─────────────────────────────────────────────────────────

export type FactField = {
  field: string;
  label: string;
  type: 'text' | 'number' | 'enum' | 'boolean' | 'date' | 'stage' | 'pipeline' | 'user' | 'tags';
  group: string;
  options?: string[];
};

const FILE_FIELDS: FactField[] = [
  { group: 'Pipeline', field: 'pipeline_key', label: 'Pipeline', type: 'pipeline' },
  { group: 'Pipeline', field: 'stage_key', label: 'Pipeline stage', type: 'stage' },
  { group: 'Pipeline', field: 'stage_category', label: 'Stage category', type: 'enum', options: ['open', 'won', 'lost'] },
  { group: 'Pipeline', field: 'transaction_type_key', label: 'Transaction type', type: 'text' },
  { group: 'Pipeline', field: 'broker_user_id', label: 'Assigned broker', type: 'user' },
  { group: 'Pipeline', field: 'has_broker', label: 'Has an assigned broker', type: 'boolean' },
  { group: 'Pipeline', field: 'scarlett_deal_id', label: 'Sent to Scarlett (deal id)', type: 'text' },
  { group: 'Pipeline', field: 'lost_disposition_key', label: 'Lost reason', type: 'text' },
  { group: 'Pipeline', field: 'funding_confirmed', label: 'Funding confirmed', type: 'boolean' },
  { group: 'Contact', field: 'first_name', label: 'First name', type: 'text' },
  { group: 'Contact', field: 'last_name', label: 'Last name', type: 'text' },
  { group: 'Contact', field: 'email', label: 'Email address', type: 'text' },
  { group: 'Contact', field: 'phone_e164', label: 'Mobile number', type: 'text' },
  { group: 'Contact', field: 'tags', label: 'Tags', type: 'tags' },
  { group: 'Contact', field: 'lead_source', label: 'Lead source', type: 'text' },
  { group: 'Contact', field: 'referral_source', label: 'Referred by', type: 'text' },
  { group: 'Contact', field: 'preferred_language', label: 'Preferred language', type: 'text' },
  { group: 'Contact', field: 'awaiting_reply', label: 'Awaiting our reply', type: 'boolean' },
  { group: 'File', field: 'percent_complete', label: 'Application completeness (%)', type: 'number' },
  { group: 'File', field: 'application_submitted', label: 'Application submitted', type: 'boolean' },
  { group: 'File', field: 'amount_requested', label: 'Amount requested', type: 'number' },
  { group: 'File', field: 'property_province', label: 'Property province', type: 'text' },
  { group: 'File', field: 'property_city', label: 'Property city', type: 'text' },
  { group: 'File', field: 'documents_outstanding', label: 'Documents outstanding', type: 'number' },
  { group: 'File', field: 'conditions_outstanding', label: 'Lender conditions outstanding', type: 'number' },
  { group: 'File', field: 'future_appointments', label: 'Upcoming appointments', type: 'number' },
  { group: 'File', field: 'last_appointment_no_show', label: 'Last appointment was a no-show', type: 'boolean' },
  { group: 'File', field: 'days_to_close', label: 'Days to closing', type: 'number' },
  { group: 'File', field: 'days_to_maturity', label: 'Days to maturity', type: 'number' },
  { group: 'File', field: 'days_since_activity', label: 'Days since last activity', type: 'number' },
  { group: 'File', field: 'gds', label: 'GDS (%)', type: 'number' },
  { group: 'File', field: 'tds', label: 'TDS (%)', type: 'number' },
  { group: 'File', field: 'ltv', label: 'LTV (%)', type: 'number' },
];

const CALC_FIELDS: FactField[] = [
  { group: 'Worked out from the application', field: 'calc.borrowers', label: 'Number of borrowers', type: 'number' },
  { group: 'Worked out from the application', field: 'calc.has_co_applicant', label: 'Has a co-applicant', type: 'boolean' },
  { group: 'Worked out from the application', field: 'calc.total_income', label: 'Total annual income (all borrowers)', type: 'number' },
  { group: 'Worked out from the application', field: 'calc.employment_income', label: 'Employment income (all borrowers)', type: 'number' },
  { group: 'Worked out from the application', field: 'calc.other_income', label: 'Other income, annual', type: 'number' },
  { group: 'Worked out from the application', field: 'calc.total_assets', label: 'Total assets', type: 'number' },
  { group: 'Worked out from the application', field: 'calc.total_debt', label: 'Total debt balances', type: 'number' },
  { group: 'Worked out from the application', field: 'calc.monthly_debt_payments', label: 'Monthly debt payments', type: 'number' },
  { group: 'Worked out from the application', field: 'calc.down_payment_percent', label: 'Down payment (%)', type: 'number' },
  { group: 'Worked out from the application', field: 'calc.other_properties', label: 'Other properties owned', type: 'number' },
];

const SECTION_PREFIX: Record<string, { prefix: string; group: string }> = {
  purpose: { prefix: 'purpose', group: 'Application · Purpose' },
  property: { prefix: 'property', group: 'Application · Property' },
  applicants: { prefix: 'applicant', group: 'Application · Primary borrower' },
};

function factType(f: FormField): Pick<FactField, 'type' | 'options'> {
  switch (f.t) {
    case 'money': case 'number': case 'percent': case 'sqft': case 'year':
      return { type: 'number' };
    case 'checkbox':
      return { type: 'boolean' };
    case 'date':
      return { type: 'date' };
    case 'select': case 'radio': case 'choice':
      if (f.dynamic) return { type: 'text' };
      return { type: 'enum', options: (f.o ?? []).map((o) => (typeof o === 'string' ? o : o.v)) };
    default:
      return { type: 'text' };
  }
}

/** Every application question a condition can test, generated from the portal schema. */
export function applicationFactFields(): FactField[] {
  const out: FactField[] = [];
  for (const section of SECTIONS) {
    const where = SECTION_PREFIX[section.id];
    if (!where) continue;
    for (const group of section.groups) {
      if (group.repeat) continue;
      for (const f of group.fields) {
        if ((f as FormField & { hidden?: boolean }).hidden && f.t !== 'checkbox') continue;
        out.push({ group: where.group, field: `${where.prefix}.${f.n}`, label: f.l, ...factType(f) });
      }
    }
  }
  return out;
}

export function factFields(): FactField[] {
  return [...FILE_FIELDS, ...applicationFactFields(), ...CALC_FIELDS];
}

// ── Reading the facts ──────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Times a year, for the income frequencies the portal offers. */
const PER_YEAR: Record<string, number> = {
  Monthly: 12, 'Semi-monthly': 24, 'Bi-weekly': 26, 'Accelerated bi-weekly': 26, Weekly: 52,
  'Accelerated weekly': 52, Annually: 1, Yearly: 1, Annual: 1,
};

/** The application answers as flat facts, and the figures worked out from them. */
export function applicationFacts(answers: Record<string, any>): Facts {
  const facts: Facts = {};
  const flat = (prefix: string, obj: unknown) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || typeof v !== 'object') facts[`${prefix}.${k}`] = v;
    }
  };
  flat('purpose', answers.purpose);
  flat('property', answers.property);
  const applicants: any[] = Array.isArray(answers.applicants) ? answers.applicants : [];
  flat('applicant', applicants[0]);

  const sum = (rows: unknown, pick: (r: any) => number | null) =>
    (Array.isArray(rows) ? rows : []).reduce((t, r) => t + (pick(r) ?? 0), 0);

  const employment = applicants.reduce((t, a) => t + (num(a?.annual_income) ?? 0), 0);
  const other = sum(answers.income, (r) => {
    const amount = num(r?.amount);
    if (amount === null) return null;
    return amount * (PER_YEAR[String(r?.frequency ?? 'Annually')] ?? 1);
  });
  const property = answers.property ?? {};
  const price = num(property.purchase_price) ?? num(property.property_value);
  const down = num(property.down_payment);

  facts['calc.borrowers'] = applicants.length;
  facts['calc.has_co_applicant'] = applicants.length > 1;
  facts['calc.employment_income'] = Math.round(employment);
  facts['calc.other_income'] = Math.round(other);
  facts['calc.total_income'] = Math.round(employment + other);
  facts['calc.total_assets'] = Math.round(sum(answers.assets, (r) => num(r?.value)));
  facts['calc.total_debt'] = Math.round(sum(answers.liabilities, (r) => num(r?.balance)));
  facts['calc.monthly_debt_payments'] = Math.round(sum(answers.liabilities, (r) => num(r?.payment)));
  facts['calc.down_payment_percent'] = price && down !== null ? Math.round((down / price) * 1000) / 10 : null;
  facts['calc.other_properties'] = Array.isArray(answers.other_properties) ? answers.other_properties.length : 0;
  return facts;
}
