/** Wave 2D: rule-based qualification is deterministic and explainable. */
import { describe, it, expect } from "vitest";
import { scoreProspect } from "./qualify";

describe("scoreProspect", () => {
  it("awards points per present required field and names missing ones", () => {
    const r = scoreProspect(
      { businessName: "Acme", email: "a@acme.example" },
      { requiredFields: ["email", "website", "phone"] }
    );
    expect(r.score).toBe(10);
    expect(r.reasons).toContain("has email (+10)");
    expect(r.reasons).toContain("missing website (+0)");
    expect(r.reasons).toContain("missing phone (+0)");
  });

  it("awards keyword bonuses case-insensitively against name/industry/description", () => {
    const r = scoreProspect(
      { businessName: "Cairo Plumbing Co", industry: "Plumbing", description: "Emergency repairs" },
      { keywordBonuses: { plumbing: 20, emergency: 5, solar: 30 } }
    );
    expect(r.score).toBe(25);
    expect(r.reasons).toContain('matches keyword "plumbing" (+20)');
    expect(r.reasons).not.toContain('matches keyword "solar" (+30)');
  });

  it("awards region and industry matches, not non-matches", () => {
    const r = scoreProspect(
      { region: "Cairo", industry: "Plumbing" },
      { regionMatches: ["cairo", "Giza"], industryMatches: ["HVAC"] }
    );
    expect(r.score).toBe(15);
    expect(r.reasons.some((x) => x.includes("target region"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("not a target industry"))).toBe(true);
  });

  it("caps at 100, floors at 0, and is deterministic", () => {
    const p = { businessName: "Acme", email: "a@x.example", website: "acme.example" };
    const c = { requiredFields: ["email", "website"], keywordBonuses: { acme: 500 } };
    expect(scoreProspect(p, c).score).toBe(100);
    expect(scoreProspect(p, c)).toEqual(scoreProspect(p, c));
  });

  it("ignores unknown required fields instead of crashing", () => {
    const r = scoreProspect({ businessName: "Acme" }, { requiredFields: ["revenue"] });
    expect(r.score).toBe(0);
    expect(r.reasons[0]).toContain("ignored unknown required field");
  });

  it("with no criteria explains the zero score", () => {
    const r = scoreProspect({ businessName: "Acme" }, {});
    expect(r.score).toBe(0);
    expect(r.reasons[0]).toContain("no qualification criteria");
  });
});
