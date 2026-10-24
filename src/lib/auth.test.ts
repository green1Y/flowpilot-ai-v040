import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, signToken, verifyToken } from "./auth";

// Pure crypto/JWT tests — no database involved.

describe("password hashing", () => {
  it("hashes and verifies a password roundtrip", async () => {
    const hash = await hashPassword("CorrectHorse123!");
    expect(hash).not.toBe("CorrectHorse123!");
    expect(await verifyPassword("CorrectHorse123!", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("CorrectHorse123!");
    expect(await verifyPassword("WrongPassword999!", hash)).toBe(false);
  });
});

describe("session tokens", () => {
  it("signs and verifies a token roundtrip", () => {
    const token = signToken({ userId: "u_123", email: "a@example.com" });
    expect(typeof token).toBe("string");
    const payload = verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.userId).toBe("u_123");
    expect(payload?.email).toBe("a@example.com");
  });

  it("returns null for a tampered token", () => {
    const token = signToken({ userId: "u_123", email: "a@example.com" });
    // Flip the last two signature characters so the signature no longer matches.
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect(verifyToken(tampered)).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(verifyToken("not-a-token")).toBeNull();
    expect(verifyToken("")).toBeNull();
  });
});
