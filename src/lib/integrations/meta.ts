/**
 * Meta (Facebook / Instagram / WhatsApp) API core library.
 *
 * Capability-honest: every network call below talks to the real Meta Graph
 * API. No mocked "connected" state, no invented sends. Callers must surface
 * real connection states (per the ChannelAdapter contract in adapter.ts).
 *
 * Security notes:
 * - Access tokens are NEVER logged here. Do not add logging that prints them.
 * - No secrets are hardcoded; everything comes from env (see metaEnv()).
 * - Credentials at rest are AES-256-GCM encrypted via ../crypto.
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { decrypt, encrypt } from "../crypto";

// ---------------------------------------------------------------------------
// Constants & env
// ---------------------------------------------------------------------------

/** Graph API version; overridable via META_GRAPH_VERSION (e.g. "v22.0"). */
export const GRAPH_VERSION: string = process.env.META_GRAPH_VERSION || "v21.0";

export const GRAPH_BASE = "https://graph.facebook.com";

export interface MetaEnv {
  appId: string;
  appSecret: string;
  verifyToken: string;
  publicUrl: string;
}

const REQUIRED_ENV: Array<[keyof MetaEnv, string]> = [
  ["appId", "META_APP_ID"],
  ["appSecret", "META_APP_SECRET"],
  ["verifyToken", "META_VERIFY_TOKEN"],
  ["publicUrl", "APP_PUBLIC_URL"],
];

/**
 * Read required Meta env vars. Throws a clear Error naming every missing var.
 */
export function metaEnv(): MetaEnv {
  const values: Record<string, string | undefined> = {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    verifyToken: process.env.META_VERIFY_TOKEN,
    publicUrl: process.env.APP_PUBLIC_URL,
  };
  const missing = REQUIRED_ENV.filter(([key]) => !values[key]).map(
    ([, name]) => name
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them before using Meta integrations.`
    );
  }
  return {
    appId: values.appId as string,
    appSecret: values.appSecret as string,
    verifyToken: values.verifyToken as string,
    publicUrl: (values.publicUrl as string).replace(/\/+$/, ""),
  };
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class MetaApiError extends Error {
  readonly code?: number;
  readonly status?: number;
  constructor(message: string, code?: number, status?: number) {
    super(message);
    this.name = "MetaApiError";
    this.code = code;
    this.status = status;
  }
}

/** Meta error code 190: the access token is expired/invalid. */
export class MetaTokenExpiredError extends MetaApiError {
  constructor(message = "Meta access token is expired or invalid", status?: number) {
    super(message, 190, status);
    this.name = "MetaTokenExpiredError";
  }
}

/**
 * Meta error codes that mean a granted permission was revoked or never
 * granted: 10 (permission denied), 200 (permission error), 298 (invalid
 * permission). When a live call fails with one of these, the connection
 * state must become "permission_missing" — never a silent green CONNECTED.
 */
export const META_PERMISSION_ERROR_CODES = new Set([10, 200, 298]);

export function isMetaPermissionError(e: MetaApiError): boolean {
  return typeof e.code === "number" && META_PERMISSION_ERROR_CODES.has(e.code);
}

/** HTTP 429 or Meta rate-limit codes 80007 / 130429: safe to retry w/ backoff. */
export class MetaRetryableError extends MetaApiError {
  constructor(message: string, code?: number, status?: number) {
    super(message, code, status);
    this.name = "MetaRetryableError";
  }
}

interface MetaGraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
}

function toMetaError(err: MetaGraphErrorBody, status: number): MetaApiError {
  const message =
    typeof err.message === "string" && err.message.length > 0
      ? err.message
      : `Meta API request failed (HTTP ${status})`;
  const code = typeof err.code === "number" ? err.code : undefined;
  if (code === 190) return new MetaTokenExpiredError(message, status);
  if (status === 429 || code === 80007 || code === 130429) {
    return new MetaRetryableError(message, code, status);
  }
  return new MetaApiError(message, code, status);
}

// ---------------------------------------------------------------------------
// graph(): fetch wrapper
// ---------------------------------------------------------------------------

/**
 * Bounded time for any single provider API call. A hung Meta API must not
 * hang a request handler or background worker indefinitely; timeouts are
 * mapped to MetaRetryableError so callers can retry with backoff.
 */
export const HTTP_TIMEOUT_MS = 20_000;

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")
  );
}

export interface GraphOptions {
  /** Page/user token → sent as ?access_token= ; use bearer:true for WhatsApp. */
  token?: string;
  /** When true, token is sent as Authorization: Bearer (WhatsApp Cloud API). */
  bearer?: boolean;
  method?: string;
  body?: Record<string, unknown> | URLSearchParams;
  searchParams?: Record<string, string | number | boolean | undefined>;
}

/**
 * Call the Meta Graph API. `path` is like "/me" (version is prepended).
 * Throws MetaTokenExpiredError / MetaRetryableError / MetaApiError on
 * `data.error`, per the typed-error rules above. Never logs tokens.
 */
export async function graph<T = unknown>(
  path: string,
  opts: GraphOptions = {}
): Promise<T> {
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${GRAPH_BASE}/${GRAPH_VERSION}${p}`);

  if (opts.searchParams) {
    for (const [k, v] of Object.entries(opts.searchParams)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  if (opts.token && !opts.bearer) {
    url.searchParams.set("access_token", opts.token);
  }

  const method = (opts.method || "GET").toUpperCase();
  const headers: Record<string, string> = {};
  let body: string | URLSearchParams | undefined;
  if (opts.bearer && opts.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }
  if (opts.body !== undefined) {
    if (opts.body instanceof URLSearchParams) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = opts.body;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    if (isAbortError(e)) {
      throw new MetaRetryableError(
        `Meta API request timed out after ${HTTP_TIMEOUT_MS / 1000}s (${method} ${p})`
      );
    }
    const reason = e instanceof Error ? e.message : String(e);
    throw new MetaApiError(`Meta API request failed: network error (${reason})`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new MetaApiError(
      `Meta API returned a non-JSON response (HTTP ${res.status})`,
      undefined,
      res.status
    );
  }

  if (
    data !== null &&
    typeof data === "object" &&
    "error" in data &&
    (data as { error?: unknown }).error !== null &&
    typeof (data as { error?: unknown }).error === "object"
  ) {
    throw toMetaError(
      (data as { error: MetaGraphErrorBody }).error,
      res.status
    );
  }

  if (!res.ok) {
    throw new MetaApiError(
      `Meta API request failed: ${method} ${p} → HTTP ${res.status}`,
      undefined,
      res.status
    );
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Credentials (encrypted at rest)
// ---------------------------------------------------------------------------

export type MetaProvider = "instagram" | "facebook" | "whatsapp";

export interface MetaCredentials {
  provider: MetaProvider;
  accessToken: string;
  expiresAt: string | null;
  /**
   * Which OAuth flow produced this credential set.
   * - "facebook_login": Facebook Login via www.facebook.com (Facebook
   *   Messenger, WhatsApp, and legacy Instagram Page-linked connections).
   * - "instagram_login": Instagram Business Login via www.instagram.com
   *   (direct IG Professional account, no Facebook Page required).
   * Absent = "facebook_login" (backwards compatible with stored rows).
   */
  loginType?: "facebook_login" | "instagram_login";
  pageId?: string;
  pageName?: string;
  pageAccessToken?: string;
  igUserId?: string;
  igUsername?: string;
  wabaId?: string;
  phoneNumberId?: string;
  phoneDisplayName?: string;
  metaUserId?: string;
  metaUserName?: string;
}

/** Serialize + AES-256-GCM encrypt credentials for storage. */
export function encryptCredentials(c: MetaCredentials): string {
  return encrypt(JSON.stringify(c));
}

/** Decrypt + parse credentials. Throws on tampering or malformed payload. */
export function decryptCredentials(s: string): MetaCredentials {
  return JSON.parse(decrypt(s)) as MetaCredentials;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * OAuth scopes per provider for the **Facebook Login** flow
 * (`https://www.facebook.com/<version>/dialog/oauth`).
 *
 * Instagram no longer uses this flow — it uses Instagram Business Login
 * (see INSTAGRAM_LOGIN_SCOPES in instagram-login.ts). The instagram entry
 * below is retained only for backwards compatibility with
 * buildAuthorizeUrl's signature and is never requested for new connections.
 *
 * Kept minimal: only permissions the app's actual features need.
 * - facebook (Messenger): `pages_messaging` (send/receive), `pages_show_list`
 *   (list Pages for selection), `pages_read_engagement` (read Page metadata).
 * - whatsapp: `whatsapp_business_messaging` + `whatsapp_business_management`.
 */
export const OAUTH_SCOPES: Record<MetaProvider, string[]> = {
  facebook: ["pages_messaging", "pages_show_list", "pages_read_engagement"],
  // Legacy — Instagram now uses Business Login (INSTAGRAM_LOGIN_SCOPES).
  // Retained so the Record type stays total; never requested for new flows.
  instagram: [],
  whatsapp: ["whatsapp_business_messaging", "whatsapp_business_management"],
};

export interface MetaOAuthState {
  workspaceId: string;
  provider: MetaProvider;
  nonce: string;
  ts: number; // unix seconds
}

const STATE_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Single-use OAuth state (replay protection)
// ---------------------------------------------------------------------------

/**
 * Nonces of states already consumed, mapped to the unix-ms time they were
 * consumed. In-memory: a restart clears it, which is acceptable because
 * outstanding states expire after 15 minutes anyway. Entries are pruned
 * lazily past STATE_TTL_MS, so the set stays tiny.
 *
 * Defense in depth: Meta authorization codes are themselves single-use,
 * but a captured callback URL should not be replayable even inside the
 * 15-minute state window.
 */
const usedStateNonces = new Map<string, number>();

/**
 * Throw if `nonce` was already consumed (a replayed callback URL),
 * otherwise record it. Call only AFTER the state passed signature and
 * expiry checks.
 */
function consumeStateNonce(nonce: string): void {
  const now = Date.now();
  for (const [n, at] of usedStateNonces) {
    if (now - at > STATE_TTL_MS) usedStateNonces.delete(n);
  }
  if (usedStateNonces.has(nonce)) {
    throw new Error("Invalid OAuth state: already used (possible replay)");
  }
  usedStateNonces.set(nonce, now);
}

/**
 * Test-only: clear the consumed-nonce set. Vitest keeps module state for
 * the whole test file, so tests that verify states must reset between
 * cases that reuse a fixed nonce.
 */
export function resetUsedStateNonces(): void {
  usedStateNonces.clear();
}

/** base64url(payload) + "." + hex HMAC-SHA256(payload, META_APP_SECRET). */
export function signState(payload: MetaOAuthState): string {
  const { appSecret } = metaEnv();
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const sig = createHmac("sha256", appSecret).update(payloadB64).digest("hex");
  return `${payloadB64}.${sig}`;
}

/**
 * Verify an OAuth state string. Throws if the signature is invalid,
 * the payload is malformed, or `ts` is older than 15 minutes.
 */
export function verifyState(state: string): MetaOAuthState {
  const { appSecret } = metaEnv();
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Invalid OAuth state: malformed");
  }
  const [payloadB64, sigHex] = parts as [string, string];
  const expected = createHmac("sha256", appSecret)
    .update(payloadB64)
    .digest("hex");
  const a = Buffer.from(sigHex, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid OAuth state: bad signature");
  }
  let payload: MetaOAuthState;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as MetaOAuthState;
  } catch {
    throw new Error("Invalid OAuth state: malformed payload");
  }
  if (
    !payload ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.provider !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.ts !== "number"
  ) {
    throw new Error("Invalid OAuth state: malformed payload");
  }
  if (Date.now() - payload.ts * 1000 > STATE_TTL_MS) {
    throw new Error("Invalid OAuth state: expired (older than 15 minutes)");
  }
  // Single-use: a captured callback URL cannot be replayed.
  consumeStateNonce(payload.nonce);
  return payload;
}

/** Facebook OAuth dialog URL; `state` is HMAC-signed and binds workspace+provider. */
/**
 * Build the Facebook Login authorization URL.
 * Instagram uses buildInstagramLoginUrl() instead — the flows are not
 * interchangeable.
 */
export function buildAuthorizeUrl(
  provider: "facebook" | "whatsapp",
  workspaceId: string
): string {
  const env = metaEnv();
  const state = signState({
    workspaceId,
    provider,
    nonce: randomBytes(16).toString("hex"),
    ts: Math.floor(Date.now() / 1000),
  });
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", env.appId);
  url.searchParams.set(
    "redirect_uri",
    `${env.publicUrl}/api/integrations/meta/callback`
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPES[provider].join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token flow
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
}

/** Exchange the OAuth `code` for a short-lived user token (form-encoded POST). */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  const env = metaEnv();
  const form = new URLSearchParams({
    client_id: env.appId,
    client_secret: env.appSecret,
    redirect_uri: redirectUri,
    code,
  });
  const data = await graph<TokenResponse>("/oauth/access_token", {
    method: "POST",
    body: form,
  });
  if (!data || typeof data.access_token !== "string" || !data.access_token) {
    throw new MetaApiError("Token exchange returned no access_token");
  }
  return data;
}

/** Exchange a short-lived token for a long-lived (~60 day) user token. */
export async function exchangeForLongLived(
  shortToken: string
): Promise<TokenResponse> {
  const env = metaEnv();
  const data = await graph<TokenResponse>("/oauth/access_token", {
    searchParams: {
      grant_type: "fb_exchange_token",
      client_id: env.appId,
      client_secret: env.appSecret,
      fb_exchange_token: shortToken,
    },
  });
  if (!data || typeof data.access_token !== "string" || !data.access_token) {
    throw new MetaApiError("Token exchange returned no access_token");
  }
  return data;
}

/** Refresh a long-lived token (same endpoint as exchangeForLongLived). */
export async function refreshLongLived(
  token: string
): Promise<TokenResponse> {
  return exchangeForLongLived(token);
}

/** Only user tokens (facebook/instagram via Facebook Login) support fb_exchange_token refresh. */
export function canRefreshToken(provider: MetaProvider): boolean {
  return provider === "facebook" || provider === "instagram";
}

const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface ValidToken {
  token: string;
  refreshed: boolean;
  /** ISO expiry after refresh, or the previous expiresAt when not refreshed. */
  newExpiresAt: string | null;
}

/**
 * Return a usable access token. If expiresAt is within 7 days (or past) and
 * the provider's token is refreshable, refresh it and report the new expiry.
 * Never throws on missing env without a clear message (via metaEnv()).
 */
export async function getValidAccessToken(
  creds: MetaCredentials
): Promise<ValidToken> {
  const expiresMs = creds.expiresAt ? Date.parse(creds.expiresAt) : NaN;
  const needsRefresh =
    canRefreshToken(creds.provider) &&
    !Number.isNaN(expiresMs) &&
    Date.now() >= expiresMs - REFRESH_WINDOW_MS;

  if (!needsRefresh) {
    return {
      token: creds.accessToken,
      refreshed: false,
      newExpiresAt: creds.expiresAt,
    };
  }

  // Instagram Business Login tokens refresh via graph.instagram.com
  // (ig_refresh_token grant) — not the Facebook fb_exchange_token flow.
  // Dynamic import avoids a hard dependency cycle (instagram-login imports
  // shared helpers from this module).
  if (creds.provider === "instagram" && creds.loginType === "instagram_login") {
    const { refreshInstagramToken } = await import("./instagram-login");
    const res = await refreshInstagramToken(creds.accessToken);
    const newExpiresAt =
      typeof res.expires_in === "number"
        ? new Date(Date.now() + res.expires_in * 1000).toISOString()
        : creds.expiresAt;
    return { token: res.access_token, refreshed: true, newExpiresAt };
  }

  const res = await refreshLongLived(creds.accessToken);
  const newExpiresAt =
    typeof res.expires_in === "number"
      ? new Date(Date.now() + res.expires_in * 1000).toISOString()
      : creds.expiresAt;
  return { token: res.access_token, refreshed: true, newExpiresAt };
}

// ---------------------------------------------------------------------------
// Discovery / verification
// ---------------------------------------------------------------------------

export interface MetaUser {
  id: string;
  name: string;
}

export async function getMe(token: string): Promise<MetaUser> {
  return graph<MetaUser>("/me", {
    token,
    searchParams: { fields: "id,name" },
  });
}

export interface MetaPage {
  id: string;
  name: string;
  access_token?: string;
}

/**
 * Pages the user manages. Page access tokens are returned only when the
 * granted permissions include them (e.g. pages_show_list / pages_messaging).
 */
export async function getPages(userToken: string): Promise<MetaPage[]> {
  const data = await graph<{ data?: MetaPage[] }>("/me/accounts", {
    token: userToken,
    searchParams: { fields: "id,name,access_token" },
  });
  return data.data ?? [];
}

export interface PageToken {
  access_token: string;
  name: string;
}

/** Fetch a single page's access token + name by page ID. */
export async function getPageToken(
  pageId: string,
  userToken: string
): Promise<PageToken> {
  return graph<PageToken>(`/${pageId}`, {
    token: userToken,
    searchParams: { fields: "access_token,name" },
  });
}

export interface InstagramAccount {
  id: string;
  username: string;
}

/** The Instagram Business account linked to a Page, or null if none. */
export async function getInstagramAccount(
  pageId: string,
  pageToken: string
): Promise<InstagramAccount | null> {
  const data = await graph<{
    instagram_business_account?: InstagramAccount;
  }>(`/${pageId}`, {
    token: pageToken,
    searchParams: { fields: "instagram_business_account{id,username}" },
  });
  return data.instagram_business_account ?? null;
}

/** Verify a page token is valid. Throws MetaTokenExpiredError on code 190. */
export async function verifyPage(
  pageId: string,
  pageToken: string
): Promise<{ id: string; name: string }> {
  return graph<{ id: string; name: string }>(`/${pageId}`, {
    token: pageToken,
    searchParams: { fields: "id,name" },
  });
}

export interface PhoneNumberInfo {
  id: string;
  display_phone_number: string;
  verified_name: string;
}

/** WhatsApp phone-number metadata (token sent as Authorization: Bearer). */
export async function getPhoneNumberInfo(
  phoneNumberId: string,
  bearerToken: string
): Promise<PhoneNumberInfo> {
  return graph<PhoneNumberInfo>(`/${phoneNumberId}`, {
    token: bearerToken,
    bearer: true,
    searchParams: {
      fields: "display_phone_number,verified_name,id",
    },
  });
}

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

/**
 * Verify the X-Hub-Signature-256 header of a Meta webhook payload.
 * signatureHeader looks like "sha256=<hex>". Uses timingSafeEqual.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string
): boolean {
  try {
    const { appSecret } = metaEnv();
    if (!signatureHeader.startsWith("sha256=")) return false;
    const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
    const expected = createHmac("sha256", appSecret)
      .update(rawBody, "utf8")
      .digest();
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}
