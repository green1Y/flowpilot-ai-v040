/**
 * POST /api/auth/password-reset/request tests (Workstream A).
 * - No-oracle: identical 200 response for existing and unknown emails.
 * - Existing user + configured email: token row created (hash only),
 *   reset link emailed, single live token per user.
 * - Unconfigured email: honest behavior — same generic reply, NO token row.
 * - Rate limiting: budget exhausted -> 429.
 * Sender is stubbed; guard + DB are real.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getEmailSender } from "@/lib/email/sender";
import { hashResetToken } from "@/lib/email/crypto";
import { resetPasswordResetAttempts } from "@/lib/rate-limit";
import { POST } from "./route";

vi.mock("@/lib/email/sender", () => ({ getEmailSender: vi.fn() }));
const mockedGetEmailSender = vi.mocked(getEmailSender);

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const sendFn = vi.fn(async () => ({ ok: true, messageId: "msg_reset" }));

const GENERIC_MESSAGE =
  "If an account exists for this email, a reset link has been sent.";

async function makeUser(tag: string) {
  const user = await db.user.create({
    data: {
      email: `reset-${tag}-${suffix}@example.com`,
      name: `Reset ${tag}`,
      passwordHash: "x",
    },
  });
  const org = await db.organization.create({
    data: { name: `Reset Org ${tag} ${suffix}` },
  });
  const ws = await db.workspace.create({
    data: {
      orgId: org.id,
      name: `Reset WS ${tag} ${suffix}`,
      slug: `reset-ws-${tag}-${suffix}`,
    },
  });
  await db.membership.create({
    data: { userId: user.id, workspaceId: ws.id, role: "OWNER" },
  });
  return { user, org, ws };
}

function req(email: string, ip: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/password-reset/request", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email }),
  });
}

const fixtures: { userId: string; orgId: string; wsId: string }[] = [];
afterAll(async () => {
  for (const f of fixtures) {
    await db.passwordResetToken.deleteMany({ where: { userId: f.userId } });
    await db.membership.deleteMany({ where: { userId: f.userId } });
    await db.workspace.deleteMany({ where: { id: f.wsId } });
    await db.organization.deleteMany({ where: { id: f.orgId } });
    await db.user.deleteMany({ where: { id: f.userId } });
  }
});

beforeEach(() => {
  resetPasswordResetAttempts();
  sendFn.mockClear();
  mockedGetEmailSender.mockReturnValue({ send: sendFn });
});

describe("POST /api/auth/password-reset/request", () => {
  it("is a no-oracle: identical response for existing and unknown emails", async () => {
    const { user, org, ws } = await makeUser("oracle");
    fixtures.push({ userId: user.id, orgId: org.id, wsId: ws.id });
    const ip = `10.40.1.${Math.floor(Math.random() * 200) + 1}`;

    const existingRes = await POST(req(user.email, ip));
    const unknownRes = await POST(req(`nobody-${suffix}@example.com`, ip));

    expect(existingRes.status).toBe(200);
    expect(unknownRes.status).toBe(200);
    const existingBody = await existingRes.json();
    const unknownBody = await unknownRes.json();
    expect(existingBody).toEqual({ ok: true, message: GENERIC_MESSAGE });
    expect(unknownBody).toEqual(existingBody);
  });

  it("creates a single-use hashed token and emails the reset link", async () => {
    const { user, org, ws } = await makeUser("send");
    fixtures.push({ userId: user.id, orgId: org.id, wsId: ws.id });
    const ip = `10.40.2.${Math.floor(Math.random() * 200) + 1}`;

    const res = await POST(req(user.email, ip));
    expect(res.status).toBe(200);

    const rows = await db.passwordResetToken.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].usedAt).toBeNull();

    expect(sendFn).toHaveBeenCalledTimes(1);
    const [to, subject, html] = sendFn.mock.calls[0] as unknown as [string, string, string];
    expect(to).toBe(user.email);
    expect(subject).toContain("Reset");
    const tokenMatch = html.match(/reset-password\?token=([0-9a-f]{64})/);
    expect(tokenMatch).not.toBeNull();
    // The emailed token verifies against the stored hash.
    expect(hashResetToken(tokenMatch![1])).toBe(rows[0].tokenHash);

    // A second request rotates: still exactly one live token.
    resetPasswordResetAttempts();
    await POST(req(user.email, ip));
    const rows2 = await db.passwordResetToken.findMany({
      where: { userId: user.id },
    });
    expect(rows2).toHaveLength(1);
    expect(rows2[0].id).not.toBe(rows[0].id);
  });

  it("does NOT create a token when email is unconfigured (honest state, same reply)", async () => {
    mockedGetEmailSender.mockReturnValue(null);
    const { user, org, ws } = await makeUser("unconfigured");
    fixtures.push({ userId: user.id, orgId: org.id, wsId: ws.id });
    const ip = `10.40.3.${Math.floor(Math.random() * 200) + 1}`;

    const res = await POST(req(user.email, ip));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: GENERIC_MESSAGE });
    expect(
      await db.passwordResetToken.count({ where: { userId: user.id } })
    ).toBe(0);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("rate-limits by IP: budget exhausted -> 429", async () => {
    const ip = `10.40.4.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 10; i++) {
      const res = await POST(req(`nobody-${i}-${suffix}@example.com`, ip));
      expect(res.status).toBe(200);
    }
    const blocked = await POST(req(`nobody-10-${suffix}@example.com`, ip));
    expect(blocked.status).toBe(429);
  });

  it("rejects malformed bodies with 422", async () => {
    const ip = `10.40.5.${Math.floor(Math.random() * 200) + 1}`;
    const bad = new NextRequest(
      "http://localhost/api/auth/password-reset/request",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ email: "not-an-email" }),
      }
    );
    expect((await POST(bad)).status).toBe(422);
  });
});
