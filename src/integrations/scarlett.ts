/**
 * Scarlett Network.
 *
 * Built against the integration Scarlett actually supports, documented in the
 * portal's `docs/scarlett-api-reference.md` and already implemented once in
 * `lib/scarlett-deal.js`. Three facts that are easy to get wrong and expensive
 * to get wrong:
 *
 *   · The host is `api.scarlettnetwork.com`. `.net` is the help site. That
 *     distinction cost the portal team a working integration.
 *   · Authentication is ONE API key, sent as `APIKey` **in the JSON body** of
 *     every call. There is no token exchange, no bearer header, nothing that
 *     expires.
 *   · There are three endpoints, all POST and all stateless:
 *     `dosconnect/dropdown-pull`, `dosconnect/deal-push`, `dosconnect/deal-pull`.
 *
 * THE ENUM RULE. Their enums are integers and no list is published; the numbers
 * come from `dropdown-pull`. An enum we cannot map is **left out** of the
 * payload rather than guessed. A field Scarlett can default or ask about later
 * is recoverable; a wrong integer sent confidently is not. So a deal with no
 * marital status means "we could not map it", never "single" — and the push
 * screen names every dropped field before anything is sent.
 */
import type pg from 'pg';
import { query, queryOne, withTransaction } from '../db/pool.ts';
import { log } from '../lib/logger.ts';
import { integrationReady, resolveIntegration } from '../services/integrations.ts';
import { calendarDateIn } from '../domain/dates.ts';
import { env } from '../config/env.ts';

export const SCARLETT_HOST = 'https://api.scarlettnetwork.com';
const TIMEOUT_MS = 30_000;

// ── Small helpers, matching the portal's vocabulary ────────────────────────

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const num = (v: unknown): number | null => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const digits = (v: unknown): string => str(v).replace(/\D/g, '');
/** Their date format is undocumented; ISO is what their own samples show. */
const date = (v: unknown): string => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : '');

/**
 * Set a key only when the value is worth sending.
 *
 * An explicit empty string or null in their payload reads as "we checked and
 * there is none", which is a different statement from "we do not hold this".
 */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && value.trim() === '') return;
  target[key] = value;
}

/** Lower-cased, punctuation-flattened, so "Employed — salaried" matches "Employed - salaried". */
export function normaliseLabel(value: unknown): string {
  return str(value)
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Code tables ────────────────────────────────────────────────────────────

export type CodeTable = Map<string, Map<string, string>>;

export async function loadCodes(organizationId: string): Promise<CodeTable> {
  const table: CodeTable = new Map();
  const { rows } = await query<{ menu_code: string; normalised: string; item_value: string }>(
    'SELECT menu_code, normalised, item_value FROM scarlett_codes WHERE organization_id = $1',
    [organizationId],
  );
  for (const row of rows) {
    if (!table.has(row.menu_code)) table.set(row.menu_code, new Map());
    table.get(row.menu_code)!.set(row.normalised, row.item_value);
  }
  // Overrides win: they exist for the cases where our wording and theirs will
  // never normalise to the same string.
  const overrides = await query<{ menu_code: string; our_value: string; their_value: string }>(
    'SELECT menu_code, our_value, their_value FROM scarlett_code_overrides WHERE organization_id = $1',
    [organizationId],
  );
  for (const row of overrides.rows) {
    if (!table.has(row.menu_code)) table.set(row.menu_code, new Map());
    table.get(row.menu_code)!.set(normaliseLabel(row.our_value), row.their_value);
  }
  return table;
}

/** The integer Scarlett expects, or undefined — never a guess. */
export function codeFor(menu: string, label: unknown, codes: CodeTable): number | undefined {
  const key = normaliseLabel(label);
  if (!key) return undefined;
  const value = codes.get(menu)?.get(key);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export type PullCodesResult = { ok: boolean; menus: number; items: number; message: string };

export async function pullCodes(organizationId: string): Promise<PullCodesResult> {
  const { ready, reason, values } = await integrationReady(organizationId, 'scarlett');
  if (!ready) return { ok: false, menus: 0, items: 0, message: reason ?? 'Scarlett is not configured.' };

  const response = await call(values, 'dosconnect/dropdown-pull', {});
  if (!response.ok) {
    return { ok: false, menus: 0, items: 0, message: response.error ?? 'The call failed.' };
  }

  const dropdowns = Array.isArray(response.body.DropDowns)
    ? (response.body.DropDowns as Array<Record<string, unknown>>)
    : [];
  if (!dropdowns.length) {
    return { ok: false, menus: 0, items: 0, message: 'Scarlett returned no dropdowns.' };
  }

  let items = 0;
  await withTransaction(async (client) => {
    // Replaced wholesale: a code removed on their side must stop being usable
    // here, and an upsert alone would leave it behind forever.
    await client.query('DELETE FROM scarlett_codes WHERE organization_id = $1', [organizationId]);
    for (const menu of dropdowns) {
      const menuCode = str(menu.MenuCode);
      if (!menuCode) continue;
      const list = Array.isArray(menu.Items) ? (menu.Items as Array<Record<string, unknown>>) : [];
      for (const item of list) {
        const value = str(item.ItemValue);
        const label = str(item.ItemLabel);
        if (!value || !label) continue;
        await client.query(
          `INSERT INTO scarlett_codes (organization_id, menu_code, item_value, item_label, normalised)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (organization_id, menu_code, item_value) DO NOTHING`,
          [organizationId, menuCode, value, label, normaliseLabel(label)],
        );
        items++;
      }
    }
  });

  return {
    ok: true,
    menus: dropdowns.length,
    items,
    message: `Pulled ${items} codes across ${dropdowns.length} menus.`,
  };
}

// ── The HTTP call ──────────────────────────────────────────────────────────

type CallResult = {
  ok: boolean;
  body: Record<string, unknown>;
  status: number;
  error?: string;
  retryable?: boolean;
  durationMs: number;
};

async function call(
  values: Record<string, unknown>,
  path: string,
  body: Record<string, unknown>,
): Promise<CallResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SCARLETT_HOST}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // The key goes in the body. Not a header.
      body: JSON.stringify({ APIKey: String(values.api_key), ...body }),
      signal: controller.signal,
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const durationMs = Math.round(performance.now() - started);

    if (!res.ok) {
      return {
        ok: false, body: parsed, status: res.status, durationMs,
        // `ReturnCode` has no documented meaning, so the HTTP status decides
        // and their message is passed through verbatim for a person to read.
        error: returnMessage(parsed) ?? `Scarlett returned HTTP ${res.status}.`,
        retryable: res.status >= 500 || res.status === 429,
      };
    }
    return { ok: true, body: parsed, status: res.status, durationMs };
  } catch (err) {
    return {
      ok: false, body: {}, status: 0,
      durationMs: Math.round(performance.now() - started),
      error: err instanceof Error
        ? (err.name === 'AbortError' ? `Scarlett did not respond within ${TIMEOUT_MS / 1000}s.` : err.message)
        : String(err),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Their error envelope is undocumented; observed in two shapes, so read both. */
function returnMessage(body: Record<string, unknown>): string | undefined {
  const nested = body.ReturnStatus as Record<string, unknown> | undefined;
  const message = str(nested?.ReturnMessage) || str(body.ReturnMessage);
  return message || undefined;
}

/** The response to a successful push is undocumented. Look in the plausible places. */
function findDealId(body: Record<string, unknown>): string | null {
  const candidates = ['DealId', 'DealID', 'dealId', 'Id', 'ID', 'ApplicationId', 'ApplicationID'];
  const search = (node: unknown, depth = 0): string | null => {
    if (!node || typeof node !== 'object' || depth > 3) return null;
    const record = node as Record<string, unknown>;
    for (const key of candidates) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    for (const value of Object.values(record)) {
      const found = search(value, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return search(body);
}

// ── Building the deal ──────────────────────────────────────────────────────

export type DealBuild = {
  deal: Record<string, unknown>;
  /** Enums dropped for want of a code table — shown before anything is sent. */
  unmapped: Array<{ menu: string; value: string }>;
  /** Things missing that Scarlett or a lender will need. */
  blockers: string[];
  warnings: string[];
};

type Row = Record<string, any>;

/**
 * The CRM's application → Scarlett's UniversalDealModel.
 *
 * Four of its nine fields are sent: MortgageApplication, ApplicantGroups,
 * SubjectProperty and DealNotes. The other five are omitted deliberately —
 * Participants (we do not collect the realtor or the lawyer yet), Activities
 * (their audit trail is not ours), Commissions (set by the brokerage in
 * Scarlett), Tags and LeadIds (nothing maps). Sending an empty array for those
 * would read as "we checked and there are none".
 */
export async function buildDeal(
  organizationId: string,
  applicationId: string,
): Promise<DealBuild> {
  const codes = await loadCodes(organizationId);
  const unmapped: Array<{ menu: string; value: string }> = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  /** Map, and record the miss rather than guessing. */
  const code = (menu: string, value: unknown): number | undefined => {
    if (!str(value)) return undefined;
    const mapped = codeFor(menu, value, codes);
    if (mapped === undefined) unmapped.push({ menu, value: str(value) });
    return mapped;
  };

  const app = await queryOne<Row>(
    'SELECT * FROM applications WHERE id = $1 AND organization_id = $2',
    [applicationId, organizationId],
  );
  if (!app) throw new Error('That application does not exist.');

  const [applicants, employments, incomes, assets, liabilities, properties, mortgages, notes] =
    await Promise.all([
      query<Row>('SELECT * FROM application_applicants WHERE application_id = $1 ORDER BY position', [applicationId]),
      query<Row>('SELECT * FROM application_employments WHERE application_id = $1 ORDER BY slot DESC, position', [applicationId]),
      query<Row>('SELECT * FROM application_incomes WHERE application_id = $1 ORDER BY position', [applicationId]),
      query<Row>('SELECT * FROM application_assets WHERE application_id = $1 ORDER BY position', [applicationId]),
      query<Row>('SELECT * FROM application_liabilities WHERE application_id = $1 ORDER BY position', [applicationId]),
      query<Row>('SELECT * FROM application_properties WHERE application_id = $1 ORDER BY position', [applicationId]),
      query<Row>('SELECT * FROM application_mortgages WHERE application_id = $1 ORDER BY seq', [applicationId]),
      query<Row>(
        `SELECT body FROM notes WHERE application_id = $1 AND deleted_at IS NULL
           AND visibility = 'team' ORDER BY created_at DESC LIMIT 5`,
        [applicationId],
      ),
    ]);

  // ── What must be there ───────────────────────────────────────────────
  if (!applicants.rows.length) blockers.push('The application has no applicant.');
  const primary = applicants.rows[0];
  if (primary) {
    if (!str(primary.first_name) || !str(primary.last_name)) {
      blockers.push('The primary applicant has no full name.');
    }
    if (!str(primary.email) && !str(primary.phone_e164)) {
      blockers.push('The primary applicant has neither an email address nor a phone number.');
    }
  }
  if (!str(app.property_province)) {
    // The specific failure the portal's team hit, named in their error copy.
    blockers.push('The subject property has no province.');
  }
  if (num(app.amount_requested) === null) blockers.push('No mortgage amount is recorded.');

  if (num(app.property_value) === null && num(app.purchase_price) === null) {
    warnings.push('No property value or purchase price — Scarlett cannot compute a loan-to-value.');
  }
  if (!app.closing_date) warnings.push('No closing date is recorded.');

  // ── MortgageApplication ──────────────────────────────────────────────
  const mortgageApplication: Record<string, unknown> = {};
  put(mortgageApplication, 'ExternalApplicationID', str(app.portal_reference) || str(app.id));
  put(mortgageApplication, 'LoanPurpose', code('LoanPurpose', app.purpose));
  put(mortgageApplication, 'LoanType', code('LoanType', app.request_loan_type));
  put(mortgageApplication, 'RequestedAmount', num(app.amount_requested));
  put(mortgageApplication, 'MortgagePosition', num(app.request_position) ?? 1);
  put(mortgageApplication, 'RenewalDate', date(app.maturity_date));
  // Not str(created_at).slice(0,10): created_at is a TIMESTAMPTZ, so the driver
  // hands back a Date, String() gives "Sun Sep 13 2026 …", and the first ten
  // characters of that are "Sun Sep 13". Scarlett was being sent that verbatim.
  put(mortgageApplication, 'ApplicationDate', calendarDateIn(app.created_at, env.BROKERAGE_TIMEZONE));
  // Our ratios travel as figures, not as a claim Scarlett will agree — they run
  // their own. Sent because a broker opening the deal wants to see what the
  // client was shown.
  put(mortgageApplication, 'GDS', num(app.gds));
  put(mortgageApplication, 'TDS', num(app.tds));
  put(mortgageApplication, 'LTV', num(app.ltv));

  // ── Applicants ───────────────────────────────────────────────────────
  const employmentsByApplicant = new Map<string, Row[]>();
  for (const e of employments.rows) {
    const list = employmentsByApplicant.get(e.applicant_id) ?? [];
    list.push(e);
    employmentsByApplicant.set(e.applicant_id, list);
  }

  const buildAddress = (a: Row): Record<string, unknown> | undefined => {
    const out: Record<string, unknown> = {};
    put(out, 'Unit', str(a.addr_unit));
    put(out, 'StreetNumber', str(a.addr_street_number));
    put(out, 'StreetName', str(a.addr_street_name));
    put(out, 'City', str(a.addr_city));
    put(out, 'PostalCode', str(a.addr_postal).toUpperCase().replace(/\s+/g, ''));
    put(out, 'Province', code('Province', a.addr_province));
    put(out, 'Country', codeFor('Country', 'Canada', codes));
    return Object.keys(out).length ? out : undefined;
  };

  const applicantModels = applicants.rows.map((a, i) => {
    const out: Record<string, unknown> = { ApplicantOrder: i + 1, PrimaryApplicant: i === 0 };
    put(out, 'FirstName', str(a.first_name));
    put(out, 'LastName', str(a.last_name));
    put(out, 'EmailAddress', str(a.email));
    put(out, 'MobileNumber', digits(a.phone_e164));
    put(out, 'DateOfBirth', date(a.date_of_birth));
    put(out, 'NumberOfDependants', num(a.dependants));
    put(out, 'MaritalStatus', code('MaritalStatus', a.marital_status));
    put(out, 'Citizenship', code('Citizenship', a.citizenship));
    put(out, 'ResidentialStatus', code('ResidentialStatus', a.residential_status));
    put(out, 'CreditScore', code('CreditScore', a.credit_self_report));
    // No SIN. This CRM does not store one, so there is nothing to decide about.

    const address = buildAddress(a);
    if (address) {
      out.Addresses = [{
        ...address,
        CurrentAddress: true,
        YearsAtAddress: num(a.years_at_address),
        MonthlyRent: num(a.monthly_rent),
      }];
    }

    const jobs = (employmentsByApplicant.get(a.id) ?? []).map((job) => {
      const e: Record<string, unknown> = {};
      put(e, 'EmployerName', str(job.employer));
      put(e, 'JobTitle', str(job.job_title));
      put(e, 'EmploymentType', code('EmploymentType', job.employment_type));
      put(e, 'AnnualIncome', num(job.annual_income));
      put(e, 'IncomeFrequency', code('IncomeFrequency', job.income_frequency));
      put(e, 'YearsAtJob', num(job.years));
      put(e, 'EndDate', date(job.ended_on));
      e.CurrentEmployment = job.status === 'Active';
      return e;
    }).filter((e) => Object.keys(e).length > 1);
    if (jobs.length) out.EmploymentHistory = jobs;

    return out;
  });

  const orderOf = (applicantId: string | null): number | undefined => {
    if (!applicantId) return undefined;
    const index = applicants.rows.findIndex((a) => a.id === applicantId);
    return index >= 0 ? index + 1 : undefined;
  };

  const group: Record<string, unknown> = { GroupOrder: 1, Applicants: applicantModels };

  const otherIncome = incomes.rows.map((r) => {
    const o: Record<string, unknown> = {};
    put(o, 'IncomeType', code('IncomeType', r.income_type));
    put(o, 'Description', str(r.income_type || r.source));
    put(o, 'Amount', num(r.amount));
    put(o, 'Frequency', code('IncomeFrequency', r.frequency));
    put(o, 'Source', str(r.source));
    put(o, 'ApplicantOrder', orderOf(r.applicant_id));
    return o;
  }).filter((o) => Object.keys(o).length);
  if (otherIncome.length) group.OtherIncome = otherIncome;

  const assetModels = assets.rows.map((r) => {
    const o: Record<string, unknown> = {};
    put(o, 'AssetType', code('AssetType', r.asset_type));
    put(o, 'Description', str(r.asset_type));
    put(o, 'Value', num(r.value));
    put(o, 'Institution', str(r.institution));
    o.UsedForDownPayment = Boolean(r.for_down_payment);
    put(o, 'ApplicantOrder', orderOf(r.applicant_id));
    return o;
  }).filter((o) => Object.keys(o).length > 1);
  if (assetModels.length) group.Assets = assetModels;

  const liabilityModels = liabilities.rows.map((r) => {
    const o: Record<string, unknown> = {};
    put(o, 'LiabilityType', code('LiabilityType', r.liability_type));
    put(o, 'Description', str(r.liability_type));
    put(o, 'CreditorName', str(r.lender));
    put(o, 'Balance', num(r.balance));
    put(o, 'MonthlyPayment', num(r.monthly_payment));
    o.PayoffAtClosing = Boolean(r.payoff);
    put(o, 'ApplicantOrder', orderOf(r.applicant_id));
    return o;
  }).filter((o) => Object.keys(o).length > 1);
  if (liabilityModels.length) group.Liabilities = liabilityModels;

  // ── Charges, in position order ───────────────────────────────────────
  const chargesFor = (propertyId: string | null) =>
    mortgages.rows
      .filter((m) => (propertyId === null ? m.property_id === null : m.property_id === propertyId))
      .sort((a, b) => (Number(a.position) || 99) - (Number(b.position) || 99))
      .map((c) => {
        const o: Record<string, unknown> = { Position: Number(c.position) || 1 };
        put(o, 'LenderName', str(c.lender));
        put(o, 'Balance', num(c.balance));
        put(o, 'OriginalAmount', num(c.opening_balance));
        put(o, 'InterestRate', num(c.rate));
        put(o, 'MortgageType', code('MortgageType', c.rate_type));
        put(o, 'Payment', num(c.payment));
        put(o, 'PaymentFrequency', code('PaymentFrequency', c.frequency));
        put(o, 'MaturityDate', date(c.maturity));
        put(o, 'Term', str(c.term));
        return o;
      });

  const subjectProperty: Record<string, unknown> = {};
  const subjectAddress: Record<string, unknown> = {};
  put(subjectAddress, 'Unit', str(app.property_unit));
  put(subjectAddress, 'StreetNumber', str(app.property_street_number));
  put(subjectAddress, 'StreetName', str(app.property_street_name));
  put(subjectAddress, 'City', str(app.property_city));
  put(subjectAddress, 'PostalCode', str(app.property_postal_code).toUpperCase().replace(/\s+/g, ''));
  put(subjectAddress, 'Province', code('Province', app.property_province));
  put(subjectAddress, 'Country', codeFor('Country', 'Canada', codes));
  if (Object.keys(subjectAddress).length) subjectProperty.Address = subjectAddress;

  put(subjectProperty, 'PropertyType', code('PropertyType', app.property_type));
  put(subjectProperty, 'Occupancy', code('Occupancy', app.property_occupancy));
  put(subjectProperty, 'PropertyValue', num(app.property_value) ?? num(app.purchase_price));
  put(subjectProperty, 'PurchasePrice', num(app.purchase_price));
  put(subjectProperty, 'AnnualTaxes', num(app.annual_taxes));
  put(subjectProperty, 'MonthlyHeating', num(app.monthly_heat));
  put(subjectProperty, 'CondoFees', num(app.monthly_condo_fee));
  put(subjectProperty, 'RentalIncome', num(app.rental_income));
  put(subjectProperty, 'DownPayment', num(app.down_payment));
  put(subjectProperty, 'DownPaymentSource', code('DownPaymentSource', app.down_payment_source));
  put(subjectProperty, 'ClosingDate', date(app.closing_date));
  /**
   * The subject property belongs to Deal.SubjectProperty and must not also be
   * listed among the applicant's other properties: Scarlett then has the deal's
   * own security twice, once as the property being financed and once as an
   * unrelated holding, and underwrites against both.
   *
   * The portal keeps the two apart (`data.property` against
   * `data.other_properties`), so this normally removes nothing. It exists for
   * the case the portal cannot prevent — a client listing the property they are
   * financing again under "do you own other properties", which is a reasonable
   * reading of the question and produces exactly that duplicate.
   *
   * Matched on address rather than on a flag, because a re-entered property has
   * no flag; it is simply the same address typed twice.
   */
  const addressKey = (unit: unknown, number: unknown, street: unknown, city: unknown, postal: unknown) =>
    [str(unit), str(number), str(street), str(city), str(postal)]
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const subjectKey = addressKey(
    app.property_unit, app.property_street_number, app.property_street_name,
    app.property_city, app.property_postal_code,
  );
  // A postal code alone is enough to match: two different properties do not
  // share one, and a street typed slightly differently still should not slip
  // through as a second property.
  const subjectPostal = str(app.property_postal_code).toUpperCase().replace(/\s+/g, '');

  const isSubjectDuplicate = (p: Row): boolean => {
    if (!subjectKey && !subjectPostal) return false;
    const postal = str(p.postal_code).toUpperCase().replace(/\s+/g, '');
    if (subjectPostal && postal && postal === subjectPostal) return true;
    // The portal's other-property rows hold one `street` line rather than a
    // split number and name, so compare against the subject's joined form.
    const key = addressKey(null, null, p.street, p.city, p.postal_code);
    return Boolean(subjectKey && key && (key === subjectKey || subjectKey.endsWith(key)));
  };

  const duplicates = properties.rows.filter(isSubjectDuplicate);
  const otherProperties = properties.rows.filter((p) => !isSubjectDuplicate(p));

  // Its charges come with it. A duplicate row is where the client recorded the
  // mortgage being refinanced, so dropping the row silently would drop the
  // existing mortgage off the deal entirely.
  const subjectCharges = [
    ...chargesFor(null),
    ...duplicates.flatMap((p) => chargesFor(p.id)),
  ];
  if (duplicates.length) {
    warnings.push(
      `The subject property was also listed under the applicant's other properties ` +
      `(${duplicates.length === 1 ? 'once' : `${duplicates.length} times`}). It has been sent once, ` +
      `as the subject property, with its mortgage(s).`,
    );
  }
  if (subjectCharges.length) {
    subjectProperty.Mortgages = subjectCharges.map((c, i) => ({ ...c, Position: Number(c.Position) || i + 1 }));
  }

  if (otherProperties.length) {
    group.OtherProperties = otherProperties.map((p) => {
      const o: Record<string, unknown> = {};
      const addr: Record<string, unknown> = {};
      put(addr, 'StreetName', str(p.street));
      put(addr, 'City', str(p.city));
      put(addr, 'PostalCode', str(p.postal_code).toUpperCase().replace(/\s+/g, ''));
      put(addr, 'Province', code('Province', p.province));
      put(addr, 'Country', codeFor('Country', 'Canada', codes));
      if (Object.keys(addr).length) o.Address = addr;
      put(o, 'PropertyType', code('PropertyType', p.property_type));
      put(o, 'Occupancy', code('Occupancy', p.occupancy));
      put(o, 'PropertyValue', num(p.value));
      put(o, 'AnnualTaxes', num(p.annual_taxes));
      put(o, 'MonthlyHeating', num(p.monthly_heat));
      put(o, 'CondoFees', num(p.monthly_condo_fee));
      put(o, 'RentalIncome', num(p.rental_income));
      o.ToBeSold = Boolean(p.to_be_sold);
      const charges = chargesFor(p.id);
      if (charges.length) o.Mortgages = charges;
      return o;
    });
  }

  /**
   * What is being asked for, as against the charges already registered.
   *
   * Without this the deal carries the existing mortgages and no request, so
   * Scarlett has nothing to underwrite — the amount travelled only as
   * MortgageApplication.RequestedAmount, which describes the application
   * rather than the mortgage wanted on this property.
   *
   * The amount goes in TotalLoanAmount. OriginalMortgageAmount is what a
   * mortgage was advanced at, which a mortgage that does not exist yet does
   * not have.
   */
  const requested: Record<string, unknown> = {};
  put(requested, 'TotalLoanAmount', num(app.amount_requested));

  // MortgageTypeDD is the rank the new charge will take: 1 first, 2 second,
  // 3 third. It is the same figure already sent as MortgagePosition, so the two
  // cannot disagree. Anything outside 1–3 is left out rather than clamped — a
  // fourth charge is a real thing to be told about, and a confidently wrong
  // integer is the one mistake their code tables exist to prevent.
  const requestedRank = num(app.request_position) ?? 1;
  if (requestedRank >= 1 && requestedRank <= 3 && Number.isInteger(requestedRank)) {
    put(requested, 'MortgageTypeDD', requestedRank);
  } else {
    warnings.push(
      `The requested mortgage is in position ${requestedRank}, which is outside the 1–3 that ` +
      'Scarlett accepts for MortgageTypeDD, so the type has been left out of the push.',
    );
  }

  if (num(app.amount_requested) !== null) {
    subjectProperty.PropertyMortgage = { RequestedMortgages: [requested] };
  }

  const deal: Record<string, unknown> = {
    MortgageApplication: mortgageApplication,
    ApplicantGroups: [group],
    SubjectProperty: subjectProperty,
  };

  if (notes.rows.length) {
    deal.DealNotes = notes.rows.map((n) => ({
      Note: str(n.body).slice(0, 4000),
      NoteDate: new Date().toISOString().slice(0, 10),
    }));
  }

  // De-duplicate the unmapped list: one "MaritalStatus" is enough, however
  // many applicants triggered it.
  const seen = new Set<string>();
  const uniqueUnmapped = unmapped.filter((u) => {
    const key = `${u.menu}:${u.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (uniqueUnmapped.length && !codes.size) {
    blockers.push(
      'Scarlett’s code tables have never been pulled, so no dropdown value can be mapped. ' +
        'Press “Pull code tables” under Settings → Integrations → Scarlett.',
    );
  }

  return { deal, unmapped: uniqueUnmapped, blockers, warnings };
}

// ── Pushing ────────────────────────────────────────────────────────────────

export type PushResult = {
  ok: boolean;
  dealId?: string;
  error?: string;
  retryable?: boolean;
  blockers?: string[];
  unmapped?: Array<{ menu: string; value: string }>;
};

export type PushOptions = {
  actorUserId?: string | null;
  /** Send even with unmapped enums. Blockers are never bypassable. */
  acceptUnmapped?: boolean;
  /** Re-push a deal Scarlett already has. */
  overwrite?: boolean;
};

export async function pushDeal(
  organizationId: string,
  applicationId: string,
  options: PushOptions = {},
): Promise<PushResult> {
  const { ready, reason, values } = await integrationReady(organizationId, 'scarlett');
  if (!ready) return { ok: false, error: reason ?? 'Scarlett is not configured.', retryable: false };

  const existing = await queryOne<{ scarlett_deal_id: string | null }>(
    'SELECT scarlett_deal_id FROM applications WHERE id = $1 AND organization_id = $2',
    [applicationId, organizationId],
  );
  if (!existing) return { ok: false, error: 'That application does not exist.', retryable: false };

  // Duplicate prevention. A second deal for one client in a broker network is
  // not something this side can clean up.
  if (existing.scarlett_deal_id && !options.overwrite) {
    return {
      ok: false, retryable: false,
      error:
        `This file is already in Scarlett as ${existing.scarlett_deal_id}. ` +
        'Use “Re-push” if you mean to overwrite it.',
    };
  }

  const build = await buildDeal(organizationId, applicationId);
  if (build.blockers.length) {
    return { ok: false, retryable: false, blockers: build.blockers, unmapped: build.unmapped,
             error: `Not ready for Scarlett: ${build.blockers.join(' ')}` };
  }
  if (build.unmapped.length && !options.acceptUnmapped) {
    return {
      ok: false, retryable: false, unmapped: build.unmapped,
      error:
        `${build.unmapped.length} field(s) could not be mapped to a Scarlett code and would be ` +
        'left out: ' + build.unmapped.map((u) => `${u.menu} “${u.value}”`).join(', ') +
        '. Pull the code tables, add an override, or push anyway.',
    };
  }

  const body: Record<string, unknown> = {
    FirmCode: str(values.firm_code),
    ExpertLogin: str(values.expert_login),
    Deal: build.deal,
    OverwriteIfExist: Boolean(options.overwrite),
  };
  if (str(values.db_name)) body.DBName = str(values.db_name);
  if (str(values.pipeline_stage_id)) body.PipelineStageID = str(values.pipeline_stage_id);
  if (values.notification_flag !== undefined) body.NotificationFlag = Boolean(values.notification_flag);

  const attempt = await nextAttempt(applicationId);
  const response = await call(values, 'dosconnect/deal-push', body);
  const dealId = response.ok ? findDealId(response.body) : null;

  await query(
    `INSERT INTO scarlett_syncs (organization_id, application_id, operation, attempt,
                                 request_payload, response_payload, http_status, ok,
                                 error_message, scarlett_deal_id, duration_ms, actor_user_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
    [
      organizationId, applicationId, existing.scarlett_deal_id ? 'update' : 'create', attempt,
      // The payload is kept because when a push fails at 6pm on a Friday the
      // question is always "what did we actually send".
      JSON.stringify(body), JSON.stringify(response.body), response.status,
      response.ok && Boolean(dealId), response.error ?? null, dealId,
      response.durationMs, options.actorUserId ?? null,
    ],
  );

  if (!response.ok) {
    await query(
      `UPDATE applications SET scarlett_sync_state = 'error', scarlett_last_error = $2,
                               scarlett_synced_at = now()
        WHERE id = $1`,
      [applicationId, response.error ?? 'Unknown error'],
    );
    return { ok: false, error: response.error, retryable: response.retryable };
  }

  if (!dealId) {
    // Their success response is undocumented. If no id can be found the push
    // may well have worked, and saying so is more honest than either claiming
    // success or reporting a failure that would cause a duplicate on retry.
    await query(
      `UPDATE applications SET scarlett_sync_state = 'stale', scarlett_synced_at = now(),
                               scarlett_last_error = $2
        WHERE id = $1`,
      [applicationId,
       'Scarlett accepted the deal but returned no id. Check Scarlett before pushing again.'],
    );
    return {
      ok: false, retryable: false,
      error:
        'Scarlett accepted the deal but returned no deal id, so it cannot be linked here. ' +
        'Check in Scarlett whether it arrived before pushing again — pushing twice creates two deals.',
    };
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE applications
          SET scarlett_deal_id = $2, scarlett_sync_state = 'ok', scarlett_synced_at = now(),
              scarlett_pushed_at = COALESCE(scarlett_pushed_at, now()),
              scarlett_pushed_by = COALESCE(scarlett_pushed_by, $3),
              scarlett_last_error = NULL, last_activity_at = now()
        WHERE id = $1`,
      [applicationId, dealId, options.actorUserId ?? null],
    );
    await client.query(
      `INSERT INTO activity (organization_id, application_id, customer_id, kind, actor_user_id,
                             actor_kind, actor_name, summary, detail)
       SELECT $1, id, customer_id, 'scarlett', $2, $3, $4, $5, $6::jsonb
         FROM applications WHERE id = $7`,
      [
        organizationId, options.actorUserId ?? null,
        options.actorUserId ? 'user' : 'system', 'Scarlett',
        `Pushed to Scarlett as ${dealId}`,
        JSON.stringify({ dealId, unmapped: build.unmapped, warnings: build.warnings }),
        applicationId,
      ],
    );
  });

  log.info('scarlett deal pushed', { applicationId, dealId, unmapped: build.unmapped.length });
  return { ok: true, dealId, unmapped: build.unmapped };
}

async function nextAttempt(applicationId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM scarlett_syncs WHERE application_id = $1`,
    [applicationId],
  );
  return row?.n ?? 1;
}

/**
 * Settings → Integrations → Test.
 *
 * `dropdown-pull` rather than a push: it proves the host, the key and the
 * account without creating anything, and its answer is useful in its own
 * right.
 */
export async function testScarlett(
  organizationId: string,
): Promise<{ ok: boolean; message: string }> {
  const resolved = await resolveIntegration(organizationId, 'scarlett');
  if (resolved.missing.length) {
    return { ok: false, message: `Missing: ${resolved.missing.join(', ')}.` };
  }
  const result = await pullCodes(organizationId);
  return { ok: result.ok, message: result.message };
}
