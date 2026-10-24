/**
 * Security regression tests: tenant isolation on integration routes.
 *
 * Proves a user cannot list, test, or disconnect another workspace's
 * integrations. Auth is stubbed (same pattern as stage2.test.ts); no real
 * provider API calls are made — the Meta test row carries no credentials,
 * so the owner's request fails at the credentials check (422), while a
 * foreign workspace must fail earlier with 404 (row invisible).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET as listGET } from "./route";
import { POST as disconnectPOST } from "./[id]/disconnect/route";
import { POST as testPOST } from "./[id]/test/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Sec Test", email },
  } as any);
}

function req(
  url: string,
  workspaceId: string,
  init?: { method?: string; body?: unknown }
): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: {
      "x-workspace-id": workspaceId,
      "content-type": "application/json",
    },
  });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

const suffix = `sec${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsA = "";
let wsB = "";
let userA = "";
let userB = "";
let userC = "";
let intAId = "";

beforeAll(async () => {
  const a = await db.user.create({
    data: { email: `sec-a-${suffix}@example.com`, name: "Sec A", passwordHash: "x" },
  });
  const b = await db.user.create({
    data: { email: `sec-b-${suffix}@example.com`, name: "Sec B", passwordHash: "x" },
  });
  const c = await db.user.create({
    data: { email: `sec-c-${suffix}@example.com`, name: "Sec C", passwordHash: "x" },
  });
  userA = a.id;
  userB = b.id;
  userC = c.id;
  const orgA = await db.organization.create({ data: { name: `Sec Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `Sec Org B ${suffix}` } });
  const wA = await db.workspace.create({
    data: { orgId: orgA.id, name: `Sec WS A ${suffix}`, slug: `sec-a-${suffix}` },
  });
  const wB = await db.workspace.create({
    data: { orgId: orgB.id, name: `Sec WS B ${suffix}`, slug: `sec-b-${suffix}` },
  });
  wsA = wA.id;
  wsB = wB.id;
  await db.membership.create({ data: { userId: a.id, workspaceId: wA.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: b.id, workspaceId: wB.id, role: "OWNER" } });
  // userC has no membership anywhere.

  // A's integration row carries NO credentials: owner's test hits the
  // credentials check (422); a foreign workspace must 404 first.
  const intA = await db.integration.create({
    data: { workspaceId: wsA, provider: "facebook", status: "NEEDS_ATTENTION" },
  });
  intAId = intA.id;
});

describe("integration tenant isolation", () => {
  it("list never leaks another workspace's rows", async () => {
    authedAs(userA, `sec-a-${suffix}@example.com`);
    const { status, body } = await jsonBody(await listGET(req("http://x/api/integrations", wsA)));
    expect(status).toBe(200);
    const rows = body.data.integrations;
    const fbA = rows.find((r: any) => r.provider === "facebook");
    expect(fbA.status).toBe("NEEDS_ATTENTION");
    expect(fbA.id).toBe(intAId);

    authedAs(userB, `sec-b-${suffix}@example.com`);
    const bRes = await jsonBody(await listGET(req("http://x/api/integrations", wsB)));
    expect(bRes.status).toBe(200);
    const bRows = bRes.body.data.integrations;
    const fbB = bRows.find((r: any) => r.provider === "facebook");
    // B gets a fresh DEMO row — never A's row id or A's status.
    expect(fbB.status).toBe("DEMO");
    expect(fbB.id).not.toBe(intAId);
    expect(bRows.some((r: any) => r.id === intAId)).toBe(false);
  });

  it("disconnect 404s for another workspace's integration", async () => {
    authedAs(userB, `sec-b-${suffix}@example.com`);
    const { status } = await jsonBody(
      await disconnectPOST(req(`http://x/api/integrations/${intAId}/disconnect`, wsB, { method: "POST" }), {
        params: { id: intAId },
      })
    );
    expect(status).toBe(404);

    // Owner can disconnect their own row.
    authedAs(userA, `sec-a-${suffix}@example.com`);
    const own = await jsonBody(
      await disconnectPOST(req(`http://x/api/integrations/${intAId}/disconnect`, wsA, { method: "POST" }), {
        params: { id: intAId },
      })
    );
    expect(own.status).toBe(200);
    expect(own.body.data.status).toBe("DISCONNECTED");
  });

  it("test 404s for another workspace's integration (owner gets 422, not 404)", async () => {
    // The list test auto-created DEMO rows for every provider in wsA.
    const existingRow = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "instagram" },
    });
    const intA2 = existingRow
      ? await db.integration.update({ where: { id: existingRow.id }, data: { status: "NEEDS_ATTENTION", encryptedCredentials: null } })
      : await db.integration.create({ data: { workspaceId: wsA, provider: "instagram", status: "NEEDS_ATTENTION" } });

    authedAs(userB, `sec-b-${suffix}@example.com`);
    const foreign = await jsonBody(
      await testPOST(req(`http://x/api/integrations/${intA2.id}/test`, wsB, { method: "POST" }), {
        params: { id: intA2.id },
      })
    );
    expect(foreign.status).toBe(404);

    authedAs(userA, `sec-a-${suffix}@example.com`);
    const own = await jsonBody(
      await testPOST(req(`http://x/api/integrations/${intA2.id}/test`, wsA, { method: "POST" }), {
        params: { id: intA2.id },
      })
    );
    // Owner reaches the row (mocked test runs for non-CONNECTED rows) —
    // proves the row was found for the owner but is invisible (404) to the
    // foreign workspace.
    expect(own.status).toBe(200);
    expect(own.body.data.mocked).toBe(true);
  });

  it("rejects a user without membership in the workspace (403)", async () => {
    // User C belongs to workspace C — requesting workspace A must 403
    // (never reveal whether the workspace exists).
    const orgC = await db.organization.create({ data: { name: `Sec Org C ${suffix}` } });
    const wC = await db.workspace.create({
      data: { orgId: orgC.id, name: `Sec WS C ${suffix}`, slug: `sec-c-${suffix}` },
    });
    await db.membership.create({ data: { userId: userC, workspaceId: wC.id, role: "OWNER" } });

    authedAs(userC, `sec-c-${suffix}@example.com`);
    const { status } = await jsonBody(await listGET(req("http://x/api/integrations", wsA)));
    expect(status).toBe(403);
  });
});
