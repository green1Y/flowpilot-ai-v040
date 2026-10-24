/**
 * Connection-state model — 8 distinct, honest states.
 *
 * The DB stores coarse statuses (DEMO | CONNECTED | NEEDS_ATTENTION |
 * EXPIRED | DISCONNECTED). That alone cannot express "the token was revoked
 * by the user", "the last attempt failed", or "this provider cannot be
 * configured in this environment". This module resolves the display state
 * from the row + its persisted failure detail (Integration.statusDetail, a
 * JSON {code,message,at} blob that never contains tokens or secrets) +
 * whether the provider's env is configured.
 *
 * Hard rule: "connected" is returned ONLY when the row is CONNECTED, the
 * stored credentials decrypt, the expected asset ids are present, and no
 * failure detail contradicts the connection. Never show green when
 * auth/verification failed.
 */

import { decryptCredentials, type MetaCredentials } from "./meta";
import { decryptTikTokCredentials, type TikTokCredentials } from "./tiktok";
import { REAL_OAUTH_PROVIDERS } from "./providers";

/** The 8 honest connection states shown on integration cards. */
export type ConnectionState =
  | "not_connected" // never connected / disconnected / demo seed
  | "connecting" // OAuth or setup flow started, not yet completed
  | "connected" // verified live connection — credentials decrypt, asset ids present
  | "partial" // connected row but degraded (undecryptable asset ids missing, never verified)
  | "permission_missing" // provider revoked a permission / scope (explicit code)
  | "reauth_required" // token expired or invalid — user must reconnect
  | "unavailable" // server env config missing — displayed as "Configuration Required"
  | "failed"; // the last connection attempt failed

export interface StatusDetail {
  code: string;
  message: string;
  at: string; // ISO timestamp
}

/** Status-detail codes written by routes. */
export const STATUS_DETAIL_CODES = {
  tokenExpired: "token_expired",
  permissionMissing: "permission_missing",
  callbackFailed: "callback_failed",
  testFailed: "test_failed",
  verifyFailed: "verify_failed",
} as const;

export function makeStatusDetail(code: string, message: string): string {
  return JSON.stringify({ code, message, at: new Date().toISOString() });
}

export function parseStatusDetail(
  raw: string | null | undefined
): StatusDetail | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<StatusDetail>;
    if (typeof d.code === "string" && typeof d.message === "string") {
      return { code: d.code, message: d.message, at: typeof d.at === "string" ? d.at : "" };
    }
    return null;
  } catch {
    return null;
  }
}

/** Badge tones for the 8 states (matches the Badge component's tone set). */
export const CONNECTION_STATE_TONES: Record<ConnectionState, "gray" | "green" | "amber" | "red" | "blue"> = {
  not_connected: "gray",
  connecting: "blue",
  connected: "green",
  partial: "amber",
  permission_missing: "red",
  reauth_required: "amber",
  unavailable: "gray",
  failed: "red",
};

export interface ConnectionStateInput {
  provider: string;
  /** Raw DB status: DEMO | CONNECTED | NEEDS_ATTENTION | EXPIRED | DISCONNECTED (or null). */
  dbStatus: string | null | undefined;
  verifiedAt: Date | string | null | undefined;
  encryptedCredentials: string | null | undefined;
  /** Raw Integration.statusDetail JSON blob. */
  statusDetail: string | null | undefined;
  /** Whether the provider's required env (app id/secret/verify token) is configured. */
  envConfigured: boolean;
}

/** The asset ids that must be present for a "fully" connected row. */
function hasAssetFields(
  provider: string,
  creds: MetaCredentials | TikTokCredentials
): boolean {
  switch (provider) {
    case "instagram":
      return Boolean(
        (creds as MetaCredentials).igUserId || (creds as MetaCredentials).pageId
      );
    case "facebook":
      return Boolean((creds as MetaCredentials).pageId);
    case "whatsapp":
      return Boolean((creds as MetaCredentials).phoneNumberId);
    case "tiktok":
      return Boolean((creds as TikTokCredentials).openId);
    default:
      // Simulated providers carry no asset ids.
      return true;
  }
}

/**
 * Resolve the honest display state for one integration row.
 * Evaluation order matters:
 *   1. An explicit disconnect (or never-connected / demo seed) always wins —
 *      a disconnected provider shows "Disconnected", never "Configuration
 *      Required", even when the server env config is missing.
 *   2. Recorded failure detail (permission_missing / token_expired /
 *      callback_failed / ...) wins over everything else, because it
 *      describes what the provider last told us. A failed OAuth callback
 *      therefore surfaces "Connection failed" with its diagnostics even
 *      when the env config is currently missing.
 *   3. Missing server env config for a real OAuth provider → "unavailable"
 *      (displayed as "Configuration Required" — the "Unavailable" label is
 *      reserved for genuinely unsupported capabilities).
 *   4. Credential health for CONNECTED rows. Never green on bad data.
 */
export function resolveConnectionState(input: ConnectionStateInput): ConnectionState {
  const { provider, dbStatus, verifiedAt, encryptedCredentials, statusDetail, envConfigured } = input;
  const isReal = REAL_OAUTH_PROVIDERS.has(provider);

  // 1) No row / seed row / explicitly disconnected → not connected.
  if (!dbStatus || dbStatus === "DEMO" || dbStatus === "DISCONNECTED") {
    return "not_connected";
  }

  const detail = parseStatusDetail(statusDetail);
  const detailCode = detail?.code;

  // 2) Explicit permission revocation always wins — the user must re-grant.
  if (detailCode === STATUS_DETAIL_CODES.permissionMissing) {
    return "permission_missing";
  }

  // 3) Expired token → reauthorization required (never green, never masked).
  if (dbStatus === "EXPIRED" || detailCode === STATUS_DETAIL_CODES.tokenExpired) {
    return "reauth_required";
  }

  // 4) Any other recorded failure (callback/test/verify) → "failed", with the
  //    diagnostics from statusDetail. This wins over a missing env config:
  //    a failed OAuth callback still surfaces "Connection failed" even when
  //    the server config is currently missing.
  if (detail) {
    return "failed";
  }

  // 5) No server configuration → the provider cannot work in this environment.
  if (isReal && !envConfigured) return "unavailable";

  if (dbStatus === "NEEDS_ATTENTION") {
    return "connecting"; // flow started (authorize hit / page selection pending), not finished
  }

  if (dbStatus === "CONNECTED") {
    // 6) Credential health for real providers. Never green on bad data.
    if (isReal) {
      if (!encryptedCredentials) return "partial";
      let creds: MetaCredentials | TikTokCredentials;
      try {
        creds =
          provider === "tiktok"
            ? decryptTikTokCredentials(encryptedCredentials)
            : decryptCredentials(encryptedCredentials);
      } catch {
        return "failed"; // stored credentials are corrupted — reconnect
      }
      if (!hasAssetFields(provider, creds)) return "partial";
      if (!verifiedAt) return "partial"; // CONNECTED without a verification handshake
    }
    return "connected";
  }

  // Unknown status value — fail closed, never claim connected.
  return "not_connected";
}

/** Providers that implement a REAL OAuth flow (vs. the simulated mock handshake). */
export function isRealOAuthProvider(provider: string): boolean {
  return REAL_OAUTH_PROVIDERS.has(provider);
}
