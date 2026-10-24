/**
 * Meta integration tests (mocked HTTP).
 *
 * All network calls are stubbed via vi.stubGlobal("fetch", ...) — no real
 * Meta API traffic happens here. DB-backed tests reuse the vitest global
 * setup's fresh `test.db`; every record uses unique keys and is cleaned up.
 */
import { createHmac } from "node:crypto";
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import {
  buildAuthorizeUrl,
  canRefreshToken,
  exchangeCodeForToken,
  exchangeForLongLived,
  getValidAccessToken,
  graph,
  OAUTH_SCOPES,
  signState,
  verifyMetaSignature,
  verifyState,
  resetUsedStateNonces,
  MetaApiError,
  MetaCredentials,
  MetaTokenExpiredError,
  MetaRetryableError,
} from "./meta";
import { MessengerAdapter } from "./messenger";
import { InstagramAdapter } from "./instagram";
import { WhatsAppAdapter } from "./whatsapp";
import { ingestMetaEvent } from "./ingest";
import { db } from "@/lib/db";

// ---- test-only Meta env (metaEnv() is read lazily by every helper) ----
process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-secret";
process.env.META_VERIFY_TOKEN = "test-verify-token";
process.env.APP_PUBLIC_URL = "https://example.test";

// ---------------------------------------------------------------------------
// fetch stub plumbing
// ---------------------------------------------------------------------------
interface CapturedCall {
  url: string;
  init: RequestInit;
}
let calls: CapturedCall[] = [];

/** Stub global fetch to return a fixed JSON payload (never real network). */
function stubFetchJson(
  data: unknown,
  opts: { ok?: boolean; status?: number } = {}
) {
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

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. Webhook HMAC verification
// ---------------------------------------------------------------------------
describe("verifyMetaSignature", () => {
  const raw = JSON.stringify({ object: "page", entry: [{ id: "page_1" }] });
  const hex = createHmac("sha256", "test-secret")
    .update(raw, "utf8")
    .digest("hex");

  it("accepts a correctly-signed payload", () => {
    expect(verifyMetaSignature(raw, `sha256=${hex}`)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    expect(verifyMetaSignature(raw + "tampered", `sha256=${hex}`)).toBe(false);
  });

  it("rejects a malformed signature header", () => {
    expect(verifyMetaSignature(raw, "not-a-signature")).toBe(false);
    expect(verifyMetaSignature(raw, "")).toBe(false);
    expect(verifyMetaSignature(raw, `sha256=${hex.slice(0, 10)}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. OAuth state signing / verification
// ---------------------------------------------------------------------------
describe("OAuth state", () => {
  const payload = {
    workspaceId: "w1",
    provider: "instagram" as const,
    nonce: "nonce-1",
    ts: Math.floor(Date.now() / 1000),
  };

  it("round-trips: verifyState returns the signed payload", () => {
    const state = signState(payload);
    expect(verifyState(state)).toEqual(payload);
  });

  it("throws on a tampered signature", () => {
    const [payloadB64, sig] = signState(payload).split(".");
    const tamperedB64 = (payloadB64[0] === "A" ? "B" : "A") + payloadB64.slice(1);
    expect(() => verifyState(`${tamperedB64}.${sig}`)).toThrow(/bad signature/);
  });

  it("throws when the state is older than 15 minutes", () => {
    const expired = signState({
      ...payload,
      ts: Math.floor(Date.now() / 1000) - 16 * 60,
    });
    expect(() => verifyState(expired)).toThrow(/expired/);
  });
});

// ---------------------------------------------------------------------------
// 2b. OAuth authorize URL + scopes (Facebook Login flow)
// ---------------------------------------------------------------------------
describe("buildAuthorizeUrl", () => {
  it("uses the Facebook Login dialog endpoint with the app callback", () => {
    const url = new URL(buildAuthorizeUrl("facebook", "w1"));
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toContain("/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("test-app-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.test/api/integrations/meta/callback"
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("requests the Messenger Page permissions for facebook", () => {
    expect(OAUTH_SCOPES.facebook).toEqual([
      "pages_messaging",
      "pages_show_list",
      "pages_read_engagement",
    ]);
    const scopes = new URL(buildAuthorizeUrl("facebook", "w1")).searchParams
      .get("scope")
      ?.split(",");
    expect(scopes).toEqual(OAUTH_SCOPES.facebook);
  });

  it("instagram no longer uses Facebook Login (Business Login instead)", () => {
    // Instagram moved to Instagram Business Login (instagram-login.ts).
    // buildAuthorizeUrl is Facebook Login only; the legacy instagram scope
    // entry is retained empty for type compatibility and never requested.
    expect(OAUTH_SCOPES.instagram).toEqual([]);
  });

  it("requests the WhatsApp Business permissions for whatsapp", () => {
    expect(OAUTH_SCOPES.whatsapp).toEqual([
      "whatsapp_business_messaging",
      "whatsapp_business_management",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2c. Token refresh logic
// ---------------------------------------------------------------------------
describe("getValidAccessToken", () => {
  const baseCreds: MetaCredentials = {
    provider: "facebook",
    accessToken: "current-token",
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };

  it("returns the existing token when far from expiry (no refresh call)", async () => {
    stubFetchJson({ access_token: "should-not-be-used", expires_in: 5184000 });
    const valid = await getValidAccessToken(baseCreds);
    expect(valid.token).toBe("current-token");
    expect(valid.refreshed).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("refreshes when inside the 7-day window", async () => {
    stubFetchJson({ access_token: "fresh-token", expires_in: 5184000 });
    const expiring = {
      ...baseCreds,
      expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const valid = await getValidAccessToken(expiring);
    expect(valid.token).toBe("fresh-token");
    expect(valid.refreshed).toBe(true);
    expect(valid.newExpiresAt).toBeTruthy();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("fb_exchange_token");
  });

  it("never refreshes for providers without refresh support (whatsapp)", async () => {
    expect(canRefreshToken("whatsapp")).toBe(false);
    expect(canRefreshToken("facebook")).toBe(true);
    expect(canRefreshToken("instagram")).toBe(true);
    stubFetchJson({ access_token: "should-not-be-used", expires_in: 5184000 });
    const waCreds: MetaCredentials = {
      ...baseCreds,
      provider: "whatsapp",
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    };
    const valid = await getValidAccessToken(waCreds);
    expect(valid.token).toBe("current-token");
    expect(valid.refreshed).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("propagates expiry errors from the refresh call", async () => {
    stubFetchJson(
      { error: { message: "Session expired", code: 190 } },
      { ok: false, status: 400 }
    );
    const expiring = {
      ...baseCreds,
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    };
    await expect(getValidAccessToken(expiring)).rejects.toThrow(
      MetaTokenExpiredError
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Token exchange parsing
// ---------------------------------------------------------------------------
describe("token exchange", () => {
  it("exchangeCodeForToken parses the short-lived token response", async () => {
    stubFetchJson({
      access_token: "abc",
      expires_in: 3600,
      token_type: "bearer",
    });
    const tok = await exchangeCodeForToken(
      "code123",
      "https://example.test/api/integrations/meta/callback"
    );
    expect(tok.access_token).toBe("abc");
    expect(tok.expires_in).toBe(3600);
    expect(calls[0].url).toContain("/oauth/access_token");
    expect(calls[0].init.method).toBe("POST");
    expect(String(calls[0].init.body)).toContain("code=code123");
  });

  it("exchangeForLongLived requests fb_exchange_token and parses the token", async () => {
    stubFetchJson({
      access_token: "long-lived-token",
      expires_in: 5184000,
      token_type: "bearer",
    });
    const tok = await exchangeForLongLived("short-token");
    expect(tok.access_token).toBe("long-lived-token");
    expect(calls[0].url).toContain("grant_type=fb_exchange_token");
    expect(calls[0].url).toContain("fb_exchange_token=short-token");
  });
});

// ---------------------------------------------------------------------------
// 4. MessengerAdapter.sendMessage
// ---------------------------------------------------------------------------
describe("MessengerAdapter", () => {
  const creds: MetaCredentials = {
    provider: "facebook",
    accessToken: "user-token",
    expiresAt: null,
    pageId: "page_1",
    pageName: "Test Page",
    pageAccessToken: "page-token",
  };

  it("POSTs to /me/messages and returns the message id", async () => {
    stubFetchJson({ message_id: "mid.123" });
    const adapter = new MessengerAdapter(creds);
    const result = await adapter.sendMessage({ to: "psid_1", body: "hello" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/me/messages");
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(calls[0].init.body as string) as Record<string, any>;
    expect(body.recipient.id).toBe("psid_1");
    expect(body.messaging_type).toBe("RESPONSE");
    expect(body.message.text).toBe("hello");
    expect(result).toEqual({ ok: true, mocked: false, externalId: "mid.123" });
  });
});

// ---------------------------------------------------------------------------
// 5. InstagramAdapter.replyToComment
// ---------------------------------------------------------------------------
describe("InstagramAdapter", () => {
  const creds: MetaCredentials = {
    provider: "instagram",
    accessToken: "user-token",
    expiresAt: null,
    pageId: "page_1",
    pageAccessToken: "page-token",
    igUserId: "ig_1",
    igUsername: "testbrand",
  };

  it("POSTs a private reply to the comment endpoint", async () => {
    stubFetchJson({ id: "reply_1" });
    const adapter = new InstagramAdapter(creds);
    const result = await adapter.replyToComment({
      commentId: "c_99",
      body: "Thanks! DM us for details.",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/c_99/private_replies");
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(calls[0].init.body as string) as Record<string, any>;
    expect(body.message).toBe("Thanks! DM us for details.");
    expect(result).toEqual({ ok: true, mocked: false, externalId: "reply_1" });
  });
});

// ---------------------------------------------------------------------------
// 6. WhatsApp 24-hour customer-service window
// ---------------------------------------------------------------------------
describe("WhatsAppAdapter messaging window", () => {
  const creds: MetaCredentials = {
    provider: "whatsapp",
    accessToken: "wa-token",
    expiresAt: null,
    wabaId: "waba_1",
    phoneNumberId: "pn_123",
    phoneDisplayName: "+15550001111",
  };

  function adapterWithLastInbound(msAgo: number) {
    return new WhatsAppAdapter(creds, {
      getLastInboundAt: async () => new Date(Date.now() - msAgo),
    });
  }

  it("(a) sends free-form text when the last inbound is 1 hour old", async () => {
    stubFetchJson({ messages: [{ id: "wamid.abc" }] });
    const adapter = adapterWithLastInbound(3600_000);
    const result = await adapter.sendMessage({
      to: "+15551234567",
      body: "hi there",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/pn_123/messages");
    expect(calls[0].url).toContain("/messages");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer wa-token");
    const body = JSON.parse(calls[0].init.body as string) as Record<string, any>;
    expect(body.type).toBe("text");
    expect(body.text.body).toBe("hi there");
    expect(result).toEqual({ ok: true, mocked: false, externalId: "wamid.abc" });
  });

  it("(b) refuses free-form text 30 hours after the last inbound", async () => {
    stubFetchJson({ messages: [{ id: "wamid.never" }] });
    const adapter = adapterWithLastInbound(30 * 3600_000);
    await expect(
      adapter.sendMessage({ to: "+15551234567", body: "hi there" })
    ).rejects.toThrow(/24-hour|window/i);
    // Never attempted a network send.
    expect(calls).toHaveLength(0);
  });

  it("(c) sends a template when outside the window with templateName", async () => {
    stubFetchJson({ messages: [{ id: "wamid.tpl" }] });
    const adapter = adapterWithLastInbound(30 * 3600_000);
    const result = await adapter.sendMessage({
      to: "+15551234567",
      body: "ignored",
      templateName: "hello_world",
    });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body as string) as Record<string, any>;
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("hello_world");
    expect(result).toEqual({ ok: true, mocked: false, externalId: "wamid.tpl" });
  });
});

// ---------------------------------------------------------------------------
// 7. Meta error mapping
// ---------------------------------------------------------------------------
describe("Meta error mapping", () => {
  it("maps OAuth code 190 to MetaTokenExpiredError", async () => {
    stubFetchJson({
      error: { message: "Invalid OAuth access token", code: 190 },
    });
    try {
      await graph("/me", { token: "stale" });
      expect.unreachable("expected MetaTokenExpiredError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MetaTokenExpiredError);
      expect((err as MetaTokenExpiredError).name).toBe("MetaTokenExpiredError");
      expect((err as MetaTokenExpiredError).code).toBe(190);
    }
  });

  it("maps code 80007 to MetaRetryableError", async () => {
    stubFetchJson({
      error: { message: "Rate limit hit", code: 80007 },
    });
    await expect(graph("/me", { token: "x" })).rejects.toThrow(
      MetaRetryableError
    );
  });

  it("maps HTTP 429 to MetaRetryableError", async () => {
    stubFetchJson(
      { error: { message: "Too many requests", code: 80007 } },
      { ok: false, status: 429 }
    );
    await expect(graph("/me", { token: "x" })).rejects.toThrow(
      MetaRetryableError
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Webhook ingestion dedupe (DB-backed)
// ---------------------------------------------------------------------------
describe("ingestMetaEvent dedupe", () => {
  let seq = 0;
  const orgNames: string[] = [];

  async function makeWorkspace() {
    seq += 1;
    const name = `Meta Test Org ${Date.now()}-${seq}`;
    orgNames.push(name);
    const org = await db.organization.create({ data: { name } });
    return db.workspace.create({
      data: {
        orgId: org.id,
        name: `Meta WS ${seq}`,
        slug: `meta-test-ws-${Date.now()}-${seq}`,
      },
    });
  }

  async function messageCount(workspaceId: string) {
    return db.message.count({
      where: { conversation: { workspaceId } },
    });
  }

  async function messagesFor(workspaceId: string) {
    return db.message.findMany({
      where: { conversation: { workspaceId } },
      orderBy: { createdAt: "asc" },
    });
  }

  afterAll(async () => {
    if (orgNames.length > 0) {
      await db.organization.deleteMany({ where: { name: { in: orgNames } } });
    }
    await db.$disconnect();
  });

  it("dedupes a repeated messaging entry (same mid) into one Message", async () => {
    const ws = await makeWorkspace();
    const integration = await db.integration.create({
      data: { workspaceId: ws.id, provider: "facebook", status: "CONNECTED" },
    });
    const input = {
      id: integration.id,
      workspaceId: ws.id,
      provider: "facebook",
    };
    const mid = `mid.dedupe.${Date.now()}-${seq}`;
    const entry = {
      id: "page_1",
      messaging: [
        {
          sender: { id: "psid_9" },
          recipient: { id: "page_1" },
          message: { mid, text: "hello there" },
        },
      ],
    };

    await ingestMetaEvent(input, entry);
    await ingestMetaEvent(input, entry); // redelivered webhook — must dedupe

    expect(await messageCount(ws.id)).toBe(1);
  });

  it("stores a comment change as one Message with private-reply metadata", async () => {
    const ws = await makeWorkspace();
    const integration = await db.integration.create({
      data: { workspaceId: ws.id, provider: "instagram", status: "CONNECTED" },
    });
    const input = {
      id: integration.id,
      workspaceId: ws.id,
      provider: "instagram",
    };
    const commentId = `c_${Date.now()}-${seq}`;

    await ingestMetaEvent(input, {
      id: "ig_1",
      changes: [
        {
          field: "comments",
          value: {
            item: "comment",
            comment_id: commentId,
            post_id: "post_1",
            message: "price please",
            from: { id: "iguser_7", username: "buyer" },
          },
        },
      ],
    });

    const messages = await messagesFor(ws.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("price please");
    const media = JSON.parse(messages[0].media);
    expect(media.commentId).toBe(commentId);
    expect(media.eligibleForPrivateReply).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security: single-use OAuth state (replay protection) + HTTP timeout
// ---------------------------------------------------------------------------

describe("single-use OAuth state (replay protection)", () => {
  it("accepts a fresh state once, then rejects the replay", () => {
    resetUsedStateNonces();
    const payload = {
      workspaceId: "w1",
      provider: "facebook" as const,
      nonce: "replay-once",
      ts: Math.floor(Date.now() / 1000),
    };
    const state = signState(payload);
    expect(verifyState(state)).toEqual(payload);
    // Same callback URL replayed (e.g. captured from browser history).
    expect(() => verifyState(state)).toThrow(/already used/);
  });

  it("does not consume the nonce when signature verification fails", () => {
    resetUsedStateNonces();
    const [payloadB64, sig] = signState({
      workspaceId: "w1",
      provider: "facebook" as const,
      nonce: "replay-tamper",
      ts: Math.floor(Date.now() / 1000),
    }).split(".");
    expect(() => verifyState(`${payloadB64}x.${sig}`)).toThrow(/bad signature/);
    // The nonce was never consumed, so a correctly signed state still works.
    const good = signState({
      workspaceId: "w1",
      provider: "facebook" as const,
      nonce: "replay-tamper",
      ts: Math.floor(Date.now() / 1000),
    });
    expect(verifyState(good).nonce).toBe("replay-tamper");
  });
});

describe("graph() HTTP timeout", () => {
  it("maps an aborted request to MetaRetryableError and sends a timeout signal", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        seen.push(init);
        throw new DOMException("The operation was aborted", "TimeoutError");
      })
    );
    await expect(graph("/me", { token: "t" })).rejects.toBeInstanceOf(
      MetaRetryableError
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });
});
