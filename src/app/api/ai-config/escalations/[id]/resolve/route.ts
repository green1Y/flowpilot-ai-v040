import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";

/** POST /api/ai-config/escalations/:id/resolve — mark an escalation RESOLVED. */
export const POST = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
    requireRole(ctx, "AGENT");

    const updated = await db.escalation.updateMany({
      where: { id: (await params).id, workspaceId: ctx.workspaceId, status: "OPEN" },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    if (updated.count === 0) throw err("Escalation not found or already resolved", 404);

    await auditLog(ctx.workspaceId, ctx.userId, "ai.escalation.resolved", {
      type: "escalation",
      id: (await params).id,
    });

    return ok({ ok: true });
  }
);
