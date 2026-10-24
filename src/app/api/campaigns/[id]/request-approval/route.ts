import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { scopedCampaign } from "@/app/api/campaigns/campaign-helpers";
import { auditLog } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/** Request approval for a campaign (Wave 2D, MANAGER+). 409 if one is PENDING. */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const campaign = await scopedCampaign(ctx.workspaceId, (await params).id);

  const pending = await db.campaignApproval.findFirst({
    where: { workspaceId: ctx.workspaceId, campaignId: campaign.id, status: "PENDING" },
  });
  if (pending) {
    throw err("An approval request is already pending for this campaign", 409, {
      code: "APPROVAL_ALREADY_PENDING",
      approvalId: pending.id,
    });
  }

  const approval = await db.campaignApproval.create({
    data: {
      workspaceId: ctx.workspaceId,
      campaignId: campaign.id,
      requestedBy: ctx.userId,
      status: "PENDING",
    },
  });
  await auditLog(ctx.workspaceId, ctx.userId, "campaign.approval_requested", {
    type: "campaign",
    id: campaign.id,
    approvalId: approval.id,
  });
  return ok({ approval }, { status: 201 });
});
