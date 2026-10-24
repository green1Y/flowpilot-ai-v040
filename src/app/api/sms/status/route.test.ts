/** Wave 2D: SMS status endpoint reports honestly unconfigured (Member-readable). */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { GET } from "./route";
import { SMS_PROVIDER_NOT_CONFIGURED } from "@/lib/sms/providers";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `w2d-sms${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userId = "";
let ws = "";

beforeAll(async () => {
  mockedRequireUser.mockImplementation(async () => ({ userId, email: "w2d@example.com", user: { id: userId } }) as any);
  const u = await db.user.create({ data: { email: `w2d-sms-${suffix}@example.com`, name: "W2D", passwordHash: "x" } });
  userId = u.id;
  const org = await db.organization.create({ data: { name: `W2D SMS Org ${suffix}` } });
  const w = await db.workspace.create({ data: { orgId: org.id, name: `W2D SMS ${suffix}`, slug: `w2d-sms-${suffix}` } });
  ws = w.id;
  await db.membership.create({ data: { userId, workspaceId: ws, role: "ANALYST" } });
});

describe("GET /api/sms/status", () => {
  it("returns configured:false with the prerequisite, even for ANALYST", async () => {
    const res = await GET(new NextRequest("http://x/api/sms/status", { headers: { "x-workspace-id": ws } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.sms.configured).toBe(false);
    expect(body.data.sms.code).toBe(SMS_PROVIDER_NOT_CONFIGURED);
    expect(body.data.sms.supported).toEqual([]);
    expect(body.data.sms.prerequisite).toContain("SMS_PROVIDER");
  });
});
