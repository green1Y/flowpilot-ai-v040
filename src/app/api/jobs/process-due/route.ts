import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import "@/lib/job-handlers"; // side effect: registers import_confirm + future handlers
import { processDueJobs } from "@/lib/jobs";

/**
 * POST /api/jobs/process-due — scheduler worker endpoint (MANAGER+).
 * Claims due durable jobs for this workspace and runs their registered
 * handlers (see src/lib/job-handlers.ts). Hit from an external cron on
 * the same pattern as /api/campaigns/process-due, e.g. every minute:
 *   curl -X POST https://<host>/api/jobs/process-due \
 *     -H "Cookie: <session>" -H "x-workspace-id: <id>"
 * NOTE: like the campaign worker, this endpoint authenticates via the
 * user's session/workspace — a cron caller needs a valid session cookie
 * or header workspace selection (see docs/IMPORT_AND_CONSENT.md).
 * It is NOT wired into the workflow engine; workflow executions keep
 * their own in-memory queue (src/lib/queue.ts).
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const result = await processDueJobs(ctx.workspaceId);
  await auditLog(ctx.workspaceId, ctx.userId, "jobs.process_due", {
    type: "worker",
    claimed: result.claimed,
    succeeded: result.succeeded,
    failed: result.failed,
    deadLettered: result.deadLettered,
  });
  return ok(result);
});
