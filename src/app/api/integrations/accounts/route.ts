import { NextRequest } from "next/server";
import type { Integration } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { PROVIDERS, isSimulatedProvider, type ProviderInfo } from "@/lib/integrations/providers";
import { decryptCredentials, metaEnv } from "@/lib/integrations/meta";
import { instagramLoginEnv } from "@/lib/integrations/instagram-login";
import { tiktokEnv } from "@/lib/integrations/tiktok";
import {
  resolveConnectionState,
  parseStatusDetail,
  type ConnectionState,
} from "@/lib/integrations/connection-state";
import { parseJson } from "@/lib/serialize";

/**
 * Wave 2A (D8) — GET /api/integrations/accounts
 *
 * The existing per-provider list route (GET /api/integrations) collapses
 * multi-account workspaces to one card per provider, so the Health Center
 * cannot show per-account state. This route returns ALL Integration rows
 * for the workspace, each merged with its catalog entry + connectionState
 * + envConfigured — never credentials.
 *
 * Gate matches the existing list route: any workspace member may read
 * (requireWorkspace only, no MANAGER+ gate). The per-provider list route
 * is NOT changed.
 *
 * envConfigured / merged logic mirrors the list route deliberately (kept
 * in sync by the accounts tests); importing from a route module would
 * couple the two handlers' module graphs.
 */

function envConfiguredFor(provider: string): boolean {
  try {
    if (provider === "instagram") {
      metaEnv();
      instagramLoginEnv();
      return true;
    }
    if (provider === "facebook" || provider === "whatsapp") {
      metaEnv();
      return true;
    }
    if (provider === "tiktok") {
      tiktokEnv();
      return true;
    }
    return true; // simulated providers need no server configuration
  } catch {
    return false;
  }
}

/** Best-effort account identity from encrypted credentials (never credentials). */
function accountInfo(row: Integration): { accountName?: string; accountId?: string } {
  if (!row.encryptedCredentials) return {};
  try {
    const c = decryptCredentials(row.encryptedCredentials);
    return {
      accountName:
        c.pageName || c.igUsername || c.phoneDisplayName || c.metaUserName || undefined,
      accountId:
        c.igUserId || c.pageId || c.phoneNumberId || c.metaUserId || undefined,
    };
  } catch {
    return {};
  }
}

function merged(info: ProviderInfo, row: Integration) {
  const fallback = accountInfo(row);
  const simulated = isSimulatedProvider(info.provider);
  const envConfigured = envConfiguredFor(info.provider);
  const connectionState: ConnectionState = resolveConnectionState({
    provider: info.provider,
    dbStatus: row.status,
    verifiedAt: row.verifiedAt,
    encryptedCredentials: row.encryptedCredentials,
    statusDetail: row.statusDetail,
    envConfigured,
  });
  return {
    id: row.id,
    provider: info.provider,
    displayName: info.displayName,
    category: info.category,
    simulated,
    connectionState,
    envConfigured,
    status: row.status,
    statusDetailMessage: parseStatusDetail(row.statusDetail)?.message ?? null,
    capabilities: parseJson<string[]>(row.capabilities, [...info.capabilities]),
    limitations: parseJson<string[]>(row.limitations, [...info.limitations]),
    requiredPermissions: parseJson<string[]>(row.requiredPermissions, [...info.requiredPermissions]),
    docsUrl: info.docsUrl,
    isDefault: row.isDefault,
    accountName: row.accountName ?? fallback.accountName ?? null,
    accountId: row.externalAccountId ?? fallback.accountId ?? null,
    accountAvatarUrl: row.accountAvatarUrl ?? null,
    lastSyncAt: row.lastSyncAt ?? null,
    verifiedAt: row.verifiedAt ?? null,
    lastError: row.lastError ?? null,
    lastErrorAt: row.lastErrorAt ?? null,
    webhookSubscribedAt: row.webhookSubscribedAt ?? null,
    webhookSubscriptionDetail: row.webhookSubscriptionDetail ?? null,
    createdAt: row.createdAt,
  };
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const rows = await db.integration.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
  });
  const catalog = new Map(PROVIDERS.map((p) => [p.provider, p]));
  // Unknown-provider rows are NOT dropped: they surface with a generic
  // entry (simulated, no catalog capabilities) so no account is invisible
  // to the Health Center just because it predates the catalog.
  const accounts = rows.map((row) => {
    const info = catalog.get(row.provider) ?? {
      provider: row.provider,
      displayName: row.provider,
      category: "other",
      capabilities: [],
      limitations: [],
      requiredPermissions: [],
      docsUrl: "",
    };
    return merged(info, row);
  });
  return ok({ accounts });
});
