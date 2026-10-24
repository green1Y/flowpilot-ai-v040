import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { processCampaign } from "@/lib/messaging/campaigns";

/**
 * Scheduler worker endpoint (per workspace): flip due SCHEDULED campaigns to
 * RUNNING and process one batch for each. A campaign only starts when its
 * scheduledAt has passed AND it has at least one PENDING recipient.
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Launch-control / send-adjacent action: MANAGER+.
  requireRole(ctx, "MANAGER");
  const now = new Date();

  const due = await db.campaign.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      status: "SCHEDULED",
      scheduledAt: { lte: now },
    },
    orderBy: { scheduledAt: "asc" },
  });

  const started: string[] = [];
  const results: { campaignId: string; process: unknown }[] = [];

  for (const campaign of due) {
    const pending = await db.campaignRecipient.count({
      where: { campaignId: campaign.id, status: "PENDING" },
    });
    if (pending === 0) continue;

    await db.campaign.update({
      where: { id: campaign.id },
      data: { status: "RUNNING", startedAt: campaign.startedAt ?? now },
    });
    await auditLog(ctx.workspaceId, ctx.userId, "campaign.started", {
      type: "campaign",
      id: campaign.id,
      pending,
      reason: "scheduled time reached",
    });
    started.push(campaign.id);

    try {
      const process = await processCampaign(ctx.workspaceId, campaign.id, {
        userId: ctx.userId,
        now,
      });
      results.push({ campaignId: campaign.id, process });
    } catch (e) {
      // One bad campaign never stops the worker; record and continue.
      console.warn("[campaigns/process-due] campaign failed", campaign.id, e);
      results.push({ campaignId: campaign.id, process: { error: "batch failed" } });
    }
  }

  await auditLog(ctx.workspaceId, ctx.userId, "campaign.process_due", {
    type: "worker",
    started,
  });

  return ok({ started, results });
});
