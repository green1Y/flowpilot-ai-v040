import { NextRequest } from "next/server";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import {
  analyticsQuerySchema,
  resolveAnalyticsQuery,
  previousPeriod,
  deltaPct,
  retargetingAnalytics,
} from "@/lib/analytics/queries";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const q = parseQuery(req, analyticsQuerySchema);
  const { from, to, compare, rangeLabel, includeTestData } = resolveAnalyticsQuery(q);

  const current = await retargetingAnalytics(ctx.workspaceId, from, to);
  const metrics = {
    campaigns: current.campaigns,
    sent: current.sent,
    delivered: current.delivered,
    failed: current.failed,
    skipped: current.skipped,
    replied: current.replied,
    replyRate: current.replyRate,
  };

  let prev: { label: string; metrics: Record<string, number | null> } | undefined;
  if (compare) {
    const p = previousPeriod(from, to);
    const past = await retargetingAnalytics(ctx.workspaceId, p.from, p.to);
    prev = {
      label: `vs previous ${rangeLabel}`,
      metrics: {
        sent: past.sent,
        sentDelta: deltaPct(current.sent, past.sent),
        delivered: past.delivered,
        deliveredDelta: deltaPct(current.delivered, past.delivered),
        replied: past.replied,
        repliedDelta: deltaPct(current.replied, past.replied),
        replyRate: past.replyRate,
      },
    };
  }

  return ok({
    metrics,
    series: current.sentByDay,
    perCampaign: current.perCampaign,
    previousPeriod: prev,
    testDataIncluded: includeTestData,
  });
});
