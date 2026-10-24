import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { siteUrl } from "../site-url";

/**
 * HMAC-signed unsubscribe tokens (Wave 2E).
 *
 * A token is `base64url(payloadJson).base64url(hmacSha256(payload))` where
 * the payload is { workspaceId, contactId, channel: "email" }. No token
 * state is stored server-side: verification recomputes the HMAC, so a
 * token stays valid as long as ENCRYPTION_KEY is unchanged.
 *
 * Signing key: ENCRYPTION_KEY (the same secret the credential store uses —
 * no new env var is introduced). A 64-hex value is used as raw bytes;
 * any other set value is SHA-256-derived so tokens survive restarts.
 * When unset outside production, a process-ephemeral key is used (tokens
 * then validate only within this process lifetime); production refuses
 * to sign without a key, matching the fail-closed rule in lib/crypto.ts.
 *
 * There is deliberately NO expiry on these tokens: an unsubscribe link
 * in an old email must still work when the recipient finally opens it.
 * The blast radius of a leaked token is a single contact's email
 * suppression — the token grants nothing else.
 */

export const UNSUBSCRIBE_CHANNEL = "email" as const;

export interface UnsubscribePayload {
  workspaceId: string;
  contactId: string;
  channel: typeof UNSUBSCRIBE_CHANNEL;
}

function getSigningKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[security] ENCRYPTION_KEY is not set — refusing to sign unsubscribe tokens in production"
    );
  }
  if (raw) return createHash("sha256").update(raw, "utf8").digest();
  const g = globalThis as unknown as { __fpUnsubKey?: Buffer };
  if (!g.__fpUnsubKey) g.__fpUnsubKey = randomBytes(32);
  return g.__fpUnsubKey;
}

function b64urlEncode(input: string | Buffer): string {
  return Buffer.isBuffer(input)
    ? input.toString("base64url")
    : Buffer.from(input, "utf8").toString("base64url");
}

/** Create a signed unsubscribe token for one (workspace, contact) pair. */
export function createUnsubscribeToken(
  workspaceId: string,
  contactId: string
): string {
  const payload: UnsubscribePayload = {
    workspaceId,
    contactId,
    channel: UNSUBSCRIBE_CHANNEL,
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", getSigningKey()).update(encoded).digest();
  return `${encoded}.${b64urlEncode(sig)}`;
}

/**
 * Verify a token. Returns the payload, or null for ANY invalid input
 * (malformed, bad signature, wrong channel, wrong types). Never throws
 * on attacker-controlled input, and never reveals why verification failed
 * — the route maps null to a single generic 400.
 */
export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  try {
    if (typeof token !== "string" || !token) return null;
    const [encoded, sig] = token.split(".");
    if (!encoded || !sig || token.split(".").length !== 2) return null;
    const expected = createHmac("sha256", getSigningKey()).update(encoded).digest();
    const actual = Buffer.from(sig, "base64url");
    if (actual.length !== expected.length) return null;
    // Length guard above keeps timingSafeEqual safe; re-check explicitly.
    if (!timingSafeEqual(actual, expected)) return null;
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (
      typeof p.workspaceId !== "string" ||
      !p.workspaceId ||
      typeof p.contactId !== "string" ||
      !p.contactId ||
      p.channel !== UNSUBSCRIBE_CHANNEL
    ) {
      return null;
    }
    return {
      workspaceId: p.workspaceId,
      contactId: p.contactId,
      channel: UNSUBSCRIBE_CHANNEL,
    };
  } catch {
    return null;
  }
}

/** Full unsubscribe URL for a contact (base defaults to the public site URL). */
export function unsubscribeUrl(
  workspaceId: string,
  contactId: string,
  baseUrl: string = siteUrl()
): string {
  const token = createUnsubscribeToken(workspaceId, contactId);
  return `${baseUrl.replace(/\/+$/, "")}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}
