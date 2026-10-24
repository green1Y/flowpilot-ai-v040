import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { analyticsDetailQuerySchema } from "@/lib/validation-stage4a";
import { integrationInWorkspace } from "@/lib/analytics/queries";

const DAY_MS = 86_400_000;

function resolveRange(fromRaw: string | undefined, toRaw: string | undefined): { from: Date; to: Date } {
  const now = new Date();
  const to = toRaw ? new Date(toRaw) : now;
  const from = fromRaw ? new Date(fromRaw) : new Date(now.getTime() - 30 * DAY_MS);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) {
    throw err("Invalid from/to — provide ISO dates", 422);
  }
  if (from > to) throw err("Invalid range: from must be before to", 422);
  return { from, to };
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/analytics/detail?from&to&channel&campaignId&stage&integrationId
 *
 * Deep, honest analytics — all tenant-scoped and date-filtered:
 * - messagesIn/messagesOut per calendar day (INTERNAL_NOTE excluded)
 * - avgFirstResponseSeconds: first OUTBOUND after first INBOUND per
 *   conversation; null when no conversation has both
 * - automationRuns: workflow executions with success rate (null when none)
 * - campaignPerformance: per-campaign sent/failed/skipped/replied from
 *   CampaignRecipient
 * - failedSends: OutboundSend rows with status FAILED
 * - leadsByStage: contact counts grouped by leadStatus
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const sp = new URL(req.url).searchParams;
  const q = analyticsDetailQuerySchema.safeParse({
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    channel: sp.get("channel") ?? undefined,
    campaignId: sp.get("campaignId") ?? undefined,
    stage: sp.get("stage") ?? undefined,
  });
  if (!q.success) throw err("Invalid query parameters", 422);
  // Batch C: opt-in inclusion of test activity (?includeTestData=1|true).
  // Parsed here because this route uses its own detail schema; the
  // production default (absent/false) excludes mocked messages and
  // DRY_RUN executions from the headline numbers below.
  const includeTestDataRaw = sp.get("includeTestData");
  const includeTestData = includeTestDataRaw === "1" || includeTestDataRaw === "true";
  const { from, to } = resolveRange(q.data.from, q.data.to);
  const channelFilter = q.data.channel || undefined;
  const campaignIdFilter = q.data.campaignId || undefined;
  const stageFilter = q.data.stage || undefined;
  // Batch B account filter (parsed like the other params, validated
  // against this workspace — a foreign id must never yield data).
  const integrationIdFilter = sp.get("integrationId") || undefined;
  if (
    integrationIdFilter &&
    !(await integrationInWorkspace(ctx.workspaceId, integrationIdFilter))
  ) {
    throw err("Integration not found in this workspace", 403);
  }

  /* ----------------------------- messages ----------------------------- */
  const messages = await db.message.findMany({
    where: {
      createdAt: { gte: from, lte: to },
      // Production default: mocked messages are not production activity.
      ...(includeTestData ? {} : { mocked: false }),
      conversation: {
        workspaceId: ctx.workspaceId,
        ...(channelFilter ? { channel: channelFilter } : {}),
        ...(integrationIdFilter ? { integrationId: integrationIdFilter } : {}),
      },
    },
    select: { conversationId: true, direction: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  let internalNotesExcluded = 0;
  const perDay = new Map<string, { date: string; messagesIn: number; messagesOut: number }>();
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const endDay = new Date(to);
  endDay.setHours(0, 0, 0, 0);
  for (let d = new Date(cursor), guard = 0; d <= endDay && guard < 400; d = new Date(d.getTime() + DAY_MS), guard++) {
    const key = dayKey(d);
    if (!perDay.has(key)) perDay.set(key, { date: key, messagesIn: 0, messagesOut: 0 });
  }
  const firstByConvo = new Map<string, { inbound?: Date; outbound?: Date }>();
  for (const m of messages) {
    if (m.direction === "INTERNAL_NOTE") {
      internalNotesExcluded++;
      continue;
    }
    const bucket = perDay.get(dayKey(m.createdAt));
    if (m.direction === "INBOUND") {
      if (bucket) bucket.messagesIn++;
    } else if (m.direction === "OUTBOUND") {
      if (bucket) bucket.messagesOut++;
    }
    let entry = firstByConvo.get(m.conversationId);
    if (!entry) {
      entry = {};
      firstByConvo.set(m.conversationId, entry);
    }
    if (m.direction === "INBOUND" && !entry.inbound) entry.inbound = m.createdAt;
    else if (m.direction === "OUTBOUND" && !entry.outbound) entry.outbound = m.createdAt;
  }

  // First outbound AFTER first inbound, per conversation.
  const responseSecs: number[] = [];
  for (const { inbound, outbound } of firstByConvo.values()) {
    if (inbound && outbound && outbound.getTime() >= inbound.getTime()) {
      responseSecs.push((outbound.getTime() - inbound.getTime()) / 1000);
    }
  }
  const avgFirstResponseSeconds =
    responseSecs.length > 0
      ? responseSecs.reduce((a, b) => a + b, 0) / responseSecs.length
      : null;

  /* --------------------------- automation runs ------------------------- */
  const executions = await db.workflowExecution.findMany({
    where: {
      workflow: { workspaceId: ctx.workspaceId },
      startedAt: { gte: from, lte: to },
      ...(integrationIdFilter ? { integrationId: integrationIdFilter } : {}),
    },
    select: { status: true, dryRun: true },
  });
  // Dry runs (status DRY_RUN and/or dryRun=true) are tallied separately
  // and never counted as succeeded. In the production view they are
  // excluded from total/succeeded/failed/queued/successRate; with
  // includeTestData they join `total` (still never as successes).
  const isDry = (e: { status: string; dryRun: boolean }) => e.status === "DRY_RUN" || e.dryRun === true;
  const dryRuns = executions.filter(isDry).length;
  const counted = includeTestData ? executions : executions.filter((e) => !isDry(e));
  const succeeded = counted.filter((e) => e.status === "SUCCEEDED").length;
  const failed = counted.filter((e) => e.status === "FAILED" || e.status === "DEAD_LETTER").length;
  const automationRuns = {
    total: counted.length,
    succeeded,
    failed,
    queued: counted.length - succeeded - failed,
    dryRuns,
    successRate: counted.length > 0 ? succeeded / counted.length : null,
  };

  /* ------------------------- campaign performance ---------------------- */
  const campaigns = await db.campaign.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(channelFilter ? { channel: channelFilter } : {}),
      ...(campaignIdFilter ? { id: campaignIdFilter } : { createdAt: { gte: from, lte: to } }),
    },
    include: { recipients: { select: { status: true, repliedAt: true, mocked: true } } },
  });
  const campaignPerformance = campaigns.map((c) => {
    const sent = c.recipients.filter((r) => r.status === "SENT").length;
    const failedCount = c.recipients.filter((r) => r.status === "FAILED").length;
    const skipped = c.recipients.filter((r) => r.status === "SKIPPED").length;
    const replied = c.recipients.filter((r) => r.repliedAt != null).length;
    const mockedSends = c.recipients.filter((r) => r.status === "SENT" && r.mocked).length;
    return {
      id: c.id,
      name: c.name,
      channel: c.channel,
      status: c.status,
      recipients: c.recipients.length,
      sent,
      failed: failedCount,
      skipped,
      replied,
      // Honest mock separation: how many "sends" were mock-adapter only.
      mockedSends,
    };
  });

  /* ------------------------------ failed sends ------------------------- */
  const failedSends = await db.outboundSend.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      status: "FAILED",
      createdAt: { gte: from, lte: to },
      ...(channelFilter ? { channel: channelFilter } : {}),
      ...(campaignIdFilter ? { campaignId: campaignIdFilter } : {}),
      ...(integrationIdFilter ? { integrationId: integrationIdFilter } : {}),
    },
    include: { contact: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  /* ------------------------------ leads by stage ----------------------- */
  const leads = await db.contact.groupBy({
    by: ["leadStatus"],
    where: {
      workspaceId: ctx.workspaceId,
      firstSeenAt: { gte: from, lte: to },
      ...(channelFilter ? { channel: channelFilter } : {}),
      ...(stageFilter ? { leadStatus: stageFilter } : {}),
    },
    _count: { _all: true },
  });
  const leadsByStage = leads
    .map((l) => ({ stage: l.leadStatus, count: l._count._all }))
    .sort((a, b) => b.count - a.count);

  return ok({
    demo: process.env.DEMO_MODE === "true",
    testDataIncluded: includeTestData,
    from: from.toISOString(),
    to: to.toISOString(),
    messagesPerDay: [...perDay.values()],
    internalNotesExcluded,
    avgFirstResponseSeconds,
    automationRuns,
    campaignPerformance,
    failedSends: failedSends.map((s) => ({
      id: s.id,
      contactName: s.contact.name,
      channel: s.channel,
      messageType: s.messageType,
      error: s.error,
      mocked: s.mocked,
      createdAt: s.createdAt,
    })),
    leadsByStage,
  });
});
