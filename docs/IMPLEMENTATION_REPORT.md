# FlowPilot AI v0.2.0 — Implementation Report (Batch A, public-beta readiness)

Date: 2026-10-20. Working copy: `~/workspace/flowpilot`.
Baseline: v0.1.1 (658/658 tests). Final: **756/756 tests (72 files)**, tsc clean, build 108/108.

## Workstream A — Git + email verification + password reset + support API

- `git init`, `.gitignore` expanded (`*.log`, `.turbo/`, `coverage/`), local baseline commit + feature commit. No remote, no push.
- Schema (additive; pushed to `prisma/test.db` only; `dev.db` untouched): `User.emailVerified`/`emailVerifiedAt`, `EmailVerification` (codeHash, expiresAt, attempts), `PasswordResetToken` (tokenHash unique, expiresAt, usedAt), `SupportTicket` (workspaceId, userId, subject, message, status).
- `src/lib/email/`: `EmailSender` interface, Resend adapter (`RESEND_API_KEY`/`EMAIL_FROM` from env only, 20s timeout), `sendGuardedEmail()` — honest 503 `EMAIL_NOT_CONFIGURED` when unconfigured, `assertLiveSendAllowed()` before every send.
- Email verification: 6-digit code (SHA-256 at rest, 15-min TTL) issued at signup; `POST /api/auth/verify-email` (timing-safe compare, 410 on expiry, 429 after 5 attempts); `POST /api/auth/verify-email/resend` (60s cooldown + hourly budget); `/api/auth/me` exposes verification status.
- Password reset: `POST /api/auth/password-reset/request` always returns the identical success message (no oracle — byte-identical bodies tested); `POST /api/auth/password-reset/confirm` validates hash/expiry/single-use atomically. Both rate-limited.
- `POST /api/support/tickets` (201 only after DB storage) + `GET` (workspace-scoped).
- `.env.example`: `RESEND_API_KEY`, `EMAIL_FROM` placeholders.

## Workstream B — Demo-mode server-side send blocking

- `src/lib/demo/guard.ts` (shared contract): `assertLiveSendAllowed(workspaceId)` throws 403 when `workspace.isDemo` or `DEMO_MODE=true`.
- Guarded boundaries: `messaging/send.ts` (covers follow-ups, campaigns, retargeting DMs, retries), `messaging/campaigns.ts`, `workflows/engine.ts` (`executeWorkflow` + `runAction` for send_message/reply_comment/send_email/send_whatsapp_template, incl. queue-worker retries), `retargeting/campaigns.ts` (launch + batch, DM types only), email sender. Dry-run/simulation paths intentionally unblocked (zero external calls). Deliberately unguarded: `ai_reply` (local DB only), `call_webhook` (simulated, never fetches), `notify_team` (audit only).
- `Workspace.isDemo` set on signup/workspace creation when `DEMO_MODE=true`.
- `src/lib/demo/reset.ts` + `POST /api/workspaces/[id]/demo/reset` (MANAGER+, membership-enforced, audit-logged).

## Workstream C — Workspace 403s

- Root cause: stale `fp_workspace_id` (localStorage + cookie) caused an unrecoverable 403 loop — logout never cleared the cookie, so a different user inherited the previous workspace id; the provider never cleared/revalidated.
- `src/lib/tenancy.ts`: coded errors — 404 `WORKSPACE_NOT_FOUND` (stale/unknown id), 403 `FORBIDDEN` (existing workspace, not a member), 404 `NO_WORKSPACE` (zero memberships), `INSUFFICIENT_ROLE` on role denials.
- `src/app/api/auth/logout/route.ts` clears the workspace cookie. `src/lib/api-client.ts`: `ApiError.code`, stale-signal recovery (clear + single revalidate, `fp:workspace-stale` event). 228 `requireWorkspace` call sites audited — tenancy intact.

## Workstream D — Theme + settings + support UI

- Theme verified working end-to-end; fixed toggle-icon flash on load.
- Floating "N" investigated exhaustively — does not exist (misread of the static sidebar user chip). Nothing removed.
- Settings reorganized into Account / Workspace / Preferences (new) / Integrations / Plan & Usage (renamed; unimplemented billing honestly labeled) / Help & Support (new; searchable guides + FAQ + ticket form + ticket list) / Privacy & Security. Unavailable controls honestly labeled ("Sign out all" — stateless JWT; self-serve billing — no processor).

## Workstream E — Dashboard/analytics + integration states

- Fixed fully-broken `/app/overview` (API/page shape mismatch — KPIs rendered "—" forever); custom-range 422 (`start`/`end` → `from`/`to`); `channel=all` matching zero rows; date-boundary bug excluding the end day (`expandRangeBound()`).
- Integration state machine: disconnect/failed-callback states no longer masked by "Unavailable"; missing env → "Configuration Required" (EN/AR). Capability matrix intact; no fake connectivity.

## Not changed

- Next.js 15.5.28, React 18.3.1, PostCSS 8.5.30 override — untouched. No dependency upgrades. No destructive DB operations. No secrets committed.
