import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";

// Inbox conversations RBAC — closes the flagged follow-up from the Phase 3
// RBAC audit ("inbox conversation routes have tenant scoping but no AGENT+
// gates (ANALYST could reply via API)"). Mocks the session at the auth
// boundary, the same technique as authz-phasef.test.ts.
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

import { GET as listConversations } from "./route";
import { GET as getConversation, PATCH as patchConversation } from "./[id]/route";
import { GET as listMessages, POST as postMessage } from "./[id]/messages/route";
import { POST as postNote } from "./[id]/notes/route";
import { POST as postTyping } from "./[id]/typing/route";

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  });
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
  owner: "",
  analyst: "",
  agent: "",
  ws: "",
  contact: "",
  convo: "",
  orgs: [] as string[],
  users: [] as string[],
};

beforeAll(async () => {
  const mkUser = async (tag: string) => {
    const u = await db.user.create({
      data: {
        email: `inboxrbac-${tag}-${suffix}@example.com`.toLowerCase(),
        name: `InboxRBAC ${tag}`,
        passwordHash: "x",
      },
    });
    ids.users.push(u.id);
    return u;
  };
  const owner = await mkUser("owner");
  const analyst = await mkUser("analyst");
  const agent = await mkUser("agent");
  ids.owner = owner.id;
  ids.analyst = analyst.id;
  ids.agent = agent.id;

  const org = await db.organization.create({ data: { name: `InboxRBAC Org ${suffix}` } });
  ids.orgs.push(org.id);
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `InboxRBAC WS ${suffix}`, slug: `inboxrbac-${suffix}` },
  });
  ids.ws = ws.id;

  await db.membership.create({ data: { userId: owner.id, workspaceId: ws.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: analyst.id, workspaceId: ws.id, role: "ANALYST" } });
  await db.membership.create({ data: { userId: agent.id, workspaceId: ws.id, role: "AGENT" } });

  const contact = await db.contact.create({
    data: { workspaceId: ws.id, name: "InboxRBAC Contact", channel: "web" },
  });
  ids.contact = contact.id;
  const convo = await db.conversation.create({
    data: { workspaceId: ws.id, contactId: contact.id, channel: "web" },
  });
  ids.convo = convo.id;
});

afterAll(async () => {
  await db.message.deleteMany({ where: { conversationId: ids.convo } });
  await db.conversation.deleteMany({ where: { id: ids.convo } });
  await db.contact.deleteMany({ where: { id: ids.contact } });
  await db.membership.deleteMany({ where: { workspaceId: ids.ws } });
  await db.workspace.deleteMany({ where: { id: ids.ws } });
  await db.organization.deleteMany({ where: { id: { in: ids.orgs } } });
  await db.user.deleteMany({ where: { id: { in: ids.users } } });
});

describe("inbox RBAC — read-only members can view but not mutate", () => {
  it("ANALYST can list conversations and read a thread (200)", async () => {
    authedAs(ids.analyst, `inboxrbac-analyst-${suffix}@example.com`);
    const list = await listConversations(req("GET", "/api/conversations", ids.ws));
    expect(list.status).toBe(200);
    const one = await getConversation(
      req("GET", `/api/conversations/${ids.convo}`, ids.ws),
      { params: { id: ids.convo } }
    );
    expect(one.status).toBe(200);
    const msgs = await listMessages(
      req("GET", `/api/conversations/${ids.convo}/messages`, ids.ws),
      { params: { id: ids.convo } }
    );
    expect(msgs.status).toBe(200);
  });

  it("ANALYST cannot change assignment/priority/takeover (403)", async () => {
    authedAs(ids.analyst, `inboxrbac-analyst-${suffix}@example.com`);
    const res = await patchConversation(
      req("PATCH", `/api/conversations/${ids.convo}`, ids.ws, { priority: "HIGH" }),
      { params: { id: ids.convo } }
    );
    expect(res.status).toBe(403);
  });

  it("ANALYST cannot send a reply (403)", async () => {
    authedAs(ids.analyst, `inboxrbac-analyst-${suffix}@example.com`);
    const res = await postMessage(
      req("POST", `/api/conversations/${ids.convo}/messages`, ids.ws, { body: "sneaky reply" }),
      { params: { id: ids.convo } }
    );
    expect(res.status).toBe(403);
  });

  it("ANALYST cannot add an internal note (403)", async () => {
    authedAs(ids.analyst, `inboxrbac-analyst-${suffix}@example.com`);
    const res = await postNote(
      req("POST", `/api/conversations/${ids.convo}/notes`, ids.ws, { body: "sneaky note" }),
      { params: { id: ids.convo } }
    );
    expect(res.status).toBe(403);
  });

  it("ANALYST cannot write typing presence (403)", async () => {
    authedAs(ids.analyst, `inboxrbac-analyst-${suffix}@example.com`);
    const res = await postTyping(
      req("POST", `/api/conversations/${ids.convo}/typing`, ids.ws, { active: true }),
      { params: { id: ids.convo } }
    );
    expect(res.status).toBe(403);
  });
});

describe("inbox RBAC — AGENT can perform the inbox mutations", () => {
  it("AGENT can change priority (200) and the change persists", async () => {
    authedAs(ids.agent, `inboxrbac-agent-${suffix}@example.com`);
    const res = await patchConversation(
      req("PATCH", `/api/conversations/${ids.convo}`, ids.ws, { priority: "HIGH" }),
      { params: { id: ids.convo } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.conversation.priority).toBe("HIGH");
  });

  it("AGENT can send a reply (201)", async () => {
    authedAs(ids.agent, `inboxrbac-agent-${suffix}@example.com`);
    const res = await postMessage(
      req("POST", `/api/conversations/${ids.convo}/messages`, ids.ws, { body: "hello from agent" }),
      { params: { id: ids.convo } }
    );
    expect(res.status).toBe(201);
  });

  it("AGENT can add an internal note (201)", async () => {
    authedAs(ids.agent, `inboxrbac-agent-${suffix}@example.com`);
    const res = await postNote(
      req("POST", `/api/conversations/${ids.convo}/notes`, ids.ws, { body: "agent note" }),
      { params: { id: ids.convo } }
    );
    expect(res.status).toBe(201);
  });

  it("AGENT can write typing presence (200)", async () => {
    authedAs(ids.agent, `inboxrbac-agent-${suffix}@example.com`);
    const res = await postTyping(
      req("POST", `/api/conversations/${ids.convo}/typing`, ids.ws, { active: true }),
      { params: { id: ids.convo } }
    );
    expect(res.status).toBe(200);
  });
});
