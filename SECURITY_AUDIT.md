# FlowPilot AI — Production-Readiness & Security Audit (2026-10-18)

Focused audit of authentication, connection integrity, webhooks, and
operational reliability. The TikTok OAuth implementation was in progress
during this audit; TikTok-specific code paths are noted but not re-audited
here.

Legend: ✅ verified good · ⚠️ finding (fix proposed) · ℹ️ note

## A. Authentication and token security

- ✅ **OAuth state validation (Meta + TikTok):** HMAC-SHA256 signature with
  timing-safe compare, 15-minute expiry, workspace+provider+nonce binding,
  and callback verifies `ctx.workspaceId === state.workspaceId` (403 on
  mismatch). Denied authorizations and missing/invalid state redirect to a
  safe error page — never a 500, never tokens in the URL.
- ✅ **FIXED 2026-10-18 — OAuth state is now single-use.** `verifyState`
  (meta.ts) and `verifyTikTokState` (tiktok.ts) now consume the nonce after
  signature + expiry checks and throw `Invalid OAuth state: already used
  (possible replay)` on reuse. Nonces are tracked in-memory with lazy TTL
  pruning (15 min, matching the state window). Instagram Business Login
  reuses meta.ts's `verifyState`, so all three real OAuth flows are covered.
  Regression tests: replay rejection in `meta.test.ts` / `tiktok.test.ts`.
- ℹ️ **PKCE:** not applicable — both Meta and TikTok web flows use the
  confidential-client pattern (`client_secret` server-side). No action.
- ✅ **Encryption at rest:** AES-256-GCM via `src/lib/crypto.ts`;
  `ENCRYPTION_KEY` must be 32-byte hex. Dev fallback uses an ephemeral key
  with a loud console warning (documented; production must set the key).
  Decrypt failures are handled ("reconnect" messaging, never crash).
- ✅ **No secret exposure:** grepped all integration/messaging code and API
  routes — no access tokens, refresh tokens, client secrets, or codes in
  logs, client responses, URLs (post-exchange), or error messages. The
  TikTok callback must preserve this (in progress).
- ⚠️ **LOW — access token in query string.** `graph()` sends
  `?access_token=` on GETs (Meta's documented pattern, but URLs can leak
  into proxy/CDN logs). Prefer `Authorization: Bearer` where the endpoint
  allows it.
- ✅ **Tenant isolation:** every integration route uses `requireWorkspace`
  (membership-verified, 403 without membership) and scopes all queries by
  `workspaceId`. Webhook routes are intentionally unauthenticated —
  HMAC-SHA256 signature verification is the auth mechanism there.
- ✅ **FIXED 2026-10-18 — login rate limiting.** `POST /api/auth/login`
  now enforces an in-memory per-IP+email budget (`src/lib/rate-limit.ts`):
  10 failed attempts per 10-minute sliding window, then HTTP 429. The
  budget counts failures only and is cleared on a successful login, so
  legitimate users are not penalized. Unit tests in
  `src/lib/rate-limit.test.ts` cover budget enforcement, per-key
  independence, and success clearing.
- ✅ **Cookies:** `httpOnly`, `secure` in production, `sameSite: lax`,
  bounded `maxAge`. Good.

## B. Connection integrity

- ✅ **No premature Connected:** Meta callback marks `NEEDS_ATTENTION`
  until Page selection + verification succeed; only then `CONNECTED`.
  Token exchange or persistence failure → error redirect, never Connected.
  (TikTok callback held to the same bar per its build brief.)
- ✅ **Server-side status:** UI re-reads integrations after every action;
  states are `DISCONNECTED` / `NEEDS_ATTENTION` (connecting) /
  `CONNECTED` / `NEEDS_ATTENTION` (expired, "Reauthorization required").
- ✅ **Expired tokens:** error 190 → `NEEDS_ATTENTION`; test/verify
  surfaces "Token expired — please reconnect" (401/422, no stack).
- ✅ **FIXED 2026-10-18 — disconnect revokes at the provider.**
  `POST /api/integrations/[id]/disconnect` now best-effort revokes the
  stored token before wiping local credentials: TikTok
  `POST /v2/oauth/revoke/`, Facebook `DELETE /{user-id}/permissions`,
  Instagram Business Login `DELETE /{ig-user-id}/permissions` on
  `graph.instagram.com`, legacy Instagram `DELETE /{page-id}/permissions`.
  WhatsApp (manual bearer token, no user-scoped revoke endpoint) skips
  provider revocation. Revocation is wrapped in try/catch — a failure never
  blocks the local disconnect. Route tests in
  `src/app/api/integrations/disconnect.test.ts` prove the revoke call is
  attempted and that local cleanup proceeds even when it fails.
- ✅ **No fake live claims:** mock adapter returns `mocked: true`;
  nothing reports live connectivity from unit tests.

## C. Webhooks and automation reliability

- ✅ **Meta webhook:** verification challenge + HMAC-SHA256 (timing-safe)
  + replay/delivery-ID dedupe + message-MID dedupe. Never 500s to Meta.
- ✅ **Idempotency:** execution idempotency keys, per-recipient campaign
  idempotency, follow-up idempotency keys — duplicate sends prevented.
- ✅ **Retries:** queue uses exponential backoff + dead-letter after max
  attempts; campaign engine retries only transient errors; 190s are not
  retried.
- ✅ **FIXED 2026-10-18 — HTTP timeouts on provider API calls.** `graph()`
  (meta.ts), `igFetch` (instagram-login.ts — backs every Instagram
  Business Login call including `igGraph`, token exchange/refresh, and
  webhook subscription), and TikTok's `postForm` / `getTikTokUserInfo`
  now send `AbortSignal.timeout(20_000)`. Timeouts map to retryable typed
  errors (`MetaRetryableError`, or `TikTokApiError` with `retryable: true`)
  so the existing backoff/dead-letter paths handle them. Regression tests
  in `meta.test.ts` / `instagram-login.test.ts` / `tiktok.test.ts` prove the
  mapping and that a timeout signal is actually attached to the request.
- ✅ **Policy enforcement:** 24h messaging windows, WhatsApp template
  enforcement, IG 7-day/one-per-comment private-reply rules, eligibility
  re-checked at send time.

## D. Data and operational reliability

- ✅ **DB constraints:** `Integration` has unique `(workspaceId, provider)`;
  all writes go through upserts keyed on it. Token updates are
  read-modify-write on the owned row (workspace-scoped `findFirst`).
- ✅ **Error hygiene:** API errors are actionable (`err(message, status)`)
  without secrets; audit trail covers connect/disconnect/verify/test/
  authorize/failures (`integration.*` events, TikTok events added).
- ✅ **Input validation:** zod schemas on OAuth/body inputs
  (`metaAuthorizeSchema`, etc.).
- ℹ️ **Larger items (not implemented here):** Prisma migrations for
  production (dev uses `db push`); Redis-backed dedupe/rate-limiting for
  multi-server deployments (the in-memory nonce store and login limiter
  are single-server by design, documented in code).

## E. Verification

- New: `src/app/api/integrations/security.test.ts` — cross-workspace
  authorization tests for list/disconnect/test routes (see below).
- New 2026-10-18: the four MEDIUM findings above were implemented and are
  covered by focused regression tests:
  `src/lib/integrations/meta.test.ts` (state replay, graph timeout),
  `src/lib/integrations/tiktok.test.ts` (state replay, exchange/userinfo
  timeout), `src/lib/integrations/instagram-login.test.ts` (igFetch
  timeout), `src/lib/rate-limit.test.ts` (budget, key independence,
  success clear), `src/app/api/integrations/disconnect.test.ts` (revoke
  attempted; local cleanup on revoke failure).
- `npm run typecheck` clean; full suite green: **306/306 tests**
  (29 files) as of 2026-10-18.
- **What was NOT live-tested:** no Meta/TikTok credentials exist here —
  all provider tests use mocked HTTP. No live OAuth, Graph, or TikTok API
  calls were made. Nothing in this audit claims live provider behavior.
- `.env` untouched; archives exclude `.env`; no secret values printed
  anywhere in this report or the test output.
