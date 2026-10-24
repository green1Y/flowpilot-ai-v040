/**
 * Meta OAuth callback route tests (mocked Meta HTTP).
 *
 * Covers: denied authorization, missing code/state, invalid state, workspace
 * mismatch, token-exchange failure (never marked connected), and the success
 * path (NEEDS_ATTENTION row + redirect). Network functions are mocked;
 * signState/verifyState and credential encryption run for real.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET } from "./callback/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/integrations/meta", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/integrations/meta")>();
  return {
    ...orig,
    exchangeCodeForToken: vi.fn(),
    exchangeForLongLived: vi.fn(),
    getMe: vi.fn(),
  };
});
vi.mock("@/lib/integrations/instagram-login", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("@/lib/integrations/instagram-login")>();
  return {
    ...orig,
    exchangeInstagramCode: vi.fn(),
    exchangeInstagramLongLived: vi.fn(),
    getInstagramLoginUser: vi.fn(),
    subscribeInstagramWebhooks: vi.fn(),
  };
});

const mockedRequireUser = vi.mocked(requireUser);
// Real signState/verifyState/metaEnv/encryptCredentials preserved.
const metaMod = await import("@/lib/integrations/meta");
const mockedExchange = vi.mocked(metaMod.exchangeCodeForToken);
const mockedLongLived = vi.mocked(metaMod.exchangeForLongLived);
const mockedGetMe = vi.mocked(metaMod.getMe);
const igLoginMod = await import("@/lib/integrations/instagram-login");
const mockedIgExchange = vi.mocked(igLoginMod.exchangeInstagramCode);
const mockedIgLongLived = vi.mocked(igLoginMod.exchangeInstagramLongLived);
const mockedIgUser = vi.mocked(igLoginMod.getInstagramLoginUser);
const mockedIgSubscribe = vi.mocked(igLoginMod.subscribeInstagramWebhooks);

process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-secret-0123456789abcdef";
process.env.META_VERIFY_TOKEN = "test-verify";
process.env.APP_PUBLIC_URL = "https://example.test";

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "CB Test", email },
  } as any);
}

function get(url: string, workspaceId: string): NextRequest {
  return new NextRequest(url, {
    headers: { "x-workspace-id": workspaceId },
  });
}

const suffix = `cb${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsA = "";
let wsB = "";
let userA = "";
let userB = "";

beforeAll(async () => {
  const a = await db.user.create({
    data: { email: `cb-a-${suffix}@example.com`, name: "CB A", passwordHash: "x" },
  });
  const b = await db.user.create({
    data: { email: `cb-b-${suffix}@example.com`, name: "CB B", passwordHash: "x" },
  });
  userA = a.id;
  userB = b.id;
  const orgA = await db.organization.create({ data: { name: `CB Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `CB Org B ${suffix}` } });
  const wA = await db.workspace.create({
    data: { orgId: orgA.id, name: `CB WS A ${suffix}`, slug: `cb-a-${suffix}` },
  });
  const wB = await db.workspace.create({
    data: { orgId: orgB.id, name: `CB WS B ${suffix}`, slug: `cb-b-${suffix}` },
  });
  wsA = wA.id;
  wsB = wB.id;
  await db.membership.create({ data: { userId: a.id, workspaceId: wA.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: b.id, workspaceId: wB.id, role: "OWNER" } });
});

function validState(workspaceId: string) {
  return metaMod.signState({
    workspaceId,
    provider: "facebook",
    nonce: `n-${Math.random()}`,
    ts: Math.floor(Date.now() / 1000),
  });
}

function validInstagramState(workspaceId: string) {
  return metaMod.signState({
    workspaceId,
    provider: "instagram",
    nonce: `ig-${Math.random()}`,
    ts: Math.floor(Date.now() / 1000),
  });
}

describe("Meta OAuth callback", () => {
  it("redirects with meta_error when the user denies authorization", async () => {
    authedAs(userA, `cb-a-${suffix}@example.com`);
    const res = await GET(
      get("https://example.test/api/integrations/meta/callback?error=access_denied&error_description=denied", wsA),
      {} as any
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("meta_error=");
  });

  it("redirects with meta_error when code or state is missing", async () => {
    authedAs(userA, `cb-a-${suffix}@example.com`);
    const res = await GET(
      get("https://example.test/api/integrations/meta/callback?code=abc", wsA),
      {} as any
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("meta_error=");
  });

  it("redirects with meta_error=invalid_state on tampered state", async () => {
    authedAs(userA, `cb-a-${suffix}@example.com`);
    const [payloadB64, sig] = validState(wsA).split(".");
    const tampered = (payloadB64[0] === "A" ? "B" : "A") + payloadB64.slice(1);
    const res = await GET(
      get(`https://example.test/api/integrations/meta/callback?code=abc&state=${tampered}.${sig}`, wsA),
      {} as any
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("meta_error=invalid_state");
  });

  it("rejects workspace mismatch between state and session", async () => {
    // State bound to wsA, but the signed-in user acts as wsB.
    authedAs(userB, `cb-b-${suffix}@example.com`);
    const res = await GET(
      get(`https://example.test/api/integrations/meta/callback?code=abc&state=${validState(wsA)}`, wsB),
      {} as any
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("meta_error=");
  });

  it("never marks connected when token exchange fails", async () => {
    authedAs(userA, `cb-a-${suffix}@example.com`);
    mockedExchange.mockRejectedValueOnce(new metaMod.MetaApiError("bad code", 400));
    const res = await GET(
      get(`https://example.test/api/integrations/meta/callback?code=bad&state=${validState(wsA)}`, wsA),
      {} as any
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("meta_error=");
    const row = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "facebook" },
    });
    expect(row?.status).not.toBe("CONNECTED");
  });

  it("on success stores NEEDS_ATTENTION and redirects with meta_connected", async () => {
    authedAs(userA, `cb-a-${suffix}@example.com`);
    mockedExchange.mockResolvedValueOnce({ access_token: "short-tok", token_type: "bearer" } as any);
    mockedLongLived.mockResolvedValueOnce({ access_token: "long-tok", expires_in: 5184000 } as any);
    mockedGetMe.mockResolvedValueOnce({ id: "me-123", name: "Test Page Owner" });
    const res = await GET(
      get(`https://example.test/api/integrations/meta/callback?code=good&state=${validState(wsA)}`, wsA),
      {} as any
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("meta_connected=facebook");
    const row = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "facebook" },
    });
    // Page selection still pending — must NOT be CONNECTED yet.
    expect(row?.status).toBe("NEEDS_ATTENTION");
    expect(row?.encryptedCredentials).toBeTruthy();
  });
});

describe("Meta OAuth callback — Instagram Business Login", () => {
  it("on success stores CONNECTED with instagram_login credentials", async () => {
    authedAs(userA, `cb-a-${suffix}@example.com`);
    mockedIgExchange.mockResolvedValueOnce({
      access_token: "ig-short",
      user_id: "ig_42",
      permissions: "instagram_business_basic",
    });
    mockedIgLongLived.mockResolvedValueOnce({
      access_token: "ig-long",
      token_type: "bearer",
      expires_in: 5183944,
    });
    mockedIgUser.mockResolvedValueOnce({
      id: "ig_42",
      username: "testbrand",
      name: "Test Brand",
      profile_picture_url: "https://example.test/pic.jpg",
    });
    mockedIgSubscribe.mockResolvedValueOnce(true);

    const res = await GET(
      get(`https://example.test/api/integrations/meta/callback?code=ig-good&state=${validInstagramState(wsA)}`, wsA),
      {} as any
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("meta_connected=instagram");

    const row = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "instagram", externalAccountId: "ig_42" },
    });
    // No Page-selection step — identity verified at callback time.
    expect(row?.status).toBe("CONNECTED");
    expect(row?.externalAccountId).toBe("ig_42");
    expect(row?.accountName).toBe("testbrand");
    expect(row?.accountAvatarUrl).toBe("https://example.test/pic.jpg");
    const creds = metaMod.decryptCredentials(row?.encryptedCredentials as string);
    expect(creds.provider).toBe("instagram");
    expect(creds.loginType).toBe("instagram_login");
    expect(creds.accessToken).toBe("ig-long");
    expect(creds.igUserId).toBe("ig_42");
    expect(creds.igUsername).toBe("testbrand");
    expect(creds.pageAccessToken).toBeUndefined();
    // Webhook subscription was attempted for the IG account.
    expect(mockedIgSubscribe).toHaveBeenCalledWith("ig_42", "ig-long");
  });

  it("never marks connected when the Instagram exchange fails", async () => {
    // Use wsB (no instagram row yet) so a pre-existing connection can't mask this.
    authedAs(userB, `cb-b-${suffix}@example.com`);
    mockedIgExchange.mockRejectedValueOnce(
      new metaMod.MetaApiError("Matching code was not found or was already used", 400)
    );
    const res = await GET(
      get(`https://example.test/api/integrations/meta/callback?code=ig-bad&state=${validInstagramState(wsB)}`, wsB),
      {} as any
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("meta_error=");
    const row = await db.integration.findFirst({
      where: { workspaceId: wsB, provider: "instagram" },
    });
    expect(row?.status).not.toBe("CONNECTED");
  });

  it("still connects when webhook subscription fails (best-effort)", async () => {
    authedAs(userA, `cb-a-${suffix}@example.com`);
    mockedIgExchange.mockResolvedValueOnce({
      access_token: "ig-short-2",
      user_id: "ig_43",
    });
    mockedIgLongLived.mockResolvedValueOnce({
      access_token: "ig-long-2",
      expires_in: 5183944,
    });
    mockedIgUser.mockResolvedValueOnce({ id: "ig_43", username: "brand2" });
    mockedIgSubscribe.mockRejectedValueOnce(new Error("webhook down"));

    const res = await GET(
      get(`https://example.test/api/integrations/meta/callback?code=ig-ok2&state=${validInstagramState(wsA)}`, wsA),
      {} as any
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("meta_connected=instagram");
    const row = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "instagram", externalAccountId: "ig_43" },
    });
    expect(row?.status).toBe("CONNECTED");
  });
});
