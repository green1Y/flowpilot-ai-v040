/**
 * Wave 2D: prospect CSV export neutralizes formula-injection cells; MANAGER+.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET } from "./route";
import { neutralizeCell } from "@/lib/csv";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `w2d-px${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let ws = "";
let wsAgent = "";

function req(url: string, workspaceId: string): NextRequest {
  return new NextRequest(url, { headers: { "x-workspace-id": workspaceId } });
}

beforeAll(async () => {
  mockedRequireUser.mockImplementation(async () => ({ userId, email: "w2d@example.com", user: { id: userId } }) as any);
  const u = await db.user.create({ data: { email: `w2d-px-${suffix}@example.com`, name: "W2D", passwordHash: "x" } });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `W2D PX Org ${suffix}` } });
  const w = await db.workspace.create({ data: { orgId: org.id, name: `W2D PX ${suffix}`, slug: `w2d-px-${suffix}` } });
  ws = w.id;
  await db.membership.create({ data: { userId, workspaceId: ws, role: "OWNER" } });
  const w2 = await db.workspace.create({ data: { orgId: org.id, name: `W2D PX2 ${suffix}`, slug: `w2d-px2-${suffix}` } });
  wsAgent = w2.id;
  await db.membership.create({ data: { userId, workspaceId: wsAgent, role: "AGENT" } });
  await db.prospect.create({ data: { workspaceId: ws, businessName: `=2+5+cmd|' /C calc'!A0 ${suffix}`, industry: "Plumbing" } });
  await db.prospect.create({ data: { workspaceId: ws, businessName: `Plain Co ${suffix}`, email: "plain@example.com" } });
});

describe("prospect export", () => {
  it("neutralizes cells starting with = + - @ | %", () => {
    expect(neutralizeCell("=2+5")).toBe("'=2+5");
    expect(neutralizeCell("+cmd")).toBe("'+cmd");
    expect(neutralizeCell("-2")).toBe("'-2");
    expect(neutralizeCell("@import")).toBe("'@import");
    expect(neutralizeCell("|calc")).toBe("'|calc");
    expect(neutralizeCell("%x")).toBe("'%x");
    expect(neutralizeCell("Plain Co")).toBe("Plain Co");
    expect(neutralizeCell(null)).toBe("");
  });

  it("exports CSV with the formula cell neutralized and a CSV content type", async () => {
    const res = await GET(req("http://x/api/prospects/export", ws));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\n")[0]).toContain("businessName");
    expect(text).toContain(`'=2+5+cmd|' /C calc'!A0 ${suffix}`);
    expect(text).not.toContain(`\n=2+5`);
  });

  it("rejects AGENT (below MANAGER) with 403", async () => {
    const res = await GET(req("http://x/api/prospects/export", wsAgent));
    expect(res.status).toBe(403);
  });
});
