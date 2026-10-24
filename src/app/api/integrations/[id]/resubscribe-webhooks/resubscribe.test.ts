/**
 * Wave 2A (D6) — resubscribe-webhooks route (stubbed HTTP only).
 *
 * Proves:
 *  - an Instagram Business-Login row resubscribes via POST subscribed_apps
 *    and persists webhookSubscribedAt + sanitized webhookSubscriptionDetail
 *    (fields + checkedAt, no tokens);
 *  - facebook/whatsapp rows get an honest BLOCKED response and NO
 *    subscription timestamp is written (nothing faked).
 *
 * Auth is stubbed (same pattern as disconnect.test.ts); DB is the fresh
 * test.db per run.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { POST as resubPOST } from "./route";
import { encryptCredentials } from "@/lib/integrations/meta";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-app-secret";
process.env.META_VERIFY_TOKEN = "test-verify-token";
process.env.APP_PUBLIC_URL = "https://example.test";

const suffix = `rs${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let wsId = "";

beforeAll(async () => {
  const u = await db.user.create({
    data: { email: `rs-${suffix}@example.com`, name: "Resub", passwordHash: "x" },
  });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `Resub Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `Resub WS ${suffix}`, slug: `rs-${suffix}` },
  });
  wsId = w.id;
  await db.membership.create({ data: { userId: u.id, workspaceId: w.id, role: "OWNER" } });
  mockedRequireUser.mockResolvedValue({
    userId,
    email: `rs-${suffix}@example.com`,
    user: { id: userId, name: "Resub", email: `rs-${suffix}@example.com` },
  } as any);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (wsId) await db.integration.deleteMany({ where: { workspaceId: wsId } });
});

function req(url: string): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "x-workspace-id": wsId },
  });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

describe("POST /api/integrations/[id]/resubscribe-webhooks", () => {
  it("resubscribes an instagram_login row and persists subscription state", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      })
    );
    const secretToken = `ig-resub-token-${suffix}`;
    const row = await db.integration.create({
      data: {
        workspaceId: wsId,
        provider: "instagram",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "instagram",
          loginType: "instagram_login",
          accessToken: secretToken,
          expiresAt: null,
          igUserId: `ig-${suffix}`,
        }),
      },
    });
    const { status, body } = await jsonBody(
      await resubPOST(req(`https://example.test/api/integrations/${row.id}/resubscribe-webhooks`), {
        params: Promise.resolve({ id: row.id }),
      } as any)
    );
    expect(status).toBe(200);
    expect(body.data.subscribed).toBe(true);
    expect(calls.some((u) => u.includes("/subscribed_apps"))).toBe(true);
    const updated = await db.integration.findUnique({ where: { id: row.id } });
    expect(updated!.webhookSubscribedAt).not.toBeNull();
    expect(updated!.webhookSubscriptionDetail).toContain("messages");
    expect(updated!.webhookSubscriptionDetail).not.toContain(secretToken);
  });

  it("facebook rows get BLOCKED and no subscription timestamp is written", async () => {
    const row = await db.integration.create({
      data: {
        workspaceId: wsId,
        provider: "facebook",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "facebook",
          accessToken: `fb-token-${suffix}`,
          expiresAt: null,
          pageId: `page-${suffix}`,
        }),
      },
    });
    const { status, body } = await jsonBody(
      await resubPOST(req(`https://example.test/api/integrations/${row.id}/resubscribe-webhooks`), {
        params: Promise.resolve({ id: row.id }),
      } as any)
    );
    expect(status).toBe(200);
    expect(body.blocked).toBe(true);
    expect(body.reason).toMatch(/dashboard/i);
    const updated = await db.integration.findUnique({ where: { id: row.id } });
    expect(updated!.webhookSubscribedAt).toBeNull();
  });
});
