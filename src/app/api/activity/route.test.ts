/**
 * GET /api/activity — Activity / Error Center feed (Batch C §7.21).
 *
 * Seeds two workspaces plus an empty one and asserts: workspace A sees
 * exactly its own failed execution, failed send, and attention-needing
 * integration — merged newest-first with the right kinds/hrefs; workspace
 * B's failures never leak into A; an empty workspace returns []; and a
 * non-member is denied exactly like sibling routes (403 via requireWorkspace).
 *
 * Auth is stubbed (same harness pattern as stage4d.test.ts); DB is the
 * fresh test.db per run.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET as activityGET } from "@/app/api/activity/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  } as any);
}

function req(workspaceId: string): NextRequest {
  return new NextRequest("http://x/api/activity", {
    method: "GET",
    headers: { "x-workspace-id": workspaceId },
  });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

const suffix = `act${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userAId = "";
let userBId = "";
let wsA = "";
let wsB = "";
let wsEmpty = "";
let workflowAId = "";

const NOW = Date.now();
const T_INTEGRATION = new Date(NOW - 30 * 60_000); // newest
const T_EXECUTION = new Date(NOW - 60 * 60_000);
const T_SEND = new Date(NOW - 180 * 60_000); // oldest

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: `Act Org ${suffix}` } });
  const userA = await db.user.create({
    data: { email: `act-a-${suffix}@example.com`, name: "Act A", passwordHash: "x" },
  });
  const userB = await db.user.create({
    data: { email: `act-b-${suffix}@example.com`, name: "Act B", passwordHash: "x" },
  });
  userAId = userA.id;
  userBId = userB.id;

  const mkWs = async (name: string, userId: string) => {
    const w = await db.workspace.create({
      data: { orgId: org.id, name, slug: `${name}-${suffix}` },
    });
    await db.membership.create({ data: { userId, workspaceId: w.id, role: "OWNER" } });
    return w.id;
  };
  wsA = await mkWs(`act-ws-a`, userAId);
  wsB = await mkWs(`act-ws-b`, userBId);
  wsEmpty = await mkWs(`act-ws-empty`, userAId);

  /* ---- Workspace A: one item of each kind ---- */

  const workflow = await db.workflow.create({
    data: { workspaceId: wsA, name: `Welcome Flow ${suffix}`, status: "PUBLISHED" },
  });
  workflowAId = workflow.id;
  await db.workflowExecution.create({
    data: {
      workflowId: workflow.id,
      status: "FAILED",
      error: "Node send_message exploded while rendering the template",
      idempotencyKey: `act-exec-a-${suffix}`,
      startedAt: new Date(T_EXECUTION.getTime() - 5_000),
      finishedAt: T_EXECUTION,
    },
  });
  // Decoy: a successful execution must never appear.
  await db.workflowExecution.create({
    data: {
      workflowId: workflow.id,
      status: "SUCCEEDED",
      idempotencyKey: `act-exec-a-ok-${suffix}`,
      startedAt: new Date(NOW - 10 * 60_000),
      finishedAt: new Date(NOW - 9 * 60_000),
    },
  });

  const contactA = await db.contact.create({
    data: { workspaceId: wsA, name: `Act Eve ${suffix}`, channel: "whatsapp" },
  });
  await db.outboundSend.create({
    data: {
      workspaceId: wsA,
      contactId: contactA.id,
      channel: "whatsapp",
      messageType: "freeform",
      body: "hello",
      idempotencyKey: `act-send-a-${suffix}`,
      status: "FAILED",
      error: "Meta error 130429: rate limit reached",
      createdAt: T_SEND,
    },
  });
  // Decoy: a successful send must never appear.
  await db.outboundSend.create({
    data: {
      workspaceId: wsA,
      contactId: contactA.id,
      channel: "whatsapp",
      messageType: "freeform",
      body: "hello again",
      idempotencyKey: `act-send-a-ok-${suffix}`,
      status: "SENT",
      createdAt: new Date(NOW - 5 * 60_000),
    },
  });

  await db.integration.create({
    data: {
      workspaceId: wsA,
      provider: "whatsapp",
      status: "NEEDS_ATTENTION",
      accountName: "Acme WA",
      lastError: "Access token expired",
      lastErrorAt: T_INTEGRATION,
    },
  });
  // Decoy: a healthy integration with a non-error statusDetail is excluded.
  await db.integration.create({
    data: {
      workspaceId: wsA,
      provider: "instagram",
      status: "CONNECTED",
      accountName: "Acme IG",
      statusDetail: JSON.stringify({ code: "verified", message: "All good", at: new Date(NOW).toISOString() }),
    },
  });

  /* ---- Workspace B: its own failed send (must never leak into A) ---- */

  const contactB = await db.contact.create({
    data: { workspaceId: wsB, name: `Act Eve B ${suffix}`, channel: "instagram" },
  });
  await db.outboundSend.create({
    data: {
      workspaceId: wsB,
      contactId: contactB.id,
      channel: "instagram",
      messageType: "freeform",
      body: "hi from B",
      idempotencyKey: `act-send-b-${suffix}`,
      status: "FAILED",
      error: "B-only failure",
      createdAt: new Date(NOW - 15 * 60_000),
    },
  });
});

describe("GET /api/activity", () => {
  it("returns exactly workspace A's 3 failures, newest first, with kinds and hrefs", async () => {
    authedAs(userAId, `act-a-${suffix}@example.com`);
    const { status, body } = await jsonBody(await activityGET(req(wsA)));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const items = body.data.items as any[];
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.kind)).toEqual(["integration", "workflow_execution", "outbound_send"]);

    const [integration, execution, send] = items;
    expect(integration.title).toContain("whatsapp");
    expect(integration.title).toContain("Acme WA");
    expect(integration.detail).toBe("Access token expired");
    expect(integration.at).toBe(T_INTEGRATION.toISOString());
    expect(integration.href).toBe("/app/integrations");

    expect(execution.title).toBe(`Welcome Flow ${suffix} execution failed`);
    expect(execution.detail).toContain("exploded");
    expect(execution.at).toBe(T_EXECUTION.toISOString());
    expect(execution.href).toBe(`/app/automations/${workflowAId}/executions`);

    expect(send.title).toContain("whatsapp");
    expect(send.detail).toBe("Meta error 130429: rate limit reached");
    expect(send.at).toBe(T_SEND.toISOString());
    expect(send.href).toBe("/app/inbox");

    // Workspace B's failure never leaks in.
    expect(items.some((i) => i.detail === "B-only failure")).toBe(false);
  });

  it("workspace B sees only its own failure", async () => {
    authedAs(userBId, `act-b-${suffix}@example.com`);
    const { status, body } = await jsonBody(await activityGET(req(wsB)));
    expect(status).toBe(200);
    const items = body.data.items as any[];
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("outbound_send");
    expect(items[0].detail).toBe("B-only failure");
  });

  it("an empty workspace returns an empty list", async () => {
    authedAs(userAId, `act-a-${suffix}@example.com`);
    const { status, body } = await jsonBody(await activityGET(req(wsEmpty)));
    expect(status).toBe(200);
    expect(body.data.items).toEqual([]);
  });

  it("a non-member gets 403, consistent with sibling routes", async () => {
    authedAs(userBId, `act-b-${suffix}@example.com`);
    const { status, body } = await jsonBody(await activityGET(req(wsA)));
    expect(status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
  });
});
