# FlowPilot AI — Integrations Status

**Date:** 2026-10-20 (after the multi-account + WhatsApp commission, Batches A–C)
**Rule applied throughout:** a connection is "live" only when provider verification succeeds. Mocked tests are reported as mocked. Nothing in this document claims a live provider exchange that did not happen.

---

## Summary table

| Provider | Implementation | Verified here | Live status |
|---|---|---|---|
| WhatsApp (Cloud API) | Real adapter, real webhook path, delivery tracking, workflow dispatch | **Mocked end-to-end only** | ❌ **NOT production-ready** — live gate open (§2) |
| Instagram (Business Login + Messaging) | Real OAuth (separate IG app), webhooks, sends | Mocked tests | ⚠️ Token-exchange completion unconfirmed on JOE's machine since 2026-10-18 |
| Facebook Messenger | Real OAuth (Facebook Login), webhooks, sends | Mocked tests | ⚠️ Not live-tested (needs JOE's app + Page) |
| TikTok | Real Login Kit OAuth — **identity only** (no messaging API exists) | Mocked tests | ⚠️ Not live-tested; account connection only, by platform design |
| Email (Resend) | Real adapter for verification/reset mail | Mocked tests | ⚠️ Needs `RESEND_API_KEY` + verified sending domain; unconfigured → honest 503 |
| Telegram, YouTube, LinkedIn, X, Webchat, Sheets, Zapier | Simulated adapters | Labeled SIMULATED in UI | Demo/mock only — never presented as connected |

Connection honesty is enforced by the 8-state model (`src/lib/integrations/connection-state.ts`): **connected** requires a CONNECTED row, decryptable credentials, the provider's asset ids, and a `verifiedAt` timestamp from a real verification handshake.

---

## 1. Multi-account state (new in this release)

- A workspace can now hold **multiple accounts of the same provider**, keyed by (workspace, provider, externalAccountId). Connecting a second account never overwrites the first account's credentials (regression-tested, including a migration test that migrates an old-schema database and asserts every row/credential survives).
- Each (workspace, provider) has at most one **default** account. Adapter resolution order: explicit account id (strict — a wrong-workspace/unusable id is an error, never a silent swap) → default CONNECTED account → the single CONNECTED account → **ambiguous = explicit failure**, never "first row".
- Inbound events, conversations, outbound sends, customer events, and workflow executions are stamped with the exact account id. Workflow nodes can pin an account; inbound-triggered executions inherit the receiving account.
- Plan limit on connected accounts (Starter 3 / Growth 10 / Agency 50), enforced transactionally at connect time; reconnects consume no slot.
- Migration + recovery procedure: `docs/MULTI_ACCOUNT_MIGRATION.md`.

---

## 2. WhatsApp — detailed status

### What is implemented and mock-verified (Batch A, 2026-10-20)

- **Inbound:** webhook GET challenge (timing-safe verify-token compare), POST HMAC-SHA256 signature validation (fail-closed), `object: "whatsapp_business_account"` routing (**this was broken before Batch A — every real WhatsApp webhook was dropped after a 200 ack**), account routing by `phone_number_id` with credential-confirmed ownership, message parsing, contact/conversation creation, `lastInboundAt` tracking.
- **Webhook success semantics:** 200 is returned **only** after the event is persisted and workflow dispatch has been attempted; transient failures return 500 so Meta redelivers, and durable dedupe (DB `CustomerEvent` unique key) + dispatch idempotency keys make redelivery exactly-once (proven by test: failure → 500 → redelivery → 200, one message, one execution).
- **Workflow dispatch:** inbound messages/comments dispatch PUBLISHED workflows (keyword + channel gates honored; DRAFT/PAUSED never fire; human takeover and demo-mode guards apply). Before Batch A, inbound events never triggered workflows on any Meta channel.
- **Outbound:** real Graph API adapter (Bearer token, 20s timeout, typed errors); manual connect verifies the phone number against the real API *before* storing AES-256-GCM-encrypted credentials; send pipeline re-checks suppression + eligibility, is DB-idempotent (no duplicate sends), and passes conversation context + last-inbound lookup to the adapter so the 24-hour window is enforced with real data (**freeform sends through the pipeline were broken before Batch A** — they always threw "outside window" on a real connection).
- **Delivery tracking:** `statuses[]` events (sent/delivered/read/failed) are parsed and applied monotonically to `OutboundSend.deliveryStatus` and the message copy; analytics distinguishes **"Outbound accepted"** (API acceptance) from provider-reported delivered/read counts. Before Batch A, statuses were ignored entirely.
- **Templates:** sent by name through the adapter. Limitations: language hardcoded `en_US`, no `components`/parameters (parameterized templates cannot be filled yet), no template approval-status sync from Meta. Freeform is blocked outside the 24-hour window, per Meta rules — never bypassed.
- **Media sends:** the adapter advertises `send_media` but does not yet put media in payloads — treat media sending as **not implemented**.

### ⛔ Release gate — what is still required before "production-ready" may be claimed

All WhatsApp verification to date is **mocked** (stubbed Graph HTTP, synthetic webhook payloads). A live pass requires, on JOE's machine:

1. A Meta app with the WhatsApp product added; a WABA and a phone number (test number is fine).
2. `.env` set (values entered by JOE, never shared in chat): `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, plus the WhatsApp credentials entered through the app's manual-connect form (WABA phone-number ID + permanent access token from a system user).
3. A public HTTPS base URL (`APP_PUBLIC_URL`, e.g. the ngrok tunnel) and the webhook configured in the Meta dashboard: callback `{APP_PUBLIC_URL}/api/webhooks/meta` (the same URL the Integrations page displays), verify token matching `META_VERIFY_TOKEN`, subscribed to the `messages` field for the WABA.
4. Connect the number in the app (Integrations → WhatsApp → manual connect) and confirm the card reaches **Connected** with `verifiedAt` set (the connect call verifies against the real Graph API).
5. Publish a simple workflow: trigger *New message* (channel WhatsApp) → action *Send message* with a fixed reply.
6. From a real phone, send a WhatsApp message to the connected number. **Pass criteria, all four:**
   - The message appears in the Unified Inbox under the correct account.
   - The workflow execution appears in Automations → Executions, stamped with that account, status SUCCEEDED.
   - The reply arrives on the phone.
   - The outbound record later shows a provider delivery status (`delivered`/`read`) — not merely "accepted".
7. Send the same message again after >24h without any inbound in between: the freeform reply must be blocked by the window rule, and a template send must be offered/used instead.
8. If any step fails, capture the server log lines (they contain no tokens) and the webhook delivery status from the Meta dashboard — do not paste `.env` values or tokens.

Until this procedure passes end-to-end, WhatsApp's status is: **implemented, mock-verified, NOT production-ready.**

---

## 3. Other providers — notes

- **Instagram:** Business Login flow (separate Instagram app credentials `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET` — not the Facebook app). Authorization was confirmed working by JOE on 2026-10-18; the full token-exchange → CONNECTED completion remains unconfirmed. Retest: reconnect from the Instagram card on the latest build; if it fails, the server logs `[instagram-login]` lines (sanitized) are the diagnostic.
- **Facebook Messenger:** Facebook Login OAuth, Page messaging via the same Meta webhook route (`object: "page"`). No live Page test has been run.
- **TikTok:** Login Kit OAuth returns identity (name/avatar) only. TikTok offers no general DM API; the capability matrix says so (`send_messages: no`) and the UI never offers TikTok messaging.
- **Email:** the Resend adapter powers verification codes and password-reset mail only when `RESEND_API_KEY` + `EMAIL_FROM` are set and the domain is verified in Resend; otherwise the API returns an honest 503 `EMAIL_NOT_CONFIGURED`. There is no general email *channel* integration (the email channel in workflows requires a CONNECTED email integration or files an approval request — it does not fake a send).
- **Capability matrix:** `src/lib/integrations/capabilities.ts` (12 providers × 8 capabilities) is the display source of truth, tested to never resolve "available" without a genuine connection. The workflow builder's node gating remains advisory (readiness warnings) — an unsupported combination fails honestly at execution rather than being hard-blocked at design time; this is a known, documented gap, not a silent one.

---

## 4. Diagnostics available today

- Integrations page: per-account Test / Verify (real identity checks), connection state with secret-free failure detail (`statusDetail`), `verifiedAt` / `lastSyncAt`.
- **Activity page** (`/app/activity`, new): failed workflow executions, failed outbound sends, and integrations needing attention, workspace-scoped, newest first.
- Server logs never contain access tokens; credential material is AES-256-GCM encrypted at rest and never returned by any API.
