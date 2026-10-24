/**
 * Pure matcher tests — no DB, no network.
 */
import { describe, it, expect } from "vitest";
import { matchesKeyword, matchKeywords } from "./match";

describe("matchesKeyword — contains (default)", () => {
  it("matches a case-insensitive partial by default", () => {
    expect(matchesKeyword("I want the LINK please", "link", "contains")).toBe(true);
    expect(matchesKeyword("LINK", "link", "contains")).toBe(true);
    expect(matchesKeyword("unrelated text", "link", "contains")).toBe(false);
  });
  it("respects caseSensitive=true", () => {
    expect(matchesKeyword("I want the LINK", "link", "contains", true)).toBe(false);
    expect(matchesKeyword("I want the link", "link", "contains", true)).toBe(true);
  });
  it("never matches an empty keyword (would otherwise match everything)", () => {
    expect(matchesKeyword("anything", "   ", "contains")).toBe(false);
    expect(matchesKeyword("anything", "", "contains")).toBe(false);
  });
  it("trims the keyword before matching", () => {
    expect(matchesKeyword("send link", "  link  ", "contains")).toBe(true);
  });
});

describe("matchesKeyword — exact", () => {
  it("matches only the whole trimmed text", () => {
    expect(matchesKeyword("link", "link", "exact")).toBe(true);
    expect(matchesKeyword("  link  ", "link", "exact")).toBe(true);
    expect(matchesKeyword("link please", "link", "exact")).toBe(false);
    expect(matchesKeyword("LINK", "link", "exact")).toBe(true);
    expect(matchesKeyword("LINK", "link", "exact", true)).toBe(false);
  });
});

describe("matchesKeyword — startsWith", () => {
  it("matches a leading keyword, tolerating leading whitespace", () => {
    expect(matchesKeyword("link please!", "link", "startsWith")).toBe(true);
    expect(matchesKeyword("  Link please!", "link", "startsWith")).toBe(true);
    expect(matchesKeyword("please link", "link", "startsWith")).toBe(false);
    expect(matchesKeyword("LINKED", "link", "startsWith", true)).toBe(false);
    expect(matchesKeyword("linked", "link", "startsWith", true)).toBe(true);
  });
});

describe("matchKeywords — first match wins, stored form returned", () => {
  it("returns the first matching keyword in rule order", () => {
    expect(matchKeywords("send me the link", ["price", "LINK", "send"], "contains")).toBe("LINK");
    expect(matchKeywords("nothing here", ["price", "link"], "contains")).toBe(null);
  });
  it("ignores non-string entries and non-string text defensively", () => {
    expect(matchKeywords("link", [null as unknown as string, "link"], "contains")).toBe("link");
    expect(matchKeywords(null as unknown as string, ["link"], "contains")).toBe(null);
  });
});
