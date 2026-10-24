import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { processDueFollowUps } from "@/lib/messaging/send";

/**
 * Scheduler worker endpoint: send every due SCHEDULED follow-up in the
 * caller's workspace. A cron hits this per workspace; eligibility is
 * re-checked at send time for each follow-up.
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Scheduler path that sends messages: MANAGER+.
  requireRole(ctx, "MANAGER");

  const results = await processDueFollowUps(ctx.workspaceId, ctx.userId);

  await auditLog(ctx.workspaceId, ctx.userId, "followup.process_due", {
    type: "worker",
    processed: results.length,
  });

  const sent = results.filter((r) => r.status === "SENT").length;
  const failed = results.filter((r) => r.status === "FAILED").length;
  const cancelled = results.filter((r) => r.status === "CANCELLED").length;

  return ok({ processed: results.length, sent, failed, cancelled, results });
});
