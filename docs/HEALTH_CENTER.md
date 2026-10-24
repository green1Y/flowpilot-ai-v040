# Health Center (Wave 2A)

Per-account connection health, served by `GET /api/integrations/accounts`
(one row per Integration — not the per-provider list route, which collapses
multi-account workspaces to one card per provider) and rendered at
`/app/health-center` (navigation wiring is separate; the Sidebar is
untouched by this wave).

## Probes (`src/lib/integrations/health.ts` — `runHealthProbes`)

Run in order, each attempted even if an earlier one failed, so a token
failure never masks webhook state. One `HealthCheck` row is written per
probe. `detail` is sanitized JSON only (ids, usernames, booleans, reasons)
— never tokens, secrets, or credential material.

| Probe | What it does | Statuses |
|---|---|---|
| `token` | Refresh-or-valid via `getValidAccessToken` / `getValidTikTokToken`. Refreshed credentials are persisted re-encrypted, so later calls use the live token. | OK / FAILED (`token_expired`) / DEGRADED (rate limit / timeout) |
| `identity` | Page / phone-number / IG-user / TikTok-user lookup using the same primitives as the verify route. Proves the asset exists at the provider. | OK / FAILED (`token_expired`, `permission_missing`, `no_page_id`, …) / DEGRADED |
| `webhook` | Subscription-state READ where the API offers one: Instagram Business Login only, via `GET subscribed_apps`. Every other real provider has no readable subscription state, so the probe is BLOCKED with a reason (dashboard-side subscription is manual) — never a faked pass. | OK / DEGRADED (no apps returned) / FAILED / BLOCKED |

Simulated providers (everything outside Meta + TikTok real OAuth) return
`SIMULATED` for every probe — never a fake live pass.

## States shown on a card

- **Connection state badge**: the 8-state model (`connected`, `partial`,
  `permission_missing`, `reauth_required`, `failed`, `not_connected`,
  `connecting`, `unavailable`) resolved from the row + failure detail +
  env configuration.
- **SIMULATED badge**: shown whenever the provider has no real OAuth/API
  integration; the mock stands in.
- **Account identity**: persisted `accountName` / `externalAccountId`,
  falling back to best-effort decryption of stored credentials (never
  shown in full, never credentials).
- **Required vs granted scopes**: the card lists `requiredPermissions`
  from the catalog. Granted scopes are labeled **"not checked via API"** —
  no scopes read is implemented anywhere in this codebase, so the UI must
  not imply the required list is granted.
- **Last Test/Verify result + timestamp**: `verifiedAt` (set only after a
  real verification handshake), the persisted `statusDetail` message, and
  `lastSyncAt`. Test results themselves are not stored as rows — the card
  shows the live result of the Test button just pressed, plus these
  persisted timestamps.
- **Webhook subscription state**: `webhookSubscribedAt` +
  `webhookSubscriptionDetail` (`{ fields, checkedAt }`), or "Never
  confirmed via API" when null. Null means *unconfirmed*, not *broken* —
  for facebook/whatsapp it is expected (see below).
- **Last error**: `lastError` + `lastErrorAt`, when any.

## What Test Connection proves — and what it doesn't

The upgraded test route (`POST /api/integrations/[id]/test`, MANAGER+)
refreshes the token when inside the refresh window AND performs the
identity check (IG-user / phone-number / page lookup). A pass therefore
proves: the token is currently usable **and the provider asset exists**.
It does not prove:

- that webhooks are subscribed (see webhook probe; dashboard-side for
  facebook/whatsapp),
- that granted scopes cover the required list (not checked via API),
- that a message will deliver (nothing is sent — the test never sends),
- that the 24h messaging window is open for any particular contact.

Simulated providers return `mocked: true` with a `SIMULATED` note and no
live provider check.

## Resubscribe (`POST /api/integrations/[id]/resubscribe-webhooks`, MANAGER+)

- Instagram Business Login: re-subscribes `messages` + `comments` via
  `POST subscribed_apps` and persists `webhookSubscribedAt` +
  `webhookSubscriptionDetail` on success.
- Facebook / WhatsApp (and legacy Page-linked Instagram): returns an
  honest BLOCKED response (`{ ok: false, blocked: true, reason }`, HTTP
  200) explaining that subscription is managed in the Meta app dashboard.
  Nothing is written for blocked rows — no timestamp is faked.

## WhatsApp OAuth limitation

WhatsApp connects via **manual token only** (WABA + phone number ID +
bearer token, validated live by the server). The Meta OAuth completion
step (`/api/integrations/meta/select`) accepts only `instagram` |
`facebook`, so there is no WhatsApp OAuth completion path — the
Integrations page copy now says so instead of promising one.

## Roadmap: Graph API v21.0 expiry

The codebase pins `META_GRAPH_VERSION` (default `v21.0`, overridable via
env). Meta has announced Graph v21.0 expiry on **January 21, 2027**.
This wave deliberately does NOT change `META_GRAPH_VERSION` — bumping it
is a separate, provider-verified migration (re-run verify/test against
every connected account on the new version, confirm no breaking field
changes for the endpoints used: `/me`, page verify, phone-number info,
IG-user lookup, subscribed_apps, conversations/messages). Track it as a
roadmap item well before that date; do not let the version drift past
expiry unnoticed.

## Email / Resend panel

The Health Center's email panel reads `GET /api/email/health` (wave 2E,
MANAGER+): Resend configuration + domain-list reachability, no sends.
When the endpoint is absent it shows "email probe pending"; when the
viewer lacks the MANAGER+ gate it says so explicitly. The panel never
claims delivery or open tracking — the probe covers configuration and
reachability only.

## Live-check status

No Meta/TikTok credentials exist in this environment, so all provider
behavior in this wave is verified with stubbed-fetch / MockTransport-style
tests only (labeled as such in each test file). Live firing still
requires a real Meta app + public HTTPS deploy and remains unverified
from here.
