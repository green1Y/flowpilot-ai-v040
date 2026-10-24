import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/tenancy";
import { requireUser } from "@/lib/auth";

// Same harness as src/app/api/tenancy.test.ts: stub the session via
// requireUser, use the isolated test DB for memberships/workspaces.
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  });
}

function reqWithHeader(workspaceId: string): NextRequest {
  return new NextRequest("http://localhost/api/tenancy-stale-test", {
    headers: { "x-workspace-id": workspaceId },
  });
}

function reqWithCookie(workspaceId: string): NextRequest {
  return new NextRequest("http://localhost/api/tenancy-stale-test", {
    headers: { cookie: `fp_workspace_id=${workspaceId}` },
  });
}

function reqNoSelection(): NextRequest {
  return new NextRequest("http://localhost/api/tenancy-stale-test");
}

/** A cuid-shaped id that names no workspace. */
function staleId(): string {
  return `c${randomBytes(12).toString("hex")}`;
}

async function thrownBody(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(Response);
    const res = e as Response;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  expect.unreachable("expected requireWorkspace to throw");
}

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userA = "";
let userNoWs = "";
let wsA = "";
let wsB = "";
const created: { users: string[]; workspaces: string[]; orgs: string[] } = {
  users: [],
  workspaces: [],
  orgs: [],
};

beforeAll(async () => {
  const a = await db.user.create({
    data: { email: `stale-a-${suffix}@example.com`, name: "Stale A", passwordHash: "x" },
  });
  const b = await db.user.create({
    data: { email: `stale-b-${suffix}@example.com`, name: "Stale B", passwordHash: "x" },
  });
  const c = await db.user.create({
    data: { email: `stale-c-${suffix}@example.com`, name: "Stale C", passwordHash: "x" },
  });
  userA = a.id;
  userNoWs = c.id;
  created.users.push(a.id, b.id, c.id);

  const orgA = await db.organization.create({ data: { name: `Stale Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `Stale Org B ${suffix}` } });
  created.orgs.push(orgA.id, orgB.id);

  const wA = await db.workspace.create({
    data: { orgId: orgA.id, name: `Stale WS A ${suffix}`, slug: `stale-a-${suffix}` },
  });
  const wB = await db.workspace.create({
    data: { orgId: orgB.id, name: `Stale WS B ${suffix}`, slug: `stale-b-${suffix}` },
  });
  wsA = wA.id;
  wsB = wB.id;
  created.workspaces.push(wA.id, wB.id);

  await db.membership.create({ data: { userId: a.id, workspaceId: wA.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: b.id, workspaceId: wB.id, role: "OWNER" } });
  // User C deliberately gets no memberships.
});

afterAll(async () => {
  await db.membership.deleteMany({ where: { workspaceId: { in: created.workspaces } } });
  await db.workspace.deleteMany({ where: { id: { in: created.workspaces } } });
  await db.organization.deleteMany({ where: { id: { in: created.orgs } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
});

describe("stale workspace selection", () => {
  it("returns 404 WORKSPACE_NOT_FOUND for a stale header id (no such workspace)", async () => {
    authedAs(userA, `stale-a-${suffix}@example.com`);
    const { status, body } = await thrownBody(requireWorkspace(reqWithHeader(staleId())));
    expect(status).toBe(404);
    expect(body.code).toBe("WORKSPACE_NOT_FOUND");
    expect(typeof body.error).toBe("string");
    // No data leak: the body carries no workspace or membership details.
    expect(body).not.toHaveProperty("workspace");
    expect(body).not.toHaveProperty("data");
    expect(body).not.toHaveProperty("workspaceId");
  });

  it("returns 404 WORKSPACE_NOT_FOUND for a stale cookie id (no header sent)", async () => {
    authedAs(userA, `stale-a-${suffix}@example.com`);
    const { status, body } = await thrownBody(requireWorkspace(reqWithCookie(staleId())));
    expect(status).toBe(404);
    expect(body.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("returns 404 for a stale id that names a deleted workspace", async () => {
    authedAs(userA, `stale-a-${suffix}@example.com`);
    const org = await db.organization.create({ data: { name: `Stale Gone ${suffix}` } });
    const gone = await db.workspace.create({
      data: { orgId: org.id, name: `Stale Gone ${suffix}`, slug: `stale-gone-${suffix}` },
    });
    const goneId = gone.id;
    await db.workspace.delete({ where: { id: goneId } });
    await db.organization.delete({ where: { id: org.id } });

    const { status, body } = await thrownBody(requireWorkspace(reqWithHeader(goneId)));
    expect(status).toBe(404);
    expect(body.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("returns 404 NO_WORKSPACE (not 500) for an authenticated user with no memberships", async () => {
    authedAs(userNoWs, `stale-c-${suffix}@example.com`);
    const { status, body } = await thrownBody(requireWorkspace(reqWithHeader(staleId())));
    expect(status).toBe(404);
    expect(body.code).toBe("NO_WORKSPACE");
    expect(typeof body.error).toBe("string");
  });

  it("returns 403 FORBIDDEN (no data) when requesting another user's workspace", async () => {
    authedAs(userA, `stale-a-${suffix}@example.com`);
    const { status, body } = await thrownBody(requireWorkspace(reqWithHeader(wsB)));
    expect(status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
    expect(body).not.toHaveProperty("workspace");
    expect(body).not.toHaveProperty("data");
    expect(body).not.toHaveProperty("workspaceId");
  });

  it("resolves a valid member with a valid id (no regression)", async () => {
    authedAs(userA, `stale-a-${suffix}@example.com`);
    const ctx = await requireWorkspace(reqWithHeader(wsA));
    expect(ctx.workspaceId).toBe(wsA);
    expect(ctx.userId).toBe(userA);
    expect(ctx.role).toBe("OWNER");
  });

  it("falls back to the first membership when no id is supplied (no regression)", async () => {
    authedAs(userA, `stale-a-${suffix}@example.com`);
    const ctx = await requireWorkspace(reqNoSelection());
    expect(ctx.workspaceId).toBe(wsA);
  });
});
