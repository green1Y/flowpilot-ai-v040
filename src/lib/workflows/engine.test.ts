/**
 * Engine tests. The vitest global setup creates a fresh `test.db` (via
 * `prisma db push`) and `vitest.setup.ts` points DATABASE_URL at it before
 * test files load — so static imports below see the right database.
 * Every test uses unique names/keys; created rows are removed afterwards.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@/lib/db";
import { executeWorkflow, processWorkflowJob, evaluateCondition } from "./engine";
import { drainQueue, resetQueue } from "@/lib/queue";

let seq = 0;
const orgNames: string[] = [];

async function makeWorkspace() {
  seq += 1;
  const name = `Engine Test Org ${Date.now()}-${seq}`;
  orgNames.push(name);
  const org = await db.organization.create({ data: { name } });
  return db.workspace.create({
    data: { orgId: org.id, name: `Engine WS ${seq}`, slug: `engine-test-ws-${Date.now()}-${seq}` },
  });
}

interface TestNode {
  id: string;
  kind: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
}
interface TestEdge {
  id: string;
  sourceId: string;
  targetId: string;
  label?: string;
}

function makeWorkflow(workspaceId: string, nodes: TestNode[], edges: TestEdge[], status = "PUBLISHED") {
  return db.workflow.create({
    data: {
      workspaceId,
      name: `Engine Test WF ${Date.now()}-${seq}`,
      status,
      nodes: {
        create: nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          type: n.type,
          label: n.label,
          config: JSON.stringify(n.config),
          position: JSON.stringify({ x: 0, y: 0 }),
        })),
      },
      edges: {
        create: edges.map((e) => ({
          id: e.id,
          sourceId: e.sourceId,
          targetId: e.targetId,
          label: e.label ?? "",
          condition: "{}",
        })),
      },
    },
  });
}

/** Remove everything created by these tests (FK cascades clean up children). */
async function cleanup() {
  if (orgNames.length === 0) return;
  const names = [...orgNames];
  orgNames.length = 0;
  await db.organization.deleteMany({ where: { name: { in: names } } });
}

beforeEach(() => {
  resetQueue();
});

afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("evaluateCondition", () => {
  it("matches keywords case-insensitively", () => {
    expect(
      evaluateCondition("condition.keyword_contains", { keyword: "Price" }, { text: "what is the PRICE?" })
    ).toBe(true);
    expect(
      evaluateCondition("condition.keyword_contains", { keyword: "price" }, { text: "hello there" })
    ).toBe(false);
  });

  it("matches comment phrases", () => {
    expect(evaluateCondition("condition.comment_matches", { phrase: "price" }, { text: "Price please!" })).toBe(true);
    expect(evaluateCondition("condition.comment_matches", { phrase: "price" }, { text: "nice post" })).toBe(false);
  });

  it("checks channel, tags, score, new-contact, intent and qualification", () => {
    expect(evaluateCondition("condition.channel_is", { channel: "instagram" }, { channel: "instagram" })).toBe(true);
    expect(evaluateCondition("condition.channel_is", { channel: "instagram" }, { channel: "webchat" })).toBe(false);
    expect(evaluateCondition("condition.has_tag", { tag: "vip" }, { tags: ["vip", "new"] })).toBe(true);
    expect(evaluateCondition("condition.has_tag", { tag: "vip" }, { tags: [] })).toBe(false);
    expect(evaluateCondition("condition.lead_score_gte", { score: 70 }, { leadScore: 80 })).toBe(true);
    expect(evaluateCondition("condition.lead_score_gte", { score: 70 }, { leadScore: 60 })).toBe(false);
    expect(evaluateCondition("condition.is_new_contact", {}, { isNewContact: true })).toBe(true);
    expect(evaluateCondition("condition.is_new_contact", {}, { isNewContact: false })).toBe(false);
    expect(evaluateCondition("condition.ai_intent", { intent: "pricing" }, { intent: "Pricing" })).toBe(true);
    expect(evaluateCondition("condition.qualification_rule", {}, { qualified: true })).toBe(true);
    expect(evaluateCondition("condition.business_hours", {}, {})).toBe(true);
  });

  it("evaluates if_else expressions", () => {
    expect(evaluateCondition("flow.if_else", { expression: "leadScore >= 50" }, { leadScore: 60 })).toBe(true);
    expect(evaluateCondition("flow.if_else", { expression: "leadScore >= 50" }, { leadScore: 10 })).toBe(false);
    expect(evaluateCondition("flow.if_else", { expression: "text includes price" }, { text: "What is the price?" })).toBe(true);
    expect(evaluateCondition("flow.if_else", { expression: "channel == webchat" }, { channel: "webchat" })).toBe(true);
    expect(evaluateCondition("flow.if_else", { expression: "not a valid (((" }, {})).toBe(false);
  });
});

describe("executeWorkflow", () => {
  it("is idempotent: the second call with the same key returns duplicate:true", async () => {
    const ws = await makeWorkspace();
    const wf = await makeWorkflow(
      ws.id,
      [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "T", config: {} },
        { id: "a1", kind: "action", type: "action.send_message", label: "A", config: { channel: "instagram", body: "hi" } },
      ],
      [{ id: "e1", sourceId: "t1", targetId: "a1" }]
    );
    const key = `idem-${Date.now()}-a`;
    const event = { type: "new_message", channel: "instagram", from: "u1", text: "hello" };

    const first = await executeWorkflow({ workflowId: wf.id, workspaceId: ws.id, event, idempotencyKey: key });
    expect(first.duplicate).toBe(false);

    await drainQueue(processWorkflowJob);

    const second = await executeWorkflow({ workflowId: wf.id, workspaceId: ws.id, event, idempotencyKey: key });
    expect(second.duplicate).toBe(true);
    expect(second.executionId).toBe(first.executionId);

    // Only one execution row exists for the key.
    const count = await db.workflowExecution.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);

    const execution = await db.workflowExecution.findUnique({
      where: { id: first.executionId },
      include: { steps: true },
    });
    expect(execution?.status).toBe("SUCCEEDED");
    expect(execution?.steps).toHaveLength(2);
    expect(execution?.steps.every((s) => s.status === "SUCCEEDED")).toBe(true);

    await cleanup();
  });

  it("refuses to run DRAFT workflows outside dry-run mode", async () => {
    const ws = await makeWorkspace();
    const wf = await makeWorkflow(ws.id, [], [], "DRAFT");
    await expect(
      executeWorkflow({
        workflowId: wf.id,
        workspaceId: ws.id,
        event: { type: "manual" },
        idempotencyKey: `k-${Date.now()}-b`,
      })
    ).rejects.toThrow("DRAFT");
    await cleanup();
  });

  it("dry-run marks steps without performing side effects", async () => {
    const ws = await makeWorkspace();
    const wf = await makeWorkflow(
      ws.id,
      [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "T", config: {} },
        { id: "a1", kind: "action", type: "action.send_message", label: "A", config: { channel: "webchat", body: "hi" } },
        { id: "a2", kind: "action", type: "action.create_lead", label: "Lead", config: { name: "Dry Runner" } },
      ],
      [
        { id: "e1", sourceId: "t1", targetId: "a1" },
        { id: "e2", sourceId: "a1", targetId: "a2" },
      ],
      "DRAFT" // dry-run is allowed on drafts
    );

    const { executionId, duplicate } = await executeWorkflow({
      workflowId: wf.id,
      workspaceId: ws.id,
      event: { type: "new_message", channel: "webchat", text: "hi" },
      idempotencyKey: `dry-${Date.now()}-c`,
      dryRun: true,
    });
    expect(duplicate).toBe(false);

    await drainQueue(processWorkflowJob);

    const execution = await db.workflowExecution.findUnique({
      where: { id: executionId },
      include: { steps: true },
    });
    expect(execution?.status).toBe("DRY_RUN");
    expect(execution?.steps).toHaveLength(3);
    expect(execution?.steps.every((s) => s.status === "SUCCEEDED")).toBe(true);
    const sendStep = execution?.steps.find((s) => s.nodeId === "a1");
    expect(JSON.parse(sendStep?.output ?? "{}").dryRun).toBe(true);

    // No lead was actually created.
    const leads = await db.contact.count({ where: { workspaceId: ws.id, name: "Dry Runner" } });
    expect(leads).toBe(0);

    await cleanup();
  });

  it("follows the false branch of if_else and skips the true branch", async () => {
    const ws = await makeWorkspace();
    const wf = await makeWorkflow(
      ws.id,
      [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "T", config: {} },
        { id: "f1", kind: "flow", type: "flow.if_else", label: "Hot?", config: { expression: "leadScore >= 70" } },
        { id: "a1", kind: "action", type: "action.add_tag", label: "Hot tag", config: { tag: "hot" } },
        { id: "a2", kind: "action", type: "action.add_tag", label: "Cold tag", config: { tag: "cold" } },
      ],
      [
        { id: "e1", sourceId: "t1", targetId: "f1" },
        { id: "e2", sourceId: "f1", targetId: "a1", label: "true" },
        { id: "e3", sourceId: "f1", targetId: "a2", label: "false" },
      ]
    );

    const { executionId } = await executeWorkflow({
      workflowId: wf.id,
      workspaceId: ws.id,
      event: { type: "new_message", leadScore: 10 },
      idempotencyKey: `branch-${Date.now()}-d`,
    });
    await drainQueue(processWorkflowJob);

    const execution = await db.workflowExecution.findUnique({
      where: { id: executionId },
      include: { steps: true },
    });
    expect(execution?.status).toBe("SUCCEEDED");
    const byNode = new Map((execution?.steps ?? []).map((s) => [s.nodeId, s.status]));
    expect(byNode.get("t1")).toBe("SUCCEEDED");
    expect(byNode.get("f1")).toBe("SUCCEEDED");
    expect(byNode.get("a2")).toBe("SUCCEEDED"); // false branch ran
    expect(byNode.get("a1")).toBeUndefined(); // true branch never visited

    await cleanup();
  });
});
