import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { findWorkspaceRule } from "../../../helpers";

/**
 * GET /api/comment-dm/rules/[id]/events — per-rule execution history
 * (Member). ?status= filters (DRY_RUN | SENT | FAILED | SKIPPED),
 * ?limit= caps the page (default 100, max 500). Actions JSON is parsed
 * for the client; malformed entries degrade to [].
 */
export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const wctx = await requireWorkspace(req);
  const rule = await findWorkspaceRule(wctx.workspaceId, (await ctx.params).id);
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status");
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit") ?? 100) || 100));
  const events = await db.commentDmEvent.findMany({
    where: {
      workspaceId: wctx.workspaceId,
      ruleId: rule.id,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return ok({
    items: events.map((e) => {
      let actions: unknown = [];
      try {
        actions = JSON.parse(e.actions || "[]");
      } catch {
        actions = [];
      }
      return {
        id: e.id,
        commentId: e.commentId,
        matched: e.matched,
        keyword: e.keyword,
        actions,
        status: e.status,
        error: e.error,
        createdAt: e.createdAt.toISOString(),
      };
    }),
  });
});
