/**
 * TikTok OAuth route tests (mocked HTTP — no real TikTok traffic).
 *
 * Covers the full callback contract: success only after token exchange +
 * identity + persistence; denied/invalid-state/exchange-failure/persistence-
 * failure all redirect with tiktok_error and NEVER mark the provider
 * connected. Also: authorize creates NEEDS_ATTENTION (not CONNECTED), and
 * the test route marks NEEDS_ATTENTION on expired tokens.
 *
 * Auth is stubbed (same pattern as stage2.test.ts); DB is the fresh
 * test.db per run.
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { POST as authorizePOST } from "./authorize/route";
import { GET as callbackGET } from "./callback/route";
import { POST as testPOST } from "../[id]/test/route";
import {
  signTikTokState,
  encryptTikTokCredentials,
  tiktokRedirectUri,
  resetUsedTikTokStateNonces,
} from "@/lib/integrations/tiktok";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

process.env.TIKTOK_CLIENT_KEY = "test-client-key";
process.env.TIKTOK_CLIENT_SECRET = "test-client-secret-0123456789abcdef";
process.env.APP_PUBLIC_URL = "https://example.test";

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  } as any);
}

function req(url: string, workspaceId: string, init?: { method?: string }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    headers: { "x-workspace-id": workspaceId },
  });
}

const suffix = `tt${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let wsId = "";
let wsId2 = "";

beforeAll(async () => {
  const u = await db.user.create({
    data: { email: `tt-${suffix}@example.com`, name: "TT", passwordHash: "x" },
  });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `TT Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `TT WS ${suffix}`, slug: `tt-${suffix}` },
  });
  const w2 = await db.workspace.create({
    data: { orgId: org.id, name: `TT WS2 ${suffix}`, slug: `tt2-${suffix}` },
  });
  wsId = w.id;
  wsId2 = w2.id;
  await db.membership.create({ data: { userId: u.id, workspaceId: w.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: u.id, workspaceId: w2.id, role: "OWNER" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetchSequence(
  tokenData: unknown,
  userData: unknown,
  tokenOpts: { ok?: boolean; status?: number } = {}
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/oauth/token/")) {
        return {
          ok: tokenOpts.ok ?? true,
          status: tokenOpts.status ?? 200,
          json: async () => tokenData,
        };
      }
      return { ok: true, status: 200, json: async () => userData };
    })
  );
}

const goodToken = {
  access_token: "tok-abc",
  refresh_token: "ref-abc",
  expires_in: 86400,
  open_id: "open-abc",
  scope: "user.info.basic",
  token_type: "Bearer",
};
const goodUser = {
  data: {
    user: {
      open_id: "open-abc",
      display_name: "Acme Shop",
      username: "acme.shop",
      avatar_url: "https://example.test/a.png",
    },
  },
};

async function row(externalAccountId?: string) {
  // Batch B: a workspace can hold several tiktok rows (the authorize
  // placeholder with a null external id plus one row per connected
  // account), so callers that mean a specific account pass its id.
  return db.integration.findFirst({
    where: {
      workspaceId: wsId,
      provider: "tiktok",
      ...(externalAccountId ? { externalAccountId } : {}),
    },
  });
}

describe("POST /api/integrations/tiktok/authorize", () => {
  it("returns the TikTok authorize URL and records NEEDS_ATTENTION (not connected)", async () => {
    authedAs(userId, `tt-${suffix}@example.com`);
    const res = await authorizePOST(req("http://x/api/integrations/tiktok/authorize", wsId, { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.url).toContain("https://www.tiktok.com/v2/auth/authorize/");
    expect(body.data.url).toContain(encodeURIComponent(tiktokRedirectUri()));
    const r = await row();
    expect(r?.status).toBe("NEEDS_ATTENTION");
    expect(r?.status).not.toBe("CONNECTED");
  });
});

describe("GET /api/integrations/tiktok/callback", () => {
  // Single-use state: the suite reuses a fixed "n1" nonce, so clear the
  // consumed-nonce store between cases (production states use fresh
  // random nonces, so this does not weaken the protection).
  beforeEach(() => resetUsedTikTokStateNonces());

  function cbUrl(params: string) {
    return `http://x/api/integrations/tiktok/callback?${params}`;
  }
  function stateFor(ws: string) {
    return signTikTokState({ workspaceId: ws, nonce: "n1", ts: Math.floor(Date.now() / 1000) });
  }

  it("denied authorization → tiktok_error redirect, never connected", async () => {
    authedAs(userId, `tt-${suffix}@example.com`);
    const res = await callbackGET(
      req(cbUrl("error=access_denied&error_description=user+denied"), wsId)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("tiktok_error=");
    const r = await row();
    expect(r?.status).not.toBe("CONNECTED");
  });

  it("missing code/state → tiktok_error", async () => {
    authedAs(userId, `tt-${suffix}@example.com`);
    const res = await callbackGET(req(cbUrl("code=only-code"), wsId));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("tiktok_error=");
  });

  it("invalid state → tiktok_error=invalid_state", async () => {
    authedAs(userId, `tt-${suffix}@example.com`);
    const res = await callbackGET(req(cbUrl("code=c&state=tampered.payload"), wsId));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("tiktok_error=invalid_state");
  });

  it("workspace mismatch → tiktok_error (tenant binding)", async () => {
    authedAs(userId, `tt-${suffix}@example.com`);
    const res = await callbackGET(
      req(cbUrl(`code=c&state=${encodeURIComponent(stateFor(wsId2))}`), wsId)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("tiktok_error=");
  });

  it("token exchange failure → tiktok_error, never marked connected", async () => {
    authedAs(userId, `tt-${suffix}@example.com`);
    stubFetchSequence(
      { error: "invalid_grant", error_description: "code expired" },
      goodUser,
      { ok: false, status: 400 }
    );
    const res = await callbackGET(
      req(cbUrl(`code=bad&state=${encodeURIComponent(stateFor(wsId))}`), wsId)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("tiktok_error=");
    const r = await row();
    expect(r?.status).not.toBe("CONNECTED");
  });

  it("persistence failure → tiktok_error, never marked connected", async () => {
    authedAs(userId, `tt-${suffix}@example.com`);
    stubFetchSequence(goodToken, goodUser);
    // Manual save/restore: vi.spyOn does not reliably restore Prisma's
    // proxied delegates across tests.
    // Batch C: persistence runs inside a Prisma interactive transaction
    // (withConnectedAccountSlot — the account-count check and the insert
    // are atomic), so the transaction client's create can no longer be
    // intercepted via the global delegate. Fail $transaction itself to
    // simulate the DB being down at persistence time.
    const client = db as any;
    const origTransaction = client.$transaction;
    client.$transaction = async () => {
      throw new Error("db down");
    };
    try {
      const res = await callbackGET(
        req(cbUrl(`code=c&state=${encodeURIComponent(stateFor(wsId))}`), wsId)
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("tiktok_error=");
    } finally {
      client.$transaction = origTransaction;
    }
    const r = await row();
    expect(r?.status).not.toBe("CONNECTED");
  });

  it("success → tiktok_connected, CONNECTED only after persistence, identity stored", async () => {
    authedAs(userId, `tt-${suffix}@example.com`);
    stubFetchSequence(goodToken, goodUser);
    const res = await callbackGET(
      req(cbUrl(`code=good&state=${encodeURIComponent(stateFor(wsId))}`), wsId)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("tiktok_connected=1");
    const r = await row("open-abc");
    expect(r?.status).toBe("CONNECTED");
    expect(r?.accountName).toBe("Acme Shop");
    expect(r?.accountAvatarUrl).toBe("https://example.test/a.png");
    expect(r?.externalAccountId).toBe("open-abc");
    expect(r?.verifiedAt).toBeTruthy();
    // Credentials are encrypted at rest — no plaintext token stored.
    expect(r?.encryptedCredentials).toBeTruthy();
    expect(r?.encryptedCredentials).not.toContain("tok-abc");
  });
});

describe("POST /api/integrations/[id]/test (tiktok)", () => {
  it("expired token → NEEDS_ATTENTION and 401 (reauthorization required)", async () => {
    authedAs(userId, `tt-${suffix}@example.com`);
    const r0 = await row();
    // Seed an expired credential set (no refresh token → refresh impossible).
    await db.integration.update({
      where: { id: r0!.id },
      data: {
        status: "CONNECTED",
        encryptedCredentials: encryptTikTokCredentials({
          provider: "tiktok",
          accessToken: "stale",
          refreshToken: "",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          openId: "open-abc",
        }),
      },
    });
    const res = await testPOST(
      req(`http://x/api/integrations/${r0!.id}/test`, wsId, { method: "POST" }),
      { params: { id: r0!.id } }
    );
    expect(res.status).toBe(401);
    const r = await row();
    expect(r?.status).toBe("NEEDS_ATTENTION");
  });
});
