import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { scopedCampaign } from "@/app/api/campaigns/campaign-helpers";
import { auditLog } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

const approveSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().optional(),
});

/**
 * Decide the PENDING approval for a campaign (Wave 2D, MANAGER+).
 * Only a PENDING request can be decided; otherwise 409 NO_PENDING_APPROVAL.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const campaign = await scopedCampaign(ctx.workspaceId, (await params).id);
  const body = await parseBody(req, approveSchema);

  const pending = await db.campaignApproval.findFirst({
    where: { workspaceId: ctx.workspaceId, campaignId: campaign.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) {
    throw err("No pending approval request for this campaign", 409, {
      code: "NO_PENDING_APPROVAL",
    });
  }

  const approval = await db.campaignApproval.update({
    where: { id: pending.id },
    data: {
      status: body.decision,
      decidedBy: ctx.userId,
      decidedAt: new Date(),
      note: body.note ?? "",
    },
  });
  await auditLog(ctx.workspaceId, ctx.userId, "campaign.approval_decided", {
    type: "campaign",
    id: campaign.id,
    approvalId: approval.id,
    decision: body.decision,
  });
  return ok({ approval });
});
