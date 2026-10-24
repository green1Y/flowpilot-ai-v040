import { describe, it, expect, beforeEach } from "vitest";
import {
  isCopilotBlocked,
  recordCopilotRequest,
  resetCopilotRateLimit,
  COPILOT_RATE_LIMIT,
} from "./rateLimit";

describe("copilot rate limit", () => {
  beforeEach(() => resetCopilotRateLimit());

  it("allows requests under the budget", () => {
    expect(isCopilotBlocked("ws-1")).toBe(false);
    recordCopilotRequest("ws-1");
    expect(isCopilotBlocked("ws-1")).toBe(false);
  });

  it("blocks after the budget is exhausted", () => {
    for (let i = 0; i < COPILOT_RATE_LIMIT.maxRequests; i++) {
      recordCopilotRequest("ws-2");
    }
    expect(isCopilotBlocked("ws-2")).toBe(true);
  });

  it("is scoped per workspace", () => {
    for (let i = 0; i < COPILOT_RATE_LIMIT.maxRequests; i++) {
      recordCopilotRequest("ws-a");
    }
    expect(isCopilotBlocked("ws-a")).toBe(true);
    expect(isCopilotBlocked("ws-b")).toBe(false);
  });

  it("resets cleanly", () => {
    for (let i = 0; i < COPILOT_RATE_LIMIT.maxRequests; i++) {
      recordCopilotRequest("ws-3");
    }
    resetCopilotRateLimit();
    expect(isCopilotBlocked("ws-3")).toBe(false);
  });
});
