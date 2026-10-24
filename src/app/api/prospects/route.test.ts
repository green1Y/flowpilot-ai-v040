/**
 * Wave 2D: prospects list + manual create (dedupe 409, validation, roles, tenancy).
 * Auth stubbed; DB is the shared test.db (coordinator runs suites serially).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `w2d-p${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let ws = "";
let wsAnalyst = "";

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
  const u = await db.user.create({ data: { email: `w2d-p-${suffix}@example.com`, name: "W2D", passwordHash: "x" } });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `W2D Org ${suffix}` } });
  const w = await db.workspace.create({ data: { orgId: org.id, name: `W2D WS ${suffix}`, slug: `w2d-p-${suffix}` } });
  ws = w.id;
  await db.membership.create({ data: { userId, workspaceId: ws, role: "OWNER" } });
  const w2 = await db.workspace.create({ data: { orgId: org.id, name: `W2D WS2 ${suffix}`, slug: `w2d-p2-${suffix}` } });
  wsAnalyst = w2.id;
  await db.membership.create({ data: { userId, workspaceId: wsAnalyst, role: "ANALYST" } });
});

describe("GET /api/prospects", () => {
  it("lists workspace prospects and filters by status/country/search", async () => {
    const created = await jsonBody(await POST(req("http://x/api/prospects", ws, { method: "POST", body: { businessName: `Filter Co ${suffix}`, country: "EG", industry: "Plumbing" } })));
    expect(created.status).toBe(201);
    const all = await jsonBody(await GET(req("http://x/api/prospects", ws)));
    expect(all.body.data.prospects.some((p: any) => p.id === created.body.data.prospect.id)).toBe(true);
    const filtered = await jsonBody(await GET(req(`http://x/api/prospects?country=EG&search=Filter%20Co`, ws)));
    expect(filtered.body.data.prospects.some((p: any) => p.id === created.body.data.prospect.id)).toBe(true);
    const none = await jsonBody(await GET(req("http://x/api/prospects?country=SA", ws)));
    expect(none.body.data.prospects.some((p: any) => p.id === created.body.data.prospect.id)).toBe(false);
  });
});

describe("POST /api/prospects", () => {
  it("creates a manual prospect, flagged unverified when no sourceUrl", async () => {
    const res = await jsonBody(await POST(req("http://x/api/prospects", ws, { method: "POST", body: { businessName: `Manual Co ${suffix}`, email: "hi@manual.example" } })));
    expect(res.status).toBe(201);
    expect(res.body.data.prospect.businessName).toBe(`Manual Co ${suffix}`);
    expect(res.body.data.prospect.verified).toBe(false);
    expect(res.body.data.prospect.sourceType).toBe("manual");
  });

  it("marks a prospect verified when a sourceUrl is supplied", async () => {
    const res = await jsonBody(await POST(req("http://x/api/prospects", ws, { method: "POST", body: { businessName: `Sourced Co ${suffix}`, sourceUrl: "https://example.com/directory/sourced" } })));
    expect(res.status).toBe(201);
    expect(res.body.data.prospect.verified).toBe(true);
  });

  it("returns 409 DUPLICATE_PROSPECT on normalized domain match", async () => {
    await jsonBody(await POST(req("http://x/api/prospects", ws, { method: "POST", body: { businessName: `Dupe Domain ${suffix}`, website: "https://www.dupe.example" } })));
    const res = await jsonBody(await POST(req("http://x/api/prospects", ws, { method: "POST", body: { businessName: "Someone Else", website: "dupe.example/" } })));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_PROSPECT");
    expect(typeof res.body.existingId).toBe("string");
  });

  it("returns 409 DUPLICATE_PROSPECT on normalized name + country match", async () => {
    await jsonBody(await POST(req("http://x/api/prospects", ws, { method: "POST", body: { businessName: `Nile Bakery ${suffix}`, country: "EG" } })));
    const res = await jsonBody(await POST(req("http://x/api/prospects", ws, { method: "POST", body: { businessName: `Nile Bakery ${suffix}, LLC`, country: "eg" } })));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_PROSPECT");
  });

  it("rejects a missing businessName with 422", async () => {
    const res = await jsonBody(await POST(req("http://x/api/prospects", ws, { method: "POST", body: { industry: "Plumbing" } })));
    expect(res.status).toBe(422);
  });

  it("rejects ANALYST (below AGENT) with 403", async () => {
    const res = await jsonBody(await POST(req("http://x/api/prospects", wsAnalyst, { method: "POST", body: { businessName: "Nope Co" } })));
    expect(res.status).toBe(403);
  });

  it("scores via criteria when supplied", async () => {
    const res = await jsonBody(await POST(req("http://x/api/prospects", ws, { method: "POST", body: { businessName: `Scored Co ${suffix}`, email: "s@scored.example", criteria: { requiredFields: ["email", "website"] } } })));
    expect(res.status).toBe(201);
    expect(res.body.data.prospect.qualificationScore).toBe(10);
    expect(res.body.data.prospect.qualificationReasons).toContain("has email (+10)");
  });
});
