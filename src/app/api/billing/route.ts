import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { currentMonth, getUsage, resolvePlan } from "@/lib/billing/usage";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Billing visibility is restricted to MANAGER+ — agents and analysts
  // cannot see plan limits or usage.
  requireRole(ctx, "MANAGER");

  const plan = await resolvePlan(ctx.workspaceId);
  const month = currentMonth();
  const usage = await getUsage(ctx.workspaceId, month);
  const seatsUsed = await db.membership.count({ where: { workspaceId: ctx.workspaceId } });
  const workflowsTotal = await db.workflow.count({ where: { workspaceId: ctx.workspaceId } });
  const wsRow = await db.workspace.findUnique({
    where: { id: ctx.workspaceId },
    select: { isDemo: true },
  });

  return ok({
    plan: {
      id: plan.id,
      name: plan.name,
      monthlyMessageLimit: plan.monthlyMessageLimit,
      workflowLimit: plan.workflowLimit,
      // workflowLimit caps DEFINED workflows (Workflow rows), not
      // executions — executions are metered as usage.workflowsRun only.
      workflowLimitMeaning: "defined_workflows",
      seatLimit: plan.seatLimit,
      connectedAccountLimit: plan.connectedAccountLimit,
      features: plan.features,
    },
    // Plan-state honesty (Batch C): there is no payment provider and no
    // subscription/trial lifecycle in this build — a workspace's plan is
    // either its demo seed or assigned by an administrator.
    assignment: {
      source: wsRow?.isDemo ? "demo" : "manual",
      note: "No payment provider is configured, so no payment was processed for this plan. Plans are assigned by an administrator; this workspace is not on a paid subscription or a trial.",
    },
    usage: {
      month,
      messagesSent: usage.messagesSent,
      messagesReceived: usage.messagesReceived,
      workflowsRun: usage.workflowsRun,
      automationsRun: usage.automationsRun,
      apiCalls: usage.apiCalls,
      seatsUsed,
      workflowsTotal,
    },
    note: "Usage shown is live data recorded for this workspace this month. Plan changes are made by your administrator — nothing here charges you automatically.",
  });
});
