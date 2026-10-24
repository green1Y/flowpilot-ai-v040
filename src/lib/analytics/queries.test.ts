/**
 * Aggregation correctness for src/lib/analytics/queries.ts.
 * Seeds real rows in the test DB and asserts:
 *  - per-day bucketing is correct and zero-filled,
 *  - every helper is tenant-isolated by workspaceId,
 *  - empty ranges return zeros (not nulls/errors),
 *  - previous-period math is right (same length, non-overlapping),
 *  - query-param schema validation (Zod).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import {
  analyticsQuerySchema,
  resolveAnalyticsQuery,
  expandRangeBound,
  dayKeys,
  previousPeriod,
  deltaPct,
  eventsByDay,
  countEvents,
  conversationStats,
  messagesByDay,
  medianFirstResponseSeconds,
  workflowAnalytics,
  campaignPerformance,
  outboundSendStats,
  commentToDmAnalytics,
  crmAnalytics,
  retargetingAnalytics,
  channelAnalytics,
} from "@/lib/analytics/queries";

const suffix = `anq-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsA = "";
let wsB = "";
let contactA = "";
let contactB = "";
const created = { orgs: [] as string[], workspaces: [] as string[], users: [] as string[] };

// Fixed "now" anchor: 2026-10-19T12:00:00Z (mid-day UTC, no DST edge).
const NOW = new Date("2026-10-19T12:00:00Z");
const DAY = 86_400_000;
const from = new Date(NOW.getTime() - 7 * DAY);
const to = NOW;

beforeAll(async () => {
  const [orgA, orgB] = await Promise.all([
    db.organization.create({ data: { name: `Analytics Org A ${suffix}` } }),
    db.organization.create({ data: { name: `Analytics Org B ${suffix}` } }),
  ]);
  created.orgs.push(orgA.id, orgB.id);
  const [wA, wB] = await Promise.all([
    db.workspace.create({ data: { orgId: orgA.id, name: `WS A ${suffix}`, slug: `anq-a-${suffix}` } }),
    db.workspace.create({ data: { orgId: orgB.id, name: `WS B ${suffix}`, slug: `anq-b-${suffix}` } }),
  ]);
  created.workspaces.push(wA.id, wB.id);
  wsA = wA.id;
  wsB = wB.id;

  const [cA, cB] = await Promise.all([
    db.contact.create({
      data: { workspaceId: wsA, name: "Contact A", channel: "instagram", leadStatus: "QUALIFIED", leadScore: 80 },
    }),
    db.contact.create({
      data: { workspaceId: wsB, name: "Contact B (other tenant)", channel: "instagram", leadStatus: "CONVERTED" },
    }),
  ]);
  contactA = cA.id;
  contactB = cB.id;

  // CustomerEvents: wsA has 3 message_received (2 on day -6, 1 on day -2), wsB has 1.
  const d1 = new Date(NOW.getTime() - 6 * DAY);
  const d2 = new Date(NOW.getTime() - 2 * DAY);
  await db.customerEvent.createMany({
    data: [
      { workspaceId: wsA, contactId: contactA, type: "message_received", provider: "instagram", timestamp: d1 },
      { workspaceId: wsA, contactId: contactA, type: "message_received", provider: "instagram", timestamp: d1 },
      { workspaceId: wsA, contactId: contactA, type: "message_received", provider: "facebook", timestamp: d2 },
      { workspaceId: wsA, contactId: contactA, type: "comment_received", provider: "instagram", timestamp: d1 },
      { workspaceId: wsB, contactId: contactB, type: "message_received", provider: "instagram", timestamp: d1 },
    ],
  });

  // Conversations: wsA has 2 (1 aiHandled, 1 humanTakeover); wsB has 1.
  // createdAt is pinned to the fixed NOW anchor: without it the rows default to
  // real now, which falls outside the [from, to] window on any run after
  // 2026-10-19T12:00:00Z and breaks conversationStats/channelAnalytics.
  const convA1 = await db.conversation.create({
    data: { workspaceId: wsA, contactId: contactA, channel: "instagram", aiHandled: true, status: "RESOLVED", createdAt: d1 },
  });
  await db.conversation.create({
    data: { workspaceId: wsA, contactId: contactA, channel: "whatsapp", humanTakeover: true, status: "OPEN", createdAt: d1 },
  });
  await db.conversation.create({ data: { workspaceId: wsB, contactId: contactB, channel: "instagram", createdAt: d1 } });

  // Messages on convA1: inbound then outbound 90s later, on day -6.
  const inAt = new Date(d1.getTime() + 3_600_000);
  const outAt = new Date(inAt.getTime() + 90_000);
  await db.message.createMany({
    data: [
      { conversationId: convA1.id, direction: "INBOUND", body: "hi", createdAt: inAt },
      { conversationId: convA1.id, direction: "OUTBOUND", body: "hello", aiGenerated: true, createdAt: outAt },
      { conversationId: convA1.id, direction: "INTERNAL_NOTE", body: "note", internalNote: true, createdAt: outAt },
    ],
  });

  // Workflow: one published workflow, 2 executions (1 succeeded 5s, 1 failed).
  const wf = await db.workflow.create({
    data: { workspaceId: wsA, name: `WF ${suffix}`, status: "PUBLISHED" },
  });
  await db.workflowExecution.create({
    data: {
      workflowId: wf.id,
      status: "SUCCEEDED",
      idempotencyKey: `anq-wf-ok-${suffix}`,
      startedAt: new Date(d1.getTime() + 1000),
      finishedAt: new Date(d1.getTime() + 6000),
    },
  });
  await db.workflowExecution.create({
    data: {
      workflowId: wf.id,
      status: "FAILED",
      idempotencyKey: `anq-wf-fail-${suffix}`,
      startedAt: new Date(d2.getTime() + 1000),
      finishedAt: new Date(d2.getTime() + 2000),
      error: "boom",
    },
  });
  await db.workflow.create({ data: { workspaceId: wsB, name: `WF B ${suffix}`, status: "PUBLISHED" } });

  // Campaign: wsA, 4 recipients (2 sent w/ 1 mocked + 1 replied, 1 failed, 1 skipped).
  // createdAt pinned to the fixed anchor (same reason as conversations above).
  const campaign = await db.campaign.create({
    data: { workspaceId: wsA, name: `Camp ${suffix}`, channel: "instagram", status: "COMPLETED", createdAt: d1 },
  });
  const mk = async (n: number, status: string, extra: Record<string, unknown> = {}) => {
    const c = await db.contact.create({ data: { workspaceId: wsA, name: `Camp C ${n} ${suffix}`, channel: "instagram" } });
    await db.campaignRecipient.create({
      data: {
        campaignId: campaign.id,
        contactId: c.id,
        status,
        idempotencyKey: `anq-camp-${suffix}-${n}`,
        sentAt: status === "SENT" ? d1 : null,
        ...extra,
      },
    });
  };
  await mk(1, "SENT");
  await mk(2, "SENT", { mocked: true, repliedAt: d2 });
  await mk(3, "FAILED", { error: "no window" });
  await mk(4, "SKIPPED", { skipReason: "opted out" });

  // Comment → DM: one comment with private reply after 30 min, one untouched (expired window).
  await db.comment.create({
    data: {
      workspaceId: wsA,
      integrationId: `int-${suffix}`,
      externalId: `ext-${suffix}-1`,
      authorExternalId: "author-1",
      mediaId: `media-${suffix}`,
      mediaType: "IMAGE",
      commentedAt: d1,
      privateRepliedAt: new Date(d1.getTime() + 30 * 60_000),
      privateReplyEligibleUntil: new Date(d1.getTime() + 7 * DAY),
    },
  });
  await db.comment.create({
    data: {
      workspaceId: wsA,
      integrationId: `int-${suffix}`,
      externalId: `ext-${suffix}-2`,
      authorExternalId: "author-2",
      mediaId: `media-${suffix}`,
      commentedAt: new Date(NOW.getTime() - 10 * DAY),
      privateReplyEligibleUntil: new Date(NOW.getTime() - 3 * DAY),
    },
  });
  await db.comment.create({
    data: {
      workspaceId: wsB,
      integrationId: `int-b-${suffix}`,
      externalId: `ext-b-${suffix}-1`,
      authorExternalId: "author-b",
      mediaId: "media-b",
      commentedAt: d1,
      privateReplyEligibleUntil: new Date(d1.getTime() + 7 * DAY),
    },
  });

  // Outbound sends: 1 SENT (mocked), 1 FAILED with error.
  await db.outboundSend.create({
    data: {
      workspaceId: wsA,
      contactId: contactA,
      channel: "instagram",
      messageType: "freeform",
      body: "hello",
      idempotencyKey: `anq-out-ok-${suffix}`,
      status: "SENT",
      mocked: true,
      createdAt: d1,
    },
  });
  await db.outboundSend.create({
    data: {
      workspaceId: wsA,
      contactId: contactA,
      channel: "whatsapp",
      messageType: "template",
      body: "hi",
      idempotencyKey: `anq-out-fail-${suffix}`,
      status: "FAILED",
      error: "provider 500",
      createdAt: d2,
    },
  });

  // FollowUp: one SENT. createdAt pinned to the fixed anchor (same reason).
  await db.followUp.create({
    data: {
      workspaceId: wsA,
      contactId: contactA,
      channel: "instagram",
      messageType: "freeform",
      body: "ping",
      scheduledAt: d1,
      status: "SENT",
      sentAt: d1,
      createdAt: d1,
      idempotencyKey: `anq-fu-${suffix}`,
    },
  });

  // Retargeting: 1 campaign, 3 recipients (sent, delivered, replied).
  // Campaign createdAt pinned to the fixed anchor (same reason).
  const rt = await db.retargetingCampaign.create({
    data: { workspaceId: wsA, name: `RT ${suffix}`, type: "dm_reengagement", status: "completed", channel: "instagram", createdAt: d1 },
  });
  const mkRt = async (n: number, status: string, sentAt: Date | null) => {
    const c = await db.contact.create({ data: { workspaceId: wsA, name: `RT C ${n} ${suffix}`, channel: "instagram" } });
    await db.retargetingRecipient.create({
      data: { campaignId: rt.id, contactId: c.id, status, idempotencyKey: `anq-rt-${suffix}-${n}`, sentAt },
    });
  };
  await mkRt(1, "sent", d1);
  await mkRt(2, "delivered", d1);
  await mkRt(3, "replied", d1);
});

afterAll(async () => {
  // Cascade from workspace covers contacts/conversations/campaigns/etc.
  await db.customerEvent.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.outboundSend.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.followUp.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.comment.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.retargetingRecipient.deleteMany({ where: { campaign: { workspaceId: { in: [wsA, wsB] } } } });
  await db.retargetingCampaign.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.campaignRecipient.deleteMany({ where: { campaign: { workspaceId: { in: [wsA, wsB] } } } });
  await db.campaign.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.workflowExecution.deleteMany({ where: { workflow: { workspaceId: { in: [wsA, wsB] } } } });
  await db.workflow.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await db.workspace.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await db.organization.deleteMany({ where: { id: { in: created.orgs } } });
});

describe("range utilities", () => {
  it("dayKeys zero-fills every calendar day in the range", () => {
    const keys = dayKeys(from, to);
    expect(keys.length).toBe(8); // 7d range + today bucket
    expect(keys[0]).toBe(from.toISOString().slice(0, 10));
    expect(keys[keys.length - 1]).toBe("2026-10-19");
  });

  it("previousPeriod is same-length and non-overlapping", () => {
    const prev = previousPeriod(from, to);
    expect(prev.to.getTime()).toBe(from.getTime());
    expect(prev.to.getTime() - prev.from.getTime()).toBe(to.getTime() - from.getTime());
    expect(prev.from.getTime()).toBeLessThan(prev.to.getTime());
  });

  it("deltaPct returns null without a baseline", () => {
    expect(deltaPct(10, 0)).toBeNull();
    expect(deltaPct(0, 0)).toBeNull();
    expect(deltaPct(15, 10)).toBeCloseTo(50, 5);
    expect(deltaPct(5, 10)).toBeCloseTo(-50, 5);
  });
});

describe("analyticsQuerySchema", () => {
  it("accepts presets and resolves concrete bounds", () => {
    const q = analyticsQuerySchema.parse({ range: "7d" });
    const r = resolveAnalyticsQuery(q);
    expect(r.to.getTime() - r.from.getTime()).toBe(7 * DAY);
    expect(r.compare).toBe(true);
  });

  it("rejects custom without from/to and with to <= from", () => {
    expect(() => analyticsQuerySchema.parse({ range: "custom" })).toThrow();
    expect(() =>
      analyticsQuerySchema.parse({ range: "custom", from: "2026-10-19", to: "2026-10-10" }),
    ).toThrow();
    expect(() =>
      analyticsQuerySchema.parse({ range: "custom", from: "2026-10-01", to: "2026-10-19" }),
    ).not.toThrow();
  });

  it("date-only custom bounds cover whole days (to includes the full end day)", () => {
    const q = analyticsQuerySchema.parse({
      range: "custom",
      from: "2026-10-01",
      to: "2026-10-20",
    });
    const r = resolveAnalyticsQuery(q);
    expect(r.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-20T23:59:59.999Z");
  });

  it("a single-day custom range is valid and spans that whole day", () => {
    expect(() =>
      analyticsQuerySchema.parse({ range: "custom", from: "2026-10-20", to: "2026-10-20" }),
    ).not.toThrow();
    const r = resolveAnalyticsQuery(
      analyticsQuerySchema.parse({ range: "custom", from: "2026-10-20", to: "2026-10-20" }),
    );
    expect(r.to.getTime()).toBeGreaterThan(r.from.getTime());
    expect(r.from.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-20T23:59:59.999Z");
  });

  it("full ISO datetimes are respected as-is", () => {
    const r = resolveAnalyticsQuery(
      analyticsQuerySchema.parse({
        range: "custom",
        from: "2026-10-01T08:00:00Z",
        to: "2026-10-02T09:30:00Z",
      }),
    );
    expect(r.from.toISOString()).toBe("2026-10-01T08:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-02T09:30:00.000Z");
  });

  it("'all' channel is a UI-only value that maps to no filter", () => {
    const r = resolveAnalyticsQuery(
      analyticsQuerySchema.parse({ range: "7d", channel: "all" }),
    );
    expect(r.channel).toBeUndefined();
    const r2 = resolveAnalyticsQuery(
      analyticsQuerySchema.parse({ range: "7d", channel: "instagram" }),
    );
    expect(r2.channel).toBe("instagram");
  });

  it("includeTestData defaults to production-only; '1'/'true' opt in", () => {
    expect(resolveAnalyticsQuery(analyticsQuerySchema.parse({ range: "7d" })).includeTestData).toBe(false);
    expect(
      resolveAnalyticsQuery(analyticsQuerySchema.parse({ range: "7d", includeTestData: "1" })).includeTestData,
    ).toBe(true);
    expect(
      resolveAnalyticsQuery(analyticsQuerySchema.parse({ range: "7d", includeTestData: "true" })).includeTestData,
    ).toBe(true);
    expect(
      resolveAnalyticsQuery(analyticsQuerySchema.parse({ range: "7d", includeTestData: "0" })).includeTestData,
    ).toBe(false);
    expect(
      resolveAnalyticsQuery(analyticsQuerySchema.parse({ range: "7d", includeTestData: "false" })).includeTestData,
    ).toBe(false);
  });

  it("expandRangeBound expands date-only strings and passes datetimes through", () => {
    expect(expandRangeBound("2026-10-20", false).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(expandRangeBound("2026-10-20", true).toISOString()).toBe("2026-10-20T23:59:59.999Z");
    expect(expandRangeBound("2026-10-20T12:34:56Z", true).toISOString()).toBe(
      "2026-10-20T12:34:56.000Z",
    );
  });
});

describe("events", () => {
  it("eventsByDay buckets correctly, zero-fills, and is tenant-scoped", async () => {
    const rows = await eventsByDay(wsA, ["message_received", "comment_received"], from, to);
    expect(rows.length).toBe(8);
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const k1 = new Date(NOW.getTime() - 6 * DAY).toISOString().slice(0, 10);
    const k2 = new Date(NOW.getTime() - 2 * DAY).toISOString().slice(0, 10);
    expect(byDate.get(k1)?.counts["message_received"]).toBe(2); // not 3: wsB's row excluded
    expect(byDate.get(k1)?.counts["comment_received"]).toBe(1);
    expect(byDate.get(k2)?.counts["message_received"]).toBe(1);
    expect(byDate.get("2026-10-19")?.counts["message_received"]).toBe(0); // zero-filled
    expect(byDate.get(k1)?.total).toBe(3);
  });

  it("countEvents totals by type and excludes other tenants", async () => {
    const c = await countEvents(wsA, ["message_received", "comment_received"], from, to);
    expect(c["message_received"]).toBe(3);
    expect(c["comment_received"]).toBe(1);
    const other = await countEvents(wsB, ["message_received"], from, to);
    expect(other["message_received"]).toBe(1);
  });

  it("returns zeros for an empty range", async () => {
    const emptyFrom = new Date(NOW.getTime() - 400 * DAY);
    const emptyTo = new Date(NOW.getTime() - 390 * DAY);
    const rows = await eventsByDay(wsA, ["message_received"], emptyFrom, emptyTo);
    expect(rows.every((r) => r.total === 0)).toBe(true);
    const c = await countEvents(wsA, ["message_received"], emptyFrom, emptyTo);
    expect(c["message_received"]).toBe(0);
  });
});

describe("conversations & messages", () => {
  it("conversationStats is tenant-scoped with channel/status breakdowns", async () => {
    const s = await conversationStats(wsA, from, to);
    expect(s.total).toBe(2);
    expect(s.aiHandled).toBe(1);
    expect(s.humanTakeover).toBe(1);
    expect(s.byChannel.find((c) => c.channel === "instagram")?.count).toBe(1);
    expect(s.byStatus["RESOLVED"]).toBe(1);
    const other = await conversationStats(wsB, from, to);
    expect(other.total).toBe(1);
    expect(other.aiHandled).toBe(0);
  });

  it("messagesByDay excludes internal notes and buckets by direction", async () => {
    const rows = await messagesByDay(wsA, from, to);
    const total = rows.reduce((a, r) => a + r.inbound + r.outbound, 0);
    expect(total).toBe(2); // internal note excluded
    const k1 = new Date(NOW.getTime() - 6 * DAY).toISOString().slice(0, 10);
    const day = rows.find((r) => r.date === k1)!;
    expect(day.inbound).toBe(1);
    expect(day.outbound).toBe(1);
  });

  it("medianFirstResponseSeconds measures the real gap (90s)", async () => {
    const med = await medianFirstResponseSeconds(wsA, from, to);
    expect(med).toBeCloseTo(90, 1);
    expect(await medianFirstResponseSeconds(wsB, from, to)).toBeNull();
  });
});

describe("workflows", () => {
  it("aggregates success rate, durations, and per-day runs", async () => {
    const w = await workflowAnalytics(wsA, from, to);
    expect(w.totals.runs).toBe(2);
    expect(w.totals.succeeded).toBe(1);
    expect(w.totals.failed).toBe(1);
    expect(w.totals.successRate).toBeCloseTo(50, 5);
    expect(w.totals.avgDurationMs).toBeCloseTo(3000, 0);
    expect(w.perWorkflow.length).toBe(1);
    expect(w.perWorkflow[0].avgDurationMs).toBeCloseTo(3000, 0);
    const dayRuns = w.runsByDay.reduce((a, r) => a + r.runs, 0);
    expect(dayRuns).toBe(2);
    const other = await workflowAnalytics(wsB, from, to);
    expect(other.totals.runs).toBe(0);
    expect(other.totals.successRate).toBeNull();
  });
});

describe("campaigns", () => {
  it("campaignPerformance counts statuses, mocked sends, and reply rate", async () => {
    const rows = await campaignPerformance(wsA, from, to);
    expect(rows.length).toBe(1);
    const c = rows[0];
    expect(c.recipients).toBe(4);
    expect(c.sent).toBe(2);
    expect(c.failed).toBe(1);
    expect(c.skipped).toBe(1);
    expect(c.mockedSends).toBe(1);
    expect(c.replied).toBe(1);
    expect(c.replyRate).toBeCloseTo(50, 5);
    expect(await campaignPerformance(wsB, from, to)).toEqual([]);
  });
});

describe("outbound sends", () => {
  it("aggregates statuses and surfaces failure rows", async () => {
    const s = await outboundSendStats(wsA, from, to);
    expect(s.sent).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.skipped).toBe(0);
    expect(s.mockedSends).toBe(1);
    expect(s.failures.length).toBe(1);
    expect(s.failures[0].error).toBe("provider 500");
    expect(s.failures[0].channel).toBe("whatsapp");
    expect(s.byChannel.find((c) => c.channel === "instagram")?.sent).toBe(1);
    const other = await outboundSendStats(wsB, from, to);
    expect(other.sent + other.failed + other.skipped).toBe(0);
  });
});

describe("comment → DM", () => {
  it("computes reply rate, delay, expired windows, and media ranking", async () => {
    const a = await commentToDmAnalytics(wsA, from, to);
    // Only 1 comment has commentedAt inside [from, to]; the other is older.
    expect(a.comments).toBe(1);
    expect(a.privateReplies).toBe(1);
    expect(a.replyRate).toBeCloseTo(100, 5);
    expect(a.avgReplyDelayMinutes).toBeCloseTo(30, 1);
    expect(a.topMedia.length).toBe(1);
    expect(a.topMedia[0].comments).toBe(1);
    const wider = await commentToDmAnalytics(
      wsA,
      new Date(NOW.getTime() - 30 * DAY),
      NOW,
    );
    expect(wider.comments).toBe(2);
    expect(wider.windowExpired).toBe(1);
    const other = await commentToDmAnalytics(wsB, from, to);
    expect(other.comments).toBe(1);
    expect(other.privateReplies).toBe(0);
    expect(other.replyRate).toBe(0);
  });
});

describe("CRM", () => {
  it("snapshot is by current stage; conversion rate uses real rows", async () => {
    const c = await crmAnalytics(wsA, from, to);
    expect(c.byStage.find((s) => s.stage === "QUALIFIED")?.count).toBeGreaterThanOrEqual(1);
    expect(c.total).toBeGreaterThanOrEqual(1);
    const other = await crmAnalytics(wsB, from, to);
    expect(other.byStage.find((s) => s.stage === "CONVERTED")?.count).toBe(1);
    expect(other.conversionRate).toBeCloseTo(100, 5);
  });
});

describe("retargeting", () => {
  it("aggregates recipient statuses and reply rate", async () => {
    const r = await retargetingAnalytics(wsA, from, to);
    expect(r.campaigns).toBe(1);
    expect(r.sent).toBe(1);
    expect(r.delivered).toBe(1);
    expect(r.replied).toBe(1);
    expect(r.replyRate).toBeCloseTo(50, 5); // 1 replied / (1 sent + 1 delivered)
    expect(r.perCampaign.length).toBe(1);
    expect(r.sentByDay.reduce((a, d) => a + d.sent, 0)).toBe(3); // all 3 recipients have sentAt
    expect(await retargetingAnalytics(wsB, from, to)).toMatchObject({ campaigns: 0, sent: 0 });
  });
});

describe("test-activity exclusion (Batch C)", () => {
  // Dedicated workspace seeded with an exact mix of live and test rows:
  //  - convLive:   live inbound, live outbound (+120s)
  //  - convMixed:  live inbound, MOCKED outbound (+60s)
  //  - convMocked: mocked inbound, mocked outbound (+30s) — mocked-only
  //  - convEmpty:  no messages at all (a real container; counts in both views)
  // Workflow executions: 1 live SUCCEEDED (4s), 1 live FAILED (2s),
  // 1 live QUEUED, 1 DRY_RUN status (10s), 1 SUCCEEDED with dryRun=true (10s).
  let wsC = "";
  let orgC = "";
  const d1 = new Date(NOW.getTime() - 6 * DAY);

  beforeAll(async () => {
    const org = await db.organization.create({ data: { name: `Analytics Org C ${suffix}` } });
    orgC = org.id;
    const w = await db.workspace.create({
      data: { orgId: org.id, name: `WS C ${suffix}`, slug: `anq-c-${suffix}` },
    });
    wsC = w.id;
    const contact = await db.contact.create({
      data: { workspaceId: wsC, name: "Contact C", channel: "instagram" },
    });
    const mkConvo = () =>
      db.conversation.create({
        data: { workspaceId: wsC, contactId: contact.id, channel: "instagram", status: "OPEN", createdAt: d1 },
      });
    const convLive = await mkConvo();
    const convMixed = await mkConvo();
    const convMocked = await mkConvo();
    await mkConvo(); // convEmpty
    const msg = (conversationId: string, direction: string, mocked: boolean, at: Date) => ({
      conversationId,
      direction,
      body: "x",
      mocked,
      createdAt: at,
    });
    await db.message.createMany({
      data: [
        msg(convLive.id, "INBOUND", false, new Date(d1.getTime() + 3_600_000)),
        msg(convLive.id, "OUTBOUND", false, new Date(d1.getTime() + 3_600_000 + 120_000)),
        msg(convMixed.id, "INBOUND", false, new Date(d1.getTime() + 7_200_000)),
        msg(convMixed.id, "OUTBOUND", true, new Date(d1.getTime() + 7_200_000 + 60_000)),
        msg(convMocked.id, "INBOUND", true, new Date(d1.getTime() + 10_800_000)),
        msg(convMocked.id, "OUTBOUND", true, new Date(d1.getTime() + 10_800_000 + 30_000)),
      ],
    });

    const wf = await db.workflow.create({
      data: { workspaceId: wsC, name: `WF C ${suffix}`, status: "PUBLISHED" },
    });
    const exec = (n: number, status: string, dryRun: boolean, durMs: number | null) => ({
      workflowId: wf.id,
      status,
      dryRun,
      idempotencyKey: `anq-c-wf-${suffix}-${n}`,
      startedAt: new Date(d1.getTime() + n * 1000),
      finishedAt: durMs == null ? null : new Date(d1.getTime() + n * 1000 + durMs),
    });
    await db.workflowExecution.createMany({
      data: [
        exec(1, "SUCCEEDED", false, 4000),
        exec(2, "FAILED", false, 2000),
        exec(3, "QUEUED", false, null),
        exec(4, "DRY_RUN", true, 10_000),
        exec(5, "SUCCEEDED", true, 10_000),
      ],
    });
  });

  afterAll(async () => {
    await db.workflowExecution.deleteMany({ where: { workflow: { workspaceId: wsC } } });
    await db.workflow.deleteMany({ where: { workspaceId: wsC } });
    await db.workspace.deleteMany({ where: { id: wsC } });
    await db.organization.deleteMany({ where: { id: orgC } });
  });

  it("messagesByDay excludes mocked messages by default, includes them on opt-in", async () => {
    const prod = await messagesByDay(wsC, from, to);
    expect(prod.reduce((a, r) => a + r.inbound, 0)).toBe(2); // live + mixed inbound
    expect(prod.reduce((a, r) => a + r.outbound, 0)).toBe(1); // live outbound only
    const incl = await messagesByDay(wsC, from, to, undefined, undefined, true);
    expect(incl.reduce((a, r) => a + r.inbound, 0)).toBe(3);
    expect(incl.reduce((a, r) => a + r.outbound, 0)).toBe(3);
  });

  it("conversationStats excludes mocked-only conversations by default (empty conversations still count)", async () => {
    const prod = await conversationStats(wsC, from, to);
    expect(prod.total).toBe(3); // live + mixed + empty; mocked-only excluded
    const incl = await conversationStats(wsC, from, to, undefined, undefined, true);
    expect(incl.total).toBe(4);
  });

  it("medianFirstResponseSeconds is computed from non-mocked messages only by default", async () => {
    // Production: only convLive has a non-mocked in→out pair (120s).
    expect(await medianFirstResponseSeconds(wsC, from, to)).toBeCloseTo(120, 1);
    // Opt-in: gaps are 120s (live), 60s (mixed), 30s (mocked) → median 60s.
    expect(await medianFirstResponseSeconds(wsC, from, to, undefined, undefined, true)).toBeCloseTo(60, 1);
  });

  it("workflowAnalytics excludes DRY_RUN executions from headline metrics and reports dryRuns separately", async () => {
    const prod = await workflowAnalytics(wsC, from, to);
    expect(prod.totals.runs).toBe(3); // SUCCEEDED + FAILED + QUEUED (live only)
    expect(prod.totals.succeeded).toBe(1);
    expect(prod.totals.failed).toBe(1);
    expect(prod.totals.queued).toBe(1);
    expect(prod.totals.dryRuns).toBe(2); // DRY_RUN status + dryRun=true
    expect(prod.totals.successRate).toBeCloseTo(50, 5);
    expect(prod.totals.avgDurationMs).toBe(3000); // (4000+2000)/2 — dry 10s runs excluded
    expect(prod.runsByDay.reduce((a, r) => a + r.runs, 0)).toBe(3);
    expect(prod.perWorkflow).toHaveLength(1);
    expect(prod.perWorkflow[0].runs).toBe(3);
    expect(prod.perWorkflow[0].dryRuns).toBe(2);

    const incl = await workflowAnalytics(wsC, from, to, undefined, true);
    expect(incl.totals.runs).toBe(5);
    expect(incl.totals.succeeded).toBe(2);
    expect(incl.totals.failed).toBe(1);
    expect(incl.totals.dryRuns).toBe(2); // still reported separately
    expect(incl.totals.successRate).toBeCloseTo((2 / 3) * 100, 5);
    expect(incl.totals.avgDurationMs).toBe(6500); // (4000+2000+10000+10000)/4
  });

  it("channelAnalytics applies the same exclusion to per-channel counts", async () => {
    const prod = await channelAnalytics(wsC, from, to);
    const igProd = prod.find((r) => r.channel === "instagram")!;
    expect(igProd.conversations).toBe(3);
    expect(igProd.messagesIn).toBe(2);
    expect(igProd.messagesOut).toBe(1);
    const incl = await channelAnalytics(wsC, from, to, undefined, true);
    const igIncl = incl.find((r) => r.channel === "instagram")!;
    expect(igIncl.conversations).toBe(4);
    expect(igIncl.messagesIn).toBe(3);
    expect(igIncl.messagesOut).toBe(3);
  });

  it("outboundSendStats keeps its mocked split (verified, unchanged)", async () => {
    // wsA seeds: 1 SENT outbound send with mocked=true.
    const s = await outboundSendStats(wsA, from, to);
    expect(s.sent).toBe(1);
    expect(s.mockedSends).toBe(1);
  });
});

describe("channels", () => {
  it("returns one row per known channel with tenant-scoped numbers", async () => {
    const rows = await channelAnalytics(wsA, from, to);
    expect(rows.length).toBe(7);
    const ig = rows.find((r) => r.channel === "instagram")!;
    expect(ig.conversations).toBe(1);
    expect(ig.messagesIn).toBe(1);
    expect(ig.outboundSent).toBe(1);
    expect(ig.outboundFailed).toBe(0);
    const wa = rows.find((r) => r.channel === "whatsapp")!;
    expect(wa.outboundFailed).toBe(1);
    const tg = rows.find((r) => r.channel === "telegram")!;
    expect(tg.conversations).toBe(0); // honest zeros
  });
});
