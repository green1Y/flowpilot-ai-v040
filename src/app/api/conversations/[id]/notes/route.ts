import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { internalNoteSchema } from "@/lib/validation-stage4a";

/**
 * POST /api/conversations/[id]/notes — create an internal note.
 *
 * Internal notes are agent-only annotations: they are stored as Message rows
 * with direction=INTERNAL_NOTE and internalNote=true, and they NEVER touch
 * any send path (no adapter, no OutboundSend, no conversation bump).
 */
export const POST = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
    // Internal notes are agent annotations — read-only members cannot add them.
    requireRole(ctx, "AGENT");
    const conversation = await db.conversation.findFirst({
      where: { id: (await params).id, workspaceId: ctx.workspaceId },
      select: { id: true },
    });
    if (!conversation) throw err("Conversation not found", 404);

    const body = await parseBody(req, internalNoteSchema);
    const note = await db.message.create({
      data: {
        conversationId: conversation.id,
        direction: "INTERNAL_NOTE",
        body: body.body,
        aiGenerated: false,
        mocked: false,
        internalNote: true,
      },
    });

    await auditLog(ctx.workspaceId, ctx.userId, "note.created", {
      type: "message",
      id: note.id,
      conversationId: conversation.id,
      internalNote: true,
    });

    return ok({ note }, { status: 201 });
  }
);
