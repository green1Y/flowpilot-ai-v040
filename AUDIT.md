# FlowPilot AI — Platform Audit & Upgrade Plan

Date: 2026-10-17. Scope: upgrade to a complete customer-communication / marketing-automation / CRM / sales platform. Prior builds preserved: auth, Prisma models, Meta integrations (OAuth, webhooks, send paths), inbox, automation engine.

## 1. Codebase inventory

| Area | Status | Notes |
|---|---|---|
| Inbox | EXISTING (real), INCOMPLETE | 3-column UI, filters, composer, saved replies, AI suggestions. Manual send route **always mocked** (`mocked:true`) — does not use real adapter even when connected. Missing: assignments, priorities, human-takeover flag, typing/conflict indicators, real-vs-demo badges on messages. |
| Automations | EXISTING (real) | Visual builder, 15 templates, engine with idempotency/retries/dead-letter, execution logs, dry-run, publish/pause/duplicate. Loop protection via MAX_VISITS. |
| AI assistant / knowledge base | INCOMPLETE | Config CRUD + knowledge-doc CRUD real. No chunking, no retrieval/RAG — `generateReply` takes optional snippets but nothing feeds them; mock provider returns canned replies. No escalation queue. |
| Contacts / CRM | EXISTING (real), INCOMPLETE | CRUD, CSV import/export, tags, lead stages, search. Missing: interaction timeline, duplicate detection, follow-up dates, order values, segments. |
| Campaigns | INCOMPLETE | CRUD + scheduledAt intent + channel/provider verification on schedule. **No sending engine, no eligibility checks, no reports, no rate control.** |
| Analytics | EXISTING (real), INCOMPLETE | DB-backed overview metrics with date/channel filters. Missing: campaign performance, response times, failed-send reporting, CSV export, real-vs-demo separation in UI. |
| Integrations | EXISTING (real) | Meta OAuth (IG/Messenger/WhatsApp), webhook verify + HMAC + dedupe, real send adapters, 24h WhatsApp enforcement, NEEDS_ATTENTION on 190s. Mocked-HTTP tested (48 tests); not live-verified (no credentials on file). |
| Team / RBAC | EXISTING (real) | Team routes + roles exist; verify enforcement per route during hardening. |
| Billing | INCOMPLETE | PLAN_LIMITS tiers + `trackUsage` metering exist. No payment provider; **limits not enforced server-side**. |
| Audit logs | EXISTING (real) | `auditLog()` used across routes; never throws. No viewer UI. |

## 2. Official API research (verified 2026-10-17 via current docs/guides)

### Instagram Graph API
- History: `GET /{ig-user-id}/conversations` (rate limit **2/sec**); `GET /{conversation-id}/messages` returns **max 20 messages per thread**. On first link, only the last 20 per conversation are retrievable; everything after setup is fully accessible going forward.
- Comments: `GET /{media-id}/comments` on own media (needs `instagram_manage_comments`).
- Private replies: `POST /{comment-id}/private_replies` — **one reply per comment**, **7-day window** from comment creation (error 551 after), text only, 750/hour. Does not require a prior DM.
- DM sends: **24-hour window** after user's last message. Likes/comments/follows do **not** open the window. Human Agent tag extends to 7 days but requires App Review + Business Verification.
- No bulk/broadcast messaging; cannot initiate conversations.

### Facebook Messenger Platform
- Standard messages: **24-hour window** after user's last interaction.
- Message tags are being **deprecated**: `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` API calls return errors (from 2026-04-27); replaced by **utility templates** (moderated).
- Remaining outside-window routes: **one-time notification** (user opts in, exactly one future message), **Marketing Messages API** (paid, explicit opt-in; replaced Recurring Notifications, discontinued Feb 2026 except AU/EU/JP/KR/UK), Human Agent tag (7 days, beta).
- Sponsored messages for paid re-engagement.

### WhatsApp Business Platform (Cloud API)
- **No message-history listing endpoint exists** — only `POST /messages` for sending. History is available **only** from webhooks captured going forward, plus a one-time 180-day onboarding history webhook at setup.
- **24-hour customer-service window**; outside it, only **approved templates** may be sent. Free-form business-initiated messages are rejected.

### Re-engagement feasibility
| Data source | Retrievable? | How |
|---|---|---|
| People who sent DMs (IG/Messenger) | YES | `conversations` API (last 20/thread initially, full going forward) + our webhook store |
| People who sent DMs (WhatsApp) | Only going forward | Webhook ingestion into our DB; no backfill API exists |
| Commenters (IG own media) | YES | `/{media-id}/comments` per media |
| Commenters (FB Page posts) | YES | `/{post-id}/comments` |
| Eligibility windows | Computed locally | From stored `lastInboundAt` / `commentedAt`; the APIs do not expose window state |

## 3. Platform messaging restrictions (enforced in eligibility checker)

- **IG/Messenger freeform**: eligible iff last inbound ≤ 24h ago (page/account-scoped). IG private reply: comment ≤ 7 days old AND no prior private reply to that comment.
- **Messenger outside 24h**: only utility templates / OTN / marketing-messages API — NOT freeform. Our checker marks freeform ineligible and suggests template/OTN.
- **WhatsApp**: freeform iff last inbound ≤ 24h; otherwise approved template required (template name + language).
- **Universal**: suppressed/opted-out contacts never eligible; one private reply per comment; per-recipient dedupe via idempotency keys; rate caps per channel.

## 4. Ranked stage plan

Ranked by (user value × feasibility) ÷ (effort × security risk):

1. **STAGE 1 — Contact history + eligibility checker** (HIGH value, MED effort, LOW risk). Foundation for all messaging. Pure-function checker, fully tested; history backfill where APIs allow.
2. **STAGE 2 — Individual follow-ups** (HIGH value, MED effort, MED risk). Eligibility verdict before send, templates, suppression, audit, lead-stage hooks. Proves the send path before bulk.
3. **STAGE 3 — Campaigns** (HIGH value, HIGH effort, HIGH risk). Only after eligibility exists: pre-check + skip-ineligible with reasons, rate caps, retries, idempotency, scheduling, honest reports.
4. **STAGE 4a — Inbox hardening** (MED value, LOW effort): assignments, takeover flag pausing AI, real/demo badges, conflict indicators.
4. **STAGE 4b — Analytics** (MED value, LOW effort): campaign stats, response times, CSV export, real-vs-demo labels.
4. **STAGE 4c — AI knowledge retrieval** (HIGH value, MED effort): chunking, grounding, citations, escalation queue.
4. **STAGE 4d — SaaS limits enforcement** (MED value, LOW effort): enforce PLAN_LIMITS server-side on sends/workflows/seats.
4. **STAGE 4e — E-commerce framework** (MED value, HIGH effort): provider interface + mock-store reference impl.

Security invariants for every stage: tenant isolation via `requireWorkspace`, zod validation, encrypted credentials server-side only, no secrets in logs, existing 48 tests stay green.
