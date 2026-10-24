# FlowPilot AI — Architecture Plan (Phase 1)

## Stack decision
- **Next.js 14 (App Router) + React + TypeScript + Tailwind CSS** for frontend AND backend (API Routes / Route Handlers).
- **Prisma ORM**: SQLite for local dev, PostgreSQL for production (same schema, `datasource` switched via `DATABASE_URL`).
- **Auth**: JWT in httpOnly cookie, bcrypt password hashing. Ready to swap to NextAuth/Auth.js later.
- **Workflow builder**: React Flow (`@xyflow/react`).
- **Queue**: abstraction `lib/queue.ts` — in-memory durable queue for local dev, BullMQ+Redis interface for production.
- **AI**: provider abstraction `lib/ai/providers.ts` — mock provider for local/tests, OpenAI-compatible interface for prod.

Justification: VM has Node 24, no Docker/Postgres/Redis. A single Next.js unit runs with `npm run dev` and deploys to any Node host or Docker when available. Preserves all architectural requirements: provider adapters, durable queue interface, tenant isolation, encrypted credentials (via env key + AES-GCM).

## Monorepo layout
```
flowpilot/
  ARCHITECTURE.md
  README.md
  .env.example
  package.json
  prisma/schema.prisma
  src/
    app/                    # App Router pages (landing, auth, dashboard sections)
    components/             # Design system (Button, Card, Input, Sidebar, Topbar...)
    lib/                    # auth, db, queue, encryption, tenancy, ai
    lib/integrations/       # provider-adapter framework + mock adapters
    lib/workflows/          # engine: validate, execute, retry, idempotency
    workflows/templates/    # 15 ready-made templates (JSON)
```

## Database schema (core)
- User(id, email unique, passwordHash, name, createdAt)
- Organization(id, name)
- Workspace(id, orgId FK, name, slug, brandColor)
- Membership(userId, workspaceId, role: OWNER|ADMIN|MANAGER|AGENT|ANALYST)
- Integration(id, workspaceId FK, provider, status: DEMO|CONNECTED|NEEDS_ATTENTION|EXPIRED|DISCONNECTED, encryptedCredentials, capabilities JSON, lastSyncAt)
- Contact(id, workspaceId FK, name, externalIds JSON, channel, tags[], leadStatus, leadScore, consent JSON)
- Conversation(id, workspaceId FK, contactId FK, channel, status, assignedTo, aiHandled)
- Message(id, conversationId FK, direction, body, media JSON, aiGenerated, createdAt)
- Workflow(id, workspaceId FK, name, status: DRAFT|PUBLISHED|PAUSED, version)
- WorkflowNode(id, workflowId FK, type, config JSON, position JSON)
- WorkflowEdge(id, workflowId FK, sourceId, targetId, condition JSON)
- WorkflowExecution(id, workflowId FK, triggerEvent JSON, status, idempotencyKey unique, startedAt, finishedAt)
- ExecutionStep(id, executionId FK, nodeId, status, input JSON, output JSON, error)
- Campaign(id, workspaceId FK, name, channel, status, audience JSON, message JSON, scheduledAt)
- AiConfig(id, workspaceId FK, assistantName, businessName, voice, tone, languages, escalationRules JSON, confidenceThreshold, fallbackResponse)
- KnowledgeDoc(id, workspaceId FK, title, content, embeddingRef)
- AuditEvent(id, workspaceId FK, actorId, action, entity JSON, createdAt)
- UsageRecord(id, workspaceId FK, metric, quantity, period)

All tables: `workspaceId` tenant scoping, indexes on (workspaceId, createdAt), UUIDs via `cuid()`.

## API boundaries
- `POST /api/auth/signup|login|logout`, `GET /api/auth/me`
- `GET|POST /api/workspaces`, `GET|PATCH /api/workspaces/:id`
- `GET|POST /api/contacts`, `GET|PATCH|DELETE /api/contacts/:id`, `POST /api/contacts/import`
- `GET|POST /api/conversations`, `GET /api/conversations/:id/messages`, `POST /api/conversations/:id/messages`
- `GET|POST /api/workflows`, `GET|PATCH|DELETE /api/workflows/:id`, `POST /api/workflows/:id/publish|pause|duplicate|test`
- `POST /api/workflows/:id/execute` (mock event entry), `GET /api/workflows/:id/executions`
- `GET|PUT /api/ai-config`, `POST /api/ai-config/test`
- `GET /api/integrations`, `POST /api/integrations/:provider/connect` (mock OAuth), `POST /api/integrations/:id/disconnect|test`
- `GET /api/analytics/overview?range&channel`
- `POST /api/webhooks/:provider` (signature verification stub + replay protection)

Every handler: `requireWorkspace(request)` → tenant check → Zod validation → audit log.

## Provider-adapter architecture
`lib/integrations/adapter.ts`:
```ts
interface ChannelAdapter {
  provider: string;
  capabilities: Capability[]; // e.g. 'send_text', 'reply_comment', 'templates_required'
  limitations: string[];
  connect(input): Promise<ConnectionResult>; // never marks CONNECTED without verification
  sendMessage(...): Promise<SendResult>;
  verifyWebhook(req): boolean;
}
```
`mock/` adapter implements full interface with latency + failure injection for tests. Real adapters (instagram, whatsapp, etc.) ship as stubs with honest capability panels.

## Execution engine
`lib/workflows/engine.ts`:
- `validateWorkflow(nodes, edges)` → errors[] (unconnected nodes, missing config, unsupported action for channel)
- `executeWorkflow(workflowId, event, idempotencyKey)`:
  1. check idempotencyKey in WorkflowExecution (duplicate prevention)
  2. enqueue job (durable queue, retry 3x exponential, dead-letter after)
  3. worker walks nodes: trigger → conditions → actions, records ExecutionStep per node
  4. actions call adapter; only permitted actions execute, else human-approval request
- Test mode: `dryRun` flag, no external sends, steps logged.

## Auth + tenancy
- bcrypt (12 rounds), JWT (7d), httpOnly secure cookie.
- All queries filtered by `workspaceId` from membership. Tests assert cross-workspace access denied.

## Phases
- Phase 1 (this build): branding, auth, workspaces, dashboard (demo-labeled data), DB, demo mode.
- Phase 2: builder canvas + engine + templates + execution logs.
- Phase 3: inbox + contacts + mock channel + webhooks.
- Phase 4: AI config + playground + activity log.
- Phase 5: campaigns, analytics, team, billing stubs.
- Phase 6: tests, hardening, docs.

## Phase 3 (2026-10-18) — Retargeting, unified events, analytics, design system, simulation, RBAC

### A. Unified customer event model
- New `CustomerEvent` model: workspaceId, contactId?, type (comment_received | conversation_started | message_received/sent/delivered/failed | workflow_executed | contact_tagged | segment_changed | opted_out | consent_changed | purchase_recorded | campaign_interaction | conversion_attributed), provider, providerEventId, timestamp, source, metadata JSON, attribution JSON.
- Idempotency: `@@unique([workspaceId, providerEventId])` — webhook re-ingestion never double-records. NULL providerEventId rows always insert (SQLite treats NULLs as distinct).
- `src/lib/events/record.ts`: `recordCustomerEvent` (never throws; returns null on failure) + `recordCustomerEventStrict` (returns existing id on dedupe hit).
- Wired into: `ingestMetaEvent` (message_received/comment_received/conversation_started/campaign_interaction on reply), `sendFollowUp` (message_sent/message_failed), `executeWorkflow` (workflow_executed; dry runs excluded).

### B. Retargeting Center (`/app/retargeting`, nav after Campaigns)
- Models: `AudienceSegment` extended (conditions JSON tree with AND/OR groups), `RetargetingCampaign` (type: dm_reengagement | email | paid_ad | comment_to_dm | crm_sequence; status: draft→scheduled→running→paused→completed/cancelled), `RetargetingRecipient` (idempotencyKey `retargeting:<campaignId>:contact:<contactId>`).
- `src/lib/retargeting/segments.ts`: condition evaluator over Contact/Conversation/Message/Comment/ContactOrder/Suppression + `PROVIDER_AVAILABILITY` honest labels (e.g. abandoned carts need a connected store; Meta exposes no cart data).
- `src/lib/retargeting/campaigns.ts`: buildRecipients (eligibility via `checkEligibility`), launch requires `confirmed:true` (422 otherwise), rate-capped processing, pause/resume/stop, dry-run mode, `getPaidAdChecklist()` + consent-flagged CSV audience export for paid_ad — never fakes ad creation.
- 11 API routes under `/api/retargeting/*` (segments CRUD+preview, campaigns CRUD+review+launch+pause+resume+stop+process+report). Report labels every metric measured/estimated/not_tracked; spend/ROAS always "not tracked" unless real data exists.
- UI: campaign list, 6-step wizard (basics→audience→message→schedule→review→explicit confirm), audience manager with nested AND/OR builder + live preview, detail page with report.
- See `RETARGETING_SETUP.md` for the paid-ads activation checklist.

### C. Premium analytics
- `src/lib/analytics/queries.ts`: tenant-scoped aggregations (eventsByDay, funnels, channel breakdown, workflow/campaign/inbox/CRM/comment-to-DM/retargeting stats, previous-period comparison, zero-filled day buckets, Zod query schema).
- 8 API routes under `/api/analytics/*`: overview, workflows, comment-to-dm, inbox, crm, retargeting, channels, advertising (advertising returns nulls + `*_available:false` with honest notes — spend/ROAS never invented).
- `src/components/charts/`: MetricCard, LineChart, BarChart, DonutChart, FunnelChart, DataTable, ChartEmptyState, ChartSkeleton (recharts).
- Analytics page rebuilt into 8 tabs with date presets + custom range, previous-period compare, channel filters, metric definitions, drill-downs, honest empty states, loading skeletons.

### D. Design system
- `tailwind.config.ts` extended (not replaced): `faint`, `info`, `surface.raised/overlay`, `line.subtle/strong`, `chart.1–8` palette, `shadow.subtle`; brand hexes untouched.
- `src/app/globals.css`: CSS vars for all new tokens with `html.light` overrides, focus rings, reduced-motion support, `.table-scroll`.
- `src/components/ui/`: added FormField, Stat, Alert, Table(+TableScroll), ConnectionStatus (Connected/Needs attention/Demo/Disconnected/Simulated/Expired); Badge/Modal/Tabs updated non-breaking (mobile full-screen modal, keyboard-nav tabs).

### E. Workflow simulation
- `src/lib/workflows/simulate.ts`: `simulateWorkflow` — synchronous, in-memory, zero DB writes, zero adapter calls (never imports getAdapter); reuses engine's `evaluateCondition`/`evaluateIfElseExpression`/`renderTemplate`; returns per-node path (matched|skipped|would_execute|validation_error), would-be message previews, validation errors (dangling edges, unreachable nodes, conflicting conditions, missing credentials, unsupported capabilities) and warnings. Works on DRAFT workflows.
- `POST /api/workflows/[id]/simulate` (Zod, workspace-scoped, audit-logged); builder UI gains a Simulate button + results modal labeled "SIMULATION — no messages were sent".

### F. RBAC verification
- Tenant isolation: no gaps — every route requires workspace membership and scopes all queries.
- Role enforcement added via shared `requireRole` (src/lib/tenancy): MANAGER+ for billing GET, campaign mutations, integration mutations, workflow execute/publish, follow-ups process-due, retargeting launch; AGENT+ for contacts/follow-ups/workflow CRUD; read-only for ANALYST (analytics, lists, previews, simulate, reports).
- `src/app/api/authz-phasef.test.ts`: 20 tests (cross-workspace 404s, role 403s, unauthenticated 401s).
- Inbox `conversations` routes now carry AGENT+ gates (2026-10-19): PATCH
  (assignment/priority/human-takeover), POST message replies, POST internal
  notes, POST typing presence — read-only ANALYST members can still view
  threads but can no longer mutate them via the API. Covered by
  `src/app/api/conversations/authz-conversations.test.ts` (9 tests).

## Phase 4 — SEO, Performance, i18n, Integrations Audit, Production Readiness (2026-10-19)

### A. i18n (EN + AR)
- `src/i18n/config.ts`: LOCALES en/ar, `/ar` `/en` URL prefixes, `localizedPath` for hreflang, cookie `fp_locale`.
- `src/middleware.ts`: locale resolution (prefix → cookie → default), `x-locale` header, `X-Robots-Tag: noindex, nofollow` for `/app/*`.
- `src/i18n/server.ts` (`getLocale`, `getDictionary`, Intl format helpers) + `src/i18n/client.tsx` (I18nProvider, useDict, useLocale, setLocaleClient).
- Core dictionaries `src/i18n/dictionaries/{en,ar}.ts` (tsc-enforced key parity); per-area fragments `src/i18n/fragments/*.ts` (`ar: typeof en`).
- `User.locale` column; `PUT /api/account/locale`; login restores the cookie. Root layout sets `<html lang dir>`. Full RTL via Tailwind logical properties. `TRANSLATION_COVERAGE.md` lists remaining English-only areas honestly.

### B. SEO
- `src/app/robots.ts` (disallow /app/, /api/), `src/app/sitemap.ts` (public URLs only, hreflang en/ar), `src/app/opengraph-image.tsx`, `src/app/not-found.tsx` (bilingual, noindex).
- New public pages: /features, /integrations, /use-cases, /pricing (real plan limits from seed-plans), /faq, /changelog, /docs. Shared `pageMeta()` helper (canonical, OG, hreflang).
- `KEYWORD_STRATEGY.md` (hypotheses labeled, no fake volume data), `SEO_AUDIT.md`. Canonical domain placeholder: set `NEXT_PUBLIC_SITE_URL` before launch.

### C. Performance
- `next.config.mjs`: `experimental.optimizePackageImports` for lucide-react/recharts/@xyflow/react; recharts components wrapped in `next/dynamic` with ChartSkeleton fallback.
- Indexes: Conversation(workspaceId,contactId), Comment(workspaceId,contactId), AuditEvent(workspaceId,action,createdAt).
- Pagination: 7 list endpoints capped at 500; thread messages use cursor pagination (`?before=`, `hasMore`).
- `PERF_AUDIT.md` — Core Web Vitals UNMEASURED in this environment (honest; no pass claimed).

### D. Settings overhaul
- `/app/settings` → 7 tabs: Account, Workspace, Integrations, Automation, Notifications, Security & Privacy, Billing & Usage — all wired to real APIs.
- New: `PATCH /api/auth/me`, `PUT /api/auth/password`, `GET /api/audit`, `GET/PUT /api/workspace/settings` (WorkspaceSettings model), `GET /api/workspace/export`, `POST /api/workspace/deletion-request`.
- Schema: `User.timezone`, `User.notificationPrefs`, `Integration.lastError/lastErrorAt`.

### E. Integrations audit round 2
- `src/lib/integrations/capabilities.ts`: 12 providers × 8 capabilities with platform-truth levels.
- `src/lib/integrations/connection-state.ts`: 8 states (not_connected/connecting/connected/partial/permission_missing/reauth_required/unavailable/failed); `Integration.statusDetail` JSON column.
- `PROVIDER_AUDIT.md` updated + non-destructive E2E checklist for JOE. 54 new mocked tests.

### F. Onboarding, docs, monitoring
- `/app/onboarding`: 10-step wizard, resumable (`OnboardingProgress` model), never auto-activates; fresh signups redirect here.
- `/docs` + `/docs/guides/<slug>`: 10 honest guides cross-checked against provider audits.
- `GET /api/health` (DB ping, no secrets); `BACKUP_RESTORE.md`, `RECOVERY.md`, `NPM_AUDIT_2026-10-19.md` (npm audit blocked by sandbox policy → OSV.dev used; next@14.2.35 has 23 advisories needing a 15.x/16.x major bump — deferred).

## Phase 5 — Workflow Builder Pro + AI Copilot (2026-10-19)

- `src/app/app/automations/[id]/builder/` (11 files): toolbar (autosave states, undo/redo, readiness badge with Fix links, Test/Simulate/Runs, Simple/Advanced toggle, guarded Activate), React Flow canvas (minimap, auto-layout, multi-select, copy/paste, shortcuts, context menu, ghost preview), Zod-driven node config panel with credential picker (names/ids only) and `{{variable}}` mapping, Test Step (`POST /api/workflows/[id]/test-step`, side-effect-free), run inspector (SIMULATION vs DRY RUN vs LIVE labels), conflict-safe autosave (409 + Reload/Keep-mine).
- `WorkflowNode.disabled` column (additive); engine/simulator record honest SKIPPED steps.
- AI Copilot: `POST /api/automations/ai/generate` (ops: generate/explain/diagnose/add_condition/add_delay/add_error_handling/translate; AGENT+, rate-limited 20/10min, 45s timeout) via `src/lib/ai/structured.ts` (OpenAI-compatible JSON mode). Unconfigured provider → honest 503 ("set OPENAI_API_KEY"), never faked. Server-side spec trust boundary: registered node types only, unknown types dropped with repair log, trigger required. Clarifying questions before generation; ghost preview + Accept/Reject (undoable); workspace-scoped (404 cross-workspace).
- All 15 templates pass `validateWorkflow()` and insert via the same validated spec path.
- 224 new tests (copilot spec/prompts/service, graph model, readiness, templates, simulate safety, execution retry, builder i18n parity).
