# Research: sales cadence, message content, and the calculator library

Development of the default templates and automations was held until this was
settled, on instruction. This is what the build follows. Where a claim comes
from a source it is cited; where it comes from Ali it is marked as his
instruction; where it is a judgement call it says so.

## 1. The calculator library — verified, not assumed

`rateshop.ca/calculators` redirects to `/mortgage-calculator/`, which lists
**36 calculators** in six categories. All 36 URLs were fetched and returned
HTTP 200 on 2026-09-15. The machine-readable list lives in
`src/domain/calculators.ts`, generated from that page, and the smoke test
re-checks the links so a renamed page shows up as a failure rather than as a
dead link in a client's inbox.

The categories are theirs, not mine: Payments and amortization · What you can
afford · The cost of buying · Renewing, refinancing and breaking · Using your
equity · Harder files.

### Mapping to transaction type

A calculator is only attached to a message when it is evidence for *that*
client's decision. The mapping is by transaction type, and every sequence step
names one:

| Transaction type | Primary | Secondary |
|---|---|---|
| Purchase | Maximum Purchase Price | Closing Costs, Land Transfer Tax, CMHC Insurance |
| Pre-approval | Mortgage Affordability | Mortgage Stress Test, Minimum Down Payment |
| First-time buyer | Down Payment Savings Timeline (FHSA + HBP) | Rent vs. Buy, Land Transfer Tax |
| Refinance | Mortgage Refinance | Debt Consolidation, Home Equity |
| Renewal | Refinance vs Renew | Mortgage Renewal, Rate Comparison |
| Switch / transfer | Rate Comparison | Mortgage Penalty, Break vs Stay |
| Equity take-out | Home Equity | HELOC, Debt Consolidation |
| Debt consolidation | Debt Consolidation | Total Cost of Ownership |
| Self-employed | Self-Employed Income Qualification | GDS / TDS Ratio |
| Rental / investment | Rental Property Cash Flow | Total Cost of Ownership |
| Private / B-lender | Private Mortgage True Cost | Mortgage Penalty |
| Construction / reno | Purchase Plus Improvements | Bridge Financing |

Clicks are tracked per customer and land in the file's Log, per Ali's
instruction (answer 29).

## 2. Cadence — what the evidence actually supports

The canonical source is the **MIT / InsideSales Lead Response Management
study** (Dr James Oldroyd, Sloan School): three years of data, six companies,
>15,000 leads and >100,000 call attempts. It is frequently misattributed to
Harvard Business Review; HBR wrote *about* it.

Findings the cadence is built on:

1. **Speed dominates everything else.** Qualifying odds are ~21× higher
   responding in 5 minutes than in 30. Contact odds fall ~100× over the same
   gap. This is why step 1 is immediate, not the "T + 30 minutes" in the
   original brief — 30 minutes is already most of the way down the cliff.
2. **Six attempts is the ceiling worth planning.** ~93% of leads that ever
   convert are reached within six attempts. The brief's six-step sequence
   (30 min · 24h · 48h · day 4 · day 7 · day 14) matches that almost exactly,
   so it is kept — with step 1 moved to immediate.
3. **Time of day matters.** 8–9am and 4–5pm are the strongest windows;
   8–9am outperforms 1–2pm by ~164%. Scheduled sends target those windows.
   Note the collision with Ali's quiet hours (21:00–08:30, answer 27): the
   morning window is therefore **08:30–09:00**, not 08:00.

Sources:
- MIT / InsideSales study (executive summary PDF): https://www.onecavo.com/wp-content/uploads/2015/11/MIT-InsideSales.com_Lead-Response-Management.pdf
- Lead Response Management study overview: https://www.leadresponsemanagement.org/lrm_study/
- InsideSales "how many touches" infographic: https://www.insidesales.com/lead-response-management-infographic/

## 3. What CASL permits the content to say

Every commercial electronic message must carry, clearly and prominently:

- who is sending it (business name, and anyone it is sent on behalf of);
- a **mailing address**;
- at least one of a phone number, email address or web address;
- contact details that stay valid for **at least 60 days** after sending;
- an unsubscribe mechanism that can be "readily performed", at no cost,
  **actioned within 10 business days**.

The CRM already exceeds the last one — unsubscribe is honoured on the spot,
and the signed token never expires, so the 60-day floor cannot be breached by
a link going stale. The footer carries the mailing address and the working
unsubscribe link; the renderer appends it rather than trusting an author to
remember, and `evaluateSend` refuses a commercial send that has neither
express nor unexpired implied consent.

Sources:
- CRTC, information to be included in a CEM: https://crtc.gc.ca/pubs/CASL_Infograph5_Eng.pdf
- CRTC CASL FAQ: https://crtc.gc.ca/eng/com500/faq500.htm
- ISED, getting consent to send email: https://ised-isde.canada.ca/site/canada-anti-spam-legislation/en/getting-consent-send-email
- ISED, texting for good client relations: https://ised-isde.canada.ca/site/canada-anti-spam-legislation/en/texting-good-client-relations

## 4. Voice — Ali's positioning, written as rules

Ali's instruction (answer 30): *"long term consistency and value creation in
every conversation is key"*, with two illustrations — the bank's employee will
not support your life goals, and the bank operates in its own interest first
while the brokerage is the client's layer of protection.

Rendered as rules the templates are written against, and against which they
can be checked:

1. **One reason for the message.** If there are two, it is two messages or it
   is not sent.
2. **Lead with something true about their file.** §30 of the brief forbids
   fabricating a personalised fact; the merge-field registry enforces it, and
   a line whose field cannot be resolved is dropped whole rather than sent
   with a blank in it.
3. **Contrast, never disparagement.** "A bank employee is measured on that
   bank's products" is fair and useful. "Banks are ripping you off" is not,
   and invites a complaint the brokerage has to answer.
4. **The value does not depend on the transaction closing.** Every message
   leaves something behind — a number, a calculator, a deadline they did not
   know about.
5. **One call to action**, and the same one throughout a given message.
6. **Every third message changes voice** (§46): steps 1, 2, 4, 5 come from the
   assigned broker; step 3 and step 6 come from the Underwriting Team persona,
   which is what `underwriting@lendmax.ca` genuinely is (answer 26). It never
   claims a named human reviewed something unless one did.

## 5. What this licenses the build to do

- Ship six default sequences (incomplete application, post-application
  documents, appointment, no-show, renewal, lost reactivation) with the step
  timings above.
- Attach a calculator to each step by transaction type, from the verified list.
- Send only inside 08:30–21:00 in the recipient's timezone, with the morning
  window preferred for scheduled sends.
- Keep every default editable by Admin, since none of this is load-bearing on
  a regulation — it is a starting cadence, not a rule.
