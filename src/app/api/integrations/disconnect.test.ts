/**
 * Disconnect revocation tests (mocked HTTP — no real provider traffic).
 *
 * Proves the disconnect route best-effort revokes the provider token
 * BEFORE clearing local credentials:
 *  - TikTok  → POST /v2/oauth/revoke/
 *  - Facebook (Facebook Login) → DELETE /{user-id}/permissions
 * and that a failed revocation NEVER blocks the local disconnect
 * (status → DISCONNECTED, credentials wiped).
 *
 * Auth is stubbed (same pattern as security.test.ts); DB is the fresh
 * test.db per run.
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { POST as disconnectPOST } from "./[id]/disconnect/route";
import { encryptTikTokCredentials, TIKTOK_REVOKE_URL } from "@/lib/integrations/tiktok";
import { encryptCredentials } from "@/lib/integrations/meta";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

process.env.TIKTOK_CLIENT_KEY = "test-client-key";
process.env.TIKTOK_CLIENT_SECRET = "test-client-secret";
process.env.APP_PUBLIC_URL = "https://example.test";

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Revoke Test", email },
  } as any);
}

function req(url: string, workspaceId: string): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "x-workspace-id": workspaceId },
  });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}
let calls: CapturedCall[] = [];

function stubFetchOk() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({}) };
    })
  );
}

const suffix = `rev${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let wsId = "";

beforeAll(async () => {
  const u = await db.user.create({
    data: { email: `rev-${suffix}@example.com`, name: "Revoke", passwordHash: "x" },
  });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `Revoke Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `Revoke WS ${suffix}`, slug: `rev-${suffix}` },
  });
  wsId = w.id;
  await db.membership.create({ data: { userId: u.id, workspaceId: w.id, role: "OWNER" } });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // The Integration model has @@unique([workspaceId, provider]); clean up so
  // each test can create its own provider row in this workspace.
  if (wsId) await db.integration.deleteMany({ where: { workspaceId: wsId } });
});

async function createIntegration(provider: string, encrypted: string) {
  return db.integration.create({
    data: {
      workspaceId: wsId,
      provider,
      status: "CONNECTED",
      encryptedCredentials: encrypted,
      accountName: "Some Account",
    },
  });
}

describe("POST /api/integrations/[id]/disconnect revocation", () => {
  beforeEach(() => {
    authedAs(userId, `rev-${suffix}@example.com`);
  });

  it("revokes the TikTok token at the provider, then clears locally", async () => {
    stubFetchOk();
    const creds = encryptTikTokCredentials({
      provider: "tiktok",
      accessToken: "tt-access-token",
      refreshToken: "tt-refresh",
      expiresAt: null,
      openId: "tt-open-id",
    });
    const row = await createIntegration("tiktok", creds);

    const res = await disconnectPOST(
      req(`http://x/api/integrations/${row.id}/disconnect`, wsId),
      { params: { id: row.id } }
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    expect(body.data.status).toBe("DISCONNECTED");

    // Revocation was attempted against TikTok with the stored token.
    const revokeCalls = calls.filter((c) => c.url === TIKTOK_REVOKE_URL);
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0].init.method).toBe("POST");
    const sentBody = String(revokeCalls[0].init.body);
    expect(sentBody).toContain("token=tt-access-token");
    expect(sentBody).not.toContain("tt-refresh");

    // Local state is wiped.
    const after = await db.integration.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("DISCONNECTED");
    expect(after?.encryptedCredentials).toBeNull();
    expect(after?.accountName).toBeNull();
  });

  it("revokes Facebook user permissions, then clears locally", async () => {
    stubFetchOk();
    const creds = encryptCredentials({
      provider: "facebook",
      accessToken: "fb-user-token",
      expiresAt: null,
      metaUserId: "fb-user-1",
      metaUserName: "FB User",
    });
    const row = await createIntegration("facebook", creds);

    const res = await disconnectPOST(
      req(`http://x/api/integrations/${row.id}/disconnect`, wsId),
      { params: { id: row.id } }
    );
    expect((await jsonBody(res)).status).toBe(200);

    const revokeCalls = calls.filter((c) => c.url.includes("/fb-user-1/permissions"));
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0].init.method).toBe("DELETE");

    const after = await db.integration.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("DISCONNECTED");
    expect(after?.encryptedCredentials).toBeNull();
  });

  it("still disconnects locally when revocation fails", async () => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const creds = encryptTikTokCredentials({
      provider: "tiktok",
      accessToken: "tt-access-token-2",
      refreshToken: "tt-refresh-2",
      expiresAt: null,
      openId: "tt-open-id-2",
    });
    const row = await createIntegration("tiktok", creds);

    const res = await disconnectPOST(
      req(`http://x/api/integrations/${row.id}/disconnect`, wsId),
      { params: { id: row.id } }
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    expect(body.data.status).toBe("DISCONNECTED");

    const after = await db.integration.findUnique({ where: { id: row.id } });
    expect(after?.status).toBe("DISCONNECTED");
    expect(after?.encryptedCredentials).toBeNull();
  });
});
