/**
 * Rule-based prospect qualification (Wave 2D).
 *
 * Pure, deterministic, no AI calls: the same prospect + criteria always
 * produce the same score and the same human-readable reasons, so a score
 * can be explained and audited. Scores are capped at 100 and floored at 0.
 * This scores the data on the record only — it never invents missing facts
 * (a missing field simply earns no points and is named in the reasons).
 */

export interface ProspectLike {
  businessName?: string | null;
  industry?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  region?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
}

export interface QualificationCriteria {
  /** Fields that must be present to earn points, e.g. ["email", "website"]. */
  requiredFields?: string[];
  /** Keyword → bonus points, matched case-insensitively against name, industry, description. */
  keywordBonuses?: Record<string, number>;
  /** Region values that earn a bonus (case-insensitive exact match). */
  regionMatches?: string[];
  /** Industry values that earn a bonus (case-insensitive exact match). */
  industryMatches?: string[];
}

export interface QualificationResult {
  score: number;
  reasons: string[];
}

const FIELD_POINTS = 10;
const REGION_BONUS = 15;
const INDUSTRY_BONUS = 15;

/** The prospect fields that can be required/checked for presence. */
const CHECKABLE_FIELDS: (keyof ProspectLike)[] = [
  "businessName",
  "industry",
  "website",
  "email",
  "phone",
  "country",
  "region",
  "description",
  "sourceUrl",
];

function hasValue(p: ProspectLike, field: string): boolean {
  const v = (p as Record<string, unknown>)[field];
  return typeof v === "string" ? v.trim().length > 0 : v !== null && v !== undefined;
}

function haystack(p: ProspectLike): string {
  return [p.businessName, p.industry, p.description].filter(Boolean).join(" ").toLowerCase();
}

export function scoreProspect(
  prospect: ProspectLike,
  criteria: QualificationCriteria = {}
): QualificationResult {
  let score = 0;
  const reasons: string[] = [];

  for (const field of criteria.requiredFields ?? []) {
    if (!CHECKABLE_FIELDS.includes(field as keyof ProspectLike)) {
      reasons.push(`ignored unknown required field "${field}"`);
      continue;
    }
    if (hasValue(prospect, field)) {
      score += FIELD_POINTS;
      reasons.push(`has ${field} (+${FIELD_POINTS})`);
    } else {
      reasons.push(`missing ${field} (+0)`);
    }
  }

  const hay = haystack(prospect);
  for (const [keyword, bonus] of Object.entries(criteria.keywordBonuses ?? {})) {
    const kw = keyword.trim().toLowerCase();
    if (!kw) continue;
    if (hay.includes(kw)) {
      score += bonus;
      reasons.push(`matches keyword "${keyword}" (+${bonus})`);
    }
  }

  if ((criteria.regionMatches ?? []).length > 0) {
    const region = (prospect.region ?? "").trim().toLowerCase();
    if (region && criteria.regionMatches!.some((r) => r.trim().toLowerCase() === region)) {
      score += REGION_BONUS;
      reasons.push(`region "${prospect.region}" is a target region (+${REGION_BONUS})`);
    } else {
      reasons.push(`region "${prospect.region ?? ""}" is not a target region (+0)`);
    }
  }

  if ((criteria.industryMatches ?? []).length > 0) {
    const industry = (prospect.industry ?? "").trim().toLowerCase();
    if (industry && criteria.industryMatches!.some((i) => i.trim().toLowerCase() === industry)) {
      score += INDUSTRY_BONUS;
      reasons.push(`industry "${prospect.industry}" is a target industry (+${INDUSTRY_BONUS})`);
    } else {
      reasons.push(`industry "${prospect.industry ?? ""}" is not a target industry (+0)`);
    }
  }

  if (reasons.length === 0) {
    reasons.push("no qualification criteria supplied — score is 0 by default");
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}
