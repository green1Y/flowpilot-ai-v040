/**
 * Instagram Business Login (Instagram API with Instagram Login) — the
 * current Meta flow for connecting Instagram Professional accounts WITHOUT
 * requiring a linked Facebook Page.
 *
 * This is intentionally SEPARATE from the Facebook Login flow in meta.ts
 * (used by Facebook Messenger + WhatsApp + legacy Instagram connections).
 * The two flows use different authorization hosts, token endpoints, scopes,
 * and Graph API hosts — they must not share endpoint logic.
 *
 * Flow (per Meta's Business Login documentation):
 *  1. Authorize:  https://www.instagram.com/oauth/authorize
 *                  ?client_id=...&redirect_uri=...&response_type=code
 *                  &scope=instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments
 *                  &state=...
 *  2. Exchange:   POST https://api.instagram.com/oauth/access_token
 *                  (form: client_id, client_secret, grant_type=authorization_code,
 *                   redirect_uri, code)
 *                  → { data: [{ access_token, user_id, permissions }] }
 *                  (short-lived, ~1 hour)
 *  3. Long-lived: GET https://graph.instagram.com/access_token
 *                  ?grant_type=ig_exchange_token&client_secret=...&access_token=...
 *                  → { access_token, token_type, expires_in } (~60 days)
 *  4. Refresh:    GET https://graph.instagram.com/refresh_access_token
 *                  ?grant_type=ig_refresh_token&access_token=...
 *  5. Graph API:  https://graph.instagram.com/{version}/me?fields=...
 *                  (Bearer token)
 *
 * The OAuth `redirect_uri` is the SAME callback as Facebook Login
 * (/api/integrations/meta/callback) — the signed `state` carries the
 * provider, so the callback branches correctly. The URL must be whitelisted
 * in the Meta dashboard under the Instagram product's Business Login
 * settings.
 *
 * Security: tokens are never logged; they are passed only to Meta.
 * Reuses signState/verifyState/metaEnv/verifyMetaSignature from meta.ts.
 */

import { randomBytes } from "crypto";
import {
  metaEnv,
  signState,
  verifyMetaSignature,
  MetaApiError,
  MetaTokenExpiredError,
  MetaRetryableError,
  GRAPH_VERSION,
  HTTP_TIMEOUT_MS,
} from "./meta";

export const INSTAGRAM_LOGIN_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
] as const;

const IG_AUTH_HOST = "https://www.instagram.com";
const IG_TOKEN_HOST = "https://api.instagram.com";
const IG_GRAPH_HOST = "https://graph.instagram.com";

/**
 * Instagram Business Login credentials — STRICT, no fallback.
 *
 * The Instagram App ID/Secret are DIFFERENT identifiers from the Facebook
 * App ID/Secret (Meta App Dashboard > Instagram > API setup with Instagram
 * login > Business login settings). Falling back to the Facebook App ID
 * produces Meta's cryptic "Invalid platform app" error, so a missing value
 * fails fast here with an actionable message instead of a bad API call.
 */
export interface InstagramLoginEnv {
  appId: string;
  appSecret: string;
}

export function instagramLoginEnv(): InstagramLoginEnv {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const missing: string[] = [];
  if (!appId) missing.push("INSTAGRAM_APP_ID");
  if (!appSecret) missing.push("INSTAGRAM_APP_SECRET");
  if (missing.length > 0) {
    throw new Error(
      `Instagram Business Login is not configured: missing ${missing.join(", ")}. ` +
        `Set them to your Instagram App ID/Secret from the Meta App Dashboard > ` +
        `Instagram > API setup with Instagram login > Business login settings. ` +
        `These differ from your Facebook App ID — using the Facebook App ID ` +
        `causes Meta's "Invalid platform app" error.`
    );
  }
  return { appId: appId as string, appSecret: appSecret as string };
}

/** Redirect target for the Instagram Business Login authorization step. */
export function instagramLoginCallbackUrl(): string {
  return `${metaEnv().publicUrl}/api/integrations/meta/callback`;
}

/** Build the Instagram Business Login authorization URL (step 1). */
export function buildInstagramLoginUrl(workspaceId: string): string {
  const igEnv = instagramLoginEnv();
  const state = signState({
    workspaceId,
    provider: "instagram",
    nonce: randomBytes(16).toString("hex"),
    ts: Math.floor(Date.now() / 1000),
  });
  const url = new URL(`${IG_AUTH_HOST}/oauth/authorize`);
  // Instagram App ID — never the Facebook App ID.
  url.searchParams.set("client_id", igEnv.appId);
  url.searchParams.set("redirect_uri", instagramLoginCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", [...INSTAGRAM_LOGIN_SCOPES].join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

interface InstagramErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number };
  // Token-exchange failures use the OAuthException shape instead.
  error_type?: string;
  code?: number;
  error_message?: string;
}

/** Map an Instagram API error payload to a typed error. Never throws raw. */
function toInstagramError(body: InstagramErrorBody, status: number): MetaApiError {
  const err = body?.error;
  const code =
    typeof err?.code === "number"
      ? err.code
      : typeof body?.code === "number"
        ? body.code
        : 0;
  const message =
    err?.message || body?.error_message || `Instagram API error (HTTP ${status})`;
  if (code === 190) return new MetaTokenExpiredError(message);
  if (status === 429 || code === 80007) return new MetaRetryableError(message);
  return new MetaApiError(message, status);
}

/**
 * Sanitize a Meta API response for server-side diagnostic logging.
 * Redacts anything that looks like a secret (tokens, secrets, codes) and
 * truncates — safe to log, never contains credentials.
 */
export function sanitizeMetaResponseForLog(body: unknown): string {
  let text: string;
  try {
    text = typeof body === "string" ? body : JSON.stringify(body);
  } catch {
    text = "[unserializable response]";
  }
  // Redact secret-bearing fields (case-insensitive) before truncating.
  const redacted = text.replace(
    /("(?:access_token|client_secret|code|refresh_token)"\s*:\s*")[^"]*(")/gi,
    "$1[redacted]$2"
  );
  return redacted.length > 500 ? redacted.slice(0, 500) + "…[truncated]" : redacted;
}

async function igFetch<T>(url: string, init?: RequestInit): Promise<T> {
  // Strip query params from the logged URL — tokens travel in them.
  const logUrl = url.split("?")[0];
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
      throw new MetaRetryableError(
        `Instagram API request timed out after ${HTTP_TIMEOUT_MS / 1000}s`
      );
    }
    throw new MetaRetryableError(
      `Instagram API unreachable: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  let body: any = null;
  let rawText: string | null = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON 2xx (e.g. an HTML error page) — capture text for diagnostics.
    try {
      rawText = await res.text();
    } catch {
      rawText = null;
    }
    body = null;
  }
  if (!res.ok) {
    const detail = sanitizeMetaResponseForLog(body ?? rawText ?? "");
    console.warn(
      `[instagram-login] ${logUrl} → HTTP ${res.status}: ${detail}`
    );
    throw toInstagramError(body ?? {}, res.status);
  }
  if (body === null && rawText !== null) {
    // 2xx but not JSON — log a sanitized preview so the real cause is visible.
    console.warn(
      `[instagram-login] ${logUrl} → HTTP ${res.status} with non-JSON body: ${sanitizeMetaResponseForLog(rawText)}`
    );
  }
  return body as T;
}

export interface InstagramLoginTokenData {
  access_token: string;
  user_id: string;
  permissions?: string;
}

export interface InstagramLoginTokenResponse {
  data: InstagramLoginTokenData[];
}

/**
 * Exchange the OAuth `code` for a short-lived (~1h) Instagram user token
 * (step 2). Meta documents the response wrapped in a `data` array, but the
 * parser also accepts a top-level object — both shapes have been observed.
 */
export async function exchangeInstagramCode(
  code: string,
  redirectUri: string
): Promise<InstagramLoginTokenData> {
  const igEnv = instagramLoginEnv();
  const form = new URLSearchParams({
    client_id: igEnv.appId,
    client_secret: igEnv.appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const data = await igFetch<InstagramLoginTokenResponse>(
    `${IG_TOKEN_HOST}/oauth/access_token`,
    { method: "POST", body: form }
  );
  // Documented shape: { data: [{ access_token, user_id, ... }] }.
  // Tolerated shape: { access_token, user_id, ... } at top level.
  const first: InstagramLoginTokenData | undefined =
    data?.data?.[0] ??
    (typeof (data as any)?.access_token === "string"
      ? (data as unknown as InstagramLoginTokenData)
      : undefined);
  if (!first || typeof first.access_token !== "string" || !first.access_token) {
    console.warn(
      `[instagram-login] token exchange returned HTTP 200 without access_token: ${sanitizeMetaResponseForLog(data)}`
    );
    throw new MetaApiError("Instagram token exchange returned no access_token");
  }
  if (!first.user_id) {
    console.warn(
      `[instagram-login] token exchange returned HTTP 200 without user_id: ${sanitizeMetaResponseForLog(data)}`
    );
    throw new MetaApiError("Instagram token exchange returned no user_id");
  }
  return first;
}

export interface InstagramLongLivedToken {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

/** Exchange a short-lived token for a long-lived (~60 day) token (step 3). */
export async function exchangeInstagramLongLived(
  shortToken: string
): Promise<InstagramLongLivedToken> {
  const igEnv = instagramLoginEnv();
  const url = new URL(`${IG_GRAPH_HOST}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", igEnv.appSecret);
  url.searchParams.set("access_token", shortToken);
  const data = await igFetch<InstagramLongLivedToken>(url.toString());
  if (!data || typeof data.access_token !== "string" || !data.access_token) {
    throw new MetaApiError("Instagram long-lived exchange returned no access_token");
  }
  return data;
}

/** Refresh a long-lived Instagram token before its 60-day expiry (step 4). */
export async function refreshInstagramToken(
  token: string
): Promise<InstagramLongLivedToken> {
  const url = new URL(`${IG_GRAPH_HOST}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);
  const data = await igFetch<InstagramLongLivedToken>(url.toString());
  if (!data || typeof data.access_token !== "string" || !data.access_token) {
    throw new MetaApiError("Instagram token refresh returned no access_token");
  }
  return data;
}

export interface InstagramLoginUser {
  id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
}

/** Fetch the connected Instagram Professional account's identity (step 5). */
export async function getInstagramLoginUser(
  token: string
): Promise<InstagramLoginUser> {
  const url = new URL(`${IG_GRAPH_HOST}/${GRAPH_VERSION}/me`);
  url.searchParams.set("fields", "id,username,name,profile_picture_url");
  url.searchParams.set("access_token", token);
  const data = await igFetch<InstagramLoginUser>(url.toString());
  if (!data || !data.id) {
    throw new MetaApiError("Instagram identity lookup returned no user");
  }
  return data;
}

/** Authenticated GET against graph.instagram.com (versioned). */
export async function igGraph<T = unknown>(
  path: string,
  token: string,
  opts: { method?: string; body?: unknown; searchParams?: Record<string, string> } = {}
): Promise<T> {
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${IG_GRAPH_HOST}/${GRAPH_VERSION}${p}`);
  if (opts.searchParams) {
    for (const [k, v] of Object.entries(opts.searchParams)) {
      url.searchParams.set(k, v);
    }
  }
  url.searchParams.set("access_token", token);
  const init: RequestInit = { method: (opts.method || "GET").toUpperCase() };
  if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  return igFetch<T>(url.toString(), init);
}

/** Webhook signature verification — same app secret as Facebook Login. */
export function verifyInstagramLoginSignature(
  rawBody: string,
  signature: string
): boolean {
  return verifyMetaSignature(rawBody, signature);
}

/**
 * Subscribe an Instagram Professional account to webhook fields (messages,
 * comments). Per Meta docs this is per-account:
 *   POST https://graph.instagram.com/{version}/{ig-user-id}/subscribed_apps
 *   ?subscribed_fields=messages,comments&access_token=...
 * Best-effort: throws on failure — callers decide whether to block.
 */
export async function subscribeInstagramWebhooks(
  igUserId: string,
  token: string,
  fields: string[] = ["messages", "comments"]
): Promise<boolean> {
  const url = new URL(`${IG_GRAPH_HOST}/${GRAPH_VERSION}/${igUserId}/subscribed_apps`);
  url.searchParams.set("subscribed_fields", fields.join(","));
  url.searchParams.set("access_token", token);
  const data = await igFetch<{ success?: boolean }>(url.toString(), {
    method: "POST",
  });
  return data?.success === true;
}
