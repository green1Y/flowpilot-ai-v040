import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { campaignSchema } from "@/lib/validation";
import { serializeCampaign } from "@/lib/serialize";
import { auditLog } from "@/lib/audit";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const campaigns = await db.campaign.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 500, // perf: hard cap; campaign lists are user-managed and small
  });
  return ok({ campaigns: campaigns.map(serializeCampaign) });
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Campaign creation is a sending-adjacent mutation: MANAGER+.
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, campaignSchema);

  // Validate channel/template references (tenant-scoped) before creating.
  if (body.segmentId) {
    const segment = await db.contactSegment.findFirst({
      where: { id: body.segmentId, workspaceId: ctx.workspaceId },
    });
    if (!segment) throw err("Contact segment not found", 404);
  }
  if (body.templateId) {
    const template = await db.messageTemplate.findFirst({
      where: { id: body.templateId, workspaceId: ctx.workspaceId },
    });
    if (!template) throw err("Message template not found", 404);
  }

  const campaign = await db.campaign.create({
    data: {
      workspaceId: ctx.workspaceId,
      name: body.name.trim(),
      objective: body.objective ?? "",
      channel: body.channel,
      status: "DRAFT",
      audience: JSON.stringify(body.audience ?? {}),
      message: JSON.stringify(body.message ?? {}),
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
      segmentId: body.segmentId ?? null,
      templateId: body.templateId ?? null,
      messageType: body.messageType ?? "freeform",
      ratePerSecond: body.ratePerSecond ?? 1,
      pauseOnReply: body.pauseOnReply ?? true,
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "campaign.created", {
    type: "campaign",
    id: campaign.id,
  });

  return ok({ campaign: serializeCampaign(campaign) }, { status: 201 });
});
