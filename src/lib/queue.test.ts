import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueue,
  drainQueue,
  resetQueue,
  getDeadLetters,
  queueStats,
  type Job,
} from "./queue";

beforeEach(() => {
  resetQueue();
});

describe("queue", () => {
  it("runs an enqueued job through the handler", async () => {
    const seen: string[] = [];
    const { jobId, duplicate } = enqueue("test.echo", { n: 1 });
    expect(duplicate).toBe(false);
    expect(jobId).toBeTruthy();

    await drainQueue(async (job: Job) => {
      seen.push(`${job.type}:${JSON.stringify(job.payload)}`);
    });

    expect(seen).toEqual(['test.echo:{"n":1}']);
    expect(queueStats().pending).toBe(0);
  });

  it("retries a failing handler then moves the job to dead-letter", async () => {
    let calls = 0;
    enqueue("test.flaky", {}, { maxAttempts: 2 });

    await drainQueue(async () => {
      calls += 1;
      throw new Error("boom");
    });

    expect(calls).toBe(2);
    expect(queueStats().pending).toBe(0);
    const dead = getDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0].type).toBe("test.flaky");
    expect(dead[0].lastError).toBe("boom");
    expect(dead[0].attempts).toBe(2);
  });

  it("recovers when a retry eventually succeeds", async () => {
    let calls = 0;
    enqueue("test.recover", {}, { maxAttempts: 3 });

    await drainQueue(async () => {
      calls += 1;
      if (calls < 2) throw new Error("first attempt fails");
    });

    expect(calls).toBe(2);
    expect(getDeadLetters()).toHaveLength(0);
    expect(queueStats().pending).toBe(0);
  });

  it("deduplicates enqueue by idempotency key", async () => {
    const first = enqueue("test.job", { a: 1 }, { idempotencyKey: "idem-1" });
    const second = enqueue("test.job", { a: 1 }, { idempotencyKey: "idem-1" });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    let runs = 0;
    await drainQueue(async () => {
      runs += 1;
    });
    expect(runs).toBe(1);
  });
});
