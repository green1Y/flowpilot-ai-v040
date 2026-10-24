/**
 * TikTok Login Kit client — REAL OAuth (not simulated).
 *
 * Flow (mirrors the Meta OAuth patterns in meta.ts):
 *   1. POST /api/integrations/tiktok/authorize → { url } (HMAC-signed state)
 *   2. User authorizes at https://www.tiktok.com/v2/auth/authorize/
 *   3. GET  /api/integrations/tiktok/callback?code=…&state=…
 *      → token exchange → identity fetch → encrypted persistence → CONNECTED
 *
 * TikTok Login Kit provides ACCOUNT IDENTITY ONLY (display name, avatar).
 * There is no general DM-sending API; the catalog entry is honest about this.
 * Never log client secrets or tokens.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { encrypt, decrypt } from "@/lib/crypto";

const TIKTOK_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TIKTOK_USERINFO_URL = "https://open.tiktokapis.com/v2/user/info/";
/** Provider-side token revocation (called best-effort on disconnect). */
export const TIKTOK_REVOKE_URL = "https://open.tiktokapis.com/v2/oauth/revoke/";

// Login Kit scope for basic account identity. Nothing broader is requested.
export const TIKTOK_SCOPES = ["user.info.basic"] as const;

const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Bounded time for any single TikTok API call. Timeouts map to
 * retryable TikTokApiError so callers can back off and retry.
 */
export const TIKTOK_HTTP_TIMEOUT_MS = 20_000;

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")
  );
}

/**
 * Nonces of TikTok states already consumed (replay protection — same
 * rationale as meta.ts). In-memory with lazy TTL pruning.
 */
const usedTikTokStateNonces = new Map<string, number>();

function consumeTikTokStateNonce(nonce: string): void {
  const now = Date.now();
  for (const [n, at] of usedTikTokStateNonces) {
    if (now - at > STATE_TTL_MS) usedTikTokStateNonces.delete(n);
  }
  if (usedTikTokStateNonces.has(nonce)) {
    throw new Error("state already used (possible replay)");
  }
  usedTikTokStateNonces.set(nonce, now);
}

/**
 * Test-only: clear the consumed-nonce set (vitest keeps module state per
 * test file).
 */
export function resetUsedTikTokStateNonces(): void {
  usedTikTokStateNonces.clear();
}

export interface TikTokEnv {
  clientKey: string;
  clientSecret: string;
  publicUrl: string;
}

const REQUIRED_ENV: Array<[keyof TikTokEnv, string]> = [
  ["clientKey", "TIKTOK_CLIENT_KEY"],
  ["clientSecret", "TIKTOK_CLIENT_SECRET"],
  ["publicUrl", "APP_PUBLIC_URL"],
];

/** Read required TikTok env vars. Throws a clear Error naming every missing var. */
export function tiktokEnv(): TikTokEnv {
  const values: Record<string, string | undefined> = {
    clientKey: process.env.TIKTOK_CLIENT_KEY,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET,
    publicUrl: process.env.APP_PUBLIC_URL,
  };
  const missing = REQUIRED_ENV.filter(([key]) => !values[key]).map(
    ([, name]) => name
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them before using the TikTok integration.`
    );
  }
  return {
    clientKey: values.clientKey as string,
    clientSecret: values.clientSecret as string,
    publicUrl: (values.publicUrl as string).replace(/\/+$/, ""),
  };
}

/** Redirect target registered in the TikTok app dashboard. */
export function tiktokRedirectUri(): string {
  return `${tiktokEnv().publicUrl}/api/integrations/tiktok/callback`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TikTokApiError extends Error {
  readonly code?: string | number;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, opts?: { code?: string | number; status?: number; retryable?: boolean }) {
    super(message);
    this.name = "TikTokApiError";
    this.code = opts?.code;
    this.status = opts?.status;
    this.retryable = opts?.retryable ?? false;
  }
}

/** Thrown when TikTok reports the token as invalid/expired. */
export class TikTokTokenExpiredError extends TikTokApiError {
  constructor(message = "TikTok token expired") {
    super(message, { retryable: false });
    this.name = "TikTokTokenExpiredError";
  }
}

// ---------------------------------------------------------------------------
// OAuth state (HMAC-signed, 15-minute expiry — mirrors meta.ts)
// ---------------------------------------------------------------------------

export interface TikTokOAuthState {
  workspaceId: string;
  nonce: string;
  ts: number; // unix seconds
}

/** base64url(payload) + "." + hex HMAC-SHA256(payload, TIKTOK_CLIENT_SECRET). */
export function signTikTokState(payload: TikTokOAuthState): string {
  const { clientSecret } = tiktokEnv();
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", clientSecret).update(payloadB64).digest("hex");
  return `${payloadB64}.${sig}`;
}

/** Verify a state string. Throws on bad signature, malformed payload, or expiry. */
export function verifyTikTokState(state: string): TikTokOAuthState {
  const { clientSecret } = tiktokEnv();
  const [payloadB64, sig] = state.split(".");
  if (!payloadB64 || !sig) throw new Error("malformed state");
  const expected = createHmac("sha256", clientSecret).update(payloadB64).digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("bad signature");
  }
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as TikTokOAuthState;
  if (typeof payload.workspaceId !== "string" || typeof payload.ts !== "number") {
    throw new Error("malformed state payload");
  }
  if (Date.now() - payload.ts * 1000 > STATE_TTL_MS) {
    throw new Error("expired state");
  }
  // Single-use: a captured callback URL cannot be replayed.
  consumeTikTokStateNonce(payload.nonce);
  return payload;
}

/** TikTok Login Kit authorization URL. */
export function buildTikTokAuthorizeUrl(workspaceId: string): string {
  const env = tiktokEnv();
  const state = signTikTokState({
    workspaceId,
    nonce: randomBytes(16).toString("hex"),
    ts: Math.floor(Date.now() / 1000),
  });
  const url = new URL(TIKTOK_AUTH_URL);
  url.searchParams.set("client_key", env.clientKey);
  url.searchParams.set("scope", TIKTOK_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", tiktokRedirectUri());
  url.searchParams.set("state", state);
  return url.toString();
}

// ---------------------------------------------------------------------------
// HTTP helpers (mocked in tests; never log secrets)
// ---------------------------------------------------------------------------

interface TikTokErrorBody {
  error?: string;
  error_description?: string;
  log_id?: string;
}

function throwForTikTokError(body: TikTokErrorBody, status: number): never {
  // Map well-known TikTok error codes to typed errors. Never include secrets.
  const code = body.error ?? "";
  const desc = body.error_description ?? "TikTok API request failed";
  if (/invalid_grant|invalid_token|expired/i.test(`${code} ${desc}`)) {
    throw new TikTokTokenExpiredError(desc);
  }
  if (status === 429) {
    throw new TikTokApiError(desc, { code, status, retryable: true });
  }
  throw new TikTokApiError(desc, { code, status });
}

async function postForm(url: string, form: Record<string, string>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIKTOK_HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    if (isAbortError(e)) {
      throw new TikTokApiError(
        `TikTok API request timed out after ${TIKTOK_HTTP_TIMEOUT_MS / 1000}s`,
        { retryable: true }
      );
    }
    throw e;
  }
  const data = (await res.json()) as TikTokErrorBody & Record<string, unknown>;
  if (!res.ok || data.error) throwForTikTokError(data, res.status);
  return data;
}

export interface TikTokTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  open_id: string;
  scope: string;
  token_type: string;
}

/** Exchange an authorization code for tokens. */
export async function exchangeTikTokCode(
  code: string,
  redirectUri: string
): Promise<TikTokTokenResponse> {
  const env = tiktokEnv();
  const data = await postForm(TIKTOK_TOKEN_URL, {
    client_key: env.clientKey,
    client_secret: env.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (!data.access_token || !data.open_id) {
    throw new TikTokApiError("TikTok token exchange returned an incomplete response");
  }
  return data as TikTokTokenResponse;
}

/** Refresh an expired access token. */
export async function refreshTikTokToken(refreshToken: string): Promise<TikTokTokenResponse> {
  const env = tiktokEnv();
  const data = await postForm(TIKTOK_TOKEN_URL, {
    client_key: env.clientKey,
    client_secret: env.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (!data.access_token) {
    throw new TikTokApiError("TikTok token refresh returned an incomplete response");
  }
  return data as TikTokTokenResponse;
}

export interface TikTokUserInfo {
  openId: string;
  unionId?: string;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
}

/**
 * Fetch the connected account's identity. Uses ONLY the documented
 * user.info.basic fields — never guessed or placeholder data.
 */
export async function getTikTokUserInfo(accessToken: string): Promise<TikTokUserInfo> {
  const url = new URL(TIKTOK_USERINFO_URL);
  url.searchParams.set("fields", "open_id,union_id,avatar_url,display_name,username");
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIKTOK_HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    if (isAbortError(e)) {
      throw new TikTokApiError(
        `TikTok API request timed out after ${TIKTOK_HTTP_TIMEOUT_MS / 1000}s`,
        { retryable: true }
      );
    }
    throw e;
  }
  const data = (await res.json()) as {
    error?: { code?: string; message?: string };
    data?: {
      user?: {
        open_id?: string;
        union_id?: string;
        display_name?: string;
        username?: string;
        avatar_url?: string;
      };
    };
  };
  if (!res.ok || data.error) {
    const msg = data.error?.message ?? "TikTok user info request failed";
    const code = data.error?.code ?? "";
    if (/invalid|expired|revoked/i.test(`${code} ${msg}`)) {
      throw new TikTokTokenExpiredError(msg);
    }
    throw new TikTokApiError(msg, { code, status: res.status });
  }
  const user = data.data?.user;
  if (!user?.open_id) {
    throw new TikTokApiError("TikTok user info response missing open_id");
  }
  return {
    openId: user.open_id,
    unionId: user.union_id,
    displayName: user.display_name,
    username: user.username,
    avatarUrl: user.avatar_url,
  };
}

// ---------------------------------------------------------------------------
// Credential storage (AES-256-GCM via @/lib/crypto — never plaintext)
// ---------------------------------------------------------------------------

export interface TikTokCredentials {
  provider: "tiktok";
  accessToken: string;
  refreshToken: string;
  expiresAt: string | null; // ISO
  openId: string;
}

export function encryptTikTokCredentials(c: TikTokCredentials): string {
  return encrypt(JSON.stringify(c));
}

export function decryptTikTokCredentials(payload: string): TikTokCredentials {
  const c = JSON.parse(decrypt(payload)) as TikTokCredentials;
  if (c.provider !== "tiktok" || !c.accessToken || !c.openId) {
    throw new Error("Not TikTok credentials");
  }
  return c;
}

/**
 * Return a usable access token, refreshing when within 1 hour of expiry.
 * Returns { token, refreshed, newExpiresAt }.
 */
export async function getValidTikTokToken(
  creds: TikTokCredentials
): Promise<{ token: string; refreshed: boolean; newExpiresAt: string | null; newRefreshToken?: string }> {
  const expiresAt = creds.expiresAt ? new Date(creds.expiresAt).getTime() : 0;
  const needsRefresh = !creds.expiresAt || expiresAt - Date.now() < 60 * 60 * 1000;
  if (!needsRefresh) return { token: creds.accessToken, refreshed: false, newExpiresAt: creds.expiresAt };
  if (!creds.refreshToken) throw new TikTokTokenExpiredError("No refresh token stored — please reconnect");
  const fresh = await refreshTikTokToken(creds.refreshToken);
  const newExpiresAt =
    typeof fresh.expires_in === "number"
      ? new Date(Date.now() + fresh.expires_in * 1000).toISOString()
      : null;
  return {
    token: fresh.access_token,
    refreshed: true,
    newExpiresAt,
    newRefreshToken: fresh.refresh_token,
  };
}
