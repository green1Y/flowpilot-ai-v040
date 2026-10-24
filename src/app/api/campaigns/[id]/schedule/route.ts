import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { serializeCampaign } from "@/lib/serialize";
import { auditLog } from "@/lib/audit";
import { scopedCampaign } from "@/app/api/campaigns/campaign-helpers";

const scheduleSchema = z.object({
  scheduledAt: z.string().datetime().optional(),
});

type Ctx = { params: Promise<{ id: string }> };

/**
 * Schedule a campaign: DRAFT/PAUSED → SCHEDULED (optionally updating the
 * scheduled time). Scheduling is an intent to send, so a connected, verified
 * provider for the campaign's channel is required — same rule as the PATCH
 * status=SCHEDULED path. The process-due worker flips due campaigns to
 * RUNNING.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Launch-control / send-adjacent action: MANAGER+.
  requireRole(ctx, "MANAGER");
  const campaign = await scopedCampaign(ctx.workspaceId, (await params).id);
  const body = await parseBody(req, scheduleSchema);

  if (campaign.status !== "DRAFT" && campaign.status !== "PAUSED") {
    throw err(`Campaign cannot be scheduled from status ${campaign.status}`, 422);
  }

  const integration = await db.integration.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      provider: campaign.channel,
      status: "CONNECTED",
    },
  });
  if (!integration) {
    throw err(
      "Scheduling requires a connected, verified provider for this channel.",
      422
    );
  }

  const updated = await db.campaign.update({
    where: { id: campaign.id },
    data: {
      status: "SCHEDULED",
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : campaign.scheduledAt,
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "campaign.scheduled", {
    type: "campaign",
    id: campaign.id,
    scheduledAt: updated.scheduledAt?.toISOString() ?? null,
  });

  return ok({ campaign: serializeCampaign(updated) });
});
