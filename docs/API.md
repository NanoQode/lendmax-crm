# Lendmax CRM API — v1

For developers connecting another website or service to the CRM: a website
contact form sending in leads, a partner portal, an HR system onboarding
agents.

Base URL: `https://lendmax.ca/crm/api/v1` (locally `http://localhost:3400/crm/api/v1`).

---

## Getting a key

An admin creates keys in the CRM under **API access** (permission
`api_key.manage`). Each key:

- belongs to one website or service, so one can be revoked without breaking the others;
- holds only the permissions ticked for it (see [Permissions](#permissions));
- is shown **once**, when it is created. The CRM stores only a fingerprint, so a
  lost key is replaced, not recovered.

Send it on every request:

```
Authorization: Bearer lmx_…
```

(`X-API-Key: lmx_…` also works.)

**Call the API from your server, never from JavaScript in a visitor's
browser.** A key in a web page is a key published to everybody who opens it.
The API sends no CORS headers, so browsers refuse cross-site calls by design.

---

## Conventions

**Responses.** Success is `{ "ok": true, "data": … }`. Failure is:

```json
{
  "ok": false,
  "code": "validation_failed",
  "error": "2 fields need attention.",
  "fields": [
    { "field": "email", "message": "Enter a valid email address." },
    { "field": "mobile_phone", "message": "Enter a valid Canadian mobile number, e.g. (416) 555-0142." }
  ],
  "correlationId": "8ab88abb-…"
}
```

`error` and each `fields[].message` are sentences written to be shown to a
person. Quote `correlationId` when reporting a problem.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | The request is malformed. |
| 401 | `unauthenticated` | No key, a wrong key, or a revoked key. |
| 403 | `forbidden` | The key lacks the permission named in `permission`, or the action is never allowed through the API. |
| 404 | `not_found` | No such record, or no such endpoint. |
| 409 | `conflict`, `last_admin`, `already_inactive`, … | The request is valid but the record's state does not allow it. |
| 422 | `validation_failed` | One or more fields are wrong; see `fields`. |
| 429 | `rate_limited` | More than 300 requests a minute from this key. |
| 500 | `internal_error` | Our fault. Nothing was changed; retrying is safe. |

**Rate limit.** 300 requests per minute per key. `RateLimit-*` headers report
what is left.

**Versioning.** Breaking changes go to `/api/v2`; v1 keeps working until
nothing calls it. New fields may be added to responses at any time — ignore
what you do not recognise.

**Phone numbers** are accepted in any common Canadian format and returned in
E.164 (`+14165550142`). **Money** is a plain number of dollars.

---

## Permissions

A key can hold these. Everything else in the CRM is managed from inside it.

| Permission | Allows |
|---|---|
| `customer.create` | `POST /leads` |
| `customer.view` | `GET /leads/{id}`, `GET /customers`, `GET /customers/{id}` |
| `customer.edit` | `PATCH /customers/{id}` |
| `automation.view` | `GET /automations` |
| `automation.control` | `POST /automations/{id}/webhook`, `POST /automations/{id}/enrol` |
| `pipeline.view` | Reading pipelines, their stages and what uses them |
| `pipeline.move` | `POST /leads/{id}/stage` |
| `pipeline.assign` | `POST /leads/{id}/assign`, and naming an owner in `POST /leads` |
| `pipeline.configure` | Creating, editing, activating and deleting pipelines and stages |
| `user.view` | Reading staff, their email signatures, and the round-robin settings |
| `user.manage` | Adding, editing, deactivating and deleting staff; setting their signatures; turning round robin on and off |
| `required_document.view` | Reading the required-documents list and a purpose's checklist |
| `required_document.manage` | Adding, editing, reordering and deleting required documents |
| `activity.view_all` | Reading the activity logs: what every staff member did in the last 30 days |
| `appointment.view_all` | Reading appointments |
| `appointment.manage_all` | Booking, moving, cancelling and recording the outcome of appointments, for any staff member |

| `task.view_all` | Reading tasks |
| `task.manage_all` | Creating, moving and completing tasks for any staff member |

LM Chats (`chat.use`, `chat.admin`) is deliberately absent from this table.
Internal staff conversations have no endpoint under `/api/v1`, so there is no
scope to grant — a scope with nothing behind it would be a promise.


**Limits that apply even with `user.manage`.** An API key can never create,
edit, deactivate or delete a **technical admin**, and never grant
administrative permissions (`user.manage`, `user.impersonate`, `system.admin`,
`api_key.manage`, `integration.manage`, `settings.manage`). Otherwise a leaked
key could create an admin account for its holder. Those changes are made
inside the CRM.

`GET /permissions` lists every module and permission, including the ones a
key cannot hold, for building your own staff screen.

---

## Leads

### `POST /leads` — send in a lead

Needs `customer.create`. Creates the customer and their file at the first
pipeline stage. The owner is chosen by **round robin**, unless you name one.

```bash
curl -X POST https://lendmax.ca/crm/api/v1/leads \
  -H "Authorization: Bearer lmx_…" -H "Content-Type: application/json" \
  -d '{
    "first_name": "Jane", "last_name": "Doe",
    "email": "jane@example.com", "phone": "416-555-0142",
    "amount_requested": 450000,
    "transaction_type_key": "refinance",
    "lead_source": "lendmax.ca contact form",
    "message": "Looking to refinance in the spring."
  }'
```

| Field | Required | Notes |
|---|---|---|
| `first_name`, `last_name` | yes | Up to 60 characters. |
| `email` / `phone` | at least one | A lead nobody can reach is refused. |
| `amount_requested` | no | Dollars. |
| `transaction_type_key` | no | One of the brokerage's transaction types. |
| `lead_source` | no | Defaults to `api:<key name>`. |
| `message` | no | Kept as a note on the file. Up to 4,000 characters. |
| `assign_to` | no | `"auto"` (default: round robin) or a staff id from `GET /staff/assignable`. Naming somebody needs `pipeline.assign`. |

`201`:

```json
{
  "ok": true,
  "data": {
    "customer_id": "010a1d47-…",
    "application_id": "1a319c8a-…",
    "assigned_to": { "id": "69b55bb0-…", "name": "Marcus Chen" },
    "possible_duplicates": []
  }
}
```

`assigned_to` is `null` when round robin is off, or nobody is in the rotation.
The lead then waits on the dashboard for somebody to hand it out.
`possible_duplicates` lists existing customers with the same email or phone.
They are reported, never merged.

### `GET /leads/{id}` — a lead's stage and owner

Needs `customer.view`. `{id}` is the `application_id` returned when the lead
was created.

### `POST /leads/{id}/assign` — hand a lead to somebody

Needs `pipeline.assign`. Body: `{ "user_id": "…" }` (optionally `"role"`,
default `"broker"`). Only **active** staff can be chosen. Inactive staff and
staff who have not activated their account are refused with a field error on
`user_id`. Round robin being off for that person does not matter here; it
only affects automatic assignment.

---

## Customers

A website that already knows somebody — a returning visitor, a signed-in
client — looks them up before sending a second lead, and keeps their contact
details current. A key acts for the brokerage, so it sees every customer.

### `GET /customers?email=rena@example.com`

Needs `customer.view`. Also `?phone=6475550142` or `?q=` (name, email or
phone, at least two characters). Up to 20 live records, most recently updated
first; records merged into another are left out.

```json
{ "ok": true, "data": [
  { "id": "7c1e…", "first_name": "Rena", "last_name": "Walsh",
    "email": "rena@example.com", "phone_e164": "+16475550142", "files": 1 }
] }
```

### `GET /customers/{id}`

Needs `customer.view`. The contact record (name, email, phone, address,
preferred language, lead source, referral, tags), the client's open `files`
with their stage, and `possible_duplicates` — other records with the same
email or phone.

### `PATCH /customers/{id}` — correct contact details

Needs `customer.edit`. Send only what changes; `null` or `""` clears a field.

| Field | Notes |
|---|---|
| `first_name`, `last_name` | |
| `email` | Stored lower-case |
| `phone` | Any format; stored as E.164. Must be a valid Canadian number |
| `address_line1`, `address_line2`, `city` | |
| `province` | Two-letter code |
| `postal_code` | Canadian; stored as `A1A 1A1` |
| `preferred_language`, `lead_source`, `referral_source` | |
| `tags` | Array of strings; replaces the list |

A customer must keep an email or a phone. The primary applicant on each of
their files follows the change. Returns `{ customer, changed, possible_duplicates }`.
A later push from the portal fills blanks only and never overwrites these.

Merging duplicates, archiving files and exporting are done inside the CRM and
have no API endpoint.

---

## LM Automation

Workflows are built in the CRM. A website can list them, fire a workflow's
**Inbound webhook** trigger, or put a client straight into one.

Each of these names the client with one of `customer_id`, `application_id`,
`email` or `phone`.

### `GET /automations`

Needs `automation.view`. Every workflow with its `status` (`active` = published,
`draft`, `paused`) and the trigger types of its live version.

### `POST /automations/{id}/webhook` — fire an Inbound webhook trigger

Needs `automation.control`. The workflow must be published with an *Inbound
webhook* trigger, or the call is refused with `409 not_listening`.

```json
{ "email": "client@example.com", "data": { "score": 82, "page": "rates" } }
```

Returns `202` with `{ received, customer_id }`. The workflow picks the event up
within a minute. Every flat value in `data` can be tested by the trigger's
filters as `event.<key>` — `event.score` is greater than 70. Only the workflow
the call names is started, however many others listen for webhooks. `404` when
no client matches.

### `POST /automations/{id}/enrol` — add a client now

Needs `automation.control`. Starts the client at the first step of the
published version, whatever its triggers. Entry and goal (stop) conditions and
the re-entry setting still apply; `409 already_enrolled` when they are already
in it or may not re-enter.

---

## Staff

A staff member's `status` is one of:

| `status` | Meaning |
|---|---|
| `invited` | Created; has not used their activation email yet. Cannot sign in, is not given leads. |
| `active` | Can sign in; can be given leads. |
| `inactive` | Cannot sign in; is not given leads, and is not in any assign list. |
| `deleted` | Archived. Gone from every list; their history on files is kept. |

A staff record:

```json
{
  "id": "d16a95da-…",
  "first_name": "Priya", "last_name": "Sandhu", "name": "Priya Sandhu",
  "email": "priya.sandhu@example.com", "mobile_phone": "+16475550110",
  "role": "broker", "role_name": "Broker",
  "title": "Mortgage Agent Level 2",
  "licence_number": "M23001234", "licence_province": "ON",
  "status": "active",
  "round_robin_enabled": true,
  "permissions": ["customer.view", "customer.create", "…"],
  "has_custom_permissions": false,
  "open_leads": 3, "open_tasks": 0,
  "last_login_at": "2026-09-15T15:43:40Z",
  "last_auto_assigned_at": "2026-09-15T15:44:02Z",
  "invited_at": "…", "activated_at": "…", "invite_expires_at": null,
  "created_at": "…"
}
```

### `GET /staff`

Needs `user.view`. Query: `status` (`all` — the default, meaning everybody
not deleted — or `active`, `invited`, `inactive`, `deleted`), `role`, `q`
(name or email).

### `GET /staff/assignable`

Needs `user.view` or `pipeline.assign`. Everybody a lead can be handed to
right now, with their open-lead count.

### `GET /staff/{id}`

Needs `user.view`.

### `POST /staff` — add somebody

Needs `user.manage`. They are emailed a link to choose a password. It works
once and expires in 72 hours. Until they use it they cannot sign in and are
not given leads. The link is never returned to an API caller.

| Field | Required | Rules |
|---|---|---|
| `first_name`, `last_name` | yes | Letters, spaces, hyphens, apostrophes; up to 60. |
| `email` | yes | Unique among current staff, case-insensitively. |
| `mobile_phone` | yes | A valid Canadian number. |
| `role` | yes | `broker`, `underwriter`, `manager`, `compliance_manager`. |
| `licence_number` | for `broker` | Letters, numbers, hyphens; up to 20. |
| `licence_province` | with a licence | Two-letter province code. |
| `title` | no | Up to 80. |
| `round_robin_enabled` | no | Default `false`. |
| `permissions` | no | The **full** list of permissions they should have. Omit for the role's defaults. |

`201`: `{ "staff": {…}, "invitation": { "sent": true, "provider": "smtp", "expires_at": "…" } }`.
If `sent` is `false`, `error` says why. An admin can resend from the CRM or
with `resend-invite`.

### `PATCH /staff/{id}`

Needs `user.manage`. Any of the fields above. Changing `role` without sending
`permissions` resets them to the new role's defaults.

### `POST /staff/{id}/deactivate`

Needs `user.manage`. Signs them out everywhere. If they have open leads or
open tasks, `reassign_to` is **required**: one active staff member's id, who
takes all of them. Funded and lost files keep their original owner.

```json
{ "reassign_to": "5fd51baf-…" }
```

→ `{ "staff": {…}, "handover": { "leads_moved": 3, "tasks_moved": 1, "to": "Tom Reilly" } }`

### `POST /staff/{id}/reactivate`

Needs `user.manage`.

### `POST /staff/{id}/resend-invite`

Needs `user.manage`. Replaces any earlier link. Only for `invited` staff.

### `DELETE /staff/{id}`

Needs `user.manage`. Same `reassign_to` rule as deactivate. The account is
archived, not erased, and its email address becomes free to invite again.

Nobody can deactivate or delete themselves, and the last active technical
admin cannot be deactivated, deleted or moved to another role (`409 last_admin`).

### `GET /staff/{id}/signature`

Needs `user.view`. Their email signature:

```json
{
  "mode": "custom",
  "source": "Warm regards,\n**{first_name}**\n{brokerage} · {mobile}",
  "standard_source": "**{name}**\n{title}\n…",
  "text": "Warm regards,\nAisha\nLendmax · (416) 555-0122",
  "html": "<div class=\"lmx-signature\" …>…</div>",
  "updated_at": "…",
  "fields": [{ "token": "name", "label": "Full name" }, …],
  "limits": { "characters": 1000, "lines": 15 }
}
```

### `PUT /staff/{id}/signature`

Needs `user.manage`. `{ "mode": "standard" }` returns them to the signature
built from their profile. `{ "mode": "custom", "source": "…" }` sets their own.

A signature is lines of text, not HTML. A line may use the fields listed in
`fields` (for example `{mobile}`, which is filled from their profile), `**bold**`,
and URLs or email addresses, which are linked automatically. A line whose
field has no value is left out. An unknown field, more than 1,000 characters
or more than 15 lines is refused with a field error on `source`. Staff can also
edit their own signature in the CRM under **Your profile**.

---

## Required documents

The checklist a client is asked for, for each of the application's four
purposes. The application portal reads it to show a client what to upload.

Purposes: `purchase`, `renew`, `refinance`, `home_equity_line`. Anywhere a
purpose is accepted, the portal's wording (`Purchase`, `Home Equity Line`)
works too.

Formats: `pdf`, `jpg`, `jpeg`, `png`, `heic`, `webp`, `tiff`, `doc`, `docx`,
`xls`, `xlsx`, `csv` — only formats the CRM's uploader accepts.

### `GET /required-documents/checklist?purpose=Purchase`

Needs `required_document.view`. What a client with that purpose is asked for:
the active entries, in the order the admin set. An unrecognised purpose returns
an empty list.

```json
{
  "ok": true,
  "data": {
    "purpose": { "key": "purchase", "label": "Purchase" },
    "documents": [
      {
        "id": "…", "purpose": "purchase", "purpose_label": "Purchase",
        "name": "Two most recent pay stubs",
        "description": "Showing your name, your employer and year-to-date earnings.",
        "formats": ["pdf", "jpg", "jpeg", "png"], "formats_label": "PDF, JPG, JPEG or PNG",
        "category_key": "pay_stubs", "category_label": "Pay Stubs",
        "required": true, "per_applicant": true, "position": 2, "active": true,
        "created_at": "…", "updated_at": "…", "updated_by_name": "Alex Admin"
      }
    ]
  }
}
```

`required: false` means "if it applies to you" (a gift letter).
`per_applicant: true` means one from each applicant.

### `GET /required-documents`

Needs `required_document.view`. The full list, for an admin screen. It takes the
same query as every table in the CRM:

| Parameter | |
|---|---|
| `q` | Searches the name and description. |
| `purpose`, `format`, `category` (`__none` for none) | Filters. |
| `status` | `active`, `inactive` or `all` (the default). |
| `required`, `per_applicant` | `yes` or `no`. |
| `sort` | `position` (the default: purpose, then the admin's order), `purpose`, `name`, `formats`, `category`, `required`, `per_applicant`, `active`, `updated_at`. |
| `dir` | `asc` or `desc`. |
| `page`, `page_size` | Page size up to 100; default 25. |

Returns `{ rows, total, page, page_size, purposes: [{ key, label, total, active }] }`.

### `GET /required-documents/meta`

The purposes, formats and document categories, for building a form.

### `POST /required-documents`

Needs `required_document.manage`.

| Field | Required | Rules |
|---|---|---|
| `purpose` | yes | One of the four. |
| `name` | yes | 2–120 characters; unique within the purpose. |
| `description` | no | Up to 1,000 characters. What the client reads. |
| `formats` | yes | At least one. |
| `category_key` | no | One of the brokerage's document categories. |
| `required` | no | Default `true`. |
| `per_applicant` | no | Default `false`. |
| `active` | no | Default `true`. |

A new entry goes to the end of its purpose's list.

### `PATCH /required-documents/{id}`

Needs `required_document.manage`. Any of the fields above. Moving it to another
purpose puts it at the end of that list.

### `POST /required-documents/{id}/move`

Needs `required_document.manage`. `{ "direction": "up" }` or `"down"`, within its
purpose. `409 cannot_move` at either end.

### `DELETE /required-documents/{id}`

Needs `required_document.manage`. Removes it from the list. It is archived, so
requests already sent keep their record of it, and the name can be used again.

### `POST /required-documents/suggested`

Needs `required_document.manage`. `{ "purpose": "renew" }` adds the suggested
starting list for that purpose, skipping any name already there.

---

## Pipelines

A brokerage can run several pipelines (Purchases, Renewals, Private
lending…), each with its own stages. A new application goes to the pipeline
that takes its purpose, or to the default pipeline, on that pipeline's first
"In progress" stage.

A stage is identified by its `key`, unique across all pipelines and never
changed once made. A file's pipeline is always its stage's pipeline, so
moving a file to a stage in another pipeline moves it to that pipeline.

Stage `category` — what the stage means: `open` (in progress), `parked` (on
hold / nurture), `won` (funded), `lost`.

### `GET /pipelines`

Needs `pipeline.view`. Every pipeline, with its stages and how many files
are on each:

```json
{
  "id": "…", "key": "renewals", "name": "Renewals", "description": "…", "colour": "#6366f1",
  "is_default": false, "active": true, "purposes": ["renew"], "purpose_labels": ["Renew"],
  "stage_count": 5, "files_open": 12, "files_total": 40, "problems": [],
  "stages": [
    { "id": "…", "key": "renewals_new", "label": "New", "category": "open", "category_label": "In progress",
      "probability": 10, "colour": "#6366f1", "position": 10, "active": true, "files": 7,
      "entry_rules": {}, "description": null }
  ]
}
```

`problems` lists what would stop an active pipeline working (no active
In-progress, Won or Lost stage). It is normally empty.

### `GET /pipelines/for-purpose?purpose=Renew`

Needs `pipeline.view`. The pipeline and first stage a new application with
this purpose enters. `{ pipeline, entry_stage_key }`.

### `GET /pipelines/{id}` · `GET /pipelines/{id}/usage` · `GET /stages/{id}/usage`

Needs `pipeline.view`. Usage is what depends on a pipeline or stage: the files
on it (`files`, `files_open`, `by_stage`), the automations and campaigns that
name it, and the purposes it takes.

### `POST /pipelines`

Needs `pipeline.configure`.

| Field | |
|---|---|
| `name` | Required, 2–80 characters, unique. |
| `description`, `colour` | Optional. `colour` is `#rrggbb`. |
| `purposes` | Purposes it takes. A purpose another pipeline has moves here; the response's `notices` say so. |
| `is_default` | Make it the default. |
| `active` | Default `true`. |
| `copy_from` | A pipeline id whose stages to copy. Without it: New, In progress, Funded, Lost. |

### `PATCH /pipelines/{id}`

Needs `pipeline.configure`. Any field above except `copy_from`. The default
pipeline cannot be made inactive (`409 default_inactive`), and cannot stop
being the default except by making another one the default. An inactive
pipeline takes no new files; its purposes go to the default until it is
turned back on.

### `DELETE /pipelines/{id}`

Needs `pipeline.configure`. Not the default. If it has files, send
`{ "stage_map": { "<its stage key>": "<active stage key in another pipeline>" } }`
for every stage with files. They are moved, the move is recorded on each
file, then the pipeline is archived. Moving them sends nothing to clients.

### `POST /pipelines/{id}/stages`

Needs `pipeline.configure`.

| Field | |
|---|---|
| `label` | Required, 2–60, unique within the pipeline. |
| `category` | Required: `open`, `parked`, `won`, `lost`. |
| `probability` | 0–100 or `null` (left out of the forecast). |
| `colour`, `description` | Optional. |
| `entry_rules` | What a file needs to enter: `minPercentComplete`, `requireAppointment`, `requireScarlettDeal`, `blockedOnceScarlettPushed`, `requireLostDisposition`, `requireFundingConfirmed`, `requireComplianceComplete` (booleans, or a number for the first). |
| `active` | Default `true`. |

An In-progress or On-hold stage is placed before the Won and Lost ones; a Won
or Lost stage at the end.

### `PATCH /stages/{id}` · `POST /stages/{id}/move` · `DELETE /stages/{id}`

Needs `pipeline.configure`. Move takes `{ "direction": "up" | "down" }`.
Delete takes `{ "move_to": "<stage key>" }` when the stage has files. A change
that would leave an active pipeline with no active In-progress, Won or Lost
stage is refused (`409 pipeline_incomplete`).

### `POST /leads/{id}/stage`

Needs `pipeline.move`. `{ "stage_key": "…", "reason": "…" }` moves a lead,
within its pipeline or into another. The stage's entry rules apply; a refusal
is `422 stage_blocked` with `blockers`, each a sentence saying what is missing.

`POST /leads` also accepts `purpose` (`Purchase`, `Renew`, `Refinance`, `Home
Equity Line`), which chooses the pipeline. Without it, the transaction type's
purpose is used.

---

## Round robin

### `GET /assignment`

Needs `user.view`.

```json
{
  "ok": true,
  "data": {
    "round_robin_enabled": true,
    "rotation": [
      { "id": "…", "name": "Aisha Khan", "last_auto_assigned_at": "…" },
      { "id": "…", "name": "Priya Sandhu", "last_auto_assigned_at": "…" }
    ],
    "next_up": { "id": "…", "name": "Aisha Khan" }
  }
}
```

`rotation` is in order: whoever was handed a lead longest ago is next. It
includes only staff who are active, activated and have `round_robin_enabled`.

### `PUT /assignment`

Needs `user.manage`. `{ "round_robin_enabled": false }` makes new leads arrive
unassigned. Leads from the application portal, from `POST /leads` and from the
CRM's own "New customer" all follow this switch.

---

## Tasks

A task is a promise about a file: "call Rena at 4:30". A key acts for the
brokerage rather than for one person, so it reads everyone's work with
`task.view_all` and makes work with `task.manage_all`.

**Whose task it is is not a field you send.** A task on a client's file
belongs to whoever that client is assigned to; a task with no file belongs to
nobody in particular and is left with the key's own actor. This is the same
rule the admin panel's read-only "Assigned to" field shows, and sending an
assignee is not a way around it.

### `POST /tasks`

Needs `task.manage_all`.

```json
{
  "title": "Call the customer about the rate hold",
  "description": "They asked to be called after 4.",
  "application_id": "…",
  "due_on": "2026-09-18",
  "due_time": "16:30",
  "priority": "high",
  "category": "follow_up",
  "reminder_minutes": 15
}
```

| Field | Required | Notes |
|---|---|---|
| `title` | yes | Up to 160 characters. |
| `application_id` | no | The file it sits on. Decides whose task it is. |
| `due_on` | no | `YYYY-MM-DD`. Without it the task has no date and is never reminded about. |
| `due_time` | no | `HH:MM`, in the brokerage's timezone. A time needs a date. A time that does not exist — the hour the clocks go forward — is refused rather than moved. |
| `reminder_minutes` | no | Minutes before the start; `15` by default, `0` for "when it starts", `null` for none. Ignored without a time. |
| `priority` | no | `low`, `normal` (default), `high`, `urgent` |
| `category` | no | `follow_up` (default), `document_request`, `lender_submission`, `application_review`, `compliance`, `condition`, `appointment`, `closing_deadline`, `renewal`, `other` |

`201` returns `{ task }`, whose `owner` says who it went to.

### Everything else

| Endpoint | Scope | What |
|---|---|---|
| `GET /tasks/meta` | view | Categories, priorities, statuses, reminder choices, the timezone |
| `GET /tasks` | view | The list. `tab` (`open`, `today`, `overdue`, `completed`, `cancelled`, `all`), `q`, `owner`, `category`, `priority`, `status`, `bucket`, `application_id`, `from`, `to`, `sort`, `dir`, `page`, `page_size`. Returns `{ tasks, total, tabs, timezone }` |
| `GET /tasks/files` | manage | The files a task may be put on, each with whose it is |
| `GET /tasks/{id}` | view | One task |
| `PATCH /tasks/{id}` | manage | Edit, move, or set `status`. A finished task is reopened before it is changed again |

## Appointments

Meetings with clients. A key acts for the brokerage as a whole: with
`appointment.manage_all` it books for any staff member, and a booking that
names nobody goes to the file's broker. Everything the admin panel does
happens here too:
- the file moves to its pipeline's "booked" stage;
- the host's Google Calendar is updated (a Meet link is created for video calls);
- the client gets the confirmation email;
- a reminder goes to the client and the host 15 minutes before.

Times are sent either as `starts_at` (ISO 8601 with its offset) or as `date`
+ `time` + `timezone` (wall-clock time in that zone, e.g. `"2026-09-18"`,
`"14:30"`, `"America/Toronto"`). A time the clocks skip is refused.

### `POST /appointments`

Needs `appointment.manage_all`.

```json
{
  "application_id": "…",
  "user_id": "…",
  "appointment_type": "discovery",
  "mode": "video",
  "starts_at": "2026-09-18T14:30:00-04:00",
  "duration_minutes": 30,
  "location": null,
  "meeting_url": null,
  "notes": "Referred by the website",
  "notify_client": true,
  "allow_conflict": false
}
```

| Field | Required | Values |
|---|---|---|
| `application_id` | yes | The client file. It must be assigned to the host. |
| `user_id` | no | Who hosts it. Defaults to the file's broker. |
| `appointment_type` | no | `discovery` (default), `application_review`, `document_review`, `rate_review`, `signing`, `other` |
| `mode` | no | `video` (default), `phone`, `in_person` |
| `location` | for `in_person` | The address. For `phone`, the number to call (the client's by default). |
| `meeting_url` | for `video` without Google | A Zoom or Teams link. When the host has Google Calendar connected, leave it out and a Meet link is made. |
| `notify_client` | no | Send the confirmation email. Default `true`. |
| `allow_conflict` | no | Book even though the host is busy in Google Calendar. |

`201` returns `{ appointment, stage, google, email }`. `stage` says where the
file moved (or why it stayed), `google` whether the calendar was updated, and
`email` whether the confirmation went out.

Refusals:
- `409 double_booked`: the host already has a CRM meeting at that time. It can't be overridden.
- `409 calendar_busy`: the host is busy in Google Calendar, and `detail.busy` lists the blocks. Resend with `allow_conflict: true` to book anyway.
- `422`: field errors, for example a file not assigned to the host, or a time that has passed.

### `GET /appointments`

Needs `appointment.view_all` or `appointment.manage_all`.

| Parameter | Meaning |
|---|---|
| `tab` | `upcoming`, `needs_outcome` (started, no outcome yet), `attended`, `missed`, `cancelled`, `all` (default) |
| `host`, `booked_by` | A staff id |
| `type`, `mode`, `status` | As above; status is `booked`, `confirmed`, `completed` (attended), `no_show` (missed), `cancelled` |
| `when` | `today`, `tomorrow`, `this_week`, `next_7`, `last_7`, `last_30`, `future`, `past` |
| `from`, `to` | Dates or ISO timestamps |
| `application_id`, `customer_id` | One file's, one client's |
| `q`, `client` | Search |
| `google` | `synced`, `error`, `off` |
| `sort`, `dir`, `page`, `page_size` | Sort by `starts_at` (default), `client`, `host`, `type`, `mode`, `status`, `booked_by`, `created_at` |

Returns `{ appointments, total, tabs }`, where `tabs` counts each tab under the same filters.

### The rest

| Endpoint | Needs | Does |
|---|---|---|
| `GET /appointments/meta` | view | Types, modes, statuses, durations |
| `GET /appointments/{id}` | view | One appointment |
| `GET /appointments/hosts` | manage | Staff who can host, with whether Google is connected |
| `GET /appointments/files?host=` | manage | That person's client files |
| `GET /appointments/availability?host=&date=` | manage | Their CRM meetings and Google busy times that day |
| `PATCH /appointments/{id}` | manage | Move it or change it. The same fields as booking; a new time re-arms the reminder and emails the client (`notify_client`) |
| `POST /appointments/{id}/cancel` | manage | `{ "reason": "…", "notify_client": true }` |
| `POST /appointments/{id}/confirm` | manage | The client confirmed |
| `POST /appointments/{id}/outcome` | manage | `{ "outcome": "attended" \| "missed", "note": "…" }`. Only after it starts, and it moves the file |

`PATCH /pipelines/{id}` accepts `appointment_stages: { booked, attended, missed }`:
stage keys in that pipeline, or `null` for "don't move".

---

## Activity logs

What each staff member (and each connected website) did in the last 30 days:
sign-ins, every change the CRM records, and the client files they opened. Read
only. Nothing deletes an entry, through this API or anywhere else. Each one is
removed automatically 30 days after it happened. The compliance audit trail is
a separate record with its own retention, and is not exposed here.

### `GET /activity`

Needs `activity.view_all`. Newest first, 25 to a page.

| Parameter | Meaning |
|---|---|
| `user` | A staff member's id, or `__integrations` for connected websites and the portal |
| `module` | `account`, `customers`, `pipeline`, `documents`, `required_documents`, `messages`, `tasks`, `calendar`, `automations`, `campaigns`, `underwriting`, `funding`, `compliance`, `reports`, `staff`, `settings`, `activity`, `system`, `other` |
| `action` | An action key, for example `auth.sign_in`, `customer.opened`, `pipeline.stage_create` |
| `application_id` | Only entries about this client file |
| `period` | `today`, `yesterday` (Toronto time) or `7d` |
| `from`, `to` | A date (`2026-09-01`) or an ISO timestamp. A bare `to` date includes that whole day |
| `q` | Search across details, person, action and client name |
| `client`, `summary` | Search the client name/reference, or the details, alone |
| `sort` | `at` (default), `actor`, `module`, `action`, `client` |
| `dir` | `desc` (default) or `asc` |
| `page`, `page_size` | `page_size` up to 100 |

```json
{
  "ok": true,
  "data": {
    "total": 118,
    "entries": [
      {
        "id": "118",
        "at": "2026-09-15T18:57:55.403Z",
        "actor_user_id": "…", "actor_name": "Priya Sandhu",
        "actor_role": "broker", "actor_role_name": "Broker", "actor_kind": "user",
        "action": "customer.opened", "action_label": "Opened a client file",
        "module": "customers", "module_label": "Customers & leads",
        "application_id": "…", "client_name": "Rena Wal",
        "summary": "Opened the file of Rena Wal (LMX-A-202609-8803)",
        "ip": "203.0.113.7"
      }
    ]
  }
}
```

A client file opened several times within 30 minutes by the same person is one
entry. `GET /leads/{id}` through this API counts as the key opening the file.

### `GET /activity/options`

Needs `activity.view_all`. What the filters can offer: `modules`, `actions`
(each with its module), `people` (every staff member, plus former ones who
still have entries, with `status`), and `integrations` (whether any website
activity exists).

---

## For whoever builds the next module

1. Add the module's permissions to `PERMISSIONS` and a `MODULES` entry in
   `src/domain/permissions.ts`. Mark the ones that get an endpoint `api: true`.
   `test/permissions.test.ts` fails if a permission is in no module. The staff
   form's checkboxes and the API key screen pick the new module up on their own.
2. Put the rules in a service that takes an `Actor` (a person or an API key),
   so the admin panel and the API cannot disagree.
3. Add the routes to `src/http/routes/api-v1.ts` with `requireScope(...)`, and
   a section to this document.
4. Record changes with `recordAudit` and they appear in the activity logs on
   their own. A new action prefix needs one line in `MODULE_BY_PREFIX` (and a
   label in `ACTION_LABELS`) in `src/domain/activity.ts` to be filed under the
   right module; `test/activity.test.ts` checks the module exists.
