# Performance Audit — FlowPilot AI (Phase 4, Performance workstream)

Date: 2026-10-19. Scope was additive/structural only (config, wrappers,
indexes, queries); page content files were not touched (i18n workstream owns them).

## 0. Environment blocker — read first

**No production build numbers and no Core Web Vitals measurements could be
captured in this session.** Three `next build` attempts failed for reasons
outside this workstream:

1. Attempt 1: a `next dev -p 3100` server from a prior session was still
   running while the build ran (violates the AGENTS.md lesson). Build died
   with `PageNotFoundError: Cannot find module for page: /_document`.
2. Attempts 2–3: clean `.next`, no dev server — failed with real webpack
   errors from the **concurrent i18n refactor**, which is mid-flight in this
   repo: `src/app/login/page.tsx` and `src/app/signup/page.tsx` export
   `generateMetadata` from `"use client"` modules; `FaqClient.tsx` imports
   `PublicPage.tsx` → `src/i18n/server.ts` which uses `next/headers`.
3. `tsc --noEmit` currently reports **155 errors, all in the i18n
   workstream's new/in-progress files** (`src/i18n/fragments/builder.ts`,
   `*Client.tsx` splits, `login/`, `signup/`, `faq/`, `settings/`, …).
   None are in files this workstream touched (verified by filtering tsc
   output against every changed path).

**Consequence:** `next build` / `next start` / headless-Chromium measurement
was impossible while the tree is broken and moving (files were being edited
by other agents throughout this session). **LCP / INP / CLS are therefore
UNMEASURED — no pass is claimed.** Re-run after the i18n workstream lands:

```bash
cd ~/workspace/flowpilot
npx tsc --noEmit            # must be clean first
npx next build              # capture route sizes + First Load JS from output
npx next start -p 3100 &
# then measure with Playwright (chromium present in ~/.cache/ms-playwright):
# navigation timing + PerformanceObserver LCP on / and /app/analytics
```

Targets for that run: LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1.

## 1. Bundle audit (static analysis)

Heavy client dependencies (unpacked sizes in node_modules, for magnitude):

| Package | Size | Used by | Before | After |
|---|---|---|---|---|
| recharts | 5.2 MB | `src/components/charts/*`, `src/app/app/overview/page.tsx` (direct) | statically bundled wherever the charts barrel or overview page loads; shared-chunk candidate for ALL app pages | charts barrel now `next/dynamic` (4 async chunks, SSR on); overview page still static (page file — i18n-owned, not touched) |
| @xyflow/react | 2.8 MB | `src/app/app/automations/[id]/builder.tsx` only | already split via `next/dynamic` `ssr:false` in `[id]/page.tsx` | unchanged (pattern already correct); `new/page.tsx` does not use the builder |
| lucide-react | 33 MB (source) | nearly every app page (icons) | barrel imports, tree-shaking only | `experimental.optimizePackageImports: ["lucide-react", "recharts", "@xyflow/react"]` added to `next.config.mjs` → per-module imports, robust against barrel bloat |

Notes:
- Next.js already code-splits per route; the risk was recharts landing in a
  shared commons chunk downloaded by chart-less pages (inbox, contacts, …).
  The dynamic barrel removes that path for all barrel consumers.
- `src/app/app/analytics/page.tsx` imports charts from the barrel → gets the
  split automatically, no page edit needed.
- `src/app/app/overview/page.tsx` imports recharts directly (AreaChart, Bar,
  …) — still static. Left untouched (page content file); flagged as the
  remaining recharts-in-first-load case for the overview route.

## 2. Code splitting changes

- `next.config.mjs`: added `experimental.optimizePackageImports` for
  `lucide-react`, `recharts`, `@xyflow/react` (additive config).
- `src/components/charts/index.ts`: `LineChart`, `BarChart`, `DonutChart`,
  `FunnelChart` re-exports converted to `next/dynamic` with SSR **enabled**
  (default) and a `ChartSkeleton` loading fallback. `MetricCard`,
  `DataTable`, `ChartEmptyState`, `ChartSkeleton`, palette, and all
  type-only exports (`LineChartProps`, `ChartSeries`, …) stay static —
  zero bundle-cost for types. File intentionally kept as `index.ts`
  (no JSX; fallback built with `React.createElement`).
- Public pages (`/`, `/login`, `/signup`, new marketing pages) remain
  server-rendered; no `ssr:false` was added anywhere except the pre-existing
  workflow builder.

## 3. Database

### Indexes added (additive; `prisma db push` applied, verified in
`prisma/dev.db` via `sqlite_master`; no reset, no data touched)

| Index | Justification |
|---|---|
| `Conversation @@index([workspaceId, contactId])` | contact timeline query `where: { workspaceId, contactId }` |
| `Comment @@index([workspaceId, contactId])` | contact timeline query `where: { workspaceId, contactId }` |
| `AuditEvent @@index([workspaceId, action, createdAt])` | audit log `where: { workspaceId, action: startsWith }` + `orderBy: { createdAt: desc }` |

Pre-existing coverage already adequate (spot-checked, no change):
`Contact(workspaceId,leadStatus)`, `Message(conversationId,createdAt)`,
`Suppression @@unique([workspaceId,contactId,channel])` (covers
`where:{workspaceId,contactId}` send-path checks via leftmost prefix),
`OutboundSend(idempotencyKey @unique)`, `CustomerEvent` triple indexes,
`FollowUp(workspaceId,status,scheduledAt)`, `Comment.externalId @unique`.

### N+1 review (hot routes)

- `GET /api/conversations`: single `findMany` with `include: { contact: true,
  messages: { take: 1 } }` — no N+1. Search path does two bounded pre-queries
  in `Promise.all` — acceptable.
- `GET /api/contacts/[id]/timeline`: 5 queries total (conversations+messages
  include, comments, integrations, executions take:200, audits take:200) —
  no per-row queries. `contains: contact.id` on `triggerEvent`/`entity` is a
  scan by nature (substring on JSON-ish text); capped at 200 rows each.
- Message-body `contains` search in conversations list is a SQLite `LIKE
  '%…%'` scan — not indexable with btree; full-text search (FTS5) would be a
  larger change, noted as future work.
- No per-row `await` loops issuing queries were found in list endpoints.

### Pagination: before → after

Already paginated (unchanged): contacts (`page`/`pageSize`, max 100),
conversations (max 100), follow-ups, audit (`limit` max 100), notifications
(`take: 15`).

Added in this workstream:

| Endpoint | Before | After |
|---|---|---|
| `GET /api/conversations/[id]/messages` | **unbounded** `findMany` (long threads could OOM) | cursor pagination: `?limit=` (default 500, max 1000) + `?before=<messageId>`; returns most-recent page in ascending order + additive `hasMore`. Existing inbox client keeps working (same `{ messages }` shape for threads < 500). New test: `pagination.test.ts` (4 tests, pass) |
| `GET /api/workflows` | unbounded | `take: 500` (response shape unchanged) |
| `GET /api/campaigns` | unbounded | `take: 500` |
| `GET /api/contact-segments` | unbounded | `take: 500` |
| `GET /api/message-templates` | unbounded | `take: 500` |
| `GET /api/suppressions` | unbounded | `take: 500` |
| `GET /api/retargeting/campaigns` | unbounded | `take: 500` |
| `GET /api/retargeting/segments` | unbounded | `take: 500` |

Intentionally left unbounded: `contacts/export`, `workspace/export` (file
exports stream full data by design), `workspaces` (membership-bounded),
`integrations` (bounded by 12-provider catalog), `team` (member list),
background-job routes (`process-due`, `reindex`), auth login (single row),
analytics aggregation routes (return buckets, not raw rows).

## 4. Images & fonts

- No `next/image` usage in the repo (only `<img>` is a 36×36 provider avatar
  in `src/app/app/integrations/page.tsx` with fixed dimensions,
  `referrerPolicy="no-referrer"`, `alt=""` — no CLS risk; page file not
  touched). Avatars are remote provider-CDN URLs with variable hosts;
  converting to `next/image` would require allowlisting unpredictable
  `remotePatterns` for marginal gain on a 36px below-fold image — documented
  decision: keep `<img>`.
- OG image: handled by the parallel workstream (`src/app/opengraph-image.tsx`
  + `opengraph-base.png`, `force-static`) — no action needed here.
- Fonts: **system stack only** (`font-family: Inter, ui-sans-serif, system-ui,
  sans-serif` in `globals.css`). No `next/font`, no Google-Fonts `<link>`, no
  `@font-face` anywhere. No render-blocking webfont. `Inter` is a fallback
  name only — nothing is downloaded.

## 5. Cache policy (tenant isolation)

- API routes: no `fetch` caching, no `force-cache`, no `revalidate`, no
  `Cache-Control` headers set anywhere in `src/app/api` or `src/lib/api.ts`.
  App-router API routes are dynamic per request; every route goes through
  `requireWorkspace` (tenant-scoped `where` clauses).
- Client `src/lib/api-client.ts`: plain `fetch`, no SWR/cache layer.
- Only `export const dynamic = "force-static"` in the repo is
  `src/app/opengraph-image.tsx` — a static marketing image with no tenant data.
- **Verdict: no tenant-private data is cached across users.** No
...[truncated 1978 chars]