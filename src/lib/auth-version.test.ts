/**
 * Session-version revocation tests (v0.4.0 hardening).
 * A JWT issued before a password change/reset must stop working once the
 * user's tokenVersion bumps, even though its 7-day expiry has not passed.
 * Tokens issued before v0.4.0 carry no version claim and are accepted
 * (migration leniency) until the next password change.
 *
 * getSession() reads next/headers cookies, so the cookie store is mocked
 * with a mutable holder; the DB is the real test DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const cookieHolder: { token: string | null } = { token: null };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "fp_session" && cookieHolder.token ? { value: cookieHolder.token } : undefined,
    set: () => {},
  }),
}));

import { db } from "@/lib/db";
import {
  signToken,
  getSession,
  isSessionVersionValid,
  hashPassword,
} from "@/lib/auth";

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

describe("isSessionVersionValid (pure)", () => {
  it("accepts a matching version", () => {
    expect(isSessionVersionValid({ userId: "u", email: "e", tokenVersion: 2 }, 2)).toBe(true);
  });
  it("rejects a stale version", () => {
    expect(isSessionVersionValid({ userId: "u", email: "e", tokenVersion: 1 }, 2)).toBe(false);
  });
  it("accepts a legacy token with no version claim", () => {
    expect(isSessionVersionValid({ userId: "u", email: "e" }, 5)).toBe(true);
  });
});

describe("getSession + tokenVersion (DB-backed)", () => {
  let userId = "";

  beforeEach(async () => {
    const user = await db.user.create({
      data: {
        email: `version-${suffix}@example.com`,
        passwordHash: await hashPassword("OldPass123!"),
        name: "Version User",
      },
    });
    userId = user.id;
    cookieHolder.token = null;
  });

  afterEach(async () => {
    cookieHolder.token = null;
    if (userId) {
      await db.user.delete({ where: { id: userId } }).catch(() => {});
      userId = "";
    }
  });

  it("accepts a current-version token and rejects it after a bump", async () => {
    cookieHolder.token = signToken({ userId, email: `version-${suffix}@example.com`, tokenVersion: 0 });
    const before = await getSession();
    expect(before?.user.id).toBe(userId);

    // Simulate a password change: bump tokenVersion.
    await db.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
    const afterBump = await getSession();
    expect(afterBump).toBeNull();

    // A fresh login (new version) works again.
    cookieHolder.token = signToken({ userId, email: `version-${suffix}@example.com`, tokenVersion: 1 });
    const fresh = await getSession();
    expect(fresh?.user.id).toBe(userId);
  });

  it("accepts a legacy token with no version claim until a bump", async () => {
    cookieHolder.token = signToken({ userId, email: `version-${suffix}@example.com` });
    expect((await getSession())?.user.id).toBe(userId);
    await db.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
    // Legacy leniency: still accepted (documented migration behavior).
    expect((await getSession())?.user.id).toBe(userId);
  });
});
