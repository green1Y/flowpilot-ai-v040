import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { campaignSchema } from "@/lib/validation";
import { serializeCampaign } from "@/lib/serialize";
import { auditLog } from "@/lib/audit";

const campaignPatchSchema = campaignSchema.partial().extend({
  // Stage 3 statuses plus legacy values (SENDING/SENT) that older rows may carry.
  status: z
    .enum(["DRAFT", "SCHEDULED", "RUNNING", "PAUSED", "CANCELLED", "COMPLETED", "FAILED", "SENDING", "SENT"])
    .optional(),
});

type Ctx = { params: Promise<{ id: string }> };

async function scopedCampaign(workspaceId: string, id: string) {
  const campaign = await db.campaign.findFirst({ where: { id, workspaceId } });
  if (!campaign) throw err("Campaign not found", 404);
  return campaign;
}

export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  const campaign = await scopedCampaign(ctx.workspaceId, (await params).id);
  return ok({ campaign: serializeCampaign(campaign) });
});

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Campaign edits can schedule/intend sends: MANAGER+.
  requireRole(ctx, "MANAGER");
  const campaign = await scopedCampaign(ctx.workspaceId, (await params).id);
  const body = await parseBody(req, campaignPatchSchema);

  // Scheduling = intent to send. Require a connected, verified provider for
  // the campaign's channel; never allow sending through an unverified one.
  const targetChannel = body.channel ?? campaign.channel;
  if (body.status === "SCHEDULED") {
    const integration = await db.integration.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        provider: targetChannel,
        status: "CONNECTED",
      },
    });
    if (!integration) {
      throw err(
        "Sending requires a connected, verified provider for this channel.",
        422
      );
    }
  }

  // Unchecked input: scalar FK fields (segmentId/templateId) are set directly.
  const data: Prisma.CampaignUncheckedUpdateInput = {};
  if (body.name !== undefined) data.name = body.name.trim();
  if (body.objective !== undefined) data.objective = body.objective;
  if (body.channel !== undefined) data.channel = body.channel;
  if (body.status !== undefined) data.status = body.status;
  if (body.audience !== undefined) data.audience = JSON.stringify(body.audience);
  if (body.message !== undefined) data.message = JSON.stringify(body.message);
  if (body.scheduledAt !== undefined) {
    data.scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
  }
  if (body.segmentId !== undefined) data.segmentId = body.segmentId;
  if (body.templateId !== undefined) data.templateId = body.templateId;
  if (body.messageType !== undefined) data.messageType = body.messageType;
  if (body.ratePerSecond !== undefined) data.ratePerSecond = body.ratePerSecond;
  if (body.pauseOnReply !== undefined) data.pauseOnReply = body.pauseOnReply;

  const updated = await db.campaign.update({ where: { id: campaign.id }, data });
  await auditLog(ctx.workspaceId, ctx.userId, "campaign.updated", {
    type: "campaign",
    id: updated.id,
  });

  return ok({ campaign: serializeCampaign(updated) });
});

export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const campaign = await scopedCampaign(ctx.workspaceId, (await params).id);

  await db.campaign.delete({ where: { id: campaign.id } });
  await auditLog(ctx.workspaceId, ctx.userId, "campaign.deleted", {
    type: "campaign",
    id: campaign.id,
  });

  return ok({ ok: true });
});
