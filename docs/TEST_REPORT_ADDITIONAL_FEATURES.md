# FlowPilot AI — Test Report: Additional Features (v0.3.0)

**Date:** 2026-10-20
**Scope:** multi-account architecture, WhatsApp verification/completion, workflow safety, plan entitlements, analytics integrity (Batches A–C).
**Reporting rule:** every check below is marked **passed**, **failed**, or **not run** — with who ran it. Mocked verification is never reported as live verification.

---

## 1. Test suite progression (full runs, `npx vitest run`)

| Stage | Files | Tests | Result | Run by |
|---|---|---|---|---|
| Baseline (v0.2.0, entering the commission) | 72 | 756 | ✅ all passed | coordinator baseline + prior release verification |
| After Batch A + A2 | 79 | 778 | ✅ all passed | coordinator, then **independently re-run by the release owner**: 778/778, exit 0 |
| After Batch B | 82 | 792 | ✅ all passed | coordinator (also confirmed via 3 shards); owner re-ran the 3 new multi-account files: passed |
| After Batch C (final code) | 85 | 818 | ✅ all passed | coordinator, then **independently re-run by the release owner**: 818/818, exit 0 (202s) |
| Final tree (after version bump + docs only) | — | — | tsc + build re-run (below); suite unaffected (no code change) | release owner |

No test was deleted or weakened in this commission. Two pre-existing test *fixtures* were corrected where they encoded the old (buggy/unenforced) behavior — the analytics stage4b test (now asserts the new exclusion default first, then the original numbers verbatim under `includeTestData=1`) and the authz-phasef seat fixture (relied on seats being unenforced). Assertions were not loosened.

## 2. New tests added (+62 over baseline)

**Batch A (7 files, +22):** WhatsApp webhook end-to-end with `whatsapp_business_account` payloads (contact/conversation/message creation); delivery-status transitions incl. failed-with-error; post-restart redelivery dedupe; webhook 500-on-transient-failure → redelivery → exactly-once (message + execution); fan-out ownership (owner / ambiguous-ingests-nowhere); inbound workflow dispatch (PUBLISHED only, keyword + channel gates, demo-mode failure reporting); publish rejects cyclic graph (disabled-node semantics preserved); concurrent + deterministic-race duplicate execution returns `duplicate`; analytics export 403 for AGENT; freeform WhatsApp send through `sendFollowUp` with the **real adapter** built from encrypted test credentials (only Graph HTTP stubbed).

**Batch B (3 files, +14 net):** two WhatsApp accounts in one workspace coexist with distinct, preserved credentials; default-account management; connect-time plan limit (402 shape); adapter resolver pinning/ambiguity/cross-workspace strictness; stubbed-Graph proof a send pinned to account A posts to A's phone-number id and never B's; per-account ingest isolation; ambiguous send fails with zero provider calls; **migration test** — builds a scratch database from the pre-Batch-B schema (via `git show`), proves the old constraint rejects a second same-provider account, applies the new schema with `prisma db push`, asserts all rows/credentials byte-identical and the second account then insertable; inbox/analytics account filters + foreign-workspace integrationId → 403.

**Batch C (+26):** atomic limit concurrency — 8 parallel workflow creates vs 3 slots → exactly 3 succeed / 5×402, final count = limit; 5 parallel seat invites vs 2 seats → 2 succeed; 8 parallel account slots → exactly 3; route-level WhatsApp manual connect at cap → 402, reconnect → 200 (Meta **mocked**); downgrade safety (over-limit workspace keeps all data, creates return 402); analytics integrity — live+mocked+DRY_RUN mixes asserted exactly, both default (excluded) and opt-in (included + flagged); version pinning — publish v1 → enqueue → edit to v2 → enqueued run applies v1, new execution applies v2; activity center aggregation + cross-workspace isolation + honest empty state.

## 3. Other verification (final tree)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Passed (exit 0), run by release owner on the final tree |
| `npx prisma validate` | ✅ Passed ("The schema is valid") |
| `npx prisma generate` | ✅ Passed |
| `npm run build` | ✅ Passed (exit 0), **110/110 pages**, run by release owner on the final tree (ports 3000/3100 confirmed free beforehand) |
| Data safety (each batch) | ✅ Timestamped dev.db backup before every schema push; `PRAGMA integrity_check` = ok; Integration rows 60 → 60; credential fingerprints identical before/after each push |
| Dependency audit — production | ✅ **0 advisories** across 134 production packages (OSV.dev query, 2026-10-20) |
| Dependency audit — dev-only | ⚠️ 11 advisories, all in the test toolchain (vitest 2.1.9 ×2, @vitest/mocker, vite 5.4.21 ×3, esbuild 0.21.5, tinypool ×2, braces, postcss-selector-parser). Dev-only; exploitation requires an exposed local Vitest/Vite server. Fix = vitest 3.x major upgrade — **not** done blindly; recommended as a separate, tested upgrade |
| `npm audit` | ⛔ **Not run** — the sandbox's registry proxy returns 403 (policy). OSV.dev used as the substitute above. Re-run `npm audit --omit=dev` on the target machine to confirm zero |
| Lint (`npm run lint` / ESLint) | ⛔ **Not run — not configured.** No ESLint installation, config, or lint script exists in this project (unchanged from prior releases). TypeScript strict typechecking is the static gate that ran |
| Live WhatsApp test | ⛔ **Not run — blocked.** Requires JOE's Meta credentials (WABA + phone number + permanent token), public HTTPS webhook, and a real handset. Procedure + pass criteria: `docs/INTEGRATIONS_STATUS.md` §2. **WhatsApp is therefore NOT production-ready and is not claimed to be** |
| Live Instagram/Facebook/TikTok tests | ⛔ Not run — same credential dependency; Instagram token-exchange completion has been unconfirmed since 2026-10-18 |

## 4. Failures encountered during the work (all resolved, disclosed)

- Batch B's first full-suite run showed 24 failures — all in *test harnesses* that mocked the pre-Batch-B `getWorkspaceAdapter` seam or the old TikTok `upsert` path; product code was not at fault. Harnesses were migrated to the new seams without weakening assertions; the suite then passed in full and in shards.
- One audit test (message-cap 402) failed once during that broken-mock cascade; it passed in isolation, in every shard, and in all final full runs.
- Two intermediate exec failures during Batch A development (transient, mid-edit states) — the final Batch A state passed coordinator + owner full runs.

## 5. What the numbers do and do not prove

818 passing tests prove the code behaves as specified **against mocked provider HTTP and synthetic webhook payloads**, including the full WhatsApp inbound → dispatch → reply path and multi-account routing. They do **not** prove any live provider exchange. Per JOE's release gate, production-readiness for WhatsApp requires the manual live procedure in `docs/INTEGRATIONS_STATUS.md` §2 to pass on a real Meta app — that gate remains open and is the release's single blocking item, owned by JOE's credentials.
