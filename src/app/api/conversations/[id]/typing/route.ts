import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { typingSchema } from "@/lib/validation-stage4a";
import { isComposingFresh } from "@/lib/conversations";

/**
 * POST /api/conversations/[id]/typing — typing presence for conflict
 * awareness. Call { active: true } on composer focus (throttle client-side,
 * e.g. every 15-20s) and { active: false } on blur/send.
 *
 * Presence expires lazily: reads treat composingAt older than 90s as stale
 * and clear it.
 */
export const POST = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
    // Typing presence is written by the agent composer — read-only members
    // have no composer, so this is AGENT+ like the other inbox mutations.
    requireRole(ctx, "AGENT");
    const conversation = await db.conversation.findFirst({
      where: { id: (await params).id, workspaceId: ctx.workspaceId },
      select: { id: true },
    });
    if (!conversation) throw err("Conversation not found", 404);

    const body = await parseBody(req, typingSchema);
    const updated = await db.conversation.update({
      where: { id: conversation.id },
      data: body.active
        ? { composingBy: ctx.userId, composingAt: new Date() }
        : { composingBy: null, composingAt: null },
    });

    return ok({
      conversationId: updated.id,
      composingBy: updated.composingBy,
      composingAt: updated.composingAt,
      fresh: isComposingFresh(updated.composingAt),
    });
  }
);
