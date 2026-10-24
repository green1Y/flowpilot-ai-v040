/**
 * Durable jobs tests (Wave 2B). DB-backed, following the existing
 * send.test.ts pattern: unique workspace per file run.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  enqueueJob,
  claimDueJobs,
  completeJob,
  failJob,
  listJobs,
  computeBackoffMs,
  registerJobHandler,
  clearJobHandlers,
  processDueJobs,
} from "./jobs";
import { ensureJobHandlersRegistered } from "./job-handlers";
import { buildImportBatch } from "./imports";

const suffix = `jb${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsId = "";

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: `JB Org ${suffix}` } });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `JB WS ${suffix}`, slug: `jb-${suffix}` },
  });
  wsId = ws.id;
});

describe("computeBackoffMs", () => {
  it("doubles per attempt from a 1s base and caps at 60s", () => {
    expect(computeBackoffMs(1, 0)).toBe(1000);
    expect(computeBackoffMs(2, 0)).toBe(2000);
    expect(computeBackoffMs(3, 0)).toBe(4000);
    expect(computeBackoffMs(7, 0)).toBe(60000);
    expect(computeBackoffMs(20, 0)).toBe(60000);
  });
});

describe("enqueueJob idempotency", () => {
  it("duplicate key returns the same job and never double-enqueues", async () => {
    const key = `jb-key-${suffix}`;
    const first = await enqueueJob("test.echo", { n: 1 }, { workspaceId: wsId, idempotencyKey: key });
    const second = await enqueueJob("test.echo", { n: 2 }, { workspaceId: wsId, idempotencyKey: key });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    const count = await db.backgroundJob.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);
  });
});

describe("claim / complete / fail", () => {
  it("exactly one claim wins: a second claimDueJobs finds nothing claimed", async () => {
    const { jobId } = await enqueueJob("test.once", {}, { workspaceId: wsId });
    const first = await claimDueJobs(wsId);
    expect(first.some((j) => j.id === jobId)).toBe(true);
    expect(first.find((j) => j.id === jobId)?.status).toBe("RUNNING");
    const second = await claimDueJobs(wsId);
    expect(second.some((j) => j.id === jobId)).toBe(false);
    await completeJob(jobId);
    const done = await db.backgroundJob.findUnique({ where: { id: jobId } });
    expect(done?.status).toBe("SUCCEEDED");
  });

  it("notBefore in the future hides the job until it is due", async () => {
    const { jobId } = await enqueueJob("test.future", {}, {
      workspaceId: wsId,
      notBefore: new Date(Date.now() + 60_000),
    });
    const claimed = await claimDueJobs(wsId);
    expect(claimed.some((j) => j.id === jobId)).toBe(false);
    await db.backgroundJob.delete({ where: { id: jobId } });
  });

  it("failJob retries with backoff, then dead-letters after maxAttempts", async () => {
    const { jobId } = await enqueueJob("test.flaky", {}, { workspaceId: wsId, maxAttempts: 2 });
    await claimDueJobs(wsId);
    const retried = await failJob(jobId, "boom");
    expect(retried.status).toBe("QUEUED");
    expect(retried.attempts).toBe(1);
    expect(retried.notBefore.getTime()).toBeGreaterThan(Date.now());
    // Make it due again and fail a second time -> DEAD_LETTER.
    await db.backgroundJob.update({
      where: { id: jobId },
      data: { notBefore: new Date(Date.now() - 1000) },
    });
    await claimDueJobs(wsId);
    const dead = await failJob(jobId, "boom again");
    expect(dead.status).toBe("DEAD_LETTER");
    expect(dead.attempts).toBe(2);
    expect(dead.lastError).toBe("boom again");
  });

  it("listJobs filters by status/type/workspace", async () => {
    const { jobId } = await enqueueJob("test.filter-me", {}, { workspaceId: wsId });
    const byType = await listJobs({ workspaceId: wsId, type: "test.filter-me" });
    expect(byType.some((j) => j.id === jobId)).toBe(true);
    const byStatus = await listJobs({ workspaceId: wsId, type: "test.filter-me", status: "SUCCEEDED" });
    expect(byStatus.some((j) => j.id === jobId)).toBe(false);
    await db.backgroundJob.delete({ where: { id: jobId } });
  });
});

describe("processDueJobs + import_confirm handler", () => {
  it("runs a registered handler and completes the job", async () => {
    clearJobHandlers();
    ensureJobHandlersRegistered();
    let calls = 0;
    registerJobHandler("test.w2b-echo", async () => {
      calls += 1;
      return "ok";
    });
    await enqueueJob("test.w2b-echo", {}, { workspaceId: wsId });
    const result = await processDueJobs(wsId);
    expect(calls).toBe(1);
    expect(result.succeeded).toBeGreaterThanOrEqual(1);
  });

  it("import_confirm processes a preview batch's rows end to end", async () => {
    clearJobHandlers();
    ensureJobHandlersRegistered();
    const built = await buildImportBatch(
      wsId,
      "job-import.csv",
      "name,email\nJob Person,jobperson@example.com\n"
    );
    const rowId = built.rows[0].id!;
    await enqueueJob(
      "import_confirm",
      { batchId: built.batchId, workspaceId: wsId, resolutions: { [rowId]: "create" } },
      { workspaceId: wsId }
    );
    const result = await processDueJobs(wsId);
    expect(result.results.some((r) => r.type === "import_confirm" && r.outcome === "SUCCEEDED")).toBe(true);
    const contact = await db.contact.findFirst({
      where: { workspaceId: wsId, email: "jobperson@example.com" },
    });
    expect(contact?.name).toBe("Job Person");
    const batch = await db.importBatch.findUnique({ where: { id: built.batchId } });
    expect(batch?.status).toBe("CONFIRMED");
    expect(batch?.importedCount).toBe(1);
  });

  it("a job with no handler fails instead of vanishing", async () => {
    clearJobHandlers();
    await enqueueJob("test.no-handler", {}, { workspaceId: wsId, maxAttempts: 5 });
    const result = await processDueJobs(wsId);
    expect(result.results.some((r) => r.type === "test.no-handler" && r.outcome === "FAILED")).toBe(true);
    // Restore handlers for any later tests in this file.
    ensureJobHandlersRegistered();
  });
});
