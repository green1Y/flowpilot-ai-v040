import { db } from "./db";
import { PROVIDERS } from "./integrations/providers";
import { upsertAccountRow } from "./integrations/accounts";

/**
 * Demo mode seeding. Called lazily for new workspaces when DEMO_MODE=true.
 * Every seeded record is ordinary data EXCEPT it is only used to render
 * UI clearly labeled "Demo data" — the dashboard never claims it is real
 * customer activity.
 */
export async function ensureDemoData(workspaceId: string) {
  if (process.env.DEMO_MODE !== "true") return;
  const existing = await db.contact.count({ where: { workspaceId } });
  if (existing > 0) return; // already seeded

  const channels = ["instagram", "facebook", "whatsapp", "webchat", "email"];
  const names = ["Sara Amr", "Omar Khaled", "Lina Hassan", "Youssef Nabil", "Maya Adel", "Karim Samy"];
  const statuses = ["NEW", "CONTACTED", "QUALIFIED", "INTERESTED", "CONVERTED"];

  for (let i = 0; i < names.length; i++) {
    const contact = await db.contact.create({
      data: {
        workspaceId,
        name: names[i],
        channel: channels[i % channels.length],
        tags: JSON.stringify(i % 2 === 0 ? ["demo"] : ["demo", "vip"]),
        leadStatus: statuses[i % statuses.length],
        leadScore: 20 + i * 12,
        externalIds: JSON.stringify({ [channels[i % channels.length]]: `demo-user-${i}` }),
      },
    });
    const convo = await db.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channel: contact.channel,
        status: i % 3 === 0 ? "RESOLVED" : "OPEN",
        aiHandled: i % 2 === 0,
        tags: JSON.stringify(["demo"]),
      },
    });
    await db.message.createMany({
      data: [
        {
          conversationId: convo.id,
          direction: "INBOUND",
          body: `Hi! Do you have this in stock? (demo message ${i + 1})`,
        },
        {
          conversationId: convo.id,
          direction: "OUTBOUND",
          body: "Thanks for reaching out! Let me check that for you. (demo reply)",
          aiGenerated: i % 2 === 0,
          mocked: true,
        },
      ],
    });
  }

  // Seed integration rows: DEMO status (honest — never CONNECTED without verification).
  // Seeded rows are placeholder rows (externalAccountId = null) — demo
  // seeding never touches a real connected account of the same provider.
  for (const p of PROVIDERS) {
    await upsertAccountRow({
      workspaceId,
      provider: p.provider,
      externalAccountId: null,
      update: {},
      create: {
        workspace: { connect: { id: workspaceId } },
        provider: p.provider,
        status: "DEMO",
        capabilities: JSON.stringify(p.capabilities),
        limitations: JSON.stringify(p.limitations),
        requiredPermissions: JSON.stringify(p.requiredPermissions),
      },
    });
  }

  // Seed one demo workflow + execution log.
  const wf = await db.workflow.create({
    data: {
      workspaceId,
      name: "Demo: FAQ Auto-Responder",
      description: "Seeded demo workflow. Publish checklist not completed.",
      status: "DRAFT",
    },
  });
  const n1 = await db.workflowNode.create({
    data: { workflowId: wf.id, kind: "trigger", type: "trigger.new_message", label: "New message", position: JSON.stringify({ x: 80, y: 80 }) },
  });
  const n2 = await db.workflowNode.create({
    data: { workflowId: wf.id, kind: "action", type: "action.ai_reply", label: "AI reply", config: JSON.stringify({ confidenceThreshold: 0.7 }), position: JSON.stringify({ x: 360, y: 80 }) },
  });
  await db.workflowEdge.create({ data: { workflowId: wf.id, sourceId: n1.id, targetId: n2.id } });
  const exec = await db.workflowExecution.create({
    data: {
      workflowId: wf.id,
      triggerEvent: JSON.stringify({ type: "new_message", demo: true }),
      status: "SUCCEEDED",
      idempotencyKey: `demo-seed-${workspaceId}`,
      dryRun: true,
      finishedAt: new Date(),
    },
  });
  await db.executionStep.createMany({
    data: [
      { executionId: exec.id, nodeId: n1.id, nodeLabel: "New message", status: "SUCCEEDED", input: JSON.stringify({ demo: true }), output: JSON.stringify({ matched: true }) },
      { executionId: exec.id, nodeId: n2.id, nodeLabel: "AI reply", status: "SUCCEEDED", input: JSON.stringify({ demo: true }), output: JSON.stringify({ mocked: true, text: "Demo AI reply" }) },
    ],
  });

  // Seed a demo AI config + knowledge doc.
  await db.aiConfig.upsert({
    where: { workspaceId },
    update: {},
    create: {
      workspaceId,
      assistantName: "Nova",
      businessName: "Demo Store",
      businessDescription: "A demo e-commerce store used to showcase FlowPilot AI.",
      fallbackResponse: "Thanks for reaching out! A team member will get back to you shortly.",
    },
  });
  await db.knowledgeDoc.create({
    data: {
      workspaceId,
      title: "Demo FAQ — Shipping",
      content: "Demo knowledge: standard shipping takes 3–5 business days. Express available at checkout.",
    },
  });
}

/** Aggregate demo-labeled analytics from whatever data exists. */
export async function getOverviewMetrics(workspaceId: string, from: Date) {
  const [conversations, messages, contacts, executions] = await Promise.all([
    db.conversation.count({ where: { workspaceId, createdAt: { gte: from } } }),
    db.message.count({ where: { conversation: { workspaceId }, createdAt: { gte: from } } }),
    db.contact.count({ where: { workspaceId, firstSeenAt: { gte: from } } }),
    db.workflowExecution.count({ where: { workflow: { workspaceId }, startedAt: { gte: from } } }),
  ]);
  const aiHandled = await db.conversation.count({ where: { workspaceId, aiHandled: true, createdAt: { gte: from } } });
  const qualified = await db.contact.count({
    where: { workspaceId, leadStatus: { in: ["QUALIFIED", "INTERESTED", "CONVERTED"] }, firstSeenAt: { gte: from } },
  });
  return { conversations, messages, contacts, executions, aiHandled, qualified };
}
