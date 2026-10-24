/**
 * Analytics CSV export — produces valid CSV from real, tenant-scoped DB rows
 * (Workstream E). Covers: header row + data rows for messages/leads,
 * date-only bounds including the full end day, channel=all behaving as no
 * filter, tenant isolation, and honest truncation reporting.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `exp${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsA = "";
let wsB = "";

function req(url: string, ws: string): NextRequest {
  return new NextRequest(url, { headers: { "x-workspace-id": ws } });
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  const mk = async (tag: string) => {
    const user = await db.user.create({
      data: { email: `exp-${tag}-${suffix}@example.com`, name: "Exp", passwordHash: "x" },
    });
    const org = await db.organization.create({ data: { name: `Exp Org ${tag} ${suffix}` } });
    const w = await db.workspace.create({
      data: { orgId: org.id, name: `Exp WS ${tag} ${suffix}`, slug: `exp-${tag}-${suffix}` },
    });
    await db.membership.create({ data: { userId: user.id, workspaceId: w.id, role: "OWNER" } });
    return { user, w };
  };
  const a = await mk("a");
  const b = await mk("b");
  wsA = a.w.id;
  wsB = b.w.id;
  mockedRequireUser.mockResolvedValue({ userId: a.user.id, email: a.user.email, user: a.user } as any);

  const yesterday = new Date(Date.now() - 24 * 3_600_000);
  const contact = await db.contact.create({
    data: {
      workspaceId: wsA,
      name: 'Comma, "Quoted" Lead',
      email: "lead@example.com",
      channel: "instagram",
      firstSeenAt: yesterday,
      lastSeenAt: yesterday,
    },
  });
  const conv = await db.conversation.create({
    data: {
      workspaceId: wsA,
      contactId: contact.id,
      channel: "instagram",
      createdAt: yesterday,
      updatedAt: yesterday,
    },
  });
  await db.message.create({
    data: {
      conversationId: conv.id,
      direction: "OUTBOUND",
      body: 'Hello, "world" — with a comma, and\nnewline',
      createdAt: yesterday,
    },
  });
  // Another workspace's data must never leak into A's export.
  await db.contact.create({
    data: { workspaceId: wsB, name: "Foreign Contact", channel: "web" },
  });
});

describe("CSV export", () => {
  it("exports messages as valid, escaped CSV from real rows", async () => {
    const from = isoDay(new Date(Date.now() - 2 * 86_400_000));
    const to = isoDay(new Date());
    const res = await GET(req(`http://x/api/analytics/export?metric=messages&from=${from}&to=${to}`, wsA));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("x-truncated")).toBe("false");
    const csv = await res.text();
    const lines = csv.split("\n");
    expect(lines[0]).toContain("message_id");
    expect(lines[0]).toContain("body");
    expect(res.headers.get("x-rows")).toBe("1"); // one data row (body has an embedded \n, so raw line count is 3)
    // Quoting/escaping is CSV-valid: embedded quotes doubled, field quoted.
    expect(csv).toContain('"Hello, ""world"" — with a comma, and\nnewline"');
    expect(csv).toContain("instagram");
    expect(csv).not.toContain("Foreign Contact");
  });

  it("date-only to bound includes the full end day", async () => {
    const day = isoDay(new Date(Date.now() - 24 * 3_600_000)); // message day
    const res = await GET(
      req(`http://x/api/analytics/export?metric=messages&from=${day}&to=${day}`, wsA)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-rows")).toBe("1");
  });

  it("channel=all behaves like no filter", async () => {
    const from = isoDay(new Date(Date.now() - 2 * 86_400_000));
    const to = isoDay(new Date());
    const res = await GET(
      req(`http://x/api/analytics/export?metric=messages&from=${from}&to=${to}&channel=all`, wsA)
    );
    expect(res.headers.get("x-rows")).toBe("1");
  });

  it("exports leads from real contacts", async () => {
    const from = isoDay(new Date(Date.now() - 2 * 86_400_000));
    const to = isoDay(new Date());
    const res = await GET(req(`http://x/api/analytics/export?metric=leads&from=${from}&to=${to}`, wsA));
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv.split("\n")[0]).toContain("contact_id");
    expect(csv).toContain('"Comma, ""Quoted"" Lead"'); // escaped name
    expect(csv).not.toContain("Foreign Contact"); // tenant isolation
  });

  it("rejects an unknown metric", async () => {
    const res = await GET(req("http://x/api/analytics/export?metric=revenue", wsA));
    expect(res.status).toBe(422);
  });
});
