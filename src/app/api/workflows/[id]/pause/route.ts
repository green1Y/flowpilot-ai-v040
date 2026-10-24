import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/audit";
import { getScopedWorkflow } from "../../helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const wctx = await requireWorkspace(req);
  // Pausing stops live sends: MANAGER+ (launch-control).
  requireRole(wctx, "MANAGER");
  const { workspaceId, userId } = wctx;
  const workflow = await getScopedWorkflow(workspaceId, (await ctx.params).id);

  const updated = await db.workflow.update({
    where: { id: workflow.id },
    data: { status: "PAUSED" },
  });

  await auditLog(workspaceId, userId, "workflow.pause", { type: "workflow", id: workflow.id });
  return ok({ id: updated.id, status: updated.status });
});
