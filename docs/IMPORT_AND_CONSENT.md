# Import batches, consent ledger & durable jobs (v0.4.0, Wave 2B)

Three additive systems. None of them touches the workflow engine, the
in-memory queue (`src/lib/queue.ts`), the legacy direct import, or the
campaigns routes.

## 1. Import batches: preview → confirm

The legacy direct import (`POST /api/contacts/import`, paste CSV →
contacts created immediately, duplicates rejected) is **unchanged**.
The batch flow adds a review step for messy files:

```
POST /api/contacts/imports            { filename, csv, mapping? }
  → 201-style { batchId, counts, rows[] }   (status PREVIEW)
GET  /api/contacts/imports?id=<batchId>      (batch + rows, incl. row ids)
POST /api/contacts/imports/<id>/confirm { resolutions }
  → { imported, skipped, failed, errors[] } (status CONFIRMED)
```

UI: `/app/contacts/import` (full preview/confirm flow) plus a minimal
"Import batches" section on `/app/contacts` that lists batches and links
there. The contacts page's existing import modal is untouched.

### Parsing & mapping

- CSV parsing is the same quoted-field parser as the legacy route
  (`parseCsv` in `src/lib/imports.ts`, copied with attribution so both
  flows parse identically).
- Column mapping: pass an explicit `mapping` object
  (`{ csvHeader: contactField }`, headers matched case-insensitively).
  Without one, common headers are default-mapped: `name`, `email`,
  `phone`, `channel`, `tags` (`;`- or `,`-separated), `company`,
  `consent`, `consent_channel` / `consentchannel` → `consentChannel`.
  `company` has no Contact column, so it is stored in `customFields`.
- The header must map to `name`, or creation fails with 422.

### Validation (per row)

- `name` required; `email` must match the standard format; `phone` is
  normalized E.164-ish (formatting stripped, a leading `+` kept, no
  country code ever invented) and must have 7–15 digits.
- `consent` values: `opted_in` / `yes` / `true` / `subscribe` → OPTED_IN;
  `opted_out` / `no` / `false` / `unsubscribe` → OPTED_OUT; anything
  else is a validation error.
- Invalid rows get status `INVALID` with `errors[]` and can never import,
  even with an explicit `create` resolution (they count as `failed`).

### Dedupe detection

A row is `DUPLICATE` when its normalized email **or** normalized phone
matches an existing contact in the same workspace (formatting-insensitive,
so `+1 (555) 999-8888` matches `+15559998888`), or when it repeats an
earlier row in the same file (`duplicateInBatch`). A duplicate row
carries `matchedContactId` plus a `diff` of conflicting fields — fields
where both sides are non-empty and differ. The diff is shown in the UI;
nothing in it is ever applied automatically.

### Confirm resolutions (one transaction per batch)

`resolutions` maps row id → `"create" | "merge" | "skip"`, or an object
`{ action, overwriteFields }` for merges. All rows are applied inside a
single Prisma transaction; the batch flips to `CONFIRMED` with counts.

- **Defaults** (no resolution supplied): `VALID` → create; `DUPLICATE` →
  skip; `INVALID` → skip. A duplicate is **never silently merged**.
- **create** → a new Contact.
- **merge** → updates the matched contact **only** via the merge rule
  below. A merge with no matched contact fails for that row.
- **skip** → row marked `SKIPPED`.
- A second confirm on a `CONFIRMED` batch returns 409 — rows are never
  double-applied.

### Merge rules (`mergeFields` in `src/lib/imports.ts`)

Default: **fill empty fields only**. A field is written only when the
existing value is empty. Non-empty existing values are never overwritten
unless the resolution explicitly lists the field in `overwriteFields`.
The allowlist is `name, email, phone, channel, tags, company` — any other
field name in `overwriteFields` is ignored. Tags and company follow the
same rule (empty existing tags/company → incoming value; otherwise only
with an explicit overwrite listing).

### Suppression survival (critical)

Merging updates the **same contact id**, and the import code never
deletes Suppression rows. So a suppressed contact that is imported again
and merged keeps its suppression and stays excluded from outbound sends
(the eligibility checker blocks suppressed contacts). Re-importing can
never re-add a suppressed contact to an audience: it does not create a
second, unsuppressed row, and it does not clear the flag. This is covered
by a test in `src/lib/imports.test.ts` ("a suppressed contact re-imported
and merged KEEPS its suppression").

### Consent columns on import

When a row carries a `consent` column, confirming the row (create or
merge) writes a `ConsentRecord` with source `"import"`, on the channel
from `consentChannel` (else the row's channel, else `"email"`). An
`OPTED_OUT` value also creates the Suppression row for that channel, so
ledger and enforcement agree.

## 2. Consent ledger

- `src/lib/consent.ts`: `recordConsent()`, `getConsentState()`,
  `isSuppressed()`, `getConsentStatesForContact()`.
- `GET /api/consent` (Member): `?contactId=` → that contact's records,
  suppressions, and effective states; no contact id → workspace-wide
  lists (capped at 500). Optional `?channel=` narrows.
- `POST /api/consent` (AGENT+): `{ contactId, channel, status, source?,
  wordingVersion? }`. `OPTED_OUT` also creates the Suppression row.
- UI: `/app/consent` — Audience & Consent Manager: per-contact consent
  by channel, suppression list with reasons, opt-out handling, and a
  note that suppressions survive re-import.

**Effective state** (per channel, via `getConsentState`):

1. Any Suppression row covering the channel (a row scoped to that
   channel, or an all-channel row with `channel = null`) →
   `SUPPRESSED` — this **always beats a stale OPTED_IN record**.
2. Otherwise the latest `ConsentRecord` for the channel →
   `OPTED_IN` / `OPTED_OUT`.
3. Otherwise `UNKNOWN`.

**Stickiness:** an `OPTED_IN` record never removes a Suppression row.
Un-suppressing is a separate, deliberate action (delete the Suppression
row), never a side effect of an import or a new opt-in record. The
`ConsentRecord` history itself is append-only and remains visible even
when a suppression overrides it.

## 3. Durable jobs

`src/lib/jobs.ts` is the DB-backed job system on the `BackgroundJob`
model. It is the durable path for **new** job types; workflow execution
jobs keep using the in-memory queue in `src/lib/queue.ts`, which this
wave deliberately did not touch.

### API

- `enqueueJob(type, payload, { workspaceId, maxAttempts, idempotencyKey,
  notBefore })` → `{ jobId, duplicate }`. A duplicate idempotency key
  returns the existing job and never double-enqueues (the unique
  constraint is also caught, so a race between check and create still
  resolves to one row).
- `claimDueJobs(workspaceId?, limit?)` — jobs with status `QUEUED` and
  `notBefore <= now`, claimed inside one transaction via conditional
  `QUEUED → RUNNING` updates, so exactly one worker run claims a job.
- `completeJob(jobId)` → `SUCCEEDED`.
- `failJob(jobId, error)` — increments attempts; returns the job to
  `QUEUED` with `notBefore = now + backoff`, or to `DEAD_LETTER` once
  `attempts >= maxAttempts`.
- `listJobs({ workspaceId, status, type, limit })`.
- `processDueJobs(workspaceId?)` — claims due jobs and runs their
  registered handlers; one bad job never stops the batch; a job type
  with no registered handler fails (and eventually dead-letters) instead
  of vanishing silently.

### Backoff

`computeBackoffMs(attempts)`: base 1s × 2^(attempts−1), capped at 60s,
plus up to +25% jitter (pass a jitter fraction of 0 for deterministic
values in tests). Attempt 1 → 1s, 2 → 2s, 3 → 4s, …, 7+ → 60s.

### Handlers & routes

- `src/lib/job-handlers.ts` is the handler registry. Register a handler
  with `registerJobHandler(type, async (ctx) => …)`; `ctx` carries
  `jobId`, `workspaceId`, `payload` (parsed JSON) and `attempts`. The
  module registers on import, so route handlers only need to import it.
- Shipped handler: **`import_confirm`** — payload
  `{ batchId, workspaceId, resolutions }`. It runs the same
  `applyImportResolutions()` the synchronous confirm route uses, so a
  batch confirmed through either path ends up identical, and a
  redelivered job whose batch is already `CONFIRMED` succeeds as a
  no-op instead of double-importing.
- `GET /api/jobs` (Member): jobs for the workspace plus a `deadLetters`
  subset. Query: `status`, `type`, `limit`.
- `POST /api/jobs/process-due` (MANAGER+): claims due jobs for the
  workspace and runs their handlers. **Not wired into the workflow
  engine** — it is a worker endpoint for new durable job types only.

### Running process-due (external cron)

Same pattern as `/api/campaigns/process-due`: hit the endpoint on a
schedule (e.g. every minute) with a valid session. Like the campaign
worker, this endpoint authenticates via the user's session cookie /
`x-workspace-id` header — there is no separate cron secret in v0.4.0,
so the cron caller must present a MANAGER+ session for the workspace:

```
curl -X POST https://<host>/api/jobs/process-due \
  -H "Cookie: <manager-session-cookie>" \
  -H "x-workspace-id: <workspace-id>"
```

Response: `{ claimed, succeeded, failed, deadLettered, results[] }`.
Jobs whose `notBefore` is in the future (backoff) are not claimed until
due; exhausted jobs land in `DEAD_LETTER` and are visible via
`GET /api/jobs` (`deadLetters`) for operator review.
