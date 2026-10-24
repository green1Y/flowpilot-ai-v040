/** Wave 2D: dedupe normalization + matching rules. */
import { describe, it, expect } from "vitest";
import { normalizeDomain, normalizeName, findDuplicates } from "./dedupe";

describe("normalizeDomain", () => {
  it("lowercases, strips www, scheme, path and trailing dot", () => {
    expect(normalizeDomain("https://WWW.Acme.Example.com./about?x=1")).toBe("acme.example.com");
    expect(normalizeDomain("acme.example")).toBe("acme.example");
    expect(normalizeDomain("http://shop.acme.example/")).toBe("shop.acme.example");
  });
  it("returns empty for blank input", () => {
    expect(normalizeDomain(null)).toBe("");
    expect(normalizeDomain("   ")).toBe("");
  });
});

describe("normalizeName", () => {
  it("lowercases, strips punctuation and legal suffixes, collapses whitespace", () => {
    expect(normalizeName("Acme, Inc.")).toBe("acme");
    expect(normalizeName("  ACME   Plumbing   LLC ")).toBe("acme plumbing");
    expect(normalizeName("Café & Bakery Co.")).toBe("caf bakery");
  });
});

describe("findDuplicates", () => {
  const existing = [
    { id: "p1", businessName: "Acme Plumbing, Inc.", website: "https://www.acme.example", country: "EG" },
    { id: "p2", businessName: "Nile Bakery", website: null, country: "EG" },
  ];
  it("matches on normalized domain regardless of name/country", () => {
    expect(findDuplicates(existing, { businessName: "Totally Different", website: "acme.example/" }).map((p) => p.id)).toEqual(["p1"]);
  });
  it("matches on normalized name + country", () => {
    expect(findDuplicates(existing, { businessName: "Nile Bakery LLC", country: "eg" }).map((p) => p.id)).toEqual(["p2"]);
  });
  it("does not match name alone when country differs or is missing", () => {
    expect(findDuplicates(existing, { businessName: "Nile Bakery", country: "SA" })).toEqual([]);
    expect(findDuplicates(existing, { businessName: "Nile Bakery" })).toEqual([]);
  });
  it("returns no duplicates for unrelated input", () => {
    expect(findDuplicates(existing, { businessName: "Delta Solar", website: "delta.example", country: "EG" })).toEqual([]);
  });
});
