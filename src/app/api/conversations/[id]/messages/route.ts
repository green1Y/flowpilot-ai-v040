import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { messageCreateSchema } from "@/lib/validation";
import { auditLog, trackUsage } from "@/lib/audit";
import { requirePlanLimit } from "@/lib/billing/usage";

export const GET = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
    const conversation = await db.conversation.findFirst({
      where: { id: (await params).id, workspaceId: ctx.workspaceId },
      select: { id: true },
    });
    if (!conversation) throw err("Conversation not found", 404);

    const sp = new URL(req.url).searchParams;
    // Perf: cursor pagination for long threads. Defaults return the most
    // recent `limit` messages in ascending order — identical shape to before
    // for existing clients ({ messages }); pass ?before=<messageId> to page
    // into older history. `hasMore` is additive for future "load older" UI.
    const limit = Math.min(
      1000,
      Math.max(1, parseInt(sp.get("limit") ?? "500", 10) || 500),
    );
    const beforeId = sp.get("before");
    let cursorFilter = {};
    if (beforeId) {
      const cursor = await db.message.findFirst({
        where: { id: beforeId, conversationId: conversation.id },
        select: { createdAt: true, id: true },
      });
      if (cursor) {
        cursorFilter = {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        };
      }
    }

    const rows = await db.message.findMany({
      where: { conversationId: conversation.id, ...cursorFilter },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse();
    return ok({ messages, hasMore });
  }
);

export const POST = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
    // Sending a reply requires an agent-level role — read-only members
    // (ANALYST) can read threads but cannot reply via the API.
    requireRole(ctx, "AGENT");
    const conversation = await db.conversation.findFirst({
      where: { id: (await params).id, workspaceId: ctx.workspaceId },
    });
    if (!conversation) throw err("Conversation not found", 404);

    const body = await parseBody(req, messageCreateSchema);

    // Stage 4d: test sends count against the plan's message allowance.
    await requirePlanLimit(ctx.workspaceId, "messages");

    // Saved as OUTBOUND with mocked:true — the mock adapter never performs a
    // real send, so this is effectively a draft reply.
    const message = await db.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTBOUND",
        body: body.body,
        aiGenerated: body.aiGenerated,
        mocked: true,
      },
    });
    // Bump the conversation so inbox ordering reflects the new reply.
    await db.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    await auditLog(ctx.workspaceId, ctx.userId, "message.sent", {
      type: "message",
      id: message.id,
      conversationId: conversation.id,
      mocked: true,
    });
    await trackUsage(ctx.workspaceId, "messages_sent", 1);

    return ok(
      {
        message,
        mocked: true,
        note: "Saved as a draft via the mock adapter — no real message was sent.",
      },
      { status: 201 }
    );
  }
);
