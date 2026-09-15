/**
 * The RateShop calculator library, and which one belongs on which file.
 *
 * Every entry was read from https://rateshop.ca/mortgage-calculator/ and every
 * URL fetched and confirmed to return 200 before it was written down (see
 * docs/research/follow-up-and-content.md). The smoke test re-checks them, so a
 * page RateShop renames shows up as a failing build rather than as a dead link
 * in a client's inbox.
 *
 * Nothing here is generated at runtime: a calculator link in a client message
 * is a closed list, for the same reason the merge-field registry is. A
 * template cannot invent a URL.
 */

export type CalculatorCategory =
  | 'Payments and amortization'
  | 'What you can afford'
  | 'The cost of buying'
  | 'Renewing, refinancing and breaking'
  | 'Using your equity'
  | 'Harder files';

export type Calculator = {
  slug: string;
  name: string;
  category: CalculatorCategory;
};

const BASE = 'https://rateshop.ca/mortgage-calculator';

export const CALCULATORS: Calculator[] = [
  { slug: 'mortgage-payment-calculator', name: 'Mortgage Payment Calculator', category: 'Payments and amortization' },
  { slug: 'amortization-schedule-calculator', name: 'Amortization Schedule Calculator', category: 'Payments and amortization' },
  { slug: 'accelerated-payment-calculator', name: 'Accelerated Payment Calculator', category: 'Payments and amortization' },
  { slug: 'mortgage-prepayment-calculator', name: 'Mortgage Prepayment Calculator', category: 'Payments and amortization' },
  { slug: 'blend-and-extend-calculator', name: 'Blend & Extend Calculator', category: 'Payments and amortization' },

  { slug: 'mortgage-affordability-calculator', name: 'Mortgage Affordability Calculator', category: 'What you can afford' },
  { slug: 'maximum-purchase-price-calculator', name: 'Maximum Purchase Price Calculator', category: 'What you can afford' },
  { slug: 'gds-tds-calculator', name: 'GDS / TDS Ratio Calculator', category: 'What you can afford' },
  { slug: 'mortgage-stress-test-calculator', name: 'Mortgage Stress Test Calculator', category: 'What you can afford' },
  { slug: 'down-payment-calculator', name: 'Minimum Down Payment Calculator', category: 'What you can afford' },
  { slug: 'down-payment-savings-calculator', name: 'Down Payment Savings Timeline (FHSA + HBP)', category: 'What you can afford' },

  { slug: 'closing-costs-calculator', name: 'Closing Costs Calculator', category: 'The cost of buying' },
  { slug: 'land-transfer-tax-calculator', name: 'Land Transfer Tax Calculator', category: 'The cost of buying' },
  { slug: 'cmhc-insurance-calculator', name: 'CMHC Insurance Calculator', category: 'The cost of buying' },
  { slug: 'property-tax-calculator', name: 'Property Tax Calculator', category: 'The cost of buying' },
  { slug: 'new-home-gst-rebate-calculator', name: 'New Home GST/HST Rebate Calculator', category: 'The cost of buying' },
  { slug: 'cost-of-ownership-calculator', name: 'Total Cost of Ownership Calculator', category: 'The cost of buying' },
  { slug: 'non-resident-buyer-calculator', name: 'Non-Resident / Foreign Buyer Cost Calculator', category: 'The cost of buying' },

  { slug: 'mortgage-renewal-calculator', name: 'Mortgage Renewal Calculator', category: 'Renewing, refinancing and breaking' },
  { slug: 'mortgage-refinance-calculator', name: 'Mortgage Refinance Calculator', category: 'Renewing, refinancing and breaking' },
  { slug: 'refinance-vs-renew-calculator', name: 'Refinance vs Renew Calculator', category: 'Renewing, refinancing and breaking' },
  { slug: 'mortgage-penalty-calculator', name: 'Mortgage Penalty Calculator', category: 'Renewing, refinancing and breaking' },
  { slug: 'break-mortgage-calculator', name: 'Break vs Stay Calculator', category: 'Renewing, refinancing and breaking' },
  { slug: 'rate-comparison-calculator', name: 'Rate Comparison Calculator', category: 'Renewing, refinancing and breaking' },
  { slug: 'fixed-vs-variable-calculator', name: 'Fixed vs. Variable Rate Comparison', category: 'Renewing, refinancing and breaking' },

  { slug: 'heloc-calculator', name: 'HELOC Calculator', category: 'Using your equity' },
  { slug: 'home-equity-calculator', name: 'Home Equity Calculator', category: 'Using your equity' },
  { slug: 'debt-consolidation-calculator', name: 'Debt Consolidation Calculator', category: 'Using your equity' },
  { slug: 'reverse-mortgage-calculator', name: 'Reverse Mortgage Calculator', category: 'Using your equity' },
  { slug: 'purchase-plus-improvements-calculator', name: 'Purchase Plus Improvements Calculator', category: 'Using your equity' },

  { slug: 'self-employed-mortgage-calculator', name: 'Self-Employed Income Qualification Calculator', category: 'Harder files' },
  { slug: 'rental-property-calculator', name: 'Rental Property Cash Flow & Qualification Calculator', category: 'Harder files' },
  { slug: 'rent-vs-buy-calculator', name: 'Rent vs. Buy Calculator', category: 'Harder files' },
  { slug: 'bridge-financing-calculator', name: 'Bridge Financing Calculator', category: 'Harder files' },
  { slug: 'private-mortgage-calculator', name: 'Private Mortgage True Cost Calculator', category: 'Harder files' },
  { slug: 'mortgage-insurance-vs-term-life-calculator', name: 'Mortgage Insurance vs. Term Life Comparison', category: 'Harder files' },
];

const BY_SLUG = new Map(CALCULATORS.map((c) => [c.slug, c]));

export function calculatorUrl(slug: string): string {
  const found = BY_SLUG.get(slug);
  if (!found) throw new Error(`Unknown calculator: ${slug}`);
  return `${BASE}/${found.slug}/`;
}

export function findCalculator(slug: string): Calculator | undefined {
  return BY_SLUG.get(slug);
}

/**
 * Which calculator answers the question this client is actually asking.
 *
 * Keyed on the transaction type's key as seeded in `transaction_types`. The
 * first entry is what a message uses when it wants one number to make its
 * point; the rest are what the workspace offers the broker to pick from.
 *
 * A type that is not on this list gets the payment calculator, which is true
 * for every mortgage that exists and therefore cannot be wrong — but it is
 * also the least interesting, so a missing mapping is worth adding rather
 * than leaving to the fallback.
 */
export const CALCULATORS_BY_TRANSACTION: Record<string, string[]> = {
  purchase: ['maximum-purchase-price-calculator', 'closing-costs-calculator',
             'land-transfer-tax-calculator', 'cmhc-insurance-calculator'],
  pre_approval: ['mortgage-affordability-calculator', 'mortgage-stress-test-calculator',
                 'down-payment-calculator'],
  first_time_buyer: ['down-payment-savings-calculator', 'rent-vs-buy-calculator',
                     'land-transfer-tax-calculator'],
  refinance: ['mortgage-refinance-calculator', 'debt-consolidation-calculator',
              'home-equity-calculator'],
  renewal: ['refinance-vs-renew-calculator', 'mortgage-renewal-calculator',
            'rate-comparison-calculator'],
  switch: ['rate-comparison-calculator', 'mortgage-penalty-calculator',
           'break-mortgage-calculator'],
  transfer: ['rate-comparison-calculator', 'mortgage-penalty-calculator',
             'break-mortgage-calculator'],
  equity_takeout: ['home-equity-calculator', 'heloc-calculator',
                   'debt-consolidation-calculator'],
  debt_consolidation: ['debt-consolidation-calculator', 'cost-of-ownership-calculator'],
  self_employed: ['self-employed-mortgage-calculator', 'gds-tds-calculator'],
  rental: ['rental-property-calculator', 'cost-of-ownership-calculator'],
  investment: ['rental-property-calculator', 'cost-of-ownership-calculator'],
  private: ['private-mortgage-calculator', 'mortgage-penalty-calculator'],
  construction: ['purchase-plus-improvements-calculator', 'bridge-financing-calculator'],
  reverse: ['reverse-mortgage-calculator', 'home-equity-calculator'],
};

const FALLBACK = 'mortgage-payment-calculator';

/** The one calculator to put in a message for this file. */
export function calculatorFor(transactionTypeKey: string | null | undefined): Calculator {
  const list = CALCULATORS_BY_TRANSACTION[String(transactionTypeKey ?? '')] ?? [];
  return BY_SLUG.get(list[0] ?? FALLBACK) ?? BY_SLUG.get(FALLBACK)!;
}

/** Everything worth offering on this file, best first. */
export function calculatorsFor(transactionTypeKey: string | null | undefined): Calculator[] {
  const list = CALCULATORS_BY_TRANSACTION[String(transactionTypeKey ?? '')] ?? [FALLBACK];
  return list.map((s) => BY_SLUG.get(s)).filter((c): c is Calculator => Boolean(c));
}
