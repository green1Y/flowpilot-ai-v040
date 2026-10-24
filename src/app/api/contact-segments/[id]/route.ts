import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/contact-segments/[id] — tenant-scoped. */
export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "AGENT");
  const segment = await db.contactSegment.findFirst({
    where: { id: (await params).id, workspaceId: ctx.workspaceId },
  });
  if (!segment) throw err("Segment not found", 404);

  await db.contactSegment.delete({ where: { id: segment.id } });
  await auditLog(ctx.workspaceId, ctx.userId, "contact_segment.deleted", {
    type: "contact_segment",
    id: segment.id,
  });

  return ok({ ok: true });
});
