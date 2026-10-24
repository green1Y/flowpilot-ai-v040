import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { analyticsQuerySchema, resolveAnalyticsQuery } from "@/lib/analytics/queries";

/**
 * Advertising analytics — honest by design.
 *
 * FlowPilot does not collect ad spend, impressions, or ROAS from any provider.
 * This endpoint only reports what actually exists in the database:
 * `paid_ad` retargeting campaigns (counts + recipient outcomes + any
 * *planned* budgets the user entered). Spend/ROAS are reported as
 * unavailable — never invented.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const q = parseQuery(req, analyticsQuerySchema);
  const { from, to, includeTestData } = resolveAnalyticsQuery(q);

  const campaigns = await db.retargetingCampaign.findMany({
    where: { workspaceId: ctx.workspaceId, type: "paid_ad", createdAt: { gte: from, lte: to } },
    select: { id: true, name: true, status: true, budget: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  let plannedBudgetTotal = 0;
  let plannedBudgetCurrency: string | null = null;
  const listed = campaigns.map((c) => {
    let planned: number | null = null;
    let currency: string | null = null;
    try {
      const b = JSON.parse(c.budget || "{}") as { amount?: unknown; currency?: unknown };
      if (typeof b.amount === "number" && Number.isFinite(b.amount)) {
        planned = b.amount;
        plannedBudgetTotal += b.amount;
      }
      if (typeof b.currency === "string") {
        currency = b.currency;
        if (!plannedBudgetCurrency) plannedBudgetCurrency = b.currency;
      }
    } catch {
      /* malformed budget JSON — ignore */
    }
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      plannedBudget: planned,
      currency,
      createdAt: c.createdAt.toISOString(),
    };
  });

  const metrics = {
    available: campaigns.length > 0,
    campaigns: campaigns.length,
    // Planned (user-entered) budgets — explicitly NOT measured spend.
    plannedBudgetTotal: campaigns.length > 0 ? plannedBudgetTotal : null,
    plannedBudgetCurrency,
    // Provider ad metrics — unavailable, never estimated.
    spendAvailable: false,
    spend: null,
    roasAvailable: false,
    roas: null,
    impressionsAvailable: false,
    note: "FlowPilot doesn't collect ad spend, impressions, or ROAS from ad providers yet. What you see here comes only from paid_ad retargeting campaigns you created in this workspace.",
  };

  return ok({ metrics, series: [], campaigns: listed, previousPeriod: undefined, testDataIncluded: includeTestData });
});
