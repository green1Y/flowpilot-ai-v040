/**
 * Stage 4b — analytics detail + CSV export tests: response-time math,
 * campaign aggregates, failed sends, leads by stage, CSV shape, and tenant
 * isolation on both new routes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET as detailGET } from "./detail/route";
import { GET as exportGET } from "./export/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  });
}

function req(url: string, workspaceId: string): NextRequest {
  return new NextRequest(url, { headers: { "x-workspace-id": workspaceId } });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

const suffix = `s4b${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userAId = "";
let userBId = "";
let wsA = "";
let wsB = "";
const orgNames: string[] = [];

const t0 = new Date(Date.now() - 2 * 86_400_000); // two days ago (in range)

async function makeOrgWorkspace(tag: string) {
  const name = `S4B Org ${tag} ${suffix}`;
  orgNames.push(name);
  const org = await db.organization.create({ data: { name } });
  return db.workspace.create({
    data: { orgId: org.id, name: `S4B WS ${tag} ${suffix}`, slug: `s4b-${tag}-${suffix}` },
  });
}

beforeAll(async () => {
  const a = await db.user.create({ data: { email: `s4b-a-${suffix}@example.com`, name: "S4B A", passwordHash: "x" } });
  const b = await db.user.create({ data: { email: `s4b-b-${suffix}@example.com`, name: "S4B B", passwordHash: "x" } });
  userAId = a.id;
  userBId = b.id;
  wsA = (await makeOrgWorkspace("a")).id;
  wsB = (await makeOrgWorkspace("b")).id;
  await db.membership.create({ data: { userId: userAId, workspaceId: wsA, role: "OWNER" } });
  await db.membership.create({ data: { userId: userBId, workspaceId: wsB, role: "OWNER" } });

  // --- Workspace A: deterministic activity ---
  const contact = await db.contact.create({
    data: { workspaceId: wsA, name: `S4B Lead ${suffix}`, channel: "webchat", leadStatus: "QUALIFIED" },
  });
  const convo = await db.conversation.create({
    data: { workspaceId: wsA, contactId: contact.id, channel: "webchat" },
  });
  const inboundAt = new Date(t0.getTime() + 60_000);
  const outboundAt = new Date(inboundAt.getTime() + 300_000); // 300s response
  await db.message.createMany({
    data: [
      { conversationId: convo.id, direction: "INBOUND", body: "pricing please", createdAt: inboundAt },
      { conversationId: convo.id, direction: "OUTBOUND", body: "Here it is", mocked: true, createdAt: outboundAt },
      { conversationId: convo.id, direction: "INTERNAL_NOTE", body: "internal context", createdAt: outboundAt, internalNote: true },
    ],
  });
  // A second conversation with only an inbound (no response — excluded from avg).
  const convo2 = await db.conversation.create({
    data: { workspaceId: wsA, contactId: contact.id, channel: "webchat" },
  });
  await db.message.create({
    data: { conversationId: convo2.id, direction: "INBOUND", body: "hello?", createdAt: new Date(t0.getTime() + 86_400_000) },
  });

  // Campaign with mixed recipient outcomes.
  const campaign = await db.campaign.create({
    data: { workspaceId: wsA, name: `S4B Campaign ${suffix}`, channel: "whatsapp", status: "COMPLETED" },
  });
  const mkRecipient = (n: string, status: string, mocked: boolean | null, replied: boolean) =>
    db.contact
      .create({ data: { workspaceId: wsA, name: `S4B Recipient ${suffix} ${n}`, channel: "whatsapp", leadStatus: "CONTACTED" } })
      .then((c) =>
        db.campaignRecipient.create({
          data: {
            campaignId: campaign.id,
            contactId: c.id,
            status,
            mocked,
            repliedAt: replied ? new Date() : null,
            idempotencyKey: `s4b-${suffix}-${n}`,
          },
        })
      );
  await mkRecipient("r1", "SENT", true, false);
  await mkRecipient("r2", "SENT", false, true);
  await mkRecipient("r3", "FAILED", false, false);
  await mkRecipient("r4", "SKIPPED", null, false);

  // Failed outbound send.
  await db.outboundSend.create({
    data: {
      workspaceId: wsA,
      contactId: contact.id,
      channel: "whatsapp",
      messageType: "freeform",
      body: "hi",
      idempotencyKey: `s4b-send-${suffix}`,
      status: "FAILED",
      error: "24h window closed",
      createdAt: new Date(t0.getTime() + 120_000),
    },
  });

  // More contacts for leads-by-stage.
  await db.contact.createMany({
    data: [
      { workspaceId: wsA, name: `S4B New ${suffix}`, channel: "webchat", leadStatus: "NEW" },
      { workspaceId: wsA, name: `S4B Conv ${suffix}`, channel: "email", leadStatus: "CONVERTED" },
    ],
  });

  // Workflow executions for automation runs.
  const wf = await db.workflow.create({ data: { workspaceId: wsA, name: `S4B WF ${suffix}`, status: "PUBLISHED" } });
  await db.workflowExecution.createMany({
    data: [
      { workflowId: wf.id, status: "SUCCEEDED", idempotencyKey: `s4b-ex1-${suffix}`, startedAt: new Date(t0.getTime() + 10_000) },
      { workflowId: wf.id, status: "SUCCEEDED", idempotencyKey: `s4b-ex2-${suffix}`, startedAt: new Date(t0.getTime() + 20_000) },
      { workflowId: wf.id, status: "FAILED", idempotencyKey: `s4b-ex3-${suffix}`, startedAt: new Date(t0.getTime() + 30_000) },
      // Batch C: one dry run — excluded from headline runs by default,
      // tallied separately as dryRuns.
      { workflowId: wf.id, status: "DRY_RUN", dryRun: true, idempotencyKey: `s4b-ex4-${suffix}`, startedAt: new Date(t0.getTime() + 40_000) },
    ],
  });

  // --- Workspace B: must stay invisible to wsA ---
  const contactB = await db.contact.create({
    data: { workspaceId: wsB, name: `S4B B Contact ${suffix}`, channel: "webchat", leadStatus: "NEW" },
  });
  const convoB = await db.conversation.create({
    data: { workspaceId: wsB, contactId: contactB.id, channel: "webchat" },
  });
  await db.message.create({
    data: { conversationId: convoB.id, direction: "INBOUND", body: "b secret", createdAt: new Date() },
  });
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { name: { in: orgNames } } });
  await db.user.deleteMany({ where: { email: { contains: suffix } } });
  await db.$disconnect();
});

const rangeParams = () =>
  `from=${new Date(Date.now() - 3 * 86_400_000).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}`;

describe("GET /api/analytics/detail", () => {
  it("computes messages per day, response time, automation runs, campaigns, failed sends, leads by stage", async () => {
    authedAs(userAId, `s4b-a-${suffix}@example.com`);

    // Batch C — production default first. NOTE: this test's seeded
    // outbound message is mocked:true, and the old expectations below
    // (totalOut 1, 300s response) encoded the OLD inclusive behavior.
    // Under the new default they must NOT count; the original numbers
    // are re-asserted verbatim on the includeTestData=1 request.
    const prodRes = await detailGET(req(`http://x/api/analytics/detail?${rangeParams()}`, wsA), {});
    const prod = (await jsonBody(prodRes)).body.data;
    expect(prod.testDataIncluded).toBe(false);
    expect(prod.messagesPerDay.reduce((a: number, x: any) => a + x.messagesIn, 0)).toBe(2);
    expect(prod.messagesPerDay.reduce((a: number, x: any) => a + x.messagesOut, 0)).toBe(0); // only outbound is mocked
    expect(prod.internalNotesExcluded).toBe(1);
    expect(prod.avgFirstResponseSeconds).toBeNull(); // no non-mocked in→out pair
    // Dry run excluded from headline runs, tallied separately.
    expect(prod.automationRuns.total).toBe(3);
    expect(prod.automationRuns.succeeded).toBe(2);
    expect(prod.automationRuns.failed).toBe(1);
    expect(prod.automationRuns.dryRuns).toBe(1);
    expect(prod.automationRuns.successRate).toBeCloseTo(2 / 3, 4);

    const res = await detailGET(
      req(`http://x/api/analytics/detail?${rangeParams()}&includeTestData=1`, wsA), {});
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    const d = body.data;
    expect(d.testDataIncluded).toBe(true);

    // Messages per day: internal notes excluded from in/out counts.
    const totalIn = d.messagesPerDay.reduce((a: number, x: any) => a + x.messagesIn, 0);
    const totalOut = d.messagesPerDay.reduce((a: number, x: any) => a + x.messagesOut, 0);
    expect(totalIn).toBe(2);
    expect(totalOut).toBe(1);
    expect(d.internalNotesExcluded).toBe(1);

    // Avg first response: 300s (only the conversation with both directions).
    expect(d.avgFirstResponseSeconds).toBeCloseTo(300, 1);

    // Automation runs with test data included: the dry run joins the
    // total (4) but is never counted as a success.
    expect(d.automationRuns.total).toBe(4);
    expect(d.automationRuns.succeeded).toBe(2);
    expect(d.automationRuns.failed).toBe(1);
    expect(d.automationRuns.dryRuns).toBe(1);
    expect(d.automationRuns.successRate).toBeCloseTo(2 / 4, 4);

    // Campaign performance aggregates.
    expect(d.campaignPerformance).toHaveLength(1);
    const cp = d.campaignPerformance[0];
    expect(cp.sent).toBe(2);
    expect(cp.failed).toBe(1);
    expect(cp.skipped).toBe(1);
    expect(cp.replied).toBe(1);
    expect(cp.mockedSends).toBe(1);

    // Failed sends listed.
    expect(d.failedSends).toHaveLength(1);
    expect(d.failedSends[0].error).toBe("24h window closed");

    // Leads by stage.
    const byStage = Object.fromEntries(d.leadsByStage.map((l: any) => [l.stage, l.count]));
    expect(byStage.QUALIFIED).toBe(1);
    expect(byStage.NEW).toBe(1);
    expect(byStage.CONVERTED).toBe(1);
    expect(byStage.CONTACTED).toBe(4);
  });

  it("is honest about missing data: null averages and rates", async () => {
    authedAs(userAId, `s4b-a-${suffix}@example.com`);
    const farFuture = `from=${new Date(Date.now() + 10 * 86_400_000).toISOString()}&to=${new Date(Date.now() + 11 * 86_400_000).toISOString()}`;
    const res = await detailGET(req(`http://x/api/analytics/detail?${farFuture}`, wsA), {});
    const { body } = await jsonBody(res);
    expect(body.data.avgFirstResponseSeconds).toBeNull();
    expect(body.data.automationRuns.successRate).toBeNull();
    expect(body.data.campaignPerformance).toEqual([]);
    expect(body.data.failedSends).toEqual([]);
  });

  it("rejects invalid ranges and is tenant-isolated", async () => {
    authedAs(userAId, `s4b-a-${suffix}@example.com`);
    const bad = await detailGET(req("http://x/api/analytics/detail?from=nope", wsA), {});
    expect(bad.status).toBe(422);

    // wsB's secret message must not leak into wsA.
    const res = await detailGET(req(`http://x/api/analytics/detail?${rangeParams()}`, wsA), {});
    const { body } = await jsonBody(res);
    const totalIn = body.data.messagesPerDay.reduce((a: number, x: any) => a + x.messagesIn, 0);
    expect(totalIn).toBe(2); // not 3
  });

  it("filters by campaignId and stage", async () => {
    authedAs(userAId, `s4b-a-${suffix}@example.com`);
    const campaign = await db.campaign.findFirst({ where: { workspaceId: wsA } });
    const res = await detailGET(
      req(`http://x/api/analytics/detail?${rangeParams()}&campaignId=${campaign!.id}`, wsA), {});
    const { body } = await jsonBody(res);
    expect(body.data.campaignPerformance).toHaveLength(1);

    const staged = await detailGET(req(`http://x/api/analytics/detail?${rangeParams()}&stage=NEW`, wsA), {});
    const { body: stagedBody } = await jsonBody(staged);
    expect(stagedBody.data.leadsByStage).toEqual([{ stage: "NEW", count: 1 }]);
  });
});

describe("GET /api/analytics/export", () => {
  it("downloads a well-formed messages CSV with attachment disposition", async () => {
    authedAs(userAId, `s4b-a-${suffix}@example.com`);
    const res = await exportGET(req(`http://x/api/analytics/export?metric=messages&${rangeParams()}`, wsA), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("flowpilot-messages-");
    expect(res.headers.get("x-truncated")).toBe("false");
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("date,message_id,conversation_id,contact_name,channel,direction,body,ai_generated,mocked,internal_note");
    expect(lines.length).toBeGreaterThan(1);
    // All rows belong to wsA (no B contact name present).
    expect(text).not.toContain(`S4B B Contact ${suffix}`);
    expect(text).toContain("pricing please");
  });

  it("exports campaigns and leads CSVs with the right headers", async () => {
    authedAs(userAId, `s4b-a-${suffix}@example.com`);
    const camps = await exportGET(req(`http://x/api/analytics/export?metric=campaigns&${rangeParams()}`, wsA), {});
    const campText = await camps.text();
    expect(campText.split("\n")[0]).toContain("campaign_id,campaign_name,channel");
    expect(campText).toContain(`S4B Campaign ${suffix}`);

    const leads = await exportGET(req(`http://x/api/analytics/export?metric=leads&${rangeParams()}`, wsA), {});
    const leadText = await leads.text();
    expect(leadText.split("\n")[0]).toContain("contact_id,name,email");
    expect(leadText).toContain(`S4B Lead ${suffix}`);
    expect(leadText).not.toContain(`S4B B Contact ${suffix}`);
  });

  it("escapes CSV cells with quotes and commas", async () => {
    authedAs(userAId, `s4b-a-${suffix}@example.com`);
    const contact = await db.contact.findFirst({ where: { workspaceId: wsA } });
    const convo = await db.conversation.findFirst({ where: { workspaceId: wsA } });
    await db.message.create({
      data: {
        conversationId: convo!.id,
        direction: "INBOUND",
        body: 'He said "hello, world"',
        createdAt: new Date(),
      },
    });
    const res = await exportGET(req(`http://x/api/analytics/export?metric=messages&${rangeParams()}`, wsA), {});
    const text = await res.text();
    expect(text).toContain('"He said ""hello, world"""');
    void contact;
  });

  it("rejects an invalid metric", async () => {
    authedAs(userAId, `s4b-a-${suffix}@example.com`);
    const res = await exportGET(req(`http://x/api/analytics/export?metric=banana&${rangeParams()}`, wsA), {});
    expect(res.status).toBe(422);
    const missing = await exportGET(req(`http://x/api/analytics/export?${rangeParams()}`, wsA), {});
    expect(missing.status).toBe(422);
  });
});
