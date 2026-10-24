import { NextRequest } from "next/server";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { PROVIDERS, getAdapter } from "@/lib/integrations/providers";
import { encrypt } from "@/lib/crypto";
import { auditLog } from "@/lib/audit";
import { buildAuthorizeUrl, type MetaProvider } from "@/lib/integrations/meta";
import { buildInstagramLoginUrl } from "@/lib/integrations/instagram-login";
import { buildTikTokAuthorizeUrl } from "@/lib/integrations/tiktok";
import {
  upsertAccountRow,
  ensureDefaultAccount,
} from "@/lib/integrations/accounts";

const META_PROVIDERS = new Set(["instagram", "facebook", "whatsapp"]);

export const POST = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
  // Integration changes touch provider credentials: MANAGER+.
  requireRole(ctx, "MANAGER");
    // NOTE: at this route the `:id` slug is a provider slug (e.g. "instagram"),
    // not an integration row id. It shares the `[id]` segment name with the
    // sibling id-based routes because Next.js requires identical slug names
    // at the same path level.
    const provider = (await params).id;

    const info = PROVIDERS.find((p) => p.provider === provider);
    if (!info) throw err(`Unknown provider: ${provider}`, 404);

    // Meta providers use the real OAuth flow — never the mock handshake.
    // Instagram uses Business Login (www.instagram.com); Facebook and
    // WhatsApp stay on Facebook Login (www.facebook.com).
    if (META_PROVIDERS.has(provider)) {
      let url: string;
      try {
        url =
          provider === "instagram"
            ? buildInstagramLoginUrl(ctx.workspaceId)
            : buildAuthorizeUrl(provider as "facebook" | "whatsapp", ctx.workspaceId);
      } catch (e) {
        // Missing INSTAGRAM_APP_ID/SECRET → actionable 422, not a 500.
        throw err(
          e instanceof Error ? e.message : "Authorization is not configured",
          422
        );
      }
      await auditLog(ctx.workspaceId, ctx.userId, "integration.meta_authorize_started", {
        type: "integration",
        provider,
      });
      return ok({
        url,
        status: "NEEDS_ATTENTION",
        message: "Continue in the Meta authorization window.",
      });
    }

    // TikTok uses the real Login Kit OAuth flow — never the mock handshake.
    // (The simulated connect() path previously produced a misleading
    // "success" message with no actual authorization; it is bypassed here.)
    if (provider === "tiktok") {
      let url: string;
      try {
        url = buildTikTokAuthorizeUrl(ctx.workspaceId);
      } catch (e) {
        throw err(e instanceof Error ? e.message : "TikTok is not configured", 422);
      }
      const info2 = PROVIDERS.find((p) => p.provider === "tiktok");
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
          capabilities: JSON.stringify(info2?.capabilities ?? []),
          limitations: JSON.stringify(info2?.limitations ?? []),
          requiredPermissions: JSON.stringify(info2?.requiredPermissions ?? []),
        },
      });
      await auditLog(ctx.workspaceId, ctx.userId, "integration.tiktok_authorize_started", {
        type: "integration",
        provider,
      });
      return ok({
        url,
        status: "NEEDS_ATTENTION",
        message: "Continue in the TikTok authorization window.",
      });
    }

    // Simulated OAuth handshake. The adapter is honest: connect() does NOT
    // verify — status stays NEEDS_ATTENTION until /verify succeeds.
    const result = await getAdapter(provider).connect({});

    // Store only an opaque, encrypted marker — real OAuth secrets would be
    // encrypted here the same way. Never return credentials to the client.
    const encryptedCredentials = encrypt(
      JSON.stringify({ mock: true, at: Date.now() })
    );
    const data = {
      status: result.status,
      encryptedCredentials,
      capabilities: JSON.stringify(info.capabilities),
      limitations: JSON.stringify(info.limitations),
      requiredPermissions: JSON.stringify(info.requiredPermissions),
    };
    // Simulated providers have no provider-side identity — the row updated
    // is the provider's placeholder row (externalAccountId = null).
    const row = await upsertAccountRow({
      workspaceId: ctx.workspaceId,
      provider,
      externalAccountId: null,
      update: data,
      create: {
        workspace: { connect: { id: ctx.workspaceId } },
        provider,
        ...data,
      },
    });
    if (row.status === "CONNECTED") {
      await ensureDefaultAccount(ctx.workspaceId, provider, row.id);
    }

    await auditLog(ctx.workspaceId, ctx.userId, "integration.connected", {
      type: "integration",
      id: row.id,
      provider,
      status: row.status,
    });

    return ok({
      status: row.status,
      message: result.message,
      next: "Complete the verification step to activate",
    });
  }
);
