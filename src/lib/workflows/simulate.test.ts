/**
 * Simulation tests.
 *
 * The vitest global setup creates a fresh `test.db` (via `prisma db push`)
 * and `vitest.setup.ts` points DATABASE_URL at it before test files load.
 *
 * The side-effect-freedom test mocks the provider module's adapter factories
 * and asserts they are never called, plus snapshots row counts (scoped to the
 * test workspace — parallel test files share test.db) on every table a real
 * run could touch and asserts they are unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { db } from "@/lib/db";
import { simulateWorkflow, type SimulationResult } from "./simulate";
import { SAMPLE_EVENT_PRESETS } from "./simulatePresets";

vi.mock("@/lib/integrations/providers", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/integrations/providers")>();
  return {
    ...mod,
    getAdapter: vi.fn(() => {
      throw new Error("getAdapter must never be called during simulation");
    }),
    getWorkspaceAdapter: vi.fn(() => {
      throw new Error("getWorkspaceAdapter must never be called during simulation");
    }),
  };
});

// Re-import after the mock so the spies below observe the mocked module.
import { getAdapter, getWorkspaceAdapter } from "@/lib/integrations/providers";

let seq = 0;
let wfSeq = 0;
const orgNames: string[] = [];

async function makeWorkspace() {
  seq += 1;
  const name = `Sim Test Org ${Date.now()}-${seq}`;
  orgNames.push(name);
  const org = await db.organization.create({ data: { name } });
  return db.workspace.create({
    data: { orgId: org.id, name: `Sim WS ${seq}`, slug: `sim-test-ws-${Date.now()}-${seq}` },
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

/**
 * WorkflowNode/WorkflowEdge ids are globally unique in the database, so
 * makeWorkflow prefixes every test id with a per-workflow marker and
 * returns it as `prefix`. Assertions map simulated ids back to the
 * unprefixed test ids via the helpers below.
 */
function makeWorkflow(workspaceId: string, nodes: TestNode[], edges: TestEdge[], status = "DRAFT") {
  // DRAFT on purpose: simulation must work on unpublished workflows.
  wfSeq += 1;
  const prefix = `simwf${wfSeq}-`;
  const remap = (id: string) => `${prefix}${id}`;
  return db.workflow
    .create({
      data: {
        workspaceId,
        name: `Sim Test WF ${Date.now()}-${wfSeq}`,
        status,
        nodes: {
          create: nodes.map((n) => ({
            id: remap(n.id),
            kind: n.kind,
            type: n.type,
            label: n.label,
            config: JSON.stringify(n.config),
            position: JSON.stringify({ x: 0, y: 0 }),
          })),
        },
        edges: {
          create: edges.map((e) => ({
            id: remap(e.id),
            sourceId: remap(e.sourceId),
            targetId: remap(e.targetId),
            label: e.label ?? "",
            condition: "{}",
          })),
        },
      },
    })
    .then((wf) => ({ ...wf, prefix }));
}

/** Map path nodeIds back to the unprefixed test ids for readable assertions. */
function outcomesOf(result: SimulationResult, prefix: string): Record<string, string> {
  return Object.fromEntries(
    result.path.map((s) => [s.nodeId.replace(prefix, ""), s.outcome])
  );
}

function step(result: SimulationResult, prefix: string, id: string) {
  return result.path.find((s) => s.nodeId === `${prefix}${id}`)!;
}

async function cleanup() {
  if (orgNames.length === 0) return;
  const names = [...orgNames];
  orgNames.length = 0;
  await db.organization.deleteMany({ where: { name: { in: names } } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanup();
});

function messageWorkflowNodes(): { nodes: TestNode[]; edges: TestEdge[] } {
  const nodes: TestNode[] = [
    { id: "t1", kind: "trigger", type: "trigger.new_message", label: "New message", config: {} },
    { id: "c1", kind: "condition", type: "condition.keyword_contains", label: "Says price?", config: { keyword: "price" } },
    { id: "a1", kind: "action", type: "action.send_message", label: "Send pricing", config: { channel: "instagram", body: "Hi {{name}}! It costs $49." } },
    { id: "a2", kind: "action", type: "action.add_tag", label: "Tag hot lead", config: { tag: "hot-lead" } },
  ];
  const edges: TestEdge[] = [
    { id: "e1", sourceId: "t1", targetId: "c1" },
    { id: "e2", sourceId: "c1", targetId: "a1" },
    { id: "e3", sourceId: "a1", targetId: "a2" },
  ];
  return { nodes, edges };
}

describe("simulateWorkflow", () => {
  it("traces a fully matched path and previews the rendered message", async () => {
    const ws = await makeWorkspace();
    const { nodes, edges } = messageWorkflowNodes();
    const wf = await makeWorkflow(ws.id, nodes, edges);

    const result = await simulateWorkflow(wf.id, ws.id, {
      type: "new_message",
      channel: "instagram",
      from: "buyer1",
      name: "Buyer One",
      text: "What is the price?",
    });

    expect(result.matched).toBe(true);
    expect(result.wouldSend).toBe(true);
    expect(outcomesOf(result, wf.prefix)).toEqual({
      t1: "matched",
      c1: "matched",
      a1: "would_execute",
      a2: "would_execute",
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      channel: "instagram",
      to: "buyer1",
      bodyPreview: "Hi Buyer One! It costs $49.",
    });
    expect(step(result, wf.prefix, "a1").detail).toContain("would send_message via instagram to buyer1");
    expect(result.errors).toHaveLength(0);
  });

  it("marks skipped branches when a condition evaluates false", async () => {
    const ws = await makeWorkspace();
    const { nodes, edges } = messageWorkflowNodes();
    const wf = await makeWorkflow(ws.id, nodes, edges);

    const result = await simulateWorkflow(wf.id, ws.id, {
      type: "new_message",
      channel: "instagram",
      from: "buyer1",
      text: "Hello there",
    });

    expect(result.matched).toBe(true);
    expect(result.wouldSend).toBe(false);
    expect(result.messages).toHaveLength(0);
    expect(outcomesOf(result, wf.prefix)).toEqual({
      t1: "matched",
      c1: "skipped",
      a1: "skipped",
      a2: "skipped",
    });
  });

  it("reports no match when no trigger matches the event", async () => {
    const ws = await makeWorkspace();
    const { nodes, edges } = messageWorkflowNodes();
    const wf = await makeWorkflow(ws.id, nodes, edges);

    const result = await simulateWorkflow(wf.id, ws.id, { type: "new_comment", channel: "instagram", text: "nice" });

    expect(result.matched).toBe(false);
    expect(result.wouldSend).toBe(false);
    expect(step(result, wf.prefix, "t1").outcome).toBe("skipped");
    expect(result.warnings.some((w) => w.code === "no_trigger_match")).toBe(true);
  });

  it("supports keyword triggers and if/else branches", async () => {
    const ws = await makeWorkspace();
    const nodes: TestNode[] = [
      { id: "t1", kind: "trigger", type: "trigger.keyword", label: "Keyword", config: { keyword: "help" } },
      { id: "b1", kind: "flow", type: "flow.if_else", label: "Big lead?", config: { expression: "leadScore >= 50" } },
      { id: "a1", kind: "action", type: "action.assign_conversation", label: "To sales", config: { assignee: "sales" } },
      { id: "a2", kind: "action", type: "action.add_tag", label: "Tag nurture", config: { tag: "nurture" } },
    ];
    const edges: TestEdge[] = [
      { id: "e1", sourceId: "t1", targetId: "b1" },
      { id: "e2", sourceId: "b1", targetId: "a1", label: "true" },
      { id: "e3", sourceId: "b1", targetId: "a2", label: "false" },
    ];
    const wf = await makeWorkflow(ws.id, nodes, edges);

    const hot = await simulateWorkflow(wf.id, ws.id, {
      type: "new_message",
      text: "I need help please",
      leadScore: 80,
      conversationId: "conv-1",
    });
    expect(hot.matched).toBe(true);
    expect(outcomesOf(hot, wf.prefix)).toEqual({
      t1: "matched",
      b1: "matched",
      a1: "would_execute",
      a2: "skipped",
    });
    expect(step(hot, wf.prefix, "a1").detail).toContain('would assign conversation conv-1 to "sales"');

    const cold = await simulateWorkflow(wf.id, ws.id, {
      type: "new_message",
      text: "help me",
      leadScore: 10,
      contactId: "contact-9",
    });
    expect(outcomesOf(cold, wf.prefix)).toEqual({
      t1: "matched",
      b1: "matched",
      a1: "skipped",
      a2: "would_execute",
    });
    expect(step(cold, wf.prefix, "a2").detail).toContain("would add tag");
  });

  it("surfaces validation errors for broken graphs", async () => {
    const ws = await makeWorkspace();
    const wf = await makeWorkflow(
      ws.id,
      [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "New message", config: {} },
        { id: "a1", kind: "action", type: "action.send_message", label: "Reply", config: { channel: "instagram", body: "hi" } },
        { id: "a2", kind: "action", type: "action.add_tag", label: "Orphan", config: { tag: "x" } },
      ],
      [
        { id: "e1", sourceId: "t1", targetId: "a1" },
        { id: "e2", sourceId: "a1", targetId: "ghost" }, // dangling edge
      ]
    );

    const result = await simulateWorkflow(wf.id, ws.id, { type: "new_message", text: "hi" });
    expect(result.errors.some((e) => e.message.includes("missing node"))).toBe(true);
    expect(result.errors.some((e) => e.nodeId === `${wf.prefix}a2` && e.message.includes("unreachable"))).toBe(true);
    // The reachable part still simulates.
    expect(result.matched).toBe(true);
    expect(step(result, wf.prefix, "a1").outcome).toBe("would_execute");
  });

  it("flags conflicting conditions as errors and duplicates as warnings", async () => {
    const ws = await makeWorkspace();
    const wf = await makeWorkflow(
      ws.id,
      [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "New message", config: {} },
        { id: "c1", kind: "condition", type: "condition.channel_is", label: "IG?", config: { channel: "instagram" } },
        { id: "c2", kind: "condition", type: "condition.channel_is", label: "FB?", config: { channel: "facebook" } },
        { id: "c3", kind: "condition", type: "condition.keyword_contains", label: "Says price", config: { keyword: "price" } },
        { id: "c4", kind: "condition", type: "condition.keyword_contains", label: "Says price again", config: { keyword: "PRICE" } },
        { id: "a1", kind: "action", type: "action.send_message", label: "Reply", config: { channel: "instagram", body: "hi" } },
      ],
      [
        { id: "e1", sourceId: "t1", targetId: "c1" },
        { id: "e2", sourceId: "c1", targetId: "c2" },
        { id: "e3", sourceId: "c2", targetId: "c3" },
        { id: "e4", sourceId: "c3", targetId: "c4" },
        { id: "e5", sourceId: "c4", targetId: "a1" },
      ]
    );

    const result = await simulateWorkflow(wf.id, ws.id, {
      type: "new_message",
      channel: "instagram",
      text: "what is the price",
    });
    expect(result.errors.some((e) => e.code === "conflicting_conditions" && e.nodeId === `${wf.prefix}c2`)).toBe(true);
    expect(result.warnings.some((w) => w.code === "redundant_condition" && w.nodeId === `${wf.prefix}c4`)).toBe(true);
  });

  it("warns on missing credentials and unsupported capabilities; gates email on approval", async () => {
    const ws = await makeWorkspace();
    // No integrations connected in this fresh workspace.
    const wf = await makeWorkflow(
      ws.id,
      [
        { id: "t1", kind: "trigger", type: "trigger.new_comment", label: "New comment", config: {} },
        { id: "a1", kind: "action", type: "action.reply_comment", label: "Reply", config: { body: "Thanks!" } },
        { id: "a2", kind: "action", type: "action.send_email", label: "Email me", config: { to: "{{email}}", subject: "Hi", body: "Hello" } },
      ],
      [
        { id: "e1", sourceId: "t1", targetId: "a1" },
        { id: "e2", sourceId: "a1", targetId: "a2" },
      ]
    );

    const result = await simulateWorkflow(wf.id, ws.id, {
      type: "new_comment",
      channel: "telegram", // telegram has no reply_comment capability
      from: "user1",
      commentId: "c1",
      text: "nice post",
    });

    expect(result.warnings.some((w) => w.code === "unsupported_capability" && w.nodeId === `${wf.prefix}a1`)).toBe(true);
    expect(result.warnings.some((w) => w.code === "missing_credentials" && w.nodeId === `${wf.prefix}a2`)).toBe(true);
    const emailStep = step(result, wf.prefix, "a2");
    expect(emailStep.outcome).toBe("would_execute");
    expect(emailStep.detail).toContain("would request approval");
    expect(result.wouldSend).toBe(true); // the comment reply would still send

    // AI is never invoked: ai_reply nodes always warn.
    const wf2 = await makeWorkflow(
      ws.id,
      [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "New message", config: {} },
        { id: "a1", kind: "action", type: "action.ai_reply", label: "AI", config: { confidenceThreshold: 0.7 } },
      ],
      [{ id: "e1", sourceId: "t1", targetId: "a1" }]
    );
    const r2 = await simulateWorkflow(wf2.id, ws.id, { type: "new_message", text: "hi" });
    expect(r2.warnings.some((w) => w.code === "ai_not_invoked")).toBe(true);
  });

  it("is provably side-effect-free: no rows, no jobs, no adapter calls", async () => {
    const ws = await makeWorkspace();
    const wf = await makeWorkflow(
      ws.id,
      [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "New message", config: {} },
        { id: "a1", kind: "action", type: "action.send_message", label: "Reply", config: { channel: "instagram", body: "hi {{name}}" } },
        { id: "a2", kind: "action", type: "action.ai_reply", label: "AI", config: { confidenceThreshold: 0.5 } },
        { id: "a3", kind: "action", type: "action.send_email", label: "Email", config: { to: "a@b.c", subject: "s", body: "b" } },
        { id: "a4", kind: "action", type: "action.notify_team", label: "Notify", config: { message: "ping" } },
        { id: "a5", kind: "action", type: "action.create_lead", label: "Lead", config: { name: "Lead {{name}}" } },
      ],
      [
        { id: "e1", sourceId: "t1", targetId: "a1" },
        { id: "e2", sourceId: "a1", targetId: "a2" },
        { id: "e3", sourceId: "a2", targetId: "a3" },
        { id: "e4", sourceId: "a3", targetId: "a4" },
        { id: "e5", sourceId: "a4", targetId: "a5" },
      ]
    );

    // Counts are scoped to this test's own workspace/workflow — never global.
    // Vitest runs test files in parallel forks against the same test.db
    // (see vitest.config.ts), and other files legitimately write rows
    // (e.g. auditEvent) for their own workspaces between our two snapshots.
    // A simulation for this workspace could only ever write rows tagged with
    // this workspace, so scoping keeps the full strength of the assertion
    // while following the project's unique-records convention.
    async function counts() {
      const [message, workflowExecution, executionStep, approvalRequest, escalation, outboundSend, customerEvent, auditEvent, contact, usageRecord] =
        await Promise.all([
          db.message.count({ where: { conversation: { workspaceId: ws.id } } }),
          db.workflowExecution.count({ where: { workflowId: wf.id } }),
          db.executionStep.count({ where: { execution: { workflowId: wf.id } } }),
          db.approvalRequest.count({ where: { workspaceId: ws.id } }),
          db.escalation.count({ where: { workspaceId: ws.id } }),
          db.outboundSend.count({ where: { workspaceId: ws.id } }),
          db.customerEvent.count({ where: { workspaceId: ws.id } }),
          db.auditEvent.count({ where: { workspaceId: ws.id } }),
          db.contact.count({ where: { workspaceId: ws.id } }),
          db.usageRecord.count({ where: { workspaceId: ws.id } }),
        ]);
      return { message, workflowExecution, executionStep, approvalRequest, escalation, outboundSend, customerEvent, auditEvent, contact, usageRecord };
    }

    const before = await counts();
    const result = await simulateWorkflow(wf.id, ws.id, {
      type: "new_message",
      channel: "instagram",
      from: "u1",
      name: "U One",
      text: "hello",
    });
    const after = await counts();

    expect(after).toEqual(before);
    expect(vi.mocked(getAdapter)).not.toHaveBeenCalled();
    expect(vi.mocked(getWorkspaceAdapter)).not.toHaveBeenCalled();
    // ...and the simulation still produced a full prediction.
    expect(result.matched).toBe(true);
    expect(result.path).toHaveLength(6);
    expect(result.wouldSend).toBe(true);
  });

  it("never writes to the database even for invalid graphs", async () => {
    const ws = await makeWorkspace();
    const wf = await makeWorkflow(
      ws.id,
      [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "New message", config: {} },
        { id: "a1", kind: "action", type: "action.send_message", label: "Reply", config: { channel: "instagram" } }, // missing body → validation error
      ],
      [{ id: "e1", sourceId: "t1", targetId: "a1" }]
    );
    // Scoped to this workflow's executions (not a global count): parallel
    // test files share test.db and may write executionStep rows of their own.
    const stepsBefore = await db.executionStep.count({ where: { execution: { workflowId: wf.id } } });
    const result = await simulateWorkflow(wf.id, ws.id, { type: "new_message", text: "hi" });
    expect(step(result, wf.prefix, "a1").outcome).toBe("validation_error");
    expect(await db.executionStep.count({ where: { execution: { workflowId: wf.id } } })).toBe(stepsBefore);
  });
});

describe("SAMPLE_EVENT_PRESETS", () => {
  it("provides the documented presets with well-formed events", () => {
    const ids = SAMPLE_EVENT_PRESETS.map((p) => p.id);
    expect(ids).toEqual(["new_message", "comment_received", "postback", "custom"]);
    for (const p of SAMPLE_EVENT_PRESETS) {
      expect(typeof p.label).toBe("string");
      expect(typeof p.event.type).toBe("string");
    }
    const comment = SAMPLE_EVENT_PRESETS.find((p) => p.id === "comment_received")!;
    expect(comment.event.type).toBe("new_comment");
    expect(comment.event.commentId).toBeTruthy();
  });
});
