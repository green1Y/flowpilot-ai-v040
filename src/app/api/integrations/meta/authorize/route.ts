import { NextRequest } from "next/server";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { metaAuthorizeSchema } from "@/lib/validation";
import { buildAuthorizeUrl, type MetaProvider } from "@/lib/integrations/meta";
import { buildInstagramLoginUrl } from "@/lib/integrations/instagram-login";

/**
 * POST /api/integrations/meta/authorize
 * Body: { provider: "instagram" | "facebook" | "whatsapp" }
 * Returns: { url } — the signed OAuth dialog URL.
 *
 * Instagram uses Business Login (www.instagram.com); Facebook and WhatsApp
 * stay on Facebook Login (www.facebook.com). The flows are not
 * interchangeable — each has its own host, scopes, and token endpoints.
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Integration changes touch provider credentials: MANAGER+.
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, metaAuthorizeSchema);

  const provider = body.provider as MetaProvider;
  let url: string;
  try {
    url =
      provider === "instagram"
        ? buildInstagramLoginUrl(ctx.workspaceId)
        : buildAuthorizeUrl(provider, ctx.workspaceId);
  } catch (e) {
    // Missing INSTAGRAM_APP_ID/SECRET → actionable 422, not a 500.
    throw err(
      e instanceof Error ? e.message : "Authorization is not configured",
      422
    );
  }

  await auditLog(ctx.workspaceId, ctx.userId, "integration.meta_authorize", {
    type: "integration",
    provider: body.provider,
  });

  return ok({ url });
});
