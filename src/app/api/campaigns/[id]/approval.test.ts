/**
 * Wave 2D: campaign approval lifecycle + the surgical start gate.
 * Three start states: PENDING → 409 APPROVAL_PENDING; latest REJECTED →
 * 409 APPROVAL_REJECTED; APPROVED or no request → starts exactly as before.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { POST as requestPOST } from "./request-approval/route";
import { POST as approvePOST } from "./approve/route";
import { POST as startPOST } from "./start/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `w2d-ap${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let ws = "";
let contactId = "";

function req(url: string, workspaceId: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? "POST",
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: { "x-workspace-id": workspaceId, "content-type": "application/json" },
  });
}
async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}
const withId = (fn: (r: NextRequest, ctx: any) => Promise<Response>, r: NextRequest, id: string) =>
  fn(r, { params: { id } });

async function mkCampaign() {
  const c = await db.campaign.create({
    data: {
      workspaceId: ws,
      name: `W2D Approval ${suffix}-${Math.floor(Math.random() * 1_000_000)}`,
      channel: "facebook",
      status: "DRAFT",
      audience: JSON.stringify({ type: "all" }),
      message: JSON.stringify({ text: "Hi" }),
      messageType: "freeform",
      ratePerSecond: 50,
    },
  });
  await db.campaignRecipient.create({
    data: {
      campaignId: c.id,
      contactId,
      status: "PENDING",
      idempotencyKey: `campaign:${c.id}:contact:${contactId}`,
    },
  });
  return c.id;
}

beforeAll(async () => {
  mockedRequireUser.mockImplementation(async () => ({ userId, email: "w2d@example.com", user: { id: userId } }) as any);
  const u = await db.user.create({ data: { email: `w2d-ap-${suffix}@example.com`, name: "W2D", passwordHash: "x" } });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `W2D AP Org ${suffix}` } });
  const w = await db.workspace.create({ data: { orgId: org.id, name: `W2D AP ${suffix}`, slug: `w2d-ap-${suffix}` } });
  ws = w.id;
  await db.membership.create({ data: { userId, workspaceId: ws, role: "OWNER" } });
  const contact = await db.contact.create({ data: { workspaceId: ws, name: "Approval Contact", channel: "facebook" } });
  contactId = contact.id;
});

describe("campaign approval", () => {
  it("request creates PENDING; a second request while PENDING is 409", async () => {
    const id = await mkCampaign();
    const first = await jsonBody(await withId(requestPOST, req("http://x/api/campaigns/x/request-approval", ws), id));
    expect(first.status).toBe(201);
    expect(first.body.data.approval.status).toBe("PENDING");
    const second = await jsonBody(await withId(requestPOST, req("http://x/api/campaigns/x/request-approval", ws), id));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("APPROVAL_ALREADY_PENDING");
  });

  it("start with PENDING approval is 409 APPROVAL_PENDING", async () => {
    const id = await mkCampaign();
    await withId(requestPOST, req("http://x/api/campaigns/x/request-approval", ws), id);
    const res = await jsonBody(await withId(startPOST, req("http://x/api/campaigns/x/start", ws), id));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("APPROVAL_PENDING");
  });

  it("approve with no pending request is 409; invalid decision is 422", async () => {
    const id = await mkCampaign();
    const none = await jsonBody(await withId(approvePOST, req("http://x/api/campaigns/x/approve", ws, { body: { decision: "APPROVED" } }), id));
    expect(none.status).toBe(409);
    expect(none.body.code).toBe("NO_PENDING_APPROVAL");
    await withId(requestPOST, req("http://x/api/campaigns/x/request-approval", ws), id);
    const bad = await jsonBody(await withId(approvePOST, req("http://x/api/campaigns/x/approve", ws, { body: { decision: "MAYBE" } }), id));
    expect(bad.status).toBe(422);
  });

  it("REJECTED decision blocks start with 409 APPROVAL_REJECTED", async () => {
    const id = await mkCampaign();
    await withId(requestPOST, req("http://x/api/campaigns/x/request-approval", ws), id);
    const dec = await jsonBody(await withId(approvePOST, req("http://x/api/campaigns/x/approve", ws, { body: { decision: "REJECTED", note: "Not yet" } }), id));
    expect(dec.status).toBe(200);
    expect(dec.body.data.approval.status).toBe("REJECTED");
    expect(dec.body.data.approval.decidedBy).toBe(userId);
    expect(dec.body.data.approval.decidedAt).toBeTruthy();
    const res = await jsonBody(await withId(startPOST, req("http://x/api/campaigns/x/start", ws), id));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("APPROVAL_REJECTED");
  });

  it("after REJECTED, a new request + APPROVED unblocks start", async () => {
    const id = await mkCampaign();
    await withId(requestPOST, req("http://x/api/campaigns/x/request-approval", ws), id);
    await withId(approvePOST, req("http://x/api/campaigns/x/approve", ws, { body: { decision: "REJECTED" } }), id);
    const again = await jsonBody(await withId(requestPOST, req("http://x/api/campaigns/x/request-approval", ws), id));
    expect(again.status).toBe(201);
    const dec = await jsonBody(await withId(approvePOST, req("http://x/api/campaigns/x/approve", ws, { body: { decision: "APPROVED" } }), id));
    expect(dec.body.data.approval.status).toBe("APPROVED");
    const res = await jsonBody(await withId(startPOST, req("http://x/api/campaigns/x/start", ws), id));
    expect(res.status).toBe(200);
    expect(res.body.data.campaign.status).toBe("RUNNING");
  });

  it("a campaign with no approval request starts exactly as before", async () => {
    const id = await mkCampaign();
    const res = await jsonBody(await withId(startPOST, req("http://x/api/campaigns/x/start", ws), id));
    expect(res.status).toBe(200);
    expect(res.body.data.campaign.status).toBe("RUNNING");
  });

  it("approval on a missing campaign is 404", async () => {
    const res = await jsonBody(await withId(requestPOST, req("http://x/api/campaigns/x/request-approval", ws), "nonexistent-id"));
    expect(res.status).toBe(404);
  });
});
