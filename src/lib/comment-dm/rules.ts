/**
 * Validation + serialization for Instagram Comment-to-DM rules
 * (CommentDmRule rows).
 *
 * Storage shape: `keywords` is a JSON string[] column; the API and UI work
 * with a plain string[]. `serializeRule` is the single place that converts
 * a row into its API shape, so the JSON column never leaks to clients.
 */
import { z } from "zod";
import { MATCH_MODES } from "./match";

/** One keyword: non-empty after trimming, max 100 chars. */
const keywordSchema = z
  .string()
  .trim()
  .min(1, "Keywords must not be empty")
  .max(100, "Keyword must be at most 100 characters");

/** Shared rule fields (create = all required except optionals). */
const ruleFields = {
  name: z.string().trim().min(1, "Name is required").max(120),
  mediaId: z.string().trim().min(1, "A post or Reel must be selected"),
  mediaPermalink: z.string().trim().max(500).nullable().optional(),
  keywords: z
    .array(keywordSchema)
    .min(1, "At least one keyword is required")
    .max(50, "At most 50 keywords per rule"),
  matchMode: z.enum(MATCH_MODES).default("contains"),
  caseSensitive: z.boolean().default(false),
  commentReply: z.string().trim().max(1000).nullable().optional(),
  dmTemplate: z.string().trim().max(1000).nullable().optional(),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
  enabled: z.boolean().default(true),
  dryRun: z.boolean().default(false),
};

/** POST /api/comment-dm/rules body. integrationId names the account. */
export const createCommentDmRuleSchema = z.object({
  ...ruleFields,
  integrationId: z.string().trim().min(1, "A connected Instagram account is required"),
});

/** PATCH /api/comment-dm/rules/[id] body — all fields optional. */
export const updateCommentDmRuleSchema = z.object({
  name: ruleFields.name.optional(),
  mediaId: ruleFields.mediaId.optional(),
  mediaPermalink: ruleFields.mediaPermalink.optional(),
  keywords: ruleFields.keywords.optional(),
  matchMode: z.enum(MATCH_MODES).optional(),
  caseSensitive: z.boolean().optional(),
  commentReply: ruleFields.commentReply,
  dmTemplate: ruleFields.dmTemplate,
  timezone: ruleFields.timezone.optional(),
  enabled: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export type CreateCommentDmRuleInput = z.infer<typeof createCommentDmRuleSchema>;
export type UpdateCommentDmRuleInput = z.infer<typeof updateCommentDmRuleSchema>;

/** Parse the keywords JSON column; malformed content yields []. */
export function parseRuleKeywords(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === "string" && k.trim().length > 0);
  } catch {
    return [];
  }
}

/** API shape of a CommentDmRule row. */
export interface SerializedCommentDmRule {
  id: string;
  workspaceId: string;
  integrationId: string;
  name: string;
  mediaId: string;
  mediaPermalink: string | null;
  keywords: string[];
  matchMode: string;
  caseSensitive: boolean;
  commentReply: string | null;
  dmTemplate: string | null;
  timezone: string;
  enabled: boolean;
  dryRun: boolean;
  createdAt: string;
  updatedAt: string;
}

export function serializeRule(
  row: {
    id: string;
    workspaceId: string;
    integrationId: string;
    name: string;
    mediaId: string;
    mediaPermalink: string | null;
    keywords: string;
    matchMode: string;
    caseSensitive: boolean;
    commentReply: string | null;
    dmTemplate: string | null;
    timezone: string;
    enabled: boolean;
    dryRun: boolean;
    createdAt: Date;
    updatedAt: Date;
  }
): SerializedCommentDmRule {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    integrationId: row.integrationId,
    name: row.name,
    mediaId: row.mediaId,
    mediaPermalink: row.mediaPermalink,
    keywords: parseRuleKeywords(row.keywords),
    matchMode: row.matchMode,
    caseSensitive: row.caseSensitive,
    commentReply: row.commentReply,
    dmTemplate: row.dmTemplate,
    timezone: row.timezone,
    enabled: row.enabled,
    dryRun: row.dryRun,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
