# FlowPilot AI — Workflow Builder

**Date:** 2026-10-20. State after Batches A–C of the multi-account + WhatsApp commission.
Classifications follow `docs/RELEASE_READINESS_AUDIT.md`: nothing is called working based on UI alone.

## What the builder is

A single node-based editor (`src/app/app/automations/[id]/builder/`, @xyflow/react) — there is no second editor. Free canvas with drag-and-drop from the palette (click-to-add also works), zoom (0.2–2×) and pan, MiniMap, multi-selection, right-click node menu, auto-layout, undo/redo (session), and a Simple ⇄ Advanced toggle (linear list view of the same graph). RTL is supported; small-screen layouts do not collapse panels yet (known limitation).

## Nodes (41 registered types, `src/lib/workflows/nodeRegistry.ts`)

- **10 triggers:** new message, new comment, new conversation, new lead, keyword, tag added, scheduled, webhook, commerce event, manual.
- **9 conditions:** keyword contains, comment matches, is new contact, has tag, lead score ≥, channel is, business hours, AI intent, qualification rule.
- **15 actions:** send message, reply to comment, AI reply, add tag, update CRM field, assign conversation, create lead, internal note, wait, send email, send WhatsApp template, call webhook, notify team, request approval, end.
- **7 flow:** if/else, delay, retry, timeout, dedupe, error branch, end.

Every type has a Zod config schema with defaults; the config panel is schema-driven, validates on apply, and supports `{{variable}}` insertion from trigger outputs plus a per-condition "test step".

## Validation and lifecycle

- **Design-time:** connection rules are enforced while drawing (no self-loops, duplicates, or cycle-creating edges); `validateWorkflow` checks unknown types, missing/invalid config, disconnected (unreachable) nodes, self-loops, if/else branch labels; `readinessReport` adds cycle detection, unknown-variable and WhatsApp 24-hour-window warnings, and credential hints. The builder blocks activation while errors exist.
- **Publish (server-side):** runs the same validation **plus cycle detection** (added in Batch A — previously the publish API could accept a cyclic graph). Publishing writes an **immutable version snapshot** (`WorkflowVersion`, Batch C). Restore-from-version UI is not built yet (deferred, documented).
- **Draft/save:** debounced autosave with optimistic concurrency (409 `SAVE_CONFLICT` with reload/keep-mine). Statuses: DRAFT / PUBLISHED / PAUSED; duplicate deep-copies the graph into a new draft.

## Execution

- Engine: `src/lib/workflows/engine.ts`. Executions are idempotent (DB unique key; concurrent duplicates return the existing run — race fixed in Batch A). Steps record input/output/error and branch decisions; the run inspector overlays per-node status on the canvas and offers safe retry with a fresh key. History shows status, duration, attempts, and explicit **DRY RUN vs LIVE** badges.
- **Version-pinned (Batch C):** an execution records the workflow's version and runs the published snapshot graph when one exists — editing a workflow no longer changes what an already-enqueued run does.
- **Inbound triggers (Batch A):** published workflows now actually fire from real inbound Meta events (message/comment), honoring keyword and channel gates; before Batch A only manual execution existed. Human takeover pauses send actions per conversation; demo workspaces cannot perform live sends (server-side guard, including queue retries).
- **Account targeting (Batch B):** send actions accept a pinned connected account (`integrationId`). Resolution is strict: pinned account → workspace default → single connected account → ambiguous fails honestly. Ambiguous account identity never silently routes through another account.
- **Simulation:** the Simulate mode is fully in-memory — no DB writes, no adapter calls (proven by safety tests) — with per-node outcomes and would-send previews. Dry-run executions go through the real queue and write DRY_RUN rows, labeled as such; analytics exclude dry-runs from production metrics by default (Batch C).

## Known limitations (honest)

- **Delays don't delay yet:** `flow.delay` / `action.wait` are pass-through markers, and no scheduler drives `trigger.scheduled` — a real durable scheduler is deferred. `flow.timeout` is informational; `flow.error_branch` does not yet route failures (failures retry via the queue: max 3 attempts, exponential backoff, then dead-letter).
- **Queue is in-memory:** queue/dead-letter state is lost on process restart (execution-row idempotency is durable in the DB). Multi-process production needs the Redis/BullMQ swap the code names as future work.
- **`condition.business_hours` is a stub:** always returns true (disclosed in its step output).
- **Provider gating is advisory:** the palette lists all node types; readiness warns when a provider isn't connected, and unsupported steps fail honestly at runtime (or file an approval request) rather than sending anything fake. Hard design-time gating remains a documented gap.
- **No file import/export** of workflows (templates and the AI Copilot are the inbound graph paths).
- Per-step durations are not captured (execution-level duration is).
