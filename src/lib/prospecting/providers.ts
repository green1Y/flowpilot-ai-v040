/**
 * Prospecting search-provider plumbing (Wave 2D).
 *
 * HONESTY RULE: no search/business-data provider is configured in v0.4.0,
 * so the registry is deliberately empty and every search attempt returns the
 * BLOCKED_NO_SOURCE result below. This module must NEVER fabricate prospect
 * results, and it must NEVER call a real search API. A future provider is
 * added by implementing SearchProvider, registering it, and gating it behind
 * SEARCH_PROVIDER + its API key — see docs/PROSPECTING.md.
 */

export const SEARCH_PROVIDER_NOT_CONFIGURED = "SEARCH_PROVIDER_NOT_CONFIGURED";

export const SEARCH_PROVIDER_PREREQUISITE =
  "Configure a search/business-data provider (env SEARCH_PROVIDER + its API key; see docs/PROSPECTING.md) — no provider is configured in v0.4.0";

export interface SearchParams {
  industry: string;
  country?: string | null;
  region?: string | null;
  businessType?: string | null;
  /** Ideal-customer-profile fields, free-form (e.g. { companySize, budget }). */
  icp?: Record<string, unknown>;
  keywords?: string[];
  exclusions?: string[];
  targetCount?: number;
}

/** A prospect returned by a real provider — every field carries provenance. */
export interface SearchedProspect {
  businessName: string;
  industry?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  region?: string | null;
  description?: string | null;
  /** The provider page/record this prospect came from. Required for trust. */
  sourceUrl: string;
}

export type SearchOutcome =
  | { blocked: true; code: typeof SEARCH_PROVIDER_NOT_CONFIGURED; prerequisite: string }
  | { blocked: false; provider: string; prospects: SearchedProspect[] };

export interface SearchProvider {
  /** Env value of SEARCH_PROVIDER that selects this provider. */
  id: string;
  label: string;
  /** True only when the provider is configured AND enabled. */
  configured: boolean;
  search(params: SearchParams): Promise<SearchedProspect[]>;
}

/**
 * The provider registry. Intentionally empty in v0.4.0: no provider
 * integration has been built or configured, so nothing can be "enabled"
 * by accident. Add providers here only with a real integration behind them.
 */
export const SEARCH_PROVIDERS: SearchProvider[] = [];

export function listSearchProviders(): SearchProvider[] {
  return [...SEARCH_PROVIDERS];
}

/** The enabled provider, or null when none is configured. */
export function getSearchProvider(): SearchProvider | null {
  return SEARCH_PROVIDERS.find((p) => p.configured) ?? null;
}

/**
 * Run a prospect search. With no provider configured this always returns
 * the blocked outcome — callers must surface `prerequisite` to the user
 * and must NOT substitute invented results.
 */
export async function searchProspects(params: SearchParams): Promise<SearchOutcome> {
  const provider = getSearchProvider();
  if (!provider) {
    return {
      blocked: true,
      code: SEARCH_PROVIDER_NOT_CONFIGURED,
      prerequisite: SEARCH_PROVIDER_PREREQUISITE,
    };
  }
  const prospects = await provider.search(params);
  return { blocked: false, provider: provider.id, prospects };
}
