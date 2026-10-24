import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { serializeCampaign } from "@/lib/serialize";
import { auditLog } from "@/lib/audit";
import { scopedCampaign } from "@/app/api/campaigns/campaign-helpers";

type Ctx = { params: Promise<{ id: string }> };

const TERMINAL = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

/** Cancel a campaign. PENDING recipients are never sent after cancellation. */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Launch-control / send-adjacent action: MANAGER+.
  requireRole(ctx, "MANAGER");
  const campaign = await scopedCampaign(ctx.workspaceId, (await params).id);

  if (TERMINAL.has(campaign.status)) {
    throw err(`Campaign is already ${campaign.status}`, 422);
  }

  const updated = await db.campaign.update({
    where: { id: campaign.id },
    data: { status: "CANCELLED" },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "campaign.cancelled", {
    type: "campaign",
    id: campaign.id,
    from: campaign.status,
  });

  return ok({ campaign: serializeCampaign(updated) });
});
