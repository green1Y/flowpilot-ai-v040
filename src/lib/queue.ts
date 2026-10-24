/**
 * Durable queue abstraction (ARCHITECTURE.md).
 *
 * Local dev: in-memory durable queue with retries (exponential backoff),
 * dead-letter handling, and idempotency-aware enqueue.
 * Production: swap `enqueue`/`startWorker` for a BullMQ + Redis implementation
 * behind this same interface.
 */

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  notBefore: number; // epoch ms — earliest run time (backoff)
  idempotencyKey?: string;
}

export interface DeadLetter extends Job {
  failedAt: number;
  lastError: string;
}

type JobHandler = (job: Job) => Promise<void>;

const queue: Job[] = [];
const deadLetters: DeadLetter[] = [];
const seenIdempotencyKeys = new Set<string>();
let workerTimer: ReturnType<typeof setInterval> | null = null;
let jobSeq = 0;

const BASE_BACKOFF_MS = 1_000;
const WORKER_INTERVAL_MS = 250;

export function enqueue(
  type: string,
  payload: Record<string, unknown>,
  opts: { maxAttempts?: number; idempotencyKey?: string } = {}
): { jobId: string; duplicate: boolean } {
  if (opts.idempotencyKey) {
    if (seenIdempotencyKeys.has(opts.idempotencyKey)) {
      const existing = queue.find((j) => j.idempotencyKey === opts.idempotencyKey);
      return { jobId: existing?.id ?? "duplicate", duplicate: true };
    }
    seenIdempotencyKeys.add(opts.idempotencyKey);
  }
  const job: Job = {
    id: `job_${Date.now()}_${jobSeq++}`,
    type,
    payload,
    attempts: 0,
    maxAttempts: opts.maxAttempts ?? 3,
    notBefore: Date.now(),
    idempotencyKey: opts.idempotencyKey,
  };
  queue.push(job);
  return { jobId: job.id, duplicate: false };
}

/** Start the background worker. Safe to call multiple times (idempotent). */
export function startWorker(handler: JobHandler) {
  if (workerTimer) return;
  workerTimer = setInterval(async () => {
    const now = Date.now();
    const job = queue.find((j) => j.notBefore <= now);
    if (!job) return;
    queue.splice(queue.indexOf(job), 1);
    job.attempts += 1;
    try {
      await handler(job);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (job.attempts >= job.maxAttempts) {
        deadLetters.push({ ...job, failedAt: now, lastError: message });
        console.error(`[queue] job ${job.id} moved to dead-letter after ${job.attempts} attempts: ${message}`);
      } else {
        job.notBefore = now + BASE_BACKOFF_MS * 2 ** (job.attempts - 1);
        queue.push(job);
        console.warn(`[queue] job ${job.id} failed (attempt ${job.attempts}), retrying: ${message}`);
      }
    }
  }, WORKER_INTERVAL_MS);
  // Don't keep the process alive just for the worker in tests.
  if (typeof (workerTimer as any).unref === "function") (workerTimer as any).unref();
}

export function stopWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

export function queueStats() {
  return { pending: queue.length, deadLetters: deadLetters.length };
}

export function getDeadLetters(): DeadLetter[] {
  return [...deadLetters];
}

/** Test helper: run all due jobs inline through the handler (no timers). */
export async function drainQueue(handler: JobHandler) {
  let guard = 0;
  while (queue.length > 0 && guard++ < 500) {
    const job = queue.shift()!;
    job.attempts += 1;
    try {
      await handler(job);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (job.attempts >= job.maxAttempts) {
        deadLetters.push({ ...job, failedAt: Date.now(), lastError: message });
      } else {
        job.notBefore = Date.now();
        queue.push(job);
      }
    }
  }
}

/** Test helper: reset all queue state. */
export function resetQueue() {
  queue.length = 0;
  deadLetters.length = 0;
  seenIdempotencyKeys.clear();
}
