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
  getPhoneNumberInfo,
  verifyPage,
  MetaApiError,
  MetaTokenExpiredError,
  MetaRetryableError,
  isMetaPermissionError,
} from "@/lib/integrations/meta";
import { getInstagramLoginUser } from "@/lib/integrations/instagram-login";
import {
  decryptTikTokCredentials,
  encryptTikTokCredentials,
  getValidTikTokToken,
  getTikTokUserInfo,
  TikTokApiError,
  TikTokTokenExpiredError,
} from "@/lib/integrations/tiktok";

import {
  STATUS_DETAIL_CODES,
  makeStatusDetail,
} from "@/lib/integrations/connection-state";

const META_PROVIDERS = new Set(["instagram", "facebook", "whatsapp"]);

/**
 * Classify a Meta failure and persist the matching statusDetail so the
 * 8-state connection model reflects what the provider actually said:
 * token expired → reauth_required, permission revoked → permission_missing,
 * rate limit → honest 429, anything else → failed. Cleared on success.
 */
async function recordMetaFailure(id: string, e: unknown): Promise<never> {
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
  if (e instanceof MetaApiError) {
    await db.integration.update({
      where: { id },
      data: {
        statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.testFailed, e.message),
      },
    });
    throw err(e.message, 422);
  }
  await db.integration.update({
    where: { id },
    data: {
      statusDetail: makeStatusDetail(
        STATUS_DETAIL_CODES.testFailed,
        "Meta token check failed"
      ),
    },
  });
  throw err("Meta token check failed", 500);
}

/**
 * Connection test for Meta providers — Wave 2A: refresh-only ("Token
 * valid") proved nothing about the asset, so the test now ALSO performs
 * the identity check with the same primitives as the verify route
 * (IG-user lookup for Business Login, phone-number lookup for WhatsApp,
 * page verification otherwise). Still never sends a message. Returns
 * { ok: true, mocked: false, latencyMs, note } with the same gate and
 * audit logging as before.
 */
async function testMeta(ctx: WorkspaceContext, integration: Integration) {
  if (!integration.encryptedCredentials) {
    throw err("No Meta credentials stored — complete the connection flow first", 422);
  }

  let creds;
  try {
    creds = decryptCredentials(integration.encryptedCredentials);
  } catch {
    throw err("Stored Meta credentials are invalid — please reconnect", 422);
  }

  const started = Date.now();
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
    // Identity check — proves the asset exists, not just that a token
    // refreshed. Same primitives as verifyMeta.
    if (integration.provider === "whatsapp") {
      if (!creds.phoneNumberId) {
        throw err("No phone number linked — reconnect WhatsApp", 422);
      }
      await getPhoneNumberInfo(creds.phoneNumberId, token);
    } else if (creds.loginType === "instagram_login") {
      await getInstagramLoginUser(token);
    } else {
      if (!creds.pageId) {
        throw err("No page selected — complete the page selection step", 422);
      }
      await verifyPage(creds.pageId, creds.pageAccessToken ?? token);
    }
  } catch (e) {
    if (e instanceof Response) throw e;
    await recordMetaFailure(integration.id, e);
  }
  const latencyMs = Date.now() - started;

  await db.integration.update({
    where: { id: integration.id },
    data: { statusDetail: null },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "integration.tested", {
    type: "integration",
    id: integration.id,
    provider: integration.provider,
    ok: true,
    mocked: false,
  });

  return ok({
    ok: true,
    mocked: false,
    latencyMs,
    note: "Token valid — account identity verified, nothing sent",
  });
}

/**
 * Connection test for TikTok: refreshes the token when near expiry, then
 * makes an authenticated user/info call. Never sends anything. On expiry
 * the integration is marked NEEDS_ATTENTION ("Reauthorization required").
 */
async function testTikTok(ctx: WorkspaceContext, integration: Integration) {
  if (!integration.encryptedCredentials) {
    throw err("No TikTok credentials stored — complete the connection flow first", 422);
  }

  let creds;
  try {
    creds = decryptTikTokCredentials(integration.encryptedCredentials);
  } catch {
    throw err("Stored TikTok credentials are invalid — please reconnect", 422);
  }

  const started = Date.now();
  try {
    const valid = await getValidTikTokToken(creds);
    if (valid.refreshed) {
      await db.integration.update({
        where: { id: integration.id },
        data: {
          encryptedCredentials: encryptTikTokCredentials({
            ...creds,
            accessToken: valid.token,
            expiresAt: valid.newExpiresAt,
            refreshToken: valid.newRefreshToken ?? creds.refreshToken,
          }),
          lastSyncAt: new Date(),
        },
      });
    }
    const info = await getTikTokUserInfo(valid.token);
    await db.integration.update({
      where: { id: integration.id },
      data: {
        accountName: info.displayName || info.username || integration.accountName,
        accountAvatarUrl: info.avatarUrl ?? integration.accountAvatarUrl,
        lastSyncAt: new Date(),
      },
    });
  } catch (e) {
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
          statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.testFailed, `TikTok error: ${e.message}`),
        },
      });
      throw err(`TikTok error: ${e.message}`, 422);
    }
    await db.integration.update({
      where: { id: integration.id },
      data: {
        statusDetail: makeStatusDetail(STATUS_DETAIL_CODES.testFailed, "TikTok connection test failed"),
      },
    });
    throw err("TikTok connection test failed", 500);
  }
  const latencyMs = Date.now() - started;

  await db.integration.update({
    where: { id: integration.id },
    data: { statusDetail: null },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "integration.tested", {
    type: "integration",
    id: integration.id,
    provider: integration.provider,
    ok: true,
    mocked: false,
  });

  return ok({
    ok: true,
    mocked: false,
    latencyMs,
    note: "Token valid — account identity verified, nothing sent",
  });
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

    if (META_PROVIDERS.has(integration.provider) && integration.status === "CONNECTED") {
      return testMeta(ctx, integration);
    }

    if (integration.provider === "tiktok" && integration.status === "CONNECTED") {
      return testTikTok(ctx, integration);
    }

    let adapter;
    try {
      adapter = getAdapter(integration.provider);
    } catch {
      throw err(`Unknown provider: ${integration.provider}`, 404);
    }

    const started = Date.now();
    const result = await adapter.sendMessage({
      to: "test-recipient",
      body: "FlowPilot connection test — simulated by the mock adapter.",
    });
    const latencyMs = Date.now() - started;

    await auditLog(ctx.workspaceId, ctx.userId, "integration.tested", {
      type: "integration",
      id: integration.id,
      provider: integration.provider,
      ok: result.ok,
    });

    return ok({
      ok: result.ok,
      mocked: true,
      latencyMs,
      note: "SIMULATED — simulated by the mock adapter, no live provider check performed",
    });
  }
);
