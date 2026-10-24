/**
 * Rule validation + serialization tests — pure, no DB.
 */
import { describe, it, expect } from "vitest";
import {
  createCommentDmRuleSchema,
  updateCommentDmRuleSchema,
  parseRuleKeywords,
  serializeRule,
} from "./rules";

const base = {
  integrationId: "int-1",
  name: "Link rule",
  mediaId: "media-1",
  keywords: ["link", "price"],
  matchMode: "contains" as const,
};

describe("createCommentDmRuleSchema", () => {
  it("accepts a full valid rule and applies defaults", () => {
    const parsed = createCommentDmRuleSchema.parse({ ...base });
    expect(parsed.caseSensitive).toBe(false);
    expect(parsed.enabled).toBe(true);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.timezone).toBe("UTC");
  });
  it("rejects an empty keyword array and blank keywords", () => {
    expect(() => createCommentDmRuleSchema.parse({ ...base, keywords: [] })).toThrow();
    expect(() => createCommentDmRuleSchema.parse({ ...base, keywords: ["  "] })).toThrow();
    expect(() => createCommentDmRuleSchema.parse({ ...base, keywords: ["ok", ""] })).toThrow();
  });
  it("rejects unknown match modes and blank names/media", () => {
    expect(() => createCommentDmRuleSchema.parse({ ...base, matchMode: "fuzzy" })).toThrow();
    expect(() => createCommentDmRuleSchema.parse({ ...base, name: "  " })).toThrow();
    expect(() => createCommentDmRuleSchema.parse({ ...base, mediaId: "" })).toThrow();
  });
  it("accepts exact / startsWith modes and optional reply templates", () => {
    for (const mode of ["exact", "startsWith"] as const) {
      const parsed = createCommentDmRuleSchema.parse({
        ...base,
        matchMode: mode,
        commentReply: "Thanks! Check your DMs.",
        dmTemplate: "Hi {{name}}, here is your {{keyword}}!",
      });
      expect(parsed.matchMode).toBe(mode);
    }
  });
});

describe("updateCommentDmRuleSchema", () => {
  it("supports enabled/dryRun toggles alone", () => {
    expect(updateCommentDmRuleSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(updateCommentDmRuleSchema.parse({ dryRun: true })).toEqual({ dryRun: true });
    expect(updateCommentDmRuleSchema.parse({})).toEqual({});
  });
  it("still validates keywords when supplied", () => {
    expect(() => updateCommentDmRuleSchema.parse({ keywords: [] })).toThrow();
  });
});

describe("parseRuleKeywords / serializeRule", () => {
  it("parses the JSON column and tolerates malformed content", () => {
    expect(parseRuleKeywords('["a","b"]')).toEqual(["a", "b"]);
    expect(parseRuleKeywords("not json")).toEqual([]);
    expect(parseRuleKeywords(null)).toEqual([]);
    expect(parseRuleKeywords('{"x":1}')).toEqual([]);
    expect(parseRuleKeywords('["a", 1, " "]')).toEqual(["a"]);
  });
  it("serializes a row with keywords as an array and ISO dates", () => {
    const row = {
      id: "r1", workspaceId: "w1", integrationId: "i1", name: "R",
      mediaId: "m1", mediaPermalink: null, keywords: '["link"]',
      matchMode: "contains", caseSensitive: false, commentReply: null,
      dmTemplate: "Hi {{name}}", timezone: "UTC", enabled: true, dryRun: false,
      createdAt: new Date("2026-10-24T10:00:00Z"),
      updatedAt: new Date("2026-10-24T11:00:00Z"),
    };
    const s = serializeRule(row);
    expect(s.keywords).toEqual(["link"]);
    expect(s.createdAt).toBe("2026-10-24T10:00:00.000Z");
    expect((s as unknown as Record<string, unknown>).keywordsJson).toBeUndefined();
  });
});
