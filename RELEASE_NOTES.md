# FlowPilot AI — Release Notes v0.4.0 (2026-10-24)

Integration audit + repair, Integration Health Center, Instagram
Comment-to-DM module, AI Prospecting (honest blocked state), outreach
campaigns with approval flow, Excel/CSV import with preview, Audience &
Consent Manager, email campaigns, durable background jobs, and security
hardening — all in place, additive, no working feature removed. Supersedes
v0.3.0. Verified on the final tree: **972/972 tests (115 files)**,
TypeScript clean, production build exit 0 (129/129 static pages generated;
192 routes in the table, including all 5 new pages), Prisma schema
valid. Full detail: `docs/HEALTH_CENTER.md`, `docs/COMMENT_TO_DM.md`,
`docs/IMPORT_AND_CONSENT.md`, `docs/PROSPECTING.md`, `docs/LINKEDIN_STATUS.md`,
`docs/EMAIL_CAMPAIGNS.md`.

## Headline: the integration layer is now honestly testable

- **Integration Health Center** (`/app/health-center`): per-account cards
  with real Test Connection (identity lookup, not just token refresh),
  webhook-subscription status, verified-at / last-sync / last-error, and
  SIMULATED badges. Granted scopes are labeled "not checked via API" —
  no scopes read exists, so none is claimed.
- **Ten integration defects repaired (D1–D10)**: WhatsApp OAuth now
  labeled manual-token-only (it could never complete); sends refresh
  tokens before firing; history sync uses and persists the refreshed
  token; Business-Login Instagram verifies correctly; Instagram scopes
  updated to the current `instagram_business_*` set; webhook resubscribe
  endpoint exists; media sends honestly labeled text-only; the
  integrations list no longer collapses multi-account workspaces.
- **Graph API stays pinned at v21.0** (documented expiry 2027-01-21 is a
  roadmap item, not a silent upgrade).

## What's new

**Instagram Comment-to-DM** (`/app/comment-to-dm`) — multi-post rules,
keyword matching (contains / exact / startsWith, case-insensitive by
default), public comment reply + private reply via the official API only,
webhook dedupe (one reply per comment, 7-day eligibility window),
dry-run mode, per-rule analytics. No scraping, no unofficial endpoints.
Webhook redelivery is exactly-once; a same-instant race is caught by the
unique backstop (documented limitation).

**AI Prospecting** (`/app/prospecting`) — configurable industry, region,
ICP, keywords, exclusions, target count; explainable rule-based scoring;
domain/name dedupe; CSV export with formula neutralization. **No search
provider is configured in v0.4.0**, so searches land in the honest
`BLOCKED_NO_SOURCE` state with the exact prerequisite — nothing is
invented. Manual entry and import are fully usable; every prospect
without a verified source URL is labeled "unverified — user-entered".

**Outreach campaigns** — approval flow (`request-approval` / `approve`;
start is gated: pending approval blocks, rejected approval blocks),
scheduling, rate limits, retries, suppression. Email is now a real
campaign channel (`process-email` route) with template variables from
verified fields only, unsubscribe footer on every email, and
accepted-vs-delivered honesty (no delivery/open tracking exists).
WhatsApp Business keeps official-API templates/windows/opt-in. **SMS has
no provider configured** — provider abstraction + blocked status, never a
hardcoded working provider. **LinkedIn: audit only** — messaging and
automated connections are marked UNSUPPORTED, never built.

**Excel/CSV import** (`/app/contacts/import`) — paste CSV → preview with
per-row status, errors and conflicting-field diff → per-row resolution
(create / merge / skip) → report. Never silently overwrites: merge is
fill-empty-only unless overwrite fields are explicitly listed; unresolved
duplicates default to skip; INVALID rows can never import.

**Audience & Consent Manager** (`/app/consent`) — per-channel consent
records with source; suppression ALWAYS beats a stale opt-in; opt-out
creates the suppression; opt-in never removes one; suppressions survive
re-import and merge untouched.

**Durable background jobs** — DB-backed `BackgroundJob` with idempotency
keys, exactly-one claim, exponential backoff + jitter, dead-letter after
max attempts; `GET /api/jobs` and `POST /api/jobs/process-due`
(external-cron hit-point, same pattern as campaigns). The workflow
engine's in-memory queue is unchanged by design — durable jobs cover new
job types; the engine migration is a documented follow-up.

**Security hardening** — password change and password reset now
invalidate all previously issued JWTs (token-version check in
`getSession`; tokens issued before v0.4.0 are accepted until the next
password change — migration leniency, documented). CSV formula
injection neutralized in both exporters. The generic webhook route now
fails closed (503) when `WEBHOOK_SECRET` is unset instead of trusting
any payload via the mock adapter. Baseline security headers added
(nosniff, referrer policy, frame deny, permissions policy — no CSP, which
would break inline scripts/styles). Workspace cookie is `secure` in
production. Backup files (`*.bak`) are now gitignored. Deliberately
NOT changed (documented limitations): single-device logout still only
clears the cookie; signup 409 oracle (standing limitation); verified-email
gate not enforced on connects/sends; rate-limit X-Forwarded-For trust
needs a trusted-proxy design decision.

**Known advisory (OSV, checked 2026-10-24):** 1 advisory across 134
production packages — `zod` GHSA-mrhx-c7xc-m3w5 (memory exhaustion when
validating oversized arrays against schemas without a length constraint;
fixed in zod 4.6.6). Not fixed in this release: zod 4 is a major version
with breaking changes and is not upgraded blind. Exposure here is limited
— every zod-validated route requires workspace membership (authenticated
only) — and the upgrade is a documented follow-up with a full re-test.

## Schema (additive only, via `prisma db push` — no migrations folder)

10 new models: `HealthCheck`, `CommentDmRule`, `CommentDmEvent`,
`ProspectSearch`, `Prospect`, `ConsentRecord`, `ImportBatch`,
`ImportRow`, `BackgroundJob`, `CampaignApproval`; `Integration`
gains `webhookSubscribedAt` + `webhookSubscriptionDetail`; `User` gains
`tokenVersion`. Migration verified on a scratch copy of the production
dev.db first (row counts preserved, integrity `ok`), then applied to
`prisma/dev.db`. Backup before any change:
`prisma/dev.db.bak-v040-20261024` (integrity `ok`). Recovery: copy the
backup over `prisma/dev.db` and revert the code — never
`migrate reset` or `--accept-data-loss` outside the test suite.

## Honest limits (unchanged from v0.3.0 unless noted)

- **WhatsApp live gate is still open** — real inbound → real workflow →
  real reply with JOE's Meta credentials + public HTTPS webhook
  (`docs/INTEGRATIONS_STATUS.md` §2). Check the Meta Billing Hub payment
  method first (service messages past the free 1,000/month tier do not
  deliver without one). Everything WhatsApp is mock-verified only.
- Live provider tests are BLOCKED — no Meta/TikTok/Resend/SMS credentials
  exist in this environment. Every live check in this release is labeled
  with its exact prerequisite.
- Scheduled triggers and delay nodes are still modeled, not executed
  (no scheduler loop in-repo; `process-due` endpoints are external-cron
  hit-points). Workflow file import/export, version restore UI, and
  hard design-time provider gating remain deferred.
- Campaign approval and the email channel are API-complete; the
  campaigns page wizard UI was not extended for them in v0.4.0.
- The in-memory workflow queue, demo-mode send blocking, and all v0.3.0
  behavior are preserved. No feature, page, route, or endpoint was
  removed.

## Install (upgrade from v0.3.0, Windows)

Back up `.env` + `prisma\dev.db` → extract over your folder → restore
backups → `npm.cmd install` → `npx.cmd prisma db push` (additive) →
`npx.cmd tsx src/db/seed-plans.ts` → `npx.cmd next dev -p 3000`.
No re-login is forced by this upgrade (legacy tokens without a version
claim keep working until your next password change). New env placeholders
in `.env.example` (unconfigured in v0.4.0): `SMS_PROVIDER`,
`SMS_API_KEY`, `SEARCH_PROVIDER`, `SEARCH_API_KEY` — leave empty unless
you configure a provider. Resend needs `RESEND_API_KEY` + `EMAIL_FROM`
(verified sender domain); without them email honestly reports
`EMAIL_NOT_CONFIGURED`.
