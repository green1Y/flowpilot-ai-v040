import { NextRequest } from "next/server";
import { handler, ok, err, parseQuery } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import {
  analyticsQuerySchema,
  resolveAnalyticsQuery,
  previousPeriod,
  deltaPct,
  channelAnalytics,
  messagesByDay,
  integrationInWorkspace,
} from "@/lib/analytics/queries";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const q = parseQuery(req, analyticsQuerySchema);
  const { from, to, compare, rangeLabel, integrationId, includeTestData } = resolveAnalyticsQuery(q);
  const ws = ctx.workspaceId;

  // Batch B: an account filter must name an account of THIS workspace.
  if (integrationId && !(await integrationInWorkspace(ws, integrationId))) {
    throw err("Integration not found in this workspace", 403);
  }

  const [rows, msgs] = await Promise.all([
    channelAnalytics(ws, from, to, integrationId, includeTestData),
    messagesByDay(ws, from, to, undefined, integrationId, includeTestData),
  ]);

  const totals = rows.reduce(
    (a, r) => ({
      conversations: a.conversations + r.conversations,
      messagesIn: a.messagesIn + r.messagesIn,
      messagesOut: a.messagesOut + r.messagesOut,
      outboundSent: a.outboundSent + r.outboundSent,
      outboundFailed: a.outboundFailed + r.outboundFailed,
    }),
    { conversations: 0, messagesIn: 0, messagesOut: 0, outboundSent: 0, outboundFailed: 0 },
  );

  let prev: { label: string; metrics: Record<string, number | null> } | undefined;
  if (compare) {
    const p = previousPeriod(from, to);
    const pRows = await channelAnalytics(ws, p.from, p.to, integrationId, includeTestData);
    const pTotals = pRows.reduce(
      (a, r) => ({ messagesIn: a.messagesIn + r.messagesIn, messagesOut: a.messagesOut + r.messagesOut }),
      { messagesIn: 0, messagesOut: 0 },
    );
    prev = {
      label: `vs previous ${rangeLabel}`,
      metrics: {
        messagesIn: pTotals.messagesIn,
        messagesInDelta: deltaPct(totals.messagesIn, pTotals.messagesIn),
        messagesOut: pTotals.messagesOut,
        messagesOutDelta: deltaPct(totals.messagesOut, pTotals.messagesOut),
      },
    };
  }

  return ok({ metrics: { totals, channels: rows }, series: msgs, previousPeriod: prev, testDataIncluded: includeTestData });
});
