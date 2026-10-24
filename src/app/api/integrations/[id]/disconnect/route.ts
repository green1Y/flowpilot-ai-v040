import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { decryptCredentials, graph } from "@/lib/integrations/meta";
import { igGraph } from "@/lib/integrations/instagram-login";
import { decryptTikTokCredentials, tiktokEnv } from "@/lib/integrations/tiktok";
import { TIKTOK_REVOKE_URL } from "@/lib/integrations/tiktok";

export const POST = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
  // Integration changes touch provider credentials: MANAGER+.
  requireRole(ctx, "MANAGER");

    const integration = await db.integration.findFirst({
      where: { id: (await params).id, workspaceId: ctx.workspaceId },
    });
    if (!integration) throw err("Integration not found", 404);

    // Best-effort: ask the provider to invalidate the token BEFORE we wipe
    // it locally. Revocation failures must never block the local
    // disconnect — the credentials are cleared either way.
    await revokeProviderTokens(integration.provider, integration.encryptedCredentials);

    const updated = await db.integration.update({
      where: { id: integration.id },
      data: {
        status: "DISCONNECTED",
        encryptedCredentials: null,
        statusDetail: null,
        verifiedAt: null,
        accountName: null,
        accountAvatarUrl: null,
      },
    });

    await auditLog(ctx.workspaceId, ctx.userId, "integration.disconnected", {
      type: "integration",
      id: updated.id,
      provider: updated.provider,
    });

    return ok({ status: updated.status });
  }
);

/**
 * Ask the provider to revoke/invalidate the stored token. Best-effort:
 * never throws, never logs tokens or secrets. Unknown providers, missing
 * credentials, or undecryptable payloads are silently skipped — the local
 * disconnect always proceeds.
 */
async function revokeProviderTokens(
  provider: string,
  encrypted: string | null
): Promise<void> {
  if (!encrypted) return;
  try {
    if (provider === "tiktok") {
      const creds = decryptTikTokCredentials(encrypted);
      const { clientKey } = tiktokEnv();
      await fetch(TIKTOK_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: clientKey,
          token: creds.accessToken,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      return;
    }

    if (provider === "facebook" || provider === "instagram" || provider === "whatsapp") {
      const creds = decryptCredentials(encrypted);
      // Instagram Business Login: revoke on the Instagram graph host.
      if (
        provider === "instagram" &&
        creds.loginType === "instagram_login" &&
        creds.igUserId
      ) {
        await igGraph(`/${creds.igUserId}/permissions`, creds.accessToken, {
          method: "DELETE",
        });
        return;
      }
      // Facebook Login flows: delete the granted permissions on the user/Page.
      if (provider === "facebook" && creds.metaUserId) {
        await graph(`/${creds.metaUserId}/permissions`, {
          token: creds.accessToken,
          method: "DELETE",
        });
        return;
      }
      if (
        provider === "instagram" &&
        creds.pageId &&
        creds.pageAccessToken
      ) {
        await graph(`/${creds.pageId}/permissions`, {
          token: creds.pageAccessToken,
          method: "DELETE",
        });
        return;
      }
      // WhatsApp: manual bearer token with no user-scoped revoke endpoint —
      // nothing provider-side to call.
    }
  } catch {
    // Best-effort: fall through to local cleanup.
  }
}
