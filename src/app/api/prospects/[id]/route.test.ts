/**
 * Wave 2D: prospect detail GET/PATCH/DELETE, workspace-scoped, dedupe on PATCH.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET, PATCH, DELETE } from "./route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `w2d-pid${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let wsA = "";
let wsB = "";
let prospectId = "";

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
const withId = (fn: (r: NextRequest, ctx: any) => Promise<Response>, r: NextRequest, id: string) =>
  fn(r, { params: { id } });

beforeAll(async () => {
  mockedRequireUser.mockImplementation(async () => ({ userId, email: "w2d@example.com", user: { id: userId } }) as any);
  const u = await db.user.create({ data: { email: `w2d-pid-${suffix}@example.com`, name: "W2D", passwordHash: "x" } });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `W2D PID Org ${suffix}` } });
  const wA = await db.workspace.create({ data: { orgId: org.id, name: `W2D PID A ${suffix}`, slug: `w2d-pid-a-${suffix}` } });
  const wB = await db.workspace.create({ data: { orgId: org.id, name: `W2D PID B ${suffix}`, slug: `w2d-pid-b-${suffix}` } });
  wsA = wA.id;
  wsB = wB.id;
  await db.membership.create({ data: { userId, workspaceId: wsA, role: "OWNER" } });
  await db.membership.create({ data: { userId, workspaceId: wsB, role: "OWNER" } });
  const p = await db.prospect.create({ data: { workspaceId: wsA, businessName: `Detail Co ${suffix}`, country: "EG" } });
  prospectId = p.id;
});

describe("prospect [id] routes", () => {
  it("GET returns the prospect in its own workspace, 404 in another", async () => {
    const okRes = await jsonBody(await withId(GET, req("http://x/api/prospects/x", wsA), prospectId));
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.prospect.id).toBe(prospectId);
    const cross = await jsonBody(await withId(GET, req("http://x/api/prospects/x", wsB), prospectId));
    expect(cross.status).toBe(404);
  });

  it("PATCH updates status and score", async () => {
    const res = await jsonBody(await withId(PATCH, req("http://x/api/prospects/x", wsA, { method: "PATCH", body: { status: "QUALIFIED", qualificationScore: 80 } }), prospectId));
    expect(res.status).toBe(200);
    expect(res.body.data.prospect.status).toBe("QUALIFIED");
    expect(res.body.data.prospect.qualificationScore).toBe(80);
  });

  it("PATCH to a duplicate identity returns 409", async () => {
    const other = await db.prospect.create({ data: { workspaceId: wsA, businessName: `Other Co ${suffix}`, country: "EG" } });
    const res = await jsonBody(await withId(PATCH, req("http://x/api/prospects/x", wsA, { method: "PATCH", body: { businessName: `Other Co ${suffix} LLC` } }), prospectId));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_PROSPECT");
    await db.prospect.delete({ where: { id: other.id } });
  });

  it("DELETE removes the prospect", async () => {
    const res = await jsonBody(await withId(DELETE, req("http://x/api/prospects/x", wsA, { method: "DELETE" }), prospectId));
    expect(res.status).toBe(200);
    expect(await db.prospect.findUnique({ where: { id: prospectId } })).toBeNull();
  });
});
