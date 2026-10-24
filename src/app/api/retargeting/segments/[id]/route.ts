import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import {
  segmentUpdateSchema,
  serializeRetargetingSegment,
} from "@/lib/retargeting/schemas";

type Ctx = { params: Promise<{ id: string }> };

async function scopedSegment(workspaceId: string, id: string) {
  const segment = await db.audienceSegment.findFirst({ where: { id, workspaceId } });
  if (!segment) throw err("Audience segment not found", 404);
  return segment;
}

export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  const segment = await scopedSegment(ctx.workspaceId, (await params).id);
  return ok({ segment: serializeRetargetingSegment(segment) });
});

export const PUT = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const segment = await scopedSegment(ctx.workspaceId, (await params).id);
  const body = await parseBody(req, segmentUpdateSchema);

  const updated = await db.audienceSegment.update({
    where: { id: segment.id },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.conditions !== undefined ? { conditions: JSON.stringify(body.conditions) } : {}),
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "retargeting.segment_updated", {
    type: "audience_segment",
    id: segment.id,
  });

  return ok({ segment: serializeRetargetingSegment(updated) });
});

export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const segment = await scopedSegment(ctx.workspaceId, (await params).id);

  const inUse = await db.retargetingCampaign.count({
    where: { segmentId: segment.id, workspaceId: ctx.workspaceId },
  });
  if (inUse > 0) {
    throw err(
      `Cannot delete: ${inUse} retargeting campaign(s) use this segment. Reassign them first.`,
      422
    );
  }

  await db.audienceSegment.delete({ where: { id: segment.id } });
  await auditLog(ctx.workspaceId, ctx.userId, "retargeting.segment_deleted", {
    type: "audience_segment",
    id: segment.id,
  });
  return ok({ deleted: true });
});
