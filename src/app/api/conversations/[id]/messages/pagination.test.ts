/**
 * Perf workstream — GET /api/conversations/[id]/messages pagination.
 *
 * Guards the cursor-pagination contract added for long threads:
 * default returns the most recent `limit` messages in ascending order,
 * `?before=<messageId>` pages into older history, and `hasMore` signals
 * whether older messages exist. Response stays tenant-isolated.
 *
 * Auth is stubbed (same pattern as stage4a.test.ts); the DB is the vitest
 * global-setup's fresh test.db with unique records per run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET as messagesGET } from "./route";

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
  return new NextRequest(url, {
    headers: { "x-workspace-id": workspaceId, "Content-Type": "application/json" },
  });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

const suffix = `msgpg${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let wsId = "";
let otherWsId = "";
let convoId = "";
let otherConvoId = "";
const messageIds: string[] = [];
const orgNames: string[] = [];

async function makeWorkspace(tag: string) {
  const name = `MsgPg Org ${tag} ${suffix}`;
  orgNames.push(name);
  const org = await db.organization.create({ data: { name } });
  return db.workspace.create({
    data: { orgId: org.id, name: `MsgPg WS ${tag} ${suffix}`, slug: `msgpg-${tag}-${suffix}` },
  });
}

beforeAll(async () => {
  const u = await db.user.create({
    data: { email: `msgpg-${suffix}@example.com`, name: "MsgPg", passwordHash: "x" },
  });
  userId = u.id;
  const wa = await makeWorkspace("a");
  const wb = await makeWorkspace("b");
  wsId = wa.id;
  otherWsId = wb.id;
  await db.membership.create({ data: { userId, workspaceId: wsId, role: "OWNER" } });

  const mkConvo = async (ws: string) => {
    const contact = await db.contact.create({
      data: { workspaceId: ws, name: `MsgPg Contact ${suffix}`, channel: "webchat" },
    });
    const convo = await db.conversation.create({
      data: { workspaceId: ws, contactId: contact.id, channel: "webchat", status: "OPEN" },
    });
    return convo.id;
  };
  convoId = await mkConvo(wsId);
  otherConvoId = await mkConvo(otherWsId);

  // 5 messages, 1s apart, deterministic order.
  const base = Date.now() - 60_000;
  for (let i = 0; i < 5; i++) {
    const m = await db.message.create({
      data: {
        conversationId: convoId,
        direction: i % 2 === 0 ? "INBOUND" : "OUTBOUND",
        body: `msg ${i}`,
        createdAt: new Date(base + i * 1000),
      },
    });
    messageIds.push(m.id);
  }
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { name: { in: orgNames } } });
  await db.user.deleteMany({ where: { email: { contains: suffix } } });
  await db.$disconnect();
});

describe("GET /api/conversations/[id]/messages pagination", () => {
  it("returns messages in ascending order with hasMore=false when under the limit", async () => {
    authedAs(userId, `msgpg-${suffix}@example.com`);
    const res = await messagesGET(req(`http://x/api/conversations/${convoId}/messages`, wsId), {
      params: { id: convoId },
    });
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    expect(body.data.hasMore).toBe(false);
    expect(body.data.messages.map((m: any) => m.body)).toEqual([
      "msg 0",
      "msg 1",
      "msg 2",
      "msg 3",
      "msg 4",
    ]);
  });

  it("caps at ?limit and returns the most recent messages with hasMore=true", async () => {
    authedAs(userId, `msgpg-${suffix}@example.com`);
    const res = await messagesGET(
      req(`http://x/api/conversations/${convoId}/messages?limit=2`, wsId),
      { params: { id: convoId } },
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.messages.map((m: any) => m.body)).toEqual(["msg 3", "msg 4"]);
  });

  it("pages into older history with ?before", async () => {
    authedAs(userId, `msgpg-${suffix}@example.com`);
    const beforeId = messageIds[3]; // "msg 3"
    const res = await messagesGET(
      req(`http://x/api/conversations/${convoId}/messages?limit=2&before=${beforeId}`, wsId),
      { params: { id: convoId } },
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.messages.map((m: any) => m.body)).toEqual(["msg 1", "msg 2"]);
  });

  it("is tenant-isolated: other workspace conversation returns 404", async () => {
    authedAs(userId, `msgpg-${suffix}@example.com`);
    const res = await messagesGET(
      req(`http://x/api/conversations/${otherConvoId}/messages`, wsId),
      { params: { id: otherConvoId } },
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(404);
  });
});
