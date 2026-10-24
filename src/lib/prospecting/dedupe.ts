/**
 * Prospect dedupe normalization (Wave 2D).
 *
 * Two prospects are duplicates when they share a normalized domain, OR
 * when they share a normalized business name AND country. Normalization is
 * deterministic and pure so it can be unit-tested without a database.
 * Dedupe never merges silently — callers return 409 with the existing id
 * and let the user decide.
 */

/** Legal suffixes stripped from the END of a business name (case-insensitive). */
const LEGAL_SUFFIXES = new Set([
  "inc", "llc", "ltd", "corp", "corporation", "co", "company",
  "gmbh", "sarl", "sa", "ag", "bv", "pty", "plc", "llp", "inc.",
]);

/**
 * Normalize a website URL or bare domain: lowercase, strip scheme,
 * strip a leading "www.", drop any path/query/fragment, strip a trailing dot.
 * Returns "" when nothing usable remains.
 */
export function normalizeDomain(input: string | null | undefined): string {
  if (!input) return "";
  let s = input.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.split(/[/?#]/)[0]; // host only
  s = s.replace(/^www\./, "");
  s = s.replace(/\.+$/, ""); // trailing dot(s)
  return s;
}

/**
 * Normalize a business name: lowercase, strip punctuation, drop trailing
 * legal suffixes, collapse whitespace. E.g. "Acme, Inc." → "acme".
 */
export function normalizeName(input: string | null | undefined): string {
  if (!input) return "";
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  // A name that is ONLY a legal suffix (e.g. "Inc") keeps its token.
  if (tokens.length === 0) {
    const raw = input.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    return raw.join(" ");
  }
  return tokens.join(" ");
}

export interface DedupeCandidate {
  id: string;
  businessName: string;
  website?: string | null;
  country?: string | null;
}

export interface DedupeInput {
  businessName: string;
  website?: string | null;
  country?: string | null;
}

/**
 * Return existing candidates that duplicate `input`: same normalized domain
 * (when both sides have one), OR same normalized name + same country
 * (country compared case-insensitively, both present).
 */
export function findDuplicates(
  existing: DedupeCandidate[],
  input: DedupeInput
): DedupeCandidate[] {
  const domain = normalizeDomain(input.website);
  const name = normalizeName(input.businessName);
  const country = (input.country ?? "").trim().toLowerCase();
  return existing.filter((c) => {
    if (domain && normalizeDomain(c.website) === domain) return true;
    if (name && country && normalizeName(c.businessName) === name) {
      return (c.country ?? "").trim().toLowerCase() === country;
    }
    return false;
  });
}
