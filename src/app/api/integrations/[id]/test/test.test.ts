/**
 * Wave 2A (item 7) — test-route identity upgrade (stubbed HTTP only).
 *
 * Before the upgrade, the Meta test was refresh-only ("Token valid — no
 * message sent") and passed for a row whose asset no longer existed. Now
 * Test Connection ALSO performs the identity check (same primitives as
 * verify), so a passing test proves the asset exists. Response shape
 * { ok, mocked, latencyMs, note }, the MANAGER+ gate, and audit logging
 * are unchanged; simulated providers still return mocked:true with a
 * SIMULATED note.
 *
 * Auth is stubbed (same pattern as disconnect.test.ts); DB is the fresh
 * test.db per run.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { POST as testPOST } from "./route";
import { encryptCredentials } from "@/lib/integrations/meta";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-app-secret";
process.env.META_VERIFY_TOKEN = "test-verify-token";
process.env.APP_PUBLIC_URL = "https://example.test";

const suffix = `tt${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let wsId = "";

beforeAll(async () => {
  const u = await db.user.create({
    data: { email: `tt-${suffix}@example.com`, name: "TestConn", passwordHash: "x" },
  });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `TestConn Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `TestConn WS ${suffix}`, slug: `tt-${suffix}` },
  });
  wsId = w.id;
  await db.membership.create({ data: { userId: u.id, workspaceId: w.id, role: "OWNER" } });
  mockedRequireUser.mockResolvedValue({
    userId,
    email: `tt-${suffix}@example.com`,
    user: { id: userId, name: "TestConn", email: `tt-${suffix}@example.com` },
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

describe("POST /api/integrations/[id]/test — identity upgrade", () => {
  it("passes for a Business-Login row only after the IG identity check succeeds", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: `ig-${suffix}`, username: "biz_account" }),
        };
      })
    );
    const row = await db.integration.create({
      data: {
        workspaceId: wsId,
        provider: "instagram",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "instagram",
          loginType: "instagram_login",
          accessToken: `ig-token-${suffix}`,
          expiresAt: null,
          igUserId: `ig-${suffix}`,
        }),
      },
    });
    const { status, body } = await jsonBody(
      await testPOST(req(`https://example.test/api/integrations/${row.id}/test`), {
        params: Promise.resolve({ id: row.id }),
      } as any)
    );
    expect(status).toBe(200);
    expect(body.data.ok).toBe(true);
    expect(body.data.mocked).toBe(false);
    expect(typeof body.data.latencyMs).toBe("number");
    expect(body.data.note).toMatch(/identity verified/i);
    // The identity endpoint was actually hit — not refresh-only.
    expect(calls.some((u) => u.includes("graph.instagram.com"))).toBe(true);
  });

  it("fails when the identity check fails (asset gone), even with a valid token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "Unsupported request", code: 100 } }),
      }))
    );
    const row = await db.integration.create({
      data: {
        workspaceId: wsId,
        provider: "instagram",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "instagram",
          loginType: "instagram_login",
          accessToken: `ig-token-${suffix}`,
          expiresAt: null,
          igUserId: `ig-${suffix}`,
        }),
      },
    });
    const { status } = await jsonBody(
      await testPOST(req(`https://example.test/api/integrations/${row.id}/test`), {
        params: Promise.resolve({ id: row.id }),
      } as any)
    );
    // Refresh-only would have passed (expiresAt null → no refresh needed);
    // the identity check must fail the test instead.
    expect(status).toBe(422);
  });

  it("simulated providers still return mocked:true with a SIMULATED note", async () => {
    const row = await db.integration.create({
      data: { workspaceId: wsId, provider: "telegram", status: "DEMO" },
    });
    const { status, body } = await jsonBody(
      await testPOST(req(`https://example.test/api/integrations/${row.id}/test`), {
        params: Promise.resolve({ id: row.id }),
      } as any)
    );
    expect(status).toBe(200);
    expect(body.data.mocked).toBe(true);
    expect(body.data.note).toMatch(/SIMULATED/i);
  });
});
