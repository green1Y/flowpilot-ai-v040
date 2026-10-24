# Changelog — FlowPilot AI

## v0.4.0 — 2026-10-24 (integration audit + repair, Health Center, Comment-to-DM, Prospecting, campaigns approval, import, consent, durable jobs, hardening)

Baseline 818/818 (85 files) → final 972/972 (115 files), tsc clean,
production build 129/129 static pages generated (exit 0), Prisma valid. All schema changes additive
via `prisma db push` (no migrations folder); scratch-copy migration
verified before applying to dev.db; backup
`prisma/dev.db.bak-v040-20261024` (integrity `ok`).

- **Integration repairs (D1–D10):** WhatsApp OAuth labeled manual-token-only
  (it could never complete); send path refreshes tokens before firing;
  history sync uses + persists the refreshed token (Facebook Page syncs
  still prefer the page token — page endpoint needs a page-scoped token);
  Business-Login Instagram verify fixed; Instagram catalog scopes updated
  to `instagram_business_*`; webhook resubscribe endpoint + health probes
  added; media sends labeled text-only (adapters ignore `media`); per-account
  list endpoint (`GET /api/integrations/accounts`) ends the provider-collapse
  bug. Graph API stays pinned at v21.0 (2027-01-21 expiry = roadmap item).
- **Health Center** (`/app/health-center`, Sidebar): per-account cards,
  real Test Connection (identity lookup, not token-refresh-only), webhook
  state, SIMULATED badges, scopes honestly "not checked via API".
- **Comment-to-DM** (`/app/comment-to-dm`): rules, keyword matching
  (contains/exact/startsWith), official-API public reply + private reply,
  webhook dedupe (one reply per comment, 7-day window), dry-run, analytics.
  No scraping, no unofficial endpoints.
- **Prospecting** (`/app/prospecting`): industry/region/ICP search config,
  explainable scoring, domain/name dedupe, CSV export with formula
  neutralization. No search provider configured → searches honestly
  `BLOCKED_NO_SOURCE`; nothing invented. Manual entry + import usable.
- **Campaigns:** approval flow (request/approve, start gated); email channel
  (`process-email`) with verified-field templates, unsubscribe footer,
  accepted ≠ delivered honesty; SMS abstraction + blocked status (no
  provider); LinkedIn audit-only, messaging/connections UNSUPPORTED.
- **Import** (`/app/contacts/import`): preview/mapping/validation/dedupe/
  report; merge fill-empty-only unless overwrite explicitly listed;
  unresolved duplicates skip; INVALID rows never import.
- **Consent** (`/app/consent`): per-channel records; suppression beats stale
  opt-in; opt-out creates suppression; opt-in never removes one;
  suppressions survive re-import/merge.
- **Durable jobs:** DB-backed `BackgroundJob` (idempotency, exactly-one
  claim, backoff + jitter, dead-letter); `GET /api/jobs`,
  `POST /api/jobs/process-due`. Workflow engine's in-memory queue unchanged
  by design (documented follow-up).
- **Security:** password change/reset bump `User.tokenVersion`, invalidating
  all prior JWTs (legacy unversioned tokens accepted until next password
  change — migration leniency); CSV formula neutralization in both
  exporters; generic webhook fails closed (503) without `WEBHOOK_SECRET`;
  baseline security headers (no CSP — would break inline scripts);
  workspace cookie `secure` in production; `*.bak` now gitignored.
  NOT changed (documented): single-device logout clears cookie only;
  signup 409 oracle; no verified-email gate; X-Forwarded-For trust.
- **OSV check 2026-10-24:** 1 advisory in 134 prod packages — zod
  GHSA-mrhx-c7xc-m3w5 (memory exhaustion on oversized arrays; fixed in
  4.6.6). Deferred: zod 4 is a major upgrade, not done blind; exposure
  limited to authenticated routes.
- **Docs:** `docs/HEALTH_CENTER.md`, `docs/COMMENT_TO_DM.md`,
  `docs/IMPORT_AND_CONSENT.md`, `docs/PROSPECTING.md`,
  `docs/LINKEDIN_STATUS.md`, `docs/EMAIL_CAMPAIGNS.md`; `.env.example`
  gains SMS + SEARCH placeholders (unconfigured).
- **Still open (user-side):** WhatsApp live gate (`docs/INTEGRATIONS_STATUS.md`
  §2, Billing Hub payment method first); live provider tests BLOCKED
  (no credentials in this environment); campaign approval + email channel
  are API-complete (wizard UI not extended); scheduled triggers/delays
  still modeled-not-executed.

## v0.3.0 — 2026-10-20 (multi-account + WhatsApp verification)

Audit-driven release (`docs/RELEASE_READINESS_AUDIT.md`). Verified: 818/818
tests (85 files), tsc clean, production build 110/110 pages, Prisma valid.

- **Fixed (critical):** WhatsApp inbound webhooks were dropped by the Meta
  route's object filter (`whatsapp_business_account` unhandled) — inbound now
  routes, persists, and dispatches workflows; webhook returns 200 only after
  safe acceptance, 5xx on transient failure (redelivery is exactly-once).
- **Fixed:** freeform WhatsApp sends via the send pipeline always failed on
  real connections (missing last-inbound lookup) — adapter now receives
  conversation context + window data; eligibility still gates first.
- **WhatsApp delivery tracking:** `statuses[]` parsed; `OutboundSend.deliveryStatus`
  + message mirror, monotonic transitions; analytics distinguishes acceptance
  from delivered/read. WhatsApp remains **mock-verified only — not
  production-ready** (live gate documented in `docs/INTEGRATIONS_STATUS.md`).
- **Multi-account:** multiple accounts per provider per workspace
  (workspace+provider+externalAccountId unique), default account per channel,
  strict adapter resolution (ambiguous = error, never first-row), account
  switcher + account-scoped inbox/analytics, per-account analytics rows,
  `integrationId` stamped on conversations/sends/events/executions, workflow
  nodes can pin an account. Additive migration verified lossless.
- **Plan entitlements:** connected-account limit (Starter 3 / Growth 10 /
  Agency 50); workflow-count and seat limits now actually enforced; all three
  enforced transactionally with concurrency tests; downgrade never deletes or
  disconnects. `workflowLimit` semantics clarified = defined workflows.
- **Analytics integrity:** production metrics exclude mocked/dry-run activity
  by default; `includeTestData=1` opt-in is flagged; overview demo flag fixed.
- **Workflow versioning:** immutable snapshots on publish; executions pinned
  to the published graph (`WorkflowVersion`, `WorkflowExecution.workflowVersion`);
  `GET /api/workflows/[id]/versions`.
- **Safety:** publish API rejects cyclic graphs; executeWorkflow idempotency
  race returns duplicate instead of throwing; analytics export requires MANAGER+.
- **UX:** new Activity (error) center at `/app/activity`; billing shows
  plan-assignment source (demo/manual); Settings › Plan de-duplicated.
- **Docs:** `docs/RELEASE_READINESS_AUDIT.md`, `docs/INTEGRATIONS_STATUS.md`,
  `docs/WORKFLOW_BUILDER.md`, `docs/MULTI_ACCOUNT_MIGRATION.md`,
  `docs/TEST_REPORT_ADDITIONAL_FEATURES.md`.

## v0.1.1 — 2026-10-19 (security hardening + audit fixes)

Full engineering audit release. All changes verified: 658/658 tests (57 files),
tsc clean, production build 103/103 pages.

### Security fixes (all verified with new or existing tests)
- **JWT secret fail-closed**: `src/lib/auth.ts` — `JWT_SECRET` unset + `NODE_ENV=production`
  now throws instead of signing sessions with the publicly-known dev fallback
  (session forgery risk). Lazy resolution keeps `next build` and tests working.
- **Encryption key fail-closed**: `src/lib/crypto.ts` — `ENCRYPTION_KEY` unset +
  production now throws instead of silently using an ephemeral in-memory key
  (which would make stored credentials undecryptable after a restart).
- **ANALYST role gates (13 endpoints)**: read-only ANALYST members could mutate AI
  config (`PUT /api/ai-config`, MANAGER), knowledge base (POST/PATCH/DELETE, AGENT),
  knowledge reindex (POST, MANAGER), AI playground test (POST, AGENT), escalation
  resolve (POST, AGENT), message templates (POST/DELETE, AGENT), contact segments
  (POST/DELETE, AGENT), and suppressions (POST/DELETE, AGENT). All now carry
  `requireRole` gates; 13 new tests in `src/app/api/authz-content.test.ts`.
- **Team privilege-escalation guard**: `PATCH /api/team/[id]` — an ADMIN can no
  longer change their own role (self-promotion to OWNER) and only an OWNER can
  grant the OWNER role. 3 new tests.
- **Login timing oracle**: `POST /api/auth/login` now always runs a bcrypt
  comparison (dummy hash when the user is missing) so response time does not
  reveal email existence.
- **Signup rate limiting**: `POST /api/auth/signup` — 5 creations/hour per IP
  (429 beyond), blunting mass-creation and the 409 email-enumeration oracle.
  1 new test.

### Correctness fixes
- **`recordCustomerEventStrict` race**: check-then-insert on the
  `(workspaceId, providerEventId)` dedupe key could throw P2002 under concurrent
  duplicate webhook deliveries; now a single atomic upsert (existing row wins).
- **Build fix**: `linkOrder` helper moved from `src/app/api/ecommerce/orders/route.ts`
  to `src/lib/ecommerce/orders.ts` — Next.js route type validation rejects
  non-handler exports from `route.ts` (pre-existing since 10-17; file is
  byte-identical to v0.1.0).
- **TikTok encryption test flake**: the tamper probe replaced the last hex char
  with "0", which is a no-op ~1/16 of the time (hex case-insensitivity); now
  tampers the first ciphertext nibble deterministically (verified 0/500 no-throw).
- **Simulate test race**: `simulate.test.ts` counted GLOBAL table rows while test
  files run in parallel against one test.db; counts now scoped to the test's own
  workspace/workflow. `simulateWorkflow` itself verified write-free (reads only).
- **Analytics test pinning** (carried from the post-v0.1.0 tree fix): seed
  `createdAt` pinned to the fixed `2026-10-19T12:00:00Z` anchor so rows cannot
  fall outside the hardcoded query window after 12:00 UTC.

### Dependencies
- No dependency changes in v0.1.1. PostCSS override (`{"next":{"postcss":"8.5.30"}}`)
  from v0.1.0 retained; Next.js 15.5.28 + React 18.3.1 unchanged.
- OSV.dev audit (npm audit is blocked in this sandbox — 403 on the audit
  endpoint; documented honestly): 0 open advisories on all production
  dependencies. Two advisories on dev-only `vitest@2.1.9` (GHSA-5xrq-8626-4rwp
  9.8, GHSA-82fw-gwwq-j7x9 7.5) — both require the Vitest UI/API server to be
  network-exposed, which never happens here; not upgraded (2.x→3.x is a major
  bump that risks the test setup; revisit at next maintenance).

### Known limitations (documented, not fixed in this release)
- Sessions are stateless JWTs (7d) with no server-side revocation; password
  change does not invalidate existing tokens. Mitigation planned: per-user
  token version (needs a schema migration).
- Plan limits (`requirePlanLimit`) enforced for bulk messages only; workflow,
  seat, and retargeting-DM paths are not yet gated.
- Rate-limit maps, OAuth state nonces, and webhook dedupe sets are in-memory
  per process; multi-process production needs Redis.
- Signup 409 still reveals email existence (rate-limited to 5/hour/IP);
  full fix is email verification (feature work, out of scope).

## 2026-10-19 — analytics test time-bomb fix (post-release)

Follow-up to the v0.1.0 entry below: the 5 failures in `src/lib/analytics/queries.test.ts`
are now fixed in the working tree (this archive does not yet contain the fix).

- Root cause: the file anchors its query window to a fixed `NOW = 2026-10-19T12:00:00Z`,
  but seeded `conversation`, `campaign`, `followUp` and `retargetingCampaign` rows relied on
  the DB default `createdAt = now()`. On any run after 12:00 UTC the seeds fall outside the
  fixed window, so `conversationStats`, `campaignPerformance`, `retargetingAnalytics` and
  `channelAnalytics` return 0.
- Fix: pin `createdAt` to the fixed anchor (day −6, inside the window) on those seed rows,
  with comments explaining why. Production code untouched.
- Verification (actual outputs, 2026-10-19): `npx vitest run src/lib/analytics/queries.test.ts`
  → 18/18 pass at 14:20 UTC (past the noon cutoff that triggered the failures);
  `npx tsc --noEmit` → clean. Combined with the 13:12Z run's 636 passing tests on unchanged
  app code, the suite is 641/641.

## v0.1.0 — 2026-10-19 (PostCSS security override)

Fixes the 2 `npm audit --omit=dev` findings on the nested `next/node_modules/postcss@8.4.31`
without touching Next.js or React versions.

- Added a scoped npm override in `package.json`: `{ "next": { "postcss": "8.5.30" } }`.
  A top-level override was rejected by npm (EOVERRIDE vs the direct `postcss` devDependency),
  so the override targets only Next's dependency edge. Result: a single `postcss@8.5.30`
  deduped across the whole tree — no nested copy under `next/` remains (verified in
  `package-lock.json`, `npm ls`, and on disk).
- Why 8.5.30 is compatible with Next 15.5.28: Next.js itself moved its postcss pin from
  8.4.31 to 8.5.23 in the 16.3.x line (verified via `npm view`); postcss 8.5.x is
  semver-backward-compatible with 8.4.x for the compiler API Next uses; the rest of this
  project's tree (tailwindcss, autoprefixer, vite) already ran on 8.5.30; and the production
  build — which compiles all CSS through Next's PostCSS pipeline — passes 103/103 pages.
- Advisories resolved by moving 8.4.31 -> 8.5.30 (per OSV.dev): GHSA-6g55-p6wh-862q
  (arbitrary file read via sourceMappingURL, fixed 8.5.12), GHSA-fxqj-rqcc-2cmp
  (incomplete fix follow-up, fixed 8.5.23), GHSA-qx2v-qp2m-jg93 (XSS via `</style>`,
  fixed 8.5.10), GHSA-r28c-9q8g-f849 (path traversal in source-map loading, fixed 8.5.18).
  OSV.dev reports 0 open advisories for postcss@8.5.30.

Verification (actual outputs, 2026-10-19):
- `npm ci` — exit 0.
- `npm ls next postcss` — next@15.5.28, react 18.3.1 unchanged; single postcss@8.5.30 deduped everywhere.
- `npm audit --omit=dev` — COULD NOT RUN HERE: the sandbox registry proxy blocks the audit
  endpoint (403 policy_denied). NOT claiming zero vulnerabilities from npm audit — please
  re-run `npm audit --omit=dev` on your machine to confirm; OSV.dev shows 0 open for 8.5.30.
- `npm run typecheck` (tsc --noEmit) — clean.
- Full test suite — 636/641 passed (55/56 files). The 5 failures are all in
  `src/lib/analytics/queries.test.ts` and are PRE-EXISTING, unrelated to this change: the file
  hardcodes `NOW = 2026-10-19T12:00:00Z` for its query window but seeds conversations with
  `createdAt = now()` (real wall-clock). Any run after 12:00 UTC on 2026-10-19 seeds rows
  outside the window, so `conversationStats` returns 0. This morning's 641/641 run passed
  because it ran at ~11:06 UTC. CSS/dependency changes cannot influence Prisma datetime
  filtering. Reported separately; suggested fix is pinning `createdAt` on the seeded rows.
- `npm run build` — success, 103/103 static pages (exercises Next's PostCSS pipeline).
- Install scripts reviewed (5 packages with lifecycle scripts, all verified necessary and
  approved): @prisma/client (generates Prisma Client), @prisma/engines (query-engine binaries),
  prisma (preinstall engine setup — dev CLI for `prisma db push`), esbuild@0.28.2 via tsx and
  esbuild@0.21.5 via vitest/vite (platform binary download). No `--ignore-scripts` used —
  disabling them would break the Prisma client and esbuild binaries.

## v0.1.0 — 2026-10-19 (Next.js 15 upgrade)

Major framework bump: **Next.js 14.2.35 → 15.5.28**, closing all 23 open
advisories on next@14 (incl. unauthenticated RCE GHSA-2xp9-vwfh-vxw4 and
GHSA-p293-qw3h-jr36). Verified: 0 open advisories on next@15.5.28 via OSV.dev.

- React stays 18.3.1 (Next 15 supports it); no recharts upgrade.
- 51 API routes migrated to async `params` (`Promise<{ id }>`, awaited at use).
- `cookies()`/`headers()` awaited in `src/lib/auth.ts`, `src/lib/tenancy.ts`,
  login route, `src/i18n/server.ts` (`getLocale()` now async; 8 server
  components made async, 30 call sites updated).
- 2 client pages unwrap `params` with React `use()`.
- Full backup taken before the upgrade
  (`~/workspace/flowpilot-backup-pre-next15/` + timestamped `dev.db` copy).

Verification: `npm ci` exit 0 · tsc clean · **641/641 tests (56 files)** ·
build 103/103 pages · log-secret tripwire OK · live smoke green
(login/logout/session, tenant isolation, builder + simulation, SEO surfaces,
copilot honest 503). Lint: not configured (no eslint).

## v0.1.0 — 2026-10-19

### Inbox RBAC follow-up (later 2026-10-19)

Closed the flagged RBAC follow-up from the Phase 3 audit: inbox
`conversations` routes had tenant scoping but no role gates, so a read-only
ANALYST member could reply to customer threads via the API.

**Fixed**

- **Inbox AGENT+ gates**: `PATCH /api/conversations/[id]`
  (assignment/priority/human-takeover), `POST .../messages` (replies),
  `POST .../notes` (internal notes), and `POST .../typing` (typing presence)
  now require AGENT+ via `requireRole`. GETs stay read-only for all workspace
  members. New `src/app/api/conversations/authz-conversations.test.ts`
  (9 tests: ANALYST 403s on all four mutations, AGENT happy paths, ANALYST
  reads still 200). Full suite 641/641, build 103/103, archive rebuilt.

### Verification fixes (morning 2026-10-19)

Verification pass over the delivered archive; all findings addressed or
documented with severity.

- **Env var mismatch**: `NEXT_PUBLIC_APP_URL` (in `.env.example`) vs
  `NEXT_PUBLIC_SITE_URL` (read by SEO code) unified. Canonical variable is now
  `NEXT_PUBLIC_SITE_URL`; new shared helper `src/lib/site-url.ts` reads it with
  a fallback to the legacy `NEXT_PUBLIC_APP_URL` so existing `.env` files keep
  working. `prisma/seed.ts` uses the same helper. `.env.example` documents the
  canonical name (+3 tests).
- **AI provider docs**: `OPENAI_BASE_URL` / `AI_MODEL` were read by
  `src/lib/ai/structured.ts` but documented nowhere. Added to `.env.example`
  and a new "AI provider setup (Workflow Copilot)" section in
  `INTEGRATIONS_SETUP.md` (missing key → honest 503, never faked).
- **Safe-upgrade docs**: README now has an "Updating an existing install"
  section — back up `.env` + `prisma/dev.db` before extracting, restore after;
  documents that `npm ci` never touches the DB, `db push` is additive,
  `db:seed` skips when the demo user exists, `seed-plans` upserts.

**Verified (no change needed)**

- Copilot specs are validated server-side against the real node registry
  (`validateAndRepairSpec` — unknown types dropped with repair log); ghost
  preview with Accept/Reject; publish blocked on validation errors (422);
  simulation writes nothing (`dryRun` flag + explicit SIMULATION notes).
- AI provider: `AI_PROVIDER`/`OPENAI_API_KEY` gating, mock never used for
  copilot, 503 `AI_PROVIDER_NOT_CONFIGURED` when unset.
- DB safety: seed scripts are idempotent/non-destructive; `BACKUP_RESTORE.md`
  runbook exists.
- No server secrets in client components; log-secret tripwire passes.

### Verification results (independent, network-enabled)

- `npm ci` — exit 0
- `tsc --noEmit` — clean
- `npm test` — **632/632 pass (55 files)**
- `npm run build` — success, 103/103 pages
- Lint — **not configured** (no eslint in this project); not claimed.

### Known issues / pre-launch blockers

- **CRITICAL**: next@14.2.35 has 23 open advisories (incl. unauthenticated RCE
  on Windows-hosted servers — relevant for Windows deployments). Fixes require
  a major bump to Next.js 15.x/16.x. Deferred: needs a dedicated upgrade
  workstream with full re-verification. See `NPM_AUDIT_2026-10-19.md`.
- Core Web Vitals unmeasured here (no Lighthouse); targets in `PERF_AUDIT.md`.
- `NEXT_PUBLIC_SITE_URL` still defaults to the `https://flowpilot.ai`
  placeholder for SEO canonicals until set to the real origin.
- Pre-existing TikTok test flake (~1/16 runs).
