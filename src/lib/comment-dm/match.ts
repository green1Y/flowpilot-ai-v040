/**
 * Pure keyword matcher for Instagram Comment-to-DM rules.
 *
 * No I/O, no DB — safe to unit-test exhaustively and to reuse from the
 * webhook ingest path (where a matcher failure must never break ingestion).
 *
 * Modes:
 * - "contains":   keyword appears anywhere in the comment text (default).
 * - "exact":      comment text (trimmed) equals the keyword (trimmed).
 * - "startsWith": comment text (leading whitespace trimmed) starts with
 *                 the keyword (trimmed).
 *
 * Case handling: case-insensitive by default (both sides lowercased).
 * With caseSensitive=true the comparison is exact-case. Empty keywords
 * never match (rule validation rejects them, but the matcher is defensive
 * too — an empty "contains" needle would otherwise match everything).
 */

/** Keyword match modes, mirroring CommentDmRule.matchMode. */
export const MATCH_MODES = ["contains", "exact", "startsWith"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

/** Normalize one side of a comparison for the given sensitivity. */
function normalize(s: string, caseSensitive: boolean): string {
  return caseSensitive ? s : s.toLowerCase();
}

/**
 * Match `text` against a single keyword under a mode.
 * Returns true only for a real, non-empty-keyword match.
 */
export function matchesKeyword(
  text: string,
  keyword: string,
  mode: MatchMode,
  caseSensitive = false
): boolean {
  const needle = normalize(keyword.trim(), caseSensitive);
  if (!needle) return false;
  const hay = normalize(text, caseSensitive);
  switch (mode) {
    case "exact":
      return hay.trim() === needle;
    case "startsWith":
      return hay.trimStart().startsWith(needle);
    case "contains":
    default:
      return hay.includes(needle);
  }
}

/**
 * Match `text` against a keyword list. Returns the FIRST matching keyword
 * (in rule order, as stored) or null when nothing matches. The returned
 * keyword is the stored form (original case), so event records and DM
 * {{keyword}} personalization show what the rule author wrote.
 */
export function matchKeywords(
  text: string,
  keywords: string[],
  mode: MatchMode,
  caseSensitive = false
): string | null {
  if (typeof text !== "string") return null;
  for (const kw of keywords) {
    if (typeof kw !== "string") continue;
    if (matchesKeyword(text, kw, mode, caseSensitive)) return kw;
  }
  return null;
}
