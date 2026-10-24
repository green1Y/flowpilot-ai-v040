# Meta Integrations Setup — Instagram, Facebook Messenger & WhatsApp

This guide covers connecting FlowPilot AI to Meta's platforms: Instagram messaging,
Facebook Page messaging (Messenger), and the WhatsApp Business Cloud API.

> **No secrets here.** All real values live in your own `.env` file (never committed).
> See `.env.example` for the full list of Meta-related variables.

---

## 1. Create the Meta app

1. Go to **https://developers.facebook.com/apps** and sign in with a Meta developer account.
2. Click **Create App**.
3. Select the **Business** app type.
4. Enter an app name (e.g. "FlowPilot") and your Business Manager account, then create.
5. Open the app dashboard and copy your **App ID** and **App Secret** into `.env`:
   - `META_APP_ID="..."`
   - `META_APP_SECRET="..."`

## 2. Add products to the app

In the app dashboard, add each product you plan to use:

| Product    | Used for                                  |
|------------|-------------------------------------------|
| Messenger  | Facebook Page messaging (chats on your Page) |
| Instagram  | Messaging on an Instagram Professional account |
| WhatsApp   | WhatsApp Business Cloud API               |

Go to **Add Product** for each, then open its settings page in the dashboard.

## 3. Permissions to request & review notes

Request these permissions in **App Review → Permissions and Features**, per product:

- **Messenger (Facebook):** `pages_messaging`, `pages_show_list`, `pages_read_engagement`
- **Instagram (Business Login):** `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`
- **WhatsApp:** `whatsapp_business_messaging`, `whatsapp_business_management`

Notes:

- In **development mode**, the app can access data for users with a role on the app
  (admin/developer/tester) or for registered **test users** — no review needed.
- Permissions granted beyond the default set may require **Advanced Access**, which
  needs **App Review**: submit a review request describing your use case (automated
  customer messaging via FlowPilot), a screencast of the login/connection flow, and
  your privacy policy URL. Expect a few business days for approval.
- **If Meta's OAuth dialog shows "Invalid Scopes"**: the scope names above are
  valid — the cause is app state, not the names. Fix: (1) keep the app in
  **Development mode** while testing (Live-mode apps reject any permission that
  hasn't passed App Review); (2) add each permission under **App Review →
  Permissions and Features**; (3) make sure the person connecting has a role on
  the app (admin/developer/tester) or is a registered test user. Do not "fix"
  this by deleting scopes from the app code — that only removes features.

## 4. Webhook setup

Meta delivers incoming messages and events to a webhook on your server.

1. In the app dashboard, go to the product's **Webhooks** (or **Configuration**) page.
2. Set **Callback URL** to:
   ```
   {APP_PUBLIC_URL}/api/webhooks/meta
   ```
   where `{APP_PUBLIC_URL}` is your public base URL (e.g. `https://flowpilot.example.com`).
   Set `APP_PUBLIC_URL` in `.env` to the same value.
3. Set **Verify Token** to the exact value of your `META_VERIFY_TOKEN`
   (a random string **you** invent — generate one, e.g. `openssl rand -hex 16`).
4. Click **Verify and Save**. Meta sends a GET request with `hub.mode`,
   `hub.verify_token`, and `hub.challenge`; the endpoint replies with the
   `hub.challenge` value **only when the verify token matches**. A mismatch
   means the token in the dashboard doesn't equal `META_VERIFY_TOKEN`.
5. Subscribe to these fields:
   - `messages` — incoming DMs / Messenger messages
   - `messaging_postbacks` — button/postback clicks
   - `messaging_referrals` — referral parameters (e.g. m.me links)
   - `feed` — Page/Instagram comments (for comment handling)

The webhook endpoint is implemented in FlowPilot; this step only registers it with Meta.

## 5. Test users & development mode

- While the app is in **development mode**, only app-role users and test users can
  authenticate and receive webhooks. Create test users under **Roles → Test Users**.
- Flip the app to **Live** (top toggle in the dashboard) only after App Review
  approval for the permissions you need.

## 6. Token expiry

- **User access tokens** from OAuth are **short-lived** (~1–2 hours). Exchange them
  for **long-lived tokens** (~60 days) via the Graph API token exchange endpoint,
  then refresh before expiry (re-exchange) to keep the connection alive.
- **Page access tokens** obtained from a long-lived user token **do not expire** —
  they remain valid as long as the underlying user grant isn't revoked.
- If a token stops working with an OAuth error, use the **Reconnect** flow in
  FlowPilot (re-run OAuth) rather than editing tokens by hand.

## 7. Local development HTTPS

Meta requires the webhook Callback URL and OAuth redirect URI to be **public HTTPS**.

- Locally, expose your dev server with a tunnel, e.g.:
  ```bash
  ngrok http 3000
  ```
  then set `APP_PUBLIC_URL` to the `https://…ngrok…` URL it prints.
- Alternatively, deploy the app to a host with HTTPS and use that URL.
- **Set `APP_PUBLIC_URL` to the public URL *before* starting OAuth**, because the
  redirect URI is built from it and must match what's registered in Meta's
  "Valid OAuth Redirect URIs" settings.

## 8. WhatsApp — two connection paths

### Path A: OAuth (Business)

Use the standard FlowPilot **Connect → WhatsApp** OAuth flow. You grant the
`whatsapp_business_messaging` / `whatsapp_business_management` permissions and
pick the WhatsApp Business Account (WABA) and phone number.

### Path B: Manual long-lived token + Phone Number ID

1. In the Meta app dashboard, go to **WhatsApp → API Setup**.
2. Copy the **Phone Number ID** and generate a long-lived access token
   (or paste an existing system-user token).
3. Enter them in FlowPilot's **WhatsApp manual setup** form
   (`whatsappManualSchema`: `phoneNumberId`, `accessToken`, optional
   `displayName` and `wabaId`).

### WhatsApp messaging rules

- **24-hour customer-service window:** free-form messages may only be sent within
  24 hours of the customer's last message. Outside the window, you must use an
  approved **message template** (create templates in the dashboard under
  WhatsApp → Message Templates; they need approval before use).

## 9. Instagram requirements (Business Login)

- The Instagram account must be a **Professional account** (Business or Creator).
  **No Facebook Page link is required** — Instagram uses Business Login
  (Instagram API with Instagram Login), a separate OAuth flow from Facebook
  Login.
- In the app dashboard: **Instagram → API setup with Instagram login →**
  set up Business Login for the account, then under **Business login settings**
  add this app's OAuth redirect URI (`{APP_PUBLIC_URL}/api/integrations/meta/callback`)
  to the allowed list. The URI must match exactly.
- If your Meta app uses a separate **Instagram App ID / Secret** (shown in the
  Business login settings), set `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`.
  These are **required** and differ from `META_APP_ID` / `META_APP_SECRET` —
  omitting them makes the app send the Facebook App ID to Instagram's
  authorize endpoint, which Meta rejects with "Invalid platform app".
- **Permissions:** `instagram_business_basic`, `instagram_business_manage_messages`,
  `instagram_business_manage_comments`. The old `instagram_basic` /
  `instagram_manage_*` values were deprecated by Meta on 2025-01-27 — this is
  why the previous Facebook-Login scopes were rejected.
- **Webhooks:** subscribe the app to the **Instagram** object's `messages` and
  `comments` fields in the dashboard. FlowPilot also subscribes each connected
  account automatically at connect time (`POST /{ig-user-id}/subscribed_apps`).
- **Comment private replies:** you can send a private message in reply to a
  comment only when the commenter has an open messaging thread or the comment
  qualifies under Instagram's private-replies policy (e.g. replying to a comment
  on your own post/story); otherwise the send is rejected by the API.
- **Legacy connections:** Instagram accounts previously connected via Facebook
  Login (Page-linked) keep working — their stored credentials are detected by
  `loginType` and continue to use the Page-based send/verify paths.

## 10. TikTok Login Kit setup

FlowPilot connects TikTok via the official **Login Kit for Web** (account
identity only — TikTok exposes no general DM-sending API, so the TikTok
card verifies *who* connected, nothing more).

1. Go to https://developers.tiktok.com/ → **Manage apps** → create an app.
2. In the app dashboard, add the **Login Kit** product (Web).
3. Under Login Kit → **Redirect URI**, whitelist exactly:
   `{APP_PUBLIC_URL}/api/integrations/tiktok/callback`
   (e.g. `https://ethics-captivity-crawling.ngrok-free.dev/api/integrations/tiktok/callback`).
   TikTok rejects any redirect URI that is not whitelisted — this is the most
   common cause of callback failures.
4. Request the scope **`user.info.basic`** (already the only scope FlowPilot
   asks for). No App Review is needed for testing with your own account; put
   the app in **Sandbox/Development** mode while testing.
5. Copy the **Client Key** and **Client Secret** into your `.env` as
   `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`, then **restart the dev server**
   (env vars are read at startup).
6. In FlowPilot → Integrations → TikTok → **Connect with TikTok**, authorize,
   and confirm the card shows your TikTok display name and avatar.

Token expiry: TikTok access tokens expire (typically 24h); FlowPilot refreshes
them automatically with the stored refresh token and marks the integration
**NEEDS_ATTENTION** ("Token expired — please reconnect") when refresh fails.

## 11. Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| Error **190** / "Error validating access token" | Token **expired** or revoked → run the **Reconnect** OAuth flow in FlowPilot to get a fresh token. |
| Error **429** / rate limiting | You're hitting Graph API rate limits → the integration **retries with backoff**; reduce send concurrency or spread traffic over time. |
| **Signature mismatch** on incoming webhooks | The `X-Hub-Signature-256` check failed → verify `META_APP_SECRET` in `.env` exactly matches the **App Secret** in the Meta app dashboard (no extra spaces/quotes), then restart the server. |
| Webhook verification fails | `META_VERIFY_TOKEN` doesn't match the Verify Token entered in the dashboard → make them identical and re-verify. |
| OAuth redirect mismatch | `APP_PUBLIC_URL` doesn't match the registered redirect URI → update "Valid OAuth Redirect URIs" in **Facebook Login → Settings** and restart OAuth. |

## 12. AI provider setup (Workflow Copilot)

The "Build with AI" copilot needs a real AI provider. Without one, the
copilot API answers **503 `AI_PROVIDER_NOT_CONFIGURED`** — it never fakes
generation with the mock provider.

1. In `.env`, set:
   ```
   AI_PROVIDER="openai"
   OPENAI_API_KEY="sk-..."   # your OpenAI API key — never commit this
   # Optional:
   # OPENAI_BASE_URL="https://api.openai.com/v1"  # for OpenAI-compatible proxies
   # AI_MODEL="gpt-4o-mini"
   ```
2. Restart the dev server.
3. Open any workflow → **Build with AI**. If the key is missing or invalid you
   get a clear error (503 not configured / provider error with safe retry) —
   never a fabricated workflow.

Keep `AI_PROVIDER="mock"` (the default) for local development and tests.
