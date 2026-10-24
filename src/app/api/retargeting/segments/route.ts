import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import {
  segmentCreateSchema,
  serializeRetargetingSegment,
} from "@/lib/retargeting/schemas";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const segments = await db.audienceSegment.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { updatedAt: "desc" },
    take: 500, // perf: hard cap; segment lists are user-managed and small
  });
  return ok({ segments: segments.map(serializeRetargetingSegment) });
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, segmentCreateSchema);

  const segment = await db.audienceSegment.create({
    data: {
      workspaceId: ctx.workspaceId,
      name: body.name.trim(),
      description: body.description ?? "",
      conditions: JSON.stringify(body.conditions),
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "retargeting.segment_created", {
    type: "audience_segment",
    id: segment.id,
  });

  return ok({ segment: serializeRetargetingSegment(segment) }, { status: 201 });
});
