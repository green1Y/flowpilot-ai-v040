import { NextRequest } from "next/server";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { PROVIDERS } from "@/lib/integrations/providers";
import { buildTikTokAuthorizeUrl } from "@/lib/integrations/tiktok";
import { upsertAccountRow } from "@/lib/integrations/accounts";

/**
 * POST /api/integrations/tiktok/authorize
 * Returns: { url } — the signed TikTok Login Kit authorization URL.
 *
 * Records NEEDS_ATTENTION ("Connecting…") so the dashboard shows honest
 * in-progress state. The integration is NOT marked connected here — only
 * the callback may do that, after token exchange + persistence succeed.
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Integration changes touch provider credentials: MANAGER+.
  requireRole(ctx, "MANAGER");

  let url: string;
  try {
    url = buildTikTokAuthorizeUrl(ctx.workspaceId);
  } catch (e) {
    throw err(
      e instanceof Error ? e.message : "TikTok is not configured",
      422
    );
  }

  const info = PROVIDERS.find((p) => p.provider === "tiktok");
  // No TikTok identity is known yet — this marks the placeholder row
  // (externalAccountId = null), never an already-connected account.
  await upsertAccountRow({
    workspaceId: ctx.workspaceId,
    provider: "tiktok",
    externalAccountId: null,
    update: { status: "NEEDS_ATTENTION" },
    create: {
      workspace: { connect: { id: ctx.workspaceId } },
      provider: "tiktok",
      status: "NEEDS_ATTENTION",
      capabilities: JSON.stringify(info?.capabilities ?? []),
      limitations: JSON.stringify(info?.limitations ?? []),
      requiredPermissions: JSON.stringify(info?.requiredPermissions ?? []),
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "integration.tiktok_authorize_started", {
    type: "integration",
    provider: "tiktok",
  });

  return ok({ url, status: "NEEDS_ATTENTION" });
});
