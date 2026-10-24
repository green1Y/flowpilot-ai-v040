/** Wave 2D: with no provider configured, every search is blocked — never fabricated. */
import { describe, it, expect } from "vitest";
import {
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_NOT_CONFIGURED,
  SEARCH_PROVIDER_PREREQUISITE,
  getSearchProvider,
  listSearchProviders,
  searchProspects,
} from "./providers";

describe("prospecting providers (no provider configured in v0.4.0)", () => {
  it("registry is empty and no provider is enabled", () => {
    expect(SEARCH_PROVIDERS).toEqual([]);
    expect(listSearchProviders()).toEqual([]);
    expect(getSearchProvider()).toBeNull();
  });

  it("searchProspects returns the blocked outcome with the prerequisite", async () => {
    const res = await searchProspects({ industry: "plumbing", targetCount: 25 });
    expect(res).toEqual({
      blocked: true,
      code: SEARCH_PROVIDER_NOT_CONFIGURED,
      prerequisite: SEARCH_PROVIDER_PREREQUISITE,
    });
    expect(res.blocked).toBe(true);
    if (res.blocked) {
      expect(res.prerequisite).toContain("SEARCH_PROVIDER");
      expect(res.prerequisite).toContain("no provider is configured in v0.4.0");
    }
  });

  it("never returns fabricated prospects", async () => {
    const res = await searchProspects({ industry: "cafés", country: "EG" });
    expect(res.blocked).toBe(true);
    expect("prospects" in res).toBe(false);
  });
});
