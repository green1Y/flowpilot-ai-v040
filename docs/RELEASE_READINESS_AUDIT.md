# FlowPilot AI — Release Readiness Audit

**Date:** 2026-10-20
**Scope:** Implementation audit for the multi-account + WhatsApp verification commission.
**Method:** Three parallel read-only audit workstreams over the actual codebase (schema, API routes, adapters, webhook handlers, workflow engine, auth/tenancy, plan limits, UI), cross-checked against the existing test files. No feature is classified "verified" based on UI, naming, or configuration fields alone — only on code paths plus tests or prior verified runs.
**Baseline entering this audit:** v0.2.0 — 756/756 tests (72 files), tsc clean, production build 108/108 pages.

**Classification key**

- **VERIFIED** — implemented and covered by tests / previously run green.
- **UNVERIFIED** — implemented in code, but no test or live run proves it.
- **DEMO/MOCK** — demo or simulated behavior only.
- **PARTIAL** — implemented incompletely or with material defects.
- **MISSING/BLOCKED** — absent, or blocked by provider configuration/credentials.

---

## 0. Headline findings (read these first)

1. 🔴 **WhatsApp inbound messaging is broken in production.** The Meta webhook POST handler (`src/app/api/webhooks/meta/route.ts`) returns early unless `body.object` is `"page"` or `"instagram"`. WhatsApp Cloud API delivers with `object: "whatsapp_business_account"` — a string that appears nowhere in `src/`. Every real WhatsApp webhook is acknowledged (200) and silently dropped before routing or ingest. The inbound parser (`parseWhatsappMessage` in `src/lib/integrations/ingest.ts`) is unreachable dead code via the real route.
2. 🟠 **Freeform WhatsApp sends through the send pipeline always fail on a real connection.** `src/lib/messaging/send.ts` calls `getWorkspaceAdapter()` without the `getLastInboundAt` option; `WhatsAppAdapter.sendMessage()` then treats every freeform send as outside the 24-hour window and throws. Template sends and mock connections are unaffected — which is why mocked tests never caught it.
3. **Multiple accounts per provider are schema-impossible today.** `Integration` carries `@@unique([workspaceId, provider])`; every connect path upserts on that key, so connecting a second WhatsApp number / Instagram account / Page **overwrites the first account's credentials**. This is the central gap against the selected architecture (multiple connected accounts within one workspace).
4. **Inbound events never trigger workflows — on any Meta channel.** `ingestMetaEvent()` creates contacts/conversations/messages and fires campaign/lead hooks, but never calls `executeWorkflow()`. The only non-test caller of the engine is the manual execute route.
5. **WhatsApp delivery statuses are not processed.** `value.statuses[]` (sent/delivered/read/failed) is explicitly ignored in ingest. `OutboundSend.status = SENT` means "Graph API accepted the request", and nothing ever transitions it. API acceptance is not distinguished from delivery anywhere in data or UI.
6. **Plan limits are mostly unenforced.** Only the monthly message limit is enforced (3 endpoints). The workflow and seat limits exist in the Plan model but are never checked in production code; there is no connected-accounts limit at all; enforcement is check-then-act (not atomic), and the campaign gate ignores recipient count.

None of these were visible from the UI. All are fixable without rebuilding working systems; the phased plan in §7 sequences the fixes.

---

## 1. Duplication and conflicts check

| Question | Finding |
|---|---|
| Duplicate workflow editors? | **No.** One builder (`src/app/app/automations/[id]/builder/`, @xyflow/react) plus a Simple-mode linear view of the same graph. One engine (`src/lib/workflows/engine.ts`). |
| Duplicate account models? | **No.** One `Integration` model serves all providers. No parallel ConnectedAccount model exists. |
| Conflicting routes? | **No** conflicting routes found. Billing UI is implemented **twice** (`src/app/app/billing/page.tsx` vs `src/app/app/settings/tabs/PlanTab.tsx`) over the same `GET /api/billing`, with the PlanTab version mapping usage bars less accurately — a UX duplication to resolve, not a route conflict. |
| Duplicate capability registries? | **Yes — drift risk.** `src/lib/integrations/capabilities.ts` (12 providers × 8 keys, display) and `src/lib/integrations/providers.ts` (adapter catalog) are separate sources of truth with different vocabularies. Currently consistent; should be unified or cross-checked by test. |
| Existing tests | 72 test files / 756 tests at baseline (v0.2.0), incl. tenancy isolation, billing 402s, analytics aggregates-vs-records, workflow engine/simulate safety, connection-state, capabilities. **No `ingest.test.ts` exists** — the webhook ingest module (incl. WhatsApp parsing) has no dedicated tests. |

---

## 2. Visual Workflow Builder + Execution Engine

| Feature | Class | Evidence |
|---|---|---|
| Free canvas: drag/drop, zoom, pan, connections, selection states | VERIFIED | `builder/canvas.tsx` + `index.tsx` (1,050 lines), @xyflow/react 12, MiniMap/Controls, connection validation at draw time (`graphModel.ts`), `graphModel.test.ts` (~24 tests) |
| Node library (10 triggers, 9 conditions, 15 actions, 7 flow = 41 types) with Zod config schemas + defaults | VERIFIED | `src/lib/workflows/nodeRegistry.ts` |
| Config panel with validation, defaults, `{{variables}}`, per-condition test-step | VERIFIED | `builder/configPanel.tsx`; `POST /api/workflows/[id]/test-step` |
| Validation: missing config, disconnected nodes (reachability), invalid edges, self-loops | VERIFIED | `src/lib/workflows/validate.ts`, `validate.test.ts` |
| Cycle detection | PARTIAL | Exists in `readiness.ts` (builder-side) — **the publish API does not run it**; a cyclic graph can be published via direct API call. Runtime `MAX_VISITS=100` guard only |
| Draft / save (autosave + optimistic concurrency) / publish / pause / duplicate | VERIFIED | `/api/workflows/[id]/{publish,pause,duplicate}`, PATCH with `expectedUpdatedAt` → 409 `SAVE_CONFLICT` |
| Version history | MISSING | `Workflow.version` is an integer counter incremented per save. No `WorkflowVersion` model, no snapshots, no history UI, no restore |
| Version-aware execution | MISSING | `WorkflowExecution` stores no version/snapshot; the processor loads nodes/edges live at job start, so edits between enqueue and execution (or between retries) silently change what runs |
| Test events + execution trace (outputs, errors, branch decisions) | VERIFIED | Test modal (dry-run), `runInspector.tsx` with DRY RUN / LIVE badges, branch decisions + SKIPPED reasons recorded in `ExecutionStep` |
| Execution history (status, duration, retries) | PARTIAL | Last 50, execution-level duration + attempts present; **per-step duration is rendered by the UI but never captured** (no timing fields on `ExecutionStep`); no pagination/filtering; retry attempts' steps interleave in one list |
| Simulated-vs-live labels | VERIFIED | `dryRun` flag + badges; `mocked` flags on steps/sends; simulation (`simulate.ts`) is fully in-memory, proven write-free by `simulate.safety.test.ts` |
| Templates | VERIFIED | 15 templates through the same spec trust boundary as the AI Copilot |
| Import/export workflow files | MISSING | No JSON export/download or import/upload anywhere |
| Provider gating of nodes | PARTIAL | Advisory only: readiness warnings; palette lists all 41 types regardless of connections; `send_message` falls back to the mock adapter (honestly labeled); email/WhatsApp-template steps fail honestly + file approval requests. Nothing hard-blocks unsupported combinations at build/publish time |
| Account targeting (`integrationId` node config) | DEMO/MOCK (UI only) | Config picker + schema fields exist; **`engine.ts` contains zero references to `integrationId`**. The engine resolves one adapter per channel per workspace |
| Human takeover respected | VERIFIED | `takeoverSkip()` in engine; `engine.takeover.test.ts` (3 tests) |
| Demo-mode blocking of real sends | VERIFIED | `assertLiveSendAllowed()` (`src/lib/demo/guard.ts`) at execution entry + inside send actions incl. queue retries (v0.2.0) |
| Durable idempotency | PARTIAL | `WorkflowExecution.idempotencyKey @unique` + dedupe is durable, **but** `executeWorkflow` does find-then-create without handling the unique-violation race — concurrent same-key calls can throw instead of returning `duplicate: true` |
| Retries / backoff / dead-letter | PARTIAL | Queue: max 3 attempts, exponential backoff, dead-letter list — **all in-memory** (`src/lib/queue.ts`); lost on restart; no dead-letter UI found. Retry is whole-run only |
| Delays / scheduled triggers | DEMO/MOCK (modeled) | `flow.delay` and `action.wait` return immediately with a "scheduled" note; **no scheduler/cron consumer exists** for `trigger.scheduled`; `flow.timeout` is self-described "informational in this build"; `flow.error_branch` is a pass-through marker — failures never route to an error branch |
| `condition.business_hours` | DEMO/MOCK | Always returns `true` (disclosed in code + step output) |
| Responsive / accessible editor | PARTIAL | Aria labels, focus rings, keyboard shortcuts present; layout is a fixed flex row with no small-screen breakpoints — panels do not collapse on mobile |

---

## 3. Multi-account / multi-workspace architecture

**Selected architecture (JOE, 2026-10-20): multiple connected social accounts within one workspace.**

| Feature | Class | Evidence |
|---|---|---|
| Multi-workspace model + membership roles | VERIFIED | `Organization → Workspace`, `Membership @@unique([userId, workspaceId])`, roles OWNER/ADMIN/MANAGER/AGENT/ANALYST |
| Server-side tenancy enforcement | VERIFIED | `src/lib/tenancy.ts` `requireWorkspace()` (header → cookie → first membership; membership verified per request; coded 403/404s); `src/app/api/tenancy.test.ts`; integration mutations workspace-scoped + MANAGER+ for credential changes |
| Workspace switcher UI | VERIFIED | `Topbar.tsx` `WorkspaceSwitcher()` + `useWorkspaces()` context; stale-selection recovery (v0.2.0) |
| **Multiple accounts per workspace per provider** | **MISSING (schema-blocked)** | `@@unique([workspaceId, provider])` on `Integration`; all connect paths upsert on it — a second connect **overwrites** the first account |
| Stable provider identity per account | PARTIAL | `Integration.externalAccountId` exists (page id / IG id / `phone_number_id`) and is indexed, but it is a scalar on the single per-provider row |
| Selected-account state (switcher, filters) | MISSING | No account cookie/localStorage/context/query param anywhere; pages filter by channel string only |
| Account scoping of data | MISSING (structurally) | `Conversation`, `Message`, `OutboundSend`, `WorkflowExecution`, `CustomerEvent` have **no `integrationId`** (only `Comment` and `RetargetingCampaign` reference an integration). Contact identity (`Contact.externalIds`) is keyed per channel, so same-provider accounts would collide |
| Workflows targeting accounts/groups | MISSING | Node config field exists but is ignored by the engine (see §2); no account groups |
| Webhook → account routing | PARTIAL + RISK | `matchIntegrations()` matches `externalAccountId` candidates; **no global uniqueness on `externalAccountId`** — if two workspaces connect the same Page/number, both ingest the event (cross-workspace duplication) |
| Message dedupe durability | PARTIAL | `CustomerEvent` dedupe is durable (`@@unique([workspaceId, providerEventId])`, atomic upsert); **visible `Message` rows are deduped only by an in-memory Set** (`ingest.ts`, lost on restart, 50k cap) — a Meta redelivery after restart duplicates inbox messages |
| Adapter resolution failure mode | PARTIAL (risk) | `getWorkspaceAdapter()` catches *any* error (missing row, decrypt failure) and silently returns the mock adapter. Sends stay honestly labeled `mocked: true`, but a corrupted real connection degrades silently |
| Cross-workspace leakage in API read paths | VERIFIED (none found) | Tenant isolation enforced and tested; `sendFollowUp()` rejects cross-tenant idempotency collisions with 409 |

---

## 4. WhatsApp (Cloud API) — full trace

**Status going in: unknown. Status after trace: outbound substantially real; inbound broken; delivery tracking absent. No live test has ever been run from this environment (no credentials); all verification below is code + mocked tests.**

### Inbound path

| Step | Class | Evidence |
|---|---|---|
| Webhook GET verification | VERIFIED | Timing-safe compare vs `META_VERIFY_TOKEN`; covered in `route.audit.test.ts` |
| POST signature verification | VERIFIED | HMAC-SHA256 + `timingSafeEqual`, fail-closed, 401 on mismatch; `meta.test.ts` |
| 🔴 Object routing | **BROKEN** | Route drops any `body.object` other than `"page"`/`"instagram"`; WhatsApp sends `"whatsapp_business_account"` (zero occurrences in `src/`) — **all WhatsApp inbound is dropped after a 200 ack** |
| Account routing by `phone_number_id` | UNVERIFIED (unreachable) | `matchIntegrations()` collects `metadata.phone_number_id` as a candidate — correct code, never exercised for WhatsApp because of the object filter; no test payload uses a WhatsApp object |
| Message parsing / normalization | UNVERIFIED | `parseWhatsappMessage()` handles `value.messages[]`, wamid dedupe key, `wa:` contact identity, conversation find-or-create, `lastInboundAt`; **no `ingest.test.ts` exists**; non-text collapses to `[image]`-style placeholders; media ids not stored |
| Deduplication | PARTIAL | Durable via `CustomerEvent`; message rows in-memory only (see §3) |
| Workflow trigger dispatch | MISSING | Ingest never calls `executeWorkflow()` — for WhatsApp **and** Instagram/Messenger |
| Delivery/read status events | MISSING | `value.statuses[]` explicitly ignored in `ingest.ts`; `message_delivered` CustomerEvent type exists with no producer; `Message` has no provider-id/status columns |
| Webhook processing failure handling | PARTIAL | Ingest errors are caught/logged and the webhook still returns 200, so Meta never redelivers a transient failure |

### Outbound path

| Step | Class | Evidence |
|---|---|---|
| Adapter performs real Graph API requests | VERIFIED (code + mocked tests) | `WhatsAppAdapter` via `meta.ts` `graph()` (Bearer, 20s timeout, typed errors 190/429/80007/130429) |
| Connection verification before storing credentials | VERIFIED | Manual connect calls `getPhoneNumberInfo()` first; stores AES-256-GCM encrypted credentials; sets `verifiedAt`, `externalAccountId = phoneNumberId`; `connect()` refuses to fake (`NEEDS_ATTENTION`, `verified: false`) |
| Send pipeline: eligibility re-check, suppression, DB idempotency, provider id persisted | VERIFIED | `send.ts` `sendFollowUp()`; `OutboundSend.idempotencyKey @unique`; duplicates return the existing row without re-sending; `send.test.ts` |
| 24-hour window — eligibility layer | VERIFIED | `eligibility.ts` (freeform ≤24h from `lastInboundAt`; templates always eligible with honest Meta-approval caveat); `eligibility.test.ts` |
| 🟠 24-hour window — adapter layer via pipeline | **BROKEN** | `send.ts` doesn't pass `getLastInboundAt` to the adapter → connected WhatsApp freeform sends always throw "outside window" (see §0.2). Engine path wires it correctly |
| Template messages | PARTIAL | Name + hardcoded `en_US`; **no `components`/parameters** — parameterized templates cannot be filled; template body discarded by the adapter branch; no template list/sync/approval-status from Meta |
| Media sends | DEMO/MOCK (claimed, not sent) | Capability advertises `send_media`; `sendMessage()` never puts media in any payload |
| Delivery states (accepted/sent/delivered/read/failed) | MISSING | `SENT` = API acceptance only; no transitions, no distinction in UI |
| Retries | PARTIAL | Errors classified retryable + sends idempotent (manual retry safe, campaign retry-failed route exists); **no automatic bounded retry/backoff** for WhatsApp sends |
| Live end-to-end test | **BLOCKED** | Requires JOE's Meta credentials (WABA + phone number + permanent token), a public HTTPS webhook, and a real handset. Mocked route tests use only `object: "page"`/`"user"` payloads — no WhatsApp case exists |

---

## 5. Provider capabilities and connection honesty

| Feature | Class | Evidence |
|---|---|---|
| Capability matrix (12 providers × 8 capabilities, platform-truth levels + notes) | VERIFIED | `src/lib/integrations/capabilities.ts`; `capabilities.test.ts` (never "available" without a genuine connection; simulated never available) |
| 8-state connection model (not_connected/connecting/connected/partial/permission_missing/reauth_required/unavailable/failed) | VERIFIED | `connection-state.ts` — "connected" requires CONNECTED row + decryptable credentials + provider asset ids + `verifiedAt`; `connection-state.test.ts` (~20 cases) |
| Instagram / Facebook / TikTok adapters | VERIFIED (code + mocked tests) / UNVERIFIED live | Meta Graph v21.0 OAuth + HMAC webhooks; Instagram Business Login separate flow; TikTok identity-only (no messaging API exists). Instagram token-exchange completion still unconfirmed on JOE's machine since 2026-10-18 |
| Simulated providers (telegram, youtube, linkedin, x, email-channel, webchat, sheets, zapier) | DEMO/MOCK (honestly labeled) | SIMULATED states in UI; never resolve to available capabilities |
| Permission errors (Meta 10/200/298, token 190) mapped to honest states | VERIFIED | `meta.ts`, `connection-state.ts`; engine marks integration NEEDS_ATTENTION on token expiry |
| Capability enforcement in the workflow builder | PARTIAL | Matrix is display-only; builder nodes are not gated by it (see §2) |
| Diagnostics screen | PARTIAL | Card-level Test/Verify buttons (real identity checks), `statusDetail`, `verifiedAt`/`lastSyncAt` on the integrations page. **Missing:** persisted `lastTestAt`, webhook-subscription verification, configuration-completeness checklist, centralized diagnostics view |

---

## 6. Plan entitlements + analytics + UX

### Plan entitlements (`src/lib/billing/usage.ts`, Plan: messages/workflows/seats only)

| Feature | Class | Evidence |
|---|---|---|
| Monthly message limit enforced server-side | VERIFIED | `requirePlanLimit(..., "messages")` at 3 endpoints (inbox send, campaign start, immediate follow-up); honest 402; `stage4d.test.ts` |
| Usage metering | VERIFIED | Atomic `{increment}` upserts per (workspace, month); metered at sends, workflow runs, inbox sends |
| Workflow limit | PARTIAL (defined, unenforced, conflated) | `checkLimit` compares monthly *executions* to `workflowLimit`, while seed/UI describe it as *defined workflow count*. No production caller enforces either meaning |
| Seat limit | PARTIAL (defined, unenforced) | No plan check in `POST /api/team` |
| Connected-accounts / workspaces / executions / export / feature limits | MISSING | No Plan fields, no checks. `Plan.features` is display-only (no gate anywhere). Analytics export has **no role or plan gate** — any member can export up to 10k rows incl. message bodies |
| Atomic enforcement | PARTIAL | Check-then-act; consume recorded after the action; no transaction spans check+consume; **no concurrency test**. Campaign gate checks once regardless of recipient count; per-send pipeline never re-checks quota |
| Billing UI honesty | VERIFIED | Upgrade modal states no payment was processed and the plan did not change; "managed by your administrator"; PlanTab marks upgrades/invoices "Not yet available" |
| Plan-state labels (real/trial/demo/manually assigned) | MISSING | No Subscription model, no trial concept; billing API never reads `Workspace.isDemo`, so a demo workspace's plan looks identical to a paid one |
| Downgrade behavior | PARTIAL (safe by absence) | No code disconnects accounts or deletes workflows on downgrade — safe, but the policy is undefined and untested |

### Analytics (`src/lib/analytics/queries.ts`, 966 lines)

| Feature | Class | Evidence |
|---|---|---|
| Workspace + channel analytics (messages, conversations, response time, workflows, campaigns, outbound, CRM, retargeting) | VERIFIED | All queries workspace-scoped; filters genuinely change results; `queries.test.ts` + route tests compare aggregates to seeded records |
| Honest advertising metrics | VERIFIED | `spend: null, roas: null, spendAvailable: false` — never invented |
| Event dedupe in metrics | VERIFIED | Counts read `CustomerEvent` (DB-unique provider event ids) and `OutboundSend` (unique idempotency keys) |
| Account-specific analytics | MISSING (schema-blocked) | No `accountId`/`integrationId` parameter anywhere; no account selector; `channelAnalytics` hard-assumes one account per channel (see §3) |
| Demo/simulated separation in headline metrics | PARTIAL | `mocked` split exists only in outbound/campaign sub-metrics; headline message/conversation counts include mocked rows; workflow runs count DRY_RUN executions; analytics page shows no mocked/demo labels |
| Demo badge on overview | BROKEN (dead code) | Overview route returns `demo: false` **unconditionally**; the badge component exists but can never appear; no analytics query reads `Workspace.isDemo` |
| Usage/plan consumption inside analytics | MISSING | Usage lives only on billing views |

### UX / diagnostics

| Feature | Class | Evidence |
|---|---|---|
| Onboarding (first account + first workflow, safe test, explicit activation) | VERIFIED | 10-step wizard, persisted progress, tested; never auto-activates a live workflow |
| Integrations page states (loading/empty/error, per-card errors, OAuth error surfacing) | VERIFIED | `src/app/app/integrations/page.tsx` |
| Centralized activity/error center | MISSING | Failed workflows, integration issues, and message failures live in three separate places; no unified feed or nav item |
| Global account/channel switcher | MISSING | Workspace switcher only; channel selection is per-page |
| Settings duplication | PARTIAL | Sidebar has Settings **and** Billing; Settings contains Plan + Integrations tabs. Integrations tab is read-only + links out (mitigated); Plan is fully duplicated with a less accurate implementation |

---

## 7. Phased implementation plan (audit-justified changes only)

### Batch A — WhatsApp critical path (no schema risk beyond additive columns)
1. Webhook route: accept `object: "whatsapp_business_account"` → route to ingest (fixes §0.1).
2. `send.ts`: pass `getLastInboundAt` when resolving the WhatsApp adapter (fixes §0.2).
3. Parse `value.statuses[]`: persist delivery state — additive `deliveryStatus` + `deliveryStatusAt` on `OutboundSend`, `providerMessageId` + `status` on `Message`; emit `message_delivered` / `message_failed` CustomerEvents; UI/API wording distinguishes "accepted by WhatsApp" from "delivered".
4. Durable message dedupe: check `CustomerEvent` dedupe *before* creating `Message` rows (or a provider-message-id unique on Message) so redelivery after restart cannot duplicate inbox messages.
5. Inbound → workflow dispatch: after ingest, run PUBLISHED workflows whose trigger matches (channel/event/keyword), idempotency key derived from the provider event id; human-takeover and demo guards already in the engine apply.
6. Webhook fan-out guard: if an `externalAccountId` matches integrations in more than one workspace, ingest only where the credential match confirms ownership; log the ambiguity (no silent cross-workspace duplication).
7. Tests: WhatsApp webhook end-to-end (mocked Graph), statuses transitions, redelivery dedupe, dispatch + duplicate-dispatch prevention, freeform-in-window send via pipeline.

### Batch A2 — small safety fixes
8. Publish API: run cycle detection (+ skip disabled nodes' config validation, matching builder semantics).
9. `executeWorkflow`: catch the unique-violation race → return `duplicate: true`.
10. Analytics export: require MANAGER+ (matches billing read gate).

### Batch B — Multi-account (the selected architecture)
11. Schema (additive, `prisma db push`, no data loss): replace `@@unique([workspaceId, provider])` with `@@unique([workspaceId, provider, externalAccountId])`; add nullable `integrationId` to `Conversation`, `OutboundSend`, `CustomerEvent`, `WorkflowExecution`; add `Integration.isDefault` for deterministic per-channel default resolution.
12. Connect paths (Meta select, WhatsApp manual, Instagram, TikTok): find-or-create by (workspace, provider, externalAccountId) — a second account no longer overwrites the first; disconnect/test/verify act on the specific account row.
13. Adapter resolution: `getWorkspaceAdapter(workspaceId, channel, integrationId?)` — explicit account wins; otherwise the workspace's default connected account for the channel; engine honors node `integrationId` (makes §2's UI-only field real).
14. Ingest stamps `integrationId` on conversations/events from the matched account; contact identity keyed per account where the provider requires it.
15. Account switcher: Topbar account selector (per workspace), persisted selection, inbox/analytics filters honor it; analytics gains an `integrationId` filter + per-account channel rows.
16. Plan: additive `connectedAccountLimit` on Plan (seeded Starter 3 / Growth 10 / Agency 50 — adjustable), enforced server-side at connect time with the same honest 402 shape.
17. Tests: two same-provider accounts coexist; switching changes data; cross-workspace ID tampering still 403/404; workflow pinned to account B never sends via account A.

### Batch C — Entitlements, honesty, versioning
18. Enforce workflow-count limit at workflow create and seat limit at team invite, inside transactions (check+consume atomic); campaign start checks remaining quota against PENDING recipient count.
19. Analytics honesty: headline metrics exclude (or separately report) mocked sends and DRY_RUN executions; overview `demo` flag read from `Workspace.isDemo` so the badge works.
20. Workflow version snapshots: additive `WorkflowVersion` (graph JSON) written on publish; executions record the version and the processor runs the snapshot — edits can no longer corrupt in-flight runs. History list API (restore = later, if wanted).
21. Activity/error center: one page aggregating failed executions, failed outbound sends, and integration errors (data already exists in `WorkflowExecution`, `OutboundSend`, `Integration.statusDetail`, `AuditEvent`).
22. Plan-state label: billing API returns assignment source (demo workspace / manually assigned — no payment provider is configured, and the UI must keep saying so).
23. De-duplicate Plan UI: Settings › Plan links to Billing (or Billing is removed in favor of the tab) — one implementation only.

### Explicitly deferred (labeled, not faked)
- Real delay/scheduled-trigger execution subsystem (needs a durable scheduler; nodes stay labeled as modeled until built).
- Durable queue (Redis/BullMQ) — required for multi-process production; in-memory queue + DB idempotency is the current honest state.
- WhatsApp template parameter components + template approval sync from Meta.
- Workflow file import/export.
- Per-step duration capture (needs `ExecutionStep` timing fields — small, can join Batch C if time allows).

---

## 8. Release blockers requiring JOE

1. **Live WhatsApp test** — Meta app credentials (WABA ID, phone number ID, permanent access token), `META_APP_SECRET` + `META_VERIFY_TOKEN` configured, public HTTPS webhook URL (ngrok or deployed), and a real phone to exchange messages. Without these, WhatsApp can only be verified with mocked tests; the manual live-test procedure will be documented in `docs/INTEGRATIONS_STATUS.md`.
2. **Instagram token-exchange confirmation** — still outstanding from 2026-10-18 (separate from this commission, listed for completeness).
3. Adjustable defaults chosen in this plan (JOE can override anytime): connected-account limits Starter 3 / Growth 10 / Agency 50; default account per channel = the account marked default (initially the first verified CONNECTED account).
