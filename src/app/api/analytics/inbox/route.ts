import { NextRequest } from "next/server";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import {
  analyticsQuerySchema,
  resolveAnalyticsQuery,
  previousPeriod,
  deltaPct,
  conversationStats,
  messagesByDay,
  medianFirstResponseSeconds,
} from "@/lib/analytics/queries";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const q = parseQuery(req, analyticsQuerySchema);
  const { from, to, channel, compare, rangeLabel, includeTestData } = resolveAnalyticsQuery(q);
  const ws = ctx.workspaceId;

  const [convos, msgs, firstResp] = await Promise.all([
    conversationStats(ws, from, to, channel, undefined, includeTestData),
    messagesByDay(ws, from, to, channel, undefined, includeTestData),
    medianFirstResponseSeconds(ws, from, to, channel, undefined, includeTestData),
  ]);
  const messagesIn = msgs.reduce((a, d) => a + d.inbound, 0);
  const messagesOut = msgs.reduce((a, d) => a + d.outbound, 0);

  const metrics = {
    conversations: convos.total,
    open: convos.byStatus["OPEN"] ?? 0,
    pending: convos.byStatus["PENDING"] ?? 0,
    resolved: convos.byStatus["RESOLVED"] ?? 0,
    aiHandled: convos.aiHandled,
    aiHandledPct: convos.aiHandledPct,
    humanTakeover: convos.humanTakeover,
    messagesIn,
    messagesOut,
    medianFirstResponseSec: firstResp,
    byStatus: convos.byStatus,
  };

  let prev: { label: string; metrics: Record<string, number | null> } | undefined;
  if (compare) {
    const p = previousPeriod(from, to);
    const [pConvos, pMsgs] = await Promise.all([
      conversationStats(ws, p.from, p.to, channel, undefined, includeTestData),
      messagesByDay(ws, p.from, p.to, channel, undefined, includeTestData),
    ]);
    const pIn = pMsgs.reduce((a, d) => a + d.inbound, 0);
    const pOut = pMsgs.reduce((a, d) => a + d.outbound, 0);
    prev = {
      label: `vs previous ${rangeLabel}`,
      metrics: {
        conversations: pConvos.total,
        conversationsDelta: deltaPct(convos.total, pConvos.total),
        messagesIn: pIn,
        messagesInDelta: deltaPct(messagesIn, pIn),
        messagesOut: pOut,
        messagesOutDelta: deltaPct(messagesOut, pOut),
        resolved: pConvos.byStatus["RESOLVED"] ?? 0,
        resolvedDelta: deltaPct(convos.byStatus["RESOLVED"] ?? 0, pConvos.byStatus["RESOLVED"] ?? 0),
      },
    };
  }

  return ok({ metrics, series: msgs, byChannel: convos.byChannel, previousPeriod: prev, testDataIncluded: includeTestData });
});
