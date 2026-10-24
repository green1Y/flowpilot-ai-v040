import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import {
  updateCommentDmRuleSchema,
  serializeRule,
} from "@/lib/comment-dm/rules";
import { findWorkspaceRule } from "../../helpers";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/comment-dm/rules/[id] — one rule, workspace-scoped (Member). */
export const GET = handler(async (req: NextRequest, ctx: Ctx) => {
  const wctx = await requireWorkspace(req);
  const rule = await findWorkspaceRule(wctx.workspaceId, (await ctx.params).id);
  return ok({ item: serializeRule(rule) });
});

/**
 * PATCH /api/comment-dm/rules/[id] — partial update (MANAGER+).
 * Supports enabled/dryRun toggles as well as full field edits; keywords
 * are re-validated whenever supplied.
 */
export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const wctx = await requireWorkspace(req);
  requireRole(wctx, "MANAGER");
  const body = await parseBody(req, updateCommentDmRuleSchema);
  const rule = await findWorkspaceRule(wctx.workspaceId, (await ctx.params).id);
  const updated = await db.commentDmRule.update({
    where: { id: rule.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.mediaId !== undefined ? { mediaId: body.mediaId } : {}),
      ...(body.mediaPermalink !== undefined ? { mediaPermalink: body.mediaPermalink } : {}),
      ...(body.keywords !== undefined ? { keywords: JSON.stringify(body.keywords) } : {}),
      ...(body.matchMode !== undefined ? { matchMode: body.matchMode } : {}),
      ...(body.caseSensitive !== undefined ? { caseSensitive: body.caseSensitive } : {}),
      ...(body.commentReply !== undefined ? { commentReply: body.commentReply } : {}),
      ...(body.dmTemplate !== undefined ? { dmTemplate: body.dmTemplate } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
    },
  });
  await auditLog(wctx.workspaceId, wctx.userId, "comment_dm.rule_updated", {
    type: "comment_dm_rule",
    id: updated.id,
    fields: Object.keys(body),
  });
  return ok({ item: serializeRule(updated) });
});

/**
 * DELETE /api/comment-dm/rules/[id] — delete a rule (MANAGER+).
 * Its CommentDmEvent history cascade-deletes with it (schema FK).
 */
export const DELETE = handler(async (req: NextRequest, ctx: Ctx) => {
  const wctx = await requireWorkspace(req);
  requireRole(wctx, "MANAGER");
  const rule = await findWorkspaceRule(wctx.workspaceId, (await ctx.params).id);
  await db.commentDmRule.delete({ where: { id: rule.id } });
  await auditLog(wctx.workspaceId, wctx.userId, "comment_dm.rule_deleted", {
    type: "comment_dm_rule",
    id: rule.id,
    name: rule.name,
  });
  return ok({ deleted: rule.id });
});
