/**
 * Stage 4a — inbox hardening route tests: PATCH conversation (assignment /
 * priority / takeover with audit), internal notes, typing presence + expiry,
 * and tenant isolation on every new route.
 *
 * Auth is stubbed (same pattern as tenancy.test.ts); the DB is the vitest
 * global-setup's fresh test.db with unique records per run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET as conversationsGET } from "./route";
import { GET as conversationGET, PATCH as conversationPATCH } from "./[id]/route";
import { POST as notesPOST } from "./[id]/notes/route";
import { POST as typingPOST } from "./[id]/typing/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  });
}

function req(url: string, workspaceId: string, init?: { method?: string; body?: string }): NextRequest {
  return new NextRequest(url, {
    method: init?.method,
    body: init?.body,
    headers: { "x-workspace-id": workspaceId, "Content-Type": "application/json" },
  });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

const suffix = `s4a${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userAId = "";
let userBId = "";
let wsA = "";
let wsB = "";
let convoAId = "";
let convoBId = "";
const orgNames: string[] = [];

async function makeOrgWorkspace(tag: string) {
  const name = `S4A Org ${tag} ${suffix}`;
  orgNames.push(name);
  const org = await db.organization.create({ data: { name } });
  return db.workspace.create({
    data: { orgId: org.id, name: `S4A WS ${tag} ${suffix}`, slug: `s4a-${tag}-${suffix}` },
  });
}

beforeAll(async () => {
  const a = await db.user.create({ data: { email: `s4a-a-${suffix}@example.com`, name: "S4A A", passwordHash: "x" } });
  const b = await db.user.create({ data: { email: `s4a-b-${suffix}@example.com`, name: "S4A B", passwordHash: "x" } });
  userAId = a.id;
  userBId = b.id;
  const wa = await makeOrgWorkspace("a");
  const wb = await makeOrgWorkspace("b");
  wsA = wa.id;
  wsB = wb.id;
  await db.membership.create({ data: { userId: userAId, workspaceId: wsA, role: "OWNER" } });
  await db.membership.create({ data: { userId: userBId, workspaceId: wsB, role: "OWNER" } });

  for (const [wsId, tag] of [[wsA, "a"], [wsB, "b"]] as const) {
    const contact = await db.contact.create({ data: { workspaceId: wsId, name: `S4A Contact ${tag}`, channel: "webchat" } });
    const convo = await db.conversation.create({
      data: { workspaceId: wsId, contactId: contact.id, channel: "webchat", status: "OPEN" },
    });
    if (tag === "a") convoAId = convo.id;
    else convoBId = convo.id;
  }
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { name: { in: orgNames } } });
  await db.user.deleteMany({ where: { email: { contains: suffix } } });
  await db.$disconnect();
});

describe("PATCH /api/conversations/[id]", () => {
  it("updates priority (lowercase normalized), assignment and takeover, auditing each change", async () => {
    authedAs(userAId, `s4a-a-${suffix}@example.com`);
    const res = await conversationPATCH(
      req(`http://x/api/conversations/${convoAId}`, wsA, {
        method: "PATCH",
        body: JSON.stringify({ priority: "high", assignedTo: userAId, humanTakeover: true }),
      }),
      { params: { id: convoAId } }
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    expect(body.data.conversation.priority).toBe("HIGH");
    expect(body.data.conversation.assignedTo).toBe(userAId);
    expect(body.data.conversation.humanTakeover).toBe(true);

    // One audit event per changed field.
    const audits = await db.auditEvent.findMany({
      where: { workspaceId: wsA, entity: { contains: convoAId } },
      orderBy: { createdAt: "desc" },
    });
    const actions = audits.map((x) => x.action);
    expect(actions).toContain("conversation.priority");
    expect(actions).toContain("conversation.assignedTo");
    expect(actions).toContain("conversation.humanTakeover");
    const priorityAudit = audits.find((x) => x.action === "conversation.priority");
    expect(priorityAudit?.entity).toContain('"before":"NORMAL"');
    expect(priorityAudit?.entity).toContain('"after":"HIGH"');
  });

  it("clears assignment with null and rejects bad priority / empty bodies", async () => {
    authedAs(userAId, `s4a-a-${suffix}@example.com`);
    const cleared = await conversationPATCH(
      req(`http://x/api/conversations/${convoAId}`, wsA, {
        method: "PATCH",
        body: JSON.stringify({ assignedTo: null }),
      }),
      { params: { id: convoAId } }
    );
    expect((await jsonBody(cleared)).body.data.conversation.assignedTo).toBeNull();

    const bad = await conversationPATCH(
      req(`http://x/api/conversations/${convoAId}`, wsA, {
        method: "PATCH",
        body: JSON.stringify({ priority: "extreme" }),
      }),
      { params: { id: convoAId } }
    );
    expect(bad.status).toBe(422);

    const empty = await conversationPATCH(
      req(`http://x/api/conversations/${convoAId}`, wsA, { method: "PATCH", body: JSON.stringify({}) }),
      { params: { id: convoAId } }
    );
    expect(empty.status).toBe(422);
  });

  it("is tenant-isolated: wsB's conversation is invisible from wsA", async () => {
    authedAs(userAId, `s4a-a-${suffix}@example.com`);
    const res = await conversationPATCH(
      req(`http://x/api/conversations/${convoBId}`, wsA, {
        method: "PATCH",
        body: JSON.stringify({ priority: "low" }),
      }),
      { params: { id: convoBId } }
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/conversations/[id]/notes", () => {
  it("creates an internal note that never touches send paths", async () => {
    authedAs(userAId, `s4a-a-${suffix}@example.com`);
    const sendsBefore = await db.outboundSend.count({ where: { workspaceId: wsA } });
    const res = await notesPOST(
      req(`http://x/api/conversations/${convoAId}/notes`, wsA, {
        method: "POST",
        body: JSON.stringify({ body: "Agent note: customer seems frustrated" }),
      }),
      { params: { id: convoAId } }
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(201);
    const note = body.data.note;
    expect(note.direction).toBe("INTERNAL_NOTE");
    expect(note.internalNote).toBe(true);
    expect(note.mocked).toBe(false);

    // No outbound send record was created for the note.
    const sendsAfter = await db.outboundSend.count({ where: { workspaceId: wsA } });
    expect(sendsAfter).toBe(sendsBefore);

    // Audit logged.
    const audit = await db.auditEvent.findFirst({
      where: { workspaceId: wsA, action: "note.created" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.entity).toContain(convoAId);
  });

  it("rejects empty bodies and is tenant-isolated", async () => {
    authedAs(userAId, `s4a-a-${suffix}@example.com`);
    const empty = await notesPOST(
      req(`http://x/api/conversations/${convoAId}/notes`, wsA, {
        method: "POST",
        body: JSON.stringify({ body: "" }),
      }),
      { params: { id: convoAId } }
    );
    expect(empty.status).toBe(422);

    const foreign = await notesPOST(
      req(`http://x/api/conversations/${convoBId}/notes`, wsA, {
        method: "POST",
        body: JSON.stringify({ body: "sneaky note" }),
      }),
      { params: { id: convoBId } }
    );
    expect(foreign.status).toBe(404);
  });
});

describe("POST /api/conversations/[id]/typing", () => {
  it("sets and clears typing presence", async () => {
    authedAs(userAId, `s4a-a-${suffix}@example.com`);
    const set = await typingPOST(
      req(`http://x/api/conversations/${convoAId}/typing`, wsA, {
        method: "POST",
        body: JSON.stringify({ active: true }),
      }),
      { params: { id: convoAId } }
    );
    const { body: setBody } = await jsonBody(set);
    expect(setBody.data.composingBy).toBe(userAId);
    expect(setBody.data.fresh).toBe(true);

    const cleared = await typingPOST(
      req(`http://x/api/conversations/${convoAId}/typing`, wsA, {
        method: "POST",
        body: JSON.stringify({ active: false }),
      }),
      { params: { id: convoAId } }
    );
    const { body: clearedBody } = await jsonBody(cleared);
    expect(clearedBody.data.composingBy).toBeNull();
  });

  it("expires stale presence lazily on conversation read", async () => {
    authedAs(userAId, `s4a-a-${suffix}@example.com`);
    // Backdate presence past the 90s TTL.
    await db.conversation.update({
      where: { id: convoAId },
      data: { composingBy: userAId, composingAt: new Date(Date.now() - 120_000) },
    });
    const res = await conversationGET(req(`http://x/api/conversations/${convoAId}`, wsA), {
      params: { id: convoAId },
    });
    const { body } = await jsonBody(res);
    expect(body.data.conversation.composingBy).toBeNull();
    expect(body.data.conversation.composingAt).toBeNull();
  });

  it("is tenant-isolated", async () => {
    authedAs(userAId, `s4a-a-${suffix}@example.com`);
    const res = await typingPOST(
      req(`http://x/api/conversations/${convoBId}/typing`, wsA, {
        method: "POST",
        body: JSON.stringify({ active: true }),
      }),
      { params: { id: convoBId } }
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/conversations (list)", () => {
  it("exposes the 4a fields and expires stale typing in bulk", async () => {
    authedAs(userAId, `s4a-a-${suffix}@example.com`);
    await db.conversation.update({
      where: { id: convoAId },
      data: { composingBy: userAId, composingAt: new Date(Date.now() - 120_000) },
    });
    const res = await conversationsGET(req("http://x/api/conversations", wsA), {});
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    const item = body.data.items.find((c: any) => c.id === convoAId);
    expect(item).toBeDefined();
    expect("humanTakeover" in item).toBe(true);
    expect("composingBy" in item).toBe(true);
    expect("composingAt" in item).toBe(true);
    // Stale presence was cleared by the lazy expiry.
    expect(item.composingBy).toBeNull();
  });
});
