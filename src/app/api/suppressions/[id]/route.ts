import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const wctx = await requireWorkspace(req);
    requireRole(wctx, "AGENT");

    const suppression = await db.suppression.findFirst({
      where: { id: (await ctx.params).id, workspaceId: wctx.workspaceId },
    });
    if (!suppression) throw err("Suppression not found", 404);

    await db.suppression.delete({ where: { id: suppression.id } });

    await auditLog(wctx.workspaceId, wctx.userId, "suppression.deleted", {
      type: "suppression",
      id: suppression.id,
      contactId: suppression.contactId,
      channel: suppression.channel,
    });

    return ok({ deleted: suppression.id });
  }
);
