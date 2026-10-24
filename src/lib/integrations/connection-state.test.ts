/**
 * Connection-state tests (pure logic; no HTTP, no DB).
 *
 * Verifies the 8-state honest model:
 *  - "connected" only when CONNECTED + decryptable creds + asset ids +
 *    verifiedAt + no contradicting failure detail
 *  - failure detail (permission_missing / token_expired / *_failed) always
 *    wins over a stale CONNECTED marker
 *  - env not configured → "unavailable" for real OAuth providers
 *  - unknown statuses fail closed to "not_connected"
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveConnectionState,
  parseStatusDetail,
  makeStatusDetail,
  STATUS_DETAIL_CODES,
  isRealOAuthProvider,
  type ConnectionStateInput,
} from "./connection-state";
import { encryptCredentials } from "./meta";
import { encryptTikTokCredentials } from "./tiktok";

function base(over: Partial<ConnectionStateInput> = {}): ConnectionStateInput {
  return {
    provider: "facebook",
    dbStatus: "CONNECTED",
    verifiedAt: new Date(),
    encryptedCredentials: encryptCredentials({
      provider: "facebook",
      accessToken: "tok",
      expiresAt: null,
      pageId: "page-1",
      pageName: "Page",
    }),
    statusDetail: null,
    envConfigured: true,
    ...over,
  };
}

describe("parseStatusDetail / makeStatusDetail", () => {
  it("round-trips", () => {
    const s = makeStatusDetail("token_expired", "Token expired — please reconnect");
    const d = parseStatusDetail(s);
    expect(d?.code).toBe("token_expired");
    expect(d?.message).toContain("Token expired");
    expect(d?.at).toBeTruthy();
  });

  it("returns null for null, empty, or malformed input", () => {
    expect(parseStatusDetail(null)).toBeNull();
    expect(parseStatusDetail("")).toBeNull();
    expect(parseStatusDetail("not-json")).toBeNull();
    expect(parseStatusDetail(JSON.stringify({ code: 1 }))).toBeNull();
  });
});

describe("resolveConnectionState — happy paths", () => {
  it("CONNECTED + healthy creds → connected", () => {
    expect(resolveConnectionState(base())).toBe("connected");
  });

  it("CONNECTED tiktok + healthy creds → connected", () => {
    expect(
      resolveConnectionState(
        base({
          provider: "tiktok",
          encryptedCredentials: encryptTikTokCredentials({
            provider: "tiktok",
            accessToken: "a",
            refreshToken: "r",
            expiresAt: null,
            openId: "open-1",
          }),
        })
      )
    ).toBe("connected");
  });

  it("NEEDS_ATTENTION → connecting (flow in progress)", () => {
    expect(resolveConnectionState(base({ dbStatus: "NEEDS_ATTENTION" }))).toBe("connecting");
  });

  it("EXPIRED → reauth_required", () => {
    expect(resolveConnectionState(base({ dbStatus: "EXPIRED" }))).toBe("reauth_required");
  });

  it("DISCONNECTED / DEMO / null → not_connected", () => {
    for (const s of ["DISCONNECTED", "DEMO", null, undefined]) {
      expect(resolveConnectionState(base({ dbStatus: s }))).toBe("not_connected");
    }
  });

  it("simulated provider CONNECTED → connected (SIMULATED badge is separate)", () => {
    expect(
      resolveConnectionState(
        base({ provider: "telegram", dbStatus: "CONNECTED", encryptedCredentials: null })
      )
    ).toBe("connected");
  });
});

describe("resolveConnectionState — failure detail wins", () => {
  it("permission_missing overrides CONNECTED", () => {
    expect(
      resolveConnectionState(
        base({ statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.permissionMissing, "revoked") })
      )
    ).toBe("permission_missing");
  });

  it("token_expired on CONNECTED → reauth_required, never green", () => {
    expect(
      resolveConnectionState(
        base({ statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.tokenExpired, "expired") })
      )
    ).toBe("reauth_required");
  });

  it("callback_failed on CONNECTED → failed", () => {
    expect(
      resolveConnectionState(
        base({ statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.callbackFailed, "denied") })
      )
    ).toBe("failed");
  });

  it("NEEDS_ATTENTION + callback_failed → failed (not forever 'connecting')", () => {
    expect(
      resolveConnectionState(
        base({
          dbStatus: "NEEDS_ATTENTION",
          statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.callbackFailed, "denied"),
        })
      )
    ).toBe("failed");
  });

  it("NEEDS_ATTENTION + permission_missing → permission_missing", () => {
    expect(
      resolveConnectionState(
        base({
          dbStatus: "NEEDS_ATTENTION",
          statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.permissionMissing, "revoked"),
        })
      )
    ).toBe("permission_missing");
  });
});

describe("resolveConnectionState — credential health (never fake green)", () => {
  it("CONNECTED without credentials → partial", () => {
    expect(resolveConnectionState(base({ encryptedCredentials: null }))).toBe("partial");
  });

  it("CONNECTED with corrupted credentials → failed", () => {
    expect(
      resolveConnectionState(base({ encryptedCredentials: "garbage-not-ciphertext" }))
    ).toBe("failed");
  });

  it("CONNECTED with missing asset ids → partial", () => {
    const creds = encryptCredentials({
      provider: "facebook",
      accessToken: "tok",
      expiresAt: null,
      // no pageId — page selection never completed
    });
    expect(resolveConnectionState(base({ encryptedCredentials: creds }))).toBe("partial");
  });

  it("CONNECTED without verifiedAt → partial", () => {
    expect(resolveConnectionState(base({ verifiedAt: null }))).toBe("partial");
  });
});

describe("resolveConnectionState — environment", () => {
  it("real provider + env missing → unavailable even when CONNECTED", () => {
    expect(resolveConnectionState(base({ envConfigured: false }))).toBe("unavailable");
    expect(
      resolveConnectionState(base({ provider: "tiktok", envConfigured: false }))
    ).toBe("unavailable");
  });

  it("explicit disconnect wins over missing env (shows Disconnected, not Configuration Required)", () => {
    expect(
      resolveConnectionState(base({ dbStatus: "DISCONNECTED", envConfigured: false }))
    ).toBe("not_connected");
    expect(
      resolveConnectionState(
        base({ provider: "tiktok", dbStatus: "DISCONNECTED", envConfigured: false })
      )
    ).toBe("not_connected");
  });

  it("demo seed / never-connected + env missing → not_connected", () => {
    for (const s of ["DEMO", null, undefined]) {
      expect(resolveConnectionState(base({ dbStatus: s, envConfigured: false }))).toBe(
        "not_connected"
      );
    }
  });

  it("recorded failure detail wins over missing env (failed callback still surfaces)", () => {
    expect(
      resolveConnectionState(
        base({
          dbStatus: "NEEDS_ATTENTION",
          statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.callbackFailed, "User denied"),
          envConfigured: false,
        })
      )
    ).toBe("failed");
    expect(
      resolveConnectionState(
        base({
          statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.tokenExpired, "expired"),
          envConfigured: false,
        })
      )
    ).toBe("reauth_required");
    expect(
      resolveConnectionState(
        base({
          statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.permissionMissing, "revoked"),
          envConfigured: false,
        })
      )
    ).toBe("permission_missing");
  });

  it("simulated provider + env missing stays honest (nothing to configure)", () => {
    expect(
      resolveConnectionState(
        base({ provider: "webchat", envConfigured: false, encryptedCredentials: null })
      )
    ).toBe("connected");
  });
});

describe("resolveConnectionState — display labels", () => {
  it("missing env config is labeled 'Configuration Required', not 'Unavailable'", async () => {
    const { getIntegrationsStrings } = await import("@/i18n/fragments/integrations");
    expect(getIntegrationsStrings("en").states.unavailable).toBe("Configuration Required");
    expect(getIntegrationsStrings("ar").states.unavailable).toBe("الإعداد مطلوب");
    // The "Unavailable" label survives only for genuinely unsupported
    // capabilities (platform truth), never for the connection state.
    expect(getIntegrationsStrings("en").capabilityStates.unavailable).toBe("Unavailable");
    expect(getIntegrationsStrings("ar").capabilityStates.unavailable).toBe("غير متاح");
  });
});

describe("resolveConnectionState — fail closed", () => {
  it("unknown DB status → not_connected", () => {
    expect(resolveConnectionState(base({ dbStatus: "WHATEVER" }))).toBe("not_connected");
  });
});

describe("isRealOAuthProvider", () => {
  it("matches REAL_OAUTH_PROVIDERS", () => {
    for (const p of ["instagram", "facebook", "whatsapp", "tiktok"]) {
      expect(isRealOAuthProvider(p)).toBe(true);
    }
    expect(isRealOAuthProvider("telegram")).toBe(false);
    expect(isRealOAuthProvider("webchat")).toBe(false);
  });
});
