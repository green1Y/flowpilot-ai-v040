/**
 * Stage 4c engine tests: action.ai_reply grounds replies in the knowledge
 * base (sourcesUsed), and escalates instead of sending when confidence is
 * below the workspace threshold or human approval is required.
 *
 * Uses the mock AI provider (confidence 0.62, deterministic), so the
 * assertions below are about our wiring — not about a live model.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@/lib/db";
import { executeWorkflow, processWorkflowJob } from "./engine";
import { drainQueue, resetQueue } from "@/lib/queue";
import { indexDocument } from "@/lib/ai/chunks";

let seq = 0;
const orgNames: string[] = [];

async function makeWorkspace() {
  seq += 1;
  const name = `Stage4c Org ${Date.now()}-${seq}`;
  orgNames.push(name);
  const org = await db.organization.create({ data: { name } });
  return db.workspace.create({
    data: { orgId: org.id, name: `Stage4c WS ${seq}`, slug: `stage4c-ws-${Date.now()}-${seq}` },
  });
}

async function seedAiConfig(
  workspaceId: string,
  opts: { confidenceThreshold?: number; requireApproval?: boolean } = {}
) {
  return db.aiConfig.upsert({
    where: { workspaceId },
    update: {
      confidenceThreshold: opts.confidenceThreshold ?? 0.0,
      requireApproval: opts.requireApproval ?? false,
    },
    create: {
      workspaceId,
      confidenceThreshold: opts.confidenceThreshold ?? 0.0,
      requireApproval: opts.requireApproval ?? false,
    },
  });
}

/** A conversation the ai_reply action can attach to. */
async function makeConversation(workspaceId: string) {
  const contact = await db.contact.create({
    data: { workspaceId, name: `Stage4c Contact ${seq}`, channel: "webchat" },
  });
  const conversation = await db.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "webchat" },
  });
  return { contact, conversation };
}

async function makeAiReplyWorkflow(workspaceId: string) {
  return db.workflow.create({
    data: {
      workspaceId,
      name: `Stage4c WF ${Date.now()}-${seq}`,
      status: "PUBLISHED",
      nodes: {
        create: [
          { id: "t1", kind: "trigger", type: "trigger.new_message", label: "T", config: "{}", position: "{}" },
          { id: "a1", kind: "action", type: "action.ai_reply", label: "AI", config: "{}", position: "{}" },
        ],
      },
      edges: {
        create: [{ id: "e1", sourceId: "t1", targetId: "a1", label: "", condition: "{}" }],
      },
    },
  });
}

async function runOnce(workspaceId: string, workflowId: string, event: Record<string, unknown>) {
  seq += 1;
  const { executionId } = await executeWorkflow({
    workflowId,
    workspaceId,
    event,
    idempotencyKey: `stage4c-${Date.now()}-${seq}`,
  });
  await drainQueue(processWorkflowJob);
  return db.workflowExecution.findUnique({ where: { id: executionId }, include: { steps: true } });
}

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

describe("action.ai_reply (Stage 4c)", () => {
  it("grounds the reply in knowledge and reports sourcesUsed", async () => {
    const ws = await makeWorkspace();
    await seedAiConfig(ws.id, { confidenceThreshold: 0.0, requireApproval: false });
    const { conversation } = await makeConversation(ws.id);
    const doc = await db.knowledgeDoc.create({
      data: {
        workspaceId: ws.id,
        title: "Shipping policy",
        content: "Standard shipping takes 3 to 5 business days. Express shipping is available at checkout.",
      },
    });
    await indexDocument(doc.id);
    const wf = await makeAiReplyWorkflow(ws.id);

    const execution = await runOnce(ws.id, wf.id, {
      type: "new_message",
      channel: "webchat",
      text: "How long does shipping take?",
      conversationId: conversation.id,
    });

    const step = execution?.steps.find((s) => s.nodeId === "a1");
    expect(step?.status).toBe("SUCCEEDED");
    const output = JSON.parse(step?.output ?? "{}");
    expect(output.sourcesUsed).toContain("Shipping policy");
    expect(output.belowThreshold).toBe(false);
    // The reply was actually sent (outbound message created).
    const sent = await db.message.count({
      where: { conversationId: conversation.id, direction: "OUTBOUND", aiGenerated: true },
    });
    expect(sent).toBe(1);
    // No escalation for a confident reply.
    expect(await db.escalation.count({ where: { workspaceId: ws.id } })).toBe(0);

    await cleanup();
  });

  it("escalates instead of sending when confidence < threshold", async () => {
    const ws = await makeWorkspace();
    // Mock provider confidence is 0.62 — a 0.99 threshold forces escalation.
    await seedAiConfig(ws.id, { confidenceThreshold: 0.99, requireApproval: false });
    const { conversation } = await makeConversation(ws.id);
    const wf = await makeAiReplyWorkflow(ws.id);

    const execution = await runOnce(ws.id, wf.id, {
      type: "new_message",
      channel: "webchat",
      text: "Tell me about pricing",
      conversationId: conversation.id,
    });

    const step = execution?.steps.find((s) => s.nodeId === "a1");
    expect(step?.status).toBe("SKIPPED");
    const output = JSON.parse(step?.output ?? "{}");
    expect(output.reason).toContain("low confidence 0.62 < 0.99");
    expect(output.escalationId).toBeTruthy();

    // No message was created or sent.
    const sent = await db.message.count({
      where: { conversationId: conversation.id, direction: "OUTBOUND" },
    });
    expect(sent).toBe(0);

    const escalation = await db.escalation.findUnique({ where: { id: output.escalationId } });
    expect(escalation?.workspaceId).toBe(ws.id);
    expect(escalation?.status).toBe("OPEN");
    expect(escalation?.conversationId).toBe(conversation.id);
    expect(escalation?.reason).toBe("low confidence 0.62 < 0.99");

    const audit = await db.auditEvent.findFirst({
      where: { workspaceId: ws.id, action: "ai.escalated" },
    });
    expect(audit).toBeTruthy();

    await cleanup();
  });

  it("escalates when human approval is required even at high confidence", async () => {
    const ws = await makeWorkspace();
    await seedAiConfig(ws.id, { confidenceThreshold: 0.0, requireApproval: true });
    const { conversation } = await makeConversation(ws.id);
    const wf = await makeAiReplyWorkflow(ws.id);

    const execution = await runOnce(ws.id, wf.id, {
      type: "new_message",
      channel: "webchat",
      text: "Tell me about pricing",
      conversationId: conversation.id,
    });

    const step = execution?.steps.find((s) => s.nodeId === "a1");
    expect(step?.status).toBe("SKIPPED");
    const output = JSON.parse(step?.output ?? "{}");
    expect(output.reason).toContain("human approval required");

    const sent = await db.message.count({
      where: { conversationId: conversation.id, direction: "OUTBOUND" },
    });
    expect(sent).toBe(0);

    const escalation = await db.escalation.findUnique({ where: { id: output.escalationId } });
    expect(escalation?.status).toBe("OPEN");
    expect(escalation?.reason).toBe("human approval required");

    await cleanup();
  });

  it("uses the fallback escalation behavior without an AiConfig row (default threshold 0.7 > mock 0.62)", async () => {
    const ws = await makeWorkspace();
    const wf = await makeAiReplyWorkflow(ws.id);

    const execution = await runOnce(ws.id, wf.id, {
      type: "new_message",
      channel: "webchat",
      text: "Hello there",
    });

    const step = execution?.steps.find((s) => s.nodeId === "a1");
    expect(step?.status).toBe("SKIPPED");
    const output = JSON.parse(step?.output ?? "{}");
    expect(output.reason).toContain("low confidence 0.62 < 0.70");

    await cleanup();
  });
});
