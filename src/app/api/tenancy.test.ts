import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/tenancy";
import { requireUser } from "@/lib/auth";

// Stub the session: requireWorkspace -> requireUser is the only auth import
// tenancy uses, so a module mock gives us full control over identity.
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  });
}

function reqWithWorkspace(workspaceId: string): NextRequest {
  return new NextRequest("http://localhost/api/tenancy-test", {
    headers: { "x-workspace-id": workspaceId },
  });
}

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userA = { id: "", email: "" };
let wsA = "";
let wsB = "";
let contactBId = "";
const created: { users: string[]; workspaces: string[]; orgs: string[] } = {
  users: [],
  workspaces: [],
  orgs: [],
};

beforeAll(async () => {
  const a = await db.user.create({
    data: { email: `tenant-a-${suffix}@example.com`, name: "Tenant A", passwordHash: "x" },
  });
  const b = await db.user.create({
    data: { email: `tenant-b-${suffix}@example.com`, name: "Tenant B", passwordHash: "x" },
  });
  userA = { id: a.id, email: a.email };
  created.users.push(a.id, b.id);

  const orgA = await db.organization.create({ data: { name: `Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `Org B ${suffix}` } });
  created.orgs.push(orgA.id, orgB.id);

  const wA = await db.workspace.create({
    data: { orgId: orgA.id, name: `WS A ${suffix}`, slug: `tenancy-a-${suffix}` },
  });
  const wB = await db.workspace.create({
    data: { orgId: orgB.id, name: `WS B ${suffix}`, slug: `tenancy-b-${suffix}` },
  });
  wsA = wA.id;
  wsB = wB.id;
  created.workspaces.push(wA.id, wB.id);

  await db.membership.create({ data: { userId: a.id, workspaceId: wA.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: b.id, workspaceId: wB.id, role: "OWNER" } });

  const contactB = await db.contact.create({
    data: { workspaceId: wB.id, name: "B Contact", channel: "web" },
  });
  contactBId = contactB.id;
});

afterAll(async () => {
  await db.contact.deleteMany({ where: { workspaceId: { in: created.workspaces } } });
  await db.membership.deleteMany({ where: { workspaceId: { in: created.workspaces } } });
  await db.workspace.deleteMany({ where: { id: { in: created.workspaces } } });
  await db.organization.deleteMany({ where: { id: { in: created.orgs } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
});

describe("tenant isolation", () => {
  it("rejects a request for another tenant's workspace with 403", async () => {
    authedAs(userA.id, userA.email);
    try {
      await requireWorkspace(reqWithWorkspace(wsB));
      expect.unreachable("should have thrown a 403 Response");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("resolves the caller's own workspace", async () => {
    authedAs(userA.id, userA.email);
    const ctx = await requireWorkspace(reqWithWorkspace(wsA));
    expect(ctx.workspaceId).toBe(wsA);
    expect(ctx.userId).toBe(userA.id);
    expect(ctx.role).toBe("OWNER");
  });

  it("returns nothing for cross-workspace Prisma queries", async () => {
    // What requireWorkspace relies on: no membership row for A in B.
    const membership = await db.membership.findFirst({
      where: { userId: userA.id, workspaceId: wsB },
    });
    expect(membership).toBeNull();

    // A contact in workspace B is invisible when scoped to workspace A.
    const cross = await db.contact.findFirst({
      where: { id: contactBId, workspaceId: wsA },
    });
    expect(cross).toBeNull();

    // …but visible with its own workspace scope.
    const own = await db.contact.findFirst({
      where: { id: contactBId, workspaceId: wsB },
    });
    expect(own?.id).toBe(contactBId);
  });
});
