/**
 * Durable background jobs (v0.4.0, Wave 2B).
 *
 * DB-backed job system on the BackgroundJob model. This is ADDITIVE: the
 * in-memory workflow-engine queue in src/lib/queue.ts is untouched, and
 * this module is deliberately NOT wired into the workflow engine.
 * New job types should use this durable path (survives restarts, exactly-
 * once claim, retries with backoff, dead-lettering).
 *
 * Lifecycle: QUEUED -> RUNNING -> SUCCEEDED
 *                     \-> QUEUED (retry, notBefore = now + backoff)
 *                     \-> DEAD_LETTER (attempts exhausted)
 *
 * Claim guarantee: claimDueJobs() runs inside one transaction and claims
 * each job with a conditional update (status = QUEUED -> RUNNING). Only a
 * claim whose update affects exactly one row is returned, so even two
 * worker runs racing on the same due set can never both claim one job.
 * (SQLite serializes writers, and the conditional update is the second,
 * belt-and-braces guard.)
 */

import { db } from "./db";

export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD_LETTER";

export interface EnqueueOptions {
  workspaceId?: string | null;
  maxAttempts?: number;
  idempotencyKey?: string;
  /** Earliest time the job may be claimed (default: now). */
  notBefore?: Date;
}

export interface EnqueueResult {
  jobId: string;
  duplicate: boolean;
}

export interface JobHandlerContext {
  jobId: string;
  workspaceId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<unknown>;

/** Registry of handlers by job-type string. See src/lib/job-handlers.ts. */
const handlers = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function getJobHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

/** For tests: clear the registry (production handlers re-register on import). */
export function clearJobHandlers(): void {
  handlers.clear();
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Exponential backoff with jitter: base 1s * 2^(attempts-1), capped at 60s.
 * `jitterFraction` (0..1) scales a uniform random addition; pass 0 for a
 * deterministic value in tests. Default jitter is up to +25%.
 */
export function computeBackoffMs(attempts: number, jitterFraction = 0.25): number {
  const exp = BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1));
  const capped = Math.min(exp, MAX_BACKOFF_MS);
  if (jitterFraction <= 0) return capped;
  return Math.round(capped * (1 + Math.random() * jitterFraction));
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Enqueue a job. With an idempotencyKey, a second call with the same key
 * returns { duplicate: true } and never creates a second row — including
 * under a race, where the unique constraint is caught and the existing
 * row is re-read.
 */
export async function enqueueJob(
  type: string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {}
): Promise<EnqueueResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  if (opts.idempotencyKey) {
    const existing = await db.backgroundJob.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
    });
    if (existing) return { jobId: existing.id, duplicate: true };
    try {
      const job = await db.backgroundJob.create({
        data: {
          workspaceId: opts.workspaceId ?? null,
          type,
          payload: JSON.stringify(payload),
          maxAttempts,
          notBefore: opts.notBefore ?? new Date(),
          idempotencyKey: opts.idempotencyKey,
        },
      });
      return { jobId: job.id, duplicate: false };
    } catch (e) {
      // Race: another worker created the keyed row between find + create.
      if (e instanceof Error && "code" in e && (e as { code?: string }).code === "P2002") {
        const raced = await db.backgroundJob.findUnique({
          where: { idempotencyKey: opts.idempotencyKey },
        });
        if (raced) return { jobId: raced.id, duplicate: true };
      }
      throw e;
    }
  }
  const job = await db.backgroundJob.create({
    data: {
      workspaceId: opts.workspaceId ?? null,
      type,
      payload: JSON.stringify(payload),
      maxAttempts,
      notBefore: opts.notBefore ?? new Date(),
    },
  });
  return { jobId: job.id, duplicate: false };
}

/**
 * Claim all jobs due now (status QUEUED, notBefore <= now), optionally
 * scoped to one workspace. Each claim is a conditional QUEUED -> RUNNING
 * transition inside a single transaction; only successfully transitioned
 * jobs are returned.
 */
export async function claimDueJobs(workspaceId?: string | null, limit = 100) {
  const now = new Date();
  return db.$transaction(async (tx) => {
    const due = await tx.backgroundJob.findMany({
      where: {
        status: "QUEUED",
        notBefore: { lte: now },
        ...(workspaceId ? { workspaceId } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: Math.max(1, limit),
    });
    const claimed = [];
    for (const job of due) {
      const updated = await tx.backgroundJob.updateMany({
        where: { id: job.id, status: "QUEUED" },
        data: { status: "RUNNING" },
      });
      if (updated.count === 1) claimed.push({ ...job, status: "RUNNING" as const });
    }
    return claimed;
  });
}

export async function completeJob(jobId: string) {
  return db.backgroundJob.update({
    where: { id: jobId },
    data: { status: "SUCCEEDED", lastError: null },
  });
}

/**
 * Record a failed attempt. Attempts are incremented; once attempts reach
 * maxAttempts the job goes DEAD_LETTER, otherwise it returns to QUEUED
 * with notBefore = now + exponential backoff (+ jitter) for a later claim.
 */
export async function failJob(jobId: string, error: string) {
  const job = await db.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job not found: ${jobId}`);
  const attempts = job.attempts + 1;
  if (attempts >= job.maxAttempts) {
    return db.backgroundJob.update({
      where: { id: jobId },
      data: { status: "DEAD_LETTER", attempts, lastError: error },
    });
  }
  const notBefore = new Date(Date.now() + computeBackoffMs(attempts));
  return db.backgroundJob.update({
    where: { id: jobId },
    data: { status: "QUEUED", attempts, lastError: error, notBefore },
  });
}

export interface ListJobsFilters {
  workspaceId?: string;
  status?: string;
  type?: string;
  limit?: number;
}

export async function listJobs(filters: ListJobsFilters = {}) {
  return db.backgroundJob.findMany({
    where: {
      ...(filters.workspaceId ? { workspaceId: filters.workspaceId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.type ? { type: filters.type } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(500, Math.max(1, filters.limit ?? 100)),
  });
}

export interface ProcessDueResult {
  claimed: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  results: { jobId: string; type: string; outcome: string; detail?: string }[];
}

/**
 * Claim due jobs and run their registered handlers. A job with no
 * registered handler fails (and eventually dead-letters) rather than
 * being silently dropped — an unhandled type is a bug to surface.
 * One bad job never stops the rest of the batch.
 */
export async function processDueJobs(workspaceId?: string | null): Promise<ProcessDueResult> {
  const claimed = await claimDueJobs(workspaceId);
  const results: ProcessDueResult["results"] = [];
  let succeeded = 0;
  let failed = 0;
  for (const job of claimed) {
    const handlerFn = handlers.get(job.type);
    if (!handlerFn) {
      const after = await failJob(job.id, `no handler registered for job type "${job.type}"`);
      if (after.status === "DEAD_LETTER") {
        results.push({ jobId: job.id, type: job.type, outcome: "DEAD_LETTER" });
      } else {
        failed += 1;
        results.push({ jobId: job.id, type: job.type, outcome: "FAILED", detail: "no handler registered" });
      }
      continue;
    }
    try {
      const detail = await handlerFn({
        jobId: job.id,
        workspaceId: job.workspaceId,
        payload: parsePayload(job.payload),
        attempts: job.attempts,
      });
      await completeJob(job.id);
      succeeded += 1;
      results.push({
        jobId: job.id,
        type: job.type,
        outcome: "SUCCEEDED",
        detail: typeof detail === "string" ? detail : undefined,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown handler error";
      const after = await failJob(job.id, message);
      if (after.status === "DEAD_LETTER") {
        results.push({ jobId: job.id, type: job.type, outcome: "DEAD_LETTER", detail: message });
      } else {
        failed += 1;
        results.push({ jobId: job.id, type: job.type, outcome: "FAILED", detail: message });
      }
    }
  }
  return {
    claimed: claimed.length,
    succeeded,
    failed,
    deadLettered: results.filter((r) => r.outcome === "DEAD_LETTER").length,
    results,
  };
}

export function serializeJob(job: {
  id: string;
  workspaceId: string | null;
  type: string;
  payload: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  notBefore: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    type: job.type,
    payload: parsePayload(job.payload),
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    notBefore: job.notBefore.toISOString(),
    lastError: job.lastError,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
