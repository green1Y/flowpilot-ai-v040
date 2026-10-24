/**
 * Wave 2A (D4) — verify-route Business-Login routing (stubbed HTTP only,
 * no real Meta traffic).
 *
 * Before the fix, every Instagram Business-Login row (pageId null by
 * design) hit "No page selected — complete the page selection step" (422)
 * in verifyMeta, even with a perfectly valid IG token. After the fix the
 * non-WhatsApp branch routes loginType "instagram_login" through the
 * adapter-level identity check (GET graph.instagram.com/me) and persists
 * CONNECTED + verifiedAt on success; facebook/legacy rows still require
 * a pageId. Failure classification is unchanged (190 → 401 reauth).
 *
 * Auth is stubbed (same pattern as disconnect.test.ts); DB is the fresh
 * test.db per run.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { POST as verifyPOST } from "./route";
import { encryptCredentials } from "@/lib/integrations/meta";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-app-secret";
process.env.META_VERIFY_TOKEN = "test-verify-token";
process.env.APP_PUBLIC_URL = "https://example.test";

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Verify Test", email },
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

/** Stub global fetch to return one fixed JSON payload (never real network). */
function stubFetchJson(data: unknown, opts: { ok?: boolean; status?: number } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => data,
    }))
  );
}

const suffix = `vf${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let wsId = "";

beforeAll(async () => {
  const u = await db.user.create({
    data: { email: `vf-${suffix}@example.com`, name: "Verify", passwordHash: "x" },
  });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `Verify Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `Verify WS ${suffix}`, slug: `vf-${suffix}` },
  });
  wsId = w.id;
  await db.membership.create({ data: { userId: u.id, workspaceId: w.id, role: "OWNER" } });
  authedAs(userId, `vf-${suffix}@example.com`);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (wsId) await db.integration.deleteMany({ where: { workspaceId: wsId } });
});

describe("POST /api/integrations/[id]/verify — Business Login (D4)", () => {
  it("verifies an instagram_login row with no pageId via the IG identity check", async () => {
    stubFetchJson({
      id: `ig-${suffix}`,
      username: "biz_account",
      name: "Biz Account",
      profile_picture_url: "https://example.test/pic.jpg",
    });
    const row = await db.integration.create({
      data: {
        workspaceId: wsId,
        provider: "instagram",
        status: "NEEDS_ATTENTION",
        encryptedCredentials: encryptCredentials({
          provider: "instagram",
          loginType: "instagram_login",
          accessToken: `ig-token-${suffix}`,
          expiresAt: null,
          igUserId: `ig-${suffix}`,
          igUsername: "biz_account",
        }),
      },
    });
    const { status, body } = await jsonBody(
      await verifyPOST(req(`https://example.test/api/integrations/${row.id}/verify`, wsId), {
        params: Promise.resolve({ id: row.id }),
      } as any)
    );
    expect(status).toBe(200);
    expect(body.data.status).toBe("CONNECTED");
    const updated = await db.integration.findUnique({ where: { id: row.id } });
    expect(updated!.status).toBe("CONNECTED");
    expect(updated!.verifiedAt).not.toBeNull();
    expect(updated!.externalAccountId).toBe(`ig-${suffix}`);
  });

  it("still requires a pageId for facebook/legacy-instagram rows", async () => {
    stubFetchJson({ id: "page-1", name: "Page" });
    const row = await db.integration.create({
      data: {
        workspaceId: wsId,
        provider: "facebook",
        status: "NEEDS_ATTENTION",
        encryptedCredentials: encryptCredentials({
          provider: "facebook",
          accessToken: `fb-token-${suffix}`,
          expiresAt: null,
        }),
      },
    });
    const { status, body } = await jsonBody(
      await verifyPOST(req(`https://example.test/api/integrations/${row.id}/verify`, wsId), {
        params: Promise.resolve({ id: row.id }),
      } as any)
    );
    expect(status).toBe(422);
    expect(body.error).toMatch(/No page selected/i);
  });

  it("keeps the 190 → reauth_required classification on the IG identity check", async () => {
    stubFetchJson(
      { error: { message: "Session expired", code: 190 } },
      { ok: false, status: 400 }
    );
    const row = await db.integration.create({
      data: {
        workspaceId: wsId,
        provider: "instagram",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "instagram",
          loginType: "instagram_login",
          accessToken: `ig-token-${suffix}`,
          expiresAt: null,
          igUserId: `ig-${suffix}`,
        }),
      },
    });
    const { status } = await jsonBody(
      await verifyPOST(req(`https://example.test/api/integrations/${row.id}/verify`, wsId), {
        params: Promise.resolve({ id: row.id }),
      } as any)
    );
    expect(status).toBe(401);
    const updated = await db.integration.findUnique({ where: { id: row.id } });
    expect(updated!.status).toBe("NEEDS_ATTENTION");
    expect(updated!.statusDetail).toContain("token_expired");
  });
});
