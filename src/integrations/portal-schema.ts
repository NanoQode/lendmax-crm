/**
 * The application form, as apply.lendmax.ca defines it.
 *
 * GENERATED — do not edit. Run `node scripts/vendor-portal-schema.mjs` after
 * copying a newer `lib/schema.js` into `vendor/portal-schema.js`.
 *
 * Source: /srv/lendmax-portal/lib/schema.js
 * sha256: e1a70ead840fbd11 (first 16)
 * Sections: 9
 *
 * Why it is vendored rather than re-typed: the portal's copy is the single
 * source of truth for what the form asks, when each question appears and what
 * it accepts. A second hand-written copy here would drift, and the day it did,
 * a broker would be correcting a client's answer on a form that no longer
 * matched the one the client filled in.
 */

export const PORTAL_SCHEMA = {
  "sections": [
    {
      "id": "purpose",
      "title": "Purpose",
      "menu": "What you need",
      "icon": "target",
      "blurb": "Two questions. They decide everything the rest of this application asks you.",
      "tip": "Start here — your answer changes which questions come next, so nothing is asked that does not apply to you.",
      "cues": [
        {
          "id": "renew-shop",
          "when": {
            "field": "purpose",
            "in": [
              "Renew"
            ]
          },
          "h": "A renewal letter is an offer, not a bill",
          "text": "Signing it back is the easiest option and rarely the best one. Letting us take it to other lenders first costs you nothing."
        },
        {
          "id": "renew-switch",
          "when": {
            "field": "purpose",
            "in": [
              "Renew"
            ]
          },
          "h": "Switching at the end of a term is free",
          "text": "No penalty for moving when the term is up — and since November 2024 an uninsured straight switch does not have to pass the stress test again."
        },
        {
          "id": "renew-early",
          "when": {
            "field": "purpose",
            "in": [
              "Renew"
            ]
          },
          "h": "Start 90 to 120 days out",
          "text": "Most lenders will hold a rate that far ahead of your maturity date. It costs nothing and protects you if rates move."
        },
        {
          "id": "purchase-preapproval",
          "when": {
            "field": "purpose",
            "in": [
              "Purchase"
            ]
          },
          "h": "A pre-approval is a rate hold, not a promise",
          "text": "It holds a rate while you shop. The lender still underwrites the property once you have an accepted offer."
        },
        {
          "id": "refi-vs-second",
          "when": {
            "field": "purpose",
            "in": [
              "Refinance"
            ]
          },
          "h": "Breaking the term is not the only way",
          "text": "A refinance replaces the mortgage and can carry a penalty. A second leaves the first where it is. We work out both."
        },
        {
          "id": "heloc-shape",
          "when": {
            "field": "purpose",
            "in": [
              "Home Equity Line"
            ]
          },
          "h": "A line of credit is revolving",
          "text": "You pay interest only on what you draw. A revolving line caps at 65% of the value; a mortgage and line together can reach 80%."
        },
        {
          "id": "rates",
          "fallback": true,
          "h": "Get lower rate offers with broker-negotiated deals",
          "text": "38% of recent Canadian mortgage borrowers found better mortgage rates through the broker channel.",
          "cite": "Canadian Mortgage Trends, July 2026"
        }
      ],
      "offer": {
        "when": {
          "field": "purpose",
          "in": [
            "Renew"
          ]
        },
        "after": "purpose_main",
        "optional_label": "Optional",
        "title": "Now compare renewal vs. refinance payments & offers",
        "field": "refi_compare",
        "label": "Calculate my monthly savings with a side-by-side refinance offer",
        "note_field": "refi_note",
        "note": "I would like to review my refinance options too",
        "confirm": "Noted — your broker will bring a side-by-side refinance comparison to your call.",
        "decline": "No thanks, just the renewal",
        "example": {
          "toggle": "See a worked example",
          "toggle_note": "An illustration, not a quote",
          "title": "Example: Your Renewal Offer vs. Refinance",
          "columns": [
            "Renew as-is",
            "Refinance"
          ],
          "rows": [
            {
              "l": "Mortgage balance",
              "a": "$211,000",
              "b": "$303,000"
            },
            {
              "l": "Total debts & HELOC",
              "a": "$92,000",
              "b": "$0",
              "strong_b": true
            },
            {
              "l": "Mortgage payment",
              "a": "$1,264",
              "b": "$1,526"
            },
            {
              "l": "Debt payments",
              "a": "$1,945",
              "b": "$0"
            },
            {
              "l": "Total monthly cost",
              "a": "$3,209",
              "b": "$1,526",
              "total": true
            }
          ],
          "savings": [
            {
              "l": "Monthly cash-flow savings",
              "v": "$1,683"
            },
            {
              "l": "Over the 5-year term",
              "v": "$100,980"
            }
          ],
          "foot": "An illustration, not a quote. Your own comparison is built from the debts you enter later in this application and confirmed by your broker."
        }
      },
      "groups": [
        {
          "id": "purpose_main",
          "title": "What are you looking to do?",
          "fields": [
            {
              "n": "purpose",
              "l": "Select your goal",
              "t": "choice",
              "req": true,
              "full": true,
              "o": [
                {
                  "v": "Purchase",
                  "l": "Purchase",
                  "icon": "home",
                  "d": "Buying a home — first, next, or investment."
                },
                {
                  "v": "Renew",
                  "l": "Renew",
                  "icon": "renew",
                  "d": "Your term is ending and you want a better rate."
                },
                {
                  "v": "Refinance",
                  "l": "Refinance",
                  "icon": "coins",
                  "d": "Restructure your mortgage or access equity."
                },
                {
                  "v": "Home Equity Line",
                  "l": "Home Equity Line",
                  "icon": "chart",
                  "d": "Open a flexible line of credit against your home."
                }
              ]
            }
          ]
        },
        {
          "id": "purpose_detail",
          "title": "A little more",
          "reveal": "purpose_main",
          "fields": [
            {
              "n": "timing",
              "l": "When do you need this done?",
              "t": "select",
              "req": true,
              "o": [
                "Immediately",
                "Within 30 days",
                "1–3 months",
                "3–6 months",
                "6+ months",
                "Just researching"
              ]
            },
            {
              "n": "request_position",
              "l": "Position of the mortgage requested",
              "t": "select",
              "req": true,
              "o": [
                {
                  "v": "1",
                  "l": "1st — ahead of everything else"
                },
                {
                  "v": "2",
                  "l": "2nd — behind one other charge"
                },
                {
                  "v": "3",
                  "l": "3rd — behind two others"
                }
              ],
              "d": "1",
              "hint": "A 2nd or 3rd sits behind a mortgage that stays where it is."
            },
            {
              "n": "request_loan_type",
              "l": "Loan type",
              "t": "select",
              "req": true,
              "o": [
                "Mortgage",
                "Line of Credit"
              ],
              "d": "Mortgage"
            },
            {
              "n": "amount_requested",
              "l": "Mortgage requested",
              "t": "money",
              "req": true,
              "hint": "For a purchase this is the mortgage, not the price."
            },
            {
              "n": "existing_lender",
              "l": "Current lender",
              "t": "text",
              "when": {
                "field": "purpose",
                "in": [
                  "Renew",
                  "Refinance",
                  "Home Equity Line"
                ]
              }
            },
            {
              "n": "maturity_date",
              "l": "Current mortgage matures",
              "t": "date",
              "when": {
                "field": "purpose",
                "in": [
                  "Renew",
                  "Refinance"
                ]
              }
            },
            {
              "n": "refi_reason",
              "l": "What is the money for?",
              "t": "select",
              "full": true,
              "when": {
                "field": "purpose",
                "in": [
                  "Refinance",
                  "Home Equity Line"
                ]
              },
              "o": [
                "Debt consolidation",
                "Home renovation",
                "Investment purchase",
                "Tuition",
                "Business capital",
                "Tax arrears",
                "Divorce / separation payout",
                "Other"
              ]
            },
            {
              "n": "refi_compare",
              "l": "Wants a side-by-side refinance comparison",
              "t": "checkbox",
              "hidden": true,
              "when": {
                "field": "purpose",
                "in": [
                  "Renew"
                ]
              }
            },
            {
              "n": "refi_note",
              "l": "Note to your broker",
              "t": "text",
              "hidden": true,
              "when": {
                "field": "purpose",
                "in": [
                  "Renew"
                ]
              }
            }
          ]
        }
      ]
    },
    {
      "id": "property",
      "title": "Subject property",
      "menu": "Subject property",
      "icon": "home",
      "blurb": "The property the mortgage is secured against.",
      "tip": "Estimates are fine. An appraisal decides the final value — nothing here is binding.",
      "groups": [
        {
          "id": "prop_address",
          "title": "Property address",
          "lookup": {
            "l": "Find the property",
            "ph": "Start typing the address…",
            "hint": "Pick it from the list and we will fill in the rest. Or enter it by hand below.",
            "fills": {
              "street_number": "street_number",
              "street_name": "street_name",
              "unit": "unit",
              "city": "city",
              "province": "province",
              "postal_code": "postal_code"
            }
          },
          "toggle": {
            "n": "is_subject",
            "l": "Make this the subject property of my application",
            "default": true,
            "hint": "Turn this off only if you are asking about a property you do not intend to secure the mortgage against."
          },
          "fields": [
            {
              "n": "found_property",
              "l": "Have you found the property?",
              "t": "radio",
              "req": true,
              "full": true,
              "o": [
                "Yes",
                "Still looking"
              ],
              "when": {
                "field": "purpose",
                "in": [
                  "Purchase"
                ]
              }
            },
            {
              "n": "street_number",
              "l": "Street number",
              "t": "text",
              "req": true,
              "when": {
                "field": "found_property",
                "in": [
                  "Yes",
                  null
                ]
              }
            },
            {
              "n": "street_name",
              "l": "Street name",
              "t": "text",
              "req": true,
              "when": {
                "field": "found_property",
                "in": [
                  "Yes",
                  null
                ]
              }
            },
            {
              "n": "unit",
              "l": "Unit",
              "t": "text"
            },
            {
              "n": "city",
              "l": "City",
              "t": "text",
              "req": true
            },
            {
              "n": "province",
              "l": "Province",
              "t": "select",
              "req": true,
              "o": [
                {
                  "v": "AB",
                  "l": "Alberta"
                },
                {
                  "v": "BC",
                  "l": "British Columbia"
                },
                {
                  "v": "MB",
                  "l": "Manitoba"
                },
                {
                  "v": "NB",
                  "l": "New Brunswick"
                },
                {
                  "v": "NL",
                  "l": "Newfoundland and Labrador"
                },
                {
                  "v": "NS",
                  "l": "Nova Scotia"
                },
                {
                  "v": "NT",
                  "l": "Northwest Territories"
                },
                {
                  "v": "NU",
                  "l": "Nunavut"
                },
                {
                  "v": "ON",
                  "l": "Ontario"
                },
                {
                  "v": "PE",
                  "l": "Prince Edward Island"
                },
                {
                  "v": "QC",
                  "l": "Quebec"
                },
                {
                  "v": "SK",
                  "l": "Saskatchewan"
                },
                {
                  "v": "YT",
                  "l": "Yukon"
                }
              ]
            },
            {
              "n": "postal_code",
              "l": "Postal code",
              "t": "postal",
              "ph": "A1A 1A1"
            }
          ]
        },
        {
          "id": "prop_detail",
          "title": "About the property",
          "reveal": "prop_address",
          "fields": [
            {
              "n": "home_type",
              "l": "Property type",
              "t": "select",
              "req": true,
              "o": [
                "Detached",
                "Semi-detached",
                "Row / townhouse",
                "Condo apartment",
                "Condo townhouse",
                "Duplex",
                "Triplex",
                "Fourplex",
                "Mobile / modular",
                "Farm / acreage",
                "Multi-unit (5+)"
              ]
            },
            {
              "n": "occupancy",
              "l": "How will it be used?",
              "t": "select",
              "req": true,
              "o": [
                "Owner occupied",
                "Owner occupied + rental",
                "Rental / investment",
                "Second home / vacation"
              ]
            },
            {
              "n": "sqft",
              "l": "Living area",
              "t": "sqft",
              "req": true,
              "ph": "1,800",
              "hint": "Above-grade square feet."
            },
            {
              "n": "year_built",
              "l": "Year built",
              "t": "year",
              "ph": "1998"
            },
            {
              "n": "bedrooms",
              "l": "Bedrooms",
              "t": "number",
              "min": 0,
              "max": 30
            },
            {
              "n": "bathrooms",
              "l": "Bathrooms",
              "t": "number",
              "min": 0,
              "max": 30,
              "step": 0.5
            },
            {
              "n": "construction",
              "l": "Construction",
              "t": "select",
              "o": [
                "Existing",
                "New build",
                "Under construction",
                "Self-build"
              ]
            },
            {
              "n": "heat_type",
              "l": "Heating",
              "t": "select",
              "req": true,
              "o": [
                "Forced air gas",
                "Forced air electric",
                "Forced air oil",
                "Baseboard electric",
                "Hot water / boiler",
                "Heat pump",
                "Geothermal",
                "Wood / pellet",
                "Propane",
                "None"
              ]
            },
            {
              "n": "water_type",
              "l": "Water",
              "t": "select",
              "o": [
                "Municipal",
                "Well",
                "Cistern",
                "Lake / surface"
              ]
            },
            {
              "n": "sewer_type",
              "l": "Sewage",
              "t": "select",
              "o": [
                "Municipal",
                "Septic",
                "Holding tank"
              ]
            },
            {
              "n": "lot_size",
              "l": "Lot size",
              "t": "text",
              "ph": "40 × 120 ft",
              "hint": "Frontage × depth, or acreage."
            },
            {
              "n": "garage",
              "l": "Parking",
              "t": "select",
              "o": [
                "None",
                "Surface / driveway",
                "Carport",
                "Garage — 1",
                "Garage — 2",
                "Garage — 3+",
                "Underground"
              ]
            },
            {
              "n": "property_value",
              "l": "Estimated value today",
              "t": "money",
              "req": true,
              "hint": "On a purchase this is usually the price. Say so if you believe it is worth more."
            },
            {
              "n": "annual_taxes",
              "l": "Annual property tax",
              "t": "money",
              "req": true,
              "hint": "Used in your debt ratios. An estimate is fine."
            }
          ]
        },
        {
          "id": "prop_condo",
          "title": "Condominium",
          "reveal": "prop_detail",
          "when": {
            "field": "home_type",
            "in": [
              "Condo apartment",
              "Condo townhouse"
            ]
          },
          "fields": [
            {
              "n": "condo_fee",
              "l": "Monthly condo fee",
              "t": "money",
              "req": true,
              "hint": "Half of this counts against your debt ratios, which is the national standard."
            },
            {
              "n": "condo_fee_includes_heat",
              "l": "Does the fee include heat?",
              "t": "select",
              "o": [
                "Yes",
                "No"
              ]
            },
            {
              "n": "condo_corp",
              "l": "Condo corporation",
              "t": "text"
            },
            {
              "n": "condo_locker",
              "l": "Locker included",
              "t": "select",
              "o": [
                "Yes",
                "No"
              ]
            }
          ]
        },
        {
          "id": "prop_mortgages",
          "title": "Mortgages already on this property",
          "reveal": "prop_detail",
          "when": {
            "any": [
              {
                "field": "purpose",
                "not": [
                  "Purchase"
                ]
              },
              {
                "field": "request_position",
                "in": [
                  "2",
                  "3"
                ]
              }
            ]
          },
          "note": "Add each charge separately, in position order. What sits ahead of the money you are asking for is counted in your loan-to-value; what is being replaced is not.",
          "repeat": {
            "key": "mortgages",
            "min": 1,
            "max": 3,
            "label": "Mortgage",
            "addLabel": "Add mortgage liability",
            "layout": "list"
          },
          "fields": [
            {
              "n": "position",
              "l": "Position",
              "t": "select",
              "req": true,
              "o": [
                {
                  "v": "1",
                  "l": "1st — ahead of everything else"
                },
                {
                  "v": "2",
                  "l": "2nd — behind one other charge"
                },
                {
                  "v": "3",
                  "l": "3rd — behind two others"
                }
              ]
            },
            {
              "n": "loan_type",
              "l": "Loan type",
              "t": "select",
              "req": true,
              "o": [
                "Mortgage",
                "Line of Credit"
              ],
              "d": "Mortgage"
            },
            {
              "n": "lender",
              "l": "Lender",
              "t": "text",
              "req": true
            },
            {
              "n": "balance",
              "l": "Current balance",
              "t": "money",
              "req": true,
              "hint": "What is owed today. On a line of credit, what is drawn."
            },
            {
              "n": "opening_balance",
              "l": "Opening balance",
              "t": "money",
              "hint": "The original amount — or, on a line of credit, the limit."
            },
            {
              "n": "rate",
              "l": "Interest rate",
              "t": "percent",
              "ph": "4.79"
            },
            {
              "n": "term",
              "l": "Term",
              "t": "select",
              "o": [
                "6 months",
                "1 year",
                "2 years",
                "3 years",
                "4 years",
                "5 years",
                "7 years",
                "10 years",
                "Open / revolving"
              ]
            },
            {
              "n": "maturity",
              "l": "Maturity date",
              "t": "date",
              "when": {
                "field": "loan_type",
                "in": [
                  "Mortgage",
                  null
                ]
              }
            },
            {
              "n": "payment",
              "l": "Payment",
              "t": "money",
              "req": true
            },
            {
              "n": "frequency",
              "l": "Payment frequency",
              "t": "select",
              "o": [
                "Monthly",
                "Semi-monthly",
                "Bi-weekly",
                "Accelerated bi-weekly",
                "Weekly",
                "Accelerated weekly"
              ],
              "d": "Monthly"
            },
            {
              "n": "rate_type",
              "l": "Fixed or variable",
              "t": "select",
              "o": [
                "Fixed",
                "Variable",
                "Adjustable",
                "I don't know"
              ]
            }
          ]
        },
        {
          "id": "prop_money",
          "title": "The numbers",
          "reveal": "prop_detail",
          "fields": [
            {
              "n": "purchase_price",
              "l": "Purchase price",
              "t": "money",
              "req": true,
              "when": {
                "field": "purpose",
                "in": [
                  "Purchase"
                ]
              }
            },
            {
              "n": "down_payment",
              "l": "Down payment",
              "t": "money",
              "req": true,
              "when": {
                "field": "purpose",
                "in": [
                  "Purchase"
                ]
              }
            },
            {
              "n": "down_source",
              "l": "Where is the down payment coming from?",
              "t": "select",
              "when": {
                "field": "purpose",
                "in": [
                  "Purchase"
                ]
              },
              "o": [
                "Savings",
                "TFSA",
                "RRSP / Home Buyers' Plan",
                "FHSA",
                "Gift — immediate family",
                "Sale of existing property",
                "Investments",
                "Borrowed",
                "Other"
              ]
            },
            {
              "n": "monthly_heat",
              "l": "Monthly heating cost",
              "t": "money",
              "req": true,
              "hint": "Estimate if you are unsure — $150 is typical."
            },
            {
              "n": "rental_income",
              "l": "Monthly rental income",
              "t": "money",
              "when": {
                "field": "occupancy",
                "in": [
                  "Owner occupied + rental",
                  "Rental / investment"
                ]
              }
            },
            {
              "n": "closing_date",
              "l": "Closing / funding date",
              "t": "date"
            }
          ]
        }
      ]
    },
    {
      "id": "applicants",
      "title": "Borrowers",
      "menu": "Borrowers",
      "sub": "Who's applying",
      "icon": "user",
      "blurb": "You, and anyone applying with you.",
      "tip": "Two applicants are covered here. If there is a third or fourth, add them with the button — there is no limit that hurts your file.",
      "repeat": {
        "key": "applicants",
        "min": 1,
        "max": 4,
        "softMax": 2,
        "label": "Borrower",
        "addLabel": "Add another borrower"
      },
      "groups": [
        {
          "id": "app_identity",
          "title": "Identity",
          "fields": [
            {
              "n": "first_name",
              "l": "First name",
              "t": "text",
              "req": true
            },
            {
              "n": "last_name",
              "l": "Last name",
              "t": "text",
              "req": true
            },
            {
              "n": "email",
              "l": "Email",
              "t": "email",
              "req": true
            },
            {
              "n": "phone",
              "l": "Mobile phone",
              "t": "phone",
              "req": true
            },
            {
              "n": "dob",
              "l": "Date of birth",
              "t": "date",
              "req": true
            },
            {
              "n": "marital_status",
              "l": "Marital status",
              "t": "select",
              "req": true,
              "o": [
                "Single",
                "Married",
                "Common-law",
                "Separated",
                "Divorced",
                "Widowed"
              ]
            },
            {
              "n": "dependants",
              "l": "Dependants",
              "t": "number",
              "min": 0,
              "max": 20
            },
            {
              "n": "citizenship",
              "l": "Status in Canada",
              "t": "select",
              "o": [
                "Canadian citizen",
                "Permanent resident",
                "Work permit",
                "Study permit",
                "Non-resident",
                "Other"
              ]
            },
            {
              "n": "credit_self",
              "l": "How would you describe your credit?",
              "t": "select",
              "full": true,
              "o": [
                "Excellent (760+)",
                "Good (700–759)",
                "Fair (640–699)",
                "Poor (560–639)",
                "Very poor (below 560)",
                "I don't know"
              ],
              "hint": "A guess is fine. We confirm it with a soft check, which does not affect your score."
            }
          ]
        },
        {
          "id": "app_address",
          "title": "Current address",
          "reveal": "app_identity",
          "lookup": {
            "l": "Find your address",
            "ph": "Start typing your home address…",
            "hint": "Pick it from the list and we will fill in the rest. Or enter it by hand below.",
            "fills": {
              "street_number": "addr_street_number",
              "street_name": "addr_street_name",
              "unit": "addr_unit",
              "city": "addr_city",
              "province": "addr_province",
              "postal_code": "addr_postal"
            }
          },
          "fields": [
            {
              "n": "addr_street_number",
              "l": "Street number",
              "t": "text",
              "req": true
            },
            {
              "n": "addr_street_name",
              "l": "Street name",
              "t": "text",
              "req": true
            },
            {
              "n": "addr_unit",
              "l": "Unit",
              "t": "text"
            },
            {
              "n": "addr_city",
              "l": "City",
              "t": "text",
              "req": true
            },
            {
              "n": "addr_province",
              "l": "Province",
              "t": "select",
              "req": true,
              "o": [
                {
                  "v": "AB",
                  "l": "Alberta"
                },
                {
                  "v": "BC",
                  "l": "British Columbia"
                },
                {
                  "v": "MB",
                  "l": "Manitoba"
                },
                {
                  "v": "NB",
                  "l": "New Brunswick"
                },
                {
                  "v": "NL",
                  "l": "Newfoundland and Labrador"
                },
                {
                  "v": "NS",
                  "l": "Nova Scotia"
                },
                {
                  "v": "NT",
                  "l": "Northwest Territories"
                },
                {
                  "v": "NU",
                  "l": "Nunavut"
                },
                {
                  "v": "ON",
                  "l": "Ontario"
                },
                {
                  "v": "PE",
                  "l": "Prince Edward Island"
                },
                {
                  "v": "QC",
                  "l": "Quebec"
                },
                {
                  "v": "SK",
                  "l": "Saskatchewan"
                },
                {
                  "v": "YT",
                  "l": "Yukon"
                }
              ]
            },
            {
              "n": "addr_postal",
              "l": "Postal code",
              "t": "postal",
              "ph": "A1A 1A1"
            },
            {
              "n": "residential_status",
              "l": "Do you own or rent?",
              "t": "select",
              "req": true,
              "o": [
                "Own",
                "Rent",
                "Living with family",
                "Other"
              ]
            },
            {
              "n": "monthly_rent",
              "l": "Monthly rent",
              "t": "money",
              "when": {
                "field": "residential_status",
                "in": [
                  "Rent"
                ]
              }
            },
            {
              "n": "years_at_address",
              "l": "Years at this address",
              "t": "number",
              "req": true,
              "min": 0,
              "max": 90,
              "step": 0.5,
              "hint": "Under two years and we will ask for the previous one."
            },
            {
              "n": "prev_address",
              "l": "Previous address",
              "t": "text",
              "full": true,
              "when": {
                "field": "years_at_address",
                "lt": 2
              }
            }
          ]
        },
        {
          "id": "app_employment",
          "title": "Employment and income",
          "reveal": "app_address",
          "fields": [
            {
              "n": "employment_type",
              "l": "Employment",
              "t": "select",
              "req": true,
              "o": [
                "Employed — salaried",
                "Employed — hourly",
                "Employed — commission",
                "Self-employed — incorporated",
                "Self-employed — sole proprietor",
                "Contract",
                "Retired / pension",
                "Maternity / parental leave",
                "Student",
                "Not employed"
              ]
            },
            {
              "n": "employment_basis",
              "l": "Full-time or part-time?",
              "t": "select",
              "req": true,
              "o": [
                "Full-time",
                "Part-time",
                "Seasonal",
                "Casual",
                "Self-employed"
              ],
              "when": {
                "field": "employment_type",
                "not": [
                  "Retired / pension",
                  "Student",
                  "Not employed"
                ]
              },
              "hint": "Lenders average part-time, seasonal and casual income over two or three years."
            },
            {
              "n": "employer",
              "l": "Employer",
              "t": "text",
              "req": true,
              "when": {
                "field": "employment_type",
                "not": [
                  "Retired / pension",
                  "Student",
                  "Not employed"
                ]
              }
            },
            {
              "n": "job_title",
              "l": "Job title",
              "t": "text",
              "when": {
                "field": "employment_type",
                "not": [
                  "Retired / pension",
                  "Student",
                  "Not employed"
                ]
              }
            },
            {
              "n": "years_employed",
              "l": "Years there",
              "t": "number",
              "req": true,
              "min": 0,
              "max": 70,
              "step": 0.5,
              "when": {
                "field": "employment_type",
                "not": [
                  "Retired / pension",
                  "Student",
                  "Not employed"
                ]
              },
              "hint": "Under three years and we will ask what came before it."
            },
            {
              "n": "annual_income",
              "l": "Annual income before tax",
              "t": "money",
              "req": true,
              "hint": "Base income only. Bonus, commission and rent go in the next section."
            },
            {
              "n": "income_frequency",
              "l": "How are you paid?",
              "t": "select",
              "o": [
                "Monthly",
                "Semi-monthly",
                "Bi-weekly",
                "Accelerated bi-weekly",
                "Weekly",
                "Accelerated weekly"
              ]
            }
          ]
        },
        {
          "id": "app_more_jobs",
          "title": "Other employment",
          "reveal": "app_employment",
          "when": {
            "field": "years_employed",
            "lt": 3
          },
          "blurb": "You have been in your current job under three years, so lenders will want to see what came before it — and any second job you still hold counts towards what you can borrow.",
          "repeat": {
            "key": "employments",
            "min": 1,
            "max": 6,
            "label": "Employment",
            "addLabel": "Add another employment",
            "layout": "list"
          },
          "fields": [
            {
              "n": "status",
              "l": "Active or previous?",
              "t": "select",
              "req": true,
              "o": [
                "Active",
                "Previous"
              ],
              "hint": "Active income counts towards your ratios. Previous is history."
            },
            {
              "n": "employment_type",
              "l": "Employment",
              "t": "select",
              "req": true,
              "o": [
                "Employed — salaried",
                "Employed — hourly",
                "Employed — commission",
                "Self-employed — incorporated",
                "Self-employed — sole proprietor",
                "Contract",
                "Retired / pension",
                "Maternity / parental leave",
                "Student",
                "Not employed"
              ]
            },
            {
              "n": "employment_basis",
              "l": "Full-time or part-time?",
              "t": "select",
              "req": true,
              "o": [
                "Full-time",
                "Part-time",
                "Seasonal",
                "Casual",
                "Self-employed"
              ],
              "when": {
                "field": "employment_type",
                "not": [
                  "Retired / pension",
                  "Student",
                  "Not employed"
                ]
              }
            },
            {
              "n": "employer",
              "l": "Employer",
              "t": "text",
              "req": true
            },
            {
              "n": "job_title",
              "l": "Job title",
              "t": "text"
            },
            {
              "n": "years",
              "l": "Years there",
              "t": "number",
              "req": true,
              "min": 0,
              "max": 70,
              "step": 0.5
            },
            {
              "n": "annual_income",
              "l": "Annual income before tax",
              "t": "money",
              "req": true
            },
            {
              "n": "ended",
              "l": "When did it end?",
              "t": "date",
              "when": {
                "field": "status",
                "in": [
                  "Previous"
                ]
              }
            }
          ]
        }
      ]
    },
    {
      "id": "income",
      "title": "Other income",
      "menu": "Other income",
      "icon": "coins",
      "blurb": "Anything beyond the base salary you just entered.",
      "tip": "Skip this if there is nothing to add. Bonus, commission, rent and support payments all help you qualify — but only if a lender can see them.",
      "cues": [
        {
          "id": "sources",
          "h": "{income_lender_count} lenders use these income sources to support your approval",
          "list": [
            "Relative paying rent",
            "Child support",
            "Side business income",
            "Government child benefit"
          ]
        }
      ],
      "optional": true,
      "declare": {
        "n": "none",
        "l": "I have no other income to declare"
      },
      "repeat": {
        "key": "income",
        "min": 0,
        "max": 20,
        "label": "Income",
        "addLabel": "Add income",
        "layout": "list"
      },
      "groups": [
        {
          "id": "inc_main",
          "title": "Income",
          "fields": [
            {
              "n": "applicant",
              "l": "Belongs to",
              "t": "select",
              "req": true,
              "o": [],
              "dynamic": "applicants"
            },
            {
              "n": "income_type",
              "l": "Type",
              "t": "select",
              "req": true,
              "o": [
                "Employment",
                "Self-employment",
                "Bonus",
                "Commission",
                "Overtime",
                "Rental",
                "Pension",
                "Investment",
                "Child support",
                "Spousal support",
                "Disability",
                "Employment insurance",
                "Child benefit",
                "Other"
              ]
            },
            {
              "n": "amount",
              "l": "Amount",
              "t": "money",
              "req": true
            },
            {
              "n": "frequency",
              "l": "Frequency",
              "t": "select",
              "req": true,
              "o": [
                "Annual",
                "Monthly",
                "Semi-monthly",
                "Bi-weekly",
                "Accelerated bi-weekly",
                "Weekly",
                "Accelerated weekly"
              ]
            },
            {
              "n": "source",
              "l": "Source / payer",
              "t": "text"
            },
            {
              "n": "years_receiving",
              "l": "Years receiving",
              "t": "number",
              "min": 0,
              "max": 70,
              "step": 0.5
            }
          ]
        }
      ]
    },
    {
      "id": "assets",
      "title": "Assets",
      "menu": "Assets",
      "icon": "wallet",
      "blurb": "What you own. Down payment, savings, investments, vehicles.",
      "tip": "Lenders want to see where the down payment and closing costs are coming from, and that you have something behind you afterwards.",
      "cues": [
        {
          "id": "liquid-over",
          "when": {
            "calc": "liquid",
            "gte": "liquid_threshold"
          },
          "h": "Liquid assets over {liquid_threshold}",
          "text": "Yours come to {liquid} — over the line, which can get you a better mortgage rate and a larger mortgage budget."
        },
        {
          "id": "liquid",
          "when": {
            "calc": "liquid",
            "lt": "liquid_threshold",
            "or_unknown": true
          },
          "text": "Liquid assets over {liquid_threshold} can get you a better mortgage rate and a larger mortgage budget."
        },
        {
          "id": "networth",
          "h": "Add more to this net worth",
          "text": "Yours is {net_worth} so far — what you own, less what you owe. A vehicle, investments, a business: they all count."
        }
      ],
      "declare": {
        "n": "none",
        "l": "I have no assets to declare"
      },
      "repeat": {
        "key": "assets",
        "min": 1,
        "max": 30,
        "label": "Asset",
        "addLabel": "Add asset"
      },
      "groups": [
        {
          "id": "asset_main",
          "title": "Asset",
          "fields": [
            {
              "n": "applicant",
              "l": "Belongs to",
              "t": "select",
              "req": true,
              "o": [],
              "dynamic": "applicants"
            },
            {
              "n": "asset_type",
              "l": "Type",
              "t": "select",
              "req": true,
              "o": [
                "Chequing account",
                "Savings account",
                "TFSA",
                "RRSP",
                "FHSA",
                "Non-registered investments",
                "Vehicle",
                "Real estate equity",
                "Gift — immediate family",
                "Business equity",
                "Life insurance cash value",
                "Other"
              ]
            },
            {
              "n": "value",
              "l": "Value",
              "t": "money",
              "req": true
            },
            {
              "n": "institution",
              "l": "Institution / description",
              "t": "text"
            },
            {
              "n": "for_down_payment",
              "l": "Using this for the down payment?",
              "t": "checkbox",
              "when": {
                "field": "purpose",
                "in": [
                  "Purchase"
                ]
              }
            }
          ]
        }
      ]
    },
    {
      "id": "liabilities",
      "title": "Liabilities",
      "menu": "Liabilities",
      "icon": "scale",
      "blurb": "What you owe. Cards, loans, lines of credit, support payments.",
      "tip": "Include everything — a lender pulls your bureau and sees it all anyway. A debt you disclose is a debt we can plan around.",
      "note": "Accurate liabilities help calculate your savings. See what your monthly and interest savings look like if you refinance.",
      "cues": [
        {
          "id": "consolidation",
          "when": {
            "calc": "debt_total",
            "gte": 1
          },
          "h": "What this could be worth",
          "text": "You could save {debt_saving} over {years} years and improve monthly cashflow by {debt_payments}.",
          "cite": "An estimate on the balances entered so far. Your broker confirms it."
        },
        {
          "id": "lenders",
          "text": "We have {lender_count} lender and local credit union offers available for {location}."
        },
        {
          "id": "intellirate",
          "text": "No credit check required at this time. {IntelliRate} estimates your credit score based on your overall borrower profile."
        }
      ],
      "declare": {
        "n": "none",
        "l": "I have no liabilities to declare"
      },
      "repeat": {
        "key": "liabilities",
        "min": 1,
        "max": 40,
        "label": "Liability",
        "addLabel": "Add liability",
        "layout": "table"
      },
      "compute": {
        "field": "payment",
        "from": "balance",
        "rate": 0.05,
        "unless": {
          "field": "liability_type",
          "in": [
            "Car Loan"
          ]
        },
        "note": "Estimated at 5% of the balance. Type over it if you know the real figure."
      },
      "groups": [
        {
          "id": "liab_main",
          "title": "Liability",
          "fields": [
            {
              "n": "applicant",
              "l": "Belongs to",
              "t": "select",
              "req": true,
              "o": [],
              "dynamic": "applicants"
            },
            {
              "n": "liability_type",
              "l": "Liability type",
              "t": "select",
              "req": true,
              "o": [
                "Car Loan",
                "Credit Card",
                "Student Loan",
                "Unsecured Line of Credit",
                "Personal Loan",
                "Other"
              ],
              "col": "1.15fr"
            },
            {
              "n": "lender",
              "l": "Creditor name",
              "t": "text",
              "req": true,
              "col": "1.15fr"
            },
            {
              "n": "balance",
              "l": "Balance",
              "t": "money",
              "req": true,
              "col": ".95fr"
            },
            {
              "n": "payment",
              "l": "Monthly payment",
              "t": "money",
              "req": true,
              "col": ".95fr",
              "hint": "The minimum you must pay each month."
            },
            {
              "n": "payoff",
              "l": "Paying this out with the mortgage?",
              "t": "checkbox",
              "full": true,
              "when": {
                "field": "purpose",
                "in": [
                  "Refinance",
                  "Home Equity Line"
                ]
              }
            }
          ]
        }
      ]
    },
    {
      "id": "other_properties",
      "title": "Other properties",
      "menu": "Other properties",
      "icon": "buildings",
      "blurb": "Any other real estate you own, and the mortgages on it.",
      "tip": "Every other property counts in your ratios — its taxes, heat and condo fees against you, its rent in your favour. Add them all.",
      "cues": [
        {
          "id": "portfolio",
          "text": "Institutional lenders will generally lend up to {rental_ceiling} rentals and 1 primary ownership. If you have more, speak with our broker about Exclusive Lender Rental Programs."
        },
        {
          "id": "portfolio-over",
          "when": {
            "calc": "other_count",
            "gte": "rental_ceiling"
          },
          "h": "You are at the institutional ceiling",
          "text": "With {other_count} other properties on file you are at or beyond what most institutional lenders will do. Ask our broker about Exclusive Lender Rental Programs."
        }
      ],
      "optional": true,
      "gate": {
        "n": "owns_other",
        "l": "Do you own any other property?",
        "yes": "Yes, I own more",
        "no": "No, this is my only property"
      },
      "repeat": {
        "key": "other_properties",
        "min": 0,
        "max": 20,
        "label": "Property",
        "addLabel": "Add another property"
      },
      "groups": [
        {
          "id": "op_main",
          "title": "The property",
          "lookup": {
            "l": "Find this property",
            "ph": "Start typing the address…",
            "hint": "Pick it from the list and we will fill in the rest. Or enter it by hand below.",
            "fills": {
              "street": "street",
              "city": "city",
              "province": "province",
              "postal_code": "postal_code"
            }
          },
          "fields": [
            {
              "n": "applicant",
              "l": "Belongs to",
              "t": "select",
              "req": true,
              "o": [],
              "dynamic": "applicants"
            },
            {
              "n": "street",
              "l": "Address",
              "t": "text",
              "req": true,
              "full": true
            },
            {
              "n": "city",
              "l": "City",
              "t": "text",
              "req": true
            },
            {
              "n": "province",
              "l": "Province",
              "t": "select",
              "req": true,
              "o": [
                {
                  "v": "AB",
                  "l": "Alberta"
                },
                {
                  "v": "BC",
                  "l": "British Columbia"
                },
                {
                  "v": "MB",
                  "l": "Manitoba"
                },
                {
                  "v": "NB",
                  "l": "New Brunswick"
                },
                {
                  "v": "NL",
                  "l": "Newfoundland and Labrador"
                },
                {
                  "v": "NS",
                  "l": "Nova Scotia"
                },
                {
                  "v": "NT",
                  "l": "Northwest Territories"
                },
                {
                  "v": "NU",
                  "l": "Nunavut"
                },
                {
                  "v": "ON",
                  "l": "Ontario"
                },
                {
                  "v": "PE",
                  "l": "Prince Edward Island"
                },
                {
                  "v": "QC",
                  "l": "Quebec"
                },
                {
                  "v": "SK",
                  "l": "Saskatchewan"
                },
                {
                  "v": "YT",
                  "l": "Yukon"
                }
              ]
            },
            {
              "n": "postal_code",
              "l": "Postal code",
              "t": "postal"
            },
            {
              "n": "home_type",
              "l": "Property type",
              "t": "select",
              "o": [
                "Detached",
                "Semi-detached",
                "Row / townhouse",
                "Condo apartment",
                "Condo townhouse",
                "Duplex",
                "Triplex",
                "Fourplex",
                "Mobile / modular",
                "Farm / acreage",
                "Multi-unit (5+)"
              ]
            },
            {
              "n": "occupancy",
              "l": "How is it used?",
              "t": "select",
              "req": true,
              "o": [
                "Owner occupied",
                "Owner occupied + rental",
                "Rental / investment",
                "Second home / vacation"
              ]
            },
            {
              "n": "value",
              "l": "Estimated value",
              "t": "money",
              "req": true
            },
            {
              "n": "annual_taxes",
              "l": "Annual property tax",
              "t": "money",
              "req": true
            },
            {
              "n": "monthly_heat",
              "l": "Monthly heat",
              "t": "money",
              "req": true
            },
            {
              "n": "condo_fee",
              "l": "Monthly condo fee",
              "t": "money",
              "when": {
                "field": "home_type",
                "in": [
                  "Condo apartment",
                  "Condo townhouse"
                ]
              }
            },
            {
              "n": "rental_income",
              "l": "Monthly rental income",
              "t": "money",
              "when": {
                "field": "occupancy",
                "in": [
                  "Owner occupied + rental",
                  "Rental / investment"
                ]
              }
            },
            {
              "n": "to_be_sold",
              "l": "Being sold before closing",
              "t": "checkbox"
            }
          ]
        },
        {
          "id": "op_mortgage",
          "title": "Mortgages on this property",
          "reveal": "op_main",
          "fields": [
            {
              "n": "has_mortgage",
              "l": "Is there a mortgage on it?",
              "t": "select",
              "req": true,
              "full": true,
              "o": [
                "Yes",
                "No"
              ]
            }
          ]
        },
        {
          "id": "op_mortgages",
          "title": "The charges",
          "reveal": "op_mortgage",
          "when": {
            "field": "has_mortgage",
            "in": [
              "Yes"
            ]
          },
          "repeat": {
            "key": "mortgages",
            "min": 1,
            "max": 3,
            "label": "Mortgage",
            "addLabel": "Add mortgage liability",
            "layout": "list"
          },
          "fields": [
            {
              "n": "position",
              "l": "Position",
              "t": "select",
              "req": true,
              "o": [
                {
                  "v": "1",
                  "l": "1st — ahead of everything else"
                },
                {
                  "v": "2",
                  "l": "2nd — behind one other charge"
                },
                {
                  "v": "3",
                  "l": "3rd — behind two others"
                }
              ]
            },
            {
              "n": "loan_type",
              "l": "Loan type",
              "t": "select",
              "req": true,
              "o": [
                "Mortgage",
                "Line of Credit"
              ],
              "d": "Mortgage"
            },
            {
              "n": "lender",
              "l": "Lender",
              "t": "text",
              "req": true
            },
            {
              "n": "balance",
              "l": "Current balance",
              "t": "money",
              "req": true,
              "hint": "What is owed today. On a line of credit, what is drawn."
            },
            {
              "n": "opening_balance",
              "l": "Opening balance",
              "t": "money",
              "hint": "The original amount — or, on a line of credit, the limit."
            },
            {
              "n": "rate",
              "l": "Interest rate",
              "t": "percent",
              "ph": "4.79"
            },
            {
              "n": "term",
              "l": "Term",
              "t": "select",
              "o": [
                "6 months",
                "1 year",
                "2 years",
                "3 years",
                "4 years",
                "5 years",
                "7 years",
                "10 years",
                "Open / revolving"
              ]
            },
            {
              "n": "maturity",
              "l": "Maturity date",
              "t": "date",
              "when": {
                "field": "loan_type",
                "in": [
                  "Mortgage",
                  null
                ]
              }
            },
            {
              "n": "payment",
              "l": "Payment",
              "t": "money",
              "req": true
            },
            {
              "n": "frequency",
              "l": "Payment frequency",
              "t": "select",
              "o": [
                "Monthly",
                "Semi-monthly",
                "Bi-weekly",
                "Accelerated bi-weekly",
                "Weekly",
                "Accelerated weekly"
              ],
              "d": "Monthly"
            },
            {
              "n": "rate_type",
              "l": "Fixed or variable",
              "t": "select",
              "o": [
                "Fixed",
                "Variable",
                "Adjustable",
                "I don't know"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "review",
      "title": "Review & submit",
      "menu": "Review & submit",
      "sub": "Final check",
      "icon": "check",
      "blurb": "Check it over, consent, and send it to your broker.",
      "tip": "Nothing is submitted until you press the button. You can go back to any section from the menu on the left.",
      "cues": [
        {
          "id": "ratios",
          "when": {
            "calc": "gds",
            "gte": 0
          },
          "h": "Your current ratios",
          "text": "{gds} / {tds}. GDS is what the home costs you against your income; TDS adds everything else you owe."
        },
        {
          "id": "dontworry",
          "h": "Don’t worry!",
          "text": "We manually review every file for structure and saving. One thing AI does not have is our 20 years of mortgage experience."
        },
        {
          "id": "offers",
          "h": "What this means",
          "text": "{offer_count} rate offers may apply to your personalized quote."
        },
        {
          "id": "call",
          "link": "booking",
          "text": "Schedule your 10 minute call with our lead broker, {broker_name}."
        }
      ],
      "terminal": true,
      "agreement": {
        "id": "consent",
        "title": "Client Consent, Privacy & Product Suitability Agreement",
        "intro": "This explains what we collect, what we do with it, and what you are agreeing to. Please read it before you accept below. One borrower may accept for all borrowers.",
        "sections": [
          {
            "n": "1",
            "h": "WHAT WE COLLECT",
            "bullets": [
              "Who you are: name, address, phone, email, date of birth, SIN, driver’s licence or passport.",
              "Your finances: income, employment, assets, debts, banking and investment details, and your credit report.",
              "Your file: your mortgage application and the supporting documents you give us."
            ],
            "after": "We may also confirm this information with employers, lenders, credit bureaus and other third parties."
          },
          {
            "n": "2",
            "h": "WHY WE COLLECT IT",
            "body": "To confirm who you are, check whether you qualify, recommend a suitable mortgage, arrange and service your mortgage, and meet our legal and regulatory obligations under PIPEDA and provincial mortgage rules."
          },
          {
            "n": "3",
            "h": "WHO WE SHARE IT WITH",
            "bullets": [
              "Lenders, mortgage insurers, other brokerages, financial institutions, credit bureaus and service providers working on your application.",
              "A licensed insurance brokerage, for home and auto insurance quotes — you can opt out of this at any time.",
              "Your realtor, builder or financial planner, only with your permission."
            ],
            "after": "We keep your file for at least three (3) years, as the law requires."
          },
          {
            "n": "4",
            "h": "CONSENT TO PULL YOUR CREDIT",
            "body": "You authorize Lendmax Inc. to obtain your credit report(s) now and at any time during the next six (6) months, and to verify your income, employment, debts and other financial information with third parties. You agree we may share what we collect with lenders, insurers and service providers involved in your mortgage."
          },
          {
            "n": "5",
            "h": "EMAILS AND TEXTS",
            "body": "You consent to receive electronic messages from Lendmax Inc. and its affiliated brands about mortgage news, products, services and events, in line with Canada’s Anti-Spam Legislation. You can unsubscribe at any time."
          },
          {
            "n": "6",
            "h": "WHAT YOU SHOULD KNOW BEFORE CHOOSING A MORTGAGE",
            "bullets": [
              "A variable rate can change, so your payment or amortization can change.",
              "Paying your mortgage off early, or breaking it, can trigger a prepayment charge or penalty.",
              "A change in your income, credit or debt can affect whether you still qualify before closing.",
              "Every mortgage product carries risk and should be chosen based on your own needs and circumstances."
            ]
          }
        ]
      },
      "groups": [
        {
          "id": "consent",
          "title": "Consent",
          "fields": [
            {
              "n": "consent",
              "t": "checkbox",
              "req": true,
              "full": true,
              "l": "I consent to be contacted about this application, and understand and agree to the terms of the Client Consent, Privacy & Product Suitability Agreement",
              "hint": "Contact by phone, email or text about this application. You can withdraw at any time. One borrower may accept for all borrowers."
            },
            {
              "n": "notes",
              "l": "Anything we should know?",
              "t": "textarea",
              "full": true,
              "ph": "A past bankruptcy, a job change coming up, a tight closing date — tell us now rather than later."
            }
          ]
        }
      ]
    },
    {
      "id": "documents",
      "title": "Documents",
      "menu": "Documents",
      "sub": "Proof to go with it",
      "icon": "file",
      "after_submit": true,
      "blurb": "Your application is with a broker. Attaching these now is what moves it fastest — but nothing here holds it up, and you can come back to this page whenever you like.",
      "tip": "Every document you attach is one your broker does not have to chase. Photos of paper are fine, as long as all four corners are in frame.",
      "optional": true,
      "upload": {
        "accept": [
          "application/pdf",
          "image/jpeg",
          "image/png",
          "image/heic",
          "image/webp"
        ],
        "accept_label": "PDF, JPG, PNG or HEIC",
        "max_file_mb": 25,
        "max_files": 30,
        "checklist": [
          {
            "id": "id",
            "l": "Photo ID",
            "d": "One piece, showing your photo and signature.",
            "per_borrower": true,
            "types": [
              "Driver's Licence",
              "Passport",
              "Provincial ID Card",
              "PR Card",
              "Citizenship Card"
            ]
          },
          {
            "id": "income",
            "l": "Proof of income",
            "d": "Recent pay stubs, or a letter of employment.",
            "per_borrower": true,
            "types": [
              "Pay Stub",
              "Letter of Employment",
              "Employment Contract",
              "Pension Statement",
              "Bank Statement — Income"
            ]
          },
          {
            "id": "tax",
            "l": "Tax documents",
            "d": "T4s, or the last two Notices of Assessment if self-employed.",
            "per_borrower": true,
            "types": [
              "T4",
              "Notice of Assessment",
              "T1 General",
              "T2125 — Business Income",
              "Financial Statements"
            ]
          },
          {
            "id": "bank",
            "l": "Bank statements",
            "d": "90 days for the down payment, if you are buying.",
            "when": {
              "field": "purpose",
              "in": [
                "Purchase"
              ]
            },
            "types": [
              "Bank Statement",
              "Investment Statement",
              "Gift Letter",
              "Deposit Receipt"
            ]
          },
          {
            "id": "mortgage",
            "l": "Current mortgage statement",
            "d": "Balance, rate, payment and maturity date.",
            "when": {
              "field": "purpose",
              "in": [
                "Renew",
                "Refinance",
                "Home Equity Line"
              ]
            },
            "types": [
              "Mortgage Statement",
              "Renewal Letter",
              "Property Tax Bill",
              "HELOC Statement"
            ]
          },
          {
            "id": "property",
            "l": "Property documents",
            "d": "Purchase agreement, MLS listing, or a recent tax bill.",
            "types": [
              "Purchase Agreement",
              "MLS Listing",
              "Property Tax Bill",
              "Condo Status Certificate",
              "Appraisal",
              "Insurance Binder"
            ]
          },
          {
            "id": "other",
            "l": "Anything else",
            "d": "A separation agreement, a gift letter, a lease.",
            "types": [
              "Separation Agreement",
              "Gift Letter",
              "Lease Agreement",
              "Void Cheque",
              "Other Document"
            ]
          }
        ]
      },
      "groups": [
        {
          "id": "doc_upload",
          "title": "A note for your broker",
          "fields": [
            {
              "n": "notes",
              "l": "Anything we should know about these?",
              "t": "textarea",
              "full": true,
              "ph": "The second pay stub is coming Friday — my employer only issues them fortnightly."
            }
          ]
        }
      ]
    }
  ],
  "vocab": {
    "PROVINCES": [
      {
        "v": "AB",
        "l": "Alberta"
      },
      {
        "v": "BC",
        "l": "British Columbia"
      },
      {
        "v": "MB",
        "l": "Manitoba"
      },
      {
        "v": "NB",
        "l": "New Brunswick"
      },
      {
        "v": "NL",
        "l": "Newfoundland and Labrador"
      },
      {
        "v": "NS",
        "l": "Nova Scotia"
      },
      {
        "v": "NT",
        "l": "Northwest Territories"
      },
      {
        "v": "NU",
        "l": "Nunavut"
      },
      {
        "v": "ON",
        "l": "Ontario"
      },
      {
        "v": "PE",
        "l": "Prince Edward Island"
      },
      {
        "v": "QC",
        "l": "Quebec"
      },
      {
        "v": "SK",
        "l": "Saskatchewan"
      },
      {
        "v": "YT",
        "l": "Yukon"
      }
    ],
    "FREQUENCIES": [
      "Monthly",
      "Semi-monthly",
      "Bi-weekly",
      "Accelerated bi-weekly",
      "Weekly",
      "Accelerated weekly"
    ],
    "OCCUPANCY": [
      "Owner occupied",
      "Owner occupied + rental",
      "Rental / investment",
      "Second home / vacation"
    ],
    "HOME_TYPES": [
      "Detached",
      "Semi-detached",
      "Row / townhouse",
      "Condo apartment",
      "Condo townhouse",
      "Duplex",
      "Triplex",
      "Fourplex",
      "Mobile / modular",
      "Farm / acreage",
      "Multi-unit (5+)"
    ],
    "HEAT_TYPES": [
      "Forced air gas",
      "Forced air electric",
      "Forced air oil",
      "Baseboard electric",
      "Hot water / boiler",
      "Heat pump",
      "Geothermal",
      "Wood / pellet",
      "Propane",
      "None"
    ],
    "WATER_TYPES": [
      "Municipal",
      "Well",
      "Cistern",
      "Lake / surface"
    ],
    "SEWER_TYPES": [
      "Municipal",
      "Septic",
      "Holding tank"
    ],
    "CONSTRUCTION": [
      "Existing",
      "New build",
      "Under construction",
      "Self-build"
    ],
    "EMPLOYMENT": [
      "Employed — salaried",
      "Employed — hourly",
      "Employed — commission",
      "Self-employed — incorporated",
      "Self-employed — sole proprietor",
      "Contract",
      "Retired / pension",
      "Maternity / parental leave",
      "Student",
      "Not employed"
    ],
    "INCOME_TYPES": [
      "Employment",
      "Self-employment",
      "Bonus",
      "Commission",
      "Overtime",
      "Rental",
      "Pension",
      "Investment",
      "Child support",
      "Spousal support",
      "Disability",
      "Employment insurance",
      "Child benefit",
      "Other"
    ],
    "ASSET_TYPES": [
      "Chequing account",
      "Savings account",
      "TFSA",
      "RRSP",
      "FHSA",
      "Non-registered investments",
      "Vehicle",
      "Real estate equity",
      "Gift — immediate family",
      "Business equity",
      "Life insurance cash value",
      "Other"
    ],
    "LIABILITY_TYPES": [
      "Car Loan",
      "Credit Card",
      "Student Loan",
      "Unsecured Line of Credit",
      "Personal Loan",
      "Other"
    ],
    "MARITAL": [
      "Single",
      "Married",
      "Common-law",
      "Separated",
      "Divorced",
      "Widowed"
    ],
    "CITIZENSHIP": [
      "Canadian citizen",
      "Permanent resident",
      "Work permit",
      "Study permit",
      "Non-resident",
      "Other"
    ],
    "RESIDENTIAL_STATUS": [
      "Own",
      "Rent",
      "Living with family",
      "Other"
    ],
    "CREDIT_SELF": [
      "Excellent (760+)",
      "Good (700–759)",
      "Fair (640–699)",
      "Poor (560–639)",
      "Very poor (below 560)",
      "I don't know"
    ],
    "DOWN_SOURCES": [
      "Savings",
      "TFSA",
      "RRSP / Home Buyers' Plan",
      "FHSA",
      "Gift — immediate family",
      "Sale of existing property",
      "Investments",
      "Borrowed",
      "Other"
    ],
    "MORTGAGE_TYPE": [
      "Fixed",
      "Variable",
      "Adjustable",
      "I don't know"
    ],
    "TIMING": [
      "Immediately",
      "Within 30 days",
      "1–3 months",
      "3–6 months",
      "6+ months",
      "Just researching"
    ],
    "EMPLOYMENT_BASIS": [
      "Full-time",
      "Part-time",
      "Seasonal",
      "Casual",
      "Self-employed"
    ],
    "JOB_STATUS": [
      "Active",
      "Previous"
    ],
    "LIABILITY_PAYMENT_RATE": 0.05,
    "LIABILITY_PAYMENT_EXCEPT": [
      "Car Loan"
    ]
  }
} as const;

export type PortalSchema = typeof PORTAL_SCHEMA;
