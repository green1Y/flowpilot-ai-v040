/**
 * Phase B — segment condition evaluator tests (pure, no DB).
 * AND/OR nesting, operator matrix, and edge cases.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateConditionRule,
  evaluateConditionGroup,
  parseConditions,
  describeConditions,
  availabilityWarningsFor,
  PROVIDER_AVAILABILITY,
  type ContactFactContext,
  type ConditionGroup,
} from "./segments";

const NOW = new Date("2026-10-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

function ctx(overrides: Partial<ContactFactContext> = {}): ContactFactContext {
  return {
    contactId: "c1",
    name: "Ada Lovelace",
    channel: "instagram",
    leadStatus: "NEW",
    tags: ["vip", "newsletter"],
    email: "ada@example.com",
    phone: null,
    lastInboundAt: daysAgo(2),
    lastOutboundAt: daysAgo(1),
    messageCount: 5,
    purchaseCount: 2,
    abandonedCart: false,
    optedOut: false,
    ...overrides,
  };
}

describe("evaluateConditionRule — leaf operators", () => {
  it("tag contains is case-insensitive exact match", () => {
    expect(evaluateConditionRule(ctx(), { field: "tag", operator: "contains", value: "VIP" }, NOW)).toBe(true);
    expect(evaluateConditionRule(ctx(), { field: "tag", operator: "contains", value: "nope" }, NOW)).toBe(false);
    expect(evaluateConditionRule(ctx(), { field: "tag", operator: "not_contains", value: "nope" }, NOW)).toBe(true);
  });
  it("tag with empty value never matches", () => {
    expect(evaluateConditionRule(ctx(), { field: "tag", operator: "contains", value: "" }, NOW)).toBe(false);
    expect(evaluateConditionRule(ctx(), { field: "tag", operator: "contains" }, NOW)).toBe(false);
  });
  it("channel eq/neq is case-insensitive", () => {
    expect(evaluateConditionRule(ctx(), { field: "channel", operator: "eq", value: "Instagram" }, NOW)).toBe(true);
    expect(evaluateConditionRule(ctx(), { field: "channel", operator: "neq", value: "whatsapp" }, NOW)).toBe(true);
  });
  it("leadStatus eq/neq is case-insensitive", () => {
    expect(evaluateConditionRule(ctx({ leadStatus: "QUALIFIED" }), { field: "leadStatus", operator: "eq", value: "qualified" }, NOW)).toBe(true);
    expect(evaluateConditionRule(ctx(), { field: "leadStatus", operator: "neq", value: "LOST" }, NOW)).toBe(true);
  });
  it("lastInboundAt older_than_days / newer_than_days", () => {
    expect(evaluateConditionRule(ctx(), { field: "lastInboundAt", operator: "older_than_days", value: 1 }, NOW)).toBe(true);
    expect(evaluateConditionRule(ctx(), { field: "lastInboundAt", operator: "older_than_days", value: 30 }, NOW)).toBe(false);
    expect(evaluateConditionRule(ctx(), { field: "lastInboundAt", operator: "newer_than_days", value: 7 }, NOW)).toBe(true);
    expect(evaluateConditionRule(ctx(), { field: "lastInboundAt", operator: "newer_than_days", value: 1 }, NOW)).toBe(false);
  });
  it("lastInboundAt null counts as infinitely old (re-engagement target)", () => {
    const c = ctx({ lastInboundAt: null });
    expect(evaluateConditionRule(c, { field: "lastInboundAt", operator: "older_than_days", value: 30 }, NOW)).toBe(true);
    expect(evaluateConditionRule(c, { field: "lastInboundAt", operator: "newer_than_days", value: 30 }, NOW)).toBe(false);
  });
  it("numeric comparisons on messageCount/purchaseCount", () => {
    const c = ctx({ messageCount: 5, purchaseCount: 0 });
    expect(evaluateConditionRule(c, { field: "messageCount", operator: "gte", value: 5 }, NOW)).toBe(true);
    expect(evaluateConditionRule(c, { field: "messageCount", operator: "gt", value: 5 }, NOW)).toBe(false);
    expect(evaluateConditionRule(c, { field: "purchaseCount", operator: "eq", value: 0 }, NOW)).toBe(true);
    expect(evaluateConditionRule(c, { field: "purchaseCount", operator: "lt", value: 1 }, NOW)).toBe(true);
    expect(evaluateConditionRule(c, { field: "messageCount", operator: "gte", value: "not-a-number" }, NOW)).toBe(false);
  });
  it("abandonedCart / optedOut booleans", () => {
    expect(evaluateConditionRule(ctx({ abandonedCart: true }), { field: "abandonedCart", operator: "is_true" }, NOW)).toBe(true);
    expect(evaluateConditionRule(ctx(), { field: "abandonedCart", operator: "is_false" }, NOW)).toBe(true);
    expect(evaluateConditionRule(ctx({ optedOut: true }), { field: "optedOut", operator: "is_true" }, NOW)).toBe(true);
    expect(evaluateConditionRule(ctx({ optedOut: true }), { field: "optedOut", operator: "eq", value: true }, NOW)).toBe(true);
  });
  it("email/phone exists / not_exists", () => {
    expect(evaluateConditionRule(ctx(), { field: "email", operator: "exists" }, NOW)).toBe(true);
    expect(evaluateConditionRule(ctx(), { field: "phone", operator: "not_exists" }, NOW)).toBe(true);
    expect(evaluateConditionRule(ctx({ email: null }), { field: "email", operator: "exists" }, NOW)).toBe(false);
  });
  it("unknown field or operator never matches (fail closed)", () => {
    expect(evaluateConditionRule(ctx(), { field: "shoeSize", operator: "eq", value: 42 }, NOW)).toBe(false);
    expect(evaluateConditionRule(ctx(), { field: "tag", operator: "fuzzy_matches", value: "vip" }, NOW)).toBe(false);
  });
});

describe("evaluateConditionGroup — AND/OR nesting", () => {
  const vipAndActive: ConditionGroup = {
    op: "and",
    rules: [
      { field: "tag", operator: "contains", value: "vip" },
      {
        op: "or",
        rules: [
          { field: "lastInboundAt", operator: "newer_than_days", value: 7 },
          { field: "messageCount", operator: "gte", value: 10 },
        ],
      },
    ],
  };

  it("nested OR inside AND: matches via either branch", () => {
    expect(evaluateConditionGroup(ctx(), vipAndActive, NOW)).toBe(true); // recent inbound
    expect(evaluateConditionGroup(ctx({ lastInboundAt: daysAgo(60), messageCount: 12 }), vipAndActive, NOW)).toBe(true); // high count
  });
  it("fails when the outer AND branch fails", () => {
    expect(evaluateConditionGroup(ctx({ tags: ["newsletter"] }), vipAndActive, NOW)).toBe(false);
  });
  it("fails when no OR branch matches", () => {
    expect(evaluateConditionGroup(ctx({ lastInboundAt: daysAgo(60), messageCount: 1 }), vipAndActive, NOW)).toBe(false);
  });
  it("deeply nested groups (3 levels)", () => {
    const deep: ConditionGroup = {
      op: "or",
      rules: [
        { field: "tag", operator: "contains", value: "nope" },
        { op: "and", rules: [{ op: "or", rules: [{ field: "leadStatus", operator: "eq", value: "NEW" }] }] },
      ],
    };
    expect(evaluateConditionGroup(ctx(), deep, NOW)).toBe(true);
    expect(evaluateConditionGroup(ctx({ leadStatus: "LOST" }), deep, NOW)).toBe(false);
  });
  it("empty AND group matches everyone; empty OR group matches nobody", () => {
    expect(evaluateConditionGroup(ctx(), { op: "and", rules: [] }, NOW)).toBe(true);
    expect(evaluateConditionGroup(ctx(), { op: "or", rules: [] }, NOW)).toBe(false);
  });
});

describe("parseConditions / describeConditions", () => {
  it("falls back to match-all on garbage", () => {
    const g = parseConditions("not json{{{");
    expect(g).toEqual({ op: "and", rules: [] });
    expect(evaluateConditionGroup(ctx(), g, NOW)).toBe(true);
  });
  it("defaults unknown op to and", () => {
    const g = parseConditions(JSON.stringify({ op: "xor", rules: [] }));
    expect(g.op).toBe("and");
  });
  it("describes an empty tree as 'All contacts'", () => {
    expect(describeConditions({ op: "and", rules: [] })).toBe("All contacts");
  });
  it("describes a mixed tree readably", () => {
    const d = describeConditions({
      op: "and",
      rules: [
        { field: "tag", operator: "contains", value: "vip" },
        { field: "purchaseCount", operator: "gte", value: 1 },
      ],
    });
    expect(d).toContain("tag contains");
    expect(d).toContain("purchaseCount gte");
  });
});

describe("availability honesty", () => {
  it("PROVIDER_AVAILABILITY is honest about store-only fields", () => {
    expect(PROVIDER_AVAILABILITY.abandonedCart).toMatch(/do not expose cart data/i);
    expect(PROVIDER_AVAILABILITY.purchaseCount).toMatch(/do not expose purchase history/i);
    expect(PROVIDER_AVAILABILITY.lastInboundAt).toMatch(/Instagram \+ Facebook/);
  });
  it("warns on store-dependent fields, stays silent on first-party ones", () => {
    const warns = availabilityWarningsFor({
      op: "and",
      rules: [
        { field: "abandonedCart", operator: "is_true" },
        { field: "tag", operator: "contains", value: "vip" },
      ],
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("abandonedCart");
  });
});
