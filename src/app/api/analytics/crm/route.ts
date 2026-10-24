import { NextRequest } from "next/server";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import {
  analyticsQuerySchema,
  resolveAnalyticsQuery,
  previousPeriod,
  deltaPct,
  crmAnalytics,
} from "@/lib/analytics/queries";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const q = parseQuery(req, analyticsQuerySchema);
  const { from, to, compare, rangeLabel, includeTestData } = resolveAnalyticsQuery(q);

  const current = await crmAnalytics(ctx.workspaceId, from, to);
  const newContacts = current.newContactsByDay.reduce((a, d) => a + d.count, 0);
  const metrics = {
    total: current.total,
    newContacts,
    converted: current.converted,
    conversionRate: current.conversionRate,
    optedOut: current.optedOut,
    avgLeadScore: current.avgLeadScore,
    byStage: current.byStage,
  };

  let prev: { label: string; metrics: Record<string, number | null> } | undefined;
  if (compare) {
    const p = previousPeriod(from, to);
    const past = await crmAnalytics(ctx.workspaceId, p.from, p.to);
    const pNew = past.newContactsByDay.reduce((a, d) => a + d.count, 0);
    prev = {
      label: `vs previous ${rangeLabel}`,
      metrics: {
        newContacts: pNew,
        newContactsDelta: deltaPct(newContacts, pNew),
        optedOut: past.optedOut,
        optedOutDelta: deltaPct(current.optedOut, past.optedOut),
        conversionRate: past.conversionRate,
      },
    };
  }

  return ok({ metrics, series: current.newContactsByDay, previousPeriod: prev, testDataIncluded: includeTestData });
});
