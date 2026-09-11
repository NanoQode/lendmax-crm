/**
 * The portal importer.
 *
 * This is written against the real contract, read from the live portal's
 * `lib/mirror.js` rather than inferred:
 *
 *   POST {main}/api/internal/mirror
 *   x-internal-key: <shared secret>
 *   → { ok: true, created, changed, id }   |   { ok: false, error }
 *
 * Four properties of that contract shape everything below.
 *
 * 1. **It pushes from the first answer, not on submit.** A file that stalls at
 *    Income is visible while it is still worth a phone call. So an import must
 *    cope with almost every field being absent, and must never treat a partial
 *    application as invalid.
 *
 * 2. **The same change arrives more than once, by design.** There is an
 *    immediate push after every save *and* a thirty-second reconciliation
 *    sweep. So the import is idempotent on the payload hash, and every domain
 *    event key is derived from the CHANGE rather than from the clock — a key
 *    built from `Date.now()` looks fine in testing and double-enrols people in
 *    production.
 *
 * 3. **It is a mirror, not a handover.** The portal keeps owning the
 *    application, the documents and the applicant's email. Nothing here writes
 *    back, and nothing here re-sends anything to the client.
 *
 * 4. **A ratio arrives with its working.** `computeRatios` in the portal
 *    records every income, shelter and debt line as it adds it. Those line
 *    items are stored and displayed as received. Recomputing here would
 *    produce a second number that disagrees with the one the client was shown.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '../db/pool.ts';
import { log } from '../lib/logger.ts';
import { toE164 } from '../lib/phone.ts';
import { recordAudit } from './audit.ts';
import { applyAssignmentRules } from './assignment.ts';

// ── The payload, as the portal actually sends it ───────────────────────────

export type MirrorDocument = {
  id: number | string;
  filename?: string | null;
  category?: string | null;
  size_bytes?: number | null;
  content_type?: string | null;
  uploaded_at?: string | null;
};

export type MirrorPayload = {
  portal_id?: number | string;
  reference: string;
  status?: string;
  percent?: number;
  current_section?: string | null;
  current_section_label?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  purpose?: string | null;
  amount_requested?: number | null;
  property_city?: string | null;
  property_province?: string | null;
  applicant_count?: number;
  document_count?: number;
  lead_source?: string | null;
  lead_campaign?: string | null;
  source_raw?: Record<string, unknown> | null;
  ratios?: Record<string, unknown> | null;
  progress?: Record<string, unknown> | null;
  documents?: MirrorDocument[];
  scarlett_app_id?: string | null;
  scarlett_status?: string | null;
  data?: Record<string, any>;
  created_at?: string | null;
  updated_at?: string | null;
  submitted_at?: string | null;
  hash?: string;
};

export type ImportResult = {
  id: string;
  created: boolean;
  changed: boolean;
  changedFields: Record<string, { from: unknown; to: unknown }>;
  customerId: string;
  duplicates: number;
};

// ── Coercion ───────────────────────────────────────────────────────────────
// The portal is another service with its own idea of types. Everything that
// crosses the wire is coerced once, here, rather than each consumer guessing.

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/**
 * Money arrives as a number, a numeric string, or "$785,000".
 *
 * Anything with no digit in it is null, not zero. Stripping the non-numeric
 * characters out of "not a number" leaves an empty string, and `Number('')` is
 * `0` — so without the digit check, garbage becomes a real $0 that flows into
 * pipeline totals and commission arithmetic as though somebody had typed it.
 * "We do not know" and "nothing" are different facts.
 */
const money = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A calendar date, or null.
 *
 * Anything that is not a clean YYYY-MM-DD is refused rather than coerced. A
 * half-parsed date on a closing field drives task priority, the board and
 * three alerts; being wrong is worse than being absent, and absent is visible.
 */
const date = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const iso = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return iso;
};

const bool = (v: unknown): boolean => v === true || v === 'true' || v === 'Yes' || v === 1 || v === '1';

const ts = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Total of the charges already registered on a property. */
function sumCharges(charges: unknown): number | null {
  if (!Array.isArray(charges) || charges.length === 0) return null;
  let total = 0;
  let any = false;
  for (const m of charges) {
    const balance = money((m as Record<string, unknown>)?.balance);
    if (balance !== null) { total += balance; any = true; }
  }
  return any ? total : null;
}

/** The portal's own hash, or one computed the same way if it did not send it. */
export function payloadHash(payload: MirrorPayload): string {
  if (payload.hash) return payload.hash;
  const { hash, ...rest } = payload;
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex');
}

// ── Summary fields we track changes on ─────────────────────────────────────
// Only the fields a change in which means something downstream. Diffing the
// whole record would report a change on every keystroke the applicant makes.

const TRACKED = [
  'portal_status', 'percent_complete', 'portal_current_section', 'submitted_at',
  'document_count', 'amount_requested', 'purpose', 'closing_date', 'scarlett_deal_id',
] as const;

/**
 * Map the portal's four-value purpose onto a CRM transaction type.
 *
 * Only when the CRM has none yet: a broker who has classified a file as a
 * first-time buyer must not have it reset to a plain purchase by the next
 * mirror push. Several CRM types share one portal purpose, so this is a
 * default, not an authority.
 */
async function defaultTransactionType(
  client: pg.PoolClient,
  organizationId: string,
  purpose: string | null,
): Promise<string | null> {
  if (!purpose) return null;
  const { rows } = await client.query<{ key: string }>(
    `SELECT key FROM transaction_types
      WHERE organization_id = $1 AND active AND portal_purpose = $2
      ORDER BY position LIMIT 1`,
    [organizationId, purpose],
  );
  return rows[0]?.key ?? null;
}

/**
 * Find or create the customer behind the primary applicant.
 *
 * Matching is on normalised phone first, then lower-cased email — a phone
 * number is the more reliable of the two because households share addresses
 * and occasionally email accounts, and because it is what an inbound text
 * arrives on.
 *
 * A near-match is FLAGGED, never merged. Merging two people's mortgage files
 * because they share a household is not undoable.
 */
async function resolveCustomer(
  client: pg.PoolClient,
  organizationId: string,
  payload: MirrorPayload,
): Promise<{ customerId: string; duplicates: number }> {
  const email = str(payload.email)?.toLowerCase() ?? null;
  const phone = toE164(payload.phone);
  const firstName = str(payload.first_name);
  const lastName = str(payload.last_name);

  const { rows: matches } = await client.query<{ id: string; email: string | null; phone_e164: string | null }>(
    `SELECT id, email, phone_e164 FROM customers
      WHERE organization_id = $1 AND merged_into_id IS NULL
        AND ( ($2::text IS NOT NULL AND phone_e164 = $2)
           OR ($3::text IS NOT NULL AND lower(email) = $3) )
      ORDER BY created_at LIMIT 10`,
    [organizationId, phone, email],
  );

  if (matches.length === 0) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO customers (organization_id, first_name, last_name, email, phone_e164,
                              phone_raw, lead_source, utm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
      [
        organizationId, firstName, lastName, email, phone, str(payload.phone),
        str(payload.lead_source) ?? 'portal',
        JSON.stringify(payload.source_raw ?? {}),
      ],
    );
    return { customerId: rows[0]!.id, duplicates: 0 };
  }

  const primary = matches[0]!;

  // Fill in what we did not have before; never overwrite something already
  // there with something emptier.
  await client.query(
    `UPDATE customers
        SET first_name = COALESCE(first_name, $2),
            last_name  = COALESCE(last_name, $3),
            email      = COALESCE(email, $4),
            phone_e164 = COALESCE(phone_e164, $5),
            phone_raw  = COALESCE(phone_raw, $6)
      WHERE id = $1`,
    [primary.id, firstName, lastName, email, phone, str(payload.phone)],
  );

  // Everything else that matched is a duplicate candidate for a person to look at.
  let duplicates = 0;
  for (const other of matches.slice(1)) {
    const matchedOn: string[] = [];
    if (phone && other.phone_e164 === phone) matchedOn.push('phone');
    if (email && other.email?.toLowerCase() === email) matchedOn.push('email');
    const inserted = await client.query(
      `INSERT INTO duplicate_candidates (organization_id, customer_id, duplicate_of_id,
                                         matched_on, confidence)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (customer_id, duplicate_of_id) DO NOTHING`,
      [organizationId, other.id, primary.id, matchedOn, matchedOn.length >= 2 ? 95 : 70],
    );
    duplicates += inserted.rowCount ?? 0;
  }

  return { customerId: primary.id, duplicates };
}

// ── Child rows ─────────────────────────────────────────────────────────────

/**
 * Replace the normalised detail wholesale.
 *
 * Delete-and-reinsert rather than a per-row diff: the portal owns this data
 * absolutely, the rows are small, and a diff would need a stable identity per
 * repeater entry that the portal does not send. `portal_path` records where
 * each row came from so a human can trace it back to the form.
 */
async function replaceChildren(
  client: pg.PoolClient,
  applicationId: string,
  customerId: string,
  data: Record<string, any>,
): Promise<void> {
  // Order matters: employments and the rest reference applicants.
  for (const table of [
    'application_mortgages', 'application_employments', 'application_incomes',
    'application_assets', 'application_liabilities', 'application_properties',
    'application_applicants',
  ]) {
    await client.query(`DELETE FROM ${table} WHERE application_id = $1`, [applicationId]);
  }

  const applicants: any[] = Array.isArray(data.applicants) ? data.applicants : [];
  // The portal's repeaters reference an applicant by index; resolved to a real
  // id here so nothing downstream has to know about array positions.
  const applicantIds: string[] = [];

  for (const [i, a] of applicants.entries()) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO application_applicants
         (application_id, customer_id, position, applicant_role, first_name, last_name,
          email, phone_e164, date_of_birth, marital_status, dependants, citizenship,
          credit_self_report, addr_street_number, addr_street_name, addr_unit, addr_city,
          addr_province, addr_postal, residential_status, monthly_rent, years_at_address,
          prev_address, portal_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING id`,
      [
        applicationId,
        // Only the primary applicant is linked to the customer record; a
        // co-applicant gets their own customer only if they later become one.
        i === 0 ? customerId : null,
        i,
        i === 0 ? 'applicant' : 'co_applicant',
        str(a.first_name), str(a.last_name), str(a.email)?.toLowerCase() ?? null,
        toE164(a.phone), date(a.dob), str(a.marital_status), num(a.dependants),
        str(a.citizenship), str(a.credit_self),
        str(a.addr_street_number), str(a.addr_street_name), str(a.addr_unit),
        str(a.addr_city), str(a.addr_province), str(a.addr_postal),
        str(a.residential_status), money(a.monthly_rent), num(a.years_at_address),
        str(a.prev_address), `applicants[${i}]`,
      ],
    );
    const applicantId = rows[0]!.id;
    applicantIds.push(applicantId);

    // The employment declared on the applicant record itself.
    if (str(a.employer) || str(a.employment_type) || money(a.annual_income) !== null) {
      await client.query(
        `INSERT INTO application_employments
           (application_id, applicant_id, position, slot, status, employment_type,
            employment_basis, employer, job_title, years, annual_income, income_frequency,
            portal_path)
         VALUES ($1,$2,0,'primary','Active',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          applicationId, applicantId, str(a.employment_type), str(a.employment_basis),
          str(a.employer), str(a.job_title), num(a.years_employed), money(a.annual_income),
          str(a.income_frequency), `applicants[${i}]`,
        ],
      );
    }

    // …and the portal's "other employment" repeater, in the same table.
    const more: any[] = Array.isArray(a.employments) ? a.employments : [];
    for (const [j, e] of more.entries()) {
      await client.query(
        `INSERT INTO application_employments
           (application_id, applicant_id, position, slot, status, employment_type,
            employment_basis, employer, job_title, years, annual_income, ended_on, portal_path)
         VALUES ($1,$2,$3,'additional',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          applicationId, applicantId, j + 1,
          str(e.status) === 'Previous' ? 'Previous' : 'Active',
          str(e.employment_type), str(e.employment_basis), str(e.employer), str(e.job_title),
          num(e.years), money(e.annual_income), date(e.ended),
          `applicants[${i}].employments[${j}]`,
        ],
      );
    }
  }

  /** The portal references an applicant by index; null when it is out of range. */
  const ownerOf = (v: unknown): string | null => {
    const idx = num(v);
    if (idx === null) return null;
    return applicantIds[idx] ?? null;
  };

  for (const [i, r] of (Array.isArray(data.income) ? data.income : []).entries()) {
    await client.query(
      `INSERT INTO application_incomes
         (application_id, applicant_id, position, income_type, amount, frequency, source,
          years_receiving, portal_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [applicationId, ownerOf(r.applicant), i, str(r.income_type), money(r.amount),
       str(r.frequency), str(r.source), num(r.years_receiving), `income[${i}]`],
    );
  }

  for (const [i, r] of (Array.isArray(data.assets) ? data.assets : []).entries()) {
    await client.query(
      `INSERT INTO application_assets
         (application_id, applicant_id, position, asset_type, value, institution,
          for_down_payment, portal_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [applicationId, ownerOf(r.applicant), i, str(r.asset_type), money(r.value),
       str(r.institution), bool(r.for_down_payment), `assets[${i}]`],
    );
  }

  for (const [i, r] of (Array.isArray(data.liabilities) ? data.liabilities : []).entries()) {
    await client.query(
      `INSERT INTO application_liabilities
         (application_id, applicant_id, position, liability_type, lender, balance,
          monthly_payment, payoff, portal_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      // `payoff` is mirrored, never inferred: a liability being paid out with
      // the mortgage is excluded from TDS, and that exclusion is the deal.
      [applicationId, ownerOf(r.applicant), i, str(r.liability_type), str(r.lender),
       money(r.balance), money(r.payment), bool(r.payoff), `liabilities[${i}]`],
    );
  }

  for (const [i, r] of (Array.isArray(data.other_properties) ? data.other_properties : []).entries()) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO application_properties
         (application_id, applicant_id, position, street, city, province, postal_code,
          property_type, occupancy, value, annual_taxes, monthly_heat, monthly_condo_fee,
          rental_income, to_be_sold, has_mortgage, portal_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        applicationId, ownerOf(r.applicant), i, str(r.street), str(r.city), str(r.province),
        str(r.postal_code), str(r.home_type), str(r.occupancy), money(r.value),
        money(r.annual_taxes), money(r.monthly_heat), money(r.condo_fee), money(r.rental_income),
        bool(r.to_be_sold), bool(r.has_mortgage), `other_properties[${i}]`,
      ],
    );
    await insertCharges(
      client, applicationId, rows[0]!.id, r.mortgages, `other_properties[${i}].mortgages`,
    );
  }

  // Charges on the SUBJECT property carry a null property_id.
  await insertCharges(client, applicationId, null, data.property?.mortgages, 'property.mortgages');
}

/**
 * One property's registered charges, in the order they were entered.
 *
 * Up to three, per the portal. Position matters more than order — what sits
 * ahead of the money being asked for is counted in the loan-to-value and what
 * is being replaced is not — so `position` is stored as given rather than
 * inferred from the array index.
 */
async function insertCharges(
  client: pg.PoolClient,
  applicationId: string,
  propertyId: string | null,
  charges: unknown,
  pathPrefix: string,
): Promise<void> {
  if (!Array.isArray(charges)) return;
  for (const [i, m] of charges.entries()) {
    if (!m || typeof m !== 'object') continue;
    const c = m as Record<string, unknown>;
    // A wholly blank repeater row is the applicant having opened one and not
    // filled it in. Storing it would show a broker a mortgage that does not
    // exist.
    if (!str(c.lender) && money(c.balance) === null && money(c.payment) === null) continue;
    await client.query(
      `INSERT INTO application_mortgages
         (application_id, property_id, seq, position, loan_type, lender, balance,
          opening_balance, rate, term, maturity, payment, frequency, rate_type, portal_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        applicationId, propertyId, i, str(c.position), str(c.loan_type), str(c.lender),
        money(c.balance), money(c.opening_balance), num(c.rate), str(c.term),
        date(c.maturity), money(c.payment), str(c.frequency), str(c.rate_type),
        `${pathPrefix}[${i}]`,
      ],
    );
  }
}

/**
 * The document manifest.
 *
 * A manifest, not the files. The portal owns the bytes, serves them and backs
 * them up; holding a second copy of somebody's passport here would double the
 * places it can leak from. `storage_driver='portal'` and the portal's own id in
 * `storage_key` are what let a download stream back through the portal.
 */
async function syncDocumentManifest(
  client: pg.PoolClient,
  organizationId: string,
  applicationId: string,
  customerId: string,
  documents: MirrorDocument[],
): Promise<number> {
  let added = 0;
  for (const doc of documents) {
    const key = String(doc.id);
    const { rowCount } = await client.query(
      `INSERT INTO documents
         (organization_id, application_id, customer_id, category_key, filename,
          display_label, mime_type, byte_size, storage_driver, storage_key, source,
          uploaded_at, scan_status)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,'portal',$8,'portal',COALESCE($9::timestamptz, now()),'skipped')
       ON CONFLICT (application_id, storage_key) WHERE storage_driver = 'portal' DO NOTHING`,
      [
        organizationId, applicationId, customerId, str(doc.category),
        str(doc.filename) ?? `document-${key}`, str(doc.content_type),
        num(doc.size_bytes), key, str(doc.uploaded_at),
      ],
    );
    added += rowCount ?? 0;
  }
  return added;
}

// ── The import ─────────────────────────────────────────────────────────────

export type ImportOptions = {
  organizationId: string;
  /** Skip the unchanged-hash short circuit. Used by a manual re-import. */
  force?: boolean;
};

export async function importMirrorPayload(
  payload: MirrorPayload,
  options: ImportOptions,
): Promise<ImportResult & { unchanged?: boolean }> {
  const { organizationId } = options;
  const reference = str(payload.reference);
  if (!reference) throw new Error('A mirrored application needs a reference.');

  const hash = payloadHash(payload);
  const data: Record<string, any> = payload.data ?? {};
  const purpose = data.purpose ?? {};
  const property = data.property ?? {};
  const ratios = (payload.ratios ?? {}) as Record<string, unknown>;

  return withTransaction(async (client) => {
    const { rows: existingRows } = await client.query<Record<string, any>>(
      `SELECT id, customer_id, mirror_hash, portal_status, percent_complete,
              portal_current_section, submitted_at, document_count, amount_requested,
              purpose, closing_date, scarlett_deal_id, transaction_type_key, stage_key
         FROM applications
        WHERE organization_id = $1 AND portal_reference = $2
        FOR UPDATE`,
      [organizationId, reference],
    );
    const existing = existingRows[0] ?? null;

    // Idempotency. The portal pushes immediately AND sweeps every thirty
    // seconds, so the same payload genuinely does arrive twice.
    if (existing && existing.mirror_hash === hash && !options.force) {
      return {
        id: existing.id, created: false, changed: false, changedFields: {},
        customerId: existing.customer_id, duplicates: 0, unchanged: true,
      };
    }

    const { customerId, duplicates } = await resolveCustomer(client, organizationId, payload);

    const fields = {
      portal_id: num(payload.portal_id),
      portal_status: str(payload.status),
      percent_complete: Math.max(0, Math.min(100, Math.round(num(payload.percent) ?? 0))),
      portal_current_section: str(payload.current_section),
      portal_current_section_label: str(payload.current_section_label),
      purpose: str(payload.purpose) ?? str(purpose.purpose),
      amount_requested: money(payload.amount_requested) ?? money(purpose.amount_requested),
      timing: str(purpose.timing),
      existing_lender: str(purpose.existing_lender),
      refi_reason: str(purpose.refi_reason),
      // The position of the money being asked for. Not a detail: it decides
      // whether the loan-to-value is this money alone or this money on top of
      // a charge that stays registered ahead of it.
      request_position: str(purpose.request_position),
      request_loan_type: str(purpose.request_loan_type),
      // A client's declared maturity on an existing mortgage is a renewal
      // opportunity the brokerage already has — not merely a form field.
      declared_maturity: date(purpose.maturity_date),

      property_street_number: str(property.street_number),
      property_street_name: str(property.street_name),
      property_unit: str(property.unit),
      property_city: str(payload.property_city) ?? str(property.city),
      property_province: str(payload.property_province) ?? str(property.province),
      property_postal_code: str(property.postal_code),
      property_type: str(property.home_type),
      property_occupancy: str(property.occupancy),
      purchase_price: money(property.purchase_price),
      property_value: money(property.property_value),
      down_payment: money(property.down_payment),
      down_payment_source: str(property.down_source),
      // The portal no longer has a flat existing balance: it has a charges
      // repeater. Summed here purely so the list and the board have one number
      // to show; the charges themselves are the record.
      existing_balance: money(property.existing_balance) ?? sumCharges(property.mortgages),
      annual_taxes: money(property.annual_taxes),
      monthly_heat: money(property.monthly_heat),
      monthly_condo_fee: money(property.condo_fee),
      rental_income: money(property.rental_income),
      closing_date: date(property.closing_date),

      applicant_count: num(payload.applicant_count) ?? (Array.isArray(data.applicants) ? data.applicants.length : 0),
      document_count: num(payload.document_count) ?? (payload.documents?.length ?? 0),

      // Displayed as received. The portal calculated these once and recorded
      // its own working; a second version computed here would disagree.
      gds: num(ratios.gds),
      tds: num(ratios.tds),
      ltv: num(ratios.ltv),
      qualifying_payment: money(ratios.mortgage_payment),
      qualifying_rate: num(ratios.qualifying_rate),
      monthly_income: money(ratios.monthly_income),
      shelter_cost: money(ratios.shelter_cost),
      other_debt_payments: money(ratios.other_debt),
      charges_ahead: money(ratios.charges_ahead),

      scarlett_deal_id: str(payload.scarlett_app_id),
      scarlett_status: str(payload.scarlett_status),
      submitted_at: ts(payload.submitted_at),
    };

    let applicationId: string;
    let created = false;

    /**
     * The columns this importer owns, as a map.
     *
     * Built as an object rather than a hand-numbered positional INSERT. That
     * statement reached fifty columns and adding two to it silently produced
     * "INSERT has more target columns than expressions" — the placeholder
     * numbering is not something a person can keep correct by hand, and it
     * should not have to be.
     */
    const owned: Record<string, unknown> = {
      portal_status: fields.portal_status,
      portal_data: JSON.stringify(data),
      portal_ratios: JSON.stringify(payload.ratios ?? null),
      portal_progress: JSON.stringify(payload.progress ?? null),
      mirror_hash: hash,
      last_mirror_status: 'accepted',
      portal_current_section: fields.portal_current_section,
      portal_current_section_label: fields.portal_current_section_label,
      portal_document_manifest: JSON.stringify(payload.documents ?? []),
      purpose: fields.purpose,
      amount_requested: fields.amount_requested,
      timing: fields.timing,
      existing_lender: fields.existing_lender,
      refi_reason: fields.refi_reason,
      request_position: fields.request_position,
      request_loan_type: fields.request_loan_type,
      property_street_number: fields.property_street_number,
      property_street_name: fields.property_street_name,
      property_unit: fields.property_unit,
      property_city: fields.property_city,
      property_province: fields.property_province,
      property_postal_code: fields.property_postal_code,
      property_type: fields.property_type,
      property_occupancy: fields.property_occupancy,
      purchase_price: fields.purchase_price,
      property_value: fields.property_value,
      down_payment: fields.down_payment,
      down_payment_source: fields.down_payment_source,
      existing_balance: fields.existing_balance,
      annual_taxes: fields.annual_taxes,
      monthly_heat: fields.monthly_heat,
      monthly_condo_fee: fields.monthly_condo_fee,
      rental_income: fields.rental_income,
      closing_date: fields.closing_date,
      percent_complete: fields.percent_complete,
      applicant_count: fields.applicant_count,
      document_count: fields.document_count,
      gds: fields.gds,
      tds: fields.tds,
      ltv: fields.ltv,
      qualifying_payment: fields.qualifying_payment,
      qualifying_rate: fields.qualifying_rate,
      monthly_income: fields.monthly_income,
      shelter_cost: fields.shelter_cost,
      other_debt_payments: fields.other_debt_payments,
      charges_ahead: fields.charges_ahead,
      scarlett_status: fields.scarlett_status,
    };

    /** Columns that are jsonb, so the placeholder needs a cast. */
    const JSONB = new Set([
      'portal_data', 'portal_ratios', 'portal_progress', 'portal_document_manifest',
    ]);
    const cast = (column: string, index: number) =>
      JSONB.has(column) ? `$${index}::jsonb` : `$${index}`;

    if (!existing) {
      // A new file lands on the first active stage. It is not forced onto one
      // later: a broker who has moved a file must not have the next mirror
      // push drag it back.
      const { rows: stageRows } = await client.query<{ key: string }>(
        `SELECT key FROM pipeline_stages WHERE organization_id = $1 AND active
          ORDER BY position LIMIT 1`,
        [organizationId],
      );
      const transactionType = await defaultTransactionType(client, organizationId, fields.purpose);

      const insert: Record<string, unknown> = {
        ...owned,
        organization_id: organizationId,
        customer_id: customerId,
        portal_reference: reference,
        portal_id: fields.portal_id,
        portal_lead_source: str(payload.lead_source),
        portal_lead_campaign: str(payload.lead_campaign),
        transaction_type_key: transactionType,
        scarlett_deal_id: fields.scarlett_deal_id,
        submitted_at: fields.submitted_at,
        stage_key: stageRows[0]?.key ?? null,
        created_at: ts(payload.created_at) ?? new Date(),
      };

      const columns = Object.keys(insert);
      const values = columns.map((c) => insert[c]);
      const placeholders = columns.map((c, i) => cast(c, i + 1));

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO applications (${columns.join(', ')},
                                   mirrored_at, stage_changed_at, last_activity_at, first_seen_at)
         VALUES (${placeholders.join(', ')}, now(), now(), now(), now())
         RETURNING id`,
        values,
      );
      applicationId = rows[0]!.id;
      created = true;

      // A new file gets an owner here, in the same transaction. Without it
      // nobody is notified when the client uploads, it shows on no priority
      // list, and no staleness rule watches it.
      await applyAssignmentRules(client, organizationId, {
        applicationId,
        province: fields.property_province,
        transactionType,
        purpose: fields.purpose,
      });
    } else {
      applicationId = existing.id;
      const update: Record<string, unknown> = { ...owned };

      const columns = Object.keys(update);
      const values = columns.map((c) => update[c]);
      const assignments = columns.map((c, i) => `${c} = ${cast(c, i + 1)}`);

      // These three are not plain assignments, so they are written out.
      //   · portal_id only ever fills a blank
      //   · the portal's Scarlett id only fills a blank — if the CRM pushed
      //     the deal, the CRM's id is the authority
      //   · submitted_at never un-submits
      //   · transaction_type_key is deliberately absent: a broker's
      //     classification must survive the next push
      values.push(fields.portal_id, fields.scarlett_deal_id, fields.submitted_at,
                  str(payload.lead_source), str(payload.lead_campaign), applicationId);
      const n = columns.length;
      await client.query(
        `UPDATE applications SET ${assignments.join(', ')},
                portal_id = COALESCE($${n + 1}, portal_id),
                scarlett_deal_id = COALESCE(scarlett_deal_id, $${n + 2}),
                submitted_at = COALESCE(submitted_at, $${n + 3}),
                portal_lead_source = COALESCE($${n + 4}, portal_lead_source),
                portal_lead_campaign = COALESCE($${n + 5}, portal_lead_campaign),
                mirrored_at = now(),
                last_activity_at = now()
          WHERE id = $${n + 6}`,
        values,
      );
    }

    await replaceChildren(client, applicationId, customerId, data);
    await syncDocumentManifest(
      client, organizationId, applicationId, customerId, payload.documents ?? [],
    );

    // The consent the applicant gave on the review step. Transactional only —
    // the portal's single acceptance toggle covers contact about THIS
    // application and is not a marketing basis. Treating it as one would be
    // the most consequential mistake this importer could make.
    const review = data.review ?? {};
    if (bool(review.consent)) {
      await client.query(
        `INSERT INTO consents (organization_id, customer_id, application_id, channel, purpose,
                               basis, granted, consent_text, consent_version, source,
                               source_detail, actor_kind, collected_at)
         SELECT $1,$2,$3,'any','transactional','express',true,$4,$5,'portal_application',$6,'client',
                COALESCE($7::timestamptz, now())
          WHERE NOT EXISTS (
            SELECT 1 FROM consents
             WHERE customer_id = $2 AND application_id = $3
               AND purpose = 'transactional' AND source = 'portal_application')`,
        [
          organizationId, customerId, applicationId,
          'Client Consent, Privacy & Product Suitability Agreement (portal review step)',
          str(data.consent_version) ?? 'portal-v1', reference, ts(payload.created_at),
        ],
      );
    }

    // What actually changed, for the events below and for the log.
    const changedFields: Record<string, { from: unknown; to: unknown }> = {};
    if (existing) {
      const now: Record<string, unknown> = {
        portal_status: fields.portal_status,
        percent_complete: fields.percent_complete,
        portal_current_section: fields.portal_current_section,
        submitted_at: fields.submitted_at?.toISOString() ?? null,
        document_count: fields.document_count,
        amount_requested: fields.amount_requested,
        purpose: fields.purpose,
        closing_date: fields.closing_date,
        scarlett_deal_id: fields.scarlett_deal_id,
      };
      for (const key of TRACKED) {
        const before = existing[key] instanceof Date
          ? (existing[key] as Date).toISOString()
          : existing[key] === null ? null : existing[key];
        const after = now[key] ?? null;
        // Loose comparison across the number/string boundary, because a
        // NUMERIC comes back as a string and would otherwise "change" on
        // every single push.
        if (String(before ?? '') !== String(after ?? '')) {
          changedFields[key] = { from: before, to: after };
        }
      }
    }

    const changed = created || Object.keys(changedFields).length > 0;

    // Domain events, keyed on the CHANGE rather than the clock. The portal
    // sends the same change more than once by design; a key built from
    // Date.now() looks fine in testing and double-enrols people in production.
    const events: Array<{ type: string; key: string; payload: Record<string, unknown> }> = [];
    if (created) {
      events.push({
        type: 'application.created',
        key: `created:${reference}`,
        payload: { reference, percent: fields.percent_complete },
      });
    } else {
      if (changedFields.portal_status) {
        events.push({
          type: 'application.status_changed',
          key: `status:${reference}:${changedFields.portal_status.to}`,
          payload: { reference, ...changedFields.portal_status },
        });
      }
      if (changedFields.submitted_at?.to) {
        events.push({
          type: 'application.submitted',
          key: `submitted:${reference}`,
          payload: { reference },
        });
      }
      if (
        changedFields.document_count &&
        Number(changedFields.document_count.to ?? 0) > Number(changedFields.document_count.from ?? 0)
      ) {
        events.push({
          type: 'document.uploaded',
          key: `docs:${reference}:${changedFields.document_count.to}`,
          payload: { reference, count: changedFields.document_count.to },
        });
      }
      if (changedFields.percent_complete || changedFields.portal_current_section) {
        events.push({
          type: 'application.section_saved',
          key: `section:${reference}:${fields.portal_current_section}:${fields.percent_complete}`,
          payload: {
            reference,
            section: fields.portal_current_section,
            section_label: fields.portal_current_section_label,
            percent: fields.percent_complete,
          },
        });
      }
      if (fields.percent_complete >= 100 && (existing?.percent_complete ?? 0) < 100) {
        events.push({
          type: 'application.completed',
          key: `completed:${reference}`,
          payload: { reference },
        });
      }
    }

    for (const event of events) {
      await client.query(
        `INSERT INTO domain_events (organization_id, event_type, customer_id, application_id,
                                    payload, dedupe_key)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [organizationId, event.type, customerId, applicationId,
         JSON.stringify(event.payload), `${event.type}:${event.key}`],
      );
    }

    if (changed) {
      const summary = created
        ? `Application ${reference} arrived from the portal`
        : `Portal updated ${reference}: ${Object.keys(changedFields).join(', ')}`;
      await client.query(
        `INSERT INTO activity (organization_id, application_id, customer_id, kind,
                               actor_kind, actor_name, summary, detail)
         VALUES ($1,$2,$3,$4,'client','Applicant',$5,$6::jsonb)`,
        [organizationId, applicationId, customerId,
         created ? 'application' : 'portal_update', summary, JSON.stringify(changedFields)],
      );
      await client.query(
        `UPDATE applications SET last_activity_at = now() WHERE id = $1`, [applicationId],
      );
    }

    if (created) {
      await recordAudit(
        {
          organizationId,
          actor: { kind: 'integration', name: 'apply.lendmax.ca' },
          action: 'application.imported',
          entityType: 'application',
          entityId: applicationId,
          summary: `Imported application ${reference} from the portal`,
          after: { reference, percent: fields.percent_complete, status: fields.portal_status },
        },
        client,
      );
    }

    await client.query(
      `INSERT INTO portal_mirror_log (organization_id, application_id, reference,
                                      payload_hash, outcome, changed_fields)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [organizationId, applicationId, reference, hash,
       created ? 'created' : changed ? 'updated' : 'unchanged', JSON.stringify(changedFields)],
    );

    return { id: applicationId, created, changed, changedFields, customerId, duplicates };
  });
}

/** Record a push that could not be accepted, so a failure is never invisible. */
export async function logMirrorFailure(
  organizationId: string | null,
  reference: string,
  outcome: 'rejected' | 'failed',
  error: string,
): Promise<void> {
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO portal_mirror_log (organization_id, reference, outcome, error)
         VALUES ($1,$2,$3,$4)`,
        [organizationId, reference || '(none)', outcome, error.slice(0, 1000)],
      );
    });
  } catch (err) {
    log.error('could not record a mirror failure', { error: err });
  }
}
