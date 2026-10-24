/**
 * Stage 4a — human takeover pauses AI/automation per conversation.
 * When a conversation has humanTakeover=true, the ai_reply (and other
 * auto-response) actions must record a SKIPPED ExecutionStep with the honest
 * reason "human takeover active — AI paused", and create/send nothing.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@/lib/db";
import { executeWorkflow, processWorkflowJob } from "./engine";
import { drainQueue, resetQueue } from "@/lib/queue";

let seq = 0;
const orgNames: string[] = [];

async function makeWorkspace() {
  seq += 1;
  const name = `Takeover Test Org ${Date.now()}-${seq}`;
  orgNames.push(name);
  const org = await db.organization.create({ data: { name } });
  return db.workspace.create({
    data: { orgId: org.id, name: `Takeover WS ${seq}`, slug: `takeover-ws-${Date.now()}-${seq}` },
  });
}

function makeWorkflow(workspaceId: string, actionType: string, actionConfig: Record<string, unknown>) {
  const uid = `tw${Date.now()}-${seq}-${Math.floor(Math.random() * 1_000_000)}`;
  const [t1, a1, e1] = [`${uid}-t1`, `${uid}-a1`, `${uid}-e1`];
  return {
    create: db.workflow.create({
      data: {
        workspaceId,
        name: `Takeover WF ${uid}`,
        status: "PUBLISHED",
        nodes: {
          create: [
            { id: t1, kind: "trigger", type: "trigger.new_message", label: "New message", config: "{}", position: '{"x":0,"y":0}' },
            { id: a1, kind: "action", type: actionType, label: "Auto reply", config: JSON.stringify(actionConfig), position: '{"x":0,"y":100}' },
          ],
        },
        edges: {
          create: [{ id: e1, sourceId: t1, targetId: a1, label: "", condition: "{}" }],
        },
      },
    }),
    actionNodeId: a1,
  };
}

async function runAndGetStep(
  workspaceId: string,
  wf: { create: Promise<{ id: string }>; actionNodeId: string },
  conversationId: string
) {
  const workflow = await wf.create;
  const key = `takeover-${Date.now()}-${Math.random()}`;
  const { executionId } = await executeWorkflow({
    workflowId: workflow.id,
    workspaceId,
    event: { type: "new_message", channel: "webchat", from: "visitor-1", text: "hello", conversationId },
    idempotencyKey: key,
  });
  await drainQueue(processWorkflowJob);
  const steps = await db.executionStep.findMany({ where: { executionId }, orderBy: { createdAt: "asc" } });
  return { executionId, steps, actionNodeId: wf.actionNodeId };
}

async function makeConversation(workspaceId: string, humanTakeover: boolean) {
  const contact = await db.contact.create({
    data: { workspaceId, name: `Takeover Contact ${Date.now()}`, channel: "webchat" },
  });
  return db.conversation.create({
    data: {
      workspaceId,
      contactId: contact.id,
      channel: "webchat",
      humanTakeover,
    },
  });
}



beforeEach(() => {
  resetQueue();
});

afterAll(async () => {
  if (orgNames.length > 0) await db.organization.deleteMany({ where: { name: { in: orgNames } } });
  await db.$disconnect();
});

describe("human takeover", () => {
  it("skips action.ai_reply with the takeover reason and creates no message", async () => {
    const ws = await makeWorkspace();
    const convo = await makeConversation(ws.id, true);
    const wf = makeWorkflow(ws.id, "action.ai_reply", {});

    const { steps, actionNodeId } = await runAndGetStep(ws.id, wf, convo.id);
    const aiStep = steps.find((s) => s.nodeId === actionNodeId);
    expect(aiStep).toBeDefined();
    expect(aiStep!.status).toBe("SKIPPED");
    expect(aiStep!.output).toContain("human takeover active — AI paused");

    // Nothing was created on the conversation.
    const msgs = await db.message.count({ where: { conversationId: convo.id } });
    expect(msgs).toBe(0);
  });

  it("skips action.send_message with the takeover reason and sends nothing", async () => {
    const ws = await makeWorkspace();
    const convo = await makeConversation(ws.id, true);
    const wf = makeWorkflow(ws.id, "action.send_message", { channel: "webchat", body: "auto hello" });

    const { steps, actionNodeId } = await runAndGetStep(ws.id, wf, convo.id);
    const sendStep = steps.find((s) => s.nodeId === actionNodeId);
    expect(sendStep).toBeDefined();
    expect(sendStep!.status).toBe("SKIPPED");
    expect(sendStep!.output).toContain("human takeover active — AI paused");

    const msgs = await db.message.count({ where: { conversationId: convo.id } });
    expect(msgs).toBe(0);
  });

  it("lets ai_reply run when there is no takeover (control)", async () => {
    const ws = await makeWorkspace();
    const convo = await makeConversation(ws.id, false);
    // Stage 4c: the mock AI provider reports confidence 0.62, below the
    // default 0.7 threshold — seed a permissive config so this control test
    // exercises the takeover path, not the escalation path.
    await db.aiConfig.upsert({
      where: { workspaceId: ws.id },
      update: { confidenceThreshold: 0.0, requireApproval: false },
      create: { workspaceId: ws.id, confidenceThreshold: 0.0, requireApproval: false },
    });
    const wf = makeWorkflow(ws.id, "action.ai_reply", {});

    const { steps, actionNodeId } = await runAndGetStep(ws.id, wf, convo.id);
    const aiStep = steps.find((s) => s.nodeId === actionNodeId);
    expect(aiStep).toBeDefined();
    expect(aiStep!.status).toBe("SUCCEEDED");
    // The (mock) AI reply is recorded on the conversation.
    const msgs = await db.message.findMany({ where: { conversationId: convo.id } });
    expect(msgs.length).toBe(1);
    expect(msgs[0].aiGenerated).toBe(true);
    expect(msgs[0].mocked).toBe(true);
  });
});
