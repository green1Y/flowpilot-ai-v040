import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { commentDmRuleAnalytics } from "@/lib/analytics/queries";

/**
 * GET /api/comment-dm/analytics — per-rule breakdown (Member).
 * ?from= / ?to= accept ISO dates (default: last 30 days). The existing
 * /api/analytics/comment-to-dm route is untouched.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const sp = new URL(req.url).searchParams;
  const to = sp.get("to") ? new Date(sp.get("to") as string) : new Date();
  const from = sp.get("from")
    ? new Date(sp.get("from") as string)
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return Response.json(
      { ok: false, error: "from/to must be valid ISO dates" },
      { status: 400 }
    );
  }
  const rules = await commentDmRuleAnalytics(ctx.workspaceId, from, to);
  return ok({ rules, from: from.toISOString(), to: to.toISOString() });
});
