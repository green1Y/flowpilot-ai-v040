/**
 * Execution safety tests: idempotent execution (same key → same run) and
 * safe retry semantics (same event + fresh key → a NEW run, never a
 * duplicate of the failed one).
 */
import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";
import { executeWorkflow } from "./engine";

let seq = 0;
const cleanup: Array<() => Promise<unknown>> = [];

async function makeWorkflow() {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const org = await db.organization.create({ data: { name: `Retry Org ${tag}` } });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `Retry WS ${seq}`, slug: `retry-ws-${tag}` },
  });
  const wf = await db.workflow.create({
    data: {
      workspaceId: ws.id,
      name: `Retry WF ${seq}`,
      status: "PUBLISHED",
      nodes: {
        create: [
          { id: `t-${tag}`, kind: "trigger", type: "trigger.new_message", label: "New message", config: "{}", position: '{"x":80,"y":120}' },
          { id: `a-${tag}`, kind: "action", type: "action.add_tag", label: "Tag", config: '{"tag":"x"}', position: '{"x":340,"y":120}' },
        ],
      },
      edges: {
        create: [{ id: `e-${tag}`, sourceId: `t-${tag}`, targetId: `a-${tag}`, label: "", condition: "{}" }],
      },
    },
  });
  cleanup.push(async () => {
    await db.workflowExecution.deleteMany({ where: { workflowId: wf.id } });
    await db.workflow.delete({ where: { id: wf.id } });
    await db.workspace.delete({ where: { id: ws.id } });
    await db.organization.delete({ where: { id: org.id } });
  });
  return { ws, wf, tag };
}

const EVENT = { type: "new_message", channel: "instagram", from: "u1", text: "hi" };

afterAll(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe("execution idempotency + retry", () => {
  it("same idempotency key returns the same execution (duplicate)", async () => {
    const { ws, wf } = await makeWorkflow();
    const key = `idem-${Date.now()}-${seq}`;
    const first = await executeWorkflow({
      workflowId: wf.id,
      workspaceId: ws.id,
      event: EVENT,
      idempotencyKey: key,
    });
    expect(first.duplicate).toBe(false);
    const second = await executeWorkflow({
      workflowId: wf.id,
      workspaceId: ws.id,
      event: EVENT,
      idempotencyKey: key,
    });
    expect(second.duplicate).toBe(true);
    expect(second.executionId).toBe(first.executionId);
  });

  it("retry with a fresh key creates a new execution for the same event", async () => {
    const { ws, wf } = await makeWorkflow();
    const base = `retry-${Date.now()}-${seq}`;
    const first = await executeWorkflow({
      workflowId: wf.id,
      workspaceId: ws.id,
      event: EVENT,
      idempotencyKey: `${base}-1`,
    });
    const retry = await executeWorkflow({
      workflowId: wf.id,
      workspaceId: ws.id,
      event: EVENT,
      idempotencyKey: `${base}-2`,
    });
    expect(retry.duplicate).toBe(false);
    expect(retry.executionId).not.toBe(first.executionId);
    const count = await db.workflowExecution.count({ where: { workflowId: wf.id } });
    expect(count).toBe(2);
  });

  it("a disabled node is recorded as SKIPPED and the branch continues", async () => {
    const { ws, wf, tag } = await makeWorkflow();
    await db.workflowNode.update({ where: { id: `a-${tag}` }, data: { disabled: true } });
    try {
      const { processWorkflowJob } = await import("./engine");
      const { executionId } = await executeWorkflow({
        workflowId: wf.id,
        workspaceId: ws.id,
        event: EVENT,
        idempotencyKey: `dis-${Date.now()}-${seq}`,
      });
      await processWorkflowJob({
        id: `job-${Date.now()}`,
        type: "workflow_execution",
        payload: { executionId },
        attempts: 0,
        maxAttempts: 3,
        notBefore: Date.now(),
      });
      const steps = await db.executionStep.findMany({ where: { executionId } });
      const skipped = steps.find((s) => s.nodeId === `a-${tag}`);
      expect(skipped?.status).toBe("SKIPPED");
      expect(skipped?.output).toMatch(/disabled/);
    } finally {
      await db.workflowNode.update({ where: { id: `a-${tag}` }, data: { disabled: false } });
    }
  });
});
