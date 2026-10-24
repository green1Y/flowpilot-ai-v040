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
  resolveCapabilities,
  type CapabilityDetail,
} from "@/lib/integrations/capabilities";
import {
  resolveConnectionState,
  parseStatusDetail,
  type ConnectionState,
} from "@/lib/integrations/connection-state";
import { parseJson } from "@/lib/serialize";

/**
 * Best-effort account summary from encrypted credentials.
 * Never includes credentials; undefined on any failure.
 */
function accountInfo(row: Integration | undefined): {
  accountName?: string;
  accountId?: string;
} {
  if (!row?.encryptedCredentials) return {};
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

/**
 * Whether the provider's server-side configuration exists. Real OAuth
 * providers cannot function without it — the card then shows "unavailable"
 * instead of a misleading not-connected or connected state.
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

/**
 * Merge a stored Integration row with its catalog entry.
 * Encrypted credentials are NEVER included in the response.
 * Account identity prefers the persisted accountName/accountAvatarUrl
 * columns, falling back to best-effort decryption of credentials.
 *
 * Adds the honest connection model: `connectionState` (one of the 8 states),
 * `capabilitiesDetail` (per-capability state + note resolved from the actual
 * authorization state), and `statusDetailMessage` (the last failure reason,
 * when any).
 */
function merged(info: ProviderInfo, row: Integration | undefined) {
  const fallback = accountInfo(row);
  const simulated = isSimulatedProvider(info.provider);
  const envConfigured = envConfiguredFor(info.provider);
  const connectionState: ConnectionState = resolveConnectionState({
    provider: info.provider,
    dbStatus: row?.status,
    verifiedAt: row?.verifiedAt,
    encryptedCredentials: row?.encryptedCredentials,
    statusDetail: row?.statusDetail,
    envConfigured,
  });
  const capabilitiesDetail: CapabilityDetail[] = resolveCapabilities(
    info.provider,
    { connectionState, simulated }
  );
  return {
    simulated,
    id: row?.id,
    provider: info.provider,
    displayName: info.displayName,
    category: info.category,
    capabilities: row ? parseJson<string[]>(row.capabilities, [...info.capabilities]) : [...info.capabilities],
    capabilitiesDetail,
    connectionState,
    envConfigured,
    statusDetailMessage: parseStatusDetail(row?.statusDetail)?.message ?? null,
    limitations: row ? parseJson<string[]>(row.limitations, [...info.limitations]) : [...info.limitations],
    requiredPermissions: row
      ? parseJson<string[]>(row.requiredPermissions, [...info.requiredPermissions])
      : [...info.requiredPermissions],
    docsUrl: info.docsUrl,
    status: row?.status ?? "DISCONNECTED",
    lastSyncAt: row?.lastSyncAt ?? null,
    verifiedAt: row?.verifiedAt ?? null,
    accountName: row?.accountName ?? fallback.accountName,
    accountId: fallback.accountId,
    accountAvatarUrl: row?.accountAvatarUrl ?? null,
    lastError: row?.lastError ?? null,
    lastErrorAt: row?.lastErrorAt ?? null,
  };
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);

  // Ensure every catalog provider has a row (DEMO status for new ones).
  // Existing rows are never touched — their status is preserved.
  const existing = await db.integration.findMany({
    where: { workspaceId: ctx.workspaceId },
  });
  const have = new Set(existing.map((i) => i.provider));
  const missing = PROVIDERS.filter((p) => !have.has(p.provider));
  if (missing.length > 0) {
    await db.$transaction(
      missing.map((p) =>
        db.integration.create({
          data: {
            workspaceId: ctx.workspaceId,
            provider: p.provider,
            status: "DEMO",
            capabilities: JSON.stringify(p.capabilities),
            limitations: JSON.stringify(p.limitations),
            requiredPermissions: JSON.stringify(p.requiredPermissions),
          },
        })
      )
    );
  }

  const rows = await db.integration.findMany({ where: { workspaceId: ctx.workspaceId } });
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  return ok({ integrations: PROVIDERS.map((p) => merged(p, byProvider.get(p.provider))) });
});
