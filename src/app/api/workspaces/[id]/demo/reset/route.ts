import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { resetDemoData } from "@/lib/demo/reset";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/workspaces/[id]/demo/reset
 *
 * Deletes demo-seeded data for the workspace in the URL. Auth + tenant
 * scoping + MANAGER-or-above role required. The workspace id always comes
 * from the URL — no client-supplied id is ever trusted. Cross-workspace or
 * non-member calls get 403 (never a hint about whether the workspace
 * exists).
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const session = await requireUser();
  const workspaceId = (await params).id;

  // Membership in THIS workspace (the URL id), not the header-selected one.
  const membership = await db.membership.findFirst({
    where: { userId: session.userId, workspaceId },
  });
  if (!membership) {
    throw err("Forbidden", 403);
  }
  requireRole(
    { userId: session.userId, workspaceId, role: membership.role },
    "MANAGER"
  );

  const deleted = await resetDemoData(workspaceId);

  await auditLog(workspaceId, session.userId, "workspace.demo_reset", {
    type: "workspace",
    id: workspaceId,
    deleted,
  });

  return ok({ workspaceId, deleted });
});
