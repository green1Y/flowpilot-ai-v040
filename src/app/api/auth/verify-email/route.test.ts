/**
 * POST /api/auth/verify-email tests (Workstream A).
 * - Success sets emailVerified + emailVerifiedAt and deletes the row.
 * - Wrong code: 401 + attempts increment; locked (429) after 5 failures.
 * - Expired code: 410 + row deleted.
 * - Malformed code: 422. No pending row: 404.
 * Auth is stubbed at the boundary (same pattern as authz-content.test.ts).
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { hashVerificationCode } from "@/lib/email/crypto";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn() };
});
const mockedRequireUser = vi.mocked(requireUser);

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const KNOWN_CODE = "482910";

async function makeUser(tag: string) {
  const user = await db.user.create({
    data: {
      email: `verify-${tag}-${suffix}@example.com`,
      name: `Verify ${tag}`,
      passwordHash: "x",
    },
  });
  return user;
}

async function makeRow(userId: string, expiresAt: Date) {
  return db.emailVerification.create({
    data: {
      userId,
      codeHash: hashVerificationCode(KNOWN_CODE),
      expiresAt,
    },
  });
}

function authed(userId: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email: "x@example.com",
    user: { id: userId, name: "T", email: "x@example.com" },
  });
}

function req(code: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/verify-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

const createdUserIds: string[] = [];
afterAll(async () => {
  await db.emailVerification.deleteMany({
    where: { userId: { in: createdUserIds } },
  });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe("POST /api/auth/verify-email", () => {
  it("verifies with the correct code, flags the user, and deletes the row", async () => {
    const user = await makeUser("ok");
    createdUserIds.push(user.id);
    await makeRow(user.id, new Date(Date.now() + 10 * 60 * 1000));
    authed(user.id);

    const res = await POST(req(KNOWN_CODE));
    expect(res.status).toBe(200);
    expect((await res.json()) as { data: { verified: boolean } }).toMatchObject({
      data: { verified: true },
    });

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.emailVerified).toBe(true);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(
      await db.emailVerification.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("rejects a wrong code with 401 and increments attempts", async () => {
    const user = await makeUser("wrong");
    createdUserIds.push(user.id);
    const row = await makeRow(user.id, new Date(Date.now() + 10 * 60 * 1000));
    authed(user.id);

    const res = await POST(req("000000"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "INVALID_CODE" });
    const after = await db.emailVerification.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.attempts).toBe(1);
    const u = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.emailVerified).toBe(false);
  });

  it("locks after 5 failed attempts (6th attempt answers 429)", async () => {
    const user = await makeUser("locked");
    createdUserIds.push(user.id);
    await makeRow(user.id, new Date(Date.now() + 10 * 60 * 1000));
    authed(user.id);

    for (let i = 0; i < 5; i++) {
      const res = await POST(req("111111"));
      expect(res.status).toBe(401);
    }
    const locked = await POST(req(KNOWN_CODE));
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ code: "VERIFICATION_LOCKED" });
    // Even the right code is rejected while locked.
    const u = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.emailVerified).toBe(false);
  });

  it("rejects an expired code with 410 and deletes the row", async () => {
    const user = await makeUser("expired");
    createdUserIds.push(user.id);
    await makeRow(user.id, new Date(Date.now() - 1000));
    authed(user.id);

    const res = await POST(req(KNOWN_CODE));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: "VERIFICATION_EXPIRED" });
    expect(
      await db.emailVerification.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("rejects a malformed code with 422", async () => {
    const user = await makeUser("malformed");
    createdUserIds.push(user.id);
    await makeRow(user.id, new Date(Date.now() + 10 * 60 * 1000));
    authed(user.id);

    expect((await POST(req("abc"))).status).toBe(422);
    expect((await POST(req("12345"))).status).toBe(422);
    expect((await POST(req(123456))).status).toBe(422);
  });

  it("answers 404 when there is no pending verification", async () => {
    const user = await makeUser("norow");
    createdUserIds.push(user.id);
    authed(user.id);

    const res = await POST(req(KNOWN_CODE));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NO_PENDING_VERIFICATION" });
  });

  it("requires authentication", async () => {
    mockedRequireUser.mockRejectedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    const res = await POST(req(KNOWN_CODE));
    expect(res.status).toBe(401);
  });
});
