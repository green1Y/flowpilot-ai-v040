/**
 * Wave 2A (D6) — integration health probes.
 *
 * runHealthProbes(integrationId) runs, in order:
 *   1. token    — refresh-or-valid (persisting refreshed credentials, as
 *                 in the verify route); never a bare "token present" check.
 *   2. identity — page / phone / IG-user / TikTok-user lookup via the same
 *                 primitives the verify route uses, proving the asset
 *                 actually exists at the provider.
 *   3. webhook  — subscription-state read where the API offers one
 *                 (Instagram Business Login: GET subscribed_apps); for
 *                 every other real provider the probe is BLOCKED with a
 *                 reason, never a faked pass — dashboard-side subscription
 *                 is manual there.
 *
 * One HealthCheck row is written per probe. `detail` is sanitized JSON
 * only (ids, usernames, booleans, reasons) — never tokens, secrets, or
 * credential material. Simulated providers return SIMULATED for every
 * probe, never a fake live pass.
 *
 * All provider calls are stubbed-fetch tests only in this environment
 * (no Meta/TikTok credentials here); production callers use the real APIs.
 */

import { db } from "../db";
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
} from "./meta";
import { getInstagramLoginUser, igGraph } from "./instagram-login";
import {
  decryptTikTokCredentials,
  encryptTikTokCredentials,
  getValidTikTokToken,
  getTikTokUserInfo,
  TikTokApiError,
  TikTokTokenExpiredError,
} from "./tiktok";
import { isSimulatedProvider } from "./providers";

export type HealthProbeName = "token" | "identity" | "webhook";
export type HealthProbeStatus =
  | "OK"
  | "DEGRADED"
  | "FAILED"
  | "BLOCKED"
  | "SIMULATED";

export interface HealthProbeResult {
  probe: HealthProbeName;
  status: HealthProbeStatus;
  latencyMs: number;
  /** Sanitized detail — safe ids/reasons only, never tokens. */
  detail: Record<string, unknown>;
}

export interface HealthProbeRun {
  integrationId: string;
  provider: string;
  simulated: boolean;
  probes: HealthProbeResult[];
}

/** Truncate a provider message for storage; provider messages never carry tokens. */
function safeMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? m.slice(0, 300) : m;
}

function classifyMetaError(e: unknown): { status: HealthProbeStatus; reason: string } {
  if (e instanceof MetaTokenExpiredError) return { status: "FAILED", reason: "token_expired" };
  if (e instanceof MetaRetryableError) return { status: "DEGRADED", reason: "rate_limited_or_timeout" };
  if (e instanceof MetaApiError && isMetaPermissionError(e)) {
    return { status: "FAILED", reason: "permission_missing" };
  }
  if (e instanceof MetaApiError) return { status: "FAILED", reason: safeMessage(e) };
  return { status: "FAILED", reason: safeMessage(e) };
}

const META_PROVIDERS = new Set(["instagram", "facebook", "whatsapp"]);

interface TokenOutcome {
  status: HealthProbeStatus;
  detail: Record<string, unknown>;
  /** Usable token for the later probes, or null when the token probe failed. */
  token: string | null;
  /** Decrypted credentials (Meta) for the identity probe's page token, if any. */
  pageAccessToken?: string | null;
}

async function probeTokenMeta(
  row: { id: string; encryptedCredentials: string | null }
): Promise<TokenOutcome> {
  if (!row.encryptedCredentials) {
    return { status: "FAILED", detail: { reason: "no_credentials_stored" }, token: null };
  }
  let creds;
  try {
    creds = decryptCredentials(row.encryptedCredentials);
  } catch {
    return { status: "FAILED", detail: { reason: "credentials_undecryptable" }, token: null };
  }
  try {
    const valid = await getValidAccessToken(creds);
    if (valid.refreshed) {
      await db.integration.update({
        where: { id: row.id },
        data: {
          encryptedCredentials: encryptCredentials({
            ...creds,
            accessToken: valid.token,
            expiresAt: valid.newExpiresAt,
          }),
        },
      });
    }
    return {
      status: "OK",
      detail: { refreshed: valid.refreshed, expiresAt: valid.newExpiresAt },
      token: valid.token,
      pageAccessToken: creds.pageAccessToken ?? null,
    };
  } catch (e) {
    const c = classifyMetaError(e);
    return { status: c.status, detail: { reason: c.reason }, token: creds.accessToken };
  }
}

async function probeTokenTikTok(
  row: { id: string; encryptedCredentials: string | null }
): Promise<TokenOutcome> {
  if (!row.encryptedCredentials) {
    return { status: "FAILED", detail: { reason: "no_credentials_stored" }, token: null };
  }
  let creds;
  try {
    creds = decryptTikTokCredentials(row.encryptedCredentials);
  } catch {
    return { status: "FAILED", detail: { reason: "credentials_undecryptable" }, token: null };
  }
  try {
    const valid = await getValidTikTokToken(creds);
    if (valid.refreshed) {
      await db.integration.update({
        where: { id: row.id },
        data: {
          encryptedCredentials: encryptTikTokCredentials({
            ...creds,
            accessToken: valid.token,
            expiresAt: valid.newExpiresAt,
            refreshToken: valid.newRefreshToken ?? creds.refreshToken,
          }),
        },
      });
    }
    return {
      status: "OK",
      detail: { refreshed: valid.refreshed, expiresAt: valid.newExpiresAt },
      token: valid.token,
    };
  } catch (e) {
    if (e instanceof TikTokTokenExpiredError) {
      return { status: "FAILED", detail: { reason: "token_expired" }, token: creds.accessToken };
    }
    if (e instanceof TikTokApiError && e.retryable) {
      return { status: "DEGRADED", detail: { reason: "rate_limited_or_timeout" }, token: creds.accessToken };
    }
    return { status: "FAILED", detail: { reason: safeMessage(e) }, token: creds.accessToken };
  }
}

interface IdentityContext {
  provider: string;
  loginType?: string;
  pageId?: string;
  phoneNumberId?: string;
  igUserId?: string;
}

async function probeIdentity(
  ctx: IdentityContext,
  token: string | null,
  pageAccessToken: string | null | undefined
): Promise<{ status: HealthProbeStatus; detail: Record<string, unknown> }> {
  if (!token) {
    return { status: "FAILED", detail: { reason: "no_token_available" } };
  }
  try {
    if (ctx.provider === "whatsapp") {
      if (!ctx.phoneNumberId) {
        return { status: "FAILED", detail: { reason: "no_phone_number_id" } };
      }
      const info = await getPhoneNumberInfo(ctx.phoneNumberId, token);
      return {
        status: "OK",
        detail: { accountId: info.id, verifiedName: info.verified_name },
      };
    }
    if (ctx.provider === "instagram" && ctx.loginType === "instagram_login") {
      const me = await getInstagramLoginUser(token);
      return { status: "OK", detail: { accountId: me.id, username: me.username } };
    }
    if (ctx.provider === "facebook" || ctx.provider === "instagram") {
      if (!ctx.pageId) {
        return { status: "FAILED", detail: { reason: "no_page_id" } };
      }
      const page = await verifyPage(ctx.pageId, pageAccessToken ?? token);
      return { status: "OK", detail: { accountId: page.id, pageName: page.name } };
    }
    if (ctx.provider === "tiktok") {
      const info = await getTikTokUserInfo(token);
      return {
        status: "OK",
        detail: { accountId: info.openId, username: info.username ?? null },
      };
    }
    return { status: "BLOCKED", detail: { reason: "no_identity_check_for_provider" } };
  } catch (e) {
    if (e instanceof TikTokTokenExpiredError) {
      return { status: "FAILED", detail: { reason: "token_expired" } };
    }
    if (e instanceof TikTokApiError) {
      return {
        status: e.retryable ? "DEGRADED" : "FAILED",
        detail: { reason: e.retryable ? "rate_limited_or_timeout" : safeMessage(e) },
      };
    }
    const c = classifyMetaError(e);
    return { status: c.status, detail: { reason: c.reason } };
  }
}

async function probeWebhook(
  ctx: IdentityContext,
  token: string | null
): Promise<{ status: HealthProbeStatus; detail: Record<string, unknown> }> {
  // The only subscription-state READ the APIs offer here is Instagram
  // Business Login's subscribed_apps endpoint. Everything else is
  // dashboard-side and manual — report BLOCKED, never invent a state.
  if (ctx.provider === "instagram" && ctx.loginType === "instagram_login") {
    if (!ctx.igUserId || !token) {
      return { status: "FAILED", detail: { reason: "no_ig_user_id_or_token" } };
    }
    try {
      const data = await igGraph<{ data?: unknown[] }>(
        `/${ctx.igUserId}/subscribed_apps`,
        token
      );
      const apps = Array.isArray(data?.data) ? data.data : [];
      if (apps.length > 0) {
        return { status: "OK", detail: { subscribed: true, appCount: apps.length } };
      }
      return {
        status: "DEGRADED",
        detail: { subscribed: false, reason: "no_subscribed_apps_returned" },
      };
    } catch (e) {
      const c = classifyMetaError(e);
      return { status: c.status, detail: { reason: c.reason } };
    }
  }
  if (ctx.provider === "tiktok") {
    return {
      status: "BLOCKED",
      detail: { reason: "TikTok Login Kit has no webhook surface." },
    };
  }
  return {
    status: "BLOCKED",
    detail: {
      reason:
        "Webhook subscription state cannot be read via API for this provider; subscription is managed in the Meta app dashboard (manual).",
    },
  };
}

/**
 * Run the token → identity → webhook probes for one integration row and
 * persist one HealthCheck row per probe. Each probe is attempted even if
 * an earlier one failed, so a token failure never masks webhook state.
 * Throws when the integration row does not exist.
 */
export async function runHealthProbes(integrationId: string): Promise<HealthProbeRun> {
  const row = await db.integration.findUnique({ where: { id: integrationId } });
  if (!row) throw new Error(`Integration not found: ${integrationId}`);

  const simulated = isSimulatedProvider(row.provider);
  const probes: HealthProbeResult[] = [];

  if (simulated) {
    // Simulated providers have no live API to probe — SIMULATED, never OK.
    for (const probe of ["token", "identity", "webhook"] as HealthProbeName[]) {
      probes.push({
        probe,
        status: "SIMULATED",
        latencyMs: 0,
        detail: { reason: "simulated_provider_no_live_check" },
      });
    }
  } else {
    // Decode the identity context once (best-effort; undecryptable rows
    // still get FAILED probes rather than a thrown error).
    let ctx: IdentityContext = { provider: row.provider };
    if (row.encryptedCredentials) {
      try {
        if (META_PROVIDERS.has(row.provider)) {
          const c = decryptCredentials(row.encryptedCredentials);
          ctx = {
            provider: row.provider,
            loginType: c.loginType,
            pageId: c.pageId,
            phoneNumberId: c.phoneNumberId,
            igUserId: c.igUserId,
          };
        }
      } catch {
        // ctx stays provider-only; token probe reports the failure.
      }
    }

    const startedToken = Date.now();
    const tokenOutcome =
      row.provider === "tiktok"
        ? await probeTokenTikTok(row)
        : await probeTokenMeta(row);
    probes.push({
      probe: "token",
      status: tokenOutcome.status,
      latencyMs: Date.now() - startedToken,
      detail: tokenOutcome.detail,
    });

    const startedIdentity = Date.now();
    const identity = await probeIdentity(
      ctx,
      tokenOutcome.token,
      tokenOutcome.pageAccessToken
    );
    probes.push({
      probe: "identity",
      status: identity.status,
      latencyMs: Date.now() - startedIdentity,
      detail: identity.detail,
    });

    const startedWebhook = Date.now();
    const webhook = await probeWebhook(ctx, tokenOutcome.token);
    probes.push({
      probe: "webhook",
      status: webhook.status,
      latencyMs: Date.now() - startedWebhook,
      detail: webhook.detail,
    });
  }

  for (const p of probes) {
    await db.healthCheck.create({
      data: {
        workspaceId: row.workspaceId,
        integrationId: row.id,
        probe: p.probe,
        status: p.status,
        latencyMs: p.latencyMs,
        detail: JSON.stringify(p.detail),
      },
    });
  }

  return { integrationId: row.id, provider: row.provider, simulated, probes };
}
