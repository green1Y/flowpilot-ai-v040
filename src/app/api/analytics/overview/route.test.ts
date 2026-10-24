/**
 * Overview route — dashboard payload tests (Workstream E).
 *
 * The /app/overview dashboard page consumes the `kpis`, `leadsByChannel`,
 * `topAutomations`, `recentConversations`, `unresolvedConversations`,
 * `draftWorkflows`, and `demo` fields of GET /api/analytics/overview. The
 * route used to return only the analytics-tab shape ({metrics, series,
 * previousPeriod}), so every KPI card rendered "—" and every list stayed
 * empty. These tests seed real rows and assert the dashboard fields are
 * populated from authorized DB records — while the legacy analytics-tab
 * shape stays intact.
 *
 * Also covers: channel filter propagation ("all" = no filter), and
 * date-only custom bounds including the full end day.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `ovd${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let ws = "";
let wsDemo = "";
let wsTest = "";

function req(url: string): NextRequest {
  return new NextRequest(url, { headers: { "x-workspace-id": ws } });
}

function reqFor(url: string, workspaceId: string): NextRequest {
  return new NextRequest(url, { headers: { "x-workspace-id": workspaceId } });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `ovd-${suffix}@example.com`, name: "Ovd", passwordHash: "x" },
  });
  const org = await db.organization.create({ data: { name: `Ovd Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `Ovd WS ${suffix}`, slug: `ovd-${suffix}` },
  });
  ws = w.id;
  await db.membership.create({ data: { userId: user.id, workspaceId: w.id, role: "OWNER" } });
  mockedRequireUser.mockResolvedValue({ userId: user.id, email: user.email, user } as any);

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3_600_000);
  const old = new Date(now.getTime() - 40 * 24 * 3_600_000); // outside 30d

  // Contacts: 1 new lead on instagram (in range), 1 qualified on whatsapp
  // (in range), 1 stale contact far outside the range.
  const cIg = await db.contact.create({
    data: {
      workspaceId: ws,
      name: "Ig Lead",
      channel: "instagram",
      leadStatus: "NEW",
      firstSeenAt: yesterday,
      lastSeenAt: yesterday,
    },
  });
  const cWa = await db.contact.create({
    data: {
      workspaceId: ws,
      name: "Wa Qualified",
      channel: "whatsapp",
      leadStatus: "QUALIFIED",
      leadScore: 80,
      firstSeenAt: yesterday,
      lastSeenAt: yesterday,
    },
  });
  await db.contact.create({
    data: {
      workspaceId: ws,
      name: "Old Contact",
      channel: "email",
      leadStatus: "NEW",
      firstSeenAt: old,
      lastSeenAt: old,
    },
  });

  // Conversations: 1 OPEN on instagram with 1 inbound + 1 outbound message,
  // 1 RESOLVED on whatsapp.
  const convIg = await db.conversation.create({
    data: {
      workspaceId: ws,
      contactId: cIg.id,
      channel: "instagram",
      status: "OPEN",
      aiHandled: true,
      createdAt: yesterday,
      updatedAt: now,
    },
  });
  await db.message.create({
    data: {
      conversationId: convIg.id,
      direction: "INBOUND",
      body: "hello there",
      createdAt: yesterday,
    },
  });
  await db.message.create({
    data: {
      conversationId: convIg.id,
      direction: "OUTBOUND",
      body: "hi! how can I help?",
      aiGenerated: true,
      createdAt: new Date(yesterday.getTime() + 60_000),
    },
  });
  await db.conversation.create({
    data: {
      workspaceId: ws,
      contactId: cWa.id,
      channel: "whatsapp",
      status: "RESOLVED",
      createdAt: yesterday,
      updatedAt: yesterday,
    },
  });

  // Workflows: 1 DRAFT (pending task) + 1 PUBLISHED with one succeeded run.
  await db.workflow.create({
    data: { workspaceId: ws, name: `Ovd Draft ${suffix}`, status: "DRAFT" },
  });
  const wfPub = await db.workflow.create({
    data: { workspaceId: ws, name: `Ovd Published ${suffix}`, status: "PUBLISHED" },
  });
  await db.workflowExecution.create({
    data: {
      workflowId: wfPub.id,
      status: "SUCCEEDED",
      idempotencyKey: `ovd-${suffix}`,
      startedAt: yesterday,
      finishedAt: new Date(yesterday.getTime() + 1_000),
    },
  });

  // --- Batch C fixtures -------------------------------------------------
  // A demo workspace (isDemo=true, no activity) for the `demo` flag, and a
  // non-demo workspace mixing live activity with test activity: one live
  // conversation (live in+out), one mocked-only conversation (mocked
  // in+out), one live SUCCEEDED execution and one DRY_RUN execution.
  const wDemo = await db.workspace.create({
    data: { orgId: org.id, name: `Ovd Demo WS ${suffix}`, slug: `ovd-demo-${suffix}`, isDemo: true },
  });
  wsDemo = wDemo.id;
  await db.membership.create({ data: { userId: user.id, workspaceId: wDemo.id, role: "OWNER" } });

  const wTest = await db.workspace.create({
    data: { orgId: org.id, name: `Ovd Test WS ${suffix}`, slug: `ovd-test-${suffix}` },
  });
  wsTest = wTest.id;
  await db.membership.create({ data: { userId: user.id, workspaceId: wTest.id, role: "OWNER" } });

  const cTest = await db.contact.create({
    data: { workspaceId: wsTest, name: "Test Mix", channel: "instagram", firstSeenAt: yesterday, lastSeenAt: yesterday },
  });
  const convLive = await db.conversation.create({
    data: { workspaceId: wsTest, contactId: cTest.id, channel: "instagram", status: "OPEN", createdAt: yesterday, updatedAt: now },
  });
  await db.message.createMany({
    data: [
      { conversationId: convLive.id, direction: "INBOUND", body: "live in", createdAt: yesterday },
      { conversationId: convLive.id, direction: "OUTBOUND", body: "live out", createdAt: new Date(yesterday.getTime() + 60_000) },
    ],
  });
  const convMocked = await db.conversation.create({
    data: { workspaceId: wsTest, contactId: cTest.id, channel: "instagram", status: "OPEN", createdAt: yesterday, updatedAt: yesterday },
  });
  await db.message.createMany({
    data: [
      { conversationId: convMocked.id, direction: "INBOUND", body: "mock in", mocked: true, createdAt: yesterday },
      { conversationId: convMocked.id, direction: "OUTBOUND", body: "mock out", mocked: true, createdAt: new Date(yesterday.getTime() + 60_000) },
    ],
  });
  const wfTest = await db.workflow.create({
    data: { workspaceId: wsTest, name: `Ovd Test WF ${suffix}`, status: "PUBLISHED" },
  });
  await db.workflowExecution.createMany({
    data: [
      {
        workflowId: wfTest.id,
        status: "SUCCEEDED",
        idempotencyKey: `ovd-test-live-${suffix}`,
        startedAt: yesterday,
        finishedAt: new Date(yesterday.getTime() + 1_000),
      },
      {
        workflowId: wfTest.id,
        status: "DRY_RUN",
        dryRun: true,
        idempotencyKey: `ovd-test-dry-${suffix}`,
        startedAt: yesterday,
        finishedAt: new Date(yesterday.getTime() + 1_000),
      },
    ],
  });
});

describe("dashboard payload", () => {
  it("serves the kpis shape the overview page renders (from real DB rows)", async () => {
    const { status, body } = await jsonBody(await GET(req("http://x/api/analytics/overview?range=7d")));
    expect(status).toBe(200);
    const d = body.data;

    expect(d.demo).toBe(false); // never serve sample data as live activity

    expect(d.kpis.totalConversations.value).toBe(2);
    expect(d.kpis.aiHandled.value).toBe(1);
    expect(d.kpis.newLeads.value).toBe(2); // 2 contacts first-seen in range
    expect(d.kpis.qualifiedLeads.value).toBe(1); // QUALIFIED contact
    expect(d.kpis.automationRuns.value).toBe(1);
    expect(d.kpis.messagesSent.value).toBe(1); // 1 outbound message
    expect(d.kpis.conversionRate.value).toBe(0); // 3 contacts, 0 converted → honest 0%

    // Lists
    expect(d.unresolvedConversations).toBe(1); // the OPEN conversation
    expect(d.draftWorkflows).toBe(1);
    expect(d.topAutomations).toHaveLength(1);
    expect(d.topAutomations[0].runs).toBe(1);
    expect(d.topAutomations[0].status).toBe("PUBLISHED");
    expect(d.recentConversations).toHaveLength(2);
    expect(d.recentConversations[0].contactName).toBe("Ig Lead"); // most recently updated
    expect(d.recentConversations[0].lastMessage).toBe("hi! how can I help?");

    // Leads by channel (in-range firstSeenAt only)
    const ig = d.leadsByChannel.find((r: any) => r.channel === "instagram");
    expect(ig?.leads).toBe(1);
    const wa = d.leadsByChannel.find((r: any) => r.channel === "whatsapp");
    expect(wa?.leads).toBe(1);
    expect(d.leadsByChannel.some((r: any) => r.channel === "email")).toBe(false);

    // Series carries the keys the dashboard charts consume
    expect(d.series.length).toBeGreaterThan(0);
    for (const p of d.series) {
      expect(typeof p.messages).toBe("number");
      expect(typeof p.label).toBe("string");
    }
  });

  it("keeps the legacy analytics-tab shape intact (metrics/series/previousPeriod)", async () => {
    const { status, body } = await jsonBody(await GET(req("http://x/api/analytics/overview?range=7d")));
    expect(status).toBe(200);
    const d = body.data;
    expect(d.metrics.conversations).toBe(2);
    expect(d.metrics.messagesIn).toBe(1);
    expect(d.metrics.messagesOut).toBe(1);
    expect(d.metrics.newLeads).toBe(2);
    expect(d.metrics.aiHandledPct).toBe(50);
    expect(d.previousPeriod.label).toContain("7d");
    expect(d.previousPeriod.metrics.conversations).toBe(0);
  });

  it("channel filter narrows every dashboard field", async () => {
    const { body } = await jsonBody(
      await GET(req("http://x/api/analytics/overview?range=7d&channel=whatsapp"))
    );
    const d = body.data;
    expect(d.kpis.totalConversations.value).toBe(1);
    expect(d.kpis.messagesSent.value).toBe(0);
    expect(d.unresolvedConversations).toBe(0); // the OPEN convo is instagram
    expect(d.leadsByChannel).toHaveLength(1);
    expect(d.leadsByChannel[0].channel).toBe("whatsapp");
    expect(d.recentConversations).toHaveLength(1);
    expect(d.recentConversations[0].contactName).toBe("Wa Qualified");
  });

  it("channel=all behaves like no filter", async () => {
    const { body } = await jsonBody(
      await GET(req("http://x/api/analytics/overview?range=7d&channel=all"))
    );
    expect(body.data.kpis.totalConversations.value).toBe(2);
  });

  it("demo flag reads Workspace.isDemo for the requesting workspace (Batch C)", async () => {
    const demoRes = await jsonBody(await GET(reqFor("http://x/api/analytics/overview?range=7d", wsDemo)));
    expect(demoRes.status).toBe(200);
    expect(demoRes.body.data.demo).toBe(true);
    const prodRes = await jsonBody(await GET(reqFor("http://x/api/analytics/overview?range=7d", wsTest)));
    expect(prodRes.body.data.demo).toBe(false);
  });

  it("excludes mocked messages and DRY_RUN executions by default; includeTestData=1 opts in (Batch C)", async () => {
    const def = await jsonBody(await GET(reqFor("http://x/api/analytics/overview?range=7d", wsTest)));
    expect(def.status).toBe(200);
    const d = def.body.data;
    expect(d.testDataIncluded).toBe(false);
    expect(d.metrics.conversations).toBe(1); // mocked-only conversation excluded
    expect(d.metrics.messagesIn).toBe(1);
    expect(d.metrics.messagesOut).toBe(1);
    expect(d.metrics.workflowRuns).toBe(1); // live SUCCEEDED only
    expect(d.metrics.workflowDryRuns).toBe(1); // reported separately
    expect(d.kpis.totalConversations.value).toBe(1);
    expect(d.recentConversations).toHaveLength(1);

    const incl = await jsonBody(
      await GET(reqFor("http://x/api/analytics/overview?range=7d&includeTestData=1", wsTest))
    );
    expect(incl.status).toBe(200);
    const i = incl.body.data;
    expect(i.testDataIncluded).toBe(true);
    expect(i.metrics.conversations).toBe(2);
    expect(i.metrics.messagesIn).toBe(2);
    expect(i.metrics.messagesOut).toBe(2);
    expect(i.metrics.workflowRuns).toBe(2);
    expect(i.metrics.workflowDryRuns).toBe(1);
    expect(i.recentConversations).toHaveLength(2);
  });

  it("date-only custom range includes the full end day", async () => {
    const today = isoDay(new Date());
    const { status, body } = await jsonBody(
      await GET(req(`http://x/api/analytics/overview?range=custom&from=${today}&to=${today}`))
    );
    expect(status).toBe(200);
    // The instagram conversation was updated today → its messages fall in
    // the single-day window only if the end-day boundary is inclusive.
    expect(body.data.metrics.messagesOut).toBe(0); // messages were yesterday
    const y = isoDay(new Date(Date.now() - 24 * 3_600_000));
    const r2 = await jsonBody(
      await GET(req(`http://x/api/analytics/overview?range=custom&from=${y}&to=${y}`))
    );
    expect(r2.status).toBe(200);
    expect(r2.body.data.metrics.messagesIn).toBe(1);
    expect(r2.body.data.metrics.messagesOut).toBe(1);
  });
});
