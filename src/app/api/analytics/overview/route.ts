import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseQuery } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import {
  analyticsQuerySchema,
  resolveAnalyticsQuery,
  previousPeriod,
  deltaPct,
  dayKeys,
  shortDayLabel,
  conversationStats,
  messagesByDay,
  medianFirstResponseSeconds,
  workflowAnalytics,
  crmAnalytics,
  followUpAnalytics,
  integrationInWorkspace,
  nonTestConversationFilter,
} from "@/lib/analytics/queries";

async function conversationsByDay(
  workspaceId: string,
  from: Date,
  to: Date,
  channel?: string,
  integrationId?: string,
  includeTestData = false
) {
  const keys = dayKeys(from, to);
  const buckets = new Map(keys.map((k) => [k, 0]));
  const rows = await db.conversation.findMany({
    where: {
      workspaceId,
      createdAt: { gte: from, lte: to },
      ...(channel ? { channel } : {}),
      ...(integrationId ? { integrationId } : {}),
      // Same production rule as conversationStats (queries.ts).
      ...nonTestConversationFilter(includeTestData),
    },
    select: { createdAt: true },
  });
  for (const r of rows) {
    const k = r.createdAt.toISOString().slice(0, 10);
    const b = buckets.get(k);
    if (b !== undefined) buckets.set(k, b + 1);
  }
  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
}

/** New contacts (leads) in range, grouped by channel. */
async function leadsByChannel(workspaceId: string, from: Date, to: Date, channel?: string) {
  const groups = await db.contact.groupBy({
    by: ["channel"],
    where: {
      workspaceId,
      firstSeenAt: { gte: from, lte: to },
      ...(channel ? { channel } : {}),
    },
    _count: { channel: true },
  });
  return groups
    .map((g) => ({ channel: g.channel, leads: g._count.channel }))
    .sort((a, b) => b.leads - a.leads);
}

/** Latest conversations in range with contact + last message (for the dashboard list). */
async function recentConversations(
  workspaceId: string,
  from: Date,
  to: Date,
  channel?: string,
  take = 5,
  integrationId?: string,
  includeTestData = false
) {
  const rows = await db.conversation.findMany({
    where: {
      workspaceId,
      createdAt: { gte: from, lte: to },
      ...(channel ? { channel } : {}),
      ...(integrationId ? { integrationId } : {}),
      // Same production rule as conversationStats (queries.ts).
      ...nonTestConversationFilter(includeTestData),
    },
    include: {
      contact: { select: { name: true } },
      messages: {
        where: { internalNote: false },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { body: true },
      },
    },
    orderBy: { updatedAt: "desc" },
    take,
  });
  return rows.map((c) => ({
    id: c.id,
    contactName: c.contact.name,
    channel: c.channel,
    lastMessage: c.messages[0]?.body ?? null,
    status: c.status,
    updatedAt: c.updatedAt.toISOString(),
  }));
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const q = parseQuery(req, analyticsQuerySchema);
  const { from, to, channel, compare, rangeLabel, integrationId, includeTestData } =
    resolveAnalyticsQuery(q);
  const ws = ctx.workspaceId;

  // Batch B: an account filter must name an account of THIS workspace.
  if (integrationId && !(await integrationInWorkspace(ws, integrationId))) {
    throw err("Integration not found in this workspace", 403);
  }

  const [convos, msgs, firstResp, wf, crm, fu, convDay] = await Promise.all([
    conversationStats(ws, from, to, channel, integrationId, includeTestData),
    messagesByDay(ws, from, to, channel, integrationId, includeTestData),
    medianFirstResponseSeconds(ws, from, to, channel, integrationId, includeTestData),
    workflowAnalytics(ws, from, to, integrationId, includeTestData),
    crmAnalytics(ws, from, to, integrationId),
    followUpAnalytics(ws, from, to, channel),
    conversationsByDay(ws, from, to, channel, integrationId, includeTestData),
  ]);

  const messagesIn = msgs.reduce((a, d) => a + d.inbound, 0);
  const messagesOut = msgs.reduce((a, d) => a + d.outbound, 0);
  const newLeads = crm.newContactsByDay.reduce((a, d) => a + d.count, 0);

  const series = msgs.map((m, i) => ({
    date: m.date,
    label: shortDayLabel(m.date),
    conversations: convDay[i]?.count ?? 0,
    messages: m.inbound + m.outbound,
    leads: crm.newContactsByDay[i]?.count ?? 0,
    inbound: m.inbound,
    outbound: m.outbound,
  }));

  const metrics = {
    conversations: convos.total,
    aiHandledPct: convos.aiHandledPct,
    messagesIn,
    messagesOut,
    newLeads,
    workflowRuns: wf.totals.runs,
    workflowDryRuns: wf.totals.dryRuns,
    workflowSuccessRate: wf.totals.successRate,
    medianFirstResponseSec: firstResp,
    conversionRate: crm.conversionRate,
    followUpsSent: fu.sent,
  };

  let prev: { label: string; metrics: Record<string, number | null> } | undefined;
  let pFirstResp: number | null = null;
  if (compare) {
    const p = previousPeriod(from, to);
    const [pConvos, pMsgs, pWf, pCrm, pResp] = await Promise.all([
      conversationStats(ws, p.from, p.to, channel, integrationId, includeTestData),
      messagesByDay(ws, p.from, p.to, channel, integrationId, includeTestData),
      workflowAnalytics(ws, p.from, p.to, integrationId, includeTestData),
      crmAnalytics(ws, p.from, p.to, integrationId),
      medianFirstResponseSeconds(ws, p.from, p.to, channel, integrationId, includeTestData),
    ]);
    pFirstResp = pResp;
    const pIn = pMsgs.reduce((a, d) => a + d.inbound, 0);
    const pOut = pMsgs.reduce((a, d) => a + d.outbound, 0);
    const pLeads = pCrm.newContactsByDay.reduce((a, d) => a + d.count, 0);
    prev = {
      label: `vs previous ${rangeLabel}`,
      metrics: {
        conversations: pConvos.total,
        conversationsDelta: deltaPct(convos.total, pConvos.total),
        messagesIn: pIn,
        messagesInDelta: deltaPct(messagesIn, pIn),
        messagesOut: pOut,
        messagesOutDelta: deltaPct(messagesOut, pOut),
        newLeads: pLeads,
        newLeadsDelta: deltaPct(newLeads, pLeads),
        workflowRuns: pWf.totals.runs,
        workflowRunsDelta: deltaPct(wf.totals.runs, pWf.totals.runs),
      },
    };
    // Stash previous-period raw values the dashboard KPIs need for deltas.
    (prev.metrics as Record<string, number | null>).aiHandled = pConvos.aiHandled;
  }

  // --- Dashboard payload for /app/overview (additive; the analytics-tab
  // shape above is unchanged). Every number here comes from authorized DB
  // records — nothing is estimated. `demo` (below) is read from
  // Workspace.isDemo for THIS workspace so the overview page's demo badge
  // can actually appear for demo workspaces (Batch C fix — it was
  // previously hardcoded false).
  const qualifiedCount =
    (crm.byStage.find((s) => s.stage === "QUALIFIED")?.count ?? 0) +
    (crm.byStage.find((s) => s.stage === "INTERESTED")?.count ?? 0) +
    (crm.byStage.find((s) => s.stage === "CONVERTED")?.count ?? 0);
  const pConvosTotal = prev?.metrics.conversations ?? 0;
  const kpi = (
    value: number | null,
    delta?: number | null
  ): { value: number | string; delta?: number } => {
    const out: { value: number | string; delta?: number } = { value: value ?? "—" };
    if (delta !== undefined && delta !== null) out.delta = delta;
    return out;
  };
  const [leadsCh, recent, unresolved, drafts, workspaceRow] = await Promise.all([
    leadsByChannel(ws, from, to, channel),
    recentConversations(ws, from, to, channel, 5, integrationId, includeTestData),
    db.conversation.count({
      where: {
        workspaceId: ws,
        status: "OPEN",
        ...(channel ? { channel } : {}),
        ...(integrationId ? { integrationId } : {}),
        // Same production rule as conversationStats (queries.ts).
        ...nonTestConversationFilter(includeTestData),
      },
    }),
    db.workflow.count({ where: { workspaceId: ws, status: "DRAFT" } }),
    db.workspace.findUnique({ where: { id: ws }, select: { isDemo: true } }),
  ]);

  return ok({
    metrics,
    series,
    previousPeriod: prev,
    // Batch C: true only when the caller explicitly opted in with
    // ?includeTestData=1|true — headline metrics then include mocked
    // messages and DRY_RUN executions.
    testDataIncluded: includeTestData,
    // Dashboard (/app/overview) fields:
    demo: workspaceRow?.isDemo ?? false,
    kpis: {
      totalConversations: kpi(convos.total, deltaPct(convos.total, pConvosTotal)),
      aiHandled: kpi(convos.aiHandled, deltaPct(convos.aiHandled, prev?.metrics.aiHandled ?? 0)),
      newLeads: kpi(newLeads, deltaPct(newLeads, prev?.metrics.newLeads ?? 0)),
      qualifiedLeads: kpi(qualifiedCount),
      automationRuns: kpi(wf.totals.runs, deltaPct(wf.totals.runs, prev?.metrics.workflowRuns ?? 0)),
      messagesSent: kpi(messagesOut, deltaPct(messagesOut, prev?.metrics.messagesOut ?? 0)),
      avgResponseTime: kpi(
        firstResp,
        firstResp != null && pFirstResp != null ? deltaPct(firstResp, pFirstResp) : undefined
      ),
      conversionRate: kpi(crm.conversionRate),
    },
    leadsByChannel: leadsCh,
    topAutomations: wf.perWorkflow.slice(0, 5).map((w) => ({
      id: w.id,
      name: w.name,
      runs: w.runs,
      status: w.status,
    })),
    recentConversations: recent,
    unresolvedConversations: unresolved,
    draftWorkflows: drafts,
  });
});
