import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";

// Content/config RBAC — closes the audit finding that ANALYST (read-only)
// members could mutate AI config, knowledge base, message templates,
// contact segments, and suppressions via the API. Mocks the session at the
// auth boundary, the same technique as authz-phasef.test.ts. Real password
// hashing / token helpers are preserved for the signup tests below.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: vi.fn(),
    // setSessionCookie needs next/headers request scope; irrelevant to these tests.
    setSessionCookie: vi.fn(async () => {}),
  };
});
const mockedRequireUser = vi.mocked(requireUser);

import { PUT as putAiConfig } from "@/app/api/ai-config/route";
import { POST as postKnowledge } from "@/app/api/ai-config/knowledge/route";
import { POST as postReindex } from "@/app/api/ai-config/knowledge/reindex/route";
import { POST as postAiTest } from "@/app/api/ai-config/test/route";
import { POST as postTemplate, GET as listTemplates } from "@/app/api/message-templates/route";
import { DELETE as deleteTemplate } from "@/app/api/message-templates/[id]/route";
import { POST as postSegment } from "@/app/api/contact-segments/route";
import { DELETE as deleteSegment } from "@/app/api/contact-segments/[id]/route";
import { POST as postSuppression } from "@/app/api/suppressions/route";
import { DELETE as deleteSuppression } from "@/app/api/suppressions/[id]/route";
import { PATCH as patchMember } from "@/app/api/team/[id]/route";

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  });
}

function req(method: string, path: string, workspaceId: string, body?: unknown): NextRequest {
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
  analyst: "",
  agent: "",
  manager: "",
  admin: "",
  ws: "",
  contact: "",
  orgs: [] as string[],
  users: [] as string[],
  template: "",
  segment: "",
};

beforeAll(async () => {
  const mkUser = async (tag: string) => {
    const u = await db.user.create({
      data: {
        email: `contentrbac-${tag}-${suffix}@example.com`.toLowerCase(),
        name: `ContentRBAC ${tag}`,
        passwordHash: "x",
      },
    });
    ids.users.push(u.id);
    return u;
  };
  const analyst = await mkUser("analyst");
  const agent = await mkUser("agent");
  const manager = await mkUser("manager");
  const admin = await mkUser("admin");
  ids.analyst = analyst.id;
  ids.agent = agent.id;
  ids.manager = manager.id;
  ids.admin = admin.id;

  const org = await db.organization.create({ data: { name: `ContentRBAC Org ${suffix}` } });
  ids.orgs.push(org.id);
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `ContentRBAC WS ${suffix}`, slug: `contentrbac-${suffix}` },
  });
  ids.ws = ws.id;

  await db.membership.create({ data: { userId: analyst.id, workspaceId: ws.id, role: "ANALYST" } });
  await db.membership.create({ data: { userId: agent.id, workspaceId: ws.id, role: "AGENT" } });
  await db.membership.create({ data: { userId: manager.id, workspaceId: ws.id, role: "MANAGER" } });
  await db.membership.create({ data: { userId: admin.id, workspaceId: ws.id, role: "ADMIN" } });

  const contact = await db.contact.create({
    data: { workspaceId: ws.id, name: "ContentRBAC Contact", channel: "web" },
  });
  ids.contact = contact.id;
});

afterAll(async () => {
  await db.messageTemplate.deleteMany({ where: { workspaceId: ids.ws } });
  await db.contactSegment.deleteMany({ where: { workspaceId: ids.ws } });
  await db.suppression.deleteMany({ where: { workspaceId: ids.ws } });
  await db.contact.deleteMany({ where: { id: ids.contact } });
  await db.membership.deleteMany({ where: { workspaceId: ids.ws } });
  await db.workspace.deleteMany({ where: { id: ids.ws } });
  await db.organization.deleteMany({ where: { id: { in: ids.orgs } } });
  await db.user.deleteMany({ where: { id: { in: ids.users } } });
});

const AI_CONFIG_BODY = { assistantName: "TestBot", fallbackResponse: "Sorry, unavailable." };

describe("content/config RBAC — ANALYST cannot mutate", () => {
  it("ANALYST gets 403 on PUT /api/ai-config (MANAGER)", async () => {
    authedAs(ids.analyst, `contentrbac-analyst-${suffix}@example.com`);
    const res = await putAiConfig(req("PUT", "/api/ai-config", ids.ws, AI_CONFIG_BODY));
    expect(res.status).toBe(403);
  });

  it("ANALYST gets 403 on POST /api/ai-config/knowledge (AGENT)", async () => {
    authedAs(ids.analyst, `contentrbac-analyst-${suffix}@example.com`);
    const res = await postKnowledge(
      req("POST", "/api/ai-config/knowledge", ids.ws, { title: "Doc", content: "0123456789abcdef" })
    );
    expect(res.status).toBe(403);
  });

  it("ANALYST gets 403 on POST /api/ai-config/knowledge/reindex (MANAGER)", async () => {
    authedAs(ids.analyst, `contentrbac-analyst-${suffix}@example.com`);
    const res = await postReindex(req("POST", "/api/ai-config/knowledge/reindex", ids.ws));
    expect(res.status).toBe(403);
  });

  it("ANALYST gets 403 on POST /api/ai-config/test (AGENT)", async () => {
    authedAs(ids.analyst, `contentrbac-analyst-${suffix}@example.com`);
    const res = await postAiTest(
      req("POST", "/api/ai-config/test", ids.ws, { question: "hello" })
    );
    expect(res.status).toBe(403);
  });

  it("ANALYST gets 403 on POST /api/message-templates (AGENT)", async () => {
    authedAs(ids.analyst, `contentrbac-analyst-${suffix}@example.com`);
    const res = await postTemplate(
      req("POST", "/api/message-templates", ids.ws, { name: "T", channel: "whatsapp", body: "hi" })
    );
    expect(res.status).toBe(403);
  });

  it("ANALYST gets 403 on POST /api/contact-segments (AGENT)", async () => {
    authedAs(ids.analyst, `contentrbac-analyst-${suffix}@example.com`);
    const res = await postSegment(req("POST", "/api/contact-segments", ids.ws, { name: "Seg" }));
    expect(res.status).toBe(403);
  });

  it("ANALYST gets 403 on POST /api/suppressions (AGENT)", async () => {
    authedAs(ids.analyst, `contentrbac-analyst-${suffix}@example.com`);
    const res = await postSuppression(
      req("POST", "/api/suppressions", ids.ws, { contactId: ids.contact })
    );
    expect(res.status).toBe(403);
  });

  it("ANALYST gets 403 on DELETE /api/message-templates/[id] (AGENT)", async () => {
    authedAs(ids.manager, `contentrbac-manager-${suffix}@example.com`);
    const created = await postTemplate(
      req("POST", "/api/message-templates", ids.ws, { name: "Del", channel: "whatsapp", body: "x" })
    );
    const { id } = (await created.json()) as { id: string };
    ids.template = id;
    authedAs(ids.analyst, `contentrbac-analyst-${suffix}@example.com`);
    const res = await deleteTemplate(req("DELETE", `/api/message-templates/${id}`, ids.ws), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(403);
  });

  it("ANALYST gets 403 on DELETE /api/suppressions/[id] (AGENT)", async () => {
    authedAs(ids.agent, `contentrbac-agent-${suffix}@example.com`);
    const created = await postSuppression(
      req("POST", "/api/suppressions", ids.ws, { contactId: ids.contact })
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    authedAs(ids.analyst, `contentrbac-analyst-${suffix}@example.com`);
    const res = await deleteSuppression(req("DELETE", `/api/suppressions/${id}`, ids.ws), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(403);
  });

  it("ANALYST gets 403 on DELETE /api/contact-segments/[id] (AGENT)", async () => {
    authedAs(ids.agent, `contentrbac-agent-${suffix}@example.com`);
    const created = await postSegment(req("POST", "/api/contact-segments", ids.ws, { name: "DelSeg" }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    ids.segment = id;
    authedAs(ids.analyst, `contentrbac-analyst-${suffix}@example.com`);
    const res = await deleteSegment(req("DELETE", `/api/contact-segments/${id}`, ids.ws), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(403);
  });
});

describe("content/config RBAC — permitted roles still work", () => {
  it("AGENT can create message templates and suppressions (201), MANAGER can PUT ai-config (200)", async () => {
    authedAs(ids.agent, `contentrbac-agent-${suffix}@example.com`);
    const t = await postTemplate(
      req("POST", "/api/message-templates", ids.ws, { name: "OK", channel: "whatsapp", body: "hi" })
    );
    expect(t.status).toBe(201);
    const s = await postSuppression(
      req("POST", "/api/suppressions", ids.ws, { contactId: ids.contact })
    );
    // 201 on first suppress, 200 if the contact is already suppressed (idempotent).
    expect([200, 201]).toContain(s.status);

    authedAs(ids.manager, `contentrbac-manager-${suffix}@example.com`);
    const c = await putAiConfig(req("PUT", "/api/ai-config", ids.ws, AI_CONFIG_BODY));
    expect(c.status).toBe(200);
  });

  it("AGENT gets 403 on MANAGER-only PUT /api/ai-config and POST reindex", async () => {
    authedAs(ids.agent, `contentrbac-agent-${suffix}@example.com`);
    expect((await putAiConfig(req("PUT", "/api/ai-config", ids.ws, AI_CONFIG_BODY))).status).toBe(403);
    expect((await postReindex(req("POST", "/api/ai-config/knowledge/reindex", ids.ws))).status).toBe(403);
  });

  it("ANALYST can still read (GET /api/message-templates = 200)", async () => {
    authedAs(ids.analyst, `contentrbac-analyst-${suffix}@example.com`);
    const res = await listTemplates(req("GET", "/api/message-templates", ids.ws));
    expect(res.status).toBe(200);
  });
});

describe("team RBAC — no privilege escalation via role changes", () => {
  it("ADMIN cannot change their own role (403), even to OWNER", async () => {
    const self = await db.membership.findFirstOrThrow({
      where: { userId: ids.admin, workspaceId: ids.ws },
    });
    authedAs(ids.admin, `contentrbac-admin-${suffix}@example.com`);
    const res = await patchMember(req("PATCH", `/api/team/${self.id}`, ids.ws, { role: "OWNER" }), {
      params: Promise.resolve({ id: self.id }),
    });
    expect(res.status).toBe(403);
  });

  it("ADMIN cannot promote another member to OWNER (403)", async () => {
    const target = await db.membership.findFirstOrThrow({
      where: { userId: ids.agent, workspaceId: ids.ws },
    });
    authedAs(ids.admin, `contentrbac-admin-${suffix}@example.com`);
    const res = await patchMember(
      req("PATCH", `/api/team/${target.id}`, ids.ws, { role: "OWNER" }),
      { params: Promise.resolve({ id: target.id }) }
    );
    expect(res.status).toBe(403);
    // Role unchanged.
    const after = await db.membership.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.role).toBe("AGENT");
  });

  it("ADMIN can still manage non-OWNER roles (AGENT -> MANAGER = 200)", async () => {
    const target = await db.membership.findFirstOrThrow({
      where: { userId: ids.manager, workspaceId: ids.ws },
    });
    authedAs(ids.admin, `contentrbac-admin-${suffix}@example.com`);
    const res = await patchMember(
      req("PATCH", `/api/team/${target.id}`, ids.ws, { role: "AGENT" }),
      { params: Promise.resolve({ id: target.id }) }
    );
    expect(res.status).toBe(200);
    const after = await db.membership.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.role).toBe("AGENT");
  });
});

import { POST as signup } from "@/app/api/auth/signup/route";
import { resetSignupAttempts } from "@/lib/rate-limit";

describe("signup rate limiting", () => {
  const createdEmails: string[] = [];
  const testIp = `10.99.99.${Math.floor(Math.random() * 200) + 1}`;

  function signupReq(email: string): NextRequest {
    return new NextRequest("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": testIp },
      body: JSON.stringify({ name: "Signup RL", email, password: "TestPass123!" }),
    });
  }

  afterAll(async () => {
    const users = await db.user.findMany({ where: { email: { in: createdEmails } } });
    const userIds = users.map((u) => u.id);
    const memberships = await db.membership.findMany({ where: { userId: { in: userIds } } });
    const wsIds = [...new Set(memberships.map((m) => m.workspaceId))];
    const workspaces = await db.workspace.findMany({ where: { id: { in: wsIds } } });
    const orgIds = [...new Set(workspaces.map((w) => w.orgId))];
    await db.membership.deleteMany({ where: { userId: { in: userIds } } });
    await db.workspace.deleteMany({ where: { id: { in: wsIds } } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    resetSignupAttempts();
  });

  it("allows signups up to the per-IP budget, then answers 429", async () => {
    resetSignupAttempts();
    for (let i = 0; i < 5; i++) {
      const email = `signup-rl-${suffix}-${i}@example.com`.toLowerCase();
      const res = await signup(signupReq(email));
      expect(res.status).toBe(201);
      createdEmails.push(email);
    }
    const blocked = await signup(signupReq(`signup-rl-${suffix}-6@example.com`.toLowerCase()));
    expect(blocked.status).toBe(429);
  });
});
