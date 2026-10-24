/**
 * Unit tests for the email crypto helpers (Workstream A).
 * - Codes/tokens are well-formed and random.
 * - Only hashes are stored (deterministic SHA-256 hex digests).
 * - Comparisons are timing-safe.
 */
import { describe, it, expect } from "vitest";
import {
  generateVerificationCode,
  hashVerificationCode,
  generateResetToken,
  hashResetToken,
  timingSafeEqualHex,
  VERIFICATION_CODE_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  VERIFICATION_MAX_ATTEMPTS,
} from "./crypto";

describe("verification codes", () => {
  it("generates 6-digit numeric codes", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateVerificationCode()).toMatch(/^\d{6}$/);
    }
  });

  it("generates distinct codes across calls", () => {
    const codes = new Set(Array.from({ length: 50 }, generateVerificationCode));
    expect(codes.size).toBeGreaterThan(40);
  });

  it("hashes deterministically to a 64-char hex digest", () => {
    const h1 = hashVerificationCode("123456");
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVerificationCode("123456")).toBe(h1);
    expect(hashVerificationCode("654321")).not.toBe(h1);
  });

  it("uses a 15-minute TTL and a 5-attempt lockout", () => {
    expect(VERIFICATION_CODE_TTL_MS).toBe(15 * 60 * 1000);
    expect(VERIFICATION_MAX_ATTEMPTS).toBe(5);
  });
});

describe("password reset tokens", () => {
  it("generates 32 random bytes as hex", () => {
    const t = generateResetToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(generateResetToken()).not.toBe(t);
  });

  it("hashes deterministically", () => {
    const t = generateResetToken();
    expect(hashResetToken(t)).toBe(hashResetToken(t));
    expect(hashResetToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses a 1-hour TTL", () => {
    expect(PASSWORD_RESET_TTL_MS).toBe(60 * 60 * 1000);
  });
});

describe("timingSafeEqualHex", () => {
  it("is true for equal digests, false otherwise", () => {
    const a = hashVerificationCode("123456");
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, hashVerificationCode("123457"))).toBe(false);
  });

  it("is false on length mismatch (never throws)", () => {
    expect(timingSafeEqualHex("abc", "abcdef")).toBe(false);
    expect(timingSafeEqualHex("", "abc")).toBe(false);
  });
});
