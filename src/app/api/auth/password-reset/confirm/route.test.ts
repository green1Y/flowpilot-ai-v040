/**
 * POST /api/auth/password-reset/confirm tests (Workstream A).
 * - Success: password actually changes (bcrypt-verified), usedAt set.
 * - Single-use: redeeming twice fails the second time.
 * - Invalid / expired tokens: identical 400, no password change.
 * - Weak new password: 422.
 * - Rate limiting: budget exhausted -> 429.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { generateResetToken, hashResetToken } from "@/lib/email/crypto";
import { resetPasswordResetAttempts } from "@/lib/rate-limit";
import { POST } from "./route";

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const OLD_PASSWORD = "OldPass123!";
const NEW_PASSWORD = "BrandNewPass456!";

async function makeUser(tag: string) {
  return db.user.create({
    data: {
      email: `confirm-${tag}-${suffix}@example.com`,
      name: `Confirm ${tag}`,
      passwordHash: await hashPassword(OLD_PASSWORD),
    },
  });
}

async function makeToken(userId: string, expiresAt: Date) {
  const raw = generateResetToken();
  const row = await db.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashResetToken(raw),
      expiresAt,
    },
  });
  return { raw, row };
}

function req(token: string, newPassword: string, ip: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/password-reset/confirm", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ token, newPassword }),
  });
}

const userIds: string[] = [];
afterAll(async () => {
  await db.passwordResetToken.deleteMany({
    where: { userId: { in: userIds } },
  });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

beforeEach(() => {
  resetPasswordResetAttempts();
});

let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.41.${Math.floor(Math.random() * 200) + 1}.${ipCounter}`;
}

describe("POST /api/auth/password-reset/confirm", () => {
  it("redeems a valid token: password changes and usedAt is set", async () => {
    const user = await makeUser("ok");
    userIds.push(user.id);
    const { raw, row } = await makeToken(
      user.id,
      new Date(Date.now() + 30 * 60 * 1000)
    );

    const res = await POST(req(raw, NEW_PASSWORD, uniqueIp()));
    expect(res.status).toBe(200);

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(NEW_PASSWORD, after.passwordHash)).toBe(true);
    expect(await verifyPassword(OLD_PASSWORD, after.passwordHash)).toBe(false);
    const tokenAfter = await db.passwordResetToken.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(tokenAfter.usedAt).not.toBeNull();
  });

  it("is single-use: the second redeem fails with the same 400", async () => {
    const user = await makeUser("reuse");
    userIds.push(user.id);
    const { raw } = await makeToken(
      user.id,
      new Date(Date.now() + 30 * 60 * 1000)
    );
    const ip = uniqueIp();

    expect((await POST(req(raw, NEW_PASSWORD, ip))).status).toBe(200);
    const second = await POST(req(raw, "AnotherPass789!", ip));
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ code: "INVALID_RESET_TOKEN" });

    // The second attempt did not change the password again.
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(NEW_PASSWORD, after.passwordHash)).toBe(true);
    expect(await verifyPassword("AnotherPass789!", after.passwordHash)).toBe(
      false
    );
  });

  it("rejects an unknown token with 400 and changes nothing", async () => {
    const user = await makeUser("unknown");
    userIds.push(user.id);

    const res = await POST(
      req("f".repeat(64), NEW_PASSWORD, uniqueIp())
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_RESET_TOKEN" });

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(OLD_PASSWORD, after.passwordHash)).toBe(true);
  });

  it("rejects an expired token with 400, deletes it, and changes nothing", async () => {
    const user = await makeUser("expired");
    userIds.push(user.id);
    const { raw, row } = await makeToken(user.id, new Date(Date.now() - 1000));

    const res = await POST(req(raw, NEW_PASSWORD, uniqueIp()));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_RESET_TOKEN" });
    expect(
      await db.passwordResetToken.findUnique({ where: { id: row.id } })
    ).toBeNull();

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(OLD_PASSWORD, after.passwordHash)).toBe(true);
  });

  it("rejects a weak new password with 422", async () => {
    const user = await makeUser("weak");
    userIds.push(user.id);
    const { raw } = await makeToken(
      user.id,
      new Date(Date.now() + 30 * 60 * 1000)
    );

    const res = await POST(req(raw, "short", uniqueIp()));
    expect(res.status).toBe(422);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(OLD_PASSWORD, after.passwordHash)).toBe(true);
  });

  it("rate-limits by IP: budget exhausted -> 429", async () => {
    const ip = `10.41.99.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 10; i++) {
      await POST(req("e".repeat(64), NEW_PASSWORD, ip));
    }
    const blocked = await POST(req("e".repeat(64), NEW_PASSWORD, ip));
    expect(blocked.status).toBe(429);
  });
});
