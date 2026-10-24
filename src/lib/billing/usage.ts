/**
 * Stage 4d — SaaS plan limits: server-side enforced usage metering.
 *
 * - recordUsage(workspaceId, counters): increment the current month's
 *   aggregated UsageRecord. Never throws — metering must never break the
 *   caller's request path.
 * - getUsage(workspaceId, month): read the aggregated row (zeros when none).
 * - resolvePlan(workspaceId): the workspace's Plan row (planId FK first,
 *   then a name match against the legacy `plan` string, then the first
 *   active plan as a last resort).
 * - checkLimit(workspaceId, kind): { allowed, used, limit, resetsAt }.
 * - requirePlanLimit(workspaceId, kind): throws an honest 402 JSON Response
 *   ({ code: "PLAN_LIMIT_EXCEEDED", used, limit, upgradeHint }) when the
 *   workspace has reached its cap. Route handlers wrapped in handler()
 *   return the thrown Response as-is.
 *
 * Batch C — limit semantics + atomic enforcement:
 * - Plan.workflowLimit is the number of DEFINED workflows (Workflow rows)
 *   a workspace may have — that is how the seed data and every UI label
 *   describe it. Workflow EXECUTIONS are metered (UsageRecord.workflowsRun
 *   via recordUsage/trackUsage) but are NEVER blocked by workflowLimit.
 * - Plan.seatLimit is the number of Membership rows; Plan
 *   .connectedAccountLimit is the number of identified, non-DISCONNECTED
 *   Integration rows (see countConnectedAccounts).
 * - Creation paths enforce these caps ATOMICALLY via withWorkflowSlot /
 *   withSeatSlot / withConnectedAccountSlot below: the count and the
 *   insert happen inside ONE Prisma interactive transaction, so two
 *   concurrent creates cannot both observe the same free slot.
 * - Enforcement is create-only: a workspace that is already over a limit
 *   (e.g. after a plan downgrade) keeps every existing row; only NEW
 *   creations are blocked.
 */

import { db } from "../db";
import type { Prisma } from "@prisma/client";

/** Any Prisma client surface the limit helpers can run against: the
 *  global client (reads / legacy checks) or an interactive-transaction
 *  client (atomic check+insert). */
type AnyPrismaClient = typeof db | Prisma.TransactionClient;

export type UsageCounter =
  | "messagesSent"
  | "messagesReceived"
  | "workflowsRun"
  | "automationsRun"
  | "apiCalls";

export type LimitKind = "messages" | "workflows" | "seats";

export interface PlanLimits {
  id: string;
  name: string;
  monthlyMessageLimit: number;
  workflowLimit: number;
  seatLimit: number;
  /** Batch B: max simultaneously connected accounts per workspace. */
  connectedAccountLimit: number;
  features: string[];
}

export interface LimitCheck {
  allowed: boolean;
  used: number;
  limit: number;
  /** ISO timestamp when the current monthly window resets. */
  resetsAt: string;
}

/** Current month as "YYYY-MM" (UTC) — the metering window key. */
export function currentMonth(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

/** When the current monthly window resets: 00:00 UTC on the 1st of next month. */
export function monthResetAt(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return d.toISOString();
}

/**
 * Increment usage counters for the current month. Never throws.
 */
export async function recordUsage(
  workspaceId: string,
  counters: Partial<Record<UsageCounter, number>>
): Promise<void> {
  const increments: Record<string, number> = {};
  const create: Record<string, number> = {};
  for (const [key, value] of Object.entries(counters)) {
    const n = Math.max(0, Math.floor(value ?? 0));
    if (n === 0) continue;
    increments[key] = { increment: n } as unknown as number;
    create[key] = n;
  }
  if (Object.keys(increments).length === 0) return;

  const month = currentMonth();
  try {
    await db.usageRecord.upsert({
      where: { workspaceId_month: { workspaceId, month } },
      create: { workspaceId, month, ...create },
      update: increments as {
        messagesSent?: { increment: number };
        messagesReceived?: { increment: number };
        workflowsRun?: { increment: number };
        automationsRun?: { increment: number };
        apiCalls?: { increment: number };
      },
    });
  } catch (e) {
    // Metering must never break sends / runs / API calls.
    console.warn("[billing] recordUsage failed (non-fatal)", e);
  }
}

/** Aggregated usage for a workspace/month; zeros when nothing was recorded. */
export async function getUsage(workspaceId: string, month: string = currentMonth()) {
  const row = await db.usageRecord.findUnique({
    where: { workspaceId_month: { workspaceId, month } },
  });
  return {
    workspaceId,
    month,
    messagesSent: row?.messagesSent ?? 0,
    messagesReceived: row?.messagesReceived ?? 0,
    workflowsRun: row?.workflowsRun ?? 0,
    automationsRun: row?.automationsRun ?? 0,
    apiCalls: row?.apiCalls ?? 0,
  };
}

function parseFeatures(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Resolve the effective plan for a workspace: planId FK first, then a
 * case-insensitive name match against the legacy `plan` string column,
 * then the first active plan (guaranteed by the seed). Runs against any
 * client so the atomic slot helpers resolve the plan INSIDE their
 * transaction, against the same snapshot as the count + insert.
 */
async function resolvePlanWith(
  client: AnyPrismaClient,
  workspaceId: string
): Promise<PlanLimits> {
  const ws = await client.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true, planId: true },
  });
  if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);

  let plan = ws.planId
    ? await client.plan.findUnique({ where: { id: ws.planId } })
    : null;
  if (!plan) {
    const name = (ws.plan || "").trim().toLowerCase();
    const plans = await client.plan.findMany({ where: { isActive: true } });
    plan =
      plans.find((p) => p.name.toLowerCase() === name) ??
      plans.find((p) => p.name.toLowerCase() === "starter") ??
      plans[0] ??
      null;
  }
  if (!plan) {
    // Seed missing: hard fallback so limits still resolve (Starter values).
    return {
      id: "fallback",
      name: "Starter",
      monthlyMessageLimit: 500,
      workflowLimit: 5,
      seatLimit: 3,
      connectedAccountLimit: 3,
      features: [],
    };
  }
  return {
    id: plan.id,
    name: plan.name,
    monthlyMessageLimit: plan.monthlyMessageLimit,
    workflowLimit: plan.workflowLimit,
    seatLimit: plan.seatLimit,
    connectedAccountLimit: plan.connectedAccountLimit,
    features: parseFeatures(plan.features),
  };
}

/** Resolve the effective plan for a workspace (see resolvePlanWith). */
export async function resolvePlan(workspaceId: string): Promise<PlanLimits> {
  return resolvePlanWith(db, workspaceId);
}

/** Defined workflows = Workflow rows owned by the workspace. This is the
 *  count Plan.workflowLimit caps — NOT executions (see file header). */
async function countDefinedWorkflows(
  client: AnyPrismaClient,
  workspaceId: string
): Promise<number> {
  return client.workflow.count({ where: { workspaceId } });
}

/** Seats in use = Membership rows owned by the workspace. */
async function countSeats(
  client: AnyPrismaClient,
  workspaceId: string
): Promise<number> {
  return client.membership.count({ where: { workspaceId } });
}

/**
 * Batch B — connected-account counting for the plan limit.
 *
 * Counts Integration rows that represent an actual account: a
 * provider-side identity (`externalAccountId` set) that has not been
 * disconnected. Placeholder rows seeded for every provider (DEMO /
 * NEEDS_ATTENTION with no provider identity yet) are NOT accounts and
 * never count — otherwise a fresh workspace would start over its limit.
 */
async function countConnectedAccountsWith(
  client: AnyPrismaClient,
  workspaceId: string
): Promise<number> {
  return client.integration.count({
    where: {
      workspaceId,
      externalAccountId: { not: null },
      status: { not: "DISCONNECTED" },
    },
  });
}

export async function countConnectedAccounts(workspaceId: string): Promise<number> {
  return countConnectedAccountsWith(db, workspaceId);
}

async function workflowCheckWith(
  client: AnyPrismaClient,
  workspaceId: string
): Promise<LimitCheck> {
  const plan = await resolvePlanWith(client, workspaceId);
  const used = await countDefinedWorkflows(client, workspaceId);
  return {
    allowed: used < plan.workflowLimit,
    used,
    limit: plan.workflowLimit,
    resetsAt: monthResetAt(),
  };
}

async function seatCheckWith(
  client: AnyPrismaClient,
  workspaceId: string
): Promise<LimitCheck> {
  const plan = await resolvePlanWith(client, workspaceId);
  const used = await countSeats(client, workspaceId);
  return {
    allowed: used < plan.seatLimit,
    used,
    limit: plan.seatLimit,
    resetsAt: monthResetAt(),
  };
}

async function connectedAccountCheckWith(
  client: AnyPrismaClient,
  workspaceId: string
): Promise<LimitCheck> {
  const plan = await resolvePlanWith(client, workspaceId);
  const used = await countConnectedAccountsWith(client, workspaceId);
  return {
    allowed: used < plan.connectedAccountLimit,
    used,
    limit: plan.connectedAccountLimit,
    resetsAt: monthResetAt(),
  };
}

/** Check a plan limit without throwing. */
export async function checkLimit(
  workspaceId: string,
  kind: LimitKind
): Promise<LimitCheck> {
  const resetsAt = monthResetAt();

  if (kind === "seats") return seatCheckWith(db, workspaceId);

  if (kind === "workflows") {
    // DEFINED workflows (Workflow rows) — never usage.workflowsRun.
    // Executions are metered for reporting only; they do not consume
    // workflowLimit and are never blocked by it.
    return workflowCheckWith(db, workspaceId);
  }

  const plan = await resolvePlan(workspaceId);
  const usage = await getUsage(workspaceId);
  return {
    allowed: usage.messagesSent < plan.monthlyMessageLimit,
    used: usage.messagesSent,
    limit: plan.monthlyMessageLimit,
    resetsAt,
  };
}

/** The one honest 402 shape every plan-limit rejection uses. */
function planLimitExceededResponse(check: LimitCheck, upgradeHint: string): Response {
  return Response.json(
    {
      ok: false,
      code: "PLAN_LIMIT_EXCEEDED",
      used: check.used,
      limit: check.limit,
      resetsAt: check.resetsAt,
      upgradeHint,
    },
    { status: 402 }
  );
}

function upgradeHintFor(kind: LimitKind, check: LimitCheck): string {
  const used = check.used.toLocaleString();
  const limit = check.limit.toLocaleString();
  if (kind === "workflows") {
    return `This workspace has ${used} of its ${limit} defined workflows allowed on its plan. Delete a workflow or ask your administrator to upgrade the plan to create another.`;
  }
  if (kind === "seats") {
    return `This workspace has ${used} of its ${limit} seats allowed on its plan. Remove a member or ask your administrator to upgrade the plan to add another.`;
  }
  return `This workspace has used ${used} of its ${limit} messages allowance for this billing period. Ask your administrator to upgrade the plan to continue.`;
}

function connectedAccountHint(check: LimitCheck): string {
  return `This workspace has connected ${check.used.toLocaleString()} of its ${check.limit.toLocaleString()} connected accounts allowed on its plan. Disconnect an account or ask your administrator to upgrade the plan to connect another.`;
}

/**
 * Enforce a plan limit. Throws an honest 402 JSON Response
 * ({ code: "PLAN_LIMIT_EXCEEDED", used, limit, upgradeHint }) when the
 * workspace has reached its cap. `handler()`-wrapped routes return the
 * thrown Response unchanged — never HTML.
 *
 * NOTE: this is a check-then-act read — fine for the monthly message cap
 * (metered, reconciled after the fact), but creation paths for DEFINED
 * resources (workflows, seats, connected accounts) must use the atomic
 * with*Slot helpers below instead.
 */
export async function requirePlanLimit(
  workspaceId: string,
  kind: LimitKind
): Promise<LimitCheck> {
  const check = await checkLimit(workspaceId, kind);
  if (check.allowed) return check;
  throw planLimitExceededResponse(check, upgradeHintFor(kind, check));
}

/** Check whether the workspace may connect ONE more account. */
export async function checkConnectedAccountLimit(
  workspaceId: string
): Promise<LimitCheck> {
  return connectedAccountCheckWith(db, workspaceId);
}

/**
 * Enforce the connected-account limit BEFORE creating a new account row.
 * Reconnecting an existing account must NOT call this (it adds no row).
 * Throws the same honest 402 JSON shape as requirePlanLimit.
 *
 * NOTE: check-then-act — kept for read-only callers and tests. The
 * connect routes use withConnectedAccountSlot (Batch C), which performs
 * the count and the insert inside one transaction.
 */
export async function requireConnectedAccountRoom(
  workspaceId: string
): Promise<LimitCheck> {
  const check = await checkConnectedAccountLimit(workspaceId);
  if (check.allowed) return check;
  throw planLimitExceededResponse(check, connectedAccountHint(check));
}

/* ------------------------------------------------------------------ */
/* Batch C — atomic (transactional) plan-limit enforcement             */
/* ------------------------------------------------------------------ */

/**
 * Why this closes the create race — stated precisely:
 *
 * The count and the insert run inside ONE Prisma interactive
 * transaction, so they commit or roll back as a unit; a create can
 * never land without its count having been part of the same unit.
 *
 * SQLite (the current deployment target): SQLite permits exactly ONE
 * writer at a time. Through Prisma's SQLite connector, a transaction
 * that loses the writer race does not silently write — it fails
 * (SQLITE_BUSY, surfaced by Prisma as P1008 "Operations timed out"
 * after its lock-wait, or P2028/P2034), and runSlotTransaction RETRIES
 * the whole count+insert from scratch, so the loser re-counts against
 * the winner's committed rows and gets the honest 402.
 *
 * In-process serialization: this app runs as a single Node process
 * (its queue and dedupe stores are in-memory too), so slot operations
 * for the same workspace are additionally queued per workspace
 * (withWorkspaceSlotLock). That keeps same-process bursts — the common
 * case — from colliding on the SQLite writer lock at all; the
 * transaction + retry above remains the guarantee for anything the
 * in-process queue cannot see (e.g. a second process on the same DB).
 *
 * Postgres (future target): under the default READ COMMITTED isolation
 * this code does NOT by itself fully close the race — two concurrent
 * transactions can both count N and both insert. Closing it there
 * requires SERIALIZABLE isolation, a per-workspace advisory lock, or an
 * atomic counter row. That is a documented residual, not a claim:
 * today's runtime is SQLite (see prisma/schema.prisma datasource).
 */

/** Prisma codes / messages that mean "another writer won — retry the
 *  whole count+insert against the newly committed state". */
function isRetryableTxContention(e: unknown): boolean {
  if (e instanceof Response) return false;
  const code = (e as { code?: string } | null)?.code;
  // P1008 = SQLite lock-wait timed out in the connector; P2028 = the
  // transaction could not start in time; P2034 = write conflict.
  if (code === "P1008" || code === "P2028" || code === "P2034") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /database is locked|SQLITE_BUSY|busy/i.test(msg);
}

const SLOT_TX_ATTEMPTS = 5;

async function runSlotTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= SLOT_TX_ATTEMPTS; attempt++) {
    try {
      return await db.$transaction(fn, { maxWait: 10_000, timeout: 10_000 });
    } catch (e) {
      // A thrown Response is a deliberate outcome (402 limit, 409
      // duplicate, …) — roll back and surface it, never retry it.
      if (e instanceof Response) throw e;
      lastError = e;
      if (!isRetryableTxContention(e) || attempt === SLOT_TX_ATTEMPTS) throw e;
      // Jittered backoff so racing writers desynchronize before the
      // recount. (A P1008 attempt has already waited out the connector's
      // lock timeout, so this mainly matters for busy-style failures.)
      await new Promise((r) =>
        setTimeout(r, 25 * attempt + Math.floor(Math.random() * 50))
      );
    }
  }
  throw lastError;
}

/**
 * Per-workspace async queue for slot operations (see the isolation note
 * above): same-workspace slot transactions run one at a time inside
 * this process; different workspaces never block each other.
 */
const slotQueues = new Map<string, Promise<unknown>>();

async function withWorkspaceSlotLock<T>(
  workspaceId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = slotQueues.get(workspaceId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  const tail = prev.then(() => gate);
  slotQueues.set(workspaceId, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (slotQueues.get(workspaceId) === tail) slotQueues.delete(workspaceId);
  }
}

/**
 * Atomically consume one DEFINED-workflow slot: count the workspace's
 * Workflow rows and run `create(tx)` (which must insert the new workflow
 * through the provided transaction client) inside a single transaction.
 * Throws the honest 402 Response when the workspace is at workflowLimit.
 * Create-only: rows that already exist are never touched, so an
 * over-limit workspace (e.g. after a downgrade) keeps all its workflows.
 */
export async function withWorkflowSlot<T>(
  workspaceId: string,
  create: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return withWorkspaceSlotLock(workspaceId, () =>
    runSlotTransaction(async (tx) => {
      const check = await workflowCheckWith(tx, workspaceId);
      if (!check.allowed) {
        throw planLimitExceededResponse(check, upgradeHintFor("workflows", check));
      }
      return create(tx);
    })
  );
}

/**
 * Atomically consume one seat: count Membership rows and run `create(tx)`
 * (which must insert the new membership through the transaction client)
 * inside a single transaction. Throws the honest 402 Response when the
 * workspace is at seatLimit. Create-only — see withWorkflowSlot.
 */
export async function withSeatSlot<T>(
  workspaceId: string,
  create: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return withWorkspaceSlotLock(workspaceId, () =>
    runSlotTransaction(async (tx) => {
      const check = await seatCheckWith(tx, workspaceId);
      if (!check.allowed) {
        throw planLimitExceededResponse(check, upgradeHintFor("seats", check));
      }
      return create(tx);
    })
  );
}

/**
 * Atomically consume one connected-account slot around the creation of a
 * NEW Integration account row.
 *
 * `accountKey` identifies the account being connected. The existence
 * probe runs INSIDE the transaction: if a row for that exact
 * (provider, externalAccountId) already exists, this is a reconnect —
 * `create(tx)` runs WITHOUT consuming a slot (it should update that row;
 * the find-or-create logic lives in the callback). Only when no such row
 * exists is the connected-account count checked, inside the same
 * transaction as the insert. Callers must do all provider/OAuth network
 * work BEFORE calling this — a transaction is never held across I/O.
 */
export async function withConnectedAccountSlot<T>(
  workspaceId: string,
  accountKey: { provider: string; externalAccountId: string },
  create: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return withWorkspaceSlotLock(workspaceId, () =>
    runSlotTransaction(async (tx) => {
      const existing = await tx.integration.findFirst({
        where: {
          workspaceId,
          provider: accountKey.provider,
          externalAccountId: accountKey.externalAccountId,
        },
        select: { id: true },
      });
      if (!existing) {
        const check = await connectedAccountCheckWith(tx, workspaceId);
        if (!check.allowed) {
          throw planLimitExceededResponse(check, connectedAccountHint(check));
        }
      }
      return create(tx);
    })
  );
}
