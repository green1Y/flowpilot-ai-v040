/**
 * executeWorkflow idempotency-race tests (Batch A item 8).
 *
 * The pre-fix engine did find-then-create on WorkflowExecution.idempotencyKey
 * without handling the unique-violation race: two concurrent calls with the
 * same key could throw P2002 instead of one returning { duplicate: true }.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/lib/db";
import { resetQueue } from "@/lib/queue";
import { executeWorkflow } from "./engine";

let seq = 0;
const suffix = `idem${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

async function makePublishedWorkflow(): Promise<{ wsId: string; wfId: string }> {
  seq += 1;
  const org = await db.organization.create({ data: { name: `Idem Org ${seq} ${suffix}` } });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `Idem WS ${seq}`, slug: `idem-ws-${seq}-${suffix}` },
  });
  const wf = await db.workflow.create({
    data: {
      workspaceId: ws.id,
      name: `Idem WF ${seq} ${suffix}`,
      status: "PUBLISHED",
      nodes: {
        create: [
          {
            id: `idem-t-${seq}-${suffix}`,
            kind: "trigger",
            type: "trigger.manual",
            label: "Manual",
            config: "{}",
            position: JSON.stringify({ x: 0, y: 0 }),
          },
        ],
      },
    },
  });
  return { wsId: ws.id, wfId: wf.id };
}

beforeEach(() => {
  resetQueue();
});

describe("executeWorkflow idempotency race", () => {
  it("concurrent duplicate calls: exactly one execution, no throw", async () => {
    const { wsId, wfId } = await makePublishedWorkflow();
    const key = `race-${suffix}`;
    const results = await Promise.allSettled([
      executeWorkflow({ workflowId: wfId, workspaceId: wsId, event: { type: "manual" }, idempotencyKey: key }),
      executeWorkflow({ workflowId: wfId, workspaceId: wsId, event: { type: "manual" }, idempotencyKey: key }),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toEqual([]);
    const values = results.map(
      (r) => (r as PromiseFulfilledResult<{ duplicate: boolean; executionId: string }>).value
    );
    expect(values.filter((v) => !v.duplicate).length).toBe(1);
    expect(values.filter((v) => v.duplicate).length).toBe(1);
    expect(values[0].executionId).toBe(values[1].executionId);
    const rows = await db.workflowExecution.count({ where: { idempotencyKey: key } });
    expect(rows).toBe(1);
  });

  it("returns duplicate:true when the create loses the unique race (P2002 path)", async () => {
    const { wsId, wfId } = await makePublishedWorkflow();
    const key = `race-spy-${suffix}`;
    // First call wins and persists the execution.
    const first = await executeWorkflow({
      workflowId: wfId,
      workspaceId: wsId,
      event: { type: "manual" },
      idempotencyKey: key,
    });
    expect(first.duplicate).toBe(false);

    // Simulate the race window: the loser's existence check runs BEFORE
    // the winner's row is visible, so it proceeds to create and hits P2002.
    // (Explicit call-through implementation: a bare spyOn mock on a Prisma
    // delegate returns undefined after the Once value is consumed.)
    const original = db.workflowExecution.findUnique.bind(db.workflowExecution);
    const spy = vi.spyOn(db.workflowExecution, "findUnique");
    spy.mockImplementation(((args: unknown) => original(args as never)) as never);
    spy.mockResolvedValueOnce(null as never);
    try {
      const second = await executeWorkflow({
        workflowId: wfId,
        workspaceId: wsId,
        event: { type: "manual" },
        idempotencyKey: key,
      });
      expect(second.duplicate).toBe(true);
      expect(second.executionId).toBe(first.executionId);
    } finally {
      spy.mockRestore();
    }
    const rows = await db.workflowExecution.count({ where: { idempotencyKey: key } });
    expect(rows).toBe(1);
  });
});
