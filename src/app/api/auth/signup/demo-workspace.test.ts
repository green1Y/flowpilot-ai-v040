/**
 * Demo-mode workspace flag on signup (Batch B public-beta readiness).
 *
 * - DEMO_MODE=true  → the signup-created workspace gets isDemo=true, so all
 *   real external sends are blocked server-side from birth.
 * - DEMO_MODE unset/false → isDemo=false (normal workspace).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { POST as signup } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    // setSessionCookie needs next/headers request scope; irrelevant here.
    setSessionCookie: vi.fn(async () => {}),
  };
});

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const testIp = `10.60.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
const createdEmails: string[] = [];

function signupReq(email: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": testIp },
    body: JSON.stringify({
      name: "Demo Signup",
      email,
      password: "correct-horse-battery-staple-1",
    }),
  });
}

async function signupAndGetWorkspace(email: string): Promise<string> {
  const res = await signup(signupReq(email));
  expect(res.status).toBe(201);
  createdEmails.push(email);
  const body = (await res.json()) as { data: { workspace: { id: string } } };
  return body.data.workspace.id;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  // Clean up anything created so far (idempotent across runs).
  if (createdEmails.length === 0) return;
  const users = await db.user.findMany({ where: { email: { in: createdEmails } } });
  const userIds = users.map((u) => u.id);
  const memberships = await db.membership.findMany({ where: { userId: { in: userIds } } });
  const wsIds = [...new Set(memberships.map((m) => m.workspaceId))];
  const workspaces = await db.workspace.findMany({ where: { id: { in: wsIds } } });
  const orgIds = [...new Set(workspaces.map((w) => w.orgId))];
  await db.membership.deleteMany({ where: { userId: { in: userIds } } });
  await db.workspace.deleteMany({ where: { id: { in: wsIds } } });
  await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  createdEmails.length = 0;
});

describe("signup demo workspace flag", () => {
  it("sets isDemo=true when DEMO_MODE=true", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const email = `demo-signup-${suffix}@example.com`;
    const workspaceId = await signupAndGetWorkspace(email);
    const ws = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { isDemo: true },
    });
    expect(ws?.isDemo).toBe(true);
  });

  it("sets isDemo=false when DEMO_MODE is off", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    const email = `live-signup-${suffix}@example.com`;
    const workspaceId = await signupAndGetWorkspace(email);
    const ws = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { isDemo: true },
    });
    expect(ws?.isDemo).toBe(false);
  });
});
