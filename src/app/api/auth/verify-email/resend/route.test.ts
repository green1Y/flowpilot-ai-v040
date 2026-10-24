/**
 * POST /api/auth/verify-email/resend tests (Workstream A).
 * - First resend: 200, code row created, email sent via the sender.
 * - Immediate second resend: 429 RESEND_COOLDOWN with retryAfterSec.
 * - Hourly budget: 10 sends allowed, 11th answers 429 RESEND_RATE_LIMITED.
 * - Already-verified users: 200 alreadyVerified (no email sent).
 * - Unconfigured email: honest 503 EMAIL_NOT_CONFIGURED.
 * Auth + sender are stubbed; the demo-mode guard and DB are real.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getEmailSender } from "@/lib/email/sender";
import {
  resetResendCooldowns,
  resetVerifyResends,
} from "@/lib/rate-limit";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn() };
});
vi.mock("@/lib/email/sender", () => ({ getEmailSender: vi.fn() }));

const mockedRequireUser = vi.mocked(requireUser);
const mockedGetEmailSender = vi.mocked(getEmailSender);

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const sendFn = vi.fn(async () => ({ ok: true, messageId: "msg_1" }));

async function makeFixture(tag: string, emailVerified = false) {
  const user = await db.user.create({
    data: {
      email: `resend-${tag}-${suffix}@example.com`,
      name: `Resend ${tag}`,
      passwordHash: "x",
      emailVerified,
    },
  });
  const org = await db.organization.create({ data: { name: `Resend Org ${tag} ${suffix}` } });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `Resend WS ${tag} ${suffix}`, slug: `resend-ws-${tag}-${suffix}` },
  });
  await db.membership.create({
    data: { userId: user.id, workspaceId: ws.id, role: "OWNER" },
  });
  return { user, org, ws };
}

function authed(userId: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email: "x@example.com",
    user: { id: userId, name: "T", email: "x@example.com" },
  });
}

function req(): NextRequest {
  return new NextRequest("http://localhost/api/auth/verify-email/resend", {
    method: "POST",
  });
}

const fixtures: { userId: string; orgId: string; wsId: string }[] = [];

async function cleanup() {
  for (const f of fixtures) {
    await db.emailVerification.deleteMany({ where: { userId: f.userId } });
    await db.membership.deleteMany({ where: { userId: f.userId } });
    await db.workspace.deleteMany({ where: { id: f.wsId } });
    await db.organization.deleteMany({ where: { id: f.orgId } });
    await db.user.deleteMany({ where: { id: f.userId } });
  }
  fixtures.length = 0;
}
afterAll(cleanup);

beforeEach(() => {
  resetResendCooldowns();
  resetVerifyResends();
  sendFn.mockClear();
  mockedGetEmailSender.mockReturnValue({ send: sendFn });
});

describe("POST /api/auth/verify-email/resend", () => {
  it("sends a fresh code on first resend and stores only its hash", async () => {
    const { user, org, ws } = await makeFixture("first");
    fixtures.push({ userId: user.id, orgId: org.id, wsId: ws.id });
    authed(user.id);

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { sent: true } });
    expect(sendFn).toHaveBeenCalledTimes(1);
    const [to, subject, html] = sendFn.mock.calls[0] as unknown as [string, string, string];
    expect(to).toBe(user.email);
    expect(subject).toContain("verification");
    expect(html).toMatch(/\d{6}/);

    const rows = await db.emailVerification.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].attempts).toBe(0);
  });

  it("answers 429 with retryAfterSec while cooling down (60s)", async () => {
    const { user, org, ws } = await makeFixture("cooldown");
    fixtures.push({ userId: user.id, orgId: org.id, wsId: ws.id });
    authed(user.id);

    expect((await POST(req())).status).toBe(200);
    const second = await POST(req());
    expect(second.status).toBe(429);
    const body = (await second.json()) as { code: string; retryAfterSec: number };
    expect(body.code).toBe("RESEND_COOLDOWN");
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(body.retryAfterSec).toBeLessThanOrEqual(60);
    // Cooldown blocked the send — only the first email went out.
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it("enforces the hourly budget: 10 sends allowed, 11th is 429", async () => {
    const { user, org, ws } = await makeFixture("budget");
    fixtures.push({ userId: user.id, orgId: org.id, wsId: ws.id });
    authed(user.id);

    for (let i = 0; i < 10; i++) {
      resetResendCooldowns(); // bypass the cooldown to exercise the budget
      const res = await POST(req());
      expect(res.status).toBe(200);
    }
    resetResendCooldowns();
    const blocked = await POST(req());
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: "RESEND_RATE_LIMITED" });
  });

  it("answers 200 alreadyVerified for verified users without sending", async () => {
    const { user, org, ws } = await makeFixture("verified", true);
    fixtures.push({ userId: user.id, orgId: org.id, wsId: ws.id });
    authed(user.id);

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { alreadyVerified: true } });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("answers an honest 503 EMAIL_NOT_CONFIGURED when no sender is configured", async () => {
    mockedGetEmailSender.mockReturnValue(null);
    const { user, org, ws } = await makeFixture("unconfigured");
    fixtures.push({ userId: user.id, orgId: org.id, wsId: ws.id });
    authed(user.id);

    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });
  });

  it("requires authentication", async () => {
    mockedRequireUser.mockRejectedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    expect((await POST(req())).status).toBe(401);
  });
});
