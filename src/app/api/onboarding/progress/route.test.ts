/**
 * Onboarding progress API tests (Phase 4).
 * - GET returns (or creates) a default progress row scoped to user+workspace.
 * - PUT upserts validated progress; invalid bodies are rejected with 422.
 * - Tenant isolation: progress is keyed by (userId, workspaceId); a 404 from
 *   requireWorkspace propagates (user with no workspace cannot read/write).
 * requireWorkspace is stubbed (same pattern as security.test.ts); DB is the
 * fresh test.db per run.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/tenancy";
import { GET, PUT } from "./route";

vi.mock("@/lib/tenancy", () => ({ requireWorkspace: vi.fn() }));
const mockedRequireWorkspace = vi.mocked(requireWorkspace);

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let userA: string, wsA: string, userB: string, wsB: string;

beforeAll(async () => {
  const mk = async (tag: string) => {
    const u = await db.user.create({
      data: { email: `ob-${tag}-${suffix}@example.com`, name: `OB ${tag}`, passwordHash: "x" },
    });
    const org = await db.organization.create({ data: { name: `OB Org ${tag}` } });
    const ws = await db.workspace.create({
      data: { name: `OB WS ${tag}`, slug: `ob-ws-${tag}-${suffix}`, orgId: org.id },
    });
    await db.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "OWNER" } });
    return { userId: u.id, workspaceId: ws.id };
  };
  ({ userId: userA, workspaceId: wsA } = await mk("a"));
  ({ userId: userB, workspaceId: wsB } = await mk("b"));
});

function authed(userId: string, workspaceId: string) {
  mockedRequireWorkspace.mockResolvedValue({ userId, workspaceId, role: "OWNER" });
}

function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "x-workspace-id": wsA, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("GET /api/onboarding/progress", () => {
  it("creates and returns a default progress row on first read", async () => {
    authed(userA, wsA);
    const res = await GET(req("http://x/api/onboarding/progress", "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.progress.currentStep).toBe(0);
    expect(body.data.progress.stepsDone).toEqual([]);
    expect(body.data.progress.skipped).toEqual([]);
    expect(body.data.progress.data).toEqual({});
    expect(body.data.progress.completedAt).toBeNull();
  });

  it("is scoped per user+workspace (no cross-tenant leak)", async () => {
    authed(userB, wsB);
    const res = await GET(req("http://x/api/onboarding/progress", "GET"));
    const body = (await res.json()) as any;
    expect(body.data.progress.stepsDone).toEqual([]);
    // userA's later writes must not appear here — verified in PUT test below.
  });

  it("propagates a 404 when the user has no workspace", async () => {
    mockedRequireWorkspace.mockRejectedValueOnce(
      Response.json({ error: "No workspace found for user" }, { status: 404 })
    );
    const res = await GET(req("http://x/api/onboarding/progress", "GET"));
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/onboarding/progress", () => {
  it("upserts validated progress", async () => {
    authed(userA, wsA);
    const res = await PUT(
      req("http://x/api/onboarding/progress", "PUT", {
        currentStep: 3,
        stepsDone: ["welcome", "workspace"],
        skipped: [],
        data: { locale: "ar", timezone: "Africa/Cairo", useCase: "lead_gen" },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.progress.currentStep).toBe(3);
    expect(body.data.progress.stepsDone).toEqual(["welcome", "workspace"]);
    expect(body.data.progress.data.useCase).toBe("lead_gen");
    expect(body.data.progress.completedAt).toBeNull();

    // GET sees the persisted state (resumable).
    const get = await GET(req("http://x/api/onboarding/progress", "GET"));
    const gbody = (await get.json()) as any;
    expect(gbody.data.progress.currentStep).toBe(3);
    expect(gbody.data.progress.data.locale).toBe("ar");
  });

  it("marks completedAt when completed=true", async () => {
    authed(userA, wsA);
    const res = await PUT(
      req("http://x/api/onboarding/progress", "PUT", {
        currentStep: 10,
        stepsDone: ["welcome"],
        skipped: ["connect"],
        data: {},
        completed: true,
      })
    );
    const body = (await res.json()) as any;
    expect(body.data.progress.completedAt).not.toBeNull();
  });

  it("rejects invalid bodies with 422 (Zod)", async () => {
    authed(userA, wsA);
    const res = await PUT(
      req("http://x/api/onboarding/progress", "PUT", {
        currentStep: -1,
        stepsDone: ["not a valid step id!!"],
      })
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
  });

  it("writes for userA are invisible to userB (tenant isolation)", async () => {
    authed(userB, wsB);
    const res = await GET(req("http://x/api/onboarding/progress", "GET"));
    const body = (await res.json()) as any;
    expect(body.data.progress.currentStep).not.toBe(10);
  });
});
