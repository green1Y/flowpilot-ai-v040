# FlowPilot AI — Final Audit for Public Beta Readiness

Date: 2026-10-20. Working copy: `~/workspace/flowpilot` (verified: this is the
current v0.1.1 tree — Next.js 15.5.28, React 18.3.1, 658/658 tests — not a backup
copy; backups live in `~/workspace/flowpilot-backup-pre-next15/`).

## 0. Backup procedure (do this before any implementation)

```bash
# Full source backup (excluding node_modules/.next)
/home/hatch: cp -r ~/workspace/flowpilot ~/workspace/flowpilot-backup-beta-20261020/ --exclude=node_modules --exclude=.next  # (use tar --exclude instead)
# Database backup
cp ~/workspace/flowpilot/prisma/dev.db ~/workspace/flowpilot-backup-beta-20261020-dev.db
```

Never run `prisma db push`, `prisma migrate`, or any destructive DB command
against `prisma/dev.db` without a verified backup. Tests write only to the
isolated `prisma/test.db`.

## 1. Issue inventory

### Critical

1. **No email verification** (`Phase 2`). There is no verification code, no
   verification link, no email-sending code path at all. The `email` integration
   is documented as SIMULATED. Public beta requires a real provider.
   → Needs: provider choice + API key + verified sending domain (JOE).
2. **Demo mode does not block real sends server-side** (`Phase 3`).
   `DEMO_MODE=true` currently gates only demo-data seeding (`src/lib/demo.ts`)
   and demo labels on analytics routes. The actual send paths — messaging
   (`src/lib/messaging/`), workflow execution engine, campaign sending — never
   check demo mode. A demo workspace with a connected provider could perform
   real external sends. Enforcement must be added at every send boundary.
3. **No password reset** (`Phase 2`). Only i18n dictionary strings exist; no
   token issuance, no reset endpoint, no email.

### High

4. **Workspace 403s** (`Phase 4`). `src/lib/tenancy.ts` throws 403 when the
   caller is not a member of the requested workspace. Signup creates org +
   workspace + OWNER membership in a transaction (correct). The reported 403s
   on workspace-dependent requests (analytics, notifications, integrations)
   need reproduction: likely stale `x-workspace-id` / cookie after
   workspace changes. Fix: safe stale-selection handling + regression tests
   for stale IDs, missing memberships, cross-workspace access. Never weaken
   tenancy to fix this.
5. **No support backend** (`Phase 8`). A support form with a truthful
   stored-or-sent confirmation does not exist. Options: minimal DB-backed
   ticket table, or documented "contact via X". No fake confirmations.
6. **Login email-existence oracle** — already fixed in v0.1.1 (dummy bcrypt
   compare). Verify still intact.

### Medium

7. **GitHub readiness** (`Phase 12`). Not a git repository. `.gitignore`
   exists and covers `.env`, `*.db`, `node_modules`, `.next` — adequate but
   should gain: build logs, `*.log`, `.turbo`, coverage. No secrets found in
   the tree (verified 2026-10-19).
8. **Database portability** (`Phase 12`). Prisma schema targets SQLite
   (`prisma/dev.db`). Fine for single-server/VPS deployment; serverless
   (Vercel/Netlify) needs managed PostgreSQL. The schema is portable —
   migration path is: change `datasource db provider`, set `DATABASE_URL`,
   `prisma db push`. Decision needed: deployment target.
9. **Theme selector** (`Phase 5`). A dark/light toggle exists in
   `Topbar.tsx` with `localStorage` persistence (`fp_theme`) and applies a
   `light` class on `<html>`. Appears functional; needs visual verification
   across pages, not a rewrite.
10. **Floating "N" element** (`Phase 5`). Not located in source via
    fixed-position selectors. Likely the user-avatar initial or a help
    widget — needs a visual pass to identify, then integrate or remove.

### Low / verification-needed

11. Dashboard filters, analytics CSV export, chart/filter consistency
    (`Phase 6/7`) — functional per v0.1.1 tests; needs a UI walkthrough.
12. Integration `Unavailable` states (`Phase 9`) — capability matrix exists;
    re-verify each card's state machine against missing-config scenarios.

## 2. What is already solid (do not regress)

- 658/658 tests, tsc clean, build 103/103, Next 15.5.28 (0 advisories),
  PostCSS 8.5.30 override, RBAC gates (inbox AGENT+, 13 content endpoints),
  JWT/ENCRYPTION_KEY fail-closed in production, rate limiting (login, signup),
  webhook HMAC verification, idempotent sends, tenant isolation, EN/AR + RTL.

## 3. External prerequisites (need JOE)

| # | Needed | Blocks |
|---|--------|--------|
| 1 | Email provider choice (Resend recommended) + API key + verified sending domain | Phase 2 live verification |
| 2 | Deployment target (VPS vs Vercel/serverless) | Phase 12 DB decision |
| 3 | PostgreSQL now or defer (only if serverless) | Phase 12 |
| 4 | GitHub repo (name, public/private) — assistant will not push | Phase 12 |
| 5 | Meta/TikTok credentials + app review (unchanged, still pending) | Live integrations |

Without #1, email verification and password reset ship fully implemented but
in an honest "configuration required" state — no bypasses, no faked sends.

## 4. Proposed implementation plan (no destructive steps)

- **Batch A (no credentials needed):** backup → `git init` (local only, no
  push) → email verification + password reset (provider-abstracted, Resend
  adapter, honest unconfigured state) → demo-mode server-side send blocking
  at every send boundary + demo reset scoped to workspace → workspace 403
  investigation + stale-selection handling + regression tests → theme visual
  verification → floating-N identification → settings reorganization → DB-backed
  support form → dashboard/analytics UI pass → integration state-machine
  re-verification → full verification battery → new ZIP.
- **Batch B (needs JOE):** Resend key + domain → flip email live;
  deployment target → Postgres migration path + `docs/DEPLOYMENT.md`;
  GitHub push (JOE's action).

Nothing in Batch A is destructive or irreversible. Work stops and reports if
anything turns up unfixable.

## 5. Batch A implementation status (2026-10-20)

All Batch A items are implemented and verified in the working copy
(`~/workspace/flowpilot`, v0.2.0). Full suite: **756/756 tests (72 files)**,
tsc clean, production build **108/108 pages**.

| # | Item | Status |
|---|------|--------|
| 1 | No email verification | DONE — provider-abstracted sender (Resend adapter), 6-digit code, 15-min expiry, 5-attempt lockout, 60s resend cooldown, honest 503 when unconfigured. Needs JOE: Resend key + verified domain for live sends. |
| 2 | Demo mode send blocking | DONE — `assertLiveSendAllowed()` enforced at every send boundary (messaging, workflow executors incl. retries, campaigns, retargeting DMs, email). `Workspace.isDemo` set on signup when DEMO_MODE=true. `POST /api/workspaces/[id]/demo/reset` (MANAGER+, workspace-scoped). 23 new tests. |
| 3 | No password reset | DONE — hashed single-use tokens, 1h expiry, no-oracle request endpoint, rate limited. Needs JOE: email provider (same as #1) for live delivery. |
| 4 | Workspace 403s | DONE — root cause was a stale-selection 403 loop (logout never cleared the workspace cookie). Server now returns coded 404/403; client clears stale ids and revalidates once. 7 regression tests. |
| 5 | No support backend | DONE — DB-backed `SupportTicket`, 201 only after storage. UI in Help & Support. |
| 6 | Login oracle | Verified still fixed (v0.1.1). |
| 7 | GitHub readiness | DONE — `git init`, expanded .gitignore, local baseline commit. No remote, no push (JOE's action). |
| 8 | DB portability | Unchanged — SQLite, portable schema. Needs JOE: deployment target decision. |
| 9 | Theme selector | Verified working; one icon-flash bug fixed. |
| 10 | Floating "N" | Investigated — does not exist (misread of the static sidebar user chip). Nothing to remove. |
| 11 | Dashboard/analytics UI | DONE — fixed fully-broken overview dashboard (API/page shape mismatch), custom-range 422, `channel=all` no-match, end-day date-boundary exclusion. CSV export verified. |
| 12 | Integration states | DONE — disconnect/failure states no longer masked by "Unavailable"; missing env now reads "Configuration Required" (EN/AR). |

External prerequisites unchanged from section 3 (email provider, deployment target, GitHub repo, Meta/TikTok credentials).
