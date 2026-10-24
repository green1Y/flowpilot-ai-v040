import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import {
  retargetingCampaignCreateSchema,
  serializeRetargetingCampaign,
} from "@/lib/retargeting/schemas";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const campaigns = await db.retargetingCampaign.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { updatedAt: "desc" },
    take: 500, // perf: hard cap; campaign lists are user-managed and small
    include: {
      _count: { select: { recipients: true } },
      segment: { select: { id: true, name: true } },
    },
  });
  return ok({
    campaigns: campaigns.map((c) => ({
      ...serializeRetargetingCampaign(c),
      recipientCount: c._count.recipients,
      segmentName: c.segment?.name ?? null,
    })),
  });
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, retargetingCampaignCreateSchema);

  // Validate tenant-scoped references before creating.
  if (body.segmentId) {
    const segment = await db.audienceSegment.findFirst({
      where: { id: body.segmentId, workspaceId: ctx.workspaceId },
    });
    if (!segment) throw err("Audience segment not found", 404);
  }
  if (body.integrationId) {
    const integration = await db.integration.findFirst({
      where: { id: body.integrationId, workspaceId: ctx.workspaceId },
    });
    if (!integration) throw err("Integration not found", 404);
  }

  const campaign = await db.retargetingCampaign.create({
    data: {
      workspaceId: ctx.workspaceId,
      name: body.name.trim(),
      type: body.type,
      status: "draft",
      channel: body.channel ?? null,
      integrationId: body.integrationId ?? null,
      segmentId: body.segmentId ?? null,
      objective: body.objective ?? "",
      message: JSON.stringify(body.message ?? {}),
      schedule: JSON.stringify(body.schedule ?? {}),
      budget: JSON.stringify(body.budget ?? {}),
      dryRun: body.dryRun ?? false,
      createdById: ctx.userId,
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "retargeting.campaign_created", {
    type: "retargeting_campaign",
    id: campaign.id,
    campaignType: campaign.type,
    dryRun: campaign.dryRun,
  });

  return ok({ campaign: serializeRetargetingCampaign(campaign) }, { status: 201 });
});
