/**
 * Analytics export role gate (Batch A item 9).
 *
 * Exports carry up to 10k rows including message bodies, so the route now
 * requires MANAGER+ (matching the billing read gate): an AGENT member gets
 * 403, a MANAGER gets the CSV.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `expr${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsId = "";
let agentId = "";
let managerId = "";

function asUser(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Exp", email },
  } as any);
}

function req(): NextRequest {
  return new NextRequest("http://x/api/analytics/export?metric=leads", {
    headers: { "x-workspace-id": wsId },
  });
}

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: `ExpRole Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `ExpRole WS ${suffix}`, slug: `expr-${suffix}` },
  });
  wsId = w.id;
  const agent = await db.user.create({
    data: { email: `agent-${suffix}@example.com`, name: "Agent", passwordHash: "x" },
  });
  const manager = await db.user.create({
    data: { email: `mgr-${suffix}@example.com`, name: "Manager", passwordHash: "x" },
  });
  agentId = agent.id;
  managerId = manager.id;
  await db.membership.create({ data: { userId: agent.id, workspaceId: w.id, role: "AGENT" } });
  await db.membership.create({ data: { userId: manager.id, workspaceId: w.id, role: "MANAGER" } });
});

describe("analytics export role gate", () => {
  it("rejects an AGENT member with 403", async () => {
    asUser(agentId, `agent-${suffix}@example.com`);
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it("allows a MANAGER member (200 + CSV)", async () => {
    asUser(managerId, `mgr-${suffix}@example.com`);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
  });
});
