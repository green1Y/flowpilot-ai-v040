/**
 * Stage 2 — route tests: follow-up CRUD, eligibility endpoint, templates,
 * suppressions, process-due worker, tenant isolation on every new route,
 * and the inbound engagement hook (auto-cancel + New→Contacted).
 *
 * Auth is stubbed (same pattern as stage1.test.ts); the workspace adapter
 * is mocked (no real Meta calls). DB is the fresh test.db per run.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAdapter } from "@/lib/integrations/providers";
import { ingestMetaEvent } from "@/lib/integrations/ingest";
import { GET as listGET, POST as createPOST } from "./route";
import { GET as eligibilityGET } from "./eligibility/route";
import { POST as processDuePOST } from "./process-due/route";
import { POST as cancelPOST } from "./[id]/cancel/route";
import {
  GET as templatesGET,
  POST as templatesPOST,
} from "../message-templates/route";
import { DELETE as templateDELETE } from "../message-templates/[id]/route";
import {
  GET as suppressionsGET,
  POST as suppressionsPOST,
} from "../suppressions/route";
import { DELETE as suppressionDELETE } from "../suppressions/[id]/route";

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

function noParams(fn: (r: NextRequest, ctx: any) => Promise<Response>, r: NextRequest) {
  return fn(r, {});
}
function withId(fn: (r: NextRequest, ctx: any) => Promise<Response>, r: NextRequest, id: string) {
  return fn(r, { params: { id } });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

const suffix = `rt${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userAId = "";
let userBId = "";
let wsA = "";
let wsB = "";
let contactAId = "";
let contactBId = "";

beforeAll(async () => {
  // Mocked adapter: honest mock, one successful send.
  const sendMessage = vi.fn(async () => ({ ok: true, mocked: true, externalId: "rt-ext-1" }));
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

  const a = await db.user.create({ data: { email: `rt-a-${suffix}@example.com`, name: "RT A", passwordHash: "x" } });
  const b = await db.user.create({ data: { email: `rt-b-${suffix}@example.com`, name: "RT B", passwordHash: "x" } });
  userAId = a.id;
  userBId = b.id;
  const orgA = await db.organization.create({ data: { name: `RT Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `RT Org B ${suffix}` } });
  const wA = await db.workspace.create({ data: { orgId: orgA.id, name: `RT WS A ${suffix}`, slug: `rt-a-${suffix}` } });
  const wB = await db.workspace.create({ data: { orgId: orgB.id, name: `RT WS B ${suffix}`, slug: `rt-b-${suffix}` } });
  wsA = wA.id;
  wsB = wB.id;
  await db.membership.create({ data: { userId: a.id, workspaceId: wA.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: b.id, workspaceId: wB.id, role: "OWNER" } });

  // A's contact: eligible right now (inbound 1h ago), addressable on facebook.
  const ca = await db.contact.create({
    data: {
      workspaceId: wsA,
      name: "Route Test Alice",
      channel: "facebook",
      externalIds: JSON.stringify({ PSID: `rt-psid-a-${suffix}` }),
      lastInboundAt: new Date(Date.now() - 3600_000),
    },
  });
  contactAId = ca.id;
  // B's contact in the other workspace.
  const cb = await db.contact.create({
    data: {
      workspaceId: wsB,
      name: "Route Test Bob",
      channel: "facebook",
      externalIds: JSON.stringify({ PSID: `rt-psid-b-${suffix}` }),
      lastInboundAt: new Date(),
    },
  });
  contactBId = cb.id;
});

describe("follow-ups routes", () => {
  it("POST immediate sends through the pipeline and returns the sent follow-up", async () => {
    authedAs(userAId, `rt-a-${suffix}@example.com`);
    const { status, body } = await jsonBody(
      await noParams(createPOST, req("http://x/api/follow-ups", wsA, {
        method: "POST",
        body: {
          contactId: contactAId,
          channel: "facebook",
          messageType: "freeform",
          body: "Hi {{firstName}}!",
          idempotencyKey: `rtk1-${suffix}`,
        },
      }))
    );
    expect(status).toBe(200);
    expect(body.data.followUp.status).toBe("SENT");
    expect(body.data.send.mocked).toBe(true);
    const outbound = await db.outboundSend.findUnique({
      where: { idempotencyKey: `rtk1-${suffix}` },
    });
    expect(outbound?.body).toBe("Hi Route!"); // {{firstName}} of "Route Test Alice"
  });

  it("POST retry with the same idempotency key returns the existing follow-up", async () => {
    authedAs(userAId, `rt-a-${suffix}@example.com`);
    const mk = () =>
      noParams(createPOST, req("http://x/api/follow-ups", wsA, {
        method: "POST",
        body: {
          contactId: contactAId,
          channel: "facebook",
          messageType: "freeform",
          body: "dup",
          idempotencyKey: `rtk-dup-${suffix}`,
        },
      }));
    const first = await jsonBody(await mk());
    const second = await jsonBody(await mk());
    expect(first.body.data.followUp.id).toBe(second.body.data.followUp.id);
    expect(second.body.data.duplicate).toBe(true);
    const sends = await db.outboundSend.count({
      where: { idempotencyKey: `rtk-dup-${suffix}` },
    });
    expect(sends).toBe(1);
  });

  it("POST scheduled creates a SCHEDULED row without sending", async () => {
    authedAs(userAId, `rt-a-${suffix}@example.com`);
    const { status, body } = await jsonBody(
      await noParams(createPOST, req("http://x/api/follow-ups", wsA, {
        method: "POST",
        body: {
          contactId: contactAId,
          channel: "facebook",
          messageType: "freeform",
          body: "later",
          scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
          idempotencyKey: `rtk-sched-${suffix}`,
        },
      }))
    );
    expect(status).toBe(201);
    expect(body.data.followUp.status).toBe("SCHEDULED");
    const outbound = await db.outboundSend.findUnique({
      where: { idempotencyKey: `rtk-sched-${suffix}` },
    });
    expect(outbound).toBeNull(); // nothing attempted yet
  });

  it("GET lists only the caller's workspace (tenant isolation)", async () => {
    authedAs(userBId, `rt-b-${suffix}@example.com`);
    const { status, body } = await jsonBody(
      await noParams(listGET, req("http://x/api/follow-ups", wsB))
    );
    expect(status).toBe(200);
    const ids: string[] = body.data.items.map((i: any) => i.contactId);
    expect(ids).not.toContain(contactAId);
  });

  it("POST rejects a contact from another workspace (404)", async () => {
    authedAs(userBId, `rt-b-${suffix}@example.com`);
    const { status } = await jsonBody(
      await noParams(createPOST, req("http://x/api/follow-ups", wsB, {
        method: "POST",
        body: { contactId: contactAId, channel: "facebook", messageType: "freeform", body: "x" },
      }))
    );
    expect(status).toBe(404);
  });

  it("cancel moves SCHEDULED → CANCELLED, then rejects a second cancel", async () => {
    authedAs(userAId, `rt-a-${suffix}@example.com`);
    const created = await jsonBody(
      await noParams(createPOST, req("http://x/api/follow-ups", wsA, {
        method: "POST",
        body: {
          contactId: contactAId,
          channel: "facebook",
          messageType: "freeform",
          body: "to cancel",
          scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
          idempotencyKey: `rtk-cancel-${suffix}`,
        },
      }))
    );
    const id = created.body.data.followUp.id;
    const first = await jsonBody(
      await withId(cancelPOST, req(`http://x/api/follow-ups/${id}/cancel`, wsA, { method: "POST", body: {} }), id)
    );
    expect(first.body.data.followUp.status).toBe("CANCELLED");
    const second = await jsonBody(
      await withId(cancelPOST, req(`http://x/api/follow-ups/${id}/cancel`, wsA, { method: "POST", body: {} }), id)
    );
    expect(second.status).toBe(422);
    const audit = await db.auditEvent.findFirst({
      where: { workspaceId: wsA, action: "followup.cancelled" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  it("process-due sends due follow-ups for the caller's workspace only", async () => {
    authedAs(userAId, `rt-a-${suffix}@example.com`);
    const fu = await db.followUp.create({
      data: {
        workspaceId: wsA,
        contactId: contactAId,
        channel: "facebook",
        messageType: "freeform",
        body: "due via worker",
        scheduledAt: new Date(Date.now() - 1000),
        status: "SCHEDULED",
        idempotencyKey: `rtk-due-${suffix}`,
      },
    });
    const { status, body } = await jsonBody(
      await noParams(processDuePOST, req("http://x/api/follow-ups/process-due", wsA, { method: "POST", body: {} }))
    );
    expect(status).toBe(200);
    expect(body.data.processed).toBeGreaterThanOrEqual(1);
    const updated = await db.followUp.findUnique({ where: { id: fu.id } });
    expect(updated?.status).toBe("SENT");
  });
});

describe("eligibility route", () => {
  it("returns ineligible for a lapsed window, eligible after fresh inbound", async () => {
    authedAs(userAId, `rt-a-${suffix}@example.com`);
    const stale = await db.contact.create({
      data: {
        workspaceId: wsA,
        name: "Stale Sam",
        channel: "facebook",
        lastInboundAt: new Date(Date.now() - 30 * 3600_000),
      },
    });
    const before = await jsonBody(
      await noParams(eligibilityGET, req(
        `http://x/api/follow-ups/eligibility?contactId=${stale.id}&channel=facebook&messageType=freeform`,
        wsA
      ))
    );
    expect(before.status).toBe(200);
    expect(before.body.data.eligible).toBe(false);
    expect(before.body.data.ineligibleReasons.join(" ")).toContain("24-hour");

    await db.contact.update({
      where: { id: stale.id },
      data: { lastInboundAt: new Date() },
    });
    const after = await jsonBody(
      await noParams(eligibilityGET, req(
        `http://x/api/follow-ups/eligibility?contactId=${stale.id}&channel=facebook&messageType=freeform`,
        wsA
      ))
    );
    expect(after.body.data.eligible).toBe(true);
  });

  it("404s for another workspace's contact", async () => {
    authedAs(userBId, `rt-b-${suffix}@example.com`);
    const { status } = await jsonBody(
      await noParams(eligibilityGET, req(
        `http://x/api/follow-ups/eligibility?contactId=${contactAId}&channel=facebook&messageType=freeform`,
        wsB
      ))
    );
    expect(status).toBe(404);
  });
});

describe("message templates", () => {
  it("CRUD: create → duplicate 409 → list → delete", async () => {
    authedAs(userAId, `rt-a-${suffix}@example.com`);
    const created = await jsonBody(
      await noParams(templatesPOST, req("http://x/api/message-templates", wsA, {
        method: "POST",
        body: { name: `Hello ${suffix}`, channel: "whatsapp", body: "Hi {{firstName}}!" },
      }))
    );
    expect(created.status).toBe(201);
    const id = created.body.data.template.id;

    const dup = await jsonBody(
      await noParams(templatesPOST, req("http://x/api/message-templates", wsA, {
        method: "POST",
        body: { name: `Hello ${suffix}`, channel: "whatsapp", body: "other" },
      }))
    );
    expect(dup.status).toBe(409);

    const listed = await jsonBody(
      await noParams(templatesGET, req("http://x/api/message-templates?channel=whatsapp", wsA))
    );
    expect(listed.body.data.items.some((t: any) => t.id === id)).toBe(true);

    const deleted = await jsonBody(
      await withId(templateDELETE, req(`http://x/api/message-templates/${id}`, wsA, { method: "DELETE" }), id)
    );
    expect(deleted.body.data.deleted).toBe(id);

    // B cannot see A's templates.
    authedAs(userBId, `rt-b-${suffix}@example.com`);
    const other = await jsonBody(
      await noParams(templatesGET, req("http://x/api/message-templates", wsB))
    );
    expect(other.body.data.items.some((t: any) => t.id === id)).toBe(false);
  });
});

describe("suppressions", () => {
  it("create → blocks sends → delete → unblocks", async () => {
    authedAs(userAId, `rt-a-${suffix}@example.com`);
    const created = await jsonBody(
      await noParams(suppressionsPOST, req("http://x/api/suppressions", wsA, {
        method: "POST",
        body: { contactId: contactAId, reason: "test opt-out" },
      }))
    );
    expect(created.status).toBe(201);
    const id = created.body.data.suppression.id;

    const verdict = await jsonBody(
      await noParams(eligibilityGET, req(
        `http://x/api/follow-ups/eligibility?contactId=${contactAId}&channel=facebook&messageType=freeform`,
        wsA
      ))
    );
    expect(verdict.body.data.suppressed).toBe(true);
    expect(verdict.body.data.eligible).toBe(false);

    // Blocked send: 422 + SKIPPED.
    const blocked = await jsonBody(
      await noParams(createPOST, req("http://x/api/follow-ups", wsA, {
        method: "POST",
        body: {
          contactId: contactAId,
          channel: "facebook",
          messageType: "freeform",
          body: "should not send",
          idempotencyKey: `rtk-blocked-${suffix}`,
        },
      }))
    );
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toContain("suppressed");

    const deleted = await jsonBody(
      await withId(suppressionDELETE, req(`http://x/api/suppressions/${id}`, wsA, { method: "DELETE" }), id)
    );
    expect(deleted.body.data.deleted).toBe(id);

    const verdict2 = await jsonBody(
      await noParams(eligibilityGET, req(
        `http://x/api/follow-ups/eligibility?contactId=${contactAId}&channel=facebook&messageType=freeform`,
        wsA
      ))
    );
    expect(verdict2.body.data.suppressed).toBe(false);
  });

  it("cannot delete another workspace's suppression", async () => {
    authedAs(userAId, `rt-a-${suffix}@example.com`);
    const created = await jsonBody(
      await noParams(suppressionsPOST, req("http://x/api/suppressions", wsA, {
        method: "POST",
        body: { contactId: contactAId },
      }))
    );
    const id = created.body.data.suppression.id;
    authedAs(userBId, `rt-b-${suffix}@example.com`);
    const { status } = await jsonBody(
      await withId(suppressionDELETE, req(`http://x/api/suppressions/${id}`, wsB, { method: "DELETE" }), id)
    );
    expect(status).toBe(404);
    // Cleanup in the owning workspace.
    authedAs(userAId, `rt-a-${suffix}@example.com`);
    await withId(suppressionDELETE, req(`http://x/api/suppressions/${id}`, wsA, { method: "DELETE" }), id);
  });
});

describe("inbound engagement hook", () => {
  it("an inbound reply cancels scheduled follow-ups and advances New → Contacted", async () => {
    const psid = `rt-hook-psid-${suffix}`;
    const contact = await db.contact.create({
      data: {
        workspaceId: wsA,
        name: "Hook Holly",
        channel: "facebook",
        leadStatus: "NEW",
        externalIds: JSON.stringify({ PSID: psid }),
      },
    });
    const fu = await db.followUp.create({
      data: {
        workspaceId: wsA,
        contactId: contact.id,
        channel: "facebook",
        messageType: "freeform",
        body: "nudge",
        scheduledAt: new Date(Date.now() + 3600_000),
        status: "SCHEDULED",
        idempotencyKey: `rtk-hook-${suffix}`,
      },
    });
    const integ = await db.integration.create({
      data: { workspaceId: wsA, provider: "facebook", status: "CONNECTED" },
    });

    const { messages } = await ingestMetaEvent(
      { id: integ.id, workspaceId: wsA, provider: "facebook" },
      {
        messaging: [
          {
            sender: { id: psid },
            message: { mid: `mid-hook-${suffix}`, text: "hey, I'm interested" },
            timestamp: Math.floor(Date.now() / 1000),
          },
        ],
      }
    );
    expect(messages).toBe(1);

    const updatedFu = await db.followUp.findUnique({ where: { id: fu.id } });
    expect(updatedFu?.status).toBe("CANCELLED");
    expect(updatedFu?.cancelReason).toBe("contact replied");

    const updatedContact = await db.contact.findUnique({ where: { id: contact.id } });
    expect(updatedContact?.leadStatus).toBe("CONTACTED");

    const cancelled = await db.auditEvent.findFirst({
      where: { workspaceId: wsA, action: "followup.auto_cancelled" },
      orderBy: { createdAt: "desc" },
    });
    expect(cancelled).not.toBeNull();
    const staged = await db.auditEvent.findFirst({
      where: { workspaceId: wsA, action: "contact.stage_changed" },
      orderBy: { createdAt: "desc" },
    });
    expect(staged).not.toBeNull();
  });
});
