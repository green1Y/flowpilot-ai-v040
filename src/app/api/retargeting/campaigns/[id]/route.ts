import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import {
  retargetingCampaignPatchSchema,
  serializeRetargetingCampaign,
  serializeRetargetingRecipient,
} from "@/lib/retargeting/schemas";
import {
  scopedRetargetingCampaign,
  mapRetargetingError,
} from "@/lib/retargeting/campaigns";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  const campaign = await scopedRetargetingCampaign(ctx.workspaceId, (await params).id);
  const recipients = await db.retargetingRecipient.findMany({
    where: { campaignId: campaign.id },
    include: { contact: { select: { name: true, email: true, phone: true } } },
    orderBy: { id: "asc" },
    take: 500,
  });
  const totalRecipients = await db.retargetingRecipient.count({
    where: { campaignId: campaign.id },
  });
  const segment = campaign.segmentId
    ? await db.audienceSegment.findFirst({
        where: { id: campaign.segmentId, workspaceId: ctx.workspaceId },
        select: { id: true, name: true },
      })
    : null;
  return ok({
    campaign: serializeRetargetingCampaign(campaign),
    segment,
    recipients: recipients.map(serializeRetargetingRecipient),
    totalRecipients,
    truncated: totalRecipients > recipients.length,
  });
});

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const campaign = await scopedRetargetingCampaign(ctx.workspaceId, (await params).id);
  if (!["draft", "scheduled", "paused"].includes(campaign.status)) {
    throw err(`Cannot edit a ${campaign.status} campaign — pause or stop it first`, 422);
  }
  const body = await parseBody(req, retargetingCampaignPatchSchema);

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

  try {
    const updated = await db.retargetingCampaign.update({
      where: { id: campaign.id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.objective !== undefined ? { objective: body.objective } : {}),
        ...(body.channel !== undefined ? { channel: body.channel ?? null } : {}),
        ...(body.integrationId !== undefined ? { integrationId: body.integrationId ?? null } : {}),
        ...(body.segmentId !== undefined ? { segmentId: body.segmentId ?? null } : {}),
        ...(body.message !== undefined ? { message: JSON.stringify(body.message) } : {}),
        ...(body.schedule !== undefined ? { schedule: JSON.stringify(body.schedule) } : {}),
        ...(body.budget !== undefined ? { budget: JSON.stringify(body.budget) } : {}),
      },
    });
    await auditLog(ctx.workspaceId, ctx.userId, "retargeting.campaign_updated", {
      type: "retargeting_campaign",
      id: campaign.id,
    });
    return ok({ campaign: serializeRetargetingCampaign(updated) });
  } catch (e) {
    mapRetargetingError(e);
  }
});
