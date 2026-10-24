import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";

const bodySchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

/**
 * Request deletion of this workspace. OWNER only.
 * This records the request in the audit trail; deletion itself is completed
 * by an administrator (no automatic destructive wipe in the app).
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "OWNER");
  const body = await parseBody(req, bodySchema);

  await auditLog(ctx.workspaceId, ctx.userId, "workspace.deletion_requested", {
    type: "workspace",
    id: ctx.workspaceId,
    reason: body.reason ?? null,
  });

  return ok({
    requested: true,
    message:
      "Deletion request recorded. An administrator will review it and complete the deletion — contact support to confirm.",
  });
});
