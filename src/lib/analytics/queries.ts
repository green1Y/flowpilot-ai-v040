/**
 * Premium Analytics — tenant-scoped aggregation helpers.
 *
 * Every helper takes `workspaceId` first and scopes ALL Prisma queries to it.
 * All numbers returned are computed from real DB rows — nothing is estimated
 * or invented. Callers label derived estimates explicitly.
 */
import { z } from "zod";
import { db } from "@/lib/db";

/* ------------------------------------------------------------------ */
/* Query params (Zod)                                                  */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/** Matches a bare calendar date like "2026-10-20" (no time component). */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize a query bound to a Date. A date-only bound ("YYYY-MM-DD") covers
 * the whole day in UTC: `from` → start of day, `to` → end of day. Without
 * this, a custom range ending "2026-10-20" would silently exclude everything
 * on Oct 20 (midnight bound), and a single-day range would fail validation.
 */
export function expandRangeBound(raw: string, endOfDay: boolean): Date {
  const s = raw.trim();
  if (DATE_ONLY.test(s)) {
    return new Date(`${s}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  }
  return new Date(s);
}

export const analyticsQuerySchema = z
  .object({
    range: z.enum(["7d", "30d", "90d", "custom"]).default("7d"),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    channel: z.string().max(40).optional(),
    campaignId: z.string().max(40).optional(),
    integrationId: z.string().max(64).optional(),
    compare: z.enum(["on", "off"]).default("on"),
    // Batch C (analytics integrity): opt-in inclusion of test activity
    // (mocked messages + DRY_RUN executions) in headline metrics. Accepted
    // values mirror the query-string form ("1"/"true"); absent, "0", or
    // "false" keeps the production-only default.
    includeTestData: z
      .union([z.enum(["1", "true", "0", "false"]), z.boolean()])
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.range === "custom") {
      if (!v.from || !v.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "custom range requires from and to (ISO dates)",
        });
        return;
      }
      // Date-only bounds are expanded to whole days (UTC) so a custom range
      // like 2026-10-01 → 2026-10-20 includes all of Oct 20 (and a
      // single-day range passes validation).
      const from = expandRangeBound(v.from, false);
      const to = expandRangeBound(v.to, true);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "from/to must be valid ISO dates" });
      } else if (to <= from) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "to must be after from" });
      } else if (to.getTime() - from.getTime() > 366 * DAY_MS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "range is capped at 366 days" });
      }
    }
  });

export type AnalyticsQuery = z.input<typeof analyticsQuerySchema>;

export interface ResolvedRange {
  from: Date;
  to: Date;
  channel?: string;
  campaignId?: string;
  /** Batch B: connected-account (Integration row id) scope, when selected. */
  integrationId?: string;
  /**
   * Batch C: when true, mocked messages and DRY_RUN executions are
   * included in headline metrics (and API responses flag
   * `testDataIncluded: true`). Defaults to false — production-only.
   */
  includeTestData: boolean;
  compare: boolean;
  /** Human label for the range ("7d", "30d", "90d", "period" for custom). */
  rangeLabel: string;
}

/** Resolve a validated query into concrete bounds. Defaults are applied defensively. */
export function resolveAnalyticsQuery(q: AnalyticsQuery): ResolvedRange {
  const range = q.range ?? "7d";
  const now = new Date();
  let from: Date;
  let to: Date;
  if (range === "custom") {
    // Date-only bounds cover whole days (UTC) — see expandRangeBound.
    from = expandRangeBound(q.from as string, false);
    to = expandRangeBound(q.to as string, true);
  } else {
    const days = range === "30d" ? 30 : range === "90d" ? 90 : 7;
    to = now;
    from = new Date(now.getTime() - days * DAY_MS);
  }
  // "all" is a UI-only value meaning "no channel filter" — never a literal
  // channel name. Mapping it here keeps every consumer correct even if a
  // caller passes it through verbatim.
  const channel = q.channel && q.channel !== "all" ? q.channel : undefined;
  return {
    from,
    to,
    channel,
    campaignId: q.campaignId || undefined,
    integrationId: q.integrationId || undefined,
    includeTestData: q.includeTestData === true || q.includeTestData === "1" || q.includeTestData === "true",
    compare: (q.compare ?? "on") === "on",
    rangeLabel: range === "custom" ? "period" : range,
  };
}

/**
 * Batch B tenant check for an account filter: true only when the named
 * Integration row belongs to this workspace. Routes MUST call this before
 * honoring an `integrationId` query param and 403 on false — a foreign id
 * must never yield another workspace's data.
 */
export async function integrationInWorkspace(
  workspaceId: string,
  integrationId: string,
): Promise<boolean> {
  const row = await db.integration.findFirst({
    where: { id: integrationId, workspaceId },
    select: { id: true },
  });
  return row !== null;
}

/* ------------------------------------------------------------------ */
/* Range utilities                                                     */
/* ------------------------------------------------------------------ */

/** Calendar-day keys (UTC, YYYY-MM-DD) covering [from, to], zero-filled. */
export function dayKeys(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  let guard = 0;
  while (cursor <= end && guard++ < 400) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

/** The immediately preceding period of identical length (non-overlapping). */
export function previousPeriod(from: Date, to: Date): { from: Date; to: Date } {
  const len = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - len), to: new Date(from.getTime()) };
}

/** Percent change of current vs previous. null when there is no baseline. */
export function deltaPct(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Short label for a day key: "Oct 19". */
export function shortDayLabel(dayKey: string): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function dayOf(ts: Date): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Test-activity exclusion (Batch C — analytics integrity)             */
/* ------------------------------------------------------------------ */

/**
 * Production-view filter for conversation-level metrics.
 *
 * Exclusion rule (one rule, applied consistently by conversationStats,
 * channelAnalytics, and the overview route's conversation counts/lists):
 * `Message.mocked` lives on the message row — a Conversation row carries
 * no mocked flag of its own. A conversation therefore counts in the
 * production view when it is EMPTY (no messages yet — a real container,
 * e.g. a manually created or just-opened conversation, not test
 * activity) OR when it contains at least one non-mocked message. A
 * conversation whose every message is mocked exists only because of
 * mock/simulated activity, so it is excluded by default. Metrics computed
 * FROM messages (messagesByDay, medianFirstResponseSeconds, per-channel
 * message counts) filter `mocked: false` on the message rows directly.
 * Pass includeTestData=true to opt back into the inclusive view.
 */
export function nonTestConversationFilter(includeTestData = false): {
  OR?: [
    { messages: { none: Record<string, never> } },
    { messages: { some: { mocked: boolean } } },
  ];
} {
  if (includeTestData) return {};
  return {
    OR: [
      { messages: { none: {} } },
      { messages: { some: { mocked: false } } },
    ],
  };
}

/** Message-row filter counterpart of nonTestConversationFilter. */
export function nonTestMessageFilter(includeTestData = false): { mocked?: boolean } {
  return includeTestData ? {} : { mocked: false };
}

/** True when a workflow execution is a dry run (status and/or flag). */
export function isDryRunExecution(e: { status: string; dryRun?: boolean | null }): boolean {
  return e.status === "DRY_RUN" || e.dryRun === true;
}

/* ------------------------------------------------------------------ */
/* CustomerEvent helpers                                               */
/* ------------------------------------------------------------------ */

export interface DayCounts {
  date: string;
  counts: Record<string, number>;
  total: number;
}

/**
 * Per-type event counts grouped by calendar day, zero-filled for every day
 * in [from, to]. Only the requested `types` are included.
 */
export async function eventsByDay(
  workspaceId: string,
  types: string[],
  from: Date,
  to: Date,
  provider?: string,
  integrationId?: string,
): Promise<DayCounts[]> {
  const keys = dayKeys(from, to);
  const buckets = new Map<string, DayCounts>(
    keys.map((k) => [
      k,
      { date: k, counts: Object.fromEntries(types.map((t) => [t, 0])), total: 0 },
    ]),
  );
  if (types.length === 0) return [...buckets.values()];
  const rows = await db.customerEvent.findMany({
    where: {
      workspaceId,
      type: { in: types },
      timestamp: { gte: from, lte: to },
      ...(provider ? { provider } : {}),
      ...(integrationId ? { integrationId } : {}),
    },
    select: { timestamp: true, type: true },
  });
  for (const r of rows) {
    const b = buckets.get(dayOf(r.timestamp));
    if (!b) continue;
    b.counts[r.type] = (b.counts[r.type] ?? 0) + 1;
    b.total += 1;
  }
  return [...buckets.values()];
}

/** Total counts per event type in range. Missing types are 0. */
export async function countEvents(
  workspaceId: string,
  types: string[],
  from: Date,
  to: Date,
  provider?: string,
  integrationId?: string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = Object.fromEntries(types.map((t) => [t, 0]));
  if (types.length === 0) return out;
  const groups = await db.customerEvent.groupBy({
    by: ["type"],
    where: {
      workspaceId,
      type: { in: types },
      timestamp: { gte: from, lte: to },
      ...(provider ? { provider } : {}),
      ...(integrationId ? { integrationId } : {}),
    },
    _count: { type: true },
  });
  for (const g of groups) out[g.type] = g._count.type;
  return out;
}

/** Event volume by provider channel (messages/comments across all types). */
export async function eventsByChannel(
  workspaceId: string,
  types: string[],
  from: Date,
  to: Date,
  integrationId?: string,
): Promise<{ channel: string; count: number }[]> {
  const groups = await db.customerEvent.groupBy({
    by: ["provider"],
    where: {
      workspaceId,
      type: { in: types },
      timestamp: { gte: from, lte: to },
      ...(integrationId ? { integrationId } : {}),
    },
    _count: { provider: true },
  });
  return groups
    .map((g) => ({ channel: g.provider ?? "unknown", count: g._count.provider }))
    .sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------------ */
/* Conversations / messages                                            */
/* ------------------------------------------------------------------ */

export interface ConversationStats {
  total: number;
  byChannel: { channel: string; count: number }[];
  byStatus: Record<string, number>;
  aiHandled: number;
  aiHandledPct: number | null;
  humanTakeover: number;
}

export async function conversationStats(
  workspaceId: string,
  from: Date,
  to: Date,
  channel?: string,
  integrationId?: string,
  includeTestData = false,
): Promise<ConversationStats> {
  const where = {
    workspaceId,
    createdAt: { gte: from, lte: to },
    ...(channel ? { channel } : {}),
    ...(integrationId ? { integrationId } : {}),
    // Production default: mocked-only conversations excluded — see
    // nonTestConversationFilter for the exact rule.
    ...nonTestConversationFilter(includeTestData),
  };
  const [total, byChannel, byStatus, aiHandled, humanTakeover] = await Promise.all([
    db.conversation.count({ where }),
    db.conversation.groupBy({ by: ["channel"], where, _count: { channel: true } }),
    db.conversation.groupBy({ by: ["status"], where, _count: { status: true } }),
    db.conversation.count({ where: { ...where, aiHandled: true } }),
    db.conversation.count({ where: { ...where, humanTakeover: true } }),
  ]);
  const status: Record<string, number> = {};
  for (const s of byStatus) status[s.status] = s._count.status;
  return {
    total,
    byChannel: byChannel
      .map((c) => ({ channel: c.channel, count: c._count.channel }))
      .sort((a, b) => b.count - a.count),
    byStatus: status,
    aiHandled,
    aiHandledPct: total > 0 ? (aiHandled / total) * 100 : null,
    humanTakeover,
  };
}

export interface DayMessages {
  date: string;
  inbound: number;
  outbound: number;
}

/** Inbound/outbound messages per day (internal notes excluded; mocked messages excluded unless includeTestData). */
export async function messagesByDay(
  workspaceId: string,
  from: Date,
  to: Date,
  channel?: string,
  integrationId?: string,
  includeTestData = false,
): Promise<DayMessages[]> {
  const keys = dayKeys(from, to);
  const buckets = new Map<string, DayMessages>(
    keys.map((k) => [k, { date: k, inbound: 0, outbound: 0 }]),
  );
  const rows = await db.message.findMany({
    where: {
      conversation: {
        workspaceId,
        ...(channel ? { channel } : {}),
        ...(integrationId ? { integrationId } : {}),
      },
      createdAt: { gte: from, lte: to },
      internalNote: false,
      ...nonTestMessageFilter(includeTestData),
    },
    select: { direction: true, createdAt: true },
  });
  for (const r of rows) {
    const b = buckets.get(dayOf(r.createdAt));
    if (!b) continue;
    if (r.direction === "INBOUND") b.inbound += 1;
    else if (r.direction === "OUTBOUND") b.outbound += 1;
  }
  return [...buckets.values()];
}

/**
 * Median seconds from a conversation's first inbound message to the first
 * outbound message after it. null when no conversation has both.
 */
export async function medianFirstResponseSeconds(
  workspaceId: string,
  from: Date,
  to: Date,
  channel?: string,
  integrationId?: string,
  includeTestData = false,
): Promise<number | null> {
  const convos = await db.conversation.findMany({
    where: {
      workspaceId,
      createdAt: { gte: from, lte: to },
      ...(channel ? { channel } : {}),
      ...(integrationId ? { integrationId } : {}),
    },
    select: { id: true },
  });
  if (convos.length === 0) return null;
  const gaps: number[] = [];
  // Bounded batches to keep query sizes sane.
  for (let i = 0; i < convos.length; i += 200) {
    const batch = convos.slice(i, i + 200).map((c) => c.id);
    const msgs = await db.message.findMany({
      where: {
        conversationId: { in: batch },
        internalNote: false,
        // Derived from messages, so the production default uses
        // non-mocked messages only.
        ...nonTestMessageFilter(includeTestData),
        direction: { in: ["INBOUND", "OUTBOUND"] },
      },
      select: { conversationId: true, direction: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const byConvo = new Map<string, typeof msgs>();
    for (const m of msgs) {
      const arr = byConvo.get(m.conversationId) ?? [];
      arr.push(m);
      byConvo.set(m.conversationId, arr);
    }
    for (const list of byConvo.values()) {
      const firstIn = list.find((m) => m.direction === "INBOUND");
      const firstOut = firstIn
        ? list.find((m) => m.direction === "OUTBOUND" && m.createdAt >= firstIn.createdAt)
        : undefined;
      if (firstIn && firstOut) {
        gaps.push((firstOut.createdAt.getTime() - firstIn.createdAt.getTime()) / 1000);
      }
    }
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/* ------------------------------------------------------------------ */
/* Workflows                                                           */
/* ------------------------------------------------------------------ */

export interface WorkflowRun {
  date: string;
  runs: number;
  succeeded: number;
  failed: number;
}

export interface WorkflowRow {
  id: string;
  name: string;
  status: string;
  runs: number;
  succeeded: number;
  failed: number;
  /** Dry-run executions (status DRY_RUN and/or dryRun=true), reported separately — never merged into runs/succeeded/failed in the production view. */
  dryRuns: number;
  successRate: number | null;
  avgDurationMs: number | null;
}

export interface WorkflowAnalytics {
  totals: {
    runs: number;
    succeeded: number;
    failed: number;
    queued: number;
    /** Dry-run executions in range, always reported separately. In the production view they are excluded from runs/succeeded/failed/successRate/avgDurationMs; with includeTestData they are also counted in runs. */
    dryRuns: number;
    successRate: number | null;
    avgDurationMs: number | null;
  };
  runsByDay: WorkflowRun[];
  perWorkflow: WorkflowRow[];
}

export async function workflowAnalytics(
  workspaceId: string,
  from: Date,
  to: Date,
  integrationId?: string,
  includeTestData = false,
): Promise<WorkflowAnalytics> {
  const workflows = await db.workflow.findMany({
    where: { workspaceId },
    select: { id: true, name: true, status: true },
  });
  const keys = dayKeys(from, to);
  const buckets = new Map<string, WorkflowRun>(
    keys.map((k) => [k, { date: k, runs: 0, succeeded: 0, failed: 0 }]),
  );
  const perWorkflow: WorkflowRow[] = [];
  let runs = 0;
  let succeeded = 0;
  let failed = 0;
  let queued = 0;
  let dryRuns = 0;
  let durSum = 0;
  let durN = 0;

  for (const wf of workflows) {
    const execs = await db.workflowExecution.findMany({
      where: {
        workflowId: wf.id,
        startedAt: { gte: from, lte: to },
        ...(integrationId ? { integrationId } : {}),
      },
      select: { status: true, dryRun: true, startedAt: true, finishedAt: true },
    });
    let wRuns = 0;
    let wOk = 0;
    let wFail = 0;
    let wDry = 0;
    let wDurSum = 0;
    let wDurN = 0;
    for (const e of execs) {
      // Dry runs are always tallied separately in `dryRuns`. In the
      // production view they contribute nothing else; with
      // includeTestData they fall through and count like any other run.
      if (isDryRunExecution(e)) {
        dryRuns += 1;
        wDry += 1;
        if (!includeTestData) continue;
      }
      runs += 1;
      wRuns += 1;
      const b = buckets.get(dayOf(e.startedAt));
      if (b) b.runs += 1;
      if (e.status === "SUCCEEDED") {
        succeeded += 1;
        wOk += 1;
        if (b) b.succeeded += 1;
      } else if (e.status === "FAILED" || e.status === "DEAD_LETTER") {
        failed += 1;
        wFail += 1;
        if (b) b.failed += 1;
      } else if (e.status === "QUEUED") {
        queued += 1;
      }
      if (e.finishedAt) {
        const d = e.finishedAt.getTime() - e.startedAt.getTime();
        durSum += d;
        durN += 1;
        wDurSum += d;
        wDurN += 1;
      }
    }
    if (wRuns > 0) {
      const done = wOk + wFail;
      perWorkflow.push({
        id: wf.id,
        name: wf.name,
        status: wf.status,
        runs: wRuns,
        succeeded: wOk,
        failed: wFail,
        dryRuns: wDry,
        successRate: done > 0 ? (wOk / done) * 100 : null,
        avgDurationMs: wDurN > 0 ? Math.round(wDurSum / wDurN) : null,
      });
    }
  }
  perWorkflow.sort((a, b) => b.runs - a.runs);
  const done = succeeded + failed;
  return {
    totals: {
      runs,
      succeeded,
      failed,
      queued,
      dryRuns,
      successRate: done > 0 ? (succeeded / done) * 100 : null,
      avgDurationMs: durN > 0 ? Math.round(durSum / durN) : null,
    },
    runsByDay: [...buckets.values()],
    perWorkflow,
  };
}

/* ------------------------------------------------------------------ */
/* Campaigns (bulk sends)                                              */
/* ------------------------------------------------------------------ */

export interface CampaignRow {
  id: string;
  name: string;
  channel: string;
  status: string;
  recipients: number;
  sent: number;
  failed: number;
  skipped: number;
  replied: number;
  mockedSends: number;
  replyRate: number | null;
}

export async function campaignPerformance(
  workspaceId: string,
  from: Date,
  to: Date,
  campaignId?: string,
): Promise<CampaignRow[]> {
  const campaigns = await db.campaign.findMany({
    where: {
      workspaceId,
      createdAt: { gte: from, lte: to },
      ...(campaignId ? { id: campaignId } : {}),
    },
    select: { id: true, name: true, channel: true, status: true },
    orderBy: { createdAt: "desc" },
  });
  const rows: CampaignRow[] = [];
  for (const c of campaigns) {
    const groups = await db.campaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId: c.id },
      _count: { status: true },
    });
    const byStatus: Record<string, number> = {};
    for (const g of groups) byStatus[g.status] = g._count.status;
    const sent = byStatus["SENT"] ?? 0;
    const replied = await db.campaignRecipient.count({
      where: { campaignId: c.id, repliedAt: { not: null } },
    });
    const mockedSends = await db.campaignRecipient.count({
      where: { campaignId: c.id, status: "SENT", mocked: true },
    });
    rows.push({
      id: c.id,
      name: c.name,
      channel: c.channel,
      status: c.status,
      recipients: Object.values(byStatus).reduce((a, b) => a + b, 0),
      sent,
      failed: byStatus["FAILED"] ?? 0,
      skipped: byStatus["SKIPPED"] ?? 0,
      replied,
      mockedSends,
      replyRate: sent > 0 ? (replied / sent) * 100 : null,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Outbound sends (send pipeline audit trail)                          */
/* ------------------------------------------------------------------ */

export interface OutboundStats {
  /** Provider API acceptances (OutboundSend.status = SENT) — NOT delivery confirmations. */
  sent: number;
  failed: number;
  skipped: number;
  mockedSends: number;
  /** Provider-reported delivery progression (OutboundSend.deliveryStatus), WhatsApp status webhooks. */
  delivered: number;
  read: number;
  deliveryFailed: number;
  byChannel: { channel: string; sent: number; failed: number; skipped: number }[];
  failures: { id: string; contactName: string; channel: string; error: string | null; mocked: boolean; createdAt: Date }[];
}

/**
 * Batch C verified: this helper intentionally SPLITS rather than
 * excludes — `sent`/`failed`/`skipped` are the pipeline totals and
 * `mockedSends` (plus `mocked` on each failure row) states exactly how
 * many of the SENT rows were mock-adapter only. Callers must surface
 * `mockedSends` alongside `sent` (the fields stay in the returned
 * object for API responses).
 */
export async function outboundSendStats(
  workspaceId: string,
  from: Date,
  to: Date,
  channel?: string,
  integrationId?: string,
): Promise<OutboundStats> {
  const where = {
    workspaceId,
    createdAt: { gte: from, lte: to },
    ...(channel ? { channel } : {}),
    ...(integrationId ? { integrationId } : {}),
  };
  const [groups, mockedSends, failures, deliveryGroups] = await Promise.all([
    db.outboundSend.groupBy({
      by: ["status", "channel"],
      where,
      _count: { status: true },
    }),
    db.outboundSend.count({ where: { ...where, status: "SENT", mocked: true } }),
    db.outboundSend.findMany({
      where: { ...where, status: "FAILED" },
      select: {
        id: true,
        channel: true,
        error: true,
        mocked: true,
        createdAt: true,
        contact: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    db.outboundSend.groupBy({
      by: ["deliveryStatus"],
      where,
      _count: { deliveryStatus: true },
    }),
  ]);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const byChannelMap = new Map<string, { channel: string; sent: number; failed: number; skipped: number }>();
  for (const g of groups) {
    const n = g._count.status;
    if (g.status === "SENT") sent += n;
    else if (g.status === "FAILED") failed += n;
    else if (g.status === "SKIPPED") skipped += n;
    const row = byChannelMap.get(g.channel) ?? { channel: g.channel, sent: 0, failed: 0, skipped: 0 };
    if (g.status === "SENT") row.sent += n;
    else if (g.status === "FAILED") row.failed += n;
    else if (g.status === "SKIPPED") row.skipped += n;
    byChannelMap.set(g.channel, row);
  }
  // Provider-reported delivery progression — distinct from `sent` above,
  // which counts API acceptances only.
  let delivered = 0;
  let read = 0;
  let deliveryFailed = 0;
  for (const g of deliveryGroups) {
    const n = g._count.deliveryStatus;
    if (g.deliveryStatus === "delivered") delivered += n;
    else if (g.deliveryStatus === "read") read += n;
    else if (g.deliveryStatus === "failed") deliveryFailed += n;
  }
  return {
    sent,
    failed,
    skipped,
    mockedSends,
    delivered,
    read,
    deliveryFailed,
    byChannel: [...byChannelMap.values()].sort((a, b) => b.sent + b.failed + b.skipped - (a.sent + a.failed + a.skipped)),
    failures: failures.map((f) => ({
      id: f.id,
      contactName: f.contact.name,
      channel: f.channel,
      error: f.error,
      mocked: f.mocked,
      createdAt: f.createdAt,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Comment → DM                                                        */
/* ------------------------------------------------------------------ */

export interface CommentToDmAnalytics {
  comments: number;
  privateReplies: number;
  replyRate: number | null;
  avgReplyDelayMinutes: number | null;
  windowExpired: number;
  commentsByDay: { date: string; comments: number; replies: number }[];
  topMedia: { mediaId: string; mediaType: string | null; comments: number; replies: number }[];
}

export async function commentToDmAnalytics(
  workspaceId: string,
  from: Date,
  to: Date,
  integrationId?: string,
): Promise<CommentToDmAnalytics> {
  const comments = await db.comment.findMany({
    where: {
      workspaceId,
      commentedAt: { gte: from, lte: to },
      // Comment.integrationId names the account that produced the event.
      ...(integrationId ? { integrationId } : {}),
    },
    select: { commentedAt: true, privateRepliedAt: true, privateReplyEligibleUntil: true, mediaId: true, mediaType: true },
  });
  const keys = dayKeys(from, to);
  const buckets = new Map<string, { date: string; comments: number; replies: number }>(
    keys.map((k) => [k, { date: k, comments: 0, replies: 0 }]),
  );
  const mediaMap = new Map<string, { mediaId: string; mediaType: string | null; comments: number; replies: number }>();
  let privateReplies = 0;
  let delaySum = 0;
  let delayN = 0;
  const now = new Date();
  let windowExpired = 0;
  for (const c of comments) {
    const b = buckets.get(dayOf(c.commentedAt));
    if (b) b.comments += 1;
    const m = mediaMap.get(c.mediaId) ?? { mediaId: c.mediaId, mediaType: c.mediaType, comments: 0, replies: 0 };
    m.comments += 1;
    mediaMap.set(c.mediaId, m);
    if (c.privateRepliedAt) {
      privateReplies += 1;
      const rb = buckets.get(dayOf(c.privateRepliedAt));
      if (rb) rb.replies += 1;
      m.replies += 1;
      delaySum += (c.privateRepliedAt.getTime() - c.commentedAt.getTime()) / 60_000;
      delayN += 1;
    } else if (c.privateReplyEligibleUntil < now) {
      windowExpired += 1;
    }
  }
  return {
    comments: comments.length,
    privateReplies,
    replyRate: comments.length > 0 ? (privateReplies / comments.length) * 100 : null,
    avgReplyDelayMinutes: delayN > 0 ? Math.round((delaySum / delayN) * 10) / 10 : null,
    windowExpired,
    commentsByDay: [...buckets.values()],
    topMedia: [...mediaMap.values()].sort((a, b) => b.comments - a.comments).slice(0, 10),
  };
}

/* ------------------------------------------------------------------ */
/* CRM / lifecycle                                                     */
/* ------------------------------------------------------------------ */

export const LEAD_STAGES = ["NEW", "CONTACTED", "QUALIFIED", "INTERESTED", "CONVERTED", "LOST"] as const;

export interface CrmAnalytics {
  byStage: { stage: string; count: number }[];
  newContactsByDay: { date: string; count: number }[];
  total: number;
  converted: number;
  conversionRate: number | null;
  optedOut: number;
  avgLeadScore: number | null;
}

export async function crmAnalytics(
  workspaceId: string,
  from: Date,
  to: Date,
  integrationId?: string,
): Promise<CrmAnalytics> {
  // NOTE (Batch B): Contact has no account dimension, so stage totals,
  // new-contact series, and lead scores stay workspace-wide even when an
  // account is selected. Only the opted-out count — sourced from
  // CustomerEvent, which IS account-stamped — honors `integrationId`.
  const [stageGroups, total, newContacts, optedOutEvents] = await Promise.all([
    db.contact.groupBy({ by: ["leadStatus"], where: { workspaceId }, _count: { leadStatus: true } }),
    db.contact.count({ where: { workspaceId } }),
    db.contact.findMany({
      where: { workspaceId, firstSeenAt: { gte: from, lte: to } },
      select: { firstSeenAt: true, leadScore: true },
    }),
    db.customerEvent.count({
      where: {
        workspaceId,
        type: "opted_out",
        timestamp: { gte: from, lte: to },
        ...(integrationId ? { integrationId } : {}),
      },
    }),
  ]);
  const stageMap = new Map<string, number>();
  for (const g of stageGroups) stageMap.set(g.leadStatus, g._count.leadStatus);
  const byStage = LEAD_STAGES.map((s) => ({ stage: s, count: stageMap.get(s) ?? 0 }));
  const converted = stageMap.get("CONVERTED") ?? 0;
  const keys = dayKeys(from, to);
  const buckets = new Map<string, number>(keys.map((k) => [k, 0]));
  let scoreSum = 0;
  for (const c of newContacts) {
    const b = buckets.get(dayOf(c.firstSeenAt));
    if (b !== undefined) buckets.set(dayOf(c.firstSeenAt), b + 1);
    scoreSum += c.leadScore;
  }
  return {
    byStage,
    newContactsByDay: [...buckets.entries()].map(([date, count]) => ({ date, count })),
    total,
    converted,
    conversionRate: total > 0 ? (converted / total) * 100 : null,
    optedOut: optedOutEvents,
    avgLeadScore: newContacts.length > 0 ? Math.round((scoreSum / newContacts.length) * 10) / 10 : null,
  };
}

/* ------------------------------------------------------------------ */
/* Follow-ups                                                          */
/* ------------------------------------------------------------------ */

export interface FollowUpAnalytics {
  scheduled: number;
  sent: number;
  failed: number;
  cancelled: number;
  sendRate: number | null;
}

export async function followUpAnalytics(
  workspaceId: string,
  from: Date,
  to: Date,
  channel?: string,
): Promise<FollowUpAnalytics> {
  const where = {
    workspaceId,
    createdAt: { gte: from, lte: to },
    ...(channel ? { channel } : {}),
  };
  const groups = await db.followUp.groupBy({ by: ["status"], where, _count: { status: true } });
  const byStatus: Record<string, number> = {};
  for (const g of groups) byStatus[g.status] = g._count.status;
  const sent = byStatus["SENT"] ?? 0;
  const failed = byStatus["FAILED"] ?? 0;
  const cancelled = byStatus["CANCELLED"] ?? 0;
  const scheduled = byStatus["SCHEDULED"] ?? 0;
  const attempted = sent + failed;
  return {
    scheduled,
    sent,
    failed,
    cancelled,
    sendRate: attempted > 0 ? (sent / attempted) * 100 : null,
  };
}

/* ------------------------------------------------------------------ */
/* Retargeting                                                         */
/* ------------------------------------------------------------------ */

export interface RetargetingRow {
  id: string;
  name: string;
  type: string;
  status: string;
  channel: string | null;
  recipients: number;
  sent: number;
  delivered: number;
  failed: number;
  skipped: number;
  replied: number;
  replyRate: number | null;
}

export interface RetargetingAnalytics {
  campaigns: number;
  sent: number;
  delivered: number;
  failed: number;
  skipped: number;
  replied: number;
  replyRate: number | null;
  sentByDay: { date: string; sent: number; replied: number }[];
  perCampaign: RetargetingRow[];
}

export async function retargetingAnalytics(
  workspaceId: string,
  from: Date,
  to: Date,
  integrationId?: string,
): Promise<RetargetingAnalytics> {
  const campaigns = await db.retargetingCampaign.findMany({
    where: {
      workspaceId,
      createdAt: { gte: from, lte: to },
      // RetargetingCampaign.integrationId names the account it sends through.
      ...(integrationId ? { integrationId } : {}),
    },
    select: { id: true, name: true, type: true, status: true, channel: true },
    orderBy: { createdAt: "desc" },
  });
  const keys = dayKeys(from, to);
  const buckets = new Map<string, { date: string; sent: number; replied: number }>(
    keys.map((k) => [k, { date: k, sent: 0, replied: 0 }]),
  );
  let sent = 0;
  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  let replied = 0;
  const perCampaign: RetargetingRow[] = [];
  for (const c of campaigns) {
    const groups = await db.retargetingRecipient.groupBy({
      by: ["status"],
      where: { campaignId: c.id },
      _count: { status: true },
    });
    const byStatus: Record<string, number> = {};
    for (const g of groups) byStatus[g.status] = g._count.status;
    const cSent = byStatus["sent"] ?? 0;
    const cDelivered = byStatus["delivered"] ?? 0;
    const cFailed = byStatus["failed"] ?? 0;
    const cSkipped = byStatus["skipped"] ?? 0;
    const cReplied = byStatus["replied"] ?? 0;
    sent += cSent;
    delivered += cDelivered;
    failed += cFailed;
    skipped += cSkipped;
    replied += cReplied;
    // Per-day series from sentAt (measured, not estimated).
    const sentRows = await db.retargetingRecipient.findMany({
      where: { campaignId: c.id, sentAt: { gte: from, lte: to, not: null } },
      select: { sentAt: true },
    });
    for (const r of sentRows) {
      if (!r.sentAt) continue;
      const b = buckets.get(dayOf(r.sentAt));
      if (b) b.sent += 1;
    }
    const base = cSent + cDelivered; // delivered implies sent
    perCampaign.push({
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      channel: c.channel,
      recipients: Object.values(byStatus).reduce((a, b) => a + b, 0),
      sent: cSent,
      delivered: cDelivered,
      failed: cFailed,
      skipped: cSkipped,
      replied: cReplied,
      replyRate: base > 0 ? (cReplied / base) * 100 : null,
    });
  }
  const deliveredBase = sent + delivered;
  return {
    campaigns: campaigns.length,
    sent,
    delivered,
    failed,
    skipped,
    replied,
    replyRate: deliveredBase > 0 ? (replied / deliveredBase) * 100 : null,
    sentByDay: [...buckets.values()],
    perCampaign,
  };
}

/* ------------------------------------------------------------------ */
/* Channels                                                            */
/* ------------------------------------------------------------------ */

export const CHANNELS = ["instagram", "facebook", "whatsapp", "telegram", "email", "webchat", "web"] as const;

export interface ChannelRow {
  channel: string;
  /** Batch B: provider string (same as `channel` for per-channel rows). */
  provider?: string;
  /** Batch B: Integration row id for per-account rows; null for per-channel rows. */
  integrationId?: string | null;
  /** Batch B: provider-side account id for per-account rows. */
  externalAccountId?: string | null;
  integrationStatus: string | null;
  accountName: string | null;
  conversations: number;
  messagesIn: number;
  messagesOut: number;
  outboundSent: number;
  outboundFailed: number;
}

interface ChannelCounts {
  conversations: number;
  messagesIn: number;
  messagesOut: number;
  outboundSent: number;
  outboundFailed: number;
}

/**
 * Batch B channel breakdown.
 *
 * When the workspace has connected accounts (Integration rows with an
 * externalAccountId), the result carries ONE ROW PER ACCOUNT — keyed by
 * integrationId, with counts computed from account-stamped data
 * (Conversation.integrationId / OutboundSend.integrationId) — instead of
 * one row per channel string for those providers. Channels with no
 * account rows keep the legacy per-channel row. When `integrationId` is
 * given (account filter selected), only that account's row is returned.
 */
export async function channelAnalytics(
  workspaceId: string,
  from: Date,
  to: Date,
  integrationId?: string,
  includeTestData = false,
): Promise<ChannelRow[]> {
  const integrations = await db.integration.findMany({
    where: { workspaceId },
    select: { id: true, provider: true, status: true, accountName: true, externalAccountId: true },
  });

  async function countsFor(
    scope: { integrationId: string } | { channel: string },
  ): Promise<ChannelCounts> {
    const byAccount = "integrationId" in scope;
    const [conversations, msgGroups, outGroups] = await Promise.all([
      db.conversation.count({
        where: {
          workspaceId,
          createdAt: { gte: from, lte: to },
          ...(byAccount ? { integrationId: scope.integrationId } : { channel: scope.channel }),
          // Same production rule as conversationStats — see
          // nonTestConversationFilter.
          ...nonTestConversationFilter(includeTestData),
        },
      }),
      db.message.groupBy({
        by: ["direction"],
        where: {
          conversation: {
            workspaceId,
            ...(byAccount ? { integrationId: scope.integrationId } : { channel: scope.channel }),
          },
          createdAt: { gte: from, lte: to },
          internalNote: false,
          ...nonTestMessageFilter(includeTestData),
        },
        _count: { direction: true },
      }),
      db.outboundSend.groupBy({
        by: ["status"],
        where: {
          workspaceId,
          createdAt: { gte: from, lte: to },
          ...(byAccount ? { integrationId: scope.integrationId } : { channel: scope.channel }),
        },
        _count: { status: true },
      }),
    ]);
    let messagesIn = 0;
    let messagesOut = 0;
    for (const g of msgGroups) {
      if (g.direction === "INBOUND") messagesIn = g._count.direction;
      else if (g.direction === "OUTBOUND") messagesOut = g._count.direction;
    }
    let outboundSent = 0;
    let outboundFailed = 0;
    for (const g of outGroups) {
      if (g.status === "SENT") outboundSent = g._count.status;
      else if (g.status === "FAILED") outboundFailed = g._count.status;
    }
    return { conversations, messagesIn, messagesOut, outboundSent, outboundFailed };
  }

  if (integrationId) {
    const target = integrations.find((i) => i.id === integrationId) ?? null;
    if (!target) return [];
    const counts = await countsFor({ integrationId: target.id });
    return [
      {
        channel: target.provider,
        provider: target.provider,
        integrationId: target.id,
        externalAccountId: target.externalAccountId,
        integrationStatus: target.status,
        accountName: target.accountName,
        ...counts,
      },
    ];
  }

  const accounts = integrations.filter((i) => i.externalAccountId);
  const rows: ChannelRow[] = [];
  for (const acct of accounts) {
    const counts = await countsFor({ integrationId: acct.id });
    rows.push({
      channel: acct.provider,
      provider: acct.provider,
      integrationId: acct.id,
      externalAccountId: acct.externalAccountId,
      integrationStatus: acct.status,
      accountName: acct.accountName,
      ...counts,
    });
  }
  const accountedProviders = new Set(accounts.map((a) => a.provider));
  const byProvider = new Map<string, (typeof integrations)[number]>();
  for (const i of integrations) if (!byProvider.has(i.provider)) byProvider.set(i.provider, i);
  for (const ch of CHANNELS) {
    if (accountedProviders.has(ch)) continue;
    const integration = byProvider.get(ch) ?? null;
    const counts = await countsFor({ channel: ch });
    rows.push({
      channel: ch,
      provider: ch,
      integrationId: null,
      externalAccountId: null,
      integrationStatus: integration?.status ?? null,
      accountName: integration?.accountName ?? null,
      ...counts,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Comment → DM per-rule breakdown (Wave 2C — appended, existing      */
/* functions untouched)                                                */
/* ------------------------------------------------------------------ */

/**
 * Per-rule Comment-to-DM execution breakdown for a workspace + range.
 *
 * Source of truth: CommentDmEvent rows (one per matched comment per
 * rule). Definitions, stated so the UI cannot misread them:
 * - comments: distinct commentIds with an event for the rule (events are
 *   only recorded for MATCHED comments — non-matches produce no event,
 *   so this is "matched comments processed", not all comments received).
 * - matches: events with matched=true (equals comments under the current
 *   recording rule; kept separate for forward compatibility).
 * - sent / failed / dryRuns / skipped: events by status.
 * - duplicatesPrevented: "duplicate_suppressed" entries appended to the
 *   original event's actions JSON when a redelivery was suppressed.
 * - replyRate: sent / comments * 100, or null when comments is 0.
 * Tenant-isolated by workspaceId; rules are looked up for display names
 * (a rule deleted mid-range cannot occur — events cascade-delete — but
 * a missing rule degrades to its id, never an error).
 */
export interface CommentDmRuleAnalyticsRow {
  ruleId: string;
  ruleName: string | null;
  mediaId: string | null;
  comments: number;
  matches: number;
  sent: number;
  failed: number;
  dryRuns: number;
  skipped: number;
  duplicatesPrevented: number;
  replyRate: number | null;
}

export async function commentDmRuleAnalytics(
  workspaceId: string,
  from: Date,
  to: Date,
): Promise<CommentDmRuleAnalyticsRow[]> {
  const events = await db.commentDmEvent.findMany({
    where: { workspaceId, createdAt: { gte: from, lte: to } },
    select: { ruleId: true, commentId: true, matched: true, status: true, actions: true },
  });
  const ruleIds = [...new Set(events.map((e) => e.ruleId))];
  const rules = ruleIds.length > 0
    ? await db.commentDmRule.findMany({
        where: { workspaceId, id: { in: ruleIds } },
        select: { id: true, name: true, mediaId: true },
      })
    : [];
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  const byRule = new Map<string, {
    commentIds: Set<string>;
    matches: number;
    sent: number;
    failed: number;
    dryRuns: number;
    skipped: number;
    duplicatesPrevented: number;
  }>();
  for (const e of events) {
    const agg = byRule.get(e.ruleId) ?? {
      commentIds: new Set<string>(),
      matches: 0,
      sent: 0,
      failed: 0,
      dryRuns: 0,
      skipped: 0,
      duplicatesPrevented: 0,
    };
    byRule.set(e.ruleId, agg);
    agg.commentIds.add(e.commentId);
    if (e.matched) agg.matches += 1;
    if (e.status === "SENT") agg.sent += 1;
    else if (e.status === "FAILED") agg.failed += 1;
    else if (e.status === "DRY_RUN") agg.dryRuns += 1;
    else if (e.status === "SKIPPED") agg.skipped += 1;
    try {
      const actions: unknown = JSON.parse(e.actions || "[]");
      if (Array.isArray(actions)) {
        for (const a of actions) {
          if (a && typeof a === "object" && (a as { type?: unknown }).type === "duplicate_suppressed") {
            agg.duplicatesPrevented += 1;
          }
        }
      }
    } catch {
      // Malformed actions JSON contributes nothing — never fails the query.
    }
  }

  return [...byRule.entries()]
    .map(([ruleId, agg]) => {
      const rule = ruleById.get(ruleId);
      const comments = agg.commentIds.size;
      return {
        ruleId,
        ruleName: rule?.name ?? null,
        mediaId: rule?.mediaId ?? null,
        comments,
        matches: agg.matches,
        sent: agg.sent,
        failed: agg.failed,
        dryRuns: agg.dryRuns,
        skipped: agg.skipped,
        duplicatesPrevented: agg.duplicatesPrevented,
        replyRate: comments > 0 ? (agg.sent / comments) * 100 : null,
      };
    })
    .sort((a, b) => b.comments - a.comments);
}
