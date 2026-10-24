import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { parseJson } from "@/lib/serialize";
import { expireStaleTyping } from "@/lib/conversations";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const sp = new URL(req.url).searchParams;

  // Lazy expiry: clear typing presence older than 90s on every list read.
  await expireStaleTyping(ctx.workspaceId);

  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") ?? "20", 10) || 20));
  const search = sp.get("search")?.trim() || null;
  const channel = sp.get("channel") || null;
  const status = sp.get("status") || null;
  const tag = sp.get("tag") || null;
  const assignedTo = sp.get("assignedTo") || null;
  const aiParam = sp.get("aiHandled");
  const integrationId = sp.get("integrationId") || null;

  // Batch B account filter: the named account must belong to THIS
  // workspace — a foreign id must never yield another tenant's data.
  if (integrationId) {
    const integration = await db.integration.findFirst({
      where: { id: integrationId, workspaceId: ctx.workspaceId },
      select: { id: true },
    });
    if (!integration) throw err("Integration not found in this workspace", 403);
  }

  const where: Prisma.ConversationWhereInput = { workspaceId: ctx.workspaceId };
  if (integrationId) where.integrationId = integrationId;
  if (channel) where.channel = channel;
  if (status) where.status = status;
  if (assignedTo) where.assignedTo = assignedTo;
  if (aiParam === "true") where.aiHandled = true;
  else if (aiParam === "false") where.aiHandled = false;
  // tags are stored as a JSON array string; match the quoted value.
  if (tag) where.tags = { contains: `"${tag}"` };

  if (search) {
    // Search matches the contact name OR any message body — two queries,
    // since Prisma can't OR across a relation and a nested relation cheaply.
    const [contactIds, messageConvoIds] = await Promise.all([
      db.contact
        .findMany({
          where: { workspaceId: ctx.workspaceId, name: { contains: search } },
          select: { id: true },
        })
        .then((cs) => cs.map((c) => c.id)),
      db.message
        .findMany({
          where: { body: { contains: search }, conversation: { workspaceId: ctx.workspaceId } },
          select: { conversationId: true },
          distinct: ["conversationId"],
        })
        .then((ms) => ms.map((m) => m.conversationId)),
    ]);
    where.OR = [{ contactId: { in: contactIds } }, { id: { in: messageConvoIds } }];
  }

  const [total, convos] = await Promise.all([
    db.conversation.count({ where }),
    db.conversation.findMany({
      where,
      include: {
        contact: true,
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const items = convos.map((c) => {
    const tags = parseJson<string[]>(c.tags, []);
    return {
    id: c.id,
    integrationId: c.integrationId,
    channel: c.channel,
    status: c.status,
    assignedTo: c.assignedTo,
    aiHandled: c.aiHandled,
    priority: c.priority,
    humanTakeover: c.humanTakeover,
    composingBy: c.composingBy,
    composingAt: c.composingAt,
    tags,
    // Seeded demo conversations carry a "demo" tag — UI uses this to badge
    // the whole thread as Demo (honest real-vs-demo labeling).
    demo: tags.includes("demo"),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    contact: c.contact,
    lastMessage: c.messages[0] ?? null,
    };
  });

  return ok({ items, total, page, pageSize });
});
