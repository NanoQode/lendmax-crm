# What has been built

A running inventory, kept current as things ship. It exists so that the next
session — or the next person — does not have to re-derive the system from the
code. Where something is deliberately incomplete it says so here rather than
looking finished.

Last updated: 2026-09-16.

## Domain (pure, unit-tested, no database)

| Module | What it decides |
|---|---|
| `domain/permissions.ts` | 5 roles, 69 permissions grouped into 18 modules (`MODULES` drives the staff checkboxes and API key scopes), per-user overrides stored as the difference from the role. Broker sees only assigned files; Underwriter sees all; archive/delete is Underwriter, Admin, Compliance only |
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
| `domain/pipelines.ts` | What makes a pipeline usable (an active In-progress, Won and Lost stage), key generation, the entry stage, and the suggested destination when a stage goes away |
| `domain/required-documents.ts` | The four portal purposes, the document formats (held to the uploader's accepted types by a test), `fileMatchesFormats`, and the suggested starting lists |
| `domain/uploads.ts` | Which uploads are accepted: MIME and extension must agree, 25 MB cap |
| `domain/appointments.ts` | Appointment types, modes and statuses; wall-clock time in a zone to an instant (a skipped hour is refused); when the attended/missed popup asks; whether booking or an outcome moves the file; the four default client emails |
| `domain/activity.ts` | Activity logs: 30-day retention, which actions count (staff and websites, not the engine or clients), the module each action belongs to, and its on-screen label |
| `domain/application-form.ts` | The application form: the portal's own questions (vendored, not re-typed), when each applies, what it accepts — ported from the portal's `validate.js` — and whose answer wins when the brokerage has corrected one |
| `domain/application-columns.ts` | The answers as the columns the board sorts on and the reports group by. Derived, never authored |
| `domain/tasks.ts` | Tasks: a date is not an instant (an all-day task is not overdue at breakfast), the instant a wall-clock due time means, when to remind and when a late reminder is dropped instead, which heading a task sits under in the reader's own day, and whose task it is — the rule the read-only "Assigned to" field shows |
| `domain/chats.ts` | LM Chats: who may open a one-to-one chat (an admin is always on one side), who may post (the Community group is closed until an admin opens it), what cannot be left or deleted, the 20 MB attachment rule, the 19-minute edit-and-delete window measured from sending, read state derived from the same `last_read_at` the unread badge uses, muting, typing, search snippets, and the 4 MB picture rule |
| `domain/signature.ts` | Email signatures from lines of text: profile fields, `**bold**`, auto-linked URLs, tap-to-call phones; everything typed is escaped; a line with an empty field is dropped |

Compliance checklist `standard_on` is at **v2**, which adds the funded package
from answer 18 (amortization schedule, fee direction, cost of borrowing
disclosure). v1 is kept: a case records the version it was completed against,
so files in flight do not retroactively grow requirements.

## Services

`auth` · `audit` (hash-chained, append-only, every break found) · `assignment`
(fixed / round-robin by least-recently-assigned among staff switched on / team)
· `staff` (invite → activate → active/inactive → archived; deactivation hands
open leads and tasks to one named person) · `leads` (manual and API leads,
assigned like portal ones) · `api-keys` (per-website, hashed, scoped) ·
`signature` (standard or custom per person, rebuilt when the profile changes,
appended to composer emails, `{signature}` in templates and automations) ·
`required-documents` (per-purpose checklist; archive not delete; ordered;
server-side filter/sort/page; `checklistFor` for the application step) ·
`pipelines` (several pipelines, purpose routing, usage, move-and-delete,
archive) · `appointments` (book for yourself or, with manage_all, for any staff member's
clients; double-booking and Google busy checks; per-pipeline booked/attended/
missed stages; confirmation, new-time, cancellation and 15-minute reminder
emails; the popup; two-way Google sync) · `google-calendar` (per-person OAuth,
encrypted tokens, push events with Meet links, busy times, changes since)
· `applications` (the client's answers, corrected: a scalar pinned by itself
and a list pinned as a list, laid over `portal_data` on read and re-applied
after every mirror push, with the client's own answer kept beside each
correction and offered back) · `tasks` (own work and, with `manage_all`, work made for
somebody else: a task on a client's file belongs to whoever that client is
assigned to; server-side filters, tabs and paging; the file's `next_task_at`
kept in step; a reminder 15 minutes before by bell, live event and email)
· `chats` (LM Chats: staff-to-admin one-to-one, admin-made groups, the
permanent Community group everybody is in; attachments to 20 MB in the same
storage as documents; edit and delete for 19 minutes; read receipts; typing;
search inside a conversation with jump-to; group and personal pictures; unread
counts, muting and the deduped bell) · `realtime` (one Server-Sent Events
stream per tab, in-process, heartbeated every 25s; a message event is shaped
per recipient, because `mine`, the ticks and the edit window depend on who is
looking)
· `activity` (30-day activity logs mirrored from the audit trail, file views
once per half hour, own vs everyone's, daily purge; no delete anywhere)
· `stage-moves` (the one path for any stage change, including
between pipelines) · `portal-import` (the apply.lendmax.ca mirror
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
- **Google Calendar** — each person connects their own (OAuth, offline). Events with Meet links and the
  client invited, busy-time checks, moves and deletions synced back every 5 minutes. A sandbox driver
  stands in for Google outside production.

## Screens

Dashboard · Customers (list with Export CSV and Show archived, and a board whose cards drag between stages —
every move asks for a note, which is kept on the transition and as a note on
the file) · Client workspace (11 tabs: Summary, the editable Application form,
Tasks, Notes, Appointments, Documents, Compliance, Funding, Automations, Log;
header actions Send to Scarlett (a pre-send check of blockers, unmapped codes, sandbox and an existing deal, then confirm; re-send overwrites only when ticked; one send at a time per file), Edit contact, Merge duplicate, Archive/Restore, and a notice when
another record looks like the same person). Request documents — tick entries
from the Required Documents checklist for the file's purpose (per-borrower
entries become one item per borrower, formats enforced on the upload link) —
sits under the Application form and on the Documents tab
· Pipeline ·
Tasks (tabs, filters, the create form with its read-only assignee) ·
Documents · Messages · LM Automation (GoHighLevel-style workflow builder: several triggers per workflow, If / Else with many branches, conditions on any application answer or worked-out figure such as total income, actions for email/SMS/internal email/notification, tags, contact fields, notes, stage moves through the stage machine, assign by user or round robin, tasks, document requests, waits by time or until a date, go to, add to/remove from workflows, outgoing webhook; right-hand drawer, Draft/Publish switch, test run on a real client, Settings with entry and goal conditions, Enrollment History, Execution Logs) · Compliance · Campaigns · Reports ·
Calendar · Renewals · Settings · Integrations · Profile · Staff · API access ·
Activate (the invitation link) · Required documents · Manage pipelines
(list and per-pipeline stages) · Activity logs · Appointments (list with tabs, week view, booking,
detail, Google connect) plus the attended/missed popup on every screen and an Appointments tab on
each client file, and LM Chats (conversation list, thread, attachments, edit
and delete in place, read ticks, typing, in-conversation search that jumps to
the hit, group management and pictures) with its unread badge on the sidebar
and in the tab title. A person's picture is set on their profile and shows
wherever they appear. The board switches between pipelines.

Every table uses `DataTable` (search, a filter per column, click-to-sort,
pagination); customers, required documents, activity logs and appointments page on the server.

All dropdowns use `SearchSelect` (type to filter) in the screens built or
touched since the staff module; older screens still have a few plain selects.

## API

`/api/v1` — leads, customers (look up, read, correct contact details), LM Automation (list, inbound webhook, add a client), staff, round robin, signatures, required documents,
pipelines, appointments, tasks, activity logs. Documented in `docs/API.md`.

LM Chats has **no** `/api/v1` surface, on purpose: a connected website has no
business reading what staff say to each other, so `chat.use` and `chat.admin`
are registered in `MODULES` without `api: true` and no key can hold them.

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
- No-show popup 10 minutes after an appointment (answer 9). What ships instead
  asks while the meeting runs and again when it ends, then waits under
  Appointments → Needs outcome for 12 hours.
- The application form has no cross-field validation beyond the portal's own —
  a down payment larger than the purchase price is accepted here exactly as it
  is up there.
- A corrected field shows the client's original answer in the `edits` payload
  but the screen only offers "undo"; it does not show the two side by side.
- The board's drag needs a mouse: HTML5 drag-and-drop does not fire on touch.
  On a phone a card is tapped to open the file, and the stage changed there.
- Tasks: one owner each, not several — the table has carried a `task_assignees`
  join since 0003 and the module uses the first row of it. Sub-tasks
  (`parent_task_id`) and recurring tasks are not built either.
- Tasks: no snooze, and no drag-to-reschedule. Moving one is the edit form.
- LM Chats: no replies or quoting, no forwarding, no reactions, no pinned
  messages, and no per-message list of exactly who has read it in a group —
  the count and "read by 3 of 8", not the names.
- LM Chats: a delete is for everyone and only within 19 minutes; there is no
  "delete for me", and an admin cannot delete somebody else's message. Edits
  are not versioned — it is a typo window, not an audit surface.
- LM Chats attachments and pictures are not virus-scanned, like every other
  upload here.
- LM Chats' event stream lives in one process's memory. Correct for this
  deployment — one service, per `deploy/lendmax-brokerage-crm.service` — and
  the fix if that changes is Postgres LISTEN/NOTIFY behind
  `services/realtime.ts`'s `publish()`, which every caller already goes
  through.
- Per-user timezone in the first-login signature flow (answer 35).
- AI suitability draft.
