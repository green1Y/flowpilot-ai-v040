/**
 * Stage 1 — history sync tests (mocked HTTP).
 *
 * syncHistory talks to the real Meta Graph API in production; here every
 * network call is intercepted via the `fetchImpl` injection point, so no
 * real Meta traffic happens. Also covers comment persistence + lastInboundAt
 * in the webhook ingest path.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { db } from "@/lib/db";
import { encryptCredentials } from "./meta";
import { syncHistory } from "./history";
import { ingestMetaEvent, seenDeliveryIds } from "./ingest";

const suffix = `h${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

let orgId = "";
let workspaceId = "";
let integrationId = "";

const IG_USER_ID = `iguser-${suffix}`;
const PAGE_TOKEN = `page-token-${suffix}`;

const MID_INBOUND = `m_hist_in_${suffix}`;
const MID_OUTBOUND = `m_hist_out_${suffix}`;
const CONV_ID = `conv_${suffix}`;

// ---------------------------------------------------------------------------
// fetch stub: emulates the Meta Graph API for one IG account.
// ---------------------------------------------------------------------------
function jsonBody(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function stubFetch(url: string | URL | Request): Promise<any> {
  const u = new URL(typeof url === "string" ? url : (url as URL).toString());
  if (u.pathname.endsWith("/conversations")) {
    return Promise.resolve(
      jsonBody({
        data: [
          {
            id: CONV_ID,
            participants: {
              data: [
                { id: IG_USER_ID, name: "Biz" },
                { id: `sender-${suffix}`, name: "History Fan" },
              ],
            },
            updated_time: "2026-10-17T10:00:00+0000",
          },
        ],
        paging: {},
      })
    );
  }
  if (u.pathname.endsWith("/messages")) {
    return Promise.resolve(
      jsonBody({
        data: [
          {
            id: MID_INBOUND,
            created_time: "2026-10-17T09:00:00+0000",
            from: { id: `sender-${suffix}`, name: "History Fan" },
            message: "Hello from the past",
          },
          {
            id: MID_OUTBOUND,
            created_time: "2026-10-17T09:05:00+0000",
            from: { id: IG_USER_ID, name: "Biz" },
            message: "Hello back",
          },
        ],
      })
    );
  }
  return Promise.resolve(jsonBody({ error: { message: "unexpected call", code: 1 } }, 500));
}

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: `Hist Org ${suffix}` } });
  orgId = org.id;
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `Hist WS ${suffix}`, slug: `hist-${suffix}` },
  });
  workspaceId = ws.id;

  const integration = await db.integration.create({
    data: {
      workspaceId,
      provider: "instagram",
      status: "CONNECTED",
      encryptedCredentials: encryptCredentials({
        provider: "instagram",
        accessToken: `user-token-${suffix}`,
        expiresAt: null,
        pageAccessToken: PAGE_TOKEN,
        igUserId: IG_USER_ID,
      }),
    },
  });
  integrationId = integration.id;
});

beforeEach(() => {
  // Simulate a process restart: the in-memory dedupe set is empty, so any
  // dedupe on re-runs must come from the DB layer.
  seenDeliveryIds.clear();
});

afterAll(async () => {
  await db.message.deleteMany({
    where: { conversation: { workspaceId } },
  });
  await db.comment.deleteMany({ where: { workspaceId } });
  await db.conversation.deleteMany({ where: { workspaceId } });
  await db.contact.deleteMany({ where: { workspaceId } });
  await db.integration.deleteMany({ where: { workspaceId } });
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.organization.deleteMany({ where: { id: orgId } });
});

async function loadIntegration() {
  const row = await db.integration.findUnique({ where: { id: integrationId } });
  if (!row) throw new Error("integration missing");
  return row;
}

describe("syncHistory", () => {
  it("backfills conversations + messages as real (never mocked) rows", async () => {
    const result = await syncHistory(await loadIntegration(), stubFetch as any);
    expect(result.conversations).toBe(1);
    expect(result.messages).toBe(2);
    expect(result.skipped).toBe(0);

    const contact = await db.contact.findFirst({ where: { workspaceId } });
    expect(contact).not.toBeNull();
    // lastInboundAt was set from the inbound thread message.
    expect(contact!.lastInboundAt).not.toBeNull();

    const messages = await db.message.findMany({
      where: { conversation: { contactId: contact!.id } },
      orderBy: { createdAt: "asc" },
    });
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.mocked === false)).toBe(true);
    expect(messages.map((m) => m.direction).sort()).toEqual(["INBOUND", "OUTBOUND"]);
    expect(messages.find((m) => m.direction === "INBOUND")!.body).toContain(
      "Hello from the past"
    );
  });

  it("dedupes on re-run via the DB layer (no duplicates after restart)", async () => {
    const before = await db.message.count({
      where: { conversation: { workspaceId } },
    });
    const result = await syncHistory(await loadIntegration(), stubFetch as any);
    expect(result.messages).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    const after = await db.message.count({
      where: { conversation: { workspaceId } },
    });
    expect(after).toBe(before);
  });

  it("is a documented no-op for WhatsApp", async () => {
    const wa = await db.integration.create({
      data: {
        workspaceId,
        provider: "whatsapp",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "whatsapp",
          accessToken: `wa-token-${suffix}`,
          expiresAt: null,
        }),
      },
    });
    try {
      const result = await syncHistory(wa, stubFetch as any);
      expect(result.conversations).toBe(0);
      expect(result.messages).toBe(0);
      expect(result.note).toMatch(/no history endpoint/i);
    } finally {
      await db.integration.delete({ where: { id: wa.id } });
    }
  });
});

describe("syncHistory token refresh persistence (D3 regression)", () => {
  it("uses the refreshed token for the sync AND persists it re-encrypted", async () => {
    // getValidAccessToken's refresh path reads Meta env lazily.
    process.env.META_APP_ID = "test-app-id";
    process.env.META_APP_SECRET = "test-app-secret";
    process.env.META_VERIFY_TOKEN = "test-verify-token";
    process.env.APP_PUBLIC_URL = "https://example.test";

    const freshToken = `fresh-token-${suffix}`;
    const seenTokens: string[] = [];
    const refreshStub = (url: string | URL | Request): Promise<any> => {
      const u = new URL(typeof url === "string" ? url : (url as URL).toString());
      // Token refresh (fb_exchange_token grant) — must be answered before
      // the conversations/messages branches below.
      if (u.pathname.includes("/oauth/access_token")) {
        return Promise.resolve(
          jsonBody({ access_token: freshToken, expires_in: 60 * 24 * 60 * 60 })
        );
      }
      // instagram_login rows refresh via graph.instagram.com's
      // /refresh_access_token (ig_refresh_token grant), NOT the Facebook
      // /oauth/access_token endpoint — without this branch the refresh
      // throws "unexpected call".
      if (u.pathname.endsWith("/refresh_access_token")) {
        return Promise.resolve(
          jsonBody({ access_token: freshToken, expires_in: 60 * 24 * 60 * 60 })
        );
      }
      if (u.pathname.endsWith("/conversations")) {
        seenTokens.push(u.searchParams.get("access_token") ?? "");
        return Promise.resolve(jsonBody({ data: [], paging: {} }));
      }
      return Promise.resolve(
        jsonBody({ error: { message: "unexpected call", code: 1 } }, 500)
      );
    };

    const row = await db.integration.create({
      data: {
        workspaceId,
        provider: "instagram",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "instagram",
          loginType: "instagram_login",
          accessToken: `stale-token-${suffix}`,
          // Inside the 7-day refresh window → getValidAccessToken refreshes.
          expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
          igUserId: `ig-refresh-${suffix}`,
        }),
      },
    });
    // NOTE: syncHistory refreshes BEFORE it swaps in fetchImpl, so the
    // refresh call goes through the global fetch — stub that too (same
    // handler answers both the refresh and the Graph calls).
    vi.stubGlobal("fetch", vi.fn(refreshStub as any));
    try {
      const result = await syncHistory(row, refreshStub as any);
      expect(result.conversations).toBe(0); // stub returns no conversations
      // The sync itself ran with the REFRESHED token, not the stale one.
      expect(seenTokens).toEqual([freshToken]);
      // And the row now stores the refreshed credentials (re-encrypted).
      const reloaded = await db.integration.findUnique({ where: { id: row.id } });
      expect(reloaded).not.toBeNull();
      const { decryptCredentials } = await import("./meta");
      const creds = decryptCredentials(reloaded!.encryptedCredentials!);
      expect(creds.accessToken).toBe(freshToken);
      expect(creds.expiresAt).not.toBeNull();
      expect(Date.parse(creds.expiresAt!)).toBeGreaterThan(Date.now());
    } finally {
      vi.unstubAllGlobals();
      await db.integration.delete({ where: { id: row.id } });
    }
  });
});

describe("ingest comment persistence", () => {
  it("stores the comment row, computes the 7-day window, and sets lastInboundAt", async () => {
    const commentId = `cmt_${suffix}`;
    const createdUnix = Math.floor(new Date("2026-10-17T08:00:00Z").getTime() / 1000);

    const res = await ingestMetaEvent(
      { id: integrationId, workspaceId, provider: "facebook" },
      {
        id: "page-1",
        changes: [
          {
            value: {
              item: "comment",
              comment_id: commentId,
              created_time: createdUnix,
              message: "Love this!",
              post_id: `post_${suffix}`,
              from: { id: `fbuser-${suffix}`, username: "commenter" },
            },
          },
        ],
      }
    );
    expect(res.messages).toBe(1);

    const comment = await db.comment.findUnique({
      where: { externalId: commentId },
    });
    expect(comment).not.toBeNull();
    expect(comment!.workspaceId).toBe(workspaceId);
    expect(comment!.integrationId).toBe(integrationId);
    expect(comment!.text).toBe("Love this!");
    expect(comment!.commentedAt.getTime()).toBe(createdUnix * 1000);
    // privateReplyEligibleUntil = commentedAt + 7 days.
    expect(comment!.privateReplyEligibleUntil.getTime()).toBe(
      createdUnix * 1000 + 7 * 24 * 60 * 60 * 1000
    );
    expect(comment!.privateRepliedAt).toBeNull();

    const contact = await db.contact.findUnique({
      where: { id: comment!.contactId! },
    });
    expect(contact!.lastInboundAt?.getTime()).toBe(createdUnix * 1000);

    // A duplicate webhook delivery must not create a second comment row.
    seenDeliveryIds.clear();
    await ingestMetaEvent(
      { id: integrationId, workspaceId, provider: "facebook" },
      {
        id: "page-1",
        changes: [
          {
            value: {
              item: "comment",
              comment_id: commentId,
              created_time: createdUnix,
              message: "Love this!",
              post_id: `post_${suffix}`,
              from: { id: `fbuser-${suffix}`, username: "commenter" },
            },
          },
        ],
      }
    );
    const count = await db.comment.count({
      where: { workspaceId, externalId: commentId },
    });
    expect(count).toBe(1);
  });

  it("sets lastInboundAt on webhook DM ingest (messaging events)", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const res = await ingestMetaEvent(
      { id: integrationId, workspaceId, provider: "instagram" },
      {
        id: "ig-1",
        messaging: [
          {
            sender: { id: `igdm-${suffix}` },
            timestamp: ts,
            message: { mid: `mid_dm_${suffix}`, text: "DM hello" },
          },
        ],
      }
    );
    expect(res.messages).toBe(1);
    const contact = await db.contact.findFirst({
      where: { workspaceId, externalIds: { contains: `igdm-${suffix}` } },
    });
    expect(contact).not.toBeNull();
    expect(contact!.lastInboundAt?.getTime()).toBe(ts * 1000);
  });
});
