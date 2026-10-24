/**
 * Signup email-verification behavior (Workstream A).
 * - Signup still returns 201 with user + workspace (existing contract intact).
 * - A verification row (hash only) is created for the new user.
 * - When email is unconfigured, the response honestly reports verification
 *   pending with reason EMAIL_NOT_CONFIGURED — nothing is marked verified.
 * Auth is stubbed at the boundary (same pattern as authz-content.test.ts);
 * the real route, validation, rate limit, and DB are exercised.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
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
const testIp = `10.50.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;

const createdEmails: string[] = [];

function signupReq(email: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": testIp },
    body: JSON.stringify({
      name: "Verify Signup",
      email,
      password: "TestPass123!",
    }),
  });
}

afterAll(async () => {
  const users = await db.user.findMany({
    where: { email: { in: createdEmails } },
  });
  const userIds = users.map((u) => u.id);
  await db.emailVerification.deleteMany({ where: { userId: { in: userIds } } });
  const memberships = await db.membership.findMany({
    where: { userId: { in: userIds } },
  });
  const wsIds = [...new Set(memberships.map((m) => m.workspaceId))];
  const workspaces = await db.workspace.findMany({
    where: { id: { in: wsIds } },
  });
  const orgIds = [...new Set(workspaces.map((w) => w.orgId))];
  await db.membership.deleteMany({ where: { userId: { in: userIds } } });
  await db.workspace.deleteMany({ where: { id: { in: wsIds } } });
  await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("signup email verification", () => {
  it("creates the account (201) with an honest pending-verification state when email is unconfigured", async () => {
    // vitest.setup.ts leaves RESEND_API_KEY/EMAIL_FROM unset -> unconfigured.
    expect(process.env.RESEND_API_KEY).toBeUndefined();

    const email = `signup-verify-${suffix}@example.com`;
    const res = await signup(signupReq(email));
    expect(res.status).toBe(201);
    createdEmails.push(email);

    const body = (await res.json()) as {
      data: {
        user: { id: string; email: string };
        workspace: { id: string };
        verification: { status: string; reason?: string };
      };
    };
    expect(body.data.user.email).toBe(email);
    expect(body.data.workspace.id).toBeTruthy();
    // Honest state: account created, verification pending, nothing verified.
    expect(body.data.verification).toEqual({
      status: "pending",
      reason: "EMAIL_NOT_CONFIGURED",
    });

    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerified).toBe(false);
    expect(user.emailVerifiedAt).toBeNull();

    const rows = await db.emailVerification.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].attempts).toBe(0);
    const ttlMs = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
    expect(ttlMs).toBeGreaterThan(14 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);
  });
});
