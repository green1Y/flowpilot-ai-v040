import { db } from "../db";

/**
 * Demo-data reset (Batch B public-beta readiness).
 *
 * `resetDemoData(workspaceId)` deletes demo-seeded rows strictly scoped to
 * the given workspace — never without the workspaceId filter. Demo rows are
 * identified by:
 *  - the "demo" tag on contacts and conversations (seeded as `["demo"]` /
 *    `["demo","vip"]` JSON in the tags column), AND
 *  - the "Demo:" name prefix on workflows and campaigns (seeded workflow:
 *    "Demo: FAQ Auto-Responder"), AND
 *  - status "DEMO" on integrations (honest seeded state, never CONNECTED).
 *
 * FK delete order is respected explicitly (children before parents), so the
 * reset works the same whether or not the database enforces cascades.
 */

export interface ResetDemoDataResult {
  messages: number;
  executionSteps: number;
  workflowExecutions: number;
  workflowNodes: number;
  workflowEdges: number;
  campaignRecipients: number;
  conversations: number;
  campaigns: number;
  workflows: number;
  contacts: number;
  integrations: number;
}

/** Tags are stored as a JSON array string; match the exact `"demo"` element. */
function demoTagWhere(workspaceId: string) {
  return { workspaceId, tags: { contains: '"demo"' } };
}

export async function resetDemoData(workspaceId: string): Promise<ResetDemoDataResult> {
  // Phase 1 — identify demo rows (every query scoped to workspaceId).
  const [demoContacts, demoConvos, demoWorkflows, demoCampaigns] = await Promise.all([
    db.contact.findMany({ where: demoTagWhere(workspaceId), select: { id: true } }),
    db.conversation.findMany({ where: demoTagWhere(workspaceId), select: { id: true } }),
    db.workflow.findMany({
      where: { workspaceId, name: { startsWith: "Demo:" } },
      select: { id: true },
    }),
    db.campaign.findMany({
      where: { workspaceId, name: { startsWith: "Demo:" } },
      select: { id: true },
    }),
  ]);
  const contactIds = demoContacts.map((c) => c.id);
  const workflowIds = demoWorkflows.map((w) => w.id);
  const campaignIds = demoCampaigns.map((c) => c.id);

  // Conversations: demo-tagged ones, plus any conversation attached to a
  // demo contact (a demo contact's thread is demo data even if untagged).
  const contactConvos =
    contactIds.length > 0
      ? await db.conversation.findMany({
          where: { workspaceId, contactId: { in: contactIds } },
          select: { id: true },
        })
      : [];
  const conversationIds = [
    ...new Set([...demoConvos.map((c) => c.id), ...contactConvos.map((c) => c.id)]),
  ];

  // Phase 2 — delete children first (FK order), then parents. All deletes
  // stay scoped to the identified demo rows; nothing else is touched.
  const messages = await db.message.deleteMany({
    where: { conversationId: { in: conversationIds } },
  });
  const executionSteps = await db.executionStep.deleteMany({
    where: { execution: { workflowId: { in: workflowIds } } },
  });
  const workflowExecutions = await db.workflowExecution.deleteMany({
    where: { workflowId: { in: workflowIds } },
  });
  const workflowNodes = await db.workflowNode.deleteMany({
    where: { workflowId: { in: workflowIds } },
  });
  const workflowEdges = await db.workflowEdge.deleteMany({
    where: { workflowId: { in: workflowIds } },
  });
  const campaignRecipients = await db.campaignRecipient.deleteMany({
    where: { campaignId: { in: campaignIds } },
  });
  const conversations = await db.conversation.deleteMany({
    where: { id: { in: conversationIds } },
  });
  const campaigns = await db.campaign.deleteMany({
    where: { id: { in: campaignIds } },
  });
  const workflows = await db.workflow.deleteMany({
    where: { id: { in: workflowIds } },
  });
  // Contact delete cascades to any leftover conversations/recipients, but
  // those were already removed explicitly above for FK-order safety.
  const contacts = await db.contact.deleteMany({
    where: { id: { in: contactIds } },
  });
  const integrations = await db.integration.deleteMany({
    where: { workspaceId, status: "DEMO" },
  });

  return {
    messages: messages.count,
    executionSteps: executionSteps.count,
    workflowExecutions: workflowExecutions.count,
    workflowNodes: workflowNodes.count,
    workflowEdges: workflowEdges.count,
    campaignRecipients: campaignRecipients.count,
    conversations: conversations.count,
    campaigns: campaigns.count,
    workflows: workflows.count,
    contacts: contacts.count,
    integrations: integrations.count,
  };
}
