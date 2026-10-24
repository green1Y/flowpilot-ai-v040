import { NextRequest } from "next/server";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { setDefaultAccount } from "@/lib/integrations/accounts";

/**
 * POST /api/integrations/:id/set-default
 *
 * Makes one connected account the default for its (workspace, provider)
 * pair — the account adapter resolution uses when no account is named
 * explicitly. Scoped strictly to the caller's workspace: a foreign or
 * unknown row id is a 404. Never returns credentials.
 */
export const POST = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
    // Integration changes: MANAGER+ (same gate as disconnect/test/verify).
    requireRole(ctx, "MANAGER");

    const row = await setDefaultAccount(ctx.workspaceId, (await params).id);
    if (!row) throw err("Integration not found", 404);

    await auditLog(ctx.workspaceId, ctx.userId, "integration.set_default", {
      type: "integration",
      id: row.id,
      provider: row.provider,
    });

    return ok({ id: row.id, provider: row.provider, isDefault: true });
  }
);
