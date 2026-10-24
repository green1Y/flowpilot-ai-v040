/**
 * Meta webhook audit tests (mocked HTTP — no real provider traffic).
 *
 * Covers the Phase 4 checklist items for /api/webhooks/meta:
 *  - GET verification challenge: correct token → 200 + challenge echo;
 *    wrong/missing token → 403.
 *  - POST HMAC: bad signature → 401; good signature → 200; malformed JSON
 *    → 400; non-Meta object → 200 received (ignored).
 *  - Duplicate delivery → single processing: the same entry POSTed twice
 *    (Meta retries) creates exactly one message row — entry-level dedupe in
 *    the route plus per-message mid:/comment: dedupe in ingest.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET, POST } from "./route";
import { seenDeliveryIds } from "@/lib/integrations/ingest";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-app-secret-for-webhook-audit";
process.env.META_VERIFY_TOKEN = "test-verify-token-audit";
process.env.APP_PUBLIC_URL = "https://example.test";

function sign(raw: string): string {
  return (
    "sha256=" +
    createHmac("sha256", process.env.META_APP_SECRET as string)
      .update(raw, "utf8")
      .digest("hex")
  );
}

function getReq(url: string): NextRequest {
  return new NextRequest(url);
}

function postReq(raw: string, sig: string): NextRequest {
  return new NextRequest("http://x/api/webhooks/meta", {
    method: "POST",
    headers: { "x-hub-signature-256": sig, "content-type": "application/json" },
    body: raw,
  });
}

const suffix = `wh${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsId = "";
const pageId = `page-${suffix}`;
const mid = `mid.${suffix}.1`;

beforeAll(async () => {
  mockedRequireUser.mockResolvedValue({
    userId: "wh-user",
    email: "wh@example.com",
    user: { id: "wh-user", name: "WH", email: "wh@example.com" },
  } as any);
  const u = await db.user.create({
    data: { email: `wh-${suffix}@example.com`, name: "WH", passwordHash: "x" },
  });
  const org = await db.organization.create({ data: { name: `WH Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `WH WS ${suffix}`, slug: `wh-${suffix}` },
  });
  wsId = w.id;
  await db.membership.create({ data: { userId: u.id, workspaceId: w.id, role: "OWNER" } });
  // CONNECTED facebook row whose externalAccountId matches the test entry id.
  await db.integration.create({
    data: {
      workspaceId: w.id,
      provider: "facebook",
      status: "CONNECTED",
      externalAccountId: pageId,
      verifiedAt: new Date(),
    },
  });
});

function entryBody() {
  return JSON.stringify({
    object: "page",
    entry: [
      {
        id: pageId,
        time: 1_700_000_000,
        messaging: [
          {
            sender: { id: `user-${suffix}` },
            message: { mid, text: "hello audit" },
            timestamp: 1_700_000_000,
          },
        ],
      },
    ],
  });
}

async function messageCount(): Promise<number> {
  return db.message.count({
    where: { conversation: { workspaceId: wsId } },
  });
}

describe("webhook verification challenge (GET)", () => {
  it("echoes the challenge when the verify token matches", async () => {
    const res = await GET(
      getReq(
        `http://x/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-token-audit&hub.challenge=CHALLENGE123`
      )
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("CHALLENGE123");
  });

  it("rejects a wrong verify token with 403", async () => {
    const res = await GET(
      getReq(
        `http://x/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHALLENGE123`
      )
    );
    expect(res.status).toBe(403);
  });

  it("rejects a missing mode with 403", async () => {
    const res = await GET(getReq(`http://x/api/webhooks/meta?hub.challenge=CHALLENGE123`));
    expect(res.status).toBe(403);
  });
});

describe("webhook delivery (POST)", () => {
  it("rejects a bad HMAC signature with 401", async () => {
    const raw = entryBody();
    const res = await POST(postReq(raw, "sha256=" + "0".repeat(64)));
    expect(res.status).toBe(401);
  });

  it("rejects a missing signature with 401", async () => {
    const raw = entryBody();
    const res = await POST(postReq(raw, ""));
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON with 400 (signature of the raw bytes still checked)", async () => {
    const raw = "{not-json";
    const res = await POST(postReq(raw, sign(raw)));
    expect(res.status).toBe(400);
  });

  it("acknowledges and ignores non-Meta objects", async () => {
    const raw = JSON.stringify({ object: "user", entry: [] });
    const res = await POST(postReq(raw, sign(raw)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.received).toBe(true);
  });

  it("ingests a valid signed delivery (200)", async () => {
    const before = await messageCount();
    const raw = entryBody();
    const res = await POST(postReq(raw, sign(raw)));
    expect(res.status).toBe(200);
    expect(await messageCount()).toBe(before + 1);
  });

  it("duplicate delivery → single processing (Meta retry of the same entry)", async () => {
    const before = await messageCount();
    const raw = entryBody();
    // Same entry delivered again (same entry.id + time, same mid).
    const r1 = await POST(postReq(raw, sign(raw)));
    const r2 = await POST(postReq(raw, sign(raw)));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await messageCount()).toBe(before);
  });

  it("duplicate message id across entries → single processing", async () => {
    const before = await messageCount();
    const raw = JSON.stringify({
      object: "page",
      entry: [
        {
          id: pageId,
          time: 1_700_000_001,
          messaging: [
            {
              sender: { id: `user-${suffix}` },
              message: { mid, text: "hello audit again" },
              timestamp: 1_700_000_001,
            },
          ],
        },
      ],
    });
    const res = await POST(postReq(raw, sign(raw)));
    expect(res.status).toBe(200);
    // The mid was already seen in an earlier test — ingest must skip it.
    expect(await messageCount()).toBe(before);
    expect(seenDeliveryIds.has(`mid:${mid}`)).toBe(true);
  });
});
