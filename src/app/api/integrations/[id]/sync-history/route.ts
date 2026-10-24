import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { syncHistory } from "@/lib/integrations/history";
import { MetaTokenExpiredError, MetaApiError } from "@/lib/integrations/meta";
import { auditLog } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

const META_PROVIDERS = new Set(["instagram", "facebook", "whatsapp"]);

/**
 * POST /api/integrations/[id]/sync-history
 *
 * Backfills real message history from Meta into the workspace's contacts,
 * conversations and messages (Instagram / Facebook). WhatsApp is a documented
 * no-op: the Cloud API exposes no history endpoint.
 *
 * The integration is resolved inside the caller's workspace (tenant
 * isolation). Every stored row is real (mocked=false); nothing is invented.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Integration changes touch provider credentials: MANAGER+.
  requireRole(ctx, "MANAGER");

  const integration = await db.integration.findFirst({
    where: { id: (await params).id, workspaceId: ctx.workspaceId },
  });
  if (!integration) throw err("Integration not found", 404);
  if (!META_PROVIDERS.has(integration.provider)) {
    throw err(`History sync is not supported for provider "${integration.provider}"`, 422);
  }

  try {
    const result = await syncHistory(integration);

    await db.integration.update({
      where: { id: integration.id },
      data: { lastSyncAt: new Date() },
    });
    await auditLog(ctx.workspaceId, ctx.userId, "integration.history_synced", {
      type: "integration",
      id: integration.id,
      ...result,
    });

    return ok({
      integrationId: integration.id,
      provider: integration.provider,
      ...result,
    });
  } catch (e) {
    if (e instanceof MetaTokenExpiredError) {
      await db.integration.update({
        where: { id: integration.id },
        data: { status: "NEEDS_ATTENTION" },
      });
      throw err("Meta token expired — please reconnect", 401);
    }
    if (e instanceof MetaApiError) throw err(`Meta API error: ${e.message}`, 422);
    if (e instanceof Error) throw err(e.message, 422);
    throw err("History sync failed", 500);
  }
});
