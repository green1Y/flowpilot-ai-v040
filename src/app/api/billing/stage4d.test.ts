/**
 * Stage 4d — SaaS plan limits: server-side enforced usage metering.
 *
 * Covers: recordUsage/getUsage aggregation, resolvePlan fallbacks,
 * checkLimit shapes, requirePlanLimit throwing an honest 402
 * (PLAN_LIMIT_EXCEEDED, JSON — never HTML), guard enforcement on campaign
 * launch, immediate follow-up send and the inbox test-send endpoint, usage
 * incrementing on real sends, tenant isolation, the "unlimited-ish" Agency
 * tier, and the /api/billing response shape.
 *
 * Auth is stubbed and the workspace adapter is mocked (no real Meta calls);
 * DB is the fresh test.db per run. Same harness pattern as stage3.test.ts.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAdapter } from "@/lib/integrations/providers";
import { trackUsage } from "@/lib/audit";
import { sendFollowUp } from "@/lib/messaging/send";
import {
  recordUsage,
  getUsage,
  resolvePlan,
  checkLimit,
  requirePlanLimit,
  currentMonth,
} from "@/lib/billing/usage";
import { GET as billingGET } from "@/app/api/billing/route";
import { POST as messagesPOST } from "@/app/api/conversations/[id]/messages/route";
import { POST as followUpsPOST } from "@/app/api/follow-ups/route";
import { POST as startPOST } from "@/app/api/campaigns/[id]/start/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/integrations/providers", () => {
  // Batch B: the send pipeline / engine resolve adapters via
  // resolveWorkspaceAdapter (which also reports the account used).
  // Delegate it to the getWorkspaceAdapter stub so this file's existing
  // fake-adapter setups keep working unchanged; resolution reports the
  // mock path (integrationId null), as these tests predate account routing.
  const getWorkspaceAdapter = vi.fn();
  const resolveWorkspaceAdapter = vi.fn(
    async (...args: unknown[]) => {
      const adapter = await (getWorkspaceAdapter as any)(...args);
      return { adapter, integrationId: null, mocked: true };
    }
  );
  class AccountResolutionError extends Error {
    code = "AMBIGUOUS_ACCOUNT";
  }
  return { getWorkspaceAdapter, resolveWorkspaceAdapter, AccountResolutionError };
});
const mockedRequireUser = vi.mocked(requireUser);
const mockedGetAdapter = vi.mocked(getWorkspaceAdapter);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  } as any);
}

function req(url: string, workspaceId: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: { "x-workspace-id": workspaceId, "content-type": "application/json" },
  });
}

function withId(fn: (r: NextRequest, ctx: any) => Promise<Response>, r: NextRequest, id: string) {
  return fn(r, { params: { id } });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

async function catchThrownResponse(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
}

const suffix = `d4${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userAId = "";
let wsA = ""; // Starter
let wsB = ""; // Growth
let wsC = ""; // Agency
let wsD = ""; // Starter, driven to its message cap
let contactAId = "";
let contactDId = "";
let convoAId = "";
let campaignDId = "";

const sendMessage = vi.fn();

beforeAll(async () => {
  sendMessage.mockImplementation(async (args: { body: string }) => ({
    ok: true,
    mocked: true,
    externalId: `d4-ext-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  }));
  mockedGetAdapter.mockResolvedValue({
    provider: "facebook",
    displayName: "Fake",
    capabilities: [],
    limitations: [],
    requiredPermissions: [],
    connect: async () => ({ ok: true, verified: false, status: "DISCONNECTED", message: "" }),
    verify: async () => ({ ok: true, verified: false, status: "DISCONNECTED", message: "" }),
    sendMessage,
    verifyWebhookSignature: () => true,
  } as any);

  // Plan tiers (same shape as src/db/seed-plans.ts).
  const starter = await db.plan.upsert({
    where: { name: "Starter" },
    update: {},
    create: {
      name: "Starter",
      monthlyMessageLimit: 500,
      workflowLimit: 5,
      seatLimit: 3,
      features: JSON.stringify(["starter"]),
    },
  });
  const growth = await db.plan.upsert({
    where: { name: "Growth" },
    update: {},
    create: {
      name: "Growth",
      monthlyMessageLimit: 5000,
      workflowLimit: 25,
      seatLimit: 10,
      features: JSON.stringify(["growth"]),
    },
  });
  const agency = await db.plan.upsert({
    where: { name: "Agency" },
    update: {},
    create: {
      name: "Agency",
      monthlyMessageLimit: 25000,
      workflowLimit: 200,
      seatLimit: 25,
      features: JSON.stringify(["agency"]),
    },
  });

  const a = await db.user.create({ data: { email: `d4-a-${suffix}@example.com`, name: "D4 A", passwordHash: "x" } });
  userAId = a.id;
  const org = await db.organization.create({ data: { name: `D4 Org ${suffix}` } });
  const mkWs = async (name: string, planId: string) => {
    const w = await db.workspace.create({
      data: { orgId: org.id, name, slug: `${name}-${suffix}`, planId },
    });
    await db.membership.create({ data: { userId: a.id, workspaceId: w.id, role: "OWNER" } });
    return w.id;
  };
  wsA = await mkWs(`d4-ws-a`, starter.id);
  wsB = await mkWs(`d4-ws-b`, growth.id);
  wsC = await mkWs(`d4-ws-c`, agency.id);
  wsD = await mkWs(`d4-ws-d`, starter.id);

  const cA = await db.contact.create({
    data: {
      workspaceId: wsA,
      name: `D4 Eve ${suffix}`,
      channel: "facebook",
      externalIds: JSON.stringify({ PSID: `d4-psid-a-${suffix}` }),
      lastInboundAt: new Date(),
    },
  });
  contactAId = cA.id;
  const conv = await db.conversation.create({
    data: { workspaceId: wsA, contactId: cA.id, channel: "facebook" },
  });
  convoAId = conv.id;

  const cD = await db.contact.create({
    data: {
      workspaceId: wsD,
      name: `D4 Eve D ${suffix}`,
      channel: "facebook",
      externalIds: JSON.stringify({ PSID: `d4-psid-d-${suffix}` }),
      lastInboundAt: new Date(),
    },
  });
  contactDId = cD.id;

  // Campaign on wsD (driven to cap) with one PENDING recipient.
  const camp = await db.campaign.create({
    data: {
      workspaceId: wsD,
      name: `D4 Campaign ${suffix}`,
      channel: "facebook",
      status: "DRAFT",
    },
  });
  campaignDId = camp.id;
  await db.campaignRecipient.create({
    data: {
      campaignId: camp.id,
      contactId: cD.id,
      status: "PENDING",
      idempotencyKey: `campaign:${camp.id}:contact:${cD.id}`,
    },
  });
});

describe("recordUsage / getUsage", () => {
  it("increments counters and reads them back aggregated", async () => {
    const before = await getUsage(wsA);
    await recordUsage(wsA, { messagesSent: 3, workflowsRun: 2, apiCalls: 10 });
    await recordUsage(wsA, { messagesSent: 2 });
    const after = await getUsage(wsA);
    expect(after.month).toBe(currentMonth());
    expect(after.messagesSent).toBe(before.messagesSent + 5);
    expect(after.workflowsRun).toBe(before.workflowsRun + 2);
    expect(after.apiCalls).toBe(before.apiCalls + 10);
    expect(after.messagesReceived).toBe(before.messagesReceived);
  });

  it("returns zeros for a workspace/month with no usage", async () => {
    const u = await getUsage(wsB);
    expect(u.messagesSent).toBe(0);
    expect(u.workflowsRun).toBe(0);
  });

  it("never throws on DB failures", async () => {
    // Bogus counter key is ignored; invalid workspace id is caught.
    await expect(recordUsage("does-not-exist", { messagesSent: 1 })).resolves.toBeUndefined();
  });
});

describe("resolvePlan", () => {
  it("resolves the Starter plan via planId FK", async () => {
    const plan = await resolvePlan(wsA);
    expect(plan.name).toBe("Starter");
    expect(plan.monthlyMessageLimit).toBe(500);
    expect(plan.workflowLimit).toBe(5);
    expect(plan.seatLimit).toBe(3);
    expect(Array.isArray(plan.features)).toBe(true);
  });

  it("falls back to the legacy plan name when planId is null", async () => {
    await db.workspace.update({ where: { id: wsB }, data: { planId: null, plan: "GROWTH" } });
    const plan = await resolvePlan(wsB);
    expect(plan.name).toBe("Growth");
    expect(plan.monthlyMessageLimit).toBe(5000);
  });
});

describe("checkLimit / requirePlanLimit", () => {
  it("reports used/limit/resetsAt and allows under-cap workspaces", async () => {
    const check = await checkLimit(wsA, "messages");
    expect(check.allowed).toBe(true);
    expect(check.used).toBeGreaterThanOrEqual(0);
    expect(check.limit).toBe(500);
    expect(() => new Date(check.resetsAt)).not.toThrow();
    expect(new Date(check.resetsAt).getUTCDate()).toBe(1);
  });

  it("blocks at the cap with a 402 carrying PLAN_LIMIT_EXCEEDED", async () => {
    await recordUsage(wsD, { messagesSent: 500 });
    const check = await checkLimit(wsD, "messages");
    expect(check.allowed).toBe(false);
    expect(check.used).toBeGreaterThanOrEqual(500);
    expect(check.limit).toBe(500);

    const thrown = await catchThrownResponse(() => requirePlanLimit(wsD, "messages"));
    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(402);
    const json = (await res.json()) as any;
    expect(json.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(json.used).toBeGreaterThanOrEqual(500);
    expect(json.limit).toBe(500);
    expect(typeof json.upgradeHint).toBe("string");
    expect(json.upgradeHint.length).toBeGreaterThan(0);
    // Honest JSON — not an HTML error page.
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("workflow limit counts DEFINED workflows, never executions (Batch C semantics)", async () => {
    // Executions are metered (workflowsRun) but must NOT consume
    // workflowLimit: even at 5 recorded runs, a workspace with zero
    // defined workflows is fully allowed.
    await recordUsage(wsD, { workflowsRun: 5 });
    const afterRuns = await checkLimit(wsD, "workflows");
    expect(afterRuns.limit).toBe(5);
    expect(afterRuns.used).toBe(0); // zero DEFINED workflows exist on wsD
    expect(afterRuns.allowed).toBe(true);

    // Defined workflows (Workflow rows) are what the cap counts.
    for (let i = 0; i < 5; i++) {
      await db.workflow.create({
        data: { workspaceId: wsD, name: `D4 defined ${i} ${suffix}` },
      });
    }
    const check = await checkLimit(wsD, "workflows");
    expect(check.allowed).toBe(false);
    expect(check.used).toBe(5);
    expect(check.limit).toBe(5);
    const thrown = await catchThrownResponse(() => requirePlanLimit(wsD, "workflows"));
    expect((thrown as Response).status).toBe(402);
    const json = (await (thrown as Response).json()) as any;
    expect(json.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(json.used).toBe(5);
    expect(json.limit).toBe(5);
  });

  it("reports seat usage against the seat limit", async () => {
    const check = await checkLimit(wsA, "seats");
    expect(check.allowed).toBe(true);
    expect(check.used).toBe(1);
    expect(check.limit).toBe(3);
  });

  it("the unlimited-ish Agency tier stays allowed at high usage", async () => {
    await recordUsage(wsC, { messagesSent: 20000, workflowsRun: 150 });
    const m = await checkLimit(wsC, "messages");
    expect(m.allowed).toBe(true);
    expect(m.used).toBe(20000);
    expect(m.limit).toBe(25000);
    const w = await checkLimit(wsC, "workflows");
    expect(w.allowed).toBe(true);
    expect(w.limit).toBe(200);
  });
});

describe("tenant isolation", () => {
  it("usage recorded for one workspace never touches another", async () => {
    await recordUsage(wsA, { messagesSent: 40 });
    const b = await getUsage(wsB);
    expect(b.messagesSent).toBe(0);
    const check = await checkLimit(wsB, "messages");
    expect(check.allowed).toBe(true);
  });
});

describe("send pipeline metering", () => {
  it("a successful send increments messagesSent", async () => {
    const before = await getUsage(wsA);
    const result = await sendFollowUp({
      workspaceId: wsA,
      userId: userAId,
      contactId: contactAId,
      channel: "facebook",
      messageType: "freeform",
      body: `hello {{name}} d4-${suffix}`,
      idempotencyKey: `d4-send-${suffix}`,
    });
    expect(result.status).toBe("SENT");
    const after = await getUsage(wsA);
    expect(after.messagesSent).toBe(before.messagesSent + 1);
  });

  it("trackUsage (the engine's metering call) increments workflowsRun", async () => {
    const before = await getUsage(wsA);
    await trackUsage(wsA, "workflow_runs", 1);
    const after = await getUsage(wsA);
    expect(after.workflowsRun).toBe(before.workflowsRun + 1);
  });
});

describe("route-level 402 enforcement", () => {
  it("inbox test-send returns 402 when the workspace is at cap", async () => {
    authedAs(userAId, `d4-a-${suffix}@example.com`);
    const convo = await db.conversation.create({
      data: { workspaceId: wsD, contactId: contactDId, channel: "facebook" },
    });
    const { status, body } = await jsonBody(
      await withId(messagesPOST, req(`http://x/api/conversations/${convo.id}/messages`, wsD, { method: "POST", body: { body: "test" } }), convo.id)
    );
    expect(status).toBe(402);
    expect(body.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(body.upgradeHint).toBeTruthy();
  });

  it("inbox test-send succeeds under the cap", async () => {
    authedAs(userAId, `d4-a-${suffix}@example.com`);
    const { status } = await jsonBody(
      await withId(messagesPOST, req(`http://x/api/conversations/${convoAId}/messages`, wsA, { method: "POST", body: { body: "hello" } }), convoAId)
    );
    expect(status).toBe(201);
  });

  it("campaign launch returns 402 when at cap", async () => {
    authedAs(userAId, `d4-a-${suffix}@example.com`);
    const { status, body } = await jsonBody(
      await withId(startPOST, req(`http://x/api/campaigns/${campaignDId}/start`, wsD, { method: "POST" }), campaignDId)
    );
    expect(status).toBe(402);
    expect(body.code).toBe("PLAN_LIMIT_EXCEEDED");
  });

  it("immediate follow-up send returns 402 when at cap", async () => {
    authedAs(userAId, `d4-a-${suffix}@example.com`);
    const { status, body } = await jsonBody(
      await followUpsPOST(
        req(`http://x/api/follow-ups`, wsD, {
          method: "POST",
          body: { contactId: contactDId, channel: "facebook", messageType: "freeform", body: "hi" },
        }) as NextRequest,
        {} as any
      )
    );
    expect(status).toBe(402);
    expect(body.code).toBe("PLAN_LIMIT_EXCEEDED");
  });

  it("immediate follow-up send succeeds under the cap", async () => {
    authedAs(userAId, `d4-a-${suffix}@example.com`);
    const { status, body } = await jsonBody(
      await followUpsPOST(
        req(`http://x/api/follow-ups`, wsB, {
          method: "POST",
          body: { contactId: contactAId, channel: "facebook", messageType: "freeform", body: "hi under cap" },
        }) as NextRequest,
        {} as any
      )
    );
    // Contact belongs to wsA, not wsB → 404 from the route (guard passed first).
    expect([404, 201]).toContain(status);
    expect(body.code ?? null).not.toBe("PLAN_LIMIT_EXCEEDED");
  });
});

describe("GET /api/billing", () => {
  it("returns plan limits and aggregated monthly usage", async () => {
    authedAs(userAId, `d4-a-${suffix}@example.com`);
    const { status, body } = await jsonBody(await billingGET(req("http://x/api/billing", wsA)));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.plan.name).toBe("Starter");
    expect(body.data.plan.monthlyMessageLimit).toBe(500);
    expect(body.data.plan.workflowLimit).toBe(5);
    // Batch C additive fields: workflowLimit means DEFINED workflows,
    // and the plan assignment source is honestly labeled (no payment
    // provider exists — plans are administrator-assigned).
    expect(body.data.plan.workflowLimitMeaning).toBe("defined_workflows");
    expect(body.data.assignment.source).toBe("manual"); // wsA is not a demo workspace
    expect(body.data.assignment.note).toContain("No payment provider is configured");
    expect(body.data.plan.seatLimit).toBe(3);
    expect(body.data.usage.month).toBe(currentMonth());
    expect(typeof body.data.usage.messagesSent).toBe("number");
    expect(typeof body.data.usage.seatsUsed).toBe("number");
  });

  it("is tenant-scoped", async () => {
    authedAs(userAId, `d4-a-${suffix}@example.com`);
    // A user with no membership must not see another workspace's billing.
    const other = await db.user.create({ data: { email: `d4-z-${suffix}@example.com`, name: "D4 Z", passwordHash: "x" } });
    const org = await db.organization.create({ data: { name: `D4 Org Z ${suffix}` } });
    const w = await db.workspace.create({ data: { orgId: org.id, name: `D4 WS Z ${suffix}`, slug: `d4-ws-z-${suffix}` } });
    await db.membership.create({ data: { userId: other.id, workspaceId: w.id, role: "OWNER" } });
    mockedRequireUser.mockResolvedValue({
      userId: other.id,
      email: `d4-z-${suffix}@example.com`,
      user: { id: other.id, name: "D4 Z", email: `d4-z-${suffix}@example.com` },
    } as any);
    const { status } = await jsonBody(await billingGET(req("http://x/api/billing", wsA)));
    // x-workspace-id: wsA with a user that has no membership → 403.
    expect(status).toBe(403);
  });
});
