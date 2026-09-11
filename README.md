# Lendmax CRM

A Canadian mortgage brokerage CRM for `lendmax.ca/crm`.

Node 22 · TypeScript · Express 5 · PostgreSQL 16 · Preact

---

## What this is, and what it is honest about

The pipeline this is built around:

```
Lead → Application → Appointment → Underwriting → Scarlett → Conditions
     → Compliance → Funded → Commission → Renewal
```

**Built and working today:** the database (nine migrations, every table in that
pipeline), the domain rules with tests, authentication and RBAC, a
hash-chained audit log, the HTTP API for customers, pipeline, tasks, notes,
timeline and settings, and an interface covering sign-in, dashboard, customer
list, board and the client workspace.

**Not built:** the portal importer, the Scarlett and VoIP.ms adapters, the
automation runtime, campaigns, and the compliance screens. Their schema, their
rules and in several cases their API are in place; the connecting code is not.
Section 8 lists exactly what remains.

Where a module is not built, the interface says so. It does not show a mocked
board, a static chart or a button that does nothing — a panel that looks
finished and stores nothing is how a product gets signed off and then does not
work.

---

## 1. Why this architecture

The estate was inspected before anything was written. What is already running:

| | |
|---|---|
| `apply.lendmax.ca` | Node 20, Express 4, SQLite. The nine-section application portal. **Owns the application.** 124 fields, generated from its own `lib/schema.js`. |
| `lendmax.ca` | Node 20, Express 4, SQLite. Marketing site, admin, and the mirror endpoint that already receives applications from the portal. |
| `app.lendmaxcapital.ca` | A separate MIC lending platform. Different product; not touched. |

**The portal is not replaced or duplicated.** It owns the application and keeps
owning it. This CRM mirrors it and owns what the brokerage does about it. See
[`docs/field-map.md`](docs/field-map.md) for the full 124-field mapping and the
record relationship.

**PostgreSQL rather than extending the existing SQLite admin.** The brokerage
CRM needs concurrent writers (a broker, an underwriter and the automation
worker on one file), a durable job queue, partial and expression indexes for
the visibility and dedupe rules, and aggregate reporting across the book.
SQLite's single-writer lock is a real constraint on the first, and the
remaining three would be fought rather than used. PostgreSQL 16 is already
running on the box.

**TypeScript, strict, with `erasableSyntaxOnly`.** The server runs under Node's
type stripping — no build step for the backend, no source maps to line up when
something fails at 2am. `erasableSyntaxOnly` makes `tsc` reject any construct
that would need code generated, so that class of failure is caught at
typecheck rather than at boot. (It was not, once: a constructor parameter
property stopped the server from starting.)

**Preact and esbuild, no framework.** 71 KB of JavaScript, one build
dependency, no component library and no CSS-in-JS. This has to be maintainable
by whoever inherits it without first learning a toolchain.

### Deliberate omissions

- **No Redis.** The job queue is Postgres (`SKIP LOCKED`, dedupe key, retry
  with backoff, dead-letter). It holds scheduled client messages; a queue that
  can lose its contents on restart is a queue that silently stops following up
  on mortgage files.
- **No ORM.** SQL is written out. The queries that matter here — the visibility
  clause, the board's window function, the dashboard's single fact-gathering
  query — are the ones an ORM makes hard to read and easy to make slow.
- **No SIN, anywhere.** The portal does not collect one and this does not store
  one. Identity records keep the last four of a document number and nothing
  more.

---

## 2. Running it

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and SESSION_SECRET
npm run migrate
npm run seed -- --admin you@lendmax.ca   # prints a password once
npm run build:web
npm start                     # http://localhost:3400/crm
```

Add `--demo` to the seed for six realistic files.

```bash
npm run dev              # server, watching
npm run build:web -- --watch
npm run typecheck
npm test                 # unit, no database
npm run test:db          # against .env.test
npm run verify           # all three
```

`npm run migrate` is never run implicitly at boot. The server *checks* the
schema is current and refuses to start if it is not — a bad migration should
not take the service down at the worst possible moment.

---

## 3. Roles

Five roles, defined as a permission matrix in `src/domain/permissions.ts` with
per-user overrides on top. Every route asserts its own permission; the UI hides
what you cannot do as a courtesy, and a hidden button is not a permission.

| Role | Holds | Deliberately does not hold |
|---|---|---|
| **Technical Admin** | Users, integrations, settings, automations, audit, diagnostics | `document.download`, `pii.view_sensitive`, `pii.view_financials`, `compliance.review` |
| **Broker** | Their own files, appointments, sending, document requests | `customer.view_all`, `message.send_bulk`, `automation.edit` |
| **Underwriter** | All files, documents, conditions, lender submission, Scarlett push, funding | `compliance.review`, `campaign.*` |
| **Manager** | Team visibility, assignment, configuration, campaigns, commission | `compliance.review`, `compliance.fintrac` |
| **Compliance Manager** | Compliance review, FINTRAC, suitability, legal hold, audit, export | `pipeline.move`, `message.send` |

The technical admin's exclusions are the point. Least privilege has to apply to
the account with the most access or it is not a principle. Where a genuine
support need exists, an override grants exactly one capability and the grant is
auditable.

---

## 4. The parts worth knowing about

### Days to close, and every date

`src/domain/dates.ts` keeps two kinds of time apart. A **calendar date** — a
closing date, a maturity date — is a `'YYYY-MM-DD'` string with no timezone,
because that is what a contract names. An **instant** is a `Date` in UTC.
Collapsing the first into the second moves a closing date overnight for anybody
west of the server, and "days to close" drives task priority, the board, the
dashboard and three stale-file alerts.

Urgency is returned as a **word** as well as a state. Roughly one man in twelve
has a colour-vision deficiency; "the red ones are urgent" excludes him from the
screen that matters most.

### The send gate

Every outbound email and SMS — manual, automated, campaign — passes through
`evaluateSend` in `src/domain/consent.ts`. There is no second path, because a
consent rule that lives in the campaign screen and not in the automation engine
is a rule the automation engine will break.

It records its reason whether it allows or refuses, and the decision is stored
on the message. Six months later, "why did this client not get the renewal
letter" has an answer that does not require re-deriving anything.

Structure is in code: a transactional message about the client's own mortgage
is not a commercial electronic message and a marketing unsubscribe does not
stop it; a hard bounce stops everything; express consent does not expire and
implied consent does. The *numbers* — how long an implied basis lasts, whether
marketing SMS requires express consent — are configuration with effective dates
(`settings.consent_rules`), to be verified against current CRTC guidance by a
person.

### The stage machine

`src/domain/pipeline.ts` is pure: a file and a target stage in, a decision plus
the side effects out. Refusals name every missing thing, not the first:

> Cannot move to Funded: Funding has not been confirmed; The amount that
> actually advanced is not recorded; No lender is recorded.

A stage change stops the automations that were about the old stage **inside the
same transaction** as the move. A file that is funded with its nurture sequence
still running is the failure that prevents.

Overriding an entry rule is allowed — a rule that cannot be overridden by
somebody with the authority is a rule people route around by lying to the board
— but it needs `pipeline.configure`, and the override is recorded and reported.

### The audit log

Append-only and hash-chained. The database refuses `UPDATE` and `DELETE`
outright; the chain catches anything that went around the database, and
`verifyChain` names the exact row where it breaks.

This is not a claim the log is un-forgeable by somebody with full database
access — it is not, and pretending otherwise would be worse than useless. It is
a claim that tampering cannot be *silent*, which is the property a compliance
review needs.

Payload digests use a canonical JSON form on both sides. Without that, `jsonb`
reorders object keys and the chain reports tampering on entries it wrote
itself. That was a real bug, found by running the verifier; `test/audit.test.ts`
now guards it.

### Next action

`src/domain/next-action.ts` is deterministic rules, in order, each producing a
suggestion that carries its own evidence:

> **Resolve lender conditions** — Closes in 4 days; 2 lender conditions
> outstanding.

Not a score. A broker who cannot see why a file is at the top of their list
stops believing the list. An LLM may later rewrite the *wording* of a reason; it
must not decide the order.

### Compliance

Structure, evidence and a review queue — not a compliance oracle. Every
threshold, weight, checklist item and retention period is configuration with an
effective date and a source note. The risk model stores the factors that
produced each score, so the screen renders the explanation from the same data
that produced the number.

Two things are structural rather than configurable:

- **A person makes the determination.** Every assessment has a `decided_by`, and
  the system's suggestion sits beside it, never instead of it.
- **Unusual-activity handling is routed, never announced.** Nothing in the
  client-facing surface reads from these tables. Tipping off is the one mistake
  a CRM can make here that cannot be corrected afterwards.

The seeded retention policies are all `action: 'review'`, never `delete`, and
each carries a source note saying the period is a placeholder until somebody
accountable has verified it. `settings.mortgage_rules` ships **unset** rather
than with a guessed stress-test rate.

---

## 5. Layout

```
migrations/          0001–0009, checksummed, one transaction each
src/
  config/env.ts      validated at boot; refuses to start rather than start wrong
  db/                pool (NUMERIC and DATE parsers), migration runner
  domain/            pure rules — permissions, dates, consent, pipeline, next-action
  lib/               logger (with redaction), phone (E.164), canonical JSON
  services/          auth (scrypt, revocable sessions), audit (hash chain)
  http/              app, middleware, routes
web/src/             Preact client — components, pages, tokens
docs/field-map.md    the 124-field portal mapping
test/                90 unit + 4 database-backed
```

---

## 6. Security

- scrypt password hashing (`node:crypto` — no native binding to break on a Node
  upgrade, and memory-hard, which bcrypt at a default cost is not), 12-character
  minimum.
- Sessions are rows holding the **SHA-256** of the cookie. A database disclosure
  hands over no live session, and a session can be revoked — which a
  self-contained signed token cannot be. Idle expiry slides; the absolute
  expiry does not. A deactivated account's live sessions die on the next
  request.
- Per-account lockout as well as per-IP rate limiting. An attacker with many IPs
  walks straight through an IP limit; the per-account lockout is what protects
  the one account they are after. Failed sign-ins are audited — a burst against
  one account is the signal, and it is invisible if only successes are recorded.
- CSP with **no `unsafe-inline` for scripts**. The one inline script (the theme
  bootstrap) is allowed by its SHA-256, emitted by the build. `unsafe-inline`
  would permit every injected script as well as ours.
- Parameterised SQL throughout; segment filters are structured data, never
  assembled SQL.
- Errors return a sentence the user can act on plus a correlation id. Never a
  stack trace, a SQL fragment or a constraint name in production — those are a
  map of the schema handed to whoever asked.
- The logger redacts a deny-list at every depth: passwords, tokens, DOB, income,
  balances, credit scores.
- Documents have no permanent URL. Access is short-lived and every grant is
  recorded in `document_access_log`, because "who looked at this client's bank
  statements" has to have an answer.

**Data residency:** PostgreSQL and object storage should both be in a Canadian
region. `S3_REGION` defaults to `ca-central-1`. No specific residency
*requirement* is asserted here — that is a determination for Lendmax's counsel,
and the architecture supports it either way.

---

## 7. Deployment

Runs behind the existing nginx on the same box, mounted under `BASE_PATH`. It
serves that prefix only and explicitly refuses anything outside it — the rest of
`lendmax.ca` belongs to the existing site and this process must not claim it.

```nginx
location /crm/ {
  proxy_pass http://127.0.0.1:3400;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 30M;
}
```

`app.set('trust proxy', 1)` is already set; without it every rate limit and
every audited IP would be the proxy's.

A systemd unit with `EnvironmentFile=/etc/lendmax/crm.env`, `Restart=always`,
`ProtectSystem=strict` and `ReadWritePaths` for the storage directory. Shutdown
drains: the listener closes, in-flight requests finish, then the pool closes —
a hard exit mid-request leaves a half-written stage change.

**Backups:** `pg_dump` nightly plus WAL archiving; object storage versioned.
Restore has to be *rehearsed*, not documented — an untested restore is a hope.

---

## 8. What remains

In dependency order. Each line is real work, not a stub to fill in.

1. **Portal importer** — the webhook, the upsert, the customer resolver, the
   backfill of the 17 applications already mirrored into
   `/var/lib/lendmax/lendmax.db`. Steps are spelled out in
   `docs/field-map.md` §5. *Nothing downstream is real until this runs.*
2. **Job worker** — the `jobs` table and its claim/retry/dead-letter shape
   exist; the runner loop and the handler registry do not.
3. **Email and SMS adapters** — behind the send gate, which is finished. VoIP.ms
   needs inbound webhook verification, media fetching, E.164 matching (done) and
   the ambiguous-number flag: if an inbound number matches two contacts, flag it
   rather than attach it to the wrong client.
4. **Documents** — request flow, the client upload link (tokens are hashed in
   the schema already), signed download, virus scanning.
5. **Automation runtime** — versioning, enrollment and stop conditions are
   modelled; the step executor, the scheduler and the builder are not.
6. **Scarlett adapter** — a mapping configuration rather than mappings spread
   through the code, `POST` with validation before push, duplicate prevention,
   and errors that say *"the deal was missing a valid subject-property
   province"* rather than *500*.
7. **Compliance screens** — checklist, FINTRAC, risk, suitability, package
   export.
8. **Funding, commission, renewals** — schema complete; screens and the
   milestone job are not.
9. **Campaigns** — block builder, segment evaluator, throttled sender.
10. **Analytics** — conversion by stage, time-in-stage, lender mix, broker
    performance. `stage_transitions` already records what these need.
11. **Google Calendar** — OAuth, token storage, idempotent event sync.

### Credentials needed before 3, 6 and 11 can be finished

`VOIPMS_API_USER`, `VOIPMS_API_PASSWORD`, `VOIPMS_DEFAULT_DID`,
`VOIPMS_WEBHOOK_SECRET`; `SCARLETT_BASE_URL`, `SCARLETT_API_KEY`,
`SCARLETT_PARTNER_ID`; `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`;
`PORTAL_INTERNAL_API_KEY`, `PORTAL_WEBHOOK_SECRET`; an email provider key.

Every one is already defined in `.env.example` and surfaced on the Integrations
screen, which names the exact variables missing for each integration. Nothing
is blocked on a credential *today* — the code is built around them.

### Before any regulatory rule is encoded

The retention periods, the implied-consent window and `mortgage_rules` are all
flagged placeholders. They must be verified against FINTRAC, FSRA, CRTC and the
OPC — with the date checked — and entered as configuration with an effective
date. **Do not promote a placeholder to a constant.**
