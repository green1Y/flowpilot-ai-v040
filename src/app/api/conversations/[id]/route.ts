import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { conversationPatchSchema } from "@/lib/validation-stage4a";
import { expireStaleTypingFor } from "@/lib/conversations";

export const GET = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
    const conversation = await db.conversation.findFirst({
      where: { id: (await params).id, workspaceId: ctx.workspaceId },
      include: { contact: true },
    });
    if (!conversation) throw err("Conversation not found", 404);
    // Lazy expiry: stale typing presence is cleared on read; re-read so the
    // response reflects the expiry.
    if (conversation.composingAt) {
      await expireStaleTypingFor(conversation.id);
      const fresh = await db.conversation.findFirst({
        where: { id: (await params).id, workspaceId: ctx.workspaceId },
        include: { contact: true },
      });
      if (fresh) return ok({ conversation: fresh });
    }
    return ok({ conversation });
  }
);

/**
 * PATCH /api/conversations/[id] — update assignment, priority, or the
 * human-takeover flag. Every change is audit-logged with before/after values.
 */
export const PATCH = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
    // Assignment, priority, and human-takeover changes require an agent-level
    // role — read-only members (ANALYST) can view but not change conversations.
    requireRole(ctx, "AGENT");
    const conversation = await db.conversation.findFirst({
      where: { id: (await params).id, workspaceId: ctx.workspaceId },
    });
    if (!conversation) throw err("Conversation not found", 404);

    const body = await parseBody(req, conversationPatchSchema);
    const data: { assignedTo?: string | null; priority?: string; humanTakeover?: boolean } = {};
    if (body.assignedTo !== undefined) data.assignedTo = body.assignedTo || null;
    if (body.priority !== undefined) data.priority = body.priority;
    if (body.humanTakeover !== undefined) data.humanTakeover = body.humanTakeover;

    const updated = await db.conversation.update({
      where: { id: conversation.id },
      data,
    });

    // Audit each changed field with before/after (no secrets involved).
    for (const [field, after] of Object.entries(data)) {
      const before = (conversation as Record<string, unknown>)[field];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await auditLog(ctx.workspaceId, ctx.userId, `conversation.${field}`, {
          type: "conversation",
          id: conversation.id,
          field,
          before,
          after,
        });
      }
    }

    return ok({ conversation: updated });
  }
);
