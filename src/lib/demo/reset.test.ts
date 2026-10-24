/**
 * resetDemoData tests (Batch B public-beta readiness).
 *
 * - Deletes only demo-identified rows in the target workspace:
 *   contacts/conversations tagged "demo", workflows/campaigns named
 *   "Demo:*", integrations with DEMO status (+ their child rows).
 * - Leaves non-demo rows in the target workspace untouched.
 * - Leaves other workspaces completely untouched (workspaceId scoping).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { resetDemoData } from "./reset";

const suffix = `reset${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsA = "";
let wsB = "";

async function seedDemoSet(workspaceId: string, label: string) {
  const contact = await db.contact.create({
    data: {
      workspaceId,
      name: `Demo Contact ${label}`,
      channel: "facebook",
      tags: JSON.stringify(["demo"]),
    },
  });
  const convo = await db.conversation.create({
    data: {
      workspaceId,
      contactId: contact.id,
      channel: "facebook",
      tags: JSON.stringify(["demo"]),
    },
  });
  await db.message.createMany({
    data: [
      { conversationId: convo.id, direction: "INBOUND", body: "hi" },
      { conversationId: convo.id, direction: "OUTBOUND", body: "hello", mocked: true },
    ],
  });
  const wf = await db.workflow.create({
    data: { workspaceId, name: `Demo: Workflow ${label}`, status: "DRAFT" },
  });
  const node = await db.workflowNode.create({
    data: { workflowId: wf.id, kind: "trigger", type: "trigger.new_message", label: "T" },
  });
  await db.workflowEdge.create({
    data: { workflowId: wf.id, sourceId: node.id, targetId: node.id },
  });
  const exec = await db.workflowExecution.create({
    data: {
      workflowId: wf.id,
      triggerEvent: "{}",
      status: "SUCCEEDED",
      idempotencyKey: `demo-exec-${suffix}-${label}`,
      dryRun: true,
    },
  });
  await db.executionStep.createMany({
    data: [
      { executionId: exec.id, nodeId: node.id, nodeLabel: "T", status: "SUCCEEDED", input: "{}", output: "{}" },
      { executionId: exec.id, nodeId: node.id, nodeLabel: "T2", status: "SUCCEEDED", input: "{}", output: "{}" },
    ],
  });
  const campaign = await db.campaign.create({
    data: {
      workspaceId,
      name: `Demo: Campaign ${label}`,
      channel: "facebook",
      messageType: "freeform",
      status: "DRAFT",
    },
  });
  await db.campaignRecipient.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      status: "PENDING",
      idempotencyKey: `demo-rec-${suffix}-${label}`,
    },
  });
  await db.integration.create({
    data: { workspaceId, provider: "facebook", status: "DEMO" },
  });
  return { contact, convo, wf, campaign };
}

async function seedLiveRows(workspaceId: string) {
  const contact = await db.contact.create({
    data: { workspaceId, name: "Real Contact", channel: "facebook", tags: JSON.stringify([]) },
  });
  const convo = await db.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "facebook", tags: JSON.stringify([]) },
  });
  await db.message.create({
    data: { conversationId: convo.id, direction: "INBOUND", body: "real message" },
  });
  const wf = await db.workflow.create({
    data: { workspaceId, name: "Real Workflow", status: "PUBLISHED" },
  });
  await db.workflowNode.create({
    data: { workflowId: wf.id, kind: "trigger", type: "trigger.new_message", label: "T" },
  });
  const campaign = await db.campaign.create({
    data: { workspaceId, name: "Real Campaign", channel: "facebook", messageType: "freeform", status: "DRAFT" },
  });
  await db.integration.create({
    // Different provider than the seeded DEMO row: (workspaceId, provider)
    // is unique.
    data: { workspaceId, provider: "instagram", status: "CONNECTED" },
  });
  return { contact, convo, wf, campaign };
}

let liveA: Awaited<ReturnType<typeof seedLiveRows>>;

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: `Reset Org ${suffix}` } });
  wsA = (
    await db.workspace.create({
      data: { orgId: org.id, name: `Reset A ${suffix}`, slug: `reset-a-${suffix}`, isDemo: true },
    })
  ).id;
  wsB = (
    await db.workspace.create({
      data: { orgId: org.id, name: `Reset B ${suffix}`, slug: `reset-b-${suffix}`, isDemo: true },
    })
  ).id;
  await seedDemoSet(wsA, "A");
  await seedDemoSet(wsB, "B");
  liveA = await seedLiveRows(wsA);
});

describe("resetDemoData", () => {
  it("deletes only the target workspace's demo rows and reports counts", async () => {
    const result = await resetDemoData(wsA);
    expect(result).toMatchObject({
      contacts: 1,
      conversations: 1,
      messages: 2,
      workflows: 1,
      workflowNodes: 1,
      workflowEdges: 1,
      workflowExecutions: 1,
      executionSteps: 2,
      campaigns: 1,
      campaignRecipients: 1,
      integrations: 1,
    });

    // Target workspace: demo rows gone…
    expect(await db.contact.count({ where: { workspaceId: wsA } })).toBe(1);
    expect(await db.conversation.count({ where: { workspaceId: wsA } })).toBe(1);
    expect(await db.message.count({ where: { conversation: { workspaceId: wsA } } })).toBe(1);
    expect(await db.workflow.count({ where: { workspaceId: wsA } })).toBe(1);
    expect(await db.campaign.count({ where: { workspaceId: wsA } })).toBe(1);
    expect(await db.integration.count({ where: { workspaceId: wsA } })).toBe(1);

    // …but the surviving rows are exactly the non-demo ones.
    expect((await db.contact.findUnique({ where: { id: liveA.contact.id } }))?.name).toBe("Real Contact");
    expect((await db.conversation.findUnique({ where: { id: liveA.convo.id } }))?.id).toBe(liveA.convo.id);
    expect((await db.workflow.findUnique({ where: { id: liveA.wf.id } }))?.name).toBe("Real Workflow");
    expect((await db.campaign.findUnique({ where: { id: liveA.campaign.id } }))?.name).toBe("Real Campaign");
    const remainingIntegration = await db.integration.findFirst({ where: { workspaceId: wsA } });
    expect(remainingIntegration?.status).toBe("CONNECTED");

    // Other workspace: completely untouched.
    expect(await db.contact.count({ where: { workspaceId: wsB } })).toBe(1);
    expect(await db.conversation.count({ where: { workspaceId: wsB } })).toBe(1);
    expect(await db.message.count({ where: { conversation: { workspaceId: wsB } } })).toBe(2);
    expect(await db.workflow.count({ where: { workspaceId: wsB } })).toBe(1);
    expect(await db.workflowNode.count({ where: { workflow: { workspaceId: wsB } } })).toBe(1);
    expect(await db.campaign.count({ where: { workspaceId: wsB } })).toBe(1);
    expect(await db.integration.count({ where: { workspaceId: wsB } })).toBe(1);
  });

  it("is a no-op when there is nothing demo left to delete", async () => {
    const result = await resetDemoData(wsA);
    expect(result).toMatchObject({
      contacts: 0,
      conversations: 0,
      messages: 0,
      workflows: 0,
      campaigns: 0,
      integrations: 0,
    });
  });
});
