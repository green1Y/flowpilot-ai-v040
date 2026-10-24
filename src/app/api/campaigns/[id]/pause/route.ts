import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { serializeCampaign } from "@/lib/serialize";
import { auditLog } from "@/lib/audit";
import { scopedCampaign } from "@/app/api/campaigns/campaign-helpers";

type Ctx = { params: Promise<{ id: string }> };

/** Pause a RUNNING campaign. PENDING recipients stay queued for resume. */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Launch-control / send-adjacent action: MANAGER+.
  requireRole(ctx, "MANAGER");
  const campaign = await scopedCampaign(ctx.workspaceId, (await params).id);

  if (campaign.status !== "RUNNING") {
    throw err(`Only RUNNING campaigns can be paused (current: ${campaign.status})`, 422);
  }

  const updated = await db.campaign.update({
    where: { id: campaign.id },
    data: { status: "PAUSED" },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "campaign.paused", {
    type: "campaign",
    id: campaign.id,
  });

  return ok({ campaign: serializeCampaign(updated) });
});
