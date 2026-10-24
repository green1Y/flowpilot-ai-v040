import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { serializeCampaign } from "@/lib/serialize";
import { auditLog } from "@/lib/audit";
import { scopedCampaign } from "@/app/api/campaigns/campaign-helpers";
import { requirePlanLimit } from "@/lib/billing/usage";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Start (or resume) a campaign: DRAFT/PAUSED → RUNNING. Requires at least one
 * PENDING recipient — build the list first. The scheduler/cron drives actual
 * sends via POST .../process.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Launch-control / send-adjacent action: MANAGER+.
  requireRole(ctx, "MANAGER");
  const campaign = await scopedCampaign(ctx.workspaceId, (await params).id);

  // Wave 2D approval gate (surgical; everything below is unchanged):
  // PENDING approval blocks start; a latest REJECTED decision blocks start;
  // APPROVED — or no approval request at all — starts exactly as before.
  const pendingApproval = await db.campaignApproval.findFirst({
    where: { workspaceId: ctx.workspaceId, campaignId: campaign.id, status: "PENDING" },
  });
  if (pendingApproval) {
    throw err("Campaign approval is pending — it cannot start until approved", 409, {
      code: "APPROVAL_PENDING",
      approvalId: pendingApproval.id,
    });
  }
  const latestApproval = await db.campaignApproval.findFirst({
    where: { workspaceId: ctx.workspaceId, campaignId: campaign.id },
    orderBy: { createdAt: "desc" },
  });
  if (latestApproval?.status === "REJECTED") {
    throw err("Campaign approval was rejected — request approval again before starting", 409, {
      code: "APPROVAL_REJECTED",
      approvalId: latestApproval.id,
    });
  }

  // Stage 4d: launching a campaign sends messages — enforce the plan limit.
  await requirePlanLimit(ctx.workspaceId, "messages");

  if (campaign.status !== "DRAFT" && campaign.status !== "PAUSED") {
    throw err(`Campaign cannot be started from status ${campaign.status}`, 422);
  }

  const pending = await db.campaignRecipient.count({
    where: { campaignId: campaign.id, status: "PENDING" },
  });
  if (pending === 0) {
    throw err(
      "Build the recipient list first — starting requires at least one eligible (PENDING) recipient",
      422
    );
  }

  const updated = await db.campaign.update({
    where: { id: campaign.id },
    data: {
      status: "RUNNING",
      startedAt: campaign.startedAt ?? new Date(),
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "campaign.started", {
    type: "campaign",
    id: campaign.id,
    pending,
  });

  return ok({ campaign: serializeCampaign(updated) });
});
