/* Lendmax application portal — the application definition.
 * =========================================================================
 * This file is the single source of truth. The browser renders the form from
 * it, the server validates against it, and the Scarlett client maps out of it.
 * They cannot drift, because there is only one of them.
 *
 * ON "REQUIRED"
 * -------------
 * Scarlett's API documentation marks **nothing** as required — every field on
 * every endpoint reads "Additional information: None." So `req:true` below is
 * not copied from their docs. It is the minimum a Canadian mortgage file needs
 * to be worth submitting: enough to identify the borrower, enough to compute
 * GDS, TDS and LTV, and enough for an underwriter to act on. Everything else is
 * optional and the applicant can skip it.
 *
 * If Scarlett later tells you a field is mandatory on their side, add `req:true`
 * here and it becomes required in the browser, on the server and in the status
 * API in one edit.
 *
 * FIELD SHAPE
 * -----------
 *   n     name (also the storage key)
 *   l     label
 *   t     text | email | phone | money | number | date | select | radio |
 *         checkbox | textarea | postal | sqft | percent | year
 *   req   required (see above)
 *   o     options for select/radio — strings, or {v,l} when the stored value
 *         differs from the label
 *   when  {field, in:[...]} — only shown/validated when another field matches
 *   full  span the full width of the grid
 *   hint  helper text under the field
 *   ph    placeholder
 *   min/max/step for numerics
 *   sc    Scarlett mapping hint, consumed by lib/scarlett.js
 */

/* --------------------------------------------------------------- vocabularies
 * Scarlett expects integer dropdown codes whose values are not published. The
 * portal stores the human string, and lib/dropdowns.js maps it to whatever code
 * Scarlett returns from LoadDD once you sync. Until then these read correctly
 * to the applicant and to your broker, which is what matters most.
 */
export const PROVINCES = [
  { v: 'AB', l: 'Alberta' }, { v: 'BC', l: 'British Columbia' },
  { v: 'MB', l: 'Manitoba' }, { v: 'NB', l: 'New Brunswick' },
  { v: 'NL', l: 'Newfoundland and Labrador' }, { v: 'NS', l: 'Nova Scotia' },
  { v: 'NT', l: 'Northwest Territories' }, { v: 'NU', l: 'Nunavut' },
  { v: 'ON', l: 'Ontario' }, { v: 'PE', l: 'Prince Edward Island' },
  { v: 'QC', l: 'Quebec' }, { v: 'SK', l: 'Saskatchewan' }, { v: 'YT', l: 'Yukon' },
];

export const FREQUENCIES = ['Monthly', 'Semi-monthly', 'Bi-weekly', 'Accelerated bi-weekly', 'Weekly', 'Accelerated weekly'];
export const OCCUPANCY = ['Owner occupied', 'Owner occupied + rental', 'Rental / investment', 'Second home / vacation'];
export const HOME_TYPES = ['Detached', 'Semi-detached', 'Row / townhouse', 'Condo apartment', 'Condo townhouse', 'Duplex', 'Triplex', 'Fourplex', 'Mobile / modular', 'Farm / acreage', 'Multi-unit (5+)'];
export const HEAT_TYPES = ['Forced air gas', 'Forced air electric', 'Forced air oil', 'Baseboard electric', 'Hot water / boiler', 'Heat pump', 'Geothermal', 'Wood / pellet', 'Propane', 'None'];
export const WATER_TYPES = ['Municipal', 'Well', 'Cistern', 'Lake / surface'];
export const SEWER_TYPES = ['Municipal', 'Septic', 'Holding tank'];
export const CONSTRUCTION = ['Existing', 'New build', 'Under construction', 'Self-build'];
export const EMPLOYMENT = ['Employed — salaried', 'Employed — hourly', 'Employed — commission', 'Self-employed — incorporated', 'Self-employed — sole proprietor', 'Contract', 'Retired / pension', 'Maternity / parental leave', 'Student', 'Not employed'];
export const INCOME_TYPES = ['Employment', 'Self-employment', 'Bonus', 'Commission', 'Overtime', 'Rental', 'Pension', 'Investment', 'Child support', 'Spousal support', 'Disability', 'Employment insurance', 'Child benefit', 'Other'];
export const ASSET_TYPES = ['Chequing account', 'Savings account', 'TFSA', 'RRSP', 'FHSA', 'Non-registered investments', 'Vehicle', 'Real estate equity', 'Gift — immediate family', 'Business equity', 'Life insurance cash value', 'Other'];
/* The five Lendmax asks for by name, plus a catch-all so nothing a borrower
   actually owes is unrecordable. Car Loan is first on the list and separate in
   the maths: every other consumer debt has its monthly payment estimated at 5%
   of the balance, and a car loan does not — see LIABILITY_PAYMENT_RATE. */
export const LIABILITY_TYPES = ['Car Loan', 'Credit Card', 'Student Loan', 'Unsecured Line of Credit', 'Personal Loan', 'Other'];
/* The share of a balance lenders commonly take as the monthly payment on
   revolving and unsecured consumer credit. Applied live as the balance is
   typed, to every type except the ones listed as having a real, fixed payment. */
export const LIABILITY_PAYMENT_RATE = 0.05;
export const LIABILITY_PAYMENT_EXCEPT = ['Car Loan'];
export const MARITAL = ['Single', 'Married', 'Common-law', 'Separated', 'Divorced', 'Widowed'];
export const CITIZENSHIP = ['Canadian citizen', 'Permanent resident', 'Work permit', 'Study permit', 'Non-resident', 'Other'];
export const RESIDENTIAL_STATUS = ['Own', 'Rent', 'Living with family', 'Other'];
/* Lenders treat these differently: full-time salaried income is taken at face
   value, part-time and casual usually need a two-year average, and seasonal is
   often averaged over three. The portal records what it is and lets the
   underwriter apply their own policy. */
export const EMPLOYMENT_BASIS = ['Full-time', 'Part-time', 'Seasonal', 'Casual', 'Self-employed'];
export const JOB_STATUS = ['Active', 'Previous'];
export const CREDIT_SELF = ['Excellent (760+)', 'Good (700–759)', 'Fair (640–699)', 'Poor (560–639)', 'Very poor (below 560)', "I don't know"];
export const DOWN_SOURCES = ['Savings', 'TFSA', 'RRSP / Home Buyers\' Plan', 'FHSA', 'Gift — immediate family', 'Sale of existing property', 'Investments', 'Borrowed', 'Other'];
export const MORTGAGE_TYPE = ['Fixed', 'Variable', 'Adjustable', "I don't know"];
export const TIMING = ['Immediately', 'Within 30 days', '1–3 months', '3–6 months', '6+ months', 'Just researching'];

/* ---------------------------------------------------------- mortgage charges
 *
 * A charge on a property has a POSITION, and the position is the whole story:
 * it decides who gets paid first in a power of sale, what rate the money costs,
 * and — the reason it is here — what has to be counted alongside a new request
 * when the loan-to-value is worked out. A second mortgage of $100,000 behind a
 * first of $400,000 is 500 over the value, not 100.
 *
 * The same shape is used in three places: the request on section 1, the charges
 * already registered against the subject property, and the charges on every
 * other property. One list of fields, so a second mortgage is described the
 * same way wherever it appears and the ratio code has one shape to read.
 */
export const MORTGAGE_POSITIONS = [
  { v: '1', l: '1st — ahead of everything else' },
  { v: '2', l: '2nd — behind one other charge' },
  { v: '3', l: '3rd — behind two others' },
];
export const LOAN_TYPES = ['Mortgage', 'Line of Credit'];
export const MORTGAGE_TERMS = ['6 months', '1 year', '2 years', '3 years', '4 years',
  '5 years', '7 years', '10 years', 'Open / revolving'];

/**
 * The fields describing one registered charge.
 *
 * `opening_balance` is asked for as well as the current one because the pair is
 * how fast it is being paid down, and on a line of credit the difference
 * between the limit and what is drawn is the room already available — which is
 * often the answer to what somebody has come here to ask for.
 */
export const mortgageFields = () => ([
  { n: 'position', l: 'Position', t: 'select', req: true, o: MORTGAGE_POSITIONS },
  { n: 'loan_type', l: 'Loan type', t: 'select', req: true, o: LOAN_TYPES, d: 'Mortgage' },
  { n: 'lender', l: 'Lender', t: 'text', req: true },
  { n: 'balance', l: 'Current balance', t: 'money', req: true,
    hint: 'What is owed today. On a line of credit, what is drawn.' },
  { n: 'opening_balance', l: 'Opening balance', t: 'money',
    hint: 'The original amount — or, on a line of credit, the limit.' },
  { n: 'rate', l: 'Interest rate', t: 'percent', ph: '4.79' },
  { n: 'term', l: 'Term', t: 'select', o: MORTGAGE_TERMS },
  { n: 'maturity', l: 'Maturity date', t: 'date',
    when: { field: 'loan_type', in: ['Mortgage', null] } },
  { n: 'payment', l: 'Payment', t: 'money', req: true },
  { n: 'frequency', l: 'Payment frequency', t: 'select', o: FREQUENCIES, d: 'Monthly' },
  { n: 'rate_type', l: 'Fixed or variable', t: 'select', o: MORTGAGE_TYPE },
]);

const applicantScope = { n: 'applicant', l: 'Belongs to', t: 'select', req: true, o: [], dynamic: 'applicants' };

/* ------------------------------------------------------------ suggested comments
 * A section can carry `cues` — short notes that float beside the form in a
 * caption card, one at a time, telling the applicant why a question is worth
 * answering carefully or what their own answers already add up to.
 *
 * They are here rather than in the browser for the same reason every other
 * piece of copy is: one place to change the wording.
 *
 * SHAPE
 *   id     stable key — the browser remembers which one it is showing
 *   text   the comment. `{token}` is replaced from the applicant's own file
 *          and from the `cues` settings group
 *   when   {field, in|not|lt|gt}  — against this applicant's answers, or
 *          {calc, gte|lt}         — against a computed figure
 *   link   'booking' — appends the "book a call" action
 *
 * THE RULE ON NUMBERS
 * -------------------
 * A comment that quotes a figure is dropped entirely when that figure cannot be
 * worked out, rather than shown with a gap or a zero in it. So an applicant who
 * has entered no debts is never told they could save nothing, and a claim whose
 * setting has been zeroed simply disappears.
 *
 * Tokens available:
 *   {lender_count} {offer_count} {broker_name}        · from settings
 *   {location}                                        · their property's city
 *   {net_worth} {liquid} {debt_total} {debt_payments} · computed, money
 *   {debt_saving} {liquid_threshold}                  · computed, money
 *   {gds} {tds}                                       · computed, percent
 *   {other_count} {rental_ceiling} {years}            · computed, counts
 */

/* ------------------------------------------------------------------ sections
 * Order is the order of the left-hand menu and the order of the pages.
 * `repeat` marks a section built from repeating entries rather than one form.
 */
export const SECTIONS = [
  /* ---------------------------------------------------------------- 1 */
  {
    id: 'purpose',
    title: 'Purpose',
    menu: 'What you need',
    icon: 'target',
    blurb: 'Two questions. They decide everything the rest of this application asks you.',
    tip: 'Start here — your answer changes which questions come next, so nothing is asked that does not apply to you.',
    /* One comment per answer, and a general one behind them.
     *
     * The section used to carry only the general one, so choosing a goal —
     * the single most consequential thing anybody does on this form — changed
     * nothing on the right-hand side. Somebody who has just pressed Renew is
     * thinking about renewing, and that is the moment a sentence about
     * renewing is worth reading.
     *
     * Every claim here is either arithmetic anybody can check or a fact about
     * how the process works. Nothing quotes a rate, a saving or a figure about
     * this applicant, because at this point in the form nobody has entered
     * anything and there is nothing real to say. */
    cues: [
      /* Short on purpose. This is a note stuck beside the form, and on a laptop
         it has to fit above whatever it must not cover — a comment that runs
         to a paragraph pushes itself off the screen entirely. Two sentences. */
      { id: 'renew-shop', when: { field: 'purpose', in: ['Renew'] },
        h: 'A renewal letter is an offer, not a bill',
        text: 'Signing it back is the easiest option and rarely the best one. Letting us take it '
            + 'to other lenders first costs you nothing.' },
      { id: 'renew-switch', when: { field: 'purpose', in: ['Renew'] },
        h: 'Switching at the end of a term is free',
        text: 'No penalty for moving when the term is up \u2014 and since November 2024 an uninsured '
            + 'straight switch does not have to pass the stress test again.' },
      { id: 'renew-early', when: { field: 'purpose', in: ['Renew'] },
        h: 'Start 90 to 120 days out',
        text: 'Most lenders will hold a rate that far ahead of your maturity date. It costs nothing '
            + 'and protects you if rates move.' },

      { id: 'purchase-preapproval', when: { field: 'purpose', in: ['Purchase'] },
        h: 'A pre-approval is a rate hold, not a promise',
        text: 'It holds a rate while you shop. The lender still underwrites the property once you '
            + 'have an accepted offer.' },

      { id: 'refi-vs-second', when: { field: 'purpose', in: ['Refinance'] },
        h: 'Breaking the term is not the only way',
        text: 'A refinance replaces the mortgage and can carry a penalty. A second leaves the first '
            + 'where it is. We work out both.' },

      { id: 'heloc-shape', when: { field: 'purpose', in: ['Home Equity Line'] },
        h: 'A line of credit is revolving',
        text: 'You pay interest only on what you draw. A revolving line caps at 65% of the value; '
            + 'a mortgage and line together can reach 80%.' },

      /* The fallback: shown only while nothing above it applies, which on this
         section means before a goal has been chosen. Four notes about one
         question is a carousel nobody pages through. */
      { id: 'rates', fallback: true,
        h: 'Get lower rate offers with broker-negotiated deals',
        text: '38% of recent Canadian mortgage borrowers found better mortgage rates through the broker channel.',
        cite: 'Canadian Mortgage Trends, July 2026' },
    ],
    /* ------------------------------------------------------ the renewal offer
     * Shown only to somebody renewing, and only ever an offer: it asks one
     * question, shows what the answer could be worth, and takes "no thanks" for
     * an answer without argument.
     *
     * The figures in the table are an example and are labelled as one. At this
     * point in the application nobody has entered a single debt, so there is
     * nothing real to calculate — and a made-up number presented as this
     * borrower's own saving would be the worst thing on the page.
     */
    offer: {
      when: { field: 'purpose', in: ['Renew'] },
      /* Directly under the question that triggers it. Somebody who has just
         pressed Renew is thinking about renewing at that moment — putting the
         comparison at the foot of the page, after two more questions, is
         putting it after they have stopped considering the alternative. */
      after: 'purpose_main',
      optional_label: 'Optional',
      title: 'Now compare renewal vs. refinance payments & offers',
      field: 'refi_compare',
      label: 'Calculate my monthly savings with a side-by-side refinance offer',
      note_field: 'refi_note',
      note: 'I would like to review my refinance options too',
      confirm: 'Noted — your broker will bring a side-by-side refinance comparison to your call.',
      decline: 'No thanks, just the renewal',
      example: {
        /* The label on the closed disclosure. It says what is behind it AND
           that it is not a quote, because a borrower should not have to open
           something to find out it was never about their own file. */
        toggle: 'See a worked example',
        toggle_note: 'An illustration, not a quote',
        title: 'Example: Your Renewal Offer vs. Refinance',
        columns: ['Renew as-is', 'Refinance'],
        rows: [
          { l: 'Mortgage balance', a: '$211,000', b: '$303,000' },
          { l: 'Total debts & HELOC', a: '$92,000', b: '$0', strong_b: true },
          { l: 'Mortgage payment', a: '$1,264', b: '$1,526' },
          { l: 'Debt payments', a: '$1,945', b: '$0' },
          { l: 'Total monthly cost', a: '$3,209', b: '$1,526', total: true },
        ],
        savings: [
          { l: 'Monthly cash-flow savings', v: '$1,683' },
          { l: 'Over the 5-year term', v: '$100,980' },
        ],
        foot: 'An illustration, not a quote. Your own comparison is built from the debts you '
            + 'enter later in this application and confirmed by your broker.',
      },
    },
    groups: [
      {
        id: 'purpose_main',
        title: 'What are you looking to do?',
        fields: [
          { n: 'purpose', l: 'Select your goal', t: 'choice', req: true, full: true,
            o: [
              { v: 'Purchase', l: 'Purchase', icon: 'home',
                d: 'Buying a home — first, next, or investment.' },
              { v: 'Renew', l: 'Renew', icon: 'renew',
                d: 'Your term is ending and you want a better rate.' },
              { v: 'Refinance', l: 'Refinance', icon: 'coins',
                d: 'Restructure your mortgage or access equity.' },
              { v: 'Home Equity Line', l: 'Home Equity Line', icon: 'chart',
                d: 'Open a flexible line of credit against your home.' },
            ] },
        ],
      },
      {
        id: 'purpose_detail',
        title: 'A little more',
        reveal: 'purpose_main',
        fields: [
          { n: 'timing', l: 'When do you need this done?', t: 'select', req: true, o: TIMING },
          /* The request, described the same way as every charge already on the
             property: what position it will sit in, what kind of credit it is,
             and how much. The position is not a detail — it is what decides
             whether the loan-to-value is this money alone or this money on top
             of somebody else's. */
          { n: 'request_position', l: 'Position of the mortgage requested', t: 'select', req: true,
            o: MORTGAGE_POSITIONS, d: '1',
            hint: 'A 2nd or 3rd sits behind a mortgage that stays where it is.' },
          { n: 'request_loan_type', l: 'Loan type', t: 'select', req: true, o: LOAN_TYPES, d: 'Mortgage' },
          { n: 'amount_requested', l: 'Mortgage requested', t: 'money', req: true,
            hint: 'For a purchase this is the mortgage, not the price.' },
          { n: 'existing_lender', l: 'Current lender', t: 'text',
            when: { field: 'purpose', in: ['Renew', 'Refinance', 'Home Equity Line'] } },
          { n: 'maturity_date', l: 'Current mortgage matures', t: 'date',
            when: { field: 'purpose', in: ['Renew', 'Refinance'] } },
          { n: 'refi_reason', l: 'What is the money for?', t: 'select', full: true,
            when: { field: 'purpose', in: ['Refinance', 'Home Equity Line'] },
            o: ['Debt consolidation', 'Home renovation', 'Investment purchase', 'Tuition', 'Business capital', 'Tax arrears', 'Divorce / separation payout', 'Other'] },
          /* Answered by the renewal offer block below rather than by the grid,
             so they are marked hidden — but they are declared here, because a
             field that is not in the schema is a field the server does not
             validate, the review does not read back and the broker never sees. */
          { n: 'refi_compare', l: 'Wants a side-by-side refinance comparison', t: 'checkbox', hidden: true,
            when: { field: 'purpose', in: ['Renew'] } },
          { n: 'refi_note', l: 'Note to your broker', t: 'text', hidden: true,
            when: { field: 'purpose', in: ['Renew'] } },
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- 2 */
  {
    id: 'property',
    title: 'Subject property',
    menu: 'Subject property',
    icon: 'home',
    blurb: 'The property the mortgage is secured against.',
    tip: 'Estimates are fine. An appraisal decides the final value — nothing here is binding.',
    groups: [
      {
        id: 'prop_address',
        title: 'Property address',
        /* Address lookup. `fills` maps what Google gives back onto this group's
           own field names — the group decides, not the lookup, so a section that
           keeps the address on one line maps `street` instead of the split
           number and route. Absent an API key the search box is simply not
           drawn and every field stays typeable. */
        lookup: {
          l: 'Find the property',
          ph: 'Start typing the address…',
          hint: 'Pick it from the list and we will fill in the rest. Or enter it by hand below.',
          fills: {
            street_number: 'street_number', street_name: 'street_name', unit: 'unit',
            city: 'city', province: 'province', postal_code: 'postal_code',
          },
        },
        toggle: { n: 'is_subject', l: 'Make this the subject property of my application', default: true,
                  hint: 'Turn this off only if you are asking about a property you do not intend to secure the mortgage against.' },
        fields: [
          { n: 'found_property', l: 'Have you found the property?', t: 'radio', req: true, full: true,
            o: ['Yes', 'Still looking'], when: { field: 'purpose', in: ['Purchase'] } },
          { n: 'street_number', l: 'Street number', t: 'text', req: true,
            when: { field: 'found_property', in: ['Yes', null] } },
          { n: 'street_name', l: 'Street name', t: 'text', req: true,
            when: { field: 'found_property', in: ['Yes', null] } },
          { n: 'unit', l: 'Unit', t: 'text' },
          { n: 'city', l: 'City', t: 'text', req: true },
          { n: 'province', l: 'Province', t: 'select', req: true, o: PROVINCES },
          { n: 'postal_code', l: 'Postal code', t: 'postal', ph: 'A1A 1A1' },
        ],
      },
      {
        id: 'prop_detail',
        title: 'About the property',
        reveal: 'prop_address',
        fields: [
          { n: 'home_type', l: 'Property type', t: 'select', req: true, o: HOME_TYPES },
          { n: 'occupancy', l: 'How will it be used?', t: 'select', req: true, o: OCCUPANCY },
          { n: 'sqft', l: 'Living area', t: 'sqft', req: true, ph: '1,800', hint: 'Above-grade square feet.' },
          { n: 'year_built', l: 'Year built', t: 'year', ph: '1998' },
          { n: 'bedrooms', l: 'Bedrooms', t: 'number', min: 0, max: 30 },
          { n: 'bathrooms', l: 'Bathrooms', t: 'number', min: 0, max: 30, step: 0.5 },
          { n: 'construction', l: 'Construction', t: 'select', o: CONSTRUCTION },
          { n: 'heat_type', l: 'Heating', t: 'select', req: true, o: HEAT_TYPES },
          { n: 'water_type', l: 'Water', t: 'select', o: WATER_TYPES },
          { n: 'sewer_type', l: 'Sewage', t: 'select', o: SEWER_TYPES },
          { n: 'lot_size', l: 'Lot size', t: 'text', ph: '40 × 120 ft', hint: 'Frontage × depth, or acreage.' },
          { n: 'garage', l: 'Parking', t: 'select', o: ['None', 'Surface / driveway', 'Carport', 'Garage — 1', 'Garage — 2', 'Garage — 3+', 'Underground'] },
          /* Value and tax live here, with the property, rather than down in
             "The numbers" with the deal. They are facts about the house and do
             not change with what is being asked for — and the value is the
             denominator of the loan-to-value, so it is wanted on every file,
             purchase included, not only on the ones with a mortgage already. */
          { n: 'property_value', l: 'Estimated value today', t: 'money', req: true,
            hint: 'On a purchase this is usually the price. Say so if you believe it is worth more.' },
          { n: 'annual_taxes', l: 'Annual property tax', t: 'money', req: true,
            hint: 'Used in your debt ratios. An estimate is fine.' },
        ],
      },
      {
        id: 'prop_condo',
        title: 'Condominium',
        reveal: 'prop_detail',
        when: { field: 'home_type', in: ['Condo apartment', 'Condo townhouse'] },
        fields: [
          { n: 'condo_fee', l: 'Monthly condo fee', t: 'money', req: true,
            hint: 'Half of this counts against your debt ratios, which is the national standard.' },
          { n: 'condo_fee_includes_heat', l: 'Does the fee include heat?', t: 'select', o: ['Yes', 'No'] },
          { n: 'condo_corp', l: 'Condo corporation', t: 'text' },
          { n: 'condo_locker', l: 'Locker included', t: 'select', o: ['Yes', 'No'] },
        ],
      },
      /* ---------------------------------------------------- existing charges
       * What is already registered against this property, in the same shape as
       * the request and as the charges on every other property.
       *
       * Shown when there is something to describe: any purpose other than a
       * purchase, or a purchase where the money being asked for sits behind
       * somebody else's charge — a vendor take-back, or a private second.
       */
      {
        id: 'prop_mortgages',
        title: 'Mortgages already on this property',
        reveal: 'prop_detail',
        when: { any: [
          { field: 'purpose', not: ['Purchase'] },
          { field: 'request_position', in: ['2', '3'] },
        ] },
        note: 'Add each charge separately, in position order. What sits ahead of the money you are '
            + 'asking for is counted in your loan-to-value; what is being replaced is not.',
        repeat: { key: 'mortgages', min: 1, max: 3, label: 'Mortgage',
                  addLabel: 'Add mortgage liability', layout: 'list' },
        fields: mortgageFields(),
      },
      {
        id: 'prop_money',
        title: 'The numbers',
        reveal: 'prop_detail',
        fields: [
          { n: 'purchase_price', l: 'Purchase price', t: 'money', req: true,
            when: { field: 'purpose', in: ['Purchase'] } },
          { n: 'down_payment', l: 'Down payment', t: 'money', req: true,
            when: { field: 'purpose', in: ['Purchase'] } },
          { n: 'down_source', l: 'Where is the down payment coming from?', t: 'select',
            when: { field: 'purpose', in: ['Purchase'] }, o: DOWN_SOURCES },
          { n: 'monthly_heat', l: 'Monthly heating cost', t: 'money', req: true, hint: 'Estimate if you are unsure — $150 is typical.' },
          { n: 'rental_income', l: 'Monthly rental income', t: 'money',
            when: { field: 'occupancy', in: ['Owner occupied + rental', 'Rental / investment'] } },
          { n: 'closing_date', l: 'Closing / funding date', t: 'date' },
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- 3 */
  {
    id: 'applicants',
    title: 'Borrowers',
    menu: 'Borrowers',
    sub: "Who's applying",
    icon: 'user',
    blurb: 'You, and anyone applying with you.',
    tip: 'Two applicants are covered here. If there is a third or fourth, add them with the button — there is no limit that hurts your file.',
    repeat: { key: 'applicants', min: 1, max: 4, softMax: 2, label: 'Borrower', addLabel: 'Add another borrower' },
    groups: [
      {
        id: 'app_identity',
        title: 'Identity',
        fields: [
          { n: 'first_name', l: 'First name', t: 'text', req: true },
          { n: 'last_name', l: 'Last name', t: 'text', req: true },
          { n: 'email', l: 'Email', t: 'email', req: true },
          { n: 'phone', l: 'Mobile phone', t: 'phone', req: true },
          { n: 'dob', l: 'Date of birth', t: 'date', req: true },
          { n: 'marital_status', l: 'Marital status', t: 'select', req: true, o: MARITAL },
          { n: 'dependants', l: 'Dependants', t: 'number', min: 0, max: 20 },
          { n: 'citizenship', l: 'Status in Canada', t: 'select', o: CITIZENSHIP },
          { n: 'credit_self', l: 'How would you describe your credit?', t: 'select', full: true, o: CREDIT_SELF,
            hint: 'A guess is fine. We confirm it with a soft check, which does not affect your score.' },
        ],
      },
      {
        id: 'app_address',
        title: 'Current address',
        reveal: 'app_identity',
        lookup: {
          l: 'Find your address',
          ph: 'Start typing your home address…',
          hint: 'Pick it from the list and we will fill in the rest. Or enter it by hand below.',
          fills: {
            street_number: 'addr_street_number', street_name: 'addr_street_name', unit: 'addr_unit',
            city: 'addr_city', province: 'addr_province', postal_code: 'addr_postal',
          },
        },
        fields: [
          { n: 'addr_street_number', l: 'Street number', t: 'text', req: true },
          { n: 'addr_street_name', l: 'Street name', t: 'text', req: true },
          { n: 'addr_unit', l: 'Unit', t: 'text' },
          { n: 'addr_city', l: 'City', t: 'text', req: true },
          { n: 'addr_province', l: 'Province', t: 'select', req: true, o: PROVINCES },
          { n: 'addr_postal', l: 'Postal code', t: 'postal', ph: 'A1A 1A1' },
          { n: 'residential_status', l: 'Do you own or rent?', t: 'select', req: true, o: RESIDENTIAL_STATUS },
          { n: 'monthly_rent', l: 'Monthly rent', t: 'money', when: { field: 'residential_status', in: ['Rent'] } },
          { n: 'years_at_address', l: 'Years at this address', t: 'number', req: true, min: 0, max: 90, step: 0.5,
            hint: 'Under two years and we will ask for the previous one.' },
          { n: 'prev_address', l: 'Previous address', t: 'text', full: true,
            when: { field: 'years_at_address', lt: 2 } },
        ],
      },
      {
        id: 'app_employment',
        title: 'Employment and income',
        reveal: 'app_address',
        fields: [
          { n: 'employment_type', l: 'Employment', t: 'select', req: true, o: EMPLOYMENT },
          { n: 'employment_basis', l: 'Full-time or part-time?', t: 'select', req: true, o: EMPLOYMENT_BASIS,
            when: { field: 'employment_type', not: ['Retired / pension', 'Student', 'Not employed'] },
            hint: 'Lenders average part-time, seasonal and casual income over two or three years.' },
          { n: 'employer', l: 'Employer', t: 'text', req: true,
            when: { field: 'employment_type', not: ['Retired / pension', 'Student', 'Not employed'] } },
          { n: 'job_title', l: 'Job title', t: 'text',
            when: { field: 'employment_type', not: ['Retired / pension', 'Student', 'Not employed'] } },
          { n: 'years_employed', l: 'Years there', t: 'number', req: true, min: 0, max: 70, step: 0.5,
            when: { field: 'employment_type', not: ['Retired / pension', 'Student', 'Not employed'] },
            hint: 'Under three years and we will ask what came before it.' },
          { n: 'annual_income', l: 'Annual income before tax', t: 'money', req: true,
            hint: 'Base income only. Bonus, commission and rent go in the next section.' },
          { n: 'income_frequency', l: 'How are you paid?', t: 'select', o: FREQUENCIES },
        ],
      },
      /* ---------------------------------------------------------------------
       * Additional employment.
       *
       * Asked only when the current job is under three years old, because that
       * is when a lender needs the history — two to three years of it is the
       * usual test, and an applicant eight years into one job should not be
       * made to answer a question that does not apply to them.
       *
       * Each entry carries its own Active / Previous. A second job somebody
       * still holds is income; a job they have left is history. Only the active
       * ones are added to the ratio maths — see computeRatios in validate.js.
       */
      {
        id: 'app_more_jobs',
        title: 'Other employment',
        reveal: 'app_employment',
        when: { field: 'years_employed', lt: 3 },
        blurb: 'You have been in your current job under three years, so lenders will want to see what came '
             + 'before it — and any second job you still hold counts towards what you can borrow.',
        repeat: { key: 'employments', min: 1, max: 6, label: 'Employment',
                  addLabel: 'Add another employment', layout: 'list' },
        fields: [
          { n: 'status', l: 'Active or previous?', t: 'select', req: true, o: JOB_STATUS,
            hint: 'Active income counts towards your ratios. Previous is history.' },
          { n: 'employment_type', l: 'Employment', t: 'select', req: true, o: EMPLOYMENT },
          { n: 'employment_basis', l: 'Full-time or part-time?', t: 'select', req: true, o: EMPLOYMENT_BASIS,
            when: { field: 'employment_type', not: ['Retired / pension', 'Student', 'Not employed'] } },
          { n: 'employer', l: 'Employer', t: 'text', req: true },
          { n: 'job_title', l: 'Job title', t: 'text' },
          { n: 'years', l: 'Years there', t: 'number', req: true, min: 0, max: 70, step: 0.5 },
          { n: 'annual_income', l: 'Annual income before tax', t: 'money', req: true },
          { n: 'ended', l: 'When did it end?', t: 'date', when: { field: 'status', in: ['Previous'] } },
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- 4 */
  {
    id: 'income',
    title: 'Other income',
    menu: 'Other income',
    icon: 'coins',
    blurb: 'Anything beyond the base salary you just entered.',
    tip: 'Skip this if there is nothing to add. Bonus, commission, rent and support payments all help you qualify — but only if a lender can see them.',
    /* Ali listed this one under liabilities. It is about income, so it is asked
       where income is asked — a note about what counts as income is worth
       nothing on the page where somebody is listing what they owe. */
    cues: [
      { id: 'sources',
        h: '{income_lender_count} lenders use these income sources to support your approval',
        list: ['Relative paying rent', 'Child support', 'Side business income', 'Government child benefit'] },
    ],
    optional: true,
    declare: { n: 'none', l: 'I have no other income to declare' },
    /* `layout: 'list'` — these are line items, not records. A bonus is a type,
       an amount and a frequency; giving each one a full card makes four short
       answers look like four pages of work. The list packs them onto a row
       apiece and still stacks on a phone. */
    repeat: { key: 'income', min: 0, max: 20, label: 'Income', addLabel: 'Add income', layout: 'list' },
    groups: [
      {
        id: 'inc_main',
        title: 'Income',
        fields: [
          { ...applicantScope },
          { n: 'income_type', l: 'Type', t: 'select', req: true, o: INCOME_TYPES },
          { n: 'amount', l: 'Amount', t: 'money', req: true },
          { n: 'frequency', l: 'Frequency', t: 'select', req: true, o: ['Annual', ...FREQUENCIES] },
          { n: 'source', l: 'Source / payer', t: 'text' },
          { n: 'years_receiving', l: 'Years receiving', t: 'number', min: 0, max: 70, step: 0.5 },
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- 5 */
  {
    id: 'assets',
    title: 'Assets',
    menu: 'Assets',
    icon: 'wallet',
    blurb: 'What you own. Down payment, savings, investments, vehicles.',
    tip: 'Lenders want to see where the down payment and closing costs are coming from, and that you have something behind you afterwards.',
    cues: [
      /* Two versions of the same point. Before they have entered enough, it is
         a reason to keep going; once they are over the line, it is news. */
      { id: 'liquid-over', when: { calc: 'liquid', gte: 'liquid_threshold' },
        h: 'Liquid assets over {liquid_threshold}',
        text: 'Yours come to {liquid} — over the line, which can get you a better mortgage rate and a '
            + 'larger mortgage budget.' },
      /* `or_unknown` because this one is worth reading *before* anything has
         been entered — it is the reason to fill the section in. The one above
         it replaces it the moment there is a real figure to quote. */
      { id: 'liquid', when: { calc: 'liquid', lt: 'liquid_threshold', or_unknown: true },
        text: 'Liquid assets over {liquid_threshold} can get you a better mortgage rate and a larger '
            + 'mortgage budget.' },
      { id: 'networth', h: 'Add more to this net worth',
        text: 'Yours is {net_worth} so far — what you own, less what you owe. A vehicle, investments, '
            + 'a business: they all count.' },
    ],
    declare: { n: 'none', l: 'I have no assets to declare' },
    repeat: { key: 'assets', min: 1, max: 30, label: 'Asset', addLabel: 'Add asset' },
    groups: [
      {
        id: 'asset_main',
        title: 'Asset',
        fields: [
          { ...applicantScope },
          { n: 'asset_type', l: 'Type', t: 'select', req: true, o: ASSET_TYPES },
          { n: 'value', l: 'Value', t: 'money', req: true },
          { n: 'institution', l: 'Institution / description', t: 'text' },
          { n: 'for_down_payment', l: 'Using this for the down payment?', t: 'checkbox',
            when: { field: 'purpose', in: ['Purchase'] } },
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- 6 */
  {
    id: 'liabilities',
    title: 'Liabilities',
    menu: 'Liabilities',
    icon: 'scale',
    blurb: 'What you owe. Cards, loans, lines of credit, support payments.',
    tip: 'Include everything — a lender pulls your bureau and sees it all anyway. A debt you disclose is a debt we can plan around.',
    /* Said here, under the question, rather than only in a floating note: this
       is the reason the section is worth filling in accurately, and it should be
       in front of somebody as they fill it in. */
    note: 'Accurate liabilities help calculate your savings. See what your monthly and interest savings '
        + 'look like if you refinance.',
    cues: [
      /* The saving is the whole reason accuracy matters here, so it appears
         once there is something to be accurate about. Car loans aside, every
         balance carries an estimated payment at 5% — see LIABILITY_PAYMENT_RATE. */
      { id: 'consolidation', when: { calc: 'debt_total', gte: 1 },
        h: 'What this could be worth',
        text: 'You could save {debt_saving} over {years} years and improve monthly cashflow by '
            + '{debt_payments}.',
        cite: 'An estimate on the balances entered so far. Your broker confirms it.' },
      { id: 'lenders', text: 'We have {lender_count} lender and local credit union offers available for '
                           + '{location}.' },
      { id: 'intellirate', text: 'No credit check required at this time. {IntelliRate} estimates your credit '
                               + 'score based on your overall borrower profile.' },
    ],
    declare: { n: 'none', l: 'I have no liabilities to declare' },
    /* A table, not a stack of cards. Five short answers per debt, and somebody
       with six debts should be able to read down a column and see them all
       rather than scroll through six identical panels. It becomes stacked,
       labelled rows on a phone, where a five-column table cannot be read. */
    repeat: { key: 'liabilities', min: 1, max: 40, label: 'Liability', addLabel: 'Add liability', layout: 'table' },
    /* The monthly payment is worked out as the balance is typed: 5% of it, for
       everything but a car loan, whose payment is a fixed contractual amount
       nobody should have to guess at. It stays editable either way — an
       applicant who knows their real minimum should be able to say so. */
    compute: {
      field: 'payment', from: 'balance',
      rate: LIABILITY_PAYMENT_RATE,
      unless: { field: 'liability_type', in: LIABILITY_PAYMENT_EXCEPT },
      note: 'Estimated at 5% of the balance. Type over it if you know the real figure.',
    },
    groups: [
      {
        id: 'liab_main',
        title: 'Liability',
        fields: [
          { ...applicantScope },
          { n: 'liability_type', l: 'Liability type', t: 'select', req: true, o: LIABILITY_TYPES, col: '1.15fr' },
          { n: 'lender', l: 'Creditor name', t: 'text', req: true, col: '1.15fr' },
          { n: 'balance', l: 'Balance', t: 'money', req: true, col: '.95fr' },
          { n: 'payment', l: 'Monthly payment', t: 'money', req: true, col: '.95fr',
            hint: 'The minimum you must pay each month.' },
          { n: 'payoff', l: 'Paying this out with the mortgage?', t: 'checkbox', full: true,
            when: { field: 'purpose', in: ['Refinance', 'Home Equity Line'] } },
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- 7 */
  {
    id: 'other_properties',
    title: 'Other properties',
    menu: 'Other properties',
    icon: 'buildings',
    blurb: 'Any other real estate you own, and the mortgages on it.',
    tip: 'Every other property counts in your ratios — its taxes, heat and condo fees against you, its rent in your favour. Add them all.',
    cues: [
      { id: 'portfolio', text: 'Institutional lenders will generally lend up to {rental_ceiling} rentals and '
                             + '1 primary ownership. If you have more, speak with our broker about Exclusive '
                             + 'Lender Rental Programs.' },
      { id: 'portfolio-over', when: { calc: 'other_count', gte: 'rental_ceiling' },
        h: 'You are at the institutional ceiling',
        text: 'With {other_count} other properties on file you are at or beyond what most institutional '
            + 'lenders will do. Ask our broker about Exclusive Lender Rental Programs.' },
    ],
    optional: true,
    gate: { n: 'owns_other', l: 'Do you own any other property?',
            yes: 'Yes, I own more', no: "No, this is my only property" },
    repeat: { key: 'other_properties', min: 0, max: 20, label: 'Property', addLabel: 'Add another property' },
    groups: [
      {
        id: 'op_main',
        title: 'The property',
        lookup: {
          l: 'Find this property',
          ph: 'Start typing the address…',
          hint: 'Pick it from the list and we will fill in the rest. Or enter it by hand below.',
          // This section keeps the address on one line, so `street` gets the
          // number and the road together.
          fills: { street: 'street', city: 'city', province: 'province', postal_code: 'postal_code' },
        },
        fields: [
          { ...applicantScope },
          { n: 'street', l: 'Address', t: 'text', req: true, full: true },
          { n: 'city', l: 'City', t: 'text', req: true },
          { n: 'province', l: 'Province', t: 'select', req: true, o: PROVINCES },
          { n: 'postal_code', l: 'Postal code', t: 'postal' },
          { n: 'home_type', l: 'Property type', t: 'select', o: HOME_TYPES },
          { n: 'occupancy', l: 'How is it used?', t: 'select', req: true, o: OCCUPANCY },
          { n: 'value', l: 'Estimated value', t: 'money', req: true },
          { n: 'annual_taxes', l: 'Annual property tax', t: 'money', req: true },
          { n: 'monthly_heat', l: 'Monthly heat', t: 'money', req: true },
          { n: 'condo_fee', l: 'Monthly condo fee', t: 'money',
            when: { field: 'home_type', in: ['Condo apartment', 'Condo townhouse'] } },
          { n: 'rental_income', l: 'Monthly rental income', t: 'money',
            when: { field: 'occupancy', in: ['Owner occupied + rental', 'Rental / investment'] } },
          { n: 'to_be_sold', l: 'Being sold before closing', t: 'checkbox' },
        ],
      },
      {
        id: 'op_mortgage',
        title: 'Mortgages on this property',
        reveal: 'op_main',
        fields: [
          { n: 'has_mortgage', l: 'Is there a mortgage on it?', t: 'select', req: true, full: true, o: ['Yes', 'No'] },
        ],
      },
      /* Was a first mortgage and a single escape hatch for "and a second".
         Now a list, because a rental with a first, a HELOC and a private second
         is an ordinary file and the escape hatch could hold one of the three. */
      {
        id: 'op_mortgages',
        title: 'The charges',
        reveal: 'op_mortgage',
        when: { field: 'has_mortgage', in: ['Yes'] },
        repeat: { key: 'mortgages', min: 1, max: 3, label: 'Mortgage',
                  addLabel: 'Add mortgage liability', layout: 'list' },
        fields: mortgageFields(),
      },
    ],
  },

  /* ---------------------------------------------------------------- 8 */
  /* ---------------------------------------------------------------- 9 */
  {
    id: 'review',
    title: 'Review & submit',
    menu: 'Review & submit',
    sub: 'Final check',
    icon: 'check',
    blurb: 'Check it over, consent, and send it to your broker.',
    tip: 'Nothing is submitted until you press the button. You can go back to any section from the menu on the left.',
    cues: [
      { id: 'ratios', when: { calc: 'gds', gte: 0 },
        h: 'Your current ratios',
        text: '{gds} / {tds}. GDS is what the home costs you against your income; TDS adds everything '
            + 'else you owe.' },
      { id: 'dontworry', h: 'Don\u2019t worry!',
        text: 'We manually review every file for structure and saving. One thing AI does not have is our '
            + '20 years of mortgage experience.' },
      { id: 'offers', h: 'What this means',
        text: '{offer_count} rate offers may apply to your personalized quote.' },
      { id: 'call', link: 'booking',
        text: 'Schedule your 10 minute call with our lead broker, {broker_name}.' },
    ],
    terminal: true,
    /* -------------------------------------------------------- the agreement
     * Held here rather than as markup in the browser, for the same reason
     * every other question is: one source of truth, and a change to the wording
     * is a change to this file rather than a hunt through a template.
     *
     * Shown in full, in a scrolling panel, rather than behind a "read this"
     * link or a collapsed block. The applicant can see it is there, see how
     * long it is, and read it without leaving the page or clicking anything.
     *
     * There is no exclusivity period and no brokerage recovery fee in this
     * agreement. The clause that carried both was removed at Lendmax's
     * instruction; nothing else in the document refers to either, and the
     * acknowledgement below no longer needs to warn about a commitment the
     * applicant is not making.
     */
    agreement: {
      id: 'consent',
      title: 'Client Consent, Privacy & Product Suitability Agreement',
      intro: 'This explains what we collect, what we do with it, and what you are agreeing to. '
           + 'Please read it before you accept below. One borrower may accept for all borrowers.',
      sections: [
        {
          n: '1', h: 'WHAT WE COLLECT',
          bullets: [
            'Who you are: name, address, phone, email, date of birth, SIN, driver’s licence or passport.',
            'Your finances: income, employment, assets, debts, banking and investment details, and your credit report.',
            'Your file: your mortgage application and the supporting documents you give us.',
          ],
          after: 'We may also confirm this information with employers, lenders, credit bureaus and other third parties.',
        },
        {
          n: '2', h: 'WHY WE COLLECT IT',
          body: 'To confirm who you are, check whether you qualify, recommend a suitable mortgage, arrange and '
              + 'service your mortgage, and meet our legal and regulatory obligations under PIPEDA and provincial '
              + 'mortgage rules.',
        },
        {
          n: '3', h: 'WHO WE SHARE IT WITH',
          bullets: [
            'Lenders, mortgage insurers, other brokerages, financial institutions, credit bureaus and service providers working on your application.',
            'A licensed insurance brokerage, for home and auto insurance quotes — you can opt out of this at any time.',
            'Your realtor, builder or financial planner, only with your permission.',
          ],
          after: 'We keep your file for at least three (3) years, as the law requires.',
        },
        {
          n: '4', h: 'CONSENT TO PULL YOUR CREDIT',
          body: 'You authorize Lendmax Inc. to obtain your credit report(s) now and at any time during the next '
              + 'six (6) months, and to verify your income, employment, debts and other financial information with '
              + 'third parties. You agree we may share what we collect with lenders, insurers and service providers '
              + 'involved in your mortgage.',
        },
        {
          n: '5', h: 'EMAILS AND TEXTS',
          body: 'You consent to receive electronic messages from Lendmax Inc. and its affiliated brands about '
              + 'mortgage news, products, services and events, in line with Canada’s Anti-Spam Legislation. '
              + 'You can unsubscribe at any time.',
        },
        {
          n: '6', h: 'WHAT YOU SHOULD KNOW BEFORE CHOOSING A MORTGAGE',
          bullets: [
            'A variable rate can change, so your payment or amortization can change.',
            'Paying your mortgage off early, or breaking it, can trigger a prepayment charge or penalty.',
            'A change in your income, credit or debt can affect whether you still qualify before closing.',
            'Every mortgage product carries risk and should be chosen based on your own needs and circumstances.',
          ],
        },
      ],
    },
    groups: [
      {
        id: 'consent',
        title: 'Consent',
        fields: [
          /* One acceptance, covering both the contact consent and the agreement
             above it — including clause 4, which is the credit authorisation in
             the wording Lendmax uses.
             
             There is no typed signature. What is recorded instead is this tick,
             the exact wording it appeared under, and the moment it was made —
             stamped by this server rather than by the applicant's own clock,
             because a consent record with a date the signer could set is not a
             record of anything. See routes/portal.js. */
          { n: 'consent', t: 'checkbox', req: true, full: true,
            l: 'I consent to be contacted about this application, and understand and agree to the terms of the '
             + 'Client Consent, Privacy & Product Suitability Agreement',
            hint: 'Contact by phone, email or text about this application. You can withdraw at any time. '
                + 'One borrower may accept for all borrowers.' },
          { n: 'notes', l: 'Anything we should know?', t: 'textarea', full: true,
            ph: 'A past bankruptcy, a job change coming up, a tight closing date — tell us now rather than later.' },
        ],
      },
    ],
  },
  /* ---------------------------------------------------------------- after
   * Documents is a stage *after* submission, not a step before it.
   *
   * Nothing here is needed to assess an application — a broker can read the file
   * and start work the moment it arrives — and asking for paperwork before
   * somebody has committed is how applications get abandoned at the last screen.
   * So the application is submitted first, and then this opens, and it stays
   * open: a pay stub that arrives on Friday still lands on the file.
   */
  {
    id: 'documents',
    title: 'Documents',
    menu: 'Documents',
    sub: 'Proof to go with it',
    icon: 'file',
    after_submit: true,
    blurb: 'Your application is with a broker. Attaching these now is what moves it fastest — but nothing here '
         + 'holds it up, and you can come back to this page whenever you like.',
    tip: 'Every document you attach is one your broker does not have to chase. Photos of paper are fine, as long as all four corners are in frame.',
    optional: true,
    upload: {
      accept: ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'],
      accept_label: 'PDF, JPG, PNG or HEIC',
      max_file_mb: 25,
      max_files: 30,
      /* The checklist is guidance, not a gate. A file can be tagged with one of
         these, or left untagged — nothing here is required, because a missing
         document is a phone call, not a reason to block a submission. */
      /* `per_borrower` items are asked of each borrower by name. Photo ID and
         proof of income belong to a person, not to an application: a file with
         two borrowers needs two sets, and a broker chasing the missing one has
         to know whose it is. */
      /* Every row names the specific documents it accepts. That list is not
         decoration: the chosen one becomes part of the stored file's name, so
         a broker opening the folder sees "Priya-Sharma-Drivers-Licence.pdf"
         rather than "IMG_4471.HEIC" — and two photo IDs are told apart. */
      checklist: [
        { id: 'id', l: 'Photo ID', d: 'One piece, showing your photo and signature.', per_borrower: true,
          types: ["Driver's Licence", 'Passport', 'Provincial ID Card', 'PR Card', 'Citizenship Card'] },
        { id: 'income', l: 'Proof of income', d: 'Recent pay stubs, or a letter of employment.', per_borrower: true,
          types: ['Pay Stub', 'Letter of Employment', 'Employment Contract', 'Pension Statement', 'Bank Statement — Income'] },
        { id: 'tax', l: 'Tax documents', d: 'T4s, or the last two Notices of Assessment if self-employed.', per_borrower: true,
          types: ['T4', 'Notice of Assessment', 'T1 General', 'T2125 — Business Income', 'Financial Statements'] },
        { id: 'bank', l: 'Bank statements', d: '90 days for the down payment, if you are buying.',
          when: { field: 'purpose', in: ['Purchase'] },
          types: ['Bank Statement', 'Investment Statement', 'Gift Letter', 'Deposit Receipt'] },
        { id: 'mortgage', l: 'Current mortgage statement', d: 'Balance, rate, payment and maturity date.',
          when: { field: 'purpose', in: ['Renew', 'Refinance', 'Home Equity Line'] },
          types: ['Mortgage Statement', 'Renewal Letter', 'Property Tax Bill', 'HELOC Statement'] },
        { id: 'property', l: 'Property documents', d: 'Purchase agreement, MLS listing, or a recent tax bill.',
          types: ['Purchase Agreement', 'MLS Listing', 'Property Tax Bill', 'Condo Status Certificate', 'Appraisal', 'Insurance Binder'] },
        { id: 'other', l: 'Anything else', d: 'A separation agreement, a gift letter, a lease.',
          types: ['Separation Agreement', 'Gift Letter', 'Lease Agreement', 'Void Cheque', 'Other Document'] },
      ],
    },
    groups: [
      {
        id: 'doc_upload',
        title: 'A note for your broker',
        fields: [
          { n: 'notes', l: 'Anything we should know about these?', t: 'textarea', full: true,
            ph: 'The second pay stub is coming Friday — my employer only issues them fortnightly.' },
        ],
      },
    ],
  },

];

/* ------------------------------------------------------------------ helpers */

export const SECTION_IDS = SECTIONS.map((s) => s.id);
export const sectionById = (id) => SECTIONS.find((s) => s.id === id) || null;

/**
 * Every field in a section, flattened, in order.
 *
 * A group can carry its own `when` — the condominium subsection only exists for
 * a condo. That condition has to travel down to each field, or a required field
 * inside a hidden group is demanded on a page where it is not even shown.
 */
export function fieldsOf(section) {
  return section.groups
    /* A group with its own `repeat` is a list nested inside the entry — an
       applicant's other jobs. Its fields belong to each row of that list, not to
       the entry, so they are validated separately by repeatGroupsOf below. Left
       in here they would be demanded once, at the wrong level. */
    .filter((g) => !g.repeat)
    .flatMap((g) => g.fields.map((f) => ({
      ...f,
      group: g.id,
      // a field's own condition wins; the group's applies when it has none
      when: f.when || g.when,
      groupWhen: g.when || null,
    })));
}

/** The groups that are themselves lists, nested inside each entry. */
export function repeatGroupsOf(section) {
  return section.groups.filter((g) => g.repeat);
}

/**
 * Is a conditional field active, given the values around it?
 * `scope` is the entry being filled, `root` the whole application — so a field
 * can depend on a sibling (liability_type) or on the purpose chosen in step 1.
 */
export function isActive(field, scope = {}, root = {}) {
  // A field inside a conditional group is only live when the group is.
  if (field.groupWhen && field.when !== field.groupWhen
      && !isActive({ when: field.groupWhen }, scope, root)) return false;

  const w = field.when;
  if (!w) return true;
  /* Any of these. The subject property's existing charges are wanted on every
     purpose except a purchase — and on a purchase too, if the money being asked
     for sits behind somebody else's charge. Two reasons, one group. */
  if (w.any) return w.any.some((c) => isActive({ when: c }, scope, root));
  const val = scope[w.field] !== undefined ? scope[w.field] : root[w.field];
  if (w.in) return w.in.includes(val === undefined || val === '' ? null : val);
  if (w.not) return !w.not.includes(val);
  if (w.lt !== undefined) return val !== '' && val !== undefined && Number(val) < w.lt;
  if (w.gt !== undefined) return val !== '' && val !== undefined && Number(val) > w.gt;
  return true;
}

/* --------------------------------------------------------------- prefill
 * The main site's Apply links arrive carrying what the visitor already told us.
 *
 *   · the hero's dual CTA sends ?intent=purchase | renew
 *   · the six-field lead form on every page forwards first_name, last_name,
 *     email, phone, property_city and situation
 *
 * Without this map those answers land here and are thrown away, and the
 * applicant retypes their own name and email on the very next screen. Only
 * these keys are read; anything else in the query string is ignored.
 */
const INTENT = {
  purchase: 'Purchase', buy: 'Purchase', purchasing: 'Purchase',
  renew: 'Renew', renewal: 'Renew',
  refinance: 'Refinance', refi: 'Refinance',
  heloc: 'Home Equity Line', equity: 'Home Equity Line', 'home-equity': 'Home Equity Line',
};

/** "Mississauga, ON" → { city, province } */
function splitCity(text) {
  const parts = String(text).split(',').map((s) => s.trim()).filter(Boolean);
  const out = { city: parts[0] || '' };
  const prov = (parts[1] || '').toUpperCase();
  if (PROVINCES.some((p) => p.v === prov)) out.province = prov;
  return out;
}

/**
 * Turn query parameters into a partial application.
 * @returns {{data:object, applied:string[]}}
 */
export function prefillFromQuery(query = {}) {
  const get = (k) => {
    const v = query[k];
    return typeof v === 'string' ? v.trim().slice(0, 200) : '';
  };
  const data = {};
  const applied = [];
  const put = (section, key, value) => {
    if (!value) return;
    data[section] = data[section] || (section === 'applicants' ? [{}] : {});
    if (section === 'applicants') data.applicants[0][key] = value;
    else data[section][key] = value;
    applied.push(`${section}.${key}`);
  };

  const intent = INTENT[get('intent').toLowerCase()];
  if (intent) put('purpose', 'purpose', intent);

  // The lead form's own purpose select, when it names one of our four.
  const situation = get('situation') || get('loan_purpose');
  if (!intent && situation) {
    const matched = ['Purchase', 'Renew', 'Refinance', 'Home Equity Line']
      .find((p) => situation.toLowerCase().includes(p.toLowerCase().split(' ')[0]));
    if (matched) put('purpose', 'purpose', matched);
  }

  put('applicants', 'first_name', get('first_name'));
  put('applicants', 'last_name', get('last_name'));
  put('applicants', 'email', get('email'));
  put('applicants', 'phone', get('phone'));

  const cityRaw = get('property_city') || get('city');
  if (cityRaw) {
    const { city, province } = splitCity(cityRaw);
    put('property', 'city', city);
    if (province) put('property', 'province', province);
  }

  const amount = get('amount') || get('amount_requested');
  if (amount && /\d/.test(amount)) put('purpose', 'amount_requested', amount.replace(/[^0-9.]/g, ''));

  return { data, applied };
}

/** The schema as plain JSON, for the browser. */
export function publicSchema() {
  return {
    sections: SECTIONS,
    vocab: {
      PROVINCES, FREQUENCIES, OCCUPANCY, HOME_TYPES, HEAT_TYPES, WATER_TYPES,
      SEWER_TYPES, CONSTRUCTION, EMPLOYMENT, INCOME_TYPES, ASSET_TYPES,
      LIABILITY_TYPES, MARITAL, CITIZENSHIP, RESIDENTIAL_STATUS, CREDIT_SELF,
      DOWN_SOURCES, MORTGAGE_TYPE, TIMING, EMPLOYMENT_BASIS, JOB_STATUS,
      LIABILITY_PAYMENT_RATE, LIABILITY_PAYMENT_EXCEPT,
    },
  };
}
