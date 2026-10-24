# Provider Audit — FlowPilot AI Integrations

Audited 2026-10-18 against the codebase at `~/workspace/flowpilot`.
**Nothing below is live-tested**: no provider credentials exist in this
environment, so no real OAuth, token, or API call has ever been made from
here. "Tested" means verified with mocked-HTTP unit/route tests unless
stated otherwise.

Conventions used per provider:
- **OAuth callback**: real = implements the provider's documented OAuth flow;
  simulated = generic mock handshake; none = no OAuth at all.
- **Status logic**: how CONNECTED / NEEDS_ATTENTION / EXPIRED /
  DISCONNECTED are reached. CONNECTED is only ever written after a
  verification handshake succeeds — never on callback-reached alone.

---

## Phase 4 audit round — 2026-10-19 (Integrations Audit workstream)

**Nothing below is live-tested.** No provider credentials exist in this
environment, so no real OAuth, token, or API call has ever been made from
here. "Verified" means: code-read against the provider's documented API +
mocked-HTTP unit/route tests (all labeled). Real OAuth end-to-end needs
JOE's app credentials + manual login — see the E2E checklist at the end.

### Checklist re-verification (all 12 providers, code-read 2026-10-19)

| Check | Result |
|---|---|
| OAuth flow (real: instagram/facebook/whatsapp Meta, tiktok Login Kit) | ✅ implemented; simulated providers bypass to mock handshake with SIMULATED badge |
| Callback URL + state validation | ✅ HMAC-SHA256 signed state, workspace+provider bound, 15-min expiry, **single-use nonces** (replay of a captured callback URL → `invalid_state`) |
| Scopes | ✅ IG Business Login: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`; FB: `pages_messaging`, `pages_show_list`, `pages_read_engagement`; WA: `whatsapp_business_messaging`, `whatsapp_business_management`; TikTok: `user.info.basic` |
| Token storage + refresh/reauth | ✅ AES-256-GCM (`src/lib/crypto.ts`) at rest; Meta long-lived refresh within 7d of expiry; IG Business Login via `ig_refresh_token`; TikTok refresh within 1h; error 190 → NEEDS_ATTENTION |
| Account/asset selection | ✅ FB/legacy-IG Page picker (`meta/select`); IG Business Login connects the Professional account directly; WhatsApp manual-token path verifies via phone-number lookup |
| Webhook subscription + HMAC | ✅ per-account `subscribed_apps` (messages, comments) best-effort at IG connect; GET challenge handshake; `X-Hub-Signature-256` HMAC verified with timingSafeEqual, bad signature → 401 |
| Event parsing/normalization | ✅ `ingest.ts`: messaging[], WhatsApp `value.messages[]`, feed comments → contacts/conversations/messages + CustomerEvent log |
| Duplicate-event protection | ✅ entry-level `seenDeliveryIds` + per-message `mid:`/`wamid:`/`comment:` dedupe + CustomerEvent idempotency on (workspaceId, providerEventId) + DB unique constraint |
| API version | ✅ Graph v21.0 (`GRAPH_VERSION`, overridable via `META_GRAPH_VERSION`) |
| Messaging eligibility | ✅ 24h window enforced (WhatsApp adapter + `src/lib/messaging/eligibility.ts`); comment private-reply 1-per-comment/7-day recorded |
| Error handling + rate limits | ✅ typed errors (MetaApiError/TokenExpired/Retryable, TikTok equivalents), 20s timeouts, 429 → honest 429 (transient, never flips the connection state) |
| Disconnect/revoke | ✅ best-effort provider-side revoke (TikTok `/oauth/revoke/`, Meta `/{id}/permissions` DELETE, IG `/{ig-id}/permissions` DELETE on graph.instagram.com) BEFORE local wipe; revocation failure never blocks local disconnect |

### Hardened this round

1. **8-state connection model** (`src/lib/integrations/connection-state.ts`):
   `not_connected` / `connecting` / `connected` / `partial` /
   `permission_missing` / `reauth_required` / `unavailable` / `failed`.
   "connected" (green) is returned ONLY when the row is CONNECTED, the
   stored credentials decrypt, the expected asset ids are present
   (pageId / igUserId / phoneNumberId / openId), `verifiedAt` is set, and no
   failure detail contradicts it. Corrupted credentials → `failed`; missing
   asset ids or no verification → `partial`.
2. **Failure persistence**: new `Integration.statusDetail` column (JSON
   `{code,message,at}`, never tokens/secrets). Test/verify/callback routes
   record `token_expired` / `permission_missing` (Meta codes 10/200/298) /
   `callback_failed` / `test_failed` / `verify_failed`; cleared on the next
   success; cleared on disconnect. A failed *reconnect* never downgrades a
   still-valid CONNECTED row.
3. **Capability matrix** (`src/lib/integrations/capabilities.ts`): 12
   providers × 8 capabilities (read events, receive comments, send messages,
   publish media, manage conversations, retrieve analytics, manage ads,
   audience/conversion data). Each cell carries a platform-truth level plus
   an honest note (e.g. "WhatsApp: no history API", "TikTok Login Kit:
   identity only — no DM-sending API", "Instagram sends: 24h window",
   "Meta ads: Marketing API not implemented"). Resolution: `available` /
   `limited` only when actually connected; `simulated` only when the mock
   handshake completed; otherwise `not_connected`; platform gaps always
   `unavailable`. Served by `GET /api/integrations` as `capabilitiesDetail`
   and rendered per card with state icons + hover notes.
4. **Honest 429s**: Meta/TikTok rate limits now return HTTP 429 with
   "retry shortly" wording and do NOT persist a failure state.
5. **i18n**: `src/i18n/fragments/integrations.ts` (`en` + `ar`) for the new
   state labels, capability labels, and hints; the integrations page reads
   the `fp_locale` cookie.
6. **Tests added (mocked HTTP, 54 new)**: `capabilities.test.ts` (10),
   `connection-state.test.ts` (21), `webhooks/meta/route.audit.test.ts`
   (10: verify challenge, HMAC good/bad, malformed JSON, non-Meta object,
   duplicate delivery → single message), `integrations/audit.test.ts` (13:
   OAuth replay rejection, tampered-state CSRF, cross-workspace state
   rejection, token expiry → reauth_required, permission revocation (code
   200) → permission_missing, 429 handling, cross-workspace 404, TikTok
   disconnect-revoke + reconnect, 8-state/capability matrix shape, corrupted
   credentials → failed).

### Per-provider notes (this round)

- **instagram**: Business Login flow is the connect path; legacy
  Page-linked rows still verify via the Page token. Card now shows
  per-capability states (sends = limited/24h window; ads/analytics =
  unavailable, honestly labeled).
- **facebook**: Page picker unchanged; permission-revocation test proves a
  code-200 revocation flips the card to `permission_missing` instead of
  leaving a stale green.
- **whatsapp**: 24h window + template enforcement unchanged; token expiry
  test proves the card flips to `reauth_required` with capabilities back to
  `not_connected`.
- **tiktok**: Login Kit identity-only confirmed again — all 8 capabilities
  resolve `unavailable` when connected; disconnect revokes via
  `/v2/oauth/revoke/` then reconnect re-runs the full callback (tested).
- **telegram / youtube / linkedin / x / email / webchat / sheets / zapier**:
  unchanged — simulated mock handshake, SIMULATED badge, capabilities
  resolve `simulated` only while the mock connection is up, `not_connected`
  otherwise, `unavailable` where the platform lacks the capability.

### Known limits (unchanged, restated)

- No Prisma migrations — schema pushed; webhook dedupe in-memory
  (documented: move to Redis for multi-process production).
- WhatsApp: no history API exists — history accumulates via webhooks only.
- Paid ads: Meta Marketing API not implemented (Retargeting Center ships a
  checklist + CSV export only — never faked).
- Email: no delivery provider configured — sends are simulated.
- `access_token` in query string on Meta GETs (LOW, documented).

---

## E2E checklist for JOE (non-destructive, test accounts only)

Run these against your own Meta/TikTok apps with **test accounts** — nothing
here sends to real customers. Do them in order; each is independent.

### Meta (Instagram / Facebook / WhatsApp)
1. **Env**: set `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`,
   `APP_PUBLIC_URL` (+ `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` from the
   Instagram product's Business Login settings — NOT the Facebook App ID),
   restart dev, hard-refresh the integrations page.
2. **Unavailable → not connected**: with env set, each Meta card badge
   should read "Not connected" (not "Unavailable").
3. **Instagram Business Login**: Connect → authorize with a test IG
   Professional account → expect redirect `?meta_connected=instagram` and a
   green "Connected" card with the real username/avatar. Card capabilities:
   send messages = Limited (24h window), manage ads = Unavailable.
4. **Deny once**: restart the flow and click "Cancel" on Meta's screen →
   expect `?meta_error=…` and the card showing "Connection failed" (not
   green).
5. **Facebook Page flow**: Connect → after OAuth expect the Page picker
   modal; pick the test Page → "Connected". Cards for unlinked rows stay
   "Not connected".
6. **WhatsApp manual token**: paste Phone Number ID + token from
   WhatsApp → API Setup → "Save & verify" → expect the verified display
   name. A bad token must fail with the server's message (never "Connected").
7. **Webhooks**: in the app dashboard set the Callback URL to
   `https://<your-public-url>/api/webhooks/meta` with your verify token;
   subscribe Instagram → messages, comments. Send a test DM/comment from the
   test account → it must appear in the inbox within seconds.
8. **Duplicate delivery**: Meta retries webhooks — send one message and
   confirm only ONE inbox message is created (dedupe verified in tests, but
   confirm on the wire once).
9. **Test connection**: with a valid connection → "Token valid — no message
   sent". Revoke the app's permission at facebook.com/settings (or remove a
   permission in the app dashboard) → Test → expect the card to flip to
   "Permission missing" (not green).
10. **Disconnect**: Disconnect → provider token revoked best-effort;
    reconnect → full flow works again.

### TikTok
11. **Env**: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, redirect URI
    `https://<your-public-url>/api/integrations/tiktok/callback` whitelisted
    in the TikTok app (Login Kit enabled).
12. **Connect**: Connect with TikTok → authorize → expect
    `?tiktok_connected=1`, green "Connected", real display name + avatar.
    All capabilities read "Unavailable" (identity only — by design).
13. **Test**: "Token valid — account identity verified, nothing sent".
14. **Disconnect/reconnect**: Disconnect → reconnect completes cleanly.

### Simulated providers
15. **Telegram/X/etc.**: Connect → "SIMULATED" badge; capabilities show
    "Simulated" only while the mock connection is up; Test reports
    "(mock)". Nothing here touches a real API — that is the honest state
    until real OAuth is implemented per provider.

If any step shows green "Connected" where the provider actually failed,
that is a bug — report which step and the card's "Connection issue" line.

---

## instagram — Instagram Messaging (Meta, Business Login flow)

- **OAuth callback**: REAL. `POST /api/integrations/meta/authorize`
  (signed state, HMAC-SHA256, 15-min expiry) →
  `GET /api/integrations/meta/callback` (state validation → Instagram code
  exchange → long-lived token → IG identity check → webhook subscription).
  CONNECTED directly after identity verification — no Page-selection step.
  Legacy Facebook-Login (Page-linked) connections keep working via the
  `loginType` credential flag.
- **Scopes**: `instagram_business_basic`, `instagram_business_manage_messages`,
  `instagram_business_manage_comments` (Instagram Business Login; the old
  `instagram_basic` / `instagram_manage_*` values were deprecated by Meta on
  2025-01-27, which is why the previous Facebook-Login scopes were rejected).
- **Endpoints**: authorize `https://www.instagram.com/oauth/authorize`;
  token exchange `POST https://api.instagram.com/oauth/access_token`;
  long-lived `GET https://graph.instagram.com/access_token`
  (`grant_type=ig_exchange_token`); refresh `GET
  https://graph.instagram.com/refresh_access_token`
  (`grant_type=ig_refresh_token`); Graph API `https://graph.instagram.com/{version}`.
- **Token handling**: AES-256-GCM encrypted `MetaCredentials`
  (`accessToken`, `expiresAt`, `loginType: "instagram_login"`, `igUserId`,
  `igUsername`). `getValidAccessToken()` refreshes via `ig_refresh_token`
  near expiry; error 190 → status NEEDS_ATTENTION.
- **Identity endpoint**: `GET https://graph.instagram.com/{version}/me`
  (IG Professional account directly). Stored as `accountName` + `accountAvatarUrl`.
- **Webhooks**: per-account `POST /{ig-user-id}/subscribed_apps`
  (`subscribed_fields=messages,comments`) at connect time (best-effort);
  inbound delivery via the shared `/api/webhooks/meta` endpoint (`object:
  "instagram"`, HMAC-verified).
- **Status logic**: CONNECTED after callback identity verification;
  NEEDS_ATTENTION on 190/token expiry; DISCONNECTED clears credentials + identity.
- **Tested**: YES (mocked-HTTP): 290-test suite includes Business Login
  authorize URL, token exchange (+ OAuthException shape), long-lived/refresh,
  identity, webhook subscription, adapter send/verify branching, and callback
  success/failure. NOT live-tested (no META_*/INSTAGRAM_* credentials).

## facebook — Facebook Messenger (Meta, Facebook Login flow)

- **OAuth callback**: REAL. Same authorize/callback routes as Instagram
  (provider=`facebook`), then `meta/select` for Page binding.
- **Scopes**: `pages_messaging`, `pages_show_list`, `pages_read_engagement`
  — all required (send/receive, Page listing, Page metadata).
- **Token handling**: same as Instagram (Page access token stored).
- **Identity endpoint**: Page `name` via `getPageToken`; stored as
  `accountName`.
- **Status logic**: same as Instagram.
- **Tested**: YES (mocked-HTTP, same suite). NOT live-tested.

## whatsapp — WhatsApp Business Platform (Meta)

- **OAuth callback**: REAL (same Meta authorize/callback; provider=
  `whatsapp`), PLUS a manual-token path
  `POST /api/integrations/meta/whatsapp/manual` (token verified server-side
  via phone-number lookup before CONNECTED).
- **Scopes**: `whatsapp_business_messaging`, `whatsapp_business_management`.
- **Token handling**: encrypted `MetaCredentials` with `phoneNumberId`,
  `phoneDisplayName`, `wabaId`. 24h customer-service window enforced in the
  send path (free-form outside window → 422 unless template given).
- **Identity endpoint**: `/{phone-number-id}` (display_phone_number);
  stored as `accountName`.
- **Status logic**: CONNECTED after verification; NEEDS_ATTENTION on 190.
- **Tested**: YES (mocked-HTTP). NOT live-tested.

## tiktok — TikTok (Login Kit)

- **OAuth callback**: REAL (implemented 2026-10-18).
  `POST /api/integrations/tiktok/authorize` → signed state →
  `https://www.tiktok.com/v2/auth/authorize/` (scope `user.info.basic`) →
  `GET /api/integrations/tiktok/callback`: handles `error` (denied),
  validates state (workspace-bound, 15-min), exchanges code at
  `https://open.tiktokapis.com/v2/oauth/token/`, fetches identity from
  `https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username`,
  persists AES-256-GCM encrypted credentials + identity, marks CONNECTED
  **only after token exchange + identity + persistence all succeed**.
  Any failure → `/app/integrations?tiktok_error=…` (safe message, no secrets).
- **Scopes**: `user.info.basic` only (identity — TikTok exposes no general
  DM-sending API; the catalog no longer claims messaging capabilities).
- **Token handling**: encrypted `TikTokCredentials`
  (`accessToken`, `refreshToken`, `expiresAt`, `openId`).
  `getValidTikTokToken()` refreshes within 1h of expiry; refresh failure →
  NEEDS_ATTENTION ("Token expired — please reconnect").
- **Identity endpoint**: documented `user/info` API above; stored as
  `accountName` (display_name || username) + `accountAvatarUrl`. When the
  API returns no usable identity, the card shows "Connected, account
  details unavailable" — never a guessed or placeholder account.
- **Status logic**: NEEDS_ATTENTION ("Connecting…") at authorize;
  CONNECTED after callback persistence; NEEDS_ATTENTION on expired token
  (test/verify routes); DISCONNECTED clears credentials + identity.
  Test Connection = authenticated `user/info` call (nothing sent).
- **Tested**: YES (mocked-HTTP): 26 new tests — authorize URL shape,
  state round-trip/tamper/expiry, denied/invalid-state/exchange-failure/
  persistence-failure redirects (never connected), identity mapping,
  refresh logic, expired-token → NEEDS_ATTENTION. NOT live-tested
  (no TIKTOK_* credentials).

## telegram / youtube / linkedin / x / email / webchat / sheets / zapier

- **OAuth callback**: NONE (generic catalog entries). `POST
  /api/integrations/[id]/connect` runs the simulated mock handshake and
  records NEEDS_ATTENTION — it does NOT verify and does NOT mark CONNECTED.
  `POST /api/integrations/[id]/verify` uses the mock adapter.
- **Scopes/permissions**: as listed in the catalog (`requiredPermissions`);
  no OAuth implemented for any of these.
- **Token handling**: an opaque encrypted mock marker only — no real
  credentials.
- **Identity endpoint**: none.
- **Status logic**: NEEDS_ATTENTION after mock connect; CONNECTED only if
  mock verify passes (clearly labeled mock in the UI test output).
- **Tested**: mock-adapter unit behavior only. No OAuth to test.

## Notes

- Instagram Login scopes (`instagram_business_*`) and Facebook Login
  scopes are kept separate per provider flow — never mixed.
- The recently corrected Instagram scopes (`instagram_manage_messages`,
  `instagram_manage_comments`, `pages_show_list`) and the Meta callback
  route were preserved untouched by this change.
- Webhook signature verification exists for Meta (HMAC-SHA256); TikTok
  Login Kit has no webhook surface in this integration.
