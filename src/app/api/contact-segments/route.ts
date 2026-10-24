import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { contactSegmentSchema } from "@/lib/validation";
import { auditLog } from "@/lib/audit";

/**
 * GET /api/contact-segments — list the workspace's saved contact filters.
 * POST /api/contact-segments — save a new contact filter set.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const items = await db.contactSegment.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 500, // perf: hard cap; segment lists are user-managed and small
  });
  return ok({
    items: items.map((s) => ({
      id: s.id,
      name: s.name,
      filters: JSON.parse(s.filters || "{}"),
      createdAt: s.createdAt,
    })),
  });
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "AGENT");
  const body = await parseBody(req, contactSegmentSchema);

  const segment = await db.contactSegment.create({
    data: {
      workspaceId: ctx.workspaceId,
      name: body.name.trim(),
      filters: JSON.stringify(body.filters ?? {}),
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "contact_segment.created", {
    type: "contact_segment",
    id: segment.id,
  });

  return ok(
    {
      id: segment.id,
      name: segment.name,
      filters: JSON.parse(segment.filters || "{}"),
      createdAt: segment.createdAt,
    },
    { status: 201 }
  );
});
