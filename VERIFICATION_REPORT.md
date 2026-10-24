# FlowPilot AI v0.1.1 — Verification Report (2026-10-19)

Every check below was executed against the final tree **after the last code
change**. Exit codes and summaries are actuals, not estimates.

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm ci` | 0 | Clean install from the committed lockfile. |
| 2 | `npx prisma validate` | 0 | "The schema at prisma/schema.prisma is valid" |
| 3 | `npx prisma generate` | 0 | Prisma Client generated successfully. |
| 4 | `npm run typecheck` (`tsc --noEmit`) | 0 | No type errors. |
| 5 | Lint | n/a | **Not configured** — no eslint in this project. Reported, not claimed. |
| 6 | `npm test` (full suite) | 0 | **658/658 tests pass, 57/57 files.** Includes 17 new tests: 13 content-RBAC, 3 team-escalation-guard, 1 signup-rate-limit. |
| 7 | `npm run build` | 0 | Production build succeeds; **103/103 pages** generated. (Dev server on :3100 stopped before building, per repo convention.) |
| 8 | `npm audit --omit=dev` | blocked | Registry proxy returns **403 policy_denied** on the audit endpoint in this sandbox — the command cannot run here. **Not claimed as passing.** |
| 8b | OSV.dev querybatch (honest substitute) | 0 | 0 open advisories on all 16 production dependencies queried (next@15.5.28, react@18.3.1, postcss@8.5.30, prisma, zod, jsonwebtoken, …). 2 advisories on dev-only vitest@2.1.9 (GHSA-5xrq-8626-4rwp, GHSA-82fw-gwwq-j7x9) — both require a network-exposed Vitest UI/API server; not exploitable in this project; documented in RELEASE_NOTES.md. |
| 9 | `npm ls postcss` | 0 | Single `postcss@8.5.30` deduped everywhere; no nested copy under `next/`. The `overrides: {"next":{"postcss":"8.5.30"}}` entry is effective. |
| 10 | `npm ci --dry-run` | 0 | Lockfile consistent with package.json. |
| 11 | Secret-exposure grep | 0 hits | No known secret formats or hardcoded credentials in src/scripts/prisma (paths/counts only; values never printed). `.env` gitignored and excluded from the archive. |
| 12 | Install-script review | n/a | 4 packages with lifecycle scripts, all verified as the packages' legitimate upstream install steps: `@prisma/client` (postinstall client codegen), `@prisma/engines` (postinstall engine binaries), `prisma` CLI (preinstall entrypoint), `esbuild` ×2 (postinstall platform binary). None disabled — `--ignore-scripts` would break the Prisma client and esbuild. |
| 13 | Archive integrity | 0 | ZIP extracts cleanly; contains `package.json`, `package-lock.json` (with the postcss override), `CHANGELOG.md`, `RELEASE_NOTES.md`, `VERIFICATION_REPORT.md`, `.env.example` (placeholders only). Excludes: `node_modules`, `.next`, real `.env`, `prisma/dev.db`, `prisma/test.db`, `tsconfig.tsbuildinfo`. |

## Notes

- The full suite was re-run **after** the final code change (the `linkOrder`
  move); the build was run after that as well. No check is reported from a
  stale run.
- Dev database `prisma/dev.db` was never written, migrated, or reset during
  this work. Tests write only to the isolated `prisma/test.db`.
- `next@15.5.28` / `react@18.3.1` preserved throughout; no major upgrades, no
  `npm audit fix --force`, no blind overrides.
