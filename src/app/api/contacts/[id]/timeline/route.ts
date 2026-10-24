import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { parseJson } from "@/lib/serialize";

type Ctx = { params: Promise<{ id: string }> };

export interface TimelineItem {
  type: "message" | "comment" | "workflow" | "lead_stage";
  at: string; // ISO
  channel?: string;
  summary: string;
  /** false for mocked/dry-run/demo rows — never present real rows as real. */
  real: boolean;
}

function snippet(body: string, max = 90): string {
  const s = body.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * GET /api/contacts/[id]/timeline
 *
 * One chronological list merging the contact's messages (inbound/outbound,
 * channel-labeled, real vs mocked flag), inbound comments, workflow
 * executions whose trigger event referenced the contact, and lead-stage
 * changes from the audit log. Demo/seeded items are labeled, never hidden.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);

  const contact = await db.contact.findFirst({
    where: { id: (await params).id, workspaceId: ctx.workspaceId },
  });
  if (!contact) throw err("Contact not found", 404);

  const items: TimelineItem[] = [];

  // 1) Messages via the contact's conversations.
  const conversations = await db.conversation.findMany({
    where: { workspaceId: ctx.workspaceId, contactId: contact.id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  for (const conv of conversations) {
    for (const m of conv.messages) {
      const dirLabel =
        m.direction === "INBOUND"
          ? "Received"
          : m.direction === "OUTBOUND"
            ? "Sent"
            : "Note";
      items.push({
        type: "message",
        at: m.createdAt.toISOString(),
        channel: conv.channel,
        summary: m.mocked
          ? `${dirLabel} (demo/mock): ${snippet(m.body)}`
          : `${dirLabel}: ${snippet(m.body)}`,
        real: !m.mocked,
      });
    }
  }

  // 2) Inbound comments on owned media/posts.
  const comments = await db.comment.findMany({
    where: { workspaceId: ctx.workspaceId, contactId: contact.id },
    orderBy: { commentedAt: "asc" },
  });
  let integrations: Array<{ id: string; provider: string }> = [];
  if (comments.length > 0) {
    integrations = await db.integration.findMany({
      where: {
        id: { in: comments.map((c) => c.integrationId) },
        workspaceId: ctx.workspaceId,
      },
      select: { id: true, provider: true },
    });
  }
  const providerByIntegration = new Map(
    integrations.map((i) => [i.id, i.provider])
  );
  for (const c of comments) {
    const windowLeft =
      c.privateReplyEligibleUntil > new Date() && !c.privateRepliedAt;
    items.push({
      type: "comment",
      at: c.commentedAt.toISOString(),
      channel: providerByIntegration.get(c.integrationId),
      summary: c.privateRepliedAt
        ? `Commented: ${snippet(c.text)} (private-replied)`
        : windowLeft
          ? `Commented: ${snippet(c.text)} (private-reply window open)`
          : `Commented: ${snippet(c.text)}`,
      real: true,
    });
  }

  // 3) Workflow executions whose trigger event referenced this contact.
  const executions = await db.workflowExecution.findMany({
    where: {
      workflow: { workspaceId: ctx.workspaceId },
      triggerEvent: { contains: contact.id },
    },
    include: { workflow: { select: { name: true } } },
    orderBy: { startedAt: "asc" },
    take: 200,
  });
  for (const ex of executions) {
    items.push({
      type: "workflow",
      at: ex.startedAt.toISOString(),
      summary: ex.dryRun
        ? `Workflow "${ex.workflow.name}": ${ex.status} (dry run)`
        : `Workflow "${ex.workflow.name}": ${ex.status}`,
      real: !ex.dryRun,
    });
  }

  // 4) Lead-stage changes from the audit log.
  const audits = await db.auditEvent.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      action: "contact.updated",
      entity: { contains: contact.id },
    },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  for (const a of audits) {
    const entity = parseJson<Record<string, unknown>>(a.entity, {});
    const change = entity.leadStageChange as
      | { from?: string; to?: string }
      | undefined;
    if (!change?.from || !change?.to) continue;
    items.push({
      type: "lead_stage",
      at: a.createdAt.toISOString(),
      summary: `Lead stage changed: ${change.from} → ${change.to}`,
      real: true,
    });
  }

  // Chronological, oldest first.
  items.sort((x, y) => x.at.localeCompare(y.at));

  return ok({ contactId: contact.id, items });
});
