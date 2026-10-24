import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";

// Static bcrypt hash of "correct-horse-123" (the @/lib/auth mock in this file
// replaces hashPassword/verifyPassword, so we cannot call them here).
const STATIC_HASH = "$2a$12$ZgOADfJQDLWXzytTXsd9W.DUc.y.tAKVIMimtrAuRcieqMw9bV9BW";

// Phase 4 — Settings workstream API tests: authz, validation, tenant isolation.
// Mocks the session at the auth boundary (same pattern as authz-phasef.test.ts).
// Mocks the session at the auth boundary (same pattern as authz-phasef.test.ts),
// passing through the real password helpers so the password route works.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, requireUser: vi.fn() };
});
const mockedRequireUser = vi.mocked(requireUser);

import { GET as getSettings, PUT as putSettings } from "./workspace/settings/route";
import { GET as getAudit } from "./audit/route";
import { GET as getExport } from "./workspace/export/route";
import { POST as requestDeletion } from "./workspace/deletion-request/route";
import { PATCH as patchMe } from "./auth/me/route";
import { PUT as changePassword } from "./auth/password/route";

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  });
}

function unauthed() {
  mockedRequireUser.mockRejectedValue(Response.json({ error: "Unauthorized" }, { status: 401 }));
}

function req(method: string, path: string, workspaceId: string | null, body?: unknown): NextRequest {
  const headers: Record<string, string> = {};
  if (workspaceId) headers["x-workspace-id"] = workspaceId;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ids = {
  ownerA: "",
  managerA: "",
  agentA: "",
  ownerB: "",
  wsA: "",
  wsB: "",
  orgs: [] as string[],
  users: [] as string[],
  passwordUser: "",
};

const json = (r: Response) => r.json() as Promise<{ ok: boolean; data?: unknown; error?: string }>;

beforeAll(async () => {
  const mkUser = async (tag: string) => {
    const u = await db.user.create({
      data: {
        email: `settings-${tag}-${suffix}@example.com`.toLowerCase(),
        name: `Settings ${tag}`,
        passwordHash: STATIC_HASH,
      },
    });
    ids.users.push(u.id);
    return u;
  };
  const ownerA = await mkUser("ownerA");
  const managerA = await mkUser("managerA");
  const agentA = await mkUser("agentA");
  const ownerB = await mkUser("ownerB");
  const pwUser = await mkUser("pwuser");
  ids.ownerA = ownerA.id;
  ids.managerA = managerA.id;
  ids.agentA = agentA.id;
  ids.ownerB = ownerB.id;
  ids.passwordUser = pwUser.id;

  const orgA = await db.organization.create({ data: { name: `Settings Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `Settings Org B ${suffix}` } });
  ids.orgs.push(orgA.id, orgB.id);

  const wA = await db.workspace.create({
    data: { orgId: orgA.id, name: `Settings WS A ${suffix}`, slug: `settings-a-${suffix}` },
  });
  const wB = await db.workspace.create({
    data: { orgId: orgB.id, name: `Settings WS B ${suffix}`, slug: `settings-b-${suffix}` },
  });
  ids.wsA = wA.id;
  ids.wsB = wB.id;

  await db.membership.create({ data: { userId: ownerA.id, workspaceId: wA.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: managerA.id, workspaceId: wA.id, role: "MANAGER" } });
  await db.membership.create({ data: { userId: agentA.id, workspaceId: wA.id, role: "AGENT" } });
  await db.membership.create({ data: { userId: ownerB.id, workspaceId: wB.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: pwUser.id, workspaceId: wA.id, role: "AGENT" } });

  // Seed an audit event for the audit/export tests.
  await db.auditEvent.create({
    data: { workspaceId: wA.id, actorId: ownerA.id, action: "team.invited", entity: "{}" },
  });
});

afterAll(async () => {
  await db.workspaceSettings.deleteMany({ where: { workspaceId: { in: [ids.wsA, ids.wsB] } } });
  await db.auditEvent.deleteMany({ where: { workspaceId: { in: [ids.wsA, ids.wsB] } } });
  await db.membership.deleteMany({ where: { workspaceId: { in: [ids.wsA, ids.wsB] } } });
  await db.workspace.deleteMany({ where: { id: { in: [ids.wsA, ids.wsB] } } });
  await db.organization.deleteMany({ where: { id: { in: ids.orgs } } });
  await db.user.deleteMany({ where: { id: { in: ids.users } } });
});

/* ---------------- workspace/settings ---------------- */

describe("GET /api/workspace/settings", () => {
  it("401 when unauthenticated", async () => {
    unauthed();
    const res = await getSettings(req("GET", "/api/workspace/settings", ids.wsA));
    expect(res.status).toBe(401);
  });

  it("403 for a workspace the user is not a member of (tenant isolation)", async () => {
    authedAs(ids.ownerB, "b@example.com");
    const res = await getSettings(req("GET", "/api/workspace/settings", ids.wsA));
    expect(res.status).toBe(403);
  });

  it("returns defaults for a member when no settings row exists", async () => {
    authedAs(ids.agentA, "agent@example.com");
    const res = await getSettings(req("GET", "/api/workspace/settings", ids.wsA));
    expect(res.status).toBe(200);
    const body = await json(res);
    const settings = (body.data as { settings: { automation: Record<string, unknown>; notifications: Record<string, unknown> } }).settings;
    expect(settings.automation.maxRetries).toBe(3);
    expect(settings.automation.dedupeEnabled).toBe(true);
    expect(settings.notifications.workflowFailures).toBe(true);
  });
});

describe("PUT /api/workspace/settings", () => {
  it("401 when unauthenticated", async () => {
    unauthed();
    const res = await putSettings(req("PUT", "/api/workspace/settings", ids.wsA, { automation: {} }));
    expect(res.status).toBe(401);
  });

  it("403 for AGENT (MANAGER+ required)", async () => {
    authedAs(ids.agentA, "agent@example.com");
    const res = await putSettings(
      req("PUT", "/api/workspace/settings", ids.wsA, { automation: { maxRetries: 5 } })
    );
    expect(res.status).toBe(403);
  });

  it("422 on invalid values (Zod validation)", async () => {
    authedAs(ids.managerA, "mgr@example.com");
    const res = await putSettings(
      req("PUT", "/api/workspace/settings", ids.wsA, { automation: { maxRetries: 99 } })
    );
    expect(res.status).toBe(422);
  });

  it("422 on unknown keys (strict schema)", async () => {
    authedAs(ids.managerA, "mgr@example.com");
    const res = await putSettings(
      req("PUT", "/api/workspace/settings", ids.wsA, { evil: true })
    );
    expect(res.status).toBe(422);
  });

  it("MANAGER can update and the values persist (merged over defaults)", async () => {
    authedAs(ids.managerA, "mgr@example.com");
    const put = await putSettings(
      req("PUT", "/api/workspace/settings", ids.wsA, {
        automation: { maxRetries: 5, dedupeEnabled: false },
        notifications: { emailAlerts: true },
      })
    );
    expect(put.status).toBe(200);
    const putBody = await json(put);
    const saved = putBody.data as { settings: { automation: Record<string, unknown>; notifications: Record<string, unknown> } };
    expect(saved.settings.automation.maxRetries).toBe(5);
    expect(saved.settings.automation.dedupeEnabled).toBe(false);
    expect(saved.settings.automation.backoffBaseMs).toBe(5000); // default preserved
    expect(saved.settings.notifications.emailAlerts).toBe(true);
    expect(saved.settings.notifications.workflowFailures).toBe(true); // default preserved

    // Read back.
    const get = await getSettings(req("GET", "/api/workspace/settings", ids.wsA));
    const getBody = await json(get);
    const readBack = (getBody.data as { settings: { automation: Record<string, unknown> } }).settings;
    expect(readBack.automation.maxRetries).toBe(5);

    // Tenant isolation: workspace B still sees defaults.
    authedAs(ids.ownerB, "b@example.com");
    const other = await getSettings(req("GET", "/api/workspace/settings", ids.wsB));
    const otherBody = await json(other);
    const otherSettings = (otherBody.data as { settings: { automation: Record<string, unknown> } }).settings;
    expect(otherSettings.automation.maxRetries).toBe(3);
  });

  it("writes an audit event", async () => {
    authedAs(ids.ownerA, "ownera@example.com");
    await putSettings(
      req("PUT", "/api/workspace/settings", ids.wsA, { automation: { maxRetries: 2 } })
    );
    const latest = await db.auditEvent.findFirst({
      where: { workspaceId: ids.wsA, action: "workspace.settings_updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(latest).not.toBeNull();
  });
});

/* ---------------- /api/audit ---------------- */

describe("GET /api/audit", () => {
  it("401 when unauthenticated", async () => {
    unauthed();
    const res = await getAudit(req("GET", "/api/audit", ids.wsA));
    expect(res.status).toBe(401);
  });

  it("403 cross-workspace (tenant isolation)", async () => {
    authedAs(ids.ownerB, "b@example.com");
    const res = await getAudit(req("GET", "/api/audit", ids.wsA));
    expect(res.status).toBe(403);
  });

  it("returns events with parsed entity and actor", async () => {
    authedAs(ids.agentA, "agent@example.com");
    const res = await getAudit(req("GET", "/api/audit?limit=10", ids.wsA));
    expect(res.status).toBe(200);
    const body = await json(res);
    const events = (body.data as { events: { action: string; actor: unknown; entity: unknown }[] }).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => typeof e.action === "string")).toBe(true);
  });

  it("action prefix filter works", async () => {
    authedAs(ids.agentA, "agent@example.com");
    const res = await getAudit(req("GET", "/api/audit?action=team", ids.wsA));
    expect(res.status).toBe(200);
    const body = await json(res);
    const events = (body.data as { events: { action: string }[] }).events;
    expect(events.every((e) => e.action.startsWith("team"))).toBe(true);
  });
});

/* ---------------- /api/workspace/export ---------------- */

describe("GET /api/workspace/export", () => {
  it("401 when unauthenticated", async () => {
    unauthed();
    const res = await getExport(req("GET", "/api/workspace/export", ids.wsA));
    expect(res.status).toBe(401);
  });

  it("403 for AGENT (MANAGER+ required)", async () => {
    authedAs(ids.agentA, "agent@example.com");
    const res = await getExport(req("GET", "/api/workspace/export", ids.wsA));
    expect(res.status).toBe(403);
  });

  it("returns a JSON download with no secrets", async () => {
    authedAs(ids.managerA, "mgr@example.com");
    const res = await getExport(req("GET", "/api/workspace/export", ids.wsA));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const payload = (await res.json()) as Record<string, unknown>;
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(/passwordHash/i);
    expect(text).not.toMatch(/encryptedCredentials/i);
    expect(payload.workspace).toBeDefined();
    expect(payload.contacts).toBeDefined();
    expect(payload.settings).toBeDefined();
  });
});

/* ---------------- /api/workspace/deletion-request ---------------- */

describe("POST /api/workspace/deletion-request", () => {
  it("403 for MANAGER (OWNER only)", async () => {
    authedAs(ids.managerA, "mgr@example.com");
    const res = await requestDeletion(req("POST", "/api/workspace/deletion-request", ids.wsA, {}));
    expect(res.status).toBe(403);
  });

  it("OWNER records the request and writes an audit event", async () => {
    authedAs(ids.ownerA, "ownera@example.com");
    const res = await requestDeletion(
      req("POST", "/api/workspace/deletion-request", ids.wsA, { reason: "test" })
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((body.data as { requested: boolean }).requested).toBe(true);
    const audit = await db.auditEvent.findFirst({
      where: { workspaceId: ids.wsA, action: "workspace.deletion_requested" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });
});

/* ---------------- /api/auth/me PATCH ---------------- */

describe("PATCH /api/auth/me", () => {
  it("401 when unauthenticated", async () => {
    unauthed();
    const res = await patchMe(req("PATCH", "/api/auth/me", null, { name: "X" }));
    expect(res.status).toBe(401);
  });

  it("updates name and timezone; 422 on bad timezone", async () => {
    authedAs(ids.agentA, "agent@example.com");
    const okRes = await patchMe(
      req("PATCH", "/api/auth/me", null, { name: "Agent Renamed", timezone: "Europe/Athens" })
    );
    expect(okRes.status).toBe(200);
    const okBody = await json(okRes);
    expect((okBody.data as { user: { name: string; timezone: string } }).user.name).toBe("Agent Renamed");
    expect((okBody.data as { user: { name: string; timezone: string } }).user.timezone).toBe("Europe/Athens");

    const badRes = await patchMe(req("PATCH", "/api/auth/me", null, { timezone: "Mars/Olympus" }));
    expect(badRes.status).toBe(422);
  });

  it("409 when the email is taken by another user", async () => {
    authedAs(ids.agentA, "agent@example.com");
    const res = await patchMe(
      req("PATCH", "/api/auth/me", null, { email: `settings-ownerA-${suffix}@example.com` })
    );
    expect(res.status).toBe(409);
  });

  it("422 on empty body and unknown keys", async () => {
    authedAs(ids.agentA, "agent@example.com");
    expect((await patchMe(req("PATCH", "/api/auth/me", null, {}))).status).toBe(422);
    expect((await patchMe(req("PATCH", "/api/auth/me", null, { evil: 1 }))).status).toBe(422);
  });
});

/* ---------------- /api/auth/password PUT ---------------- */

describe("PUT /api/auth/password", () => {
  it("401 when unauthenticated", async () => {
    unauthed();
    const res = await changePassword(
      req("PUT", "/api/auth/password", null, { currentPassword: "x", newPassword: "new-password-123" })
    );
    expect(res.status).toBe(401);
  });

  it("401 on wrong current password", async () => {
    authedAs(ids.passwordUser, "pw@example.com");
    const res = await changePassword(
      req("PUT", "/api/auth/password", null, { currentPassword: "wrong-password", newPassword: "new-password-123" })
    );
    expect(res.status).toBe(401);
  });

  it("422 on short or identical new password", async () => {
    authedAs(ids.passwordUser, "pw@example.com");
    const short = await changePassword(
      req("PUT", "/api/auth/password", null, { currentPassword: "correct-horse-123", newPassword: "short" })
    );
    expect(short.status).toBe(422);
    const same = await changePassword(
      req("PUT", "/api/auth/password", null, { currentPassword: "correct-horse-123", newPassword: "correct-horse-123" })
    );
    expect(same.status).toBe(422);
  });

  it("changes the password when the current one verifies", async () => {
    authedAs(ids.passwordUser, "pw@example.com");
    const res = await changePassword(
      req("PUT", "/api/auth/password", null, { currentPassword: "correct-horse-123", newPassword: "brand-new-pass-456" })
    );
    expect(res.status).toBe(200);
    const row = await db.user.findUnique({ where: { id: ids.passwordUser }, select: { passwordHash: true } });
    const bcrypt = await import("bcryptjs");
    expect(await bcrypt.compare("brand-new-pass-456", row!.passwordHash)).toBe(true);
  });
});
