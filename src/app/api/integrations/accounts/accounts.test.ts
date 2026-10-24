/**
 * Wave 2A (D8) — GET /api/integrations/accounts (no HTTP to providers).
 *
 * Proves the accounts endpoint returns ALL rows for the workspace
 * (per-account, not one card per provider), each merged with catalog +
 * connectionState + envConfigured, and NEVER credentials — even the
 * ciphertext must not appear in the response body.
 *
 * Auth is stubbed (same pattern as disconnect.test.ts); DB is the fresh
 * test.db per run.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET as accountsGET } from "./route";
import { encryptCredentials } from "@/lib/integrations/meta";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `ac${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let wsId = "";
let otherWsId = "";

beforeAll(async () => {
  const u = await db.user.create({
    data: { email: `ac-${suffix}@example.com`, name: "Accounts", passwordHash: "x" },
  });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `Accounts Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `Accounts WS ${suffix}`, slug: `ac-${suffix}` },
  });
  wsId = w.id;
  const w2 = await db.workspace.create({
    data: { orgId: org.id, name: `Accounts WS2 ${suffix}`, slug: `ac2-${suffix}` },
  });
  otherWsId = w2.id;
  await db.membership.create({ data: { userId: u.id, workspaceId: w.id, role: "AGENT" } });
  mockedRequireUser.mockResolvedValue({
    userId,
    email: `ac-${suffix}@example.com`,
    user: { id: userId, name: "Accounts", email: `ac-${suffix}@example.com` },
  } as any);
});

afterEach(async () => {
  if (wsId) await db.integration.deleteMany({ where: { workspaceId: wsId } });
  if (otherWsId) await db.integration.deleteMany({ where: { workspaceId: otherWsId } });
});

function req(workspaceId: string): NextRequest {
  return new NextRequest("https://example.test/api/integrations/accounts", {
    headers: { "x-workspace-id": workspaceId },
  });
}

describe("GET /api/integrations/accounts", () => {
  it("returns every row for the workspace, per-account, without credentials", async () => {
    const cipher = encryptCredentials({
      provider: "instagram",
      loginType: "instagram_login",
      accessToken: `secret-${suffix}`,
      expiresAt: null,
      igUserId: `ig-${suffix}`,
    });
    const a = await db.integration.create({
      data: {
        workspaceId: wsId, provider: "instagram", status: "CONNECTED",
        encryptedCredentials: cipher, externalAccountId: `ig-${suffix}`,
        accountName: "Biz One",
      },
    });
    const b = await db.integration.create({
      data: {
        workspaceId: wsId, provider: "instagram", status: "DISCONNECTED",
        externalAccountId: `ig2-${suffix}`, accountName: "Biz Two",
      },
    });
    // Another workspace's row must never leak in.
    await db.integration.create({
      data: {
        workspaceId: otherWsId, provider: "instagram", status: "CONNECTED",
        externalAccountId: `ig-other-${suffix}`,
      },
    });
    const res = await accountsGET(req(wsId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const accounts = body.data.accounts as any[];
    expect(accounts.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    for (const x of accounts) {
      expect(x.provider).toBe("instagram");
      expect(typeof x.connectionState).toBe("string");
      expect(typeof x.envConfigured).toBe("boolean");
      expect(Array.isArray(x.requiredPermissions)).toBe(true);
    }
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(cipher);
    expect(serialized).not.toContain(`secret-${suffix}`);
    expect(serialized).not.toContain("encryptedCredentials");
    const first = accounts.find((x) => x.id === a.id)!;
    expect(first.accountName).toBe("Biz One");
    expect(first.accountId).toBe(`ig-${suffix}`);
  });

  it("is readable by a non-manager member (matches the list route's gate)", async () => {
    // Membership above is AGENT; requireRole is never called by this route.
    await db.integration.create({
      data: { workspaceId: wsId, provider: "telegram", status: "DEMO" },
    });
    const res = await accountsGET(req(wsId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.accounts).toHaveLength(1);
    expect(body.data.accounts[0].simulated).toBe(true);
  });
});
