import { NextRequest } from "next/server";
import type { Integration } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { getAdapter } from "@/lib/integrations/providers";
import { auditLog } from "@/lib/audit";
import type { WorkspaceContext } from "@/lib/tenancy";
import {
  decryptCredentials,
  encryptCredentials,
  getValidAccessToken,
  verifyPage,
  getPhoneNumberInfo,
  MetaApiError,
  MetaTokenExpiredError,
  MetaRetryableError,
  isMetaPermissionError,
} from "@/lib/integrations/meta";
import {
  STATUS_DETAIL_CODES,
  makeStatusDetail,
} from "@/lib/integrations/connection-state";
import {
  decryptTikTokCredentials,
  encryptTikTokCredentials,
  getValidTikTokToken,
  getTikTokUserInfo,
  TikTokApiError,
  TikTokTokenExpiredError,
} from "@/lib/integrations/tiktok";
import { getInstagramLoginUser } from "@/lib/integrations/instagram-login";

const META_PROVIDERS = new Set(["instagram", "facebook", "whatsapp"]);

/**
 * Persist a failure detail so the 8-state model reflects what the provider
 * said (reauth_required / permission_missing / failed) instead of leaving
 * a stale "connecting" marker. Returns never — always throws the HTTP error.
 */
async function recordVerifyMetaFailure(id: string, e: unknown): Promise<never> {
  // Thrown err() HTTP responses pass through untouched (validation, etc.).
  if (e instanceof Response) throw e;
  if (e instanceof MetaTokenExpiredError) {
    await db.integration.update({
      where: { id },
      data: {
        status: "NEEDS_ATTENTION",
        statusDetail: makeStatusDetail(
          STATUS_DETAIL_CODES.tokenExpired,
          "Token expired — please reconnect"
        ),
      },
    });
    throw err("Token expired — please reconnect", 401);
  }
  if (e instanceof MetaRetryableError) {
    // Transient rate limit — the connection itself is fine, so no
    // statusDetail is persisted (it would wrongly flip the card to "failed").
    throw err("Meta rate limit hit — the connection itself is fine; retry shortly", 429);
  }
  if (e instanceof MetaApiError && isMetaPermissionError(e)) {
    await db.integration.update({
      where: { id },
      data: {
        statusDetail: makeStatusDetail(
          STATUS_DETAIL_CODES.permissionMissing,
          "A required Meta permission was revoked — re-authorize to grant it again"
        ),
      },
    });
    throw err("A required Meta permission was revoked — please reconnect and re-grant it", 403);
  }
  const message = e instanceof MetaApiError ? e.message : "Failed to verify the Meta connection";
  const httpStatus = e instanceof MetaApiError ? 422 : 500;
  await db.integration.update({
    where: { id },
    data: { statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.verifyFailed, message) },
  });
  throw err(message, httpStatus);
}

/**
 * Real verification for Meta providers: decrypt stored credentials, refresh
 * the user token when near expiry, then run a provider-specific live check
 * (page token check / WhatsApp phone-number lookup).
 */
async function verifyMeta(
  ctx: WorkspaceContext,
  integration: Integration
) {
  if (!integration.encryptedCredentials) {
    throw err("No Meta credentials stored — complete the connection flow first", 422);
  }

  let creds;
  try {
    creds = decryptCredentials(integration.encryptedCredentials);
  } catch {
    throw err("Stored Meta credentials are invalid — please reconnect", 422);
  }

  let token = creds.accessToken;
  try {
    const valid = await getValidAccessToken(creds);
    token = valid.token;
    if (valid.refreshed) {
      creds = { ...creds, accessToken: valid.token, expiresAt: valid.newExpiresAt };
      await db.integration.update({
        where: { id: integration.id },
        data: { encryptedCredentials: encryptCredentials(creds) },
      });
    }
  } catch (e) {
    await recordVerifyMetaFailure(integration.id, e);
  }

  try {
    if (integration.provider === "whatsapp") {
      if (!creds.phoneNumberId) {
        throw err("No phone number linked — reconnect WhatsApp", 422);
      }
      await getPhoneNumberInfo(creds.phoneNumberId, creds.accessToken);
    } else if (creds.loginType === "instagram_login") {
      // Wave 2A (D4): Business-Login Instagram rows have no Facebook Page
      // (pageId is null by design) — the old branch 422'd every one of
      // them. Route through the adapter-level identity check instead:
      // GET graph.instagram.com/me with the (possibly refreshed) user
      // token proves the IG Professional account exists. Only
      // facebook/legacy-instagram rows require a pageId.
      const me = await getInstagramLoginUser(token);
      await db.integration.update({
        where: { id: integration.id },
        data: {
          externalAccountId: me.id,
          accountName: me.username || me.name || undefined,
          accountAvatarUrl: me.profile_picture_url ?? undefined,
        },
      });
    } else {
      if (!creds.pageId) {
        throw err("No page selected — complete the page selection step", 422);
      }
      await verifyPage(creds.pageId, creds.pageAccessToken ?? token);
    }
  } catch (e) {
    await recordVerifyMetaFailure(integration.id, e);
  }

  // CONNECTED is only ever set after a successful verification handshake.
  const now = new Date();
  const updated = await db.integration.update({
    where: { id: integration.id },
    data: { status: "CONNECTED", verifiedAt: now, lastSyncAt: now, statusDetail: null },
  });
  await auditLog(ctx.workspaceId, ctx.userId, "integration.verified", {
    type: "integration",
    id: updated.id,
    provider: updated.provider,
  });
  return ok({ status: updated.status });
}

/**
 * Real verification for TikTok: decrypt stored credentials, refresh when
 * near expiry, then call the documented user/info endpoint. CONNECTED is
 * only ever set after this handshake succeeds.
 */
async function verifyTikTok(ctx: WorkspaceContext, integration: Integration) {
  if (!integration.encryptedCredentials) {
    throw err("No TikTok credentials stored — complete the connection flow first", 422);
  }

  let creds;
  try {
    creds = decryptTikTokCredentials(integration.encryptedCredentials);
  } catch {
    throw err("Stored TikTok credentials are invalid — please reconnect", 422);
  }

  try {
    const valid = await getValidTikTokToken(creds);
    if (valid.refreshed) {
      creds = {
        ...creds,
        accessToken: valid.token,
        expiresAt: valid.newExpiresAt,
        refreshToken: valid.newRefreshToken ?? creds.refreshToken,
      };
    }
    const info = await getTikTokUserInfo(valid.token);
    const now = new Date();
    const updated = await db.integration.update({
      where: { id: integration.id },
      data: {
        status: "CONNECTED",
        encryptedCredentials: encryptTikTokCredentials(creds),
        externalAccountId: info.openId,
        accountName: info.displayName || info.username || null,
        accountAvatarUrl: info.avatarUrl ?? null,
        verifiedAt: now,
        lastSyncAt: now,
        statusDetail: null,
      },
    });
    await auditLog(ctx.workspaceId, ctx.userId, "integration.verified", {
      type: "integration",
      id: updated.id,
      provider: updated.provider,
    });
    return ok({ status: updated.status });
  } catch (e) {
    if (e instanceof Response) throw e;
    if (e instanceof TikTokTokenExpiredError) {
      await db.integration.update({
        where: { id: integration.id },
        data: {
          status: "NEEDS_ATTENTION",
          statusDetail: makeStatusDetail(
            STATUS_DETAIL_CODES.tokenExpired,
            "Token expired — please reconnect"
          ),
        },
      });
      throw err("Token expired — please reconnect", 401);
    }
    if (e instanceof TikTokApiError && e.retryable) {
      // Transient rate limit — the connection itself is fine, so no
      // statusDetail is persisted (it would wrongly flip the card to "failed").
      throw err("TikTok rate limit hit — the connection itself is fine; retry shortly", 429);
    }
    if (e instanceof TikTokApiError) {
      await db.integration.update({
        where: { id: integration.id },
        data: {
          statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.verifyFailed, `TikTok error: ${e.message}`),
        },
      });
      throw err(`TikTok error: ${e.message}`, 422);
    }
    throw err("TikTok verification failed", 500);
  }
}

export const POST = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
  // Integration changes touch provider credentials: MANAGER+.
  requireRole(ctx, "MANAGER");

    const integration = await db.integration.findFirst({
      where: { id: (await params).id, workspaceId: ctx.workspaceId },
    });
    if (!integration) throw err("Integration not found", 404);

    if (META_PROVIDERS.has(integration.provider)) {
      return verifyMeta(ctx, integration);
    }

    if (integration.provider === "tiktok") {
      return verifyTikTok(ctx, integration);
    }

    let result;
    try {
      result = await getAdapter(integration.provider).verify({});
    } catch {
      throw err(`Unknown provider: ${integration.provider}`, 404);
    }

    // CONNECTED is only ever set after a successful verification handshake.
    if (result.ok && result.verified) {
      const now = new Date();
      const updated = await db.integration.update({
        where: { id: integration.id },
        data: { status: "CONNECTED", verifiedAt: now, lastSyncAt: now },
      });
      await auditLog(ctx.workspaceId, ctx.userId, "integration.verified", {
        type: "integration",
        id: updated.id,
        provider: updated.provider,
      });
      return ok({ status: updated.status });
    }

    throw err(result.message || "Verification failed", 422);
  }
);
