/**
 * Instagram Business Login tests (mocked HTTP).
 *
 * Covers the CURRENT Meta flow (Instagram API with Instagram Login):
 * authorize URL, token exchange (+ OAuthException error shape), long-lived
 * exchange, refresh, identity lookup, and webhook subscription.
 * No real Meta traffic happens here.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildInstagramLoginUrl,
  exchangeInstagramCode,
  exchangeInstagramLongLived,
  getInstagramLoginUser,
  INSTAGRAM_LOGIN_SCOPES,
  instagramLoginCallbackUrl,
  instagramLoginEnv,
  refreshInstagramToken,
  sanitizeMetaResponseForLog,
  subscribeInstagramWebhooks,
} from "./instagram-login";
import { verifyState, MetaApiError, MetaTokenExpiredError, MetaRetryableError } from "./meta";
import { InstagramAdapter } from "./instagram";

// ---- test-only env (metaEnv() is read lazily by every helper) ----
process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-secret-0123456789abcdef";
process.env.META_VERIFY_TOKEN = "test-verify-token";
process.env.APP_PUBLIC_URL = "https://example.test";
process.env.INSTAGRAM_APP_ID = "ig-app-id-123";
process.env.INSTAGRAM_APP_SECRET = "ig-secret-abc";

// ---------------------------------------------------------------------------
// fetch stub plumbing
// ---------------------------------------------------------------------------
interface CapturedCall {
  url: string;
  init: RequestInit;
}
let calls: CapturedCall[] = [];

function stubFetchJson(data: unknown, opts: { ok?: boolean; status?: number } = {}) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        json: async () => data,
      };
    })
  );
}

function stubFetchFormCapture() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ access_token: "short-tok", user_id: "ig_42", permissions: "instagram_business_basic" }],
        }),
      };
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 0. Credential validation — no silent fallback to the Facebook App ID
// ---------------------------------------------------------------------------
describe("instagramLoginEnv", () => {
  it("fails fast when INSTAGRAM_APP_ID/SECRET are missing", () => {
    const savedId = process.env.INSTAGRAM_APP_ID;
    const savedSecret = process.env.INSTAGRAM_APP_SECRET;
    delete process.env.INSTAGRAM_APP_ID;
    delete process.env.INSTAGRAM_APP_SECRET;
    try {
      expect(() => instagramLoginEnv()).toThrow(/INSTAGRAM_APP_ID/);
      expect(() => buildInstagramLoginUrl("w1")).toThrow(/INSTAGRAM_APP_ID/);
    } finally {
      process.env.INSTAGRAM_APP_ID = savedId;
      process.env.INSTAGRAM_APP_SECRET = savedSecret;
    }
  });

  it("never falls back to META_APP_ID", () => {
    // Regression: the old fallback sent the Facebook App ID as client_id,
    // which Meta rejects with "Invalid platform app".
    const env = instagramLoginEnv();
    expect(env.appId).toBe("ig-app-id-123");
    expect(env.appId).not.toBe(process.env.META_APP_ID);
  });
});

// ---------------------------------------------------------------------------
// 1. Authorize URL
// ---------------------------------------------------------------------------
describe("buildInstagramLoginUrl", () => {
  it("uses the Instagram authorization host (not facebook.com)", () => {
    const url = new URL(buildInstagramLoginUrl("w1"));
    expect(url.origin).toBe("https://www.instagram.com");
    expect(url.pathname).toBe("/oauth/authorize");
  });

  it("requests the Business Login scopes", () => {
    expect([...INSTAGRAM_LOGIN_SCOPES]).toEqual([
      "instagram_business_basic",
      "instagram_business_manage_messages",
      "instagram_business_manage_comments",
    ]);
    const scopes = new URL(buildInstagramLoginUrl("w1")).searchParams
      .get("scope")
      ?.split(",");
    expect(scopes).toEqual([...INSTAGRAM_LOGIN_SCOPES]);
  });

  it("uses the Instagram App ID and the shared callback URL", () => {
    const url = new URL(buildInstagramLoginUrl("w1"));
    expect(url.searchParams.get("client_id")).toBe("ig-app-id-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.test/api/integrations/meta/callback"
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    // State is signed and verifiable.
    const st = verifyState(url.searchParams.get("state") as string);
    expect(st.workspaceId).toBe("w1");
    expect(st.provider).toBe("instagram");
  });

  it("instagramLoginCallbackUrl matches the authorize redirect_uri", () => {
    expect(instagramLoginCallbackUrl()).toBe(
      "https://example.test/api/integrations/meta/callback"
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Token exchange
// ---------------------------------------------------------------------------
describe("exchangeInstagramCode", () => {
  it("POSTs form fields to api.instagram.com and parses the data array", async () => {
    stubFetchFormCapture();
    const data = await exchangeInstagramCode(
      "auth-code",
      "https://example.test/api/integrations/meta/callback"
    );
    expect(data.access_token).toBe("short-tok");
    expect(data.user_id).toBe("ig_42");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.instagram.com/oauth/access_token");
    expect(calls[0].init.method).toBe("POST");
    const form = calls[0].init.body as URLSearchParams;
    expect(form.get("client_id")).toBe("ig-app-id-123");
    expect(form.get("client_secret")).toBe("ig-secret-abc");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("redirect_uri")).toBe(
      "https://example.test/api/integrations/meta/callback"
    );
  });

  it("maps the OAuthException error shape (not the graph error shape)", async () => {
    stubFetchJson(
      {
        error_type: "OAuthException",
        code: 400,
        error_message: "Matching code was not found or was already used",
      },
      { ok: false, status: 400 }
    );
    await expect(
      exchangeInstagramCode("bad", "https://example.test/api/integrations/meta/callback")
    ).rejects.toThrow("Matching code was not found or was already used");
  });

  it("throws when the data array has no access_token", async () => {
    stubFetchJson({ data: [] });
    await expect(
      exchangeInstagramCode("x", "https://example.test/api/integrations/meta/callback")
    ).rejects.toThrow(MetaApiError);
  });

  it("accepts a top-level (unwrapped) token response", async () => {
    // Some Meta responses return the token without the data wrapper.
    stubFetchJson({ access_token: "top-tok", user_id: "ig_77" });
    const data = await exchangeInstagramCode(
      "code",
      "https://example.test/api/integrations/meta/callback"
    );
    expect(data.access_token).toBe("top-tok");
    expect(data.user_id).toBe("ig_77");
  });

  it("logs a sanitized diagnostic (no secrets) on 200 without token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stubFetchJson({ unexpected: "shape" });
      await expect(
        exchangeInstagramCode("x", "https://example.test/api/integrations/meta/callback")
      ).rejects.toThrow("no access_token");
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((c) => String(c[0])).join(" ");
      expect(logged).toContain("HTTP 200");
      expect(logged).not.toContain("ig-secret-abc");
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 2b. Response sanitizer — never leaks secrets into logs
// ---------------------------------------------------------------------------
describe("sanitizeMetaResponseForLog", () => {
  it("redacts token/secret/code values and truncates", () => {
    const out = sanitizeMetaResponseForLog({
      access_token: "EAACEdEose0c0",
      client_secret: "s3cr3t",
      code: "AQBx-hBs",
      ok: true,
    });
    expect(out).not.toContain("EAACEdEose0c0");
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("AQBx-hBs");
    expect(out).toContain("[redacted]");
  });

  it("truncates long bodies", () => {
    const out = sanitizeMetaResponseForLog({ blob: "x".repeat(2000) });
    expect(out.length).toBeLessThan(600);
    expect(out).toContain("[truncated]");
  });
});

// ---------------------------------------------------------------------------
// 3. Long-lived exchange + refresh
// ---------------------------------------------------------------------------
describe("exchangeInstagramLongLived / refreshInstagramToken", () => {
  it("calls the unversioned graph.instagram.com endpoint with ig_exchange_token", async () => {
    stubFetchJson({ access_token: "long-tok", token_type: "bearer", expires_in: 5183944 });
    const res = await exchangeInstagramLongLived("short-tok");
    expect(res.access_token).toBe("long-tok");
    const url = new URL(calls[0].url);
    expect(url.origin).toBe("https://graph.instagram.com");
    // Unversioned per Meta docs.
    expect(url.pathname).toBe("/access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(url.searchParams.get("client_secret")).toBe("ig-secret-abc");
    expect(url.searchParams.get("access_token")).toBe("short-tok");
  });

  it("refreshes via ig_refresh_token on the unversioned endpoint", async () => {
    stubFetchJson({ access_token: "refreshed-tok", expires_in: 5183944 });
    const res = await refreshInstagramToken("old-tok");
    expect(res.access_token).toBe("refreshed-tok");
    const url = new URL(calls[0].url);
    expect(url.origin).toBe("https://graph.instagram.com");
    expect(url.pathname).toBe("/refresh_access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(url.searchParams.get("access_token")).toBe("old-tok");
  });

  it("maps code 190 to MetaTokenExpiredError", async () => {
    stubFetchJson(
      { error: { message: "Session expired", code: 190 } },
      { ok: false, status: 400 }
    );
    await expect(refreshInstagramToken("dead")).rejects.toThrow(
      MetaTokenExpiredError
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Identity + webhooks
// ---------------------------------------------------------------------------
describe("getInstagramLoginUser / subscribeInstagramWebhooks", () => {
  it("fetches the IG identity from versioned graph.instagram.com/me", async () => {
    stubFetchJson({ id: "ig_42", username: "testbrand", name: "Test Brand" });
    const me = await getInstagramLoginUser("tok");
    expect(me.id).toBe("ig_42");
    expect(me.username).toBe("testbrand");
    const url = new URL(calls[0].url);
    expect(url.origin).toBe("https://graph.instagram.com");
    expect(url.pathname).toContain("/me");
    expect(url.searchParams.get("fields")).toContain("username");
  });

  it("subscribes the account to messages+comments webhooks", async () => {
    stubFetchJson({ success: true });
    const ok = await subscribeInstagramWebhooks("ig_42", "tok");
    expect(ok).toBe(true);
    const url = new URL(calls[0].url);
    expect(url.origin).toBe("https://graph.instagram.com");
    expect(url.pathname).toContain("/ig_42/subscribed_apps");
    expect(calls[0].init.method).toBe("POST");
    expect(url.searchParams.get("subscribed_fields")).toBe("messages,comments");
  });

  it("returns false when the subscription is not acknowledged", async () => {
    stubFetchJson({ success: false });
    const ok = await subscribeInstagramWebhooks("ig_42", "tok");
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Adapter branches on loginType
// ---------------------------------------------------------------------------
describe("InstagramAdapter loginType branching", () => {
  it("sends via graph.instagram.com for instagram_login credentials", async () => {
    stubFetchJson({ message_id: "mid_1" });
    const adapter = new InstagramAdapter({
      provider: "instagram",
      loginType: "instagram_login",
      accessToken: "ig-user-token",
      expiresAt: null,
      igUserId: "ig_42",
      igUsername: "testbrand",
    });
    const result = await adapter.sendMessage({ to: "ig_99", body: "hi" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("graph.instagram.com");
    expect(calls[0].url).toContain("/me/messages");
    expect(result).toEqual({ ok: true, mocked: false, externalId: "mid_1" });
  });

  it("private-replies via graph.instagram.com for instagram_login credentials", async () => {
    stubFetchJson({ id: "reply_2" });
    const adapter = new InstagramAdapter({
      provider: "instagram",
      loginType: "instagram_login",
      accessToken: "ig-user-token",
      expiresAt: null,
      igUserId: "ig_42",
      igUsername: "testbrand",
    });
    const result = await adapter.replyToComment({ commentId: "c_1", body: "Thanks!" });
    expect(calls[0].url).toContain("graph.instagram.com");
    expect(calls[0].url).toContain("/c_1/private_replies");
    expect(result).toEqual({ ok: true, mocked: false, externalId: "reply_2" });
  });

  it("verifies the IG account directly for instagram_login credentials", async () => {
    stubFetchJson({ id: "ig_42", username: "testbrand" });
    const adapter = new InstagramAdapter({
      provider: "instagram",
      loginType: "instagram_login",
      accessToken: "ig-user-token",
      expiresAt: null,
      igUserId: "ig_42",
      igUsername: "testbrand",
    });
    const result = await adapter.verify({});
    expect(result.verified).toBe(true);
    expect(result.accountLabel).toBe("testbrand");
    expect(calls[0].url).toContain("graph.instagram.com");
  });
});

// ---------------------------------------------------------------------------
// Security: HTTP timeout (igFetch backs every Instagram API call)
// ---------------------------------------------------------------------------

describe("igFetch HTTP timeout", () => {
  it("maps an aborted request to MetaRetryableError and sends a timeout signal", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        seen.push(init);
        throw new DOMException("The operation was aborted", "AbortError");
      })
    );
    await expect(refreshInstagramToken("tok")).rejects.toBeInstanceOf(
      MetaRetryableError
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });
});
