import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import {
  createCommentDmRuleSchema,
  serializeRule,
} from "@/lib/comment-dm/rules";
import { findWorkspaceInstagramAccount } from "../helpers";

/**
 * GET /api/comment-dm/rules — list rules in this workspace (Member).
 * Optional ?integrationId= filters to one connected account.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const integrationId = new URL(req.url).searchParams.get("integrationId");
  const rules = await db.commentDmRule.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(integrationId ? { integrationId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return ok({ items: rules.map(serializeRule) });
});

/**
 * POST /api/comment-dm/rules — create a rule (MANAGER+).
 * The account must exist in this workspace and be an Instagram account;
 * its connection status is NOT required at creation time (a rule may be
 * drafted before connecting) — sends through a non-CONNECTED account
 * fail honestly as FAILED events instead.
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, createCommentDmRuleSchema);
  await findWorkspaceInstagramAccount(ctx.workspaceId, body.integrationId);
  const created = await db.commentDmRule.create({
    data: {
      workspaceId: ctx.workspaceId,
      integrationId: body.integrationId,
      name: body.name,
      mediaId: body.mediaId,
      mediaPermalink: body.mediaPermalink ?? null,
      keywords: JSON.stringify(body.keywords),
      matchMode: body.matchMode,
      caseSensitive: body.caseSensitive,
      commentReply: body.commentReply ?? null,
      dmTemplate: body.dmTemplate ?? null,
      timezone: body.timezone,
      enabled: body.enabled,
      dryRun: body.dryRun,
    },
  });
  await auditLog(ctx.workspaceId, ctx.userId, "comment_dm.rule_created", {
    type: "comment_dm_rule",
    id: created.id,
    name: created.name,
    mediaId: created.mediaId,
  });
  return ok({ item: serializeRule(created) });
});
