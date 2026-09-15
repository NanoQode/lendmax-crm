/**
 * Seed: the brokerage, its vocabularies, and a first account.
 *
 * Idempotent — every insert is ON CONFLICT DO NOTHING or DO UPDATE on a stable
 * key, so running it against an existing database adds what is missing without
 * overwriting what somebody has since configured. A seed that resets the
 * pipeline every deploy is a seed nobody dares run.
 *
 *   npm run seed                      vocabularies only
 *   npm run seed -- --demo            plus a small set of realistic files
 *   npm run seed -- --admin you@x.ca  create/refresh the first admin account
 */
import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../src/db/pool.ts';
import { hashPassword } from '../src/services/auth.ts';
import { addDays, addMonths, todayIn } from '../src/domain/dates.ts';
import { toE164 } from '../src/lib/phone.ts';
import { DEFAULT_AUTOMATIONS } from '../src/domain/default-automations.ts';
import { validateDefinition } from '../src/domain/automation.ts';

const TZ = 'America/Toronto';

/**
 * The default pipeline. Configurable from Settings the moment it exists — these
 * are a starting point, not a constant, which is why they live in a table.
 */
const STAGES = [
  { key: 'lead',              label: 'Lead',              position: 1, category: 'open',  probability: 5,   colour: '#6366f1',
    rules: { blockedOnceScarlettPushed: true } },
  { key: 'application',       label: 'Application',       position: 2, category: 'open',  probability: 20,  colour: '#0ea5e9',
    rules: { minPercentComplete: 50, blockedOnceScarlettPushed: true } },
  { key: 'appointment_booked', label: 'Appointment Booked', position: 3, category: 'open', probability: 35, colour: '#14b8a6',
    rules: { requireAppointment: true, blockedOnceScarlettPushed: true } },
  { key: 'no_show',           label: 'No Show',           position: 4, category: 'open',  probability: 10,  colour: '#f59e0b',
    rules: { blockedOnceScarlettPushed: true } },
  { key: 'scarlett',          label: 'Scarlett',          position: 5, category: 'open',  probability: 65,  colour: '#8b5cf6',
    rules: { requireScarlettDeal: true } },
  { key: 'funded',            label: 'Funded',            position: 6, category: 'won',   probability: 100, colour: '#10b981',
    // The gate that makes Funded mean something: the money is recorded and the
    // compliance file is closed before a file counts as won.
    rules: { requireFundingConfirmed: true, requireComplianceComplete: true } },
  { key: 'nurture',           label: 'Nurture',           position: 7, category: 'parked', probability: 3,  colour: '#64748b', rules: {} },
  { key: 'lost',              label: 'Lost',              position: 8, category: 'lost',  probability: 0,   colour: '#ef4444',
    rules: { requireLostDisposition: true } },
];

const TRANSACTION_TYPES = [
  ['purchase',            'Purchase',                     'Purchase'],
  ['first_time_buyer',    'First-Time Home Buyer',        'Purchase'],
  ['renewal',             'Renewal',                      'Renew'],
  ['refinance',           'Refinance',                    'Refinance'],
  ['switch_transfer',     'Switch / Transfer',            'Renew'],
  ['equity_takeout',      'Equity Take-Out',              'Refinance'],
  ['debt_consolidation',  'Debt Consolidation',           'Refinance'],
  ['heloc',               'HELOC',                        'Home Equity Line'],
  ['second_mortgage',     'Second Mortgage',              'Refinance'],
  ['rental_investment',   'Rental / Investment Property', 'Purchase'],
  ['private',             'Private Mortgage',             null],
  ['construction',        'Construction',                 null],
  ['other',               'Other',                        null],
] as const;

/**
 * Lost dispositions. `reactivation_days` is what makes the disposition useful
 * rather than decorative: "did not qualify" is worth another look in six
 * months, "not interested" is not worth one at all.
 */
const DISPOSITIONS: Array<[string, string, boolean, number | null, boolean]> = [
  ['not_interested',        'Not Interested',            false, null, false],
  ['did_not_qualify',       'Did Not Qualify',           false, 180,  true],
  ['found_better_rate',     'Found a Better Rate',       false, null, true],
  ['chose_another_broker',  'Chose Another Broker',      false, null, true],
  ['chose_existing_bank',   'Chose Existing Bank',       false, null, true],
  ['appraisal_low',         'Appraisal Value Too Low',   false, 180,  true],
  ['gds_too_high',          'GDS Too High',              false, 180,  true],
  ['tds_too_high',          'TDS Too High',              false, 180,  true],
  ['insufficient_income',   'Insufficient Income',       false, 180,  true],
  ['credit_issue',          'Credit Issue',              false, 180,  true],
  ['insufficient_down',     'Insufficient Down Payment', false, 180,  true],
  ['property_unacceptable', 'Property Not Acceptable',   false, null, true],
  ['lender_declined',       'Lender Declined',           false, 90,   true],
  ['income_unverifiable',   'Unable to Verify Income',   false, 180,  true],
  ['unable_to_contact',     'Unable to Contact',         false, 60,   true],
  ['client_withdrew',       'Client Withdrew',           false, 90,   true],
  ['timing_changed',        'Timing Changed',            false, 90,   true],
  ['purchase_fell_through', 'Purchase Fell Through',     false, 60,   true],
  ['rate_not_competitive',  'Rate Not Competitive',      false, null, true],
  ['fees_too_high',         'Fees Too High',             false, null, true],
  // The one that must carry a note, because "Other" on its own tells the next
  // person nothing at all.
  ['other',                 'Other',                     true,  null, false],
];

const DOCUMENT_CATEGORIES: Array<[string, string, string, boolean, boolean]> = [
  ['identification',      'Identification',          'identity', true,  true],
  ['pay_stubs',           'Pay Stubs',               'income',   true,  false],
  ['employment_letter',   'Employment Letter',       'income',   true,  false],
  ['t4',                  'T4',                      'income',   true,  false],
  ['t1_general',          'T1 General',              'income',   true,  true],
  ['notice_of_assessment','Notice of Assessment',    'income',   true,  true],
  ['bank_statements',     'Bank Statements',         'assets',   true,  true],
  ['down_payment',        'Down Payment Confirmation','assets',  true,  true],
  ['gift_letter',         'Gift Letter',             'assets',   false, true],
  ['purchase_agreement',  'Purchase Agreement',      'property', true,  false],
  ['mls',                 'MLS Listing',             'property', true,  false],
  ['property_tax',        'Property Tax Bill',       'property', true,  false],
  ['mortgage_statement',  'Mortgage Statement',      'property', true,  false],
  ['appraisal',           'Appraisal',               'property', false, false],
  ['credit',              'Credit Report',           'credit',   false, true],
  ['incorporation',       'Incorporation Documents', 'business', true,  false],
  ['business_financials', 'Business Financials',     'business', true,  true],
  ['rental_documents',    'Rental Documents',        'property', true,  false],
  ['lease',               'Lease Agreement',         'property', true,  false],
  ['commitment',          'Commitment',              'lender',   false, false],
  ['signed_commitment',   'Signed Commitment',       'lender',   true,  false],
  ['lawyer',              'Lawyer Information',      'closing',  true,  false],
  ['compliance',          'Compliance',              'compliance', false, true],
  // On the file from the start, invisible to the borrower until somebody asks.
  // Putting "invoices for any deposit over $3,000" in front of a client
  // unprompted reads as an accusation.
  ['fintrac_deposit',     'Deposit Source Documents','compliance', false, true],
  ['funding',             'Funding',                 'closing',  false, false],
  ['other',               'Other',                   'other',    true,  false],
];

/**
 * The compliance checklist. Every item is configuration with a version, and the
 * instance records which version it was completed against, so gaining an item
 * next year does not make last year's approved files retroactively incomplete.
 */
const COMPLIANCE_CHECKLIST = {
  key: 'standard_on',
  name: 'Standard file (Ontario)',
  version: 1,
  province: 'ON',
  items: [
    { key: 'application_complete', group: 'application', label: 'Application complete and signed', required: true, evidence: 'field' },
    { key: 'client_consent',       group: 'consent',     label: 'Client consent recorded with evidence', required: true, evidence: 'field' },
    { key: 'identity_verified',    group: 'fintrac',     label: 'Identity verified for every applicant', required: true, evidence: 'field' },
    { key: 'third_party',          group: 'fintrac',     label: 'Third-party determination made', required: true, evidence: 'attestation' },
    { key: 'pep_screening',        group: 'fintrac',     label: 'PEP / HIO screening completed', required: true, evidence: 'attestation' },
    { key: 'source_of_funds',      group: 'fintrac',     label: 'Source of funds established', required: true, evidence: 'attestation' },
    { key: 'risk_assessed',        group: 'fintrac',     label: 'Risk assessment completed and rated', required: true, evidence: 'field' },
    { key: 'disclosures',          group: 'disclosure',  label: 'Required disclosures provided', required: true, evidence: 'document' },
    { key: 'suitability',          group: 'suitability', label: 'Suitability rationale documented', required: true, evidence: 'field' },
    { key: 'credit_documented',    group: 'credit',      label: 'Credit documentation on file', required: true, evidence: 'document' },
    { key: 'income_documented',    group: 'income',      label: 'Income documentation on file', required: true, evidence: 'document' },
    { key: 'commitment_signed',    group: 'lender',      label: 'Signed commitment on file', required: true, evidence: 'document' },
    { key: 'conditions_satisfied', group: 'lender',      label: 'Lender conditions satisfied', required: true, evidence: 'field' },
    { key: 'appraisal',            group: 'property',    label: 'Appraisal on file where required', required: false, evidence: 'document' },
    { key: 'funding_confirmed',    group: 'funding',     label: 'Funding confirmed with final figures', required: true, evidence: 'field' },
    { key: 'correspondence',       group: 'file',        label: 'Client correspondence retained', required: false, evidence: 'attestation' },
  ],
};

/**
 * The risk factors. Every one names its evaluator and its weight, and the
 * assessment stores the factors it used — which is what makes the score
 * explainable rather than a number somebody has to trust.
 */
const RISK_FACTORS: Array<[string, string, string, number, string, object]> = [
  ['non_resident',      'Non-resident borrower',        'A borrower without Canadian residency status.', 3, 'applicant_field_in',
    { field: 'citizenship', values: ['Non-resident'] }],
  // `determined_by` names the field that says the determination was actually
  // made. Both of these columns default to false, so without it a file nobody
  // has assessed reads as assessed and clean.
  ['entity_borrower',   'Corporate or entity borrower', 'Beneficial ownership must be established.', 3, 'fintrac_flag',
    { flag: 'entity_borrower', determined_by: 'completed_at' }],
  ['third_party',       'Third party involved',         'Somebody other than the borrower is party to the transaction.', 3, 'fintrac_flag',
    { flag: 'third_party_present', determined_by: 'third_party_checked' }],
  ['pep',               'Politically exposed person',   'PEP, HIO, family member or close associate.', 4, 'fintrac_pep', {}],
  ['private_lender',    'Private mortgage',             'Private lending carries a higher inherent risk rating.', 2, 'transaction_type_in',
    { values: ['private', 'second_mortgage'] }],
  ['cash_down_payment', 'Down payment not from a traceable source', 'Source of funds not evidenced.', 3, 'fintrac_source_unclear', {}],
  ['rapid_refinance',   'Refinanced within twelve months', 'Repeat equity take-out in a short window.', 2, 'repeat_refinance',
    { months: 12 }],
  ['unable_to_verify',  'Income could not be verified', 'Stated income without supporting documentation.', 2, 'documents_missing',
    { categories: ['notice_of_assessment', 't4', 'pay_stubs'] }],
];

/**
 * Retention. `action: 'review'` on every one, deliberately. Nothing in this
 * system deletes a mortgage record on a schedule nobody approved — the runner
 * proposes and a person disposes. The periods below are placeholders for the
 * brokerage's own verified answer, which is why each carries a source note
 * saying so.
 */
const RETENTION: Array<[string, string, string, string, number, string]> = [
  ['application_files', 'Mortgage application files', 'application', 'funded_at', 72,
   'PLACEHOLDER — confirm against FINTRAC and FSRA record-keeping requirements before relying on it.'],
  ['compliance_records', 'Compliance and identity records', 'compliance_case', 'closed_at', 72,
   'PLACEHOLDER — confirm against FINTRAC record-keeping requirements before relying on it.'],
  ['communications', 'Client communications', 'message', 'last_activity_at', 72,
   'PLACEHOLDER — confirm against FSRA and brokerage policy before relying on it.'],
  ['lost_files', 'Files that did not proceed', 'application', 'closed_at', 36,
   'PLACEHOLDER — confirm against brokerage policy and privacy obligations before relying on it.'],
];

/**
 * The default follow-up sequences.
 *
 * Seeded as `paused`, deliberately. A sequence that starts emailing clients
 * the moment somebody runs the seeder is not a helpful default — Admin reads
 * them, edits the wording to sound like the brokerage, and turns them on.
 * Re-running the seeder never overwrites an edited sequence: it only inserts
 * what is missing, matched on key.
 */
async function seedAutomations(orgId: string): Promise<void> {
  let added = 0;
  for (const auto of DEFAULT_AUTOMATIONS) {
    const issues = validateDefinition(auto.definition).filter((i) => i.level === 'error');
    if (issues.length) {
      throw new Error(
        `Default automation "${auto.key}" would not publish: ${issues.map((i) => i.message).join('; ')}`,
      );
    }

    const existing = await pool.query<{ id: string }>(
      'SELECT id FROM automations WHERE organization_id = $1 AND key = $2',
      [orgId, auto.key],
    );
    if (existing.rows.length) continue;

    // The purpose on the automation is the strongest purpose any step uses:
    // one marketing step makes the whole sequence marketing as far as the
    // consent gate is concerned, which is the safe direction to round.
    const purposes = auto.definition.nodes
      .map((n) => ('purpose' in n ? n.purpose : undefined))
      .filter(Boolean) as string[];
    const purpose = purposes.includes('marketing')
      ? 'marketing' : purposes.includes('service') ? 'service' : 'transactional';

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO automations (organization_id, key, name, description, status, purpose,
                                allow_reenrollment, reenrollment_cooldown_days)
       VALUES ($1,$2,$3,$4,'paused',$5,$6,$7) RETURNING id`,
      [orgId, auto.key, auto.name, auto.description, purpose,
       auto.key === 'renewal_runway', auto.key === 'renewal_runway' ? 300 : null],
    );
    const automationId = rows[0]!.id;

    await pool.query(
      `INSERT INTO automation_versions (automation_id, version, definition, notes)
       VALUES ($1, 1, $2, $3)`,
      [automationId, JSON.stringify(auto.definition),
       'Shipped default. Timings from docs/research/follow-up-and-content.md.'],
    );
    added++;
  }
  if (added) console.log(`Automations seeded (${added} added, paused for review).`);
}

async function seedVocabularies(orgId: string): Promise<void> {
  await withTransaction(async (c) => {
    for (const s of STAGES) {
      await c.query(
        `INSERT INTO pipeline_stages (organization_id, key, label, position, category,
                                      probability, colour, entry_rules)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (organization_id, key) DO NOTHING`,
        [orgId, s.key, s.label, s.position, s.category, s.probability, s.colour, JSON.stringify(s.rules)],
      );
    }
    for (const [i, [key, label, purpose]] of TRANSACTION_TYPES.entries()) {
      await c.query(
        `INSERT INTO transaction_types (organization_id, key, label, position, portal_purpose)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organization_id, key) DO NOTHING`,
        [orgId, key, label, i + 1, purpose],
      );
    }
    for (const [i, [key, label, note, days, nurture]] of DISPOSITIONS.entries()) {
      await c.query(
        `INSERT INTO lost_dispositions (organization_id, key, label, position,
                                        requires_note, reactivation_days, nurture_eligible)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (organization_id, key) DO NOTHING`,
        [orgId, key, label, i + 1, note, days, nurture],
      );
    }
    for (const [i, [key, label, group, visible, sensitive]] of DOCUMENT_CATEGORIES.entries()) {
      await c.query(
        `INSERT INTO document_categories (organization_id, key, label, position, group_key,
                                          client_visible, sensitive)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (organization_id, key) DO NOTHING`,
        [orgId, key, label, i + 1, group, visible, sensitive],
      );
    }
    await c.query(
      `INSERT INTO compliance_checklist_templates (organization_id, key, name, version,
                                                   province, items)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (organization_id, key, version) DO NOTHING`,
      [orgId, COMPLIANCE_CHECKLIST.key, COMPLIANCE_CHECKLIST.name, COMPLIANCE_CHECKLIST.version,
       COMPLIANCE_CHECKLIST.province, JSON.stringify(COMPLIANCE_CHECKLIST.items)],
    );
    for (const [key, label, description, weight, evaluator, params] of RISK_FACTORS) {
      await c.query(
        `INSERT INTO risk_factor_definitions (organization_id, model_key, model_version,
                                              factor_key, label, description, weight,
                                              evaluator, parameters)
         VALUES ($1,'standard',1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (organization_id, model_key, model_version, factor_key) DO NOTHING`,
        [orgId, key, label, description, weight, evaluator, JSON.stringify(params)],
      );
    }
    for (const [key, name, entity, anchor, months, note] of RETENTION) {
      await c.query(
        `INSERT INTO retention_policies (organization_id, key, name, entity_type, anchor,
                                         retain_months, action, source_note)
         VALUES ($1,$2,$3,$4,$5,$6,'review',$7)
         ON CONFLICT (organization_id, key) DO NOTHING`,
        [orgId, key, name, entity, anchor, months, note],
      );
    }

    // Who a new file belongs to. Seeded as `unassigned` deliberately: a
    // brokerage should choose how files are routed rather than discover that
    // the seed chose for them. The dashboard's unassigned count makes the
    // choice visible until they do.
    for (const role of ['broker', 'underwriter'] as const) {
      await c.query(
        `INSERT INTO assignment_rules (organization_id, role, mode)
         SELECT $1, $2, 'unassigned'
          WHERE NOT EXISTS (SELECT 1 FROM assignment_rules
                             WHERE organization_id = $1 AND role = $2)`,
        [orgId, role],
      );
    }

    // Settings carry a source note wherever the value is somebody else's rule
    // rather than the brokerage's own preference.
    const settings: Array<[string, unknown, string | null]> = [
      ['consent_rules', {
        impliedConsentMonths: 24,
        smsMarketingRequiresExpress: true,
        stopKeywords: ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'arret', 'arrêt'],
        startKeywords: ['start', 'unstop', 'yes', 'subscribe'],
        unsubscribeAppliesAcrossChannels: false,
      }, 'PLACEHOLDER — confirm the implied-consent window against current CRTC/CASL guidance.'],
      ['quiet_hours', { enabled: true, startHour: 21, endHour: 8, respectWeekends: false }, null],
      ['business_calendar', {
        workingDays: [1, 2, 3, 4, 5], workdayStartHour: 9, workdayEndHour: 17, holidays: [],
      }, 'Statutory holidays are entered by the brokerage; none are assumed.'],
      ['closing_thresholds', { attention: 14, urgent: 7 }, null],
      ['stale_alerts', {
        leadIncompleteHours: 48, documentsOutstandingHours: 48, replySlaBusinessHours: 4,
        noContactDays: 7, closingConditionsDays: 7, closingComplianceDays: 3,
      }, null],
      ['mortgage_rules', {
        // Deliberately unset. A stress-test rate or a maximum GDS compiled in
        // as a constant is a number that goes silently stale and then makes
        // every qualification wrong.
        qualifyingRate: null, maxGds: null, maxTds: null,
        note: 'Set these from the current OSFI B-20 / lender guidance, with the date checked.',
      }, 'UNSET — must be entered from an authoritative source with an effective date.'],
    ];
    for (const [key, value, note] of settings) {
      await c.query(
        `INSERT INTO settings (organization_id, key, value, source_note)
         VALUES ($1,$2,$3::jsonb,$4)
         ON CONFLICT (organization_id, key, effective_from) DO NOTHING`,
        [orgId, key, JSON.stringify(value), note],
      );
    }
  });
}

async function ensureOrganization(): Promise<string> {
  const existing = await pool.query<{ id: string }>('SELECT id FROM organizations LIMIT 1');
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, legal_name, regulator, home_province, timezone, website)
     VALUES ('Lendmax', 'Lendmax', 'FSRA', 'ON', $1, 'https://lendmax.ca') RETURNING id`,
    [TZ],
  );
  return rows[0]!.id;
}

/**
 * The two people every arriving file is routed to, per answer 8: Michael Squeo
 * as the manager and Joe Marker on underwriting. They are created without a
 * password — they sign in by having one set, rather than by a default that
 * somebody forgets to change.
 *
 * `underwriting@lendmax.ca` is deliberately Joe's address: answer 26 says the
 * "Underwriting Team" is a persona on that mailbox, not a separate human, and
 * the tone-rotation templates sign as the team rather than inventing a person.
 */
async function seedStaff(orgId: string): Promise<Record<string, string>> {
  const staff = [
    { email: 'michael@lendmax.ca', name: 'Michael Squeo', role: 'manager' },
    { email: 'underwriting@lendmax.ca', name: 'Joe Marker', role: 'underwriter' },
  ];
  const ids: Record<string, string> = {};
  for (const person of staff) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, email, name, role, active, profile_complete)
       VALUES ($1,$2,$3,$4,true,false)
       ON CONFLICT (organization_id, lower(email))
       DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = true
       RETURNING id`,
      [orgId, person.email, person.name, person.role],
    );
    ids[person.role] = rows[0]!.id;
  }

  // Every arriving file gets an owner rather than sitting unclaimed (answer 8).
  // Fixed rather than round robin, because Ali named two specific people.
  for (const [role, userId] of Object.entries(ids)) {
    // No unique key on (organization_id, role) — the table allows several
    // ordered rules per role on purpose — so this checks rather than upserts.
    //
    // A rule already pointing at somebody, or rotating, is a decision someone
    // made and is left alone. A rule still on 'unassigned' is the shipped
    // default rather than a choice, so it gets filled in: leaving it would
    // mean files keep arriving with no owner, which is the thing answer 8
    // asked to stop.
    const existing = await pool.query<{ id: string; mode: string }>(
      'SELECT id, mode FROM assignment_rules WHERE organization_id = $1 AND role = $2 ORDER BY position LIMIT 1',
      [orgId, role],
    );
    const current = existing.rows[0];
    if (current && current.mode !== 'unassigned') continue;
    if (current) {
      await pool.query(
        `UPDATE assignment_rules SET mode = 'fixed', fixed_user_id = $2, active = true WHERE id = $1`,
        [current.id, userId],
      );
    } else {
      await pool.query(
        `INSERT INTO assignment_rules (organization_id, role, mode, fixed_user_id, position, active)
         VALUES ($1,$2,'fixed',$3,1,true)`,
        [orgId, role, userId],
      );
    }
  }
  console.log('Staff seeded: Michael Squeo (manager), Joe Marker (underwriter).');
  return ids;
}

async function seedDemo(orgId: string, brokerId: string): Promise<void> {
  const today = todayIn(TZ);
  const people = [
    { first: 'Sarah', last: 'Johnson', email: 'sarah.johnson@example.com', phone: '(416) 555-0142',
      stage: 'scarlett', type: 'purchase', amount: 785000, city: 'Toronto', street: 'Main Street',
      number: '123', closing: addDays(today, 34), percent: 100, scarlett: 'SCR-2026-4471', province: 'ON' },
    { first: 'Michael', last: 'Chen', email: 'm.chen@example.com', phone: '647-555-0198',
      stage: 'application', type: 'refinance', amount: 420000, city: 'Mississauga', street: 'Lakeshore Road',
      number: '88', closing: addDays(today, 12), percent: 78, scarlett: null, province: 'ON' },
    { first: 'Priya', last: 'Patel', email: 'priya.patel@example.com', phone: '905 555 0177',
      stage: 'lead', type: 'first_time_buyer', amount: 540000, city: 'Brampton', street: 'Queen Street',
      number: '4102', closing: null, percent: 35, scarlett: null, province: 'ON' },
    { first: 'David', last: 'Okonkwo', email: 'd.okonkwo@example.com', phone: '(289) 555-0163',
      stage: 'appointment_booked', type: 'renewal', amount: 312000, city: 'Hamilton', street: 'King Street East',
      number: '760', closing: addDays(today, 61), percent: 92, scarlett: null, province: 'ON' },
    { first: 'Emma', last: 'Tremblay', email: 'emma.t@example.com', phone: '613-555-0110',
      stage: 'funded', type: 'purchase', amount: 615000, city: 'Ottawa', street: 'Bank Street',
      number: '215', closing: addDays(today, -21), percent: 100, scarlett: 'SCR-2026-4402', province: 'ON' },
    { first: 'James', last: 'Whitfield', email: 'jwhitfield@example.com', phone: '416-555-0129',
      stage: 'no_show', type: 'debt_consolidation', amount: 268000, city: 'Etobicoke', street: 'Islington Avenue',
      number: '1450', closing: null, percent: 64, scarlett: null, province: 'ON' },
    // Ten files, spread across transaction types and stages, so every screen
    // has something real to render: a board with one card in one column tells
    // you nothing about whether the board works.
    { first: 'Aisha', last: 'Rahman', email: 'aisha.rahman@example.com', phone: '(604) 555-0184',
      stage: 'application', type: 'rental_investment', amount: 498000, city: 'Burnaby', street: 'Canada Way',
      number: '3820', closing: addDays(today, 47), percent: 71, scarlett: null, province: 'BC' },
    { first: 'Grzegorz', last: 'Nowak', email: 'g.nowak@example.com', phone: '780-555-0155',
      stage: 'scarlett', type: 'private', amount: 185000, city: 'Edmonton', street: 'Jasper Avenue',
      number: '10230', closing: addDays(today, 19), percent: 100, scarlett: 'SCR-2026-4518', province: 'AB' },
    { first: 'Marie-Claude', last: 'Gagnon', email: 'mc.gagnon@example.com', phone: '(514) 555-0121',
      stage: 'lead', type: 'construction', amount: 720000, city: 'Laval', street: 'Boulevard Saint-Martin',
      number: '1875', closing: null, percent: 22, scarlett: null, province: 'QC' },
    { first: 'Desmond', last: 'Clarke', email: 'd.clarke@example.com', phone: '902-555-0173',
      stage: 'lost', type: 'heloc', amount: 150000, city: 'Halifax', street: 'Robie Street',
      number: '644', closing: null, percent: 88, scarlett: null, province: 'NS', lost: 'found_better_rate' },
  ];

  for (const p of people) {
    await withTransaction(async (c) => {
      const existing = await c.query('SELECT id FROM customers WHERE organization_id = $1 AND email = $2',
        [orgId, p.email]);
      if (existing.rows[0]) return;

      const { rows: cust } = await c.query<{ id: string }>(
        `INSERT INTO customers (organization_id, first_name, last_name, email, phone_e164, phone_raw,
                                lead_source, last_contacted_at, awaiting_reply_since)
         VALUES ($1,$2,$3,$4,$5,$6,'demo', now() - interval '2 days', $7) RETURNING id`,
        [orgId, p.first, p.last, p.email, toE164(p.phone), p.phone,
         p.stage === 'application' ? new Date(Date.now() - 5 * 3_600_000) : null],
      );
      const customerId = cust[0]!.id;

      const { rows: app } = await c.query<{ id: string }>(
        `INSERT INTO applications (organization_id, customer_id, portal_reference, portal_status,
                                   transaction_type_key, amount_requested, stage_key, stage_changed_at,
                                   closing_date, percent_complete, applicant_count,
                                   property_street_number, property_street_name, property_city,
                                   property_province, scarlett_deal_id, scarlett_sync_state,
                                   last_activity_at, documents_outstanding, maturity_date,
                                   lost_disposition_key)
         VALUES ($1,$2,$3,'submitted',$4,$5,$6, now() - interval '6 days', $7,$8,1,
                 $9,$10,$11,$12,$13,$14, now() - interval '1 day', $15, $16, $17)
         RETURNING id`,
        [orgId, customerId, `LMX-A-202609-${1000 + people.indexOf(p)}`, p.type, p.amount, p.stage,
         p.closing, p.percent, p.number, p.street, p.city,
         // Province drives land transfer tax and the provincial rules, so a
         // Halifax file marked Ontario is not a cosmetic error.
         ('province' in p ? p.province : 'ON'), p.scarlett,
         p.scarlett ? 'ok' : null, p.stage === 'scarlett' ? 2 : 0,
         p.stage === 'funded' ? addMonths(today, 60) : null,
         'lost' in p ? p.lost : null],
      );
      const applicationId = app[0]!.id;

      await c.query(
        `INSERT INTO application_applicants (application_id, customer_id, position, applicant_role,
                                             first_name, last_name, email, phone_e164, addr_city, addr_province)
         VALUES ($1,$2,0,'applicant',$3,$4,$5,$6,$7,'ON')`,
        [applicationId, customerId, p.first, p.last, p.email, toE164(p.phone), p.city],
      );
      await c.query(
        `INSERT INTO assignments (application_id, user_id, role, is_primary, assigned_by)
         VALUES ($1,$2,'broker',true,$2)`,
        [applicationId, brokerId],
      );
      await c.query(
        `INSERT INTO activity (organization_id, application_id, customer_id, kind, actor_kind,
                               actor_name, summary)
         VALUES ($1,$2,$3,'system','system','Portal', 'Application mirrored from apply.lendmax.ca')`,
        [orgId, applicationId, customerId],
      );

      if (p.stage === 'scarlett') {
        const { rows: sub } = await c.query<{ id: string }>(
          `INSERT INTO lender_submissions (organization_id, application_id, lender_name, status,
                                           submitted_at, rate, rate_type, term_months, amortization_months, amount)
           VALUES ($1,$2,'MCAP','conditional', now() - interval '3 days', 4.89,'fixed',60,300,$3)
           RETURNING id`,
          [orgId, applicationId, p.amount],
        );
        for (const [label, days] of [['Confirmation of down payment', 5], ['Employment letter', 3]] as const) {
          await c.query(
            `INSERT INTO lender_conditions (lender_submission_id, application_id, label, due_on, status)
             VALUES ($1,$2,$3,$4::date,'outstanding')`,
            [sub[0]!.id, applicationId, label, addDays(today, days)],
          );
        }
      }

      if (p.stage === 'funded') {
        await c.query(
          `INSERT INTO funding_records (organization_id, application_id, lender_name, product_name,
                                        approved_amount, funded_amount, rate, rate_type, term_months,
                                        amortization_months, insurance_status, funding_date,
                                        maturity_date, confirmed, confirmed_by)
           VALUES ($1,$2,'Scotiabank','5-Year Fixed',$3,$3,4.74,'fixed',60,300,'insured',
                   $4::date,$5::date,true,$6)`,
          [orgId, applicationId, p.amount, p.closing, addMonths(today, 60), brokerId],
        );
        const { rows: comm } = await c.query<{ id: string }>(
          `INSERT INTO commission_records (organization_id, application_id, source, lender_name,
                                           basis_bps, gross_expected, expected_on, status)
           VALUES ($1,$2,'lender','Scotiabank',85,$3,$4::date,'awaiting_payment') RETURNING id`,
          [orgId, applicationId, (p.amount * 0.0085).toFixed(2), addDays(today, 9)],
        );
        await c.query(
          `INSERT INTO commission_splits (commission_record_id, party, user_id, percent, amount)
           VALUES ($1,'broker',$2,80,$3), ($1,'brokerage',NULL,20,$4)`,
          [comm[0]!.id, brokerId,
           (p.amount * 0.0085 * 0.8).toFixed(2), (p.amount * 0.0085 * 0.2).toFixed(2)],
        );
        const { rows: cc } = await c.query<{ id: string }>(
          `INSERT INTO compliance_cases (organization_id, application_id, customer_id, status,
                                         checklist_key, province)
           VALUES ($1,$2,$3,'in_progress','standard_on','ON') RETURNING id`,
          [orgId, applicationId, customerId],
        );
        for (const [i, item] of COMPLIANCE_CHECKLIST.items.entries()) {
          await c.query(
            `INSERT INTO compliance_checklist_items (compliance_case_id, template_key, template_version,
                                                     item_key, group_key, label, required, status, position)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [cc[0]!.id, COMPLIANCE_CHECKLIST.key, COMPLIANCE_CHECKLIST.version,
             item.key, item.group, item.label, item.required, i < 12 ? 'complete' : 'outstanding', i],
          );
        }
        await c.query(
          `INSERT INTO renewal_records (organization_id, customer_id, application_id, maturity_date,
                                        maturity_source, lender_name, balance_estimate, rate, status, assigned_to)
           VALUES ($1,$2,$3,$4::date,'calculated','Scotiabank',$5,4.74,'upcoming',$6)`,
          [orgId, customerId, applicationId, addMonths(today, 60), p.amount, brokerId],
        );
      }

      await c.query(
        `INSERT INTO tasks (organization_id, application_id, customer_id, title, category,
                            priority, due_on, created_by)
         VALUES ($1,$2,$3,$4,'follow_up','normal',$5::date,$6) RETURNING id`,
        [orgId, applicationId, customerId, `Follow up with ${p.first}`, addDays(today, 2), brokerId],
      );
    });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantsDemo = args.includes('--demo');
  const adminIndex = args.indexOf('--admin');
  const adminEmail = adminIndex >= 0 ? args[adminIndex + 1] : undefined;

  const orgId = await ensureOrganization();
  await seedVocabularies(orgId);
  console.log('Vocabularies seeded.');
  await seedAutomations(orgId);
  await seedStaff(orgId);

  let password: string | undefined;
  if (adminEmail) {
    password = randomUUID().replace(/-/g, '').slice(0, 20);
    await pool.query(
      `INSERT INTO users (organization_id, email, name, role, password_hash, active, profile_complete)
       VALUES ($1,$2,$3,'technical_admin',$4,true,false)
       ON CONFLICT (organization_id, lower(email))
       DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true,
                     failed_login_count = 0, locked_until = NULL`,
      [orgId, adminEmail, adminEmail.split('@')[0], await hashPassword(password)],
    );
    console.log(`\nAdmin account ready:\n  ${adminEmail}\n  ${password}\n`);
    console.log('Change it on first sign-in. It is printed once and not stored anywhere else.\n');
  }

  if (wantsDemo) {
    const broker = await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, email, name, role, active, profile_complete)
       VALUES ($1,'broker@lendmax.ca','Demo Broker','broker',true,true)
       ON CONFLICT (organization_id, lower(email)) DO UPDATE SET active = true
       RETURNING id`,
      [orgId],
    );
    await seedDemo(orgId, broker.rows[0]!.id);
    console.log('Demo files seeded.');
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end().catch(() => {});
  process.exit(1);
});
