# FlowPilot AI v0.2.0 — Test Report (2026-10-20)

Every command below was executed in `~/workspace/flowpilot` **after the last code change**. Exit codes are actuals.

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm ci` | 0 | Clean install from committed lockfile. |
| 2 | `npx prisma validate` | 0 | "The schema at prisma/schema.prisma is valid" |
| 3 | `npx prisma generate` | 0 | Prisma Client generated. |
| 4 | `npm run typecheck` (`tsc --noEmit`) | 0 | No type errors. |
| 5 | Lint | n/a | Not configured (no eslint). Reported, not claimed. |
| 6 | `npm test` (full suite) | 0 | **756/756 tests pass, 72/72 files.** Baseline was 658/658 (56 files); +98 tests across Batch A (email verification, password reset, support tickets, demo guard/reset, tenancy-stale, overview/export routes, connection states, settings). |
| 7 | `npm run build` | 0 | Production build succeeds; **108/108 pages** (was 103 — new auth/support/demo routes). Dev server stopped before building per repo convention. |
| 8 | `npm audit --omit=dev` / full | blocked | Sandbox registry proxy returns **403 policy_denied** — cannot run here. **Not claimed.** |
| 8b | OSV.dev querybatch (substitute) | 0 | **0 open advisories** on all 12 production deps queried (next@15.5.28, react@18.3.1, react-dom@18.3.1, postcss@8.5.30, @prisma/client@5.22.0, prisma@5.22.0, jsonwebtoken@9.0.3, zod@3.25.76, recharts@2.15.4, @xyflow/react@12.12.0, bcryptjs@2.4.3, lucide-react@0.454.0). 2 advisories on dev-only vitest@2.1.9 (GHSA-5xrq-8626-4rwp, GHSA-82fw-gwwq-j7x9) — both require a network-exposed Vitest server; not applicable; documented, not upgraded (major bump). |
| 9 | Secret grep (src/prisma/scripts) | 0 hits | No API keys, tokens, or private keys. `.env` excluded from archive. |
| 10 | `prisma/dev.db` mtime | — | Unchanged (2026-10-19 11:05) — never written, migrated, or reset during Batch A. Tests used isolated `prisma/test.db` only. |

## Notes

- One transient SQLite lock-timeout was observed in a single parallel test file during one workstream run; it passes standalone and in all full runs since — infrastructure flake, not a regression.
- Live email delivery is untested (no Resend key in this environment); the adapter is real but all send paths honestly return 503 until configured.
- Live provider OAuth/sends remain mocked here (no credentials); unchanged from v0.1.1.
