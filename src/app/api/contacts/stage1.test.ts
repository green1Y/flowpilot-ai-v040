/**
 * Stage 1 — route tests: timeline assembly, contact filters, segment CRUD,
 * and tenant isolation on every new Stage 1 route.
 *
 * Auth is stubbed (same pattern as tenancy.test.ts); the DB is the vitest
 * global-setup's fresh test.db with unique records per run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { encryptCredentials } from "@/lib/integrations/meta";
import { GET as timelineGET } from "./[id]/timeline/route";
import { GET as contactsGET } from "./route";
import { POST as segmentsPOST, GET as segmentsGET } from "../contact-segments/route";
import { DELETE as segmentDELETE } from "../contact-segments/[id]/route";
import { POST as syncHistoryPOST } from "../integrations/[id]/sync-history/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  });
}

interface ReqOpts {
  method?: string;
  body?: string;
}

function req(url: string, workspaceId: string, init?: ReqOpts): NextRequest {
  return new NextRequest(url, {
    method: init?.method,
    body: init?.body,
    headers: { "x-workspace-id": workspaceId },
  });
}

// Handlers are created with handler(fn) which requires (req, ctx).
async function noParams(
  fn: (r: NextRequest, ctx: any) => Promise<Response>,
  r: NextRequest
): Promise<Response> {
  return fn(r, {});
}

const suffix = `s1${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userAId = "";
let userBId = "";
let wsA = "";
let wsB = "";
let contactBId = "";
let integrationBId = "";
const created = { users: [] as string[], workspaces: [] as string[], orgs: [] as string[] };

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  const a = await db.user.create({
    data: { email: `s1-a-${suffix}@example.com`, name: "S1 A", passwordHash: "x" },
  });
  const b = await db.user.create({
    data: { email: `s1-b-${suffix}@example.com`, name: "S1 B", passwordHash: "x" },
  });
  userAId = a.id;
  userBId = b.id;
  created.users.push(a.id, b.id);

  const orgA = await db.organization.create({ data: { name: `S1 Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `S1 Org B ${suffix}` } });
  created.orgs.push(orgA.id, orgB.id);

  const wA = await db.workspace.create({
    data: { orgId: orgA.id, name: `S1 WS A ${suffix}`, slug: `s1-a-${suffix}` },
  });
  const wB = await db.workspace.create({
    data: { orgId: orgB.id, name: `S1 WS B ${suffix}`, slug: `s1-b-${suffix}` },
  });
  wsA = wA.id;
  wsB = wB.id;
  created.workspaces.push(wA.id, wB.id);

  await db.membership.create({ data: { userId: a.id, workspaceId: wA.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: b.id, workspaceId: wB.id, role: "OWNER" } });

  // --- B's contact with rich activity ---
  const contact = await db.contact.create({
    data: {
      workspaceId: wsB,
      name: "B Contact",
      channel: "instagram",
      leadStatus: "QUALIFIED",
      tags: JSON.stringify(["vip"]),
      lastInboundAt: new Date("2026-10-16T10:00:00Z"),
    },
  });
  contactBId = contact.id;

  const conv = await db.conversation.create({
    data: { workspaceId: wsB, contactId: contact.id, channel: "instagram" },
  });
  await db.message.create({
    data: {
      conversationId: conv.id,
      direction: "INBOUND",
      body: "Real hello from B",
      mocked: false,
      createdAt: new Date("2026-10-16T10:00:00Z"),
    },
  });
  await db.message.create({
    data: {
      conversationId: conv.id,
      direction: "OUTBOUND",
      body: "Demo reply",
      mocked: true,
      createdAt: new Date("2026-10-16T11:00:00Z"),
    },
  });

  const integ = await db.integration.create({
    data: {
      workspaceId: wsB,
      provider: "instagram",
      status: "CONNECTED",
      encryptedCredentials: encryptCredentials({
        provider: "instagram",
        accessToken: "tok",
        expiresAt: null,
        pageAccessToken: "page-tok",
        igUserId: "ig-1",
      }),
    },
  });
  integrationBId = integ.id;

  await db.comment.create({
    data: {
      workspaceId: wsB,
      contactId: contact.id,
      integrationId: integ.id,
      externalId: `cmt_s1_${suffix}`,
      authorExternalId: "fbuser-1",
      authorName: "B Fan",
      mediaId: `post_${suffix}`,
      text: "Nice post!",
      commentedAt: new Date("2026-10-15T08:00:00Z"),
      privateReplyEligibleUntil: new Date("2026-10-22T08:00:00Z"),
    },
  });

  const wf = await db.workflow.create({
    data: { workspaceId: wsB, name: `S1 WF ${suffix}`, status: "PUBLISHED" },
  });
  await db.workflowExecution.create({
    data: {
      workflowId: wf.id,
      triggerEvent: JSON.stringify({ type: "message.received", contactId: contact.id }),
      status: "SUCCEEDED",
      idempotencyKey: `s1-exec-${suffix}`,
      startedAt: new Date("2026-10-16T12:00:00Z"),
    },
  });

  await db.auditEvent.create({
    data: {
      workspaceId: wsB,
      actorId: b.id,
      action: "contact.updated",
      entity: JSON.stringify({
        type: "contact",
        id: contact.id,
        leadStageChange: { from: "NEW", to: "QUALIFIED" },
      }),
      createdAt: new Date("2026-10-16T09:00:00Z"),
    },
  });
});

afterAll(async () => {
  await db.workflowExecution.deleteMany({
    where: { workflow: { workspaceId: { in: created.workspaces } } },
  });
  await db.workflow.deleteMany({ where: { workspaceId: { in: created.workspaces } } });
  await db.auditEvent.deleteMany({ where: { workspaceId: { in: created.workspaces } } });
  await db.message.deleteMany({ where: { conversation: { workspaceId: { in: created.workspaces } } } });
  await db.comment.deleteMany({ where: { workspaceId: { in: created.workspaces } } });
  await db.conversation.deleteMany({ where: { workspaceId: { in: created.workspaces } } });
  await db.contactSegment.deleteMany({ where: { workspaceId: { in: created.workspaces } } });
  await db.integration.deleteMany({ where: { workspaceId: { in: created.workspaces } } });
  await db.contact.deleteMany({ where: { workspaceId: { in: created.workspaces } } });
  await db.membership.deleteMany({ where: { workspaceId: { in: created.workspaces } } });
  await db.workspace.deleteMany({ where: { id: { in: created.workspaces } } });
  await db.organization.deleteMany({ where: { id: { in: created.orgs } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
});

describe("GET /api/contacts/[id]/timeline", () => {
  it("assembles messages, comments, workflow runs, and lead-stage changes in order", async () => {
    authedAs(userBId, `s1-b-${suffix}@example.com`);
    const res = await timelineGET(
      req(`http://localhost/api/contacts/${contactBId}/timeline`, wsB),
      { params: { id: contactBId } }
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    const items = body.data.items as Array<{
      type: string;
      at: string;
      channel?: string;
      summary: string;
      real: boolean;
    }>;

    expect(items.map((i) => i.type)).toEqual([
      "comment",
      "lead_stage",
      "message",
      "message",
      "workflow",
    ]);

    const inbound = items.find((i) => i.summary.includes("Real hello"));
    expect(inbound).toBeDefined();
    expect(inbound!.channel).toBe("instagram");
    expect(inbound!.real).toBe(true);

    const demoMsg = items.find((i) => i.summary.includes("Demo reply"));
    expect(demoMsg!.real).toBe(false);
    expect(demoMsg!.summary).toMatch(/demo/i);

    const comment = items.find((i) => i.type === "comment");
    expect(comment!.channel).toBe("instagram");
    expect(comment!.real).toBe(true);

    const wf = items.find((i) => i.type === "workflow");
    expect(wf!.summary).toContain("SUCCEEDED");

    const stage = items.find((i) => i.type === "lead_stage");
    expect(stage!.summary).toContain("NEW → QUALIFIED");
  });

  it("returns 404 for another tenant's contact (no leak)", async () => {
    authedAs(userAId, `s1-a-${suffix}@example.com`);
    const res = await timelineGET(
      req(`http://localhost/api/contacts/${contactBId}/timeline`, wsA),
      { params: { id: contactBId } }
    );
    expect(res.status).toBe(404);
    const { body } = await jsonBody(res);
    expect(body.ok).toBe(false);
  });
});

describe("GET /api/contacts filters (Stage 1)", () => {
  it("filters by leadStatus, channel, tag, and from/to date range", async () => {
    authedAs(userBId, `s1-b-${suffix}@example.com`);

    // leadStatus match
    let res = await noParams(contactsGET,
      req(`http://localhost/api/contacts?leadStatus=QUALIFIED`, wsB)
    );
    let { body } = await jsonBody(res);
    expect(body.data.items.map((c: any) => c.id)).toContain(contactBId);

    // leadStatus mismatch
    res = await noParams(contactsGET, req(`http://localhost/api/contacts?leadStatus=LOST`, wsB));
    ({ body } = await jsonBody(res));
    expect(body.data.items.map((c: any) => c.id)).not.toContain(contactBId);

    // channel + tag match
    res = await noParams(contactsGET,
      req(`http://localhost/api/contacts?channel=instagram&tag=vip`, wsB)
    );
    ({ body } = await jsonBody(res));
    expect(body.data.items.map((c: any) => c.id)).toContain(contactBId);

    // date range covering lastInboundAt (2026-10-16)
    res = await noParams(contactsGET,
      req(`http://localhost/api/contacts?from=2026-10-15&to=2026-10-17`, wsB)
    );
    ({ body } = await jsonBody(res));
    expect(body.data.items.map((c: any) => c.id)).toContain(contactBId);

    // date range excluding it
    res = await noParams(contactsGET,
      req(`http://localhost/api/contacts?from=2026-10-18&to=2026-10-20`, wsB)
    );
    ({ body } = await jsonBody(res));
    expect(body.data.items.map((c: any) => c.id)).not.toContain(contactBId);

    // legacy `status` param still works
    res = await noParams(contactsGET, req(`http://localhost/api/contacts?status=QUALIFIED`, wsB));
    ({ body } = await jsonBody(res));
    expect(body.data.items.map((c: any) => c.id)).toContain(contactBId);

    // invalid date → 422
    res = await noParams(contactsGET, req(`http://localhost/api/contacts?from=not-a-date`, wsB));
    expect(res.status).toBe(422);
  });

  it("applies a saved segment via segmentId", async () => {
    authedAs(userBId, `s1-b-${suffix}@example.com`);
    const created = await noParams(segmentsPOST,
      req(`http://localhost/api/contact-segments`, wsB, {
        method: "POST",
        body: JSON.stringify({ name: `VIP IG ${suffix}`, filters: { channel: "instagram", tag: "vip" } }),
      })
    );
    const createdBody = (await created.json()) as any;
    const segmentId = createdBody.data.id as string;

    const res = await noParams(contactsGET,
      req(`http://localhost/api/contacts?segmentId=${segmentId}`, wsB)
    );
    const { body } = await jsonBody(res);
    expect(body.data.items.map((c: any) => c.id)).toContain(contactBId);

    await segmentDELETE(
      req(`http://localhost/api/contact-segments/${segmentId}`, wsB, { method: "DELETE" }),
      { params: { id: segmentId } }
    );
  });

  it("tenant B cannot use tenant A's segment (404 on missing segment)", async () => {
    authedAs(userAId, `s1-a-${suffix}@example.com`);
    const created = await noParams(segmentsPOST,
      req(`http://localhost/api/contact-segments`, wsA, {
        method: "POST",
        body: JSON.stringify({ name: `A seg ${suffix}`, filters: {} }),
      })
    );
    const segmentId = ((await created.json()) as any).data.id as string;

    authedAs(userBId, `s1-b-${suffix}@example.com`);
    const res = await noParams(contactsGET,
      req(`http://localhost/api/contacts?segmentId=${segmentId}`, wsB)
    );
    expect(res.status).toBe(404);
  });
});

describe("contact-segments CRUD", () => {
  it("lists, creates, and deletes segments; tenant-isolated", async () => {
    authedAs(userBId, `s1-b-${suffix}@example.com`);

    const created = await noParams(segmentsPOST,
      req(`http://localhost/api/contact-segments`, wsB, {
        method: "POST",
        body: JSON.stringify({ name: `CRUD ${suffix}`, filters: { leadStatus: "NEW" } }),
      })
    );
    expect(created.status).toBe(201);
    const segmentId = ((await created.json()) as any).data.id as string;

    const listed = await segmentsGET(req(`http://localhost/api/contact-segments`, wsB), {});
    const listedBody = (await listed.json()) as any;
    expect(listedBody.data.items.map((s: any) => s.id)).toContain(segmentId);

    // Cross-tenant delete → 404 (no leak, no delete).
    authedAs(userAId, `s1-a-${suffix}@example.com`);
    const crossDelete = await segmentDELETE(
      req(`http://localhost/api/contact-segments/${segmentId}`, wsA, { method: "DELETE" }),
      { params: { id: segmentId } }
    );
    expect(crossDelete.status).toBe(404);
    expect(
      await db.contactSegment.findUnique({ where: { id: segmentId } })
    ).not.toBeNull();

    // Owner delete works.
    authedAs(userBId, `s1-b-${suffix}@example.com`);
    const deleted = await segmentDELETE(
      req(`http://localhost/api/contact-segments/${segmentId}`, wsB, { method: "DELETE" }),
      { params: { id: segmentId } }
    );
    expect(deleted.status).toBe(200);
    expect(
      await db.contactSegment.findUnique({ where: { id: segmentId } })
    ).toBeNull();

    // Validation: empty name rejected.
    const bad = await noParams(segmentsPOST,
      req(`http://localhost/api/contact-segments`, wsB, {
        method: "POST",
        body: JSON.stringify({ name: "x", filters: {} }),
      })
    );
    expect(bad.status).toBe(422);
  });
});

describe("POST /api/integrations/[id]/sync-history tenant isolation", () => {
  it("returns 404 for another tenant's integration", async () => {
    authedAs(userAId, `s1-a-${suffix}@example.com`);
    const res = await syncHistoryPOST(
      req(`http://localhost/api/integrations/${integrationBId}/sync-history`, wsA, {
        method: "POST",
      }),
      { params: { id: integrationBId } }
    );
    expect(res.status).toBe(404);
  });

  it("returns an honest no-op for WhatsApp without calling Meta", async () => {
    authedAs(userBId, `s1-b-${suffix}@example.com`);
    const wa = await db.integration.create({
      data: {
        workspaceId: wsB,
        provider: "whatsapp",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "whatsapp",
          accessToken: "wa-tok",
          expiresAt: null,
        }),
      },
    });
    const res = await syncHistoryPOST(
      req(`http://localhost/api/integrations/${wa.id}/sync-history`, wsB, {
        method: "POST",
      }),
      { params: { id: wa.id } }
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    expect(body.data.messages).toBe(0);
    expect(body.data.note).toMatch(/no history endpoint/i);
    await db.integration.delete({ where: { id: wa.id } });
  });
});
