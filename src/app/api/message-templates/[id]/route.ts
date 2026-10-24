import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const wctx = await requireWorkspace(req);
    requireRole(wctx, "AGENT");

    const template = await db.messageTemplate.findFirst({
      where: { id: (await ctx.params).id, workspaceId: wctx.workspaceId },
    });
    if (!template) throw err("Message template not found", 404);

    await db.messageTemplate.delete({ where: { id: template.id } });

    await auditLog(wctx.workspaceId, wctx.userId, "template.deleted", {
      type: "template", id: template.id, name: template.name,
    });

    return ok({ deleted: template.id });
  }
);
