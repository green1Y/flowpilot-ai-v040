/**
 * Wave 2D: prospect searches always land in BLOCKED_NO_SOURCE (no provider
 * configured) — never fabricated results. MANAGER+ for create.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET, POST } from "./route";
import { SEARCH_PROVIDER_NOT_CONFIGURED, SEARCH_PROVIDER_PREREQUISITE } from "@/lib/prospecting/providers";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `w2d-ps${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let ws = "";
let wsAgent = "";

function req(url: string, workspaceId: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: { "x-workspace-id": workspaceId, "content-type": "application/json" },
  });
}
async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  mockedRequireUser.mockImplementation(async () => ({ userId, email: "w2d@example.com", user: { id: userId } }) as any);
  const u = await db.user.create({ data: { email: `w2d-ps-${suffix}@example.com`, name: "W2D", passwordHash: "x" } });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `W2D PS Org ${suffix}` } });
  const w = await db.workspace.create({ data: { orgId: org.id, name: `W2D PS ${suffix}`, slug: `w2d-ps-${suffix}` } });
  ws = w.id;
  await db.membership.create({ data: { userId, workspaceId: ws, role: "OWNER" } });
  const w2 = await db.workspace.create({ data: { orgId: org.id, name: `W2D PS2 ${suffix}`, slug: `w2d-ps2-${suffix}` } });
  wsAgent = w2.id;
  await db.membership.create({ data: { userId, workspaceId: wsAgent, role: "AGENT" } });
});

describe("POST /api/prospects/searches", () => {
  it("creates a BLOCKED_NO_SOURCE search with the prerequisite, no prospects", async () => {
    const res = await jsonBody(await POST(req("http://x/api/prospects/searches", ws, {
      method: "POST",
      body: { industry: "Plumbing", country: "EG", region: "Cairo", keywords: ["emergency"], targetCount: 25 },
    })));
    expect(res.status).toBe(201);
    expect(res.body.data.search.status).toBe("BLOCKED_NO_SOURCE");
    expect(res.body.data.search.error).toBe(SEARCH_PROVIDER_PREREQUISITE);
    expect(res.body.data.blocked).toBe(true);
    expect(res.body.data.code).toBe(SEARCH_PROVIDER_NOT_CONFIGURED);
    expect(res.body.data.prerequisite).toBe(SEARCH_PROVIDER_PREREQUISITE);
    const prospects = await db.prospect.findMany({ where: { searchId: res.body.data.search.id } });
    expect(prospects).toEqual([]);
  });

  it("rejects missing industry with 422 and targetCount > 500 with 422", async () => {
    const noIndustry = await jsonBody(await POST(req("http://x/api/prospects/searches", ws, { method: "POST", body: { country: "EG" } })));
    expect(noIndustry.status).toBe(422);
    const tooMany = await jsonBody(await POST(req("http://x/api/prospects/searches", ws, { method: "POST", body: { industry: "Plumbing", targetCount: 501 } })));
    expect(tooMany.status).toBe(422);
  });

  it("rejects AGENT (below MANAGER) with 403", async () => {
    const res = await jsonBody(await POST(req("http://x/api/prospects/searches", wsAgent, { method: "POST", body: { industry: "Plumbing" } })));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/prospects/searches", () => {
  it("lists searches for the workspace", async () => {
    const res = await jsonBody(await GET(req("http://x/api/prospects/searches", ws)));
    expect(res.status).toBe(200);
    expect(res.body.data.searches.some((s: any) => s.status === "BLOCKED_NO_SOURCE")).toBe(true);
  });
});
