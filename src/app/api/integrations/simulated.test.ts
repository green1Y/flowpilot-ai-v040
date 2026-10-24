/**
 * Simulated provider lifecycle tests (telegram, youtube, linkedin, x,
 * email, webchat, sheets, zapier).
 *
 * These providers have NO real OAuth — they use the honest mock adapter.
 * This suite pins the honest behavior: connect never marks CONNECTED
 * directly (NEEDS_ATTENTION until verify), verify is explicit, disconnect
 * clears credentials, and sends are always mocked:true.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getAdapter } from "@/lib/integrations/providers";
import { POST as connectPOST } from "./[id]/connect/route";
import { POST as verifyPOST } from "./[id]/verify/route";
import { POST as disconnectPOST } from "./[id]/disconnect/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Sim Test", email },
  } as any);
}

function req(url: string, workspaceId: string, method = "POST"): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "x-workspace-id": workspaceId, "content-type": "application/json" },
  });
}

const suffix = `sim${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsA = "";
let userA = "";

beforeAll(async () => {
  const a = await db.user.create({
    data: { email: `sim-a-${suffix}@example.com`, name: "Sim A", passwordHash: "x" },
  });
  userA = a.id;
  const org = await db.organization.create({ data: { name: `Sim Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `Sim WS ${suffix}`, slug: `sim-${suffix}` },
  });
  wsA = w.id;
  await db.membership.create({ data: { userId: a.id, workspaceId: w.id, role: "OWNER" } });
  authedAs(userA, `sim-a-${suffix}@example.com`);
});

describe("simulated provider lifecycle (telegram)", () => {
  it("connect returns NEEDS_ATTENTION, never CONNECTED, and no OAuth URL", async () => {
    const res = await connectPOST(
      req("http://x/api/integrations/telegram/connect", wsA),
      { params: { id: "telegram" } }
    );
    const { status, body } = { status: res.status, body: (await res.json()) as any };
    expect(status).toBe(200);
    // No OAuth URL for simulated providers (Meta providers return one).
    expect(body.data.url).toBeUndefined();
    expect(body.data.status).toBe("NEEDS_ATTENTION");
    expect(body.data.status).not.toBe("CONNECTED");

    const row = await db.integration.findFirst({
      where: { workspaceId: wsA, provider: "telegram" },
    });
    expect(row?.status).toBe("NEEDS_ATTENTION");
  });

  it("verify marks CONNECTED via the explicit mock handshake", async () => {
    const row = await db.integration.findFirstOrThrow({
      where: { workspaceId: wsA, provider: "telegram" },
    });
    const res = await verifyPOST(
      req(`http://x/api/integrations/${row.id}/verify`, wsA),
      { params: { id: row.id } }
    );
    expect(res.status).toBe(200);
    const updated = await db.integration.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("CONNECTED");
    expect(updated.verifiedAt).toBeTruthy();
  });

  it("disconnect clears credentials and marks DISCONNECTED", async () => {
    const row = await db.integration.findFirstOrThrow({
      where: { workspaceId: wsA, provider: "telegram" },
    });
    const res = await disconnectPOST(
      req(`http://x/api/integrations/${row.id}/disconnect`, wsA),
      { params: { id: row.id } }
    );
    expect(res.status).toBe(200);
    const updated = await db.integration.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("DISCONNECTED");
    expect(updated.encryptedCredentials).toBeNull();
  });

  it("mock adapter never performs a real send (mocked:true, no external id)", async () => {
    const adapter = await getAdapter("youtube");
    const result = await adapter.sendMessage({ to: "x", body: "hello" });
    expect(result.mocked).toBe(true);
    expect(result.externalId).toBeNull();
  });

  it("mock adapter connect is honest about being simulated", async () => {
    const adapter = await getAdapter("linkedin");
    const result = await adapter.connect({});
    expect(result.status).toBe("NEEDS_ATTENTION");
    expect(result.verified).toBe(false);
  });
});
