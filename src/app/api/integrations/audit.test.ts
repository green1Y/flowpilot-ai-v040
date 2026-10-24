/**
 * Integrations audit tests — Phase 4 checklist (mocked HTTP, no real
 * provider traffic; clearly labeled).
 *
 *  - OAuth callback: success / denial / invalid-state / replayed state
 *  - CSRF: tampered state rejected; cross-workspace state rejected
 *  - Token expiry → NEEDS_ATTENTION + reauth_required connection state
 *  - Permission revocation (Meta code 200) → permission_missing state
 *  - Rate limit (429) → honest 429, connection state untouched
 *  - Cross-workspace isolation on the test route (404 for foreign rows)
 *  - Disconnect revokes the provider token + reconnect works afterwards
 *  - GET /api/integrations serves the 8-state + capability matrix
 *
 * Auth is stubbed; Meta/TikTok network functions are mocked while
 * signState/verifyState, credential encryption, and the DB run for real.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomBytes } from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET as listGET } from "./route";
import { POST as testPOST } from "./[id]/test/route";
import { POST as verifyPOST } from "./[id]/verify/route";
import { POST as disconnectPOST } from "./[id]/disconnect/route";
import { GET as metaCallbackGET } from "./meta/callback/route";
import { GET as tiktokCallbackGET } from "./tiktok/callback/route";
import { encryptCredentials } from "@/lib/integrations/meta";
import { encryptTikTokCredentials, TIKTOK_REVOKE_URL } from "@/lib/integrations/tiktok";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/integrations/meta", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/integrations/meta")>();
  return {
    ...orig,
    exchangeCodeForToken: vi.fn(),
    exchangeForLongLived: vi.fn(),
    getMe: vi.fn(),
    getValidAccessToken: vi.fn(),
    verifyPage: vi.fn(),
  };
});
vi.mock("@/lib/integrations/tiktok", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/integrations/tiktok")>();
  return {
    ...orig,
    exchangeTikTokCode: vi.fn(),
    getTikTokUserInfo: vi.fn(),
  };
});

const mockedRequireUser = vi.mocked(requireUser);
const metaMod = await import("@/lib/integrations/meta");
const tiktokMod = await import("@/lib/integrations/tiktok");

process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-app-secret-for-audit";
process.env.META_VERIFY_TOKEN = "test-verify-token";
process.env.INSTAGRAM_APP_ID = "test-ig-app-id";
process.env.INSTAGRAM_APP_SECRET = "test-ig-app-secret";
process.env.TIKTOK_CLIENT_KEY = "test-client-key";
process.env.TIKTOK_CLIENT_SECRET = "test-client-secret";
process.env.APP_PUBLIC_URL = "https://example.test";

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Audit", email },
  } as any);
}

function req(url: string, workspaceId: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: { "x-workspace-id": workspaceId, "content-type": "application/json" },
  });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

function signMetaState(workspaceId: string, provider: "facebook" | "instagram" | "whatsapp") {
  return metaMod.signState({
    workspaceId,
    provider,
    nonce: randomBytes(16).toString("hex"),
    ts: Math.floor(Date.now() / 1000),
  });
}

const suffix = `aud${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsA = "";
let wsB = "";
let userA = "";
let userB = "";

beforeAll(async () => {
  const a = await db.user.create({
    data: { email: `aud-a-${suffix}@example.com`, name: "Aud A", passwordHash: "x" },
  });
  const b = await db.user.create({
    data: { email: `aud-b-${suffix}@example.com`, name: "Aud B", passwordHash: "x" },
  });
  userA = a.id;
  userB = b.id;
  const orgA = await db.organization.create({ data: { name: `Aud Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `Aud Org B ${suffix}` } });
  const wA = await db.workspace.create({
    data: { orgId: orgA.id, name: `Aud WS A ${suffix}`, slug: `aud-a-${suffix}` },
  });
  const wB = await db.workspace.create({
    data: { orgId: orgB.id, name: `Aud WS B ${suffix}`, slug: `aud-b-${suffix}` },
  });
  wsA = wA.id;
  wsB = wB.id;
  await db.membership.create({ data: { userId: a.id, workspaceId: wA.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: b.id, workspaceId: wB.id, role: "OWNER" } });
  // userA is also a member of wsB so the cross-workspace CSRF test can
  // present a state bound to wsA while "acting" in wsB.
  await db.membership.create({ data: { userId: a.id, workspaceId: wB.id, role: "MANAGER" } });
  authedAs(userA, `aud-a-${suffix}@example.com`);
});

describe("Meta OAuth callback (mocked Meta HTTP)", () => {
  it("success marks NEEDS_ATTENTION (never CONNECTED before page selection)", async () => {
    vi.mocked(metaMod.exchangeCodeForToken).mockResolvedValue({ access_token: "short" });
    vi.mocked(metaMod.exchangeForLongLived).mockResolvedValue({
      access_token: "long",
      expires_in: 5_184_000,
    });
    vi.mocked(metaMod.getMe).mockResolvedValue({ id: "me-1", name: "Me" });

    const state = signMetaState(wsA, "facebook");
    const res = await metaCallbackGET(
      req(`http://x/api/integrations/meta/callback?code=c1&state=${encodeURIComponent(state)}`, wsA)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("meta_connected=facebook");
    const row = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "facebook" },
    });
    expect(row?.status).toBe("NEEDS_ATTENTION");
  });

  it("replaying the same callback state is rejected (single-use nonce)", async () => {
    const state = signMetaState(wsA, "facebook");
    const url = `http://x/api/integrations/meta/callback?code=c2&state=${encodeURIComponent(state)}`;
    const first = await metaCallbackGET(req(url, wsA));
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toContain("meta_connected=facebook");

    const replay = await metaCallbackGET(req(url, wsA));
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain("meta_error=invalid_state");
  });

  it("denied authorization redirects with the provider's error (never connected)", async () => {
    const res = await metaCallbackGET(
      req(`http://x/api/integrations/meta/callback?error=access_denied&error_description=User+denied`, wsA)
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("meta_error=");
    expect(loc).not.toContain("meta_connected");
  });

  it("tampered state (CSRF) is rejected", async () => {
    const state = signMetaState(wsA, "facebook");
    const tampered = state.slice(0, -4) + "ffff";
    const res = await metaCallbackGET(
      req(`http://x/api/integrations/meta/callback?code=c3&state=${encodeURIComponent(tampered)}`, wsA)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("meta_error=invalid_state");
  });

  it("cross-workspace state is rejected (state bound to wsA, request in wsB)", async () => {
    const state = signMetaState(wsA, "whatsapp");
    const res = await metaCallbackGET(
      req(`http://x/api/integrations/meta/callback?code=c4&state=${encodeURIComponent(state)}`, wsB)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("Workspace+mismatch");
  });
});

describe("token expiry → NEEDS_ATTENTION + reauth_required", () => {
  it("marks the row and surfaces reauth_required on the card", async () => {
    const row = await db.integration.create({
      data: {
        workspaceId: wsA,
        provider: "whatsapp",
        status: "CONNECTED",
        verifiedAt: new Date(),
        encryptedCredentials: encryptCredentials({
          provider: "whatsapp",
          accessToken: "expired-token",
          expiresAt: new Date(Date.now() - 10_000).toISOString(),
          phoneNumberId: "pn-1",
        }),
      },
    });
    vi.mocked(metaMod.getValidAccessToken).mockRejectedValue(
      new metaMod.MetaTokenExpiredError("expired")
    );

    const { status, body } = await jsonBody(
      await testPOST(req(`http://x/api/integrations/${row.id}/test`, wsA, { method: "POST" }), {
        params: { id: row.id },
      })
    );
    expect(status).toBe(401);
    expect(body.error).toContain("Token expired");

    const updated = await db.integration.findUnique({ where: { id: row.id } });
    expect(updated?.status).toBe("NEEDS_ATTENTION");
    expect(JSON.parse(updated?.statusDetail ?? "{}").code).toBe("token_expired");

    const list = await jsonBody(await listGET(req("http://x/api/integrations", wsA)));
    const wa = list.body.data.integrations.find((r: any) => r.provider === "whatsapp");
    expect(wa.connectionState).toBe("reauth_required");
    expect(wa.statusDetailMessage).toContain("Token expired");
    // No capability may show as available while reauth is required.
    const send = wa.capabilitiesDetail.find((c: any) => c.key === "send_messages");
    expect(send.state).toBe("not_connected");
  });
});

describe("permission revocation → permission_missing", () => {
  it("Meta code 200 flips the card to permission_missing (never stays green)", async () => {
    const existingRow = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "facebook" },
    });
    const row = existingRow
      ? await db.integration.update({ where: { id: existingRow.id }, data: {
        status: "CONNECTED",
        verifiedAt: new Date(),
        statusDetail: null,
        encryptedCredentials: encryptCredentials({
          provider: "facebook",
          accessToken: "tok",
          expiresAt: null,
          pageId: "page-9",
          pageAccessToken: "page-tok",
        }),
      } })
      : await db.integration.create({ data: {
        workspaceId: wsA,
        provider: "facebook",
        status: "CONNECTED",
        verifiedAt: new Date(),
        encryptedCredentials: encryptCredentials({
          provider: "facebook",
          accessToken: "tok",
          expiresAt: null,
          pageId: "page-9",
          pageAccessToken: "page-tok",
        }),
      } });
    vi.mocked(metaMod.getValidAccessToken).mockResolvedValue({
      token: "tok",
      refreshed: false,
      newExpiresAt: null,
    });
    vi.mocked(metaMod.verifyPage).mockRejectedValue(
      new metaMod.MetaApiError("Permissions error", 200)
    );

    const { status, body } = await jsonBody(
      await verifyPOST(req(`http://x/api/integrations/${row.id}/verify`, wsA, { method: "POST" }), {
        params: { id: row.id },
      })
    );
    expect(status).toBe(403);
    expect(body.error).toContain("permission was revoked");

    const list = await jsonBody(await listGET(req("http://x/api/integrations", wsA)));
    const fb = list.body.data.integrations.find((r: any) => r.provider === "facebook");
    expect(fb.connectionState).toBe("permission_missing");
  });
});

describe("rate-limit (429) handling", () => {
  it("returns 429 and leaves the connection state untouched", async () => {
    const existingRow = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "facebook" },
    });
    const row = existingRow
      ? await db.integration.update({ where: { id: existingRow.id }, data: {
        status: "CONNECTED",
        verifiedAt: new Date(),
        statusDetail: null,
        encryptedCredentials: encryptCredentials({
          provider: "facebook",
          accessToken: "tok",
          expiresAt: null,
          pageId: "page-9",
          pageAccessToken: "page-tok",
        }),
      } })
      : await db.integration.create({ data: {
        workspaceId: wsA,
        provider: "facebook",
        status: "CONNECTED",
        verifiedAt: new Date(),
        encryptedCredentials: encryptCredentials({
          provider: "facebook",
          accessToken: "tok",
          expiresAt: null,
          pageId: "page-9",
          pageAccessToken: "page-tok",
        }),
      } });
    vi.mocked(metaMod.getValidAccessToken).mockRejectedValue(
      new metaMod.MetaRetryableError("slow down", 80007, 429)
    );

    const { status, body } = await jsonBody(
      await testPOST(req(`http://x/api/integrations/${row.id}/test`, wsA, { method: "POST" }), {
        params: { id: row.id },
      })
    );
    expect(status).toBe(429);
    expect(body.error).toContain("rate limit");

    const list = await jsonBody(await listGET(req("http://x/api/integrations", wsA)));
    const fb = list.body.data.integrations.find((r: any) => r.provider === "facebook");
    // Transient limit: the card must NOT flip to failed.
    expect(fb.connectionState).toBe("connected");
    expect(fb.statusDetailMessage).toBeNull();
  });
});

describe("cross-workspace isolation on the test route", () => {
  it("404s for another workspace's integration", async () => {
    const row = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "facebook" },
    });
    authedAs(userB, `aud-b-${suffix}@example.com`);
    const { status } = await jsonBody(
      await testPOST(req(`http://x/api/integrations/${row!.id}/test`, wsB, { method: "POST" }), {
        params: { id: row!.id },
      })
    );
    expect(status).toBe(404);
    authedAs(userA, `aud-a-${suffix}@example.com`);
  });
});

describe("disconnect revokes + reconnect works (TikTok, mocked HTTP)", () => {
  it("revokes provider-side before wiping local credentials", async () => {
    const existingRow = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "tiktok" },
    });
    const row = existingRow
      ? await db.integration.update({ where: { id: existingRow.id }, data: {
        status: "CONNECTED",
        verifiedAt: new Date(),
        statusDetail: null,
        accountName: "Old Name",
        encryptedCredentials: encryptTikTokCredentials({
          provider: "tiktok",
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: null,
          openId: "open-old",
        }),
      } })
      : await db.integration.create({ data: {
        workspaceId: wsA,
        provider: "tiktok",
        status: "CONNECTED",
        verifiedAt: new Date(),
        accountName: "Old Name",
        encryptedCredentials: encryptTikTokCredentials({
          provider: "tiktok",
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: null,
          openId: "open-old",
        }),
      } });
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any = {}) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({}) };
      })
    );

    const { status } = await jsonBody(
      await disconnectPOST(
        req(`http://x/api/integrations/${row.id}/disconnect`, wsA, { method: "POST" }),
        { params: { id: row.id } }
      )
    );
    expect(status).toBe(200);
    expect(calls.some((c) => String(c.url) === TIKTOK_REVOKE_URL)).toBe(true);

    const updated = await db.integration.findUnique({ where: { id: row.id } });
    expect(updated?.status).toBe("DISCONNECTED");
    expect(updated?.encryptedCredentials).toBeNull();
    expect(updated?.statusDetail).toBeNull();
    vi.unstubAllGlobals();
  });

  it("reconnect completes the full OAuth callback after disconnect", async () => {
    vi.mocked(tiktokMod.exchangeTikTokCode).mockResolvedValue({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 7200,
      open_id: "open-new",
      scope: "user.info.basic",
      token_type: "Bearer",
    });
    vi.mocked(tiktokMod.getTikTokUserInfo).mockResolvedValue({
      openId: "open-new",
      displayName: "New Name",
      username: "newname",
      avatarUrl: "https://example.test/a.png",
    });

    const state = tiktokMod.signTikTokState({
      workspaceId: wsA,
      nonce: randomBytes(16).toString("hex"),
      ts: Math.floor(Date.now() / 1000),
    });
    const res = await tiktokCallbackGET(
      req(`http://x/api/integrations/tiktok/callback?code=newcode&state=${encodeURIComponent(state)}`, wsA)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("tiktok_connected=1");

    const row = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "tiktok", externalAccountId: "open-new" },
    });
    expect(row?.status).toBe("CONNECTED");
    expect(row?.accountName).toBe("New Name");
    const creds = tiktokMod.decryptTikTokCredentials(row!.encryptedCredentials!);
    expect(creds.accessToken).toBe("new-access");

    const list = await jsonBody(await listGET(req("http://x/api/integrations", wsA)));
    const tt = list.body.data.integrations.find((r: any) => r.provider === "tiktok");
    expect(tt.connectionState).toBe("connected");
    // TikTok Login Kit = identity only: every capability stays unavailable.
    for (const c of tt.capabilitiesDetail) {
      expect(c.state).toBe("unavailable");
    }
  });
});

describe("GET /api/integrations — 8-state + capability matrix", () => {
  it("serves connectionState + 8 capabilities per provider", async () => {
    // Healthy CONNECTED instagram row (Business Login shape).
    const existingRow = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "instagram" },
    });
    if (existingRow) {
      await db.integration.update({ where: { id: existingRow.id }, data: {
        status: "CONNECTED",
        verifiedAt: new Date(),
        statusDetail: null,
        encryptedCredentials: encryptCredentials({
          provider: "instagram",
          loginType: "instagram_login",
          accessToken: "ig-tok",
          expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
          igUserId: "ig-1",
          igUsername: "iguser",
        }),
      } });
    } else {
      await db.integration.create({ data: {
        workspaceId: wsA,
        provider: "instagram",
        status: "CONNECTED",
        verifiedAt: new Date(),
        statusDetail: null,
        encryptedCredentials: encryptCredentials({
          provider: "instagram",
          loginType: "instagram_login",
          accessToken: "ig-tok",
          expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
          igUserId: "ig-1",
          igUsername: "iguser",
        }),
      } });
    }

    const { status, body } = await jsonBody(await listGET(req("http://x/api/integrations", wsA)));
    expect(status).toBe(200);
    const rows = body.data.integrations;
    expect(rows).toHaveLength(12);
    const validStates = new Set([
      "not_connected", "connecting", "connected", "partial",
      "permission_missing", "reauth_required", "unavailable", "failed",
    ]);
    for (const r of rows) {
      expect(validStates.has(r.connectionState), `${r.provider}: ${r.connectionState}`).toBe(true);
      expect(r.capabilitiesDetail).toHaveLength(8);
      for (const c of r.capabilitiesDetail) {
        expect(["available", "limited", "unavailable", "not_connected", "simulated"]).toContain(c.state);
        expect(typeof c.note).toBe("string");
      }
      expect(typeof r.envConfigured).toBe("boolean");
    }

    const ig = rows.find((r: any) => r.provider === "instagram");
    expect(ig.connectionState).toBe("connected");
    expect(ig.envConfigured).toBe(true);
    const byKey = Object.fromEntries(ig.capabilitiesDetail.map((c: any) => [c.key, c.state]));
    expect(byKey.read_events).toBe("available");
    expect(byKey.send_messages).toBe("limited");
    expect(byKey.manage_ads).toBe("unavailable");

    // A never-touched simulated provider: not_connected + simulated caps only where supported.
    const tg = rows.find((r: any) => r.provider === "telegram");
    expect(tg.connectionState).toBe("not_connected");
    expect(tg.simulated).toBe(true);
    const tgSend = tg.capabilitiesDetail.find((c: any) => c.key === "send_messages");
    expect(tgSend.state).toBe("not_connected");
  });

  it("never shows connected when credentials are corrupted", async () => {
    const existingRow = await db.integration.findFirst({
      where: { workspaceId: wsB, provider: "facebook" },
    });
    if (existingRow) {
      await db.integration.update({ where: { id: existingRow.id }, data: { status: "CONNECTED", verifiedAt: new Date(), encryptedCredentials: "corrupted" } });
    } else {
      await db.integration.create({ data: {
        workspaceId: wsB,
        provider: "facebook",
        status: "CONNECTED",
        verifiedAt: new Date(),
        encryptedCredentials: "corrupted",
      } });
    }
    authedAs(userB, `aud-b-${suffix}@example.com`);
    const { body } = await jsonBody(await listGET(req("http://x/api/integrations", wsB)));
    const fb = body.data.integrations.find((r: any) => r.provider === "facebook");
    expect(fb.connectionState).toBe("failed");
    authedAs(userA, `aud-a-${suffix}@example.com`);
  });
});
