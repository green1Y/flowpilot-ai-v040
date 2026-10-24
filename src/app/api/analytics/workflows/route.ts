import { NextRequest } from "next/server";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import {
  analyticsQuerySchema,
  resolveAnalyticsQuery,
  previousPeriod,
  deltaPct,
  workflowAnalytics,
} from "@/lib/analytics/queries";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const q = parseQuery(req, analyticsQuerySchema);
  const { from, to, compare, rangeLabel, includeTestData } = resolveAnalyticsQuery(q);

  const current = await workflowAnalytics(ctx.workspaceId, from, to, undefined, includeTestData);
  const metrics = { ...current.totals, workflowsActive: current.perWorkflow.length };

  let prev: { label: string; metrics: Record<string, number | null> } | undefined;
  if (compare) {
    const p = previousPeriod(from, to);
    const past = await workflowAnalytics(ctx.workspaceId, p.from, p.to, undefined, includeTestData);
    prev = {
      label: `vs previous ${rangeLabel}`,
      metrics: {
        runs: past.totals.runs,
        runsDelta: deltaPct(current.totals.runs, past.totals.runs),
        successRate: past.totals.successRate,
        successRateDeltaPp:
          current.totals.successRate != null && past.totals.successRate != null
            ? current.totals.successRate - past.totals.successRate
            : null,
      },
    };
  }

  return ok({ metrics, series: current.runsByDay, perWorkflow: current.perWorkflow, previousPeriod: prev, testDataIncluded: includeTestData });
});
