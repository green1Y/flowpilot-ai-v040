/**
 * Login rate-limiter tests (pure unit tests — no DB, no HTTP).
 *
 * Covers: budget enforcement, per-key independence, success clearing the
 * record, and the published configuration.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  isLoginBlocked,
  recordFailedLogin,
  clearFailedLogins,
  resetLoginAttempts,
  LOGIN_RATE_LIMIT,
} from "./rate-limit";

beforeEach(() => {
  resetLoginAttempts();
});

describe("login rate limiting", () => {
  it("allows attempts under the budget", () => {
    const key = "1.2.3.4:user@example.com";
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxFailedAttempts - 1; i++) {
      expect(isLoginBlocked(key)).toBe(false);
      recordFailedLogin(key);
    }
    expect(isLoginBlocked(key)).toBe(false);
  });

  it("blocks after the failed-attempt budget is exhausted", () => {
    const key = "1.2.3.4:victim@example.com";
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxFailedAttempts; i++) {
      recordFailedLogin(key);
    }
    expect(isLoginBlocked(key)).toBe(true);
    // Further failures keep it blocked.
    recordFailedLogin(key);
    expect(isLoginBlocked(key)).toBe(true);
  });

  it("tracks keys independently (IP + email)", () => {
    const blocked = "9.9.9.9:target@example.com";
    const otherIp = "8.8.8.8:target@example.com";
    const otherEmail = "9.9.9.9:other@example.com";
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxFailedAttempts; i++) {
      recordFailedLogin(blocked);
    }
    expect(isLoginBlocked(blocked)).toBe(true);
    expect(isLoginBlocked(otherIp)).toBe(false);
    expect(isLoginBlocked(otherEmail)).toBe(false);
  });

  it("clears the record on successful login", () => {
    const key = "1.2.3.4:user@example.com";
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxFailedAttempts; i++) {
      recordFailedLogin(key);
    }
    expect(isLoginBlocked(key)).toBe(true);
    clearFailedLogins(key);
    expect(isLoginBlocked(key)).toBe(false);
  });

  it("returns the running count from recordFailedLogin", () => {
    const key = "1.2.3.4:count@example.com";
    expect(recordFailedLogin(key)).toBe(1);
    expect(recordFailedLogin(key)).toBe(2);
  });

  it("publishes its configuration", () => {
    expect(LOGIN_RATE_LIMIT.maxFailedAttempts).toBe(10);
    expect(LOGIN_RATE_LIMIT.windowMs).toBe(10 * 60 * 1000);
  });
});
