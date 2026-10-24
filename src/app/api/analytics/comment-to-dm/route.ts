import { NextRequest } from "next/server";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import {
  analyticsQuerySchema,
  resolveAnalyticsQuery,
  previousPeriod,
  deltaPct,
  commentToDmAnalytics,
} from "@/lib/analytics/queries";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const q = parseQuery(req, analyticsQuerySchema);
  const { from, to, compare, rangeLabel, includeTestData } = resolveAnalyticsQuery(q);

  const current = await commentToDmAnalytics(ctx.workspaceId, from, to);
  const metrics = {
    comments: current.comments,
    privateReplies: current.privateReplies,
    replyRate: current.replyRate,
    avgReplyDelayMinutes: current.avgReplyDelayMinutes,
    windowExpired: current.windowExpired,
  };

  let prev: { label: string; metrics: Record<string, number | null> } | undefined;
  if (compare) {
    const p = previousPeriod(from, to);
    const past = await commentToDmAnalytics(ctx.workspaceId, p.from, p.to);
    prev = {
      label: `vs previous ${rangeLabel}`,
      metrics: {
        comments: past.comments,
        commentsDelta: deltaPct(current.comments, past.comments),
        privateReplies: past.privateReplies,
        privateRepliesDelta: deltaPct(current.privateReplies, past.privateReplies),
        replyRate: past.replyRate,
        replyRateDeltaPp:
          current.replyRate != null && past.replyRate != null
            ? current.replyRate - past.replyRate
            : null,
      },
    };
  }

  return ok({
    metrics,
    series: current.commentsByDay,
    topMedia: current.topMedia,
    previousPeriod: prev,
    testDataIncluded: includeTestData,
  });
});
