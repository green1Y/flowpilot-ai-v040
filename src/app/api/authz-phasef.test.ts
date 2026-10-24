import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";

// Phase F — RBAC + authorization verification.
// Mocks the session at the auth boundary: requireWorkspace -> requireUser is
// the only auth import tenancy uses, so this gives full control over identity
// while exercising the real tenant-scoping and role checks server-side.
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

import { GET as getSegment } from "./retargeting/segments/[id]/route";
import { GET as getCampaignReport } from "./retargeting/campaigns/[id]/report/route";
import { POST as launchRetargeting } from "./retargeting/campaigns/[id]/launch/route";
import { POST as createRetargetingCampaign } from "./retargeting/campaigns/route";
import { POST as publishWorkflow } from "./workflows/[id]/publish/route";
import { POST as simulateWorkflow } from "./workflows/[id]/simulate/route";
import { GET as getCampaign } from "./campaigns/[id]/route";
import { GET as listCampaigns } from "./campaigns/route";
import { POST as createCampaign } from "./campaigns/route";
import { GET as getAnalytics } from "./analytics/overview/route";
import { GET as getBilling } from "./billing/route";
import { POST as inviteMember } from "./team/route";
import { POST as connectIntegration } from "./integrations/[id]/connect/route";
import { POST as createContact, GET as listContacts } from "./contacts/route";

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  });
}

function unauthed() {
  mockedRequireUser.mockRejectedValue(
    Response.json({ error: "Unauthorized" }, { status: 401 })
  );
}

function req(
  method: string,
  path: string,
  workspaceId: string,
  body?: unknown
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      "x-workspace-id": workspaceId,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ids = {
  ownerA: "",
  analystA: "",
  agentA: "",
  adminA: "",
  userB: "",
  wsA: "",
  wsB: "",
  segmentA: "",
  rtCampaignA: "",
  campaignA: "",
  workflowA: "",
  orgs: [] as string[],
  users: [] as string[],
};

beforeAll(async () => {
  const mkUser = async (tag: string) => {
    const u = await db.user.create({
      data: { email: `phasef-${tag}-${suffix}@example.com`.toLowerCase(), name: `PhaseF ${tag}`, passwordHash: "x" },
    });
    ids.users.push(u.id);
    return u;
  };
  const ownerA = await mkUser("ownerA");
  const analystA = await mkUser("analystA");
  const agentA = await mkUser("agentA");
  const adminA = await mkUser("adminA");
  const userB = await mkUser("userB");
  ids.ownerA = ownerA.id;
  ids.analystA = analystA.id;
  ids.agentA = agentA.id;
  ids.adminA = adminA.id;
  ids.userB = userB.id;

  const orgA = await db.organization.create({ data: { name: `PhaseF Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `PhaseF Org B ${suffix}` } });
  ids.orgs.push(orgA.id, orgB.id);

  // Batch C: seat limits are now enforced at invite time. This fixture
  // seats 4 members per workspace and invites a 5th, so the workspaces
  // sit on a plan whose seat limit fits the fixture team — the RBAC
  // assertions below are about roles, not plan caps.
  const phasefPlan = await db.plan.create({
    data: {
      name: `PhaseF Plan ${suffix}`,
      monthlyMessageLimit: 100000,
      workflowLimit: 100,
      seatLimit: 25,
      connectedAccountLimit: 50,
      features: "[]",
    },
  });
  const wA = await db.workspace.create({
    data: { orgId: orgA.id, name: `PhaseF WS A ${suffix}`, slug: `phasef-a-${suffix}`, planId: phasefPlan.id },
  });
  const wB = await db.workspace.create({
    data: { orgId: orgB.id, name: `PhaseF WS B ${suffix}`, slug: `phasef-b-${suffix}`, planId: phasefPlan.id },
  });
  ids.wsA = wA.id;
  ids.wsB = wB.id;

  await db.membership.create({ data: { userId: ownerA.id, workspaceId: wA.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: analystA.id, workspaceId: wA.id, role: "ANALYST" } });
  await db.membership.create({ data: { userId: agentA.id, workspaceId: wA.id, role: "AGENT" } });
  await db.membership.create({ data: { userId: adminA.id, workspaceId: wA.id, role: "ADMIN" } });
  await db.membership.create({ data: { userId: userB.id, workspaceId: wB.id, role: "OWNER" } });

  const segment = await db.audienceSegment.create({
    data: { workspaceId: wA.id, name: "PhaseF segment", conditions: "{}" },
  });
  ids.segmentA = segment.id;

  const rt = await db.retargetingCampaign.create({
    data: { workspaceId: wA.id, name: "PhaseF RT", type: "dm_reengagement", segmentId: segment.id },
  });
  ids.rtCampaignA = rt.id;

  const camp = await db.campaign.create({
    data: { workspaceId: wA.id, name: "PhaseF campaign", channel: "whatsapp" },
  });
  ids.campaignA = camp.id;

  const wf = await db.workflow.create({
    data: { workspaceId: wA.id, name: "PhaseF workflow", status: "DRAFT" },
  });
  ids.workflowA = wf.id;

  // One contact per workspace so analytics isolation is measurable.
  await db.contact.create({ data: { workspaceId: wA.id, name: "PhaseF Contact A", channel: "web" } });
  await db.contact.create({ data: { workspaceId: wB.id, name: "PhaseF Contact B", channel: "web" } });
});

afterAll(async () => {
  await db.contact.deleteMany({ where: { workspaceId: { in: [ids.wsA, ids.wsB] } } });
  await db.workflow.deleteMany({ where: { workspaceId: { in: [ids.wsA, ids.wsB] } } });
  await db.campaign.deleteMany({ where: { workspaceId: { in: [ids.wsA, ids.wsB] } } });
  await db.retargetingCampaign.deleteMany({ where: { workspaceId: { in: [ids.wsA, ids.wsB] } } });
  await db.audienceSegment.deleteMany({ where: { workspaceId: { in: [ids.wsA, ids.wsB] } } });
  await db.membership.deleteMany({ where: { workspaceId: { in: [ids.wsA, ids.wsB] } } });
  await db.workspace.deleteMany({ where: { id: { in: [ids.wsA, ids.wsB] } } });
  await db.organization.deleteMany({ where: { id: { in: ids.orgs } } });
  await db.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe("cross-workspace isolation (URL params)", () => {
  it("user B cannot read workspace A's retargeting segment (404)", async () => {
    authedAs(ids.userB, `phasef-userb-${suffix}@example.com`);
    const res = await getSegment(req("GET", `/api/retargeting/segments/${ids.segmentA}`, ids.wsB), {
      params: { id: ids.segmentA },
    });
    expect(res.status).toBe(404);
  });

  it("user B cannot read workspace A's retargeting campaign report (404)", async () => {
    authedAs(ids.userB, `phasef-userb-${suffix}@example.com`);
    const res = await getCampaignReport(
      req("GET", `/api/retargeting/campaigns/${ids.rtCampaignA}/report`, ids.wsB),
      { params: { id: ids.rtCampaignA } }
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("PhaseF RT");
  });

  it("user B cannot simulate workspace A's workflow (404)", async () => {
    authedAs(ids.userB, `phasef-userb-${suffix}@example.com`);
    const res = await simulateWorkflow(
      req("POST", `/api/workflows/${ids.workflowA}/simulate`, ids.wsB, { sampleEvent: {} }),
      { params: { id: ids.workflowA } }
    );
    expect(res.status).toBe(404);
  });

  it("user B cannot read workspace A's bulk campaign (404)", async () => {
    authedAs(ids.userB, `phasef-userb-${suffix}@example.com`);
    const res = await getCampaign(req("GET", `/api/campaigns/${ids.campaignA}`, ids.wsB), {
      params: { id: ids.campaignA },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("PhaseF campaign");
  });

  it("user B analytics show only workspace B data (never A's)", async () => {
    authedAs(ids.userB, `phasef-userb-${suffix}@example.com`);
    const res = await getAnalytics(req("GET", "/api/analytics/overview", ids.wsB));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Exactly one contact exists in B (seeded above); A's contact must not leak.
    expect(body.data.metrics.newLeads).toBe(1);
    expect(JSON.stringify(body)).not.toContain("PhaseF Contact A");
  });
});

describe("cross-workspace isolation (body payloads)", () => {
  it("user B cannot attach workspace A's segment to a new retargeting campaign (404)", async () => {
    authedAs(ids.userB, `phasef-userb-${suffix}@example.com`);
    const res = await createRetargetingCampaign(
      req("POST", "/api/retargeting/campaigns", ids.wsB, {
        name: "Sneaky RT",
        type: "dm_reengagement",
        channel: "whatsapp",
        message: { body: "hello" },
        segmentId: ids.segmentA,
      })
    );
    expect(res.status).toBe(404);
  });

  it("user B cannot create a bulk campaign referencing workspace A's template (404)", async () => {
    authedAs(ids.userB, `phasef-userb-${suffix}@example.com`);
    const tpl = await db.messageTemplate.create({
      data: { workspaceId: ids.wsA, name: "PhaseF tpl", channel: "whatsapp", body: "hi" },
    });
    try {
      const res = await createCampaign(
        req("POST", "/api/campaigns", ids.wsB, {
          name: "Sneaky campaign",
          channel: "whatsapp",
          templateId: tpl.id,
        })
      );
      expect(res.status).toBe(404);
    } finally {
      await db.messageTemplate.delete({ where: { id: tpl.id } });
    }
  });

  it("user B cannot launch workspace A's retargeting campaign (404, not 403/200)", async () => {
    // userB IS an owner of their own workspace, so a non-404 here would mean
    // the tenant scope leaked. Launch of another tenant's campaign must 404.
    authedAs(ids.userB, `phasef-userb-${suffix}@example.com`);
    const res = await launchRetargeting(
      req("POST", `/api/retargeting/campaigns/${ids.rtCampaignA}/launch`, ids.wsB, {
        confirmed: true,
      }),
      { params: { id: ids.rtCampaignA } }
    );
    expect(res.status).toBe(404);
  });
});

describe("role enforcement", () => {
  it("ANALYST cannot launch a retargeting campaign (403)", async () => {
    authedAs(ids.analystA, `phasef-analysta-${suffix}@example.com`);
    const res = await launchRetargeting(
      req("POST", `/api/retargeting/campaigns/${ids.rtCampaignA}/launch`, ids.wsA, {
        confirmed: true,
      }),
      { params: { id: ids.rtCampaignA } }
    );
    expect(res.status).toBe(403);
  });

  it("ANALYST cannot create a retargeting campaign (403)", async () => {
    authedAs(ids.analystA, `phasef-analysta-${suffix}@example.com`);
    const res = await createRetargetingCampaign(
      req("POST", "/api/retargeting/campaigns", ids.wsA, {
        name: "Analyst RT",
        type: "dm_reengagement",
      })
    );
    expect(res.status).toBe(403);
  });

  it("ANALYST cannot create a contact (403) but can read contacts (200)", async () => {
    authedAs(ids.analystA, `phasef-analysta-${suffix}@example.com`);
    const denied = await createContact(
      req("POST", "/api/contacts", ids.wsA, { name: "Nope", channel: "web" })
    );
    expect(denied.status).toBe(403);
    const allowed = await listContacts(req("GET", "/api/contacts", ids.wsA));
    expect(allowed.status).toBe(200);
  });

  it("AGENT can create a contact (201) — contacts are in the AGENT scope", async () => {
    authedAs(ids.agentA, `phasef-agenta-${suffix}@example.com`);
    const res = await createContact(
      req("POST", "/api/contacts", ids.wsA, { name: "Agent Contact", channel: "web" })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.contact.name).toBe("Agent Contact");
  });

  it("AGENT cannot read billing (403); OWNER can (200)", async () => {
    authedAs(ids.agentA, `phasef-agenta-${suffix}@example.com`);
    const denied = await getBilling(req("GET", "/api/billing", ids.wsA));
    expect(denied.status).toBe(403);

    authedAs(ids.ownerA, `phasef-ownera-${suffix}@example.com`);
    const allowed = await getBilling(req("GET", "/api/billing", ids.wsA));
    expect(allowed.status).toBe(200);
  });

  it("AGENT cannot invite team members (403); ADMIN can (201)", async () => {
    authedAs(ids.agentA, `phasef-agenta-${suffix}@example.com`);
    const denied = await inviteMember(
      req("POST", "/api/team", ids.wsA, {
        email: `phasef-userb-${suffix}@example.com`,
        role: "AGENT",
      })
    );
    expect(denied.status).toBe(403);

    authedAs(ids.adminA, `phasef-admina-${suffix}@example.com`);
    const allowed = await inviteMember(
      req("POST", "/api/team", ids.wsA, {
        email: `phasef-userb-${suffix}@example.com`,
        role: "AGENT",
      })
    );
    expect(allowed.status).toBe(201);
    // Clean up the invited membership so afterAll stays idempotent.
    await db.membership.deleteMany({
      where: { userId: ids.userB, workspaceId: ids.wsA },
    });
  });

  it("AGENT cannot start an integration connection (403)", async () => {
    authedAs(ids.agentA, `phasef-agenta-${suffix}@example.com`);
    const res = await connectIntegration(
      req("POST", "/api/integrations/instagram/connect", ids.wsA),
      { params: { id: "instagram" } }
    );
    expect(res.status).toBe(403);
  });

  it("AGENT cannot publish a workflow (403) — launch-control is MANAGER+", async () => {
    authedAs(ids.agentA, `phasef-agenta-${suffix}@example.com`);
    const res = await publishWorkflow(
      req("POST", `/api/workflows/${ids.workflowA}/publish`, ids.wsA),
      { params: { id: ids.workflowA } }
    );
    expect(res.status).toBe(403);
  });

  it("AGENT cannot create a bulk campaign (403)", async () => {
    authedAs(ids.agentA, `phasef-agenta-${suffix}@example.com`);
    const res = await createCampaign(
      req("POST", "/api/campaigns", ids.wsA, { name: "Agent campaign", channel: "web" })
    );
    expect(res.status).toBe(403);
  });
});

describe("unauthenticated requests", () => {
  it("GET /api/campaigns without a session → 401", async () => {
    unauthed();
    const res = await listCampaigns(req("GET", "/api/campaigns", ids.wsA));
    expect(res.status).toBe(401);
  });

  it("POST retargeting launch without a session → 401", async () => {
    unauthed();
    const res = await launchRetargeting(
      req("POST", `/api/retargeting/campaigns/${ids.rtCampaignA}/launch`, ids.wsA, {
        confirmed: true,
      }),
      { params: { id: ids.rtCampaignA } }
    );
    expect(res.status).toBe(401);
  });

  it("GET /api/billing without a session → 401", async () => {
    unauthed();
    const res = await getBilling(req("GET", "/api/billing", ids.wsA));
    expect(res.status).toBe(401);
  });
});
