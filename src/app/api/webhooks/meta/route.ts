import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import {
  metaEnv,
  verifyMetaSignature,
  decryptCredentials,
} from "@/lib/integrations/meta";
import { ingestMetaEvent, seenDeliveryIds } from "@/lib/integrations/ingest";

/**
 * Meta webhook endpoint (Facebook / Instagram / WhatsApp).
 *
 * GET  — verification handshake (hub.mode=subscribe + verify token).
 * POST — event delivery: HMAC signature check, object filter, tenant matching
 *        via Integration.externalAccountId, then ingestMetaEvent().
 *        Answers 200 ONLY when every entry was safely accepted (persisted +
 *        dispatched). A transient ingest/dispatch failure answers 500 so
 *        Meta redelivers — safe because durable dedupe (CustomerEvent) and
 *        dispatch idempotency keys make redelivery exactly-once.
 */

const META_PROVIDERS = ["instagram", "facebook", "whatsapp"];

/** Constant-time string comparison (safe against length-mismatch throws). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const GET = handler(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  const mode = q.get("hub.mode");
  const token = q.get("hub.verify_token") ?? "";
  const challenge = q.get("hub.challenge") ?? "";

  let expected = "";
  try {
    expected = metaEnv().verifyToken;
  } catch (e) {
    console.error("[webhook:meta] Meta env not configured", e);
  }

  if (mode === "subscribe" && expected && safeEqual(token, expected)) {
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  throw err("Webhook verification failed", 403);
});

/**
 * Match an incoming entry to CONNECTED Meta integrations.
 * Candidate ids: entry.id (Page id / IGSID for messaging), plus ids derived
 * from change values (WhatsApp phone_number_id, page_id).
 */
async function matchIntegrations(entry: Record<string, unknown>) {
  const candidates = new Set<string>();
  if (typeof entry.id === "string" && entry.id) candidates.add(entry.id);
  const changes = Array.isArray(entry.changes) ? entry.changes : [];
  for (const rawChange of changes) {
    const value =
      rawChange && typeof rawChange === "object"
        ? (rawChange as Record<string, unknown>).value
        : undefined;
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const metadata = v.metadata as Record<string, unknown> | undefined;
    const pnid = metadata?.phone_number_id;
    if (typeof pnid === "string" && pnid) candidates.add(pnid);
    if (typeof v.page_id === "string" && v.page_id) candidates.add(v.page_id);
  }
  if (candidates.size === 0) return [];

  const direct = await db.integration.findMany({
    where: {
      status: "CONNECTED",
      provider: { in: META_PROVIDERS },
      externalAccountId: { in: [...candidates] },
    },
  });
  if (direct.length > 0) return resolveOwnership(direct, candidates);

  // Fallback: match against page/IG/phone ids stored inside the encrypted
  // credentials. This covers Instagram messaging webhooks, where entry.id is
  // the IGSID while externalAccountId holds the Page id. Best-effort.
  const rows = await db.integration.findMany({
    where: { status: "CONNECTED", provider: { in: META_PROVIDERS } },
  });
  const matched = rows.filter((r) => {
    if (!r.encryptedCredentials) return false;
    try {
      const c = decryptCredentials(r.encryptedCredentials);
      const ids = [c.pageId, c.igUserId, c.phoneNumberId];
      return ids.some(
        (id) => typeof id === "string" && id && candidates.has(id)
      );
    } catch {
      return false;
    }
  });
  return resolveOwnership(matched, candidates);
}

/** True when the row's own credentials contain one of the candidate asset ids. */
function credentialConfirmed<T extends { encryptedCredentials: string | null }>(
  r: T,
  candidates: Set<string>
): boolean {
  if (!r.encryptedCredentials) return false;
  try {
    const c = decryptCredentials(r.encryptedCredentials);
    const ids = [c.pageId, c.igUserId, c.phoneNumberId];
    return ids.some(
      (id) => typeof id === "string" && id && candidates.has(id)
    );
  } catch {
    return false;
  }
}

/**
 * Cross-workspace fan-out guard (Batch A item 6). If one external account
 * id matches integrations in MULTIPLE workspaces, ingesting into all of
 * them would copy one business's events into another tenant. Prefer the
 * workspace whose decrypted credentials actually contain the matched asset
 * id; if ownership is still ambiguous, ingest into none and log a clear
 * warning (counts only — never credential material).
 *
 * Batch B extension — same-workspace multi-account: several accounts of
 * one provider may now match one entry inside a single workspace (e.g.
 * two WhatsApp numbers under one WABA). Within each (workspace,
 * provider) group, keep only credential-confirmed accounts; if more than
 * one account of the same provider is still confirmed for the same
 * entry, the account identity is ambiguous — skip that group and log a
 * diagnostic rather than ingesting the event into the wrong account.
 */
function resolveOwnership<
  T extends {
    workspaceId: string;
    provider: string;
    encryptedCredentials: string | null;
  },
>(rows: T[], candidates: Set<string>): T[] {
  const wsIds = new Set(rows.map((r) => r.workspaceId));
  let owned = rows;
  if (wsIds.size > 1) {
    const confirmed = rows.filter((r) => credentialConfirmed(r, candidates));
    const confirmedWs = new Set(confirmed.map((r) => r.workspaceId));
    if (confirmedWs.size === 1) {
      const owner = [...confirmedWs][0];
      owned = confirmed.filter((r) => r.workspaceId === owner);
    } else {
      console.warn(
        "[webhook:meta] ambiguous account match across workspaces — skipping ingest for this entry",
        { workspaces: wsIds.size }
      );
      return [];
    }
  }
  // Same-workspace, same-provider disambiguation (Batch B).
  const groups = new Map<string, T[]>();
  for (const r of owned) {
    const key = `${r.workspaceId}:${r.provider}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const out: T[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const confirmed = group.filter((r) => credentialConfirmed(r, candidates));
    if (confirmed.length === 1) {
      out.push(confirmed[0]);
    } else {
      console.warn(
        "[webhook:meta] ambiguous account match within workspace — skipping ingest for this provider on this entry",
        { workspaceId: group[0].workspaceId, provider: group[0].provider, matches: group.length }
      );
    }
  }
  return out;
}

export const POST = handler(async (req: NextRequest) => {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  if (!verifyMetaSignature(raw, sig)) {
    throw err("Invalid webhook signature", 401);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    throw err("Invalid JSON body", 400);
  }

  if (
    body.object !== "page" &&
    body.object !== "instagram" &&
    body.object !== "whatsapp_business_account"
  ) {
    // Not a feed/messaging event we handle — acknowledge and ignore.
    // WhatsApp Cloud API delivers with object "whatsapp_business_account";
    // its entries route into the same ingest path (matchIntegrations
    // already collects metadata.phone_number_id as a candidate).
    return ok({ received: true });
  }

  const entries = Array.isArray(body.entry) ? body.entry : [];
  let ingestFailed = false;
  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Record<string, unknown>;
    const entryId = typeof entry.id === "string" ? entry.id : "";

    // Entry-level dedupe (per-message/comment dedupe lives in ingest).
    // NOTE: for production, move this to Redis (shared across processes).
    // Only applied when the entry carries a time: WhatsApp entries have no
    // `time` field, so keying on it would drop every delivery after the
    // first from the same WABA. WhatsApp items are deduped per-message by
    // the durable CustomerEvent gate in ingest instead.
    if (entry.time != null) {
      const entryKey = `entry:${entryId}:${String(entry.time)}`;
      if (seenDeliveryIds.has(entryKey)) continue;
      if (seenDeliveryIds.size > 50_000) seenDeliveryIds.clear();
      seenDeliveryIds.add(entryKey);
    }

    try {
      const integrations = await matchIntegrations(entry);
      for (const integ of integrations) {
        try {
          const result = await ingestMetaEvent(
            {
              id: integ.id,
              workspaceId: integ.workspaceId,
              provider: integ.provider,
            },
            entry
          );
          if (result.failed) ingestFailed = true;
        } catch (e) {
          console.error(
            "[webhook:meta] ingest failed for entry",
            entryId,
            e
          );
          ingestFailed = true;
        }
      }
    } catch (e) {
      console.error("[webhook:meta] matching failed for entry", entryId, e);
      ingestFailed = true;
    }
  }

  if (ingestFailed) {
    // Not safely accepted: ask Meta to redeliver. Durable dedupe and
    // dispatch idempotency make the redelivery exactly-once.
    throw err("Ingest failed — event not accepted, redelivery requested", 500);
  }

  return ok({ received: true });
});
