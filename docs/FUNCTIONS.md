# What has been built

A running inventory, kept current as things ship. It exists so that the next
session — or the next person — does not have to re-derive the system from the
code. Where something is deliberately incomplete it says so here rather than
looking finished.

Last updated: 2026-09-15.

## Domain (pure, unit-tested, no database)

| Module | What it decides |
|---|---|
| `domain/permissions.ts` | 5 roles, ~50 permissions, per-user overrides. Broker sees only assigned files; Underwriter sees all; archive/delete is Underwriter, Admin, Compliance only |
| `domain/pipeline.ts` | Stage entry rules, blockers named individually, one-way past Scarlett, forced moves recorded not silent |
| `domain/automation.ts` | Definition schema, cycle and unreachable-node detection, condition evaluation |
| `domain/merge-fields.ts` | Closed registry. An unresolved field drops its whole line rather than sending a blank |
| `domain/risk.ts` | FINTRAC factors as a closed evaluator set. Unanswered is never low risk — it is `review_required`. Ships inert per answer 17 |
| `domain/money.ts` | Cents throughout. Fixed fees off the top, percentages on the remainder, rounding remainder to the largest share |
| `domain/segment.ts` | Campaign audiences as structure, never SQL |
| `domain/blocks.ts` | Typed message blocks; the renderer appends the CASL footer rather than trusting an author |
| `domain/dates.ts` | Calendar dates vs instants, business days, month-end-clamped maturity, quiet hours to the minute (21:00–08:30) |
| `domain/calculators.ts` | The 36 RateShop calculators, verified live, mapped to all 13 transaction types |
| `domain/default-automations.ts` | Six shipped sequences, seeded paused |

Compliance checklist `standard_on` is at **v2**, which adds the funded package
from answer 18 (amortization schedule, fee direction, cost of borrowing
disclosure). v1 is kept: a case records the version it was completed against,
so files in flight do not retroactively grow requirements.

## Services

`auth` · `audit` (hash-chained, append-only, every break found) · `assignment`
(fixed / round-robin / team) · `portal-import` (the apply.lendmax.ca mirror
contract) · `automation-engine` (claim-before-run, sweep for stranded
enrolments) · `compliance` (evidence-derived checklist, supersede never
overwrite) · `campaigns` (one audience query, then the consent gate per
recipient) · `messaging` · `consent` (`evaluateSend` — the single gate every
outbound path goes through) · `unsubscribe` (signed, unexpiring) ·
`link-tracking` (signed calculator redirects, destination from our own list) ·
`storage` · `integrations` (AES-256-GCM, database over environment).

## Integrations

- **apply.lendmax.ca** — inbound mirror, idempotent, verified against live data.
- **Scarlett** — `UniversalDealModel` deal push. Enums omitted rather than
  guessed when the code tables have not been pulled.
- **VoIP.ms** — two-way SMS/MMS, STOP honoured.
- **Email** — Resend / SMTP / console.
- **Google Calendar** — not built. OAuth outstanding.

## Screens

Dashboard · Customers · Client workspace (7 tabs) · Pipeline · Tasks ·
Documents · Messages · Automations · Compliance · Campaigns · Reports ·
Calendar · Renewals · Settings · Integrations · Profile.

## Deliberately not done

- Google Calendar OAuth and per-user sync (answers 31, 33).
- S3 storage and virus scanning — local disk today.
- The retention runner. Nothing deletes on a guessed legal rule.
- Commission `trailer`, fee direction, disclosure flags and the broker split %
  set at user creation (answer 13) — the schema carries bps, gross, source and
  splits, but not those four.
- Approve/decline-with-reason on the compliance file, notifying the compliance
  manager, and the commission-payout review that goes with it (answer 19). The
  payout *gate* is built — commission cannot move to a paid state while a
  required item is outstanding, and the refusal names every one — but the
  notification and the adjust-the-payout step are not.
- No-show popup 10 minutes after an appointment (answer 9).
- Per-user timezone in the first-login signature flow (answer 35).
- AI suitability draft.
