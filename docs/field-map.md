# Field map — `apply.lendmax.ca` → CRM

**What this is.** Every variable the application portal collects, and where it
lands in this CRM. It was produced by inspecting the live portal rather than by
guessing: `/srv/lendmax-portal/lendmax-portal-fields.csv` (124 fields, generated
by the portal from its own `lib/schema.js`, which is the single source of truth
for the form), plus the portal's `AGENTS.md`, its migrations, and the mirror
payload it already pushes to `lendmax.ca`.

**Why it matters.** The instruction was not to rebuild the application data
model blindly, and this is the document that makes that possible. A consumer
must not have one application record at `apply.lendmax.ca` and an unrelated
duplicate here.

---

## 1. The authoritative record relationship

```
apply.lendmax.ca                     lendmax.ca/crm
─────────────────                    ──────────────
owns the APPLICATION                 owns what the BROKERAGE does about it
  the answers                          the pipeline stage
  the uploaded documents               who it is assigned to
  the client's session                 notes, tasks, appointments
  the GDS/TDS calculation              compliance, funding, commission
  the booking                          renewals

        ── mirror push, one way ──▶    applications.portal_data (verbatim)
                                       + the normalised columns below

        ◀── document stream ──         a manifest here; the bytes stay there
```

Three rules follow, and they are enforced in code rather than by convention:

1. **One portal application is exactly one `applications` row**, keyed on
   `portal_reference` (`LMX-A-YYYYMM-NNNN`), which carries a `UNIQUE`
   constraint. There is no path that creates a second.
2. **The client owns the answer, the brokerage owns the correction, and the
   correction wins.** *(Changed 2026-09-16. It previously read "the CRM never
   edits a portal-owned field", which cost a broker their fix to the next
   mirror push thirty seconds later.)*

   `portal_data` is still replaced wholesale by a newer push and is still never
   written to from here — what the client said is always recoverable. A staff
   correction is recorded in `application_field_edits` against the path it
   changed and laid over the portal's copy on every read.

   A **scalar is pinned by itself** (`property.postal_code`), so correcting one
   field does not freeze the forty beside it. A **list is pinned as a list**
   (`liabilities`), because rows have no stable identity across a client's own
   edits and pinning per row would silently reattach a correction to a
   different debt.

   The derived columns in section 3 are recomputed from the merged view after a
   correction *and* after every push (`services/applications.ts`,
   `applyAnswerColumns`), so the board and the reports agree with what the file
   shows. Removing the last correction puts the field back under the portal's
   control.
3. **A ratio is never recomputed.** The portal calculates GDS/TDS once and
   records its own working — every income, shelter and debt line with the note
   that explains it. Those line items travel in `portal_ratios` and are
   displayed as received. Deriving a second version here would produce two
   numbers that disagree, and the one on screen would be the one nobody trusts.

**A customer is not an application.** People renew, refinance, and buy a rental
later. `customers` is keyed on the person; `applications` hangs off it. Keyed
the other way round the whole renewal workflow is impossible.

---

## 2. Sensitivity classification

| Class | Fields | Handling |
|---|---|---|
| **Not stored** | Social insurance number | The portal does not collect it and this CRM does not store it. The older `lendmax.ca` intake form encrypted one; nothing here carries that forward. |
| **Restricted** | `dob`, identification document numbers, credit detail | `identity_verifications` keeps **only the last four** of a document number, CHECK-constrained to ≤ 4 characters. DOB is on the applicant row and is in the logger's redaction deny-list. |
| **Financial** | income, assets, liabilities, balances, ratios | Behind `pii.view_financials`, which is a separate grant from opening the file. Absent that permission the API does not query them at all, and the UI says *why* the section is missing rather than rendering it empty. |
| **Ordinary** | name, contact, property, purpose | Behind `customer.view`. |

The technical admin role holds **none** of the first three. Least privilege has
to apply to the account with the most access or it is not a principle.

---

## 3. Section-by-section mapping

Portal storage keys are as they appear in the portal's own CSV. `{i}` and `{j}`
are repeater indices.

### Section 1 — Purpose

| Portal key | CRM column | Type | Notes |
|---|---|---|---|
| `purpose.purpose` | `applications.purpose` | text | Portal vocabulary: Purchase / Renew / Refinance / Home Equity Line. Mapped to the richer `applications.transaction_type_key` via `transaction_types.portal_purpose` — several CRM types share one portal purpose (a first-time buyer and a plain purchase are both `Purchase` up there). |
| `purpose.timing` | `applications.timing` | text | Drives lead-stage follow-up urgency. |
| `purpose.amount_requested` | `applications.amount_requested` | `NUMERIC(14,2)` | For a purchase this is the mortgage, not the price. |
| `purpose.existing_lender` | `applications.existing_lender` | text | |
| `purpose.maturity_date` | `applications.maturity_date`, `maturity_source='declared'` | `DATE` | **A renewal opportunity the brokerage already knows about.** A client's declared maturity is treated as a first-class renewal source, not only mortgages we funded. |
| `purpose.refi_reason` | `applications.refi_reason` | text | |
| `purpose.refi_compare`, `purpose.refi_note`, `meta.purpose.offer_declined` | `applications.portal_data` only | — | Portal UI state (the renewal-offer block). No CRM meaning; kept verbatim, not promoted to a column. |

### Section 2 — Subject property

| Portal key | CRM column | Type |
|---|---|---|
| `property.street_number` | `applications.property_street_number` | text |
| `property.street_name` | `applications.property_street_name` | text |
| `property.unit` | `applications.property_unit` | text |
| `property.city` | `applications.property_city` | text |
| `property.province` | `applications.property_province` | text |
| `property.postal_code` | `applications.property_postal_code` | text |
| `property.home_type` | `applications.property_type` | text |
| `property.occupancy` | `applications.property_occupancy` | text |
| `property.purchase_price` | `applications.purchase_price` | `NUMERIC(14,2)` |
| `property.property_value` | `applications.property_value` | `NUMERIC(14,2)` |
| `property.down_payment` | `applications.down_payment` | `NUMERIC(14,2)` |
| `property.down_source` | `applications.down_payment_source` | text |
| `property.existing_balance` | `applications.existing_balance` | `NUMERIC(14,2)` |
| `property.annual_taxes` | `applications.annual_taxes` | `NUMERIC(14,2)` |
| `property.monthly_heat` | `applications.monthly_heat` | `NUMERIC(14,2)` |
| `property.condo_fee` | `applications.monthly_condo_fee` | `NUMERIC(14,2)` |
| `property.rental_income` | `applications.rental_income` | `NUMERIC(14,2)` |
| `property.closing_date` | `applications.closing_date` | **`DATE`** |

`property.sqft`, `year_built`, `bedrooms`, `bathrooms`, `construction`,
`heat_type`, `water_type`, `sewer_type`, `lot_size`, `garage`,
`condo_fee_includes_heat`, `condo_corp`, `condo_locker`, `is_subject`,
`found_property` stay in `portal_data`. They matter to a lender submission and
to an appraisal, and are read from the JSON when a Scarlett payload is built —
promoting fourteen columns nothing sorts or filters on would be cost with no
return.

> **`closing_date` is a `DATE`, deliberately.** A closing date is a date in a
> contract, not an instant. Given a timestamp it moves overnight for anybody
> west of the server, and "days to close" — which drives task priority, the
> board, the dashboard and three stale-file alerts — is then wrong by one for
> half the country. The `pg` driver's default parser was returning a JS `Date`
> here and it was caught in testing; `src/db/pool.ts` now keeps `DATE` as a
> `'YYYY-MM-DD'` string.

### Section 3 — Borrowers → `application_applicants`

One row per applicant, `position` 0 being the primary. `customer_id` links the
primary applicant to the `customers` record so the person survives the file.

| Portal key | CRM column |
|---|---|
| `applicants[{i}].first_name` / `.last_name` | `first_name` / `last_name` |
| `applicants[{i}].email` | `email` |
| `applicants[{i}].phone` | `phone_e164` — **normalised to E.164 on the way in** (`src/lib/phone.ts`), so an inbound SMS from `+16475551234` finds the client who typed `(647) 555-1234` |
| `applicants[{i}].dob` | `date_of_birth` (`DATE`, restricted) |
| `applicants[{i}].marital_status` | `marital_status` |
| `applicants[{i}].dependants` | `dependants` |
| `applicants[{i}].citizenship` | `citizenship` — also a FINTRAC risk factor input |
| `applicants[{i}].credit_self` | `credit_self_report` — the client's *guess*, never a bureau score |
| `applicants[{i}].addr_*` | `addr_street_number`, `addr_street_name`, `addr_unit`, `addr_city`, `addr_province`, `addr_postal` |
| `applicants[{i}].residential_status` | `residential_status` |
| `applicants[{i}].monthly_rent` | `monthly_rent` |
| `applicants[{i}].years_at_address` | `years_at_address` |
| `applicants[{i}].prev_address` | `prev_address` |

Employment on the applicant record maps to `application_employments` with
`slot='primary'`:

| Portal key | CRM column |
|---|---|
| `applicants[{i}].employment_type` | `employment_type` |
| `applicants[{i}].employment_basis` | `employment_basis` |
| `applicants[{i}].employer` | `employer` |
| `applicants[{i}].job_title` | `job_title` |
| `applicants[{i}].years_employed` | `years` |
| `applicants[{i}].annual_income` | `annual_income` |
| `applicants[{i}].income_frequency` | `income_frequency` |

The portal's "other employment" repeater maps to the same table with
`slot='additional'`: `.status` → `status` (Active / Previous), `.employment_type`,
`.employment_basis`, `.employer`, `.job_title`, `.years` → `years`,
`.annual_income`, `.ended` → `ended_on` (`DATE`).

> One table, two slots — not two tables. The question a lender asks is "what is
> this borrower's income", and that has to be one query.

### Sections 4–7 — the repeaters

| Portal | CRM table | Key columns |
|---|---|---|
| `income[{i}].*` | `application_incomes` | `income_type`, `amount`, `frequency`, `source`, `years_receiving`, `applicant_id` |
| `assets[{i}].*` | `application_assets` | `asset_type`, `value`, `institution`, `for_down_payment`, `applicant_id` |
| `liabilities[{i}].*` | `application_liabilities` | `liability_type`, `lender`, `balance`, `monthly_payment`, **`payoff`**, `applicant_id` |
| `other_properties[{i}].*` | `application_properties` | address, `occupancy`, `value`, `annual_taxes`, `monthly_heat`, `monthly_condo_fee`, `rental_income`, `to_be_sold`, plus the mortgage block |

Notes that are not obvious:

- **`liabilities[{i}].payoff`** is mirrored, never inferred. A liability being
  paid out with the mortgage is excluded from TDS on the refinance it is being
  consolidated into, and that exclusion is the whole point of the deal.
- **`other_properties[{i}].mtg_maturity`** is indexed. Every other property with
  a maturity date is a renewal the brokerage already knows about and would
  otherwise never look at again.
- **`other_properties[{i}].mtg_rate`** is `NUMERIC(9,6)` **stored as a percent**
  — `5.29` means 5.29%. Storing a rate as a fraction in one place and a percent
  in another is the most reliable way to produce a payment that is out by 100×.
- `applicant` on each repeater is the portal's index into its applicants array;
  it is resolved to the CRM `applicant_id` on import, not stored as an index.
- `meta.income.none`, `meta.assets.none`, `meta.liabilities.none`,
  `meta.other_properties.owns_other` are **declarations**, not absences. "The
  client said they have no other income" and "nobody has filled this in yet" are
  different facts, and the completeness calculation needs both. They stay in
  `portal_data` and are read by the completeness logic.

### Sections 8–9 — Review, consent, documents

| Portal key | CRM destination | Notes |
|---|---|---|
| `review.consent` | `consents` row: `channel='any'`, `purpose='transactional'`, `basis='express'`, with `consent_text`, `consent_version`, `ip`, `user_agent`, `collected_at` | **This is not marketing consent.** The portal's single acceptance toggle covers contact about *this application*. It is imported as transactional only. Using it to justify a campaign send would be the single most consequential mistake this mapping could make, and the send gate (`src/domain/consent.ts`) will not do it. |
| `review.notes` | `notes` row, `note_type='general'`, `source` portal | |
| `documents.notes` | `notes` row, `note_type='general'` | |
| portal document manifest | `documents` rows with `storage_driver='portal'`, `storage_key` = the portal's document id | A manifest, not a copy. No path on disk crosses the wire and the CRM does not hold a second copy of somebody's passport; opening one streams it back through the portal's authenticated endpoint. |

### Mirror metadata

| Portal / mirror field | CRM column |
|---|---|
| portal id | `applications.portal_id` |
| reference | `applications.portal_reference` (UNIQUE) |
| status | `applications.portal_status` |
| percent | `applications.percent_complete` |
| gds / tds / ltv / payment | `applications.gds` / `.tds` / `.ltv` / `.qualifying_payment` |
| ratio line items | `applications.portal_ratios` (JSONB, **displayed as received**) |
| progress | `applications.portal_progress` |
| whole record | `applications.portal_data` |
| content hash | `applications.mirror_hash` — a push whose hash is unchanged is a no-op |
| — | `applications.mirrored_at` |

---

## 4. Fields the CRM adds

These have no portal equivalent. They are what the brokerage knows and the
client does not fill in.

`stage_key`, `stage_changed_at`, `status_key`, `lost_disposition_key`,
`lost_reason_note`, `reactivate_after`, `transaction_type_key`,
`scarlett_deal_id`/`_status`/`_sync_state`, `next_task_at`,
`next_appointment_at`, `last_activity_at`, `documents_outstanding`,
`maturity_source`, plus everything in `assignments`, `funding_records`,
`commission_records`, `compliance_cases`, `renewal_records`.

---

## 4a. The form itself

The CRM renders the client's answers from the portal's own form definition
rather than a second description of it. `vendor/portal-schema.js` is a
byte-identical copy of `/srv/lendmax-portal/lib/schema.js`;
`scripts/vendor-portal-schema.mjs` calls its `publicSchema()` and writes
`src/integrations/portal-schema.ts`. The conditions (`shown_when`) and the
validators are ported in `domain/application-form.ts`, word for word from the
portal's `lib/validate.js`, so a value the portal would refuse is refused here
with the same sentence.

To refresh after the portal changes:

```
scp the portal's lib/schema.js over vendor/portal-schema.js
node scripts/vendor-portal-schema.mjs
npm test          # test/application-form.test.ts says what changed
```

One deliberate difference from the portal: a staff member saves a section
`partial`, so a broker fixing one wrong postal code on a half-finished file is
not made to answer the other forty questions first. What they type must be
*valid*; the section does not have to be *complete*. Completeness is the
client's business and the portal's bar.

## 5. What still has to be built for this map to run

The schema and the rules are in place; the importer is not. To connect it:

1. **Receive the push.** `POST /api/crm/internal/portal/application`, verified
   against `PORTAL_WEBHOOK_SECRET` in constant time, writing the raw body to
   `webhook_events` **before** it is acted on — a webhook that arrives and
   cannot be processed is a bug to fix, not an event to lose.
2. **Upsert on `portal_reference`** inside one transaction: the `applications`
   row, then replace the child rows (`portal_path` on each records where it came
   from), then the consent row if this is the first push.
3. **Resolve the customer** by normalised phone and lower-cased email. On a
   near-match, create and **flag** — never merge. Merging two people's mortgage
   files because they share an address is not undoable.
4. **Emit `domain_events`** (`application.created`, `application.updated`,
   `application.completed`) for the automation engine to consume.
5. **Backfill** the 17 applications already mirrored into the existing SQLite at
   `/var/lib/lendmax/lendmax.db` (`portal_applications`), with a dry-run,
   duplicate detection and a reconciliation count before anything is written.
