/**
 * TikTok Login Kit tests (mocked HTTP — no real TikTok traffic).
 *
 * Covers: authorize URL shape + scopes, state round-trip/tamper/expiry,
 * env validation, token exchange parsing + failure, identity mapping,
 * refresh flow, and the getValidTikTokToken expiry logic.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildTikTokAuthorizeUrl,
  exchangeTikTokCode,
  refreshTikTokToken,
  getTikTokUserInfo,
  getValidTikTokToken,
  signTikTokState,
  verifyTikTokState,
  resetUsedTikTokStateNonces,
  tiktokEnv,
  tiktokRedirectUri,
  TIKTOK_SCOPES,
  encryptTikTokCredentials,
  decryptTikTokCredentials,
  TikTokApiError,
  TikTokTokenExpiredError,
} from "./tiktok";

// ---- test-only TikTok env ----
process.env.TIKTOK_CLIENT_KEY = "test-client-key";
process.env.TIKTOK_CLIENT_SECRET = "test-client-secret-0123456789abcdef";
process.env.APP_PUBLIC_URL = "https://example.test";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tiktokEnv", () => {
  it("names every missing variable", () => {
    const saved = process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_KEY;
    expect(() => tiktokEnv()).toThrow(/TIKTOK_CLIENT_KEY/);
    process.env.TIKTOK_CLIENT_KEY = saved;
  });

  it("builds the callback redirect URI from APP_PUBLIC_URL", () => {
    expect(tiktokRedirectUri()).toBe("https://example.test/api/integrations/tiktok/callback");
  });
});

describe("buildTikTokAuthorizeUrl", () => {
  it("uses the TikTok Login Kit endpoint with identity-only scope", () => {
    const url = new URL(buildTikTokAuthorizeUrl("w1"));
    expect(url.origin).toBe("https://www.tiktok.com");
    expect(url.pathname).toBe("/v2/auth/authorize/");
    expect(url.searchParams.get("client_key")).toBe("test-client-key");
    expect(url.searchParams.get("scope")).toBe(TIKTOK_SCOPES.join(","));
    expect(url.searchParams.get("scope")).toBe("user.info.basic");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.test/api/integrations/tiktok/callback"
    );
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("never requests messaging scopes", () => {
    expect(TIKTOK_SCOPES.join(",")).not.toMatch(/messag|dm|comment/i);
  });
});

describe("TikTok OAuth state", () => {
  const payload = { workspaceId: "w1", nonce: "n1", ts: Math.floor(Date.now() / 1000) };

  it("round-trips", () => {
    expect(verifyTikTokState(signTikTokState(payload))).toEqual(payload);
  });

  it("throws on tampering", () => {
    const [b64, sig] = signTikTokState(payload).split(".");
    const tampered = (b64[0] === "A" ? "B" : "A") + b64.slice(1);
    expect(() => verifyTikTokState(`${tampered}.${sig}`)).toThrow(/bad signature/);
  });

  it("throws when older than 15 minutes", () => {
    const expired = signTikTokState({ ...payload, ts: Math.floor(Date.now() / 1000) - 16 * 60 });
    expect(() => verifyTikTokState(expired)).toThrow(/expired/);
  });

  it("throws on malformed input", () => {
    expect(() => verifyTikTokState("no-dot-here")).toThrow();
  });
});

describe("exchangeTikTokCode", () => {
  it("parses the token response", async () => {
    stubFetchJson({
      access_token: "tok-1",
      refresh_token: "ref-1",
      expires_in: 86400,
      open_id: "open-1",
      scope: "user.info.basic",
      token_type: "Bearer",
    });
    const t = await exchangeTikTokCode("code-1", tiktokRedirectUri());
    expect(t.access_token).toBe("tok-1");
    expect(t.open_id).toBe("open-1");
  });

  it("throws TikTokApiError on provider errors (never marks anything connected)", async () => {
    stubFetchJson(
      { error: "invalid_grant", error_description: "code expired", log_id: "x" },
      { ok: false, status: 400 }
    );
    await expect(exchangeTikTokCode("bad", tiktokRedirectUri())).rejects.toThrow(TikTokApiError);
  });
});

describe("getTikTokUserInfo", () => {
  it("maps identity fields from the documented API", async () => {
    stubFetchJson({
      data: {
        user: {
          open_id: "open-9",
          union_id: "union-9",
          display_name: "Acme Shop",
          username: "acme.shop",
          avatar_url: "https://example.test/a.png",
        },
      },
    });
    const info = await getTikTokUserInfo("tok-1");
    expect(info).toEqual({
      openId: "open-9",
      unionId: "union-9",
      displayName: "Acme Shop",
      username: "acme.shop",
      avatarUrl: "https://example.test/a.png",
    });
  });

  it("maps expired tokens to TikTokTokenExpiredError", async () => {
    stubFetchJson(
      { error: { code: "invalid_token", message: "access token expired" } },
      { ok: false, status: 401 }
    );
    await expect(getTikTokUserInfo("stale")).rejects.toThrow(TikTokTokenExpiredError);
  });

  it("rejects responses without open_id (never a guessed identity)", async () => {
    stubFetchJson({ data: { user: { display_name: "Nobody" } } });
    await expect(getTikTokUserInfo("tok")).rejects.toThrow(/open_id/);
  });
});

describe("refreshTikTokToken + getValidTikTokToken", () => {
  const fresh = {
    provider: "tiktok" as const,
    accessToken: "tok-fresh",
    refreshToken: "ref-fresh",
    expiresAt: new Date(Date.now() + 20 * 3600_000).toISOString(),
    openId: "open-1",
  };

  it("returns the stored token when far from expiry (no network)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const v = await getValidTikTokToken(fresh);
    expect(v.token).toBe("tok-fresh");
    expect(v.refreshed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refreshes when within one hour of expiry", async () => {
    stubFetchJson({
      access_token: "tok-new",
      refresh_token: "ref-new",
      expires_in: 86400,
      open_id: "open-1",
      scope: "user.info.basic",
      token_type: "Bearer",
    });
    const v = await getValidTikTokToken({
      ...fresh,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    expect(v.refreshed).toBe(true);
    expect(v.token).toBe("tok-new");
    expect(v.newRefreshToken).toBe("ref-new");
    expect(v.newExpiresAt).toBeTruthy();
  });

  it("throws TikTokTokenExpiredError when no refresh token is stored", async () => {
    await expect(
      getValidTikTokToken({ ...fresh, refreshToken: "", expiresAt: new Date(Date.now() - 1000).toISOString() })
    ).rejects.toThrow(TikTokTokenExpiredError);
  });
});

describe("credential encryption round-trip", () => {
  it("encrypts and decrypts; rejects wrong-provider payloads", () => {
    const c = {
      provider: "tiktok" as const,
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: null,
      openId: "open-1",
    };
    const enc = encryptTikTokCredentials(c);
    expect(enc).not.toContain("tok");
    expect(decryptTikTokCredentials(enc)).toEqual(c);
    // Tamper the first nibble of the CIPHERTEXT segment (format is iv:cipher:tag, hex).
    // This must always change the decoded byte ("f"->"0", anything else->"f"), so GCM auth
    // always fails. (Naive single-char tampers are flaky: hex is case-insensitive and a
    // replaced nibble can decode to the identical value with probability ~1/16, in which
    // case decryption wrongly succeeds — the old `replace(/.$/, "0")` flaked exactly so.)
    const [ivHex, encHex, tagHex] = enc.split(":");
    const tamperedMid = (encHex[0] === "f" ? "0" : "f") + encHex.slice(1);
    expect(() => decryptTikTokCredentials(`${ivHex}:${tamperedMid}:${tagHex}`)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Security: single-use OAuth state (replay protection) + HTTP timeout
// ---------------------------------------------------------------------------

describe("single-use OAuth state (replay protection)", () => {
  it("accepts a fresh state once, then rejects the replay", () => {
    resetUsedTikTokStateNonces();
    const payload = {
      workspaceId: "w1",
      nonce: "tt-replay-once",
      ts: Math.floor(Date.now() / 1000),
    };
    const state = signTikTokState(payload);
    expect(verifyTikTokState(state)).toEqual(payload);
    expect(() => verifyTikTokState(state)).toThrow(/already used/);
  });
});

describe("TikTok HTTP timeout", () => {
  it("maps an aborted token exchange to a retryable TikTokApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      })
    );
    const err = await exchangeTikTokCode("code", "https://example.test/cb").catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(TikTokApiError);
    expect(err.retryable).toBe(true);
  });

  it("maps an aborted user-info fetch to a retryable TikTokApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      })
    );
    const err = await getTikTokUserInfo("tok").catch((e) => e);
    expect(err).toBeInstanceOf(TikTokApiError);
    expect(err.retryable).toBe(true);
  });
});
