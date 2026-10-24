/**
 * Simulation safety tests: simulateWorkflow must never write executions,
 * never enqueue jobs, and never call provider adapters — it only reports
 * what WOULD happen.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { db } from "@/lib/db";
import { simulateWorkflow } from "./simulate";

let seq = 0;
const cleanup: Array<() => Promise<unknown>> = [];

async function makeWorkflow() {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const org = await db.organization.create({ data: { name: `Sim Safety Org ${tag}` } });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `Sim Safety WS ${seq}`, slug: `sim-safety-ws-${tag}` },
  });
  const wf = await db.workflow.create({
    data: {
      workspaceId: ws.id,
      name: `Sim Safety WF ${seq}`,
      status: "PUBLISHED",
      nodes: {
        create: [
          { id: `t-${tag}`, kind: "trigger", type: "trigger.new_message", label: "New message", config: "{}", position: '{"x":80,"y":120}' },
          { id: `a-${tag}`, kind: "action", type: "action.send_message", label: "Reply", config: '{"channel":"instagram","body":"Hello {{name}}"}', position: '{"x":340,"y":120}' },
          { id: `b-${tag}`, kind: "action", type: "action.add_tag", label: "Tag", config: '{"tag":"vip"}', position: '{"x":600,"y":120}' },
        ],
      },
      edges: {
        create: [
          { id: `e1-${tag}`, sourceId: `t-${tag}`, targetId: `a-${tag}`, label: "", condition: "{}" },
          { id: `e2-${tag}`, sourceId: `a-${tag}`, targetId: `b-${tag}`, label: "", condition: "{}" },
        ],
      },
    },
  });
  cleanup.push(async () => {
    await db.workflow.delete({ where: { id: wf.id } });
    await db.workspace.delete({ where: { id: ws.id } });
    await db.organization.delete({ where: { id: org.id } });
  });
  return { ws, wf, tag };
}

afterAll(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe("simulateWorkflow safety", () => {
  it("writes zero execution rows and reports would-be sends", async () => {
    const { ws, wf } = await makeWorkflow();
    const before = await db.workflowExecution.count({ where: { workflowId: wf.id } });

    const result = await simulateWorkflow(wf.id, ws.id, {
      type: "new_message",
      channel: "instagram",
      from: "user_9",
      name: "Sam",
      text: "hello",
    });

    const after = await db.workflowExecution.count({ where: { workflowId: wf.id } });
    expect(after).toBe(before);
    expect(result.wouldSend).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0].bodyPreview).toContain("Sam");
    expect(result.note).toMatch(/simulat/i);
  });

  it("never calls provider adapters", async () => {
    const { ws, wf } = await makeWorkflow();
    const providers = await import("@/lib/integrations/providers");
    const getAdapter = vi.spyOn(providers, "getAdapter");
    const getWorkspaceAdapter = vi.spyOn(providers, "getWorkspaceAdapter");
    try {
      await simulateWorkflow(wf.id, ws.id, {
        type: "new_message",
        channel: "instagram",
        from: "user_9",
        name: "Sam",
        text: "hello",
      });
      expect(getAdapter).not.toHaveBeenCalled();
      expect(getWorkspaceAdapter).not.toHaveBeenCalled();
    } finally {
      getAdapter.mockRestore();
      getWorkspaceAdapter.mockRestore();
    }
  });

  it("skips disabled nodes honestly", async () => {
    const { ws, wf, tag } = await makeWorkflow();
    await db.workflowNode.update({ where: { id: `a-${tag}` }, data: { disabled: true } });
    try {
      const result = await simulateWorkflow(wf.id, ws.id, {
        type: "new_message",
        channel: "instagram",
        from: "user_9",
        name: "Sam",
        text: "hello",
      });
      const step = result.path.find((s) => s.nodeId === `a-${tag}`);
      expect(step?.outcome).toBe("skipped");
      expect(step?.detail).toMatch(/disabled/);
      // The branch continues past the disabled node.
      expect(result.path.some((s) => s.nodeId === `b-${tag}`)).toBe(true);
    } finally {
      await db.workflowNode.update({ where: { id: `a-${tag}` }, data: { disabled: false } });
    }
  });
});
