/**
 * Message-history backfill from Meta Graph APIs (Instagram / Facebook).
 *
 * Capabilities, verified against Meta docs (2026-10-17):
 *  - Instagram: GET /{ig-user-id}/conversations (rate limit 2 req/sec), then
 *    GET /{conversation-id}/messages — max 20 messages per thread. On first
 *    link only the last 20 per conversation are retrievable; everything after
 *    setup is fully accessible going forward.
 *  - Facebook: same shape via the Page conversations endpoint.
 *  - WhatsApp: NO history endpoint exists — only webhooks going forward
 *    (plus a one-time 180-day onboarding history webhook at setup).
 *
 * Every stored message is a real Message row (mocked=false, never invented).
 * MID-level dedupe is enforced both in-process and in the DB so repeated
 * syncs never duplicate rows.
 */

import { db } from "../db";
import {
  decryptCredentials,
  encryptCredentials,
  getValidAccessToken,
  graph,
  MetaCredentials,
} from "./meta";
import {
  createInboundMessage,
  findOrCreateContact,
  findOrCreateConversation,
  markSeen,
} from "./ingest";
import type { Integration } from "@prisma/client";

export interface SyncHistoryResult {
  conversations: number;
  messages: number;
  skipped: number;
  note?: string;
}

/** Max conversations processed per sync call (bounds total work). */
const MAX_CONVERSATIONS = 25;
/** Messages pulled per conversation (Meta returns max 20 per thread). */
const MESSAGES_PER_THREAD = 20;
/** Respect Instagram's 2 req/sec conversations rate limit. */
const RATE_LIMIT_DELAY_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GraphPage<T> {
  data?: T[];
  paging?: { next?: string; cursors?: { after?: string } };
}

interface GraphConversation {
  id: string;
  participants?: { data?: Array<{ id?: string; name?: string }> };
  updated_time?: string;
}

interface GraphThreadMessage {
  id: string;
  created_time?: string;
  from?: { id?: string; name?: string };
  to?: { data?: Array<{ id?: string }> };
  message?: string;
}

/**
 * DB-level MID dedupe: history rows carry the Meta message id inside their
 * media JSON as {"mid":"..."}. Scoped to the workspace so tenants cannot
 * collide.
 */
async function midExistsInDb(
  workspaceId: string,
  contactId: string,
  channel: string,
  mid: string
): Promise<boolean> {
  const safe = mid.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const found = await db.message.findFirst({
    where: {
      conversation: { workspaceId, contactId, channel },
      media: { contains: `"mid":"${safe}"` },
    },
    select: { id: true },
  });
  return found !== null;
}

async function ingestThreadMessage(args: {
  workspaceId: string;
  provider: "instagram" | "facebook";
  businessId: string;
  participants: Array<{ id?: string; name?: string }>;
  msg: GraphThreadMessage;
  channel: string;
  /** Batch B: the account being synced — its conversations are account-scoped. */
  integrationId?: string;
}): Promise<"created" | "skipped"> {
  const { workspaceId, provider, businessId, participants, msg, channel } = args;
  const mid = msg.id;
  if (!mid) return "skipped";
  // In-process dedupe (repeat runs in the same process).
  if (markSeen(`history:${mid}`)) return "skipped";

  const fromId = msg.from?.id ?? "";
  const isOutbound = fromId !== "" && fromId === businessId;

  // Identity: the other party. For outbound-only threads, fall back to the
  // first participant that isn't the business account.
  let partyId = isOutbound
    ? participants.find((p) => p.id && p.id !== businessId)?.id
    : fromId;
  if (!partyId) {
    partyId = participants.find((p) => p.id && p.id !== businessId)?.id ?? "";
  }
  if (!partyId) return "skipped";

  const partyName =
    participants.find((p) => p.id === partyId)?.name ??
    msg.from?.name ??
    partyId;

  const contactId = await findOrCreateContact(workspaceId, provider, partyId, partyName);
  if (await midExistsInDb(workspaceId, contactId, channel, mid)) return "skipped";

  const { id: conversationId } = await findOrCreateConversation(
    workspaceId,
    contactId,
    channel,
    args.integrationId
  );

  const body =
    typeof msg.message === "string" && msg.message ? msg.message : "[attachment]";
  const createdAt =
    msg.created_time && !Number.isNaN(Date.parse(msg.created_time))
      ? new Date(msg.created_time)
      : undefined;

  await createInboundMessage(
    conversationId,
    body,
    JSON.stringify({ mid, fromId, syncedVia: "history" }),
    { direction: isOutbound ? "OUTBOUND" : "INBOUND", createdAt }
  );

  if (!isOutbound) {
    try {
      await db.contact.update({
        where: { id: contactId },
        data: { lastInboundAt: createdAt ?? new Date() },
      });
    } catch (e) {
      console.warn("[history] failed to set lastInboundAt", e);
    }
  }
  return "created";
}

/**
 * Sync message history for one Meta integration. Tenant-scoped: the route
 * handler resolves the integration inside the caller's workspace first.
 *
 * `fetchImpl` exists so tests can inject a stubbed HTTP layer; production
 * callers omit it and the real Meta Graph API is used.
 */
export async function syncHistory(
  integration: Integration,
  fetchImpl: typeof fetch = fetch
): Promise<SyncHistoryResult> {
  const { provider, workspaceId } = integration;

  if (provider === "whatsapp") {
    return {
      conversations: 0,
      messages: 0,
      skipped: 0,
      note: "WhatsApp Cloud API exposes no history endpoint; history accumulates via webhooks going forward.",
    };
  }
  if (provider !== "instagram" && provider !== "facebook") {
    return {
      conversations: 0,
      messages: 0,
      skipped: 0,
      note: `History sync is not supported for provider "${provider}".`,
    };
  }

  if (!integration.encryptedCredentials) {
    throw new Error("No Meta credentials stored — complete the connection flow first");
  }
  const creds: MetaCredentials = decryptCredentials(integration.encryptedCredentials);
  // Wave 2A (D3): the refreshed token used to be computed and then
  // discarded — syncs kept running on the expiring token and the row was
  // never updated, so every later sync re-refreshed (or failed once the
  // old token died). Use the valid token for the sync and persist the
  // refreshed credentials (re-encrypted) when a refresh happened.
  // Facebook Page syncs still prefer the Page token (a page-scoped token
  // the user-token refresh does not replace); Instagram Business Login
  // rows have no page token, so valid.token is used there.
  const valid = await getValidAccessToken(creds);
  if (valid.refreshed) {
    await db.integration.update({
      where: { id: integration.id },
      data: {
        encryptedCredentials: encryptCredentials({
          ...creds,
          accessToken: valid.token,
          expiresAt: valid.newExpiresAt,
        }),
      },
    });
  }
  const token = provider === "facebook" || provider === "instagram"
    ? (creds.pageAccessToken ?? valid.token)
    : valid.token;
  if (!token) throw new Error("No access token available for this integration");

  const accountId =
    provider === "instagram" ? creds.igUserId : creds.pageId;
  if (!accountId) {
    throw new Error(
      `No ${provider === "instagram" ? "Instagram user id" : "Page id"} stored — complete the connection flow first`
    );
  }

  // graph() uses the global fetch; allow tests to inject a stub.
  const originalFetch = globalThis.fetch;
  if (fetchImpl !== fetch) globalThis.fetch = fetchImpl as typeof fetch;
  try {
    const result = await (async () => {
      const channel = provider;
      let conversations = 0;
      let messages = 0;
      let skipped = 0;

      let after: string | undefined;
      const collected: GraphConversation[] = [];
      while (collected.length < MAX_CONVERSATIONS) {
        const page = await graph<GraphPage<GraphConversation>>(
          `/${accountId}/conversations`,
          {
            token,
            searchParams: {
              fields: "id,participants,updated_time",
              limit: MAX_CONVERSATIONS,
              ...(after ? { after } : {}),
              ...(provider === "instagram" ? { platform: "instagram" } : {}),
            },
          }
        );
        const items = Array.isArray(page.data) ? page.data : [];
        collected.push(...items);
        after = page.paging?.cursors?.after;
        if (!after || items.length === 0) break;
        await sleep(RATE_LIMIT_DELAY_MS);
      }

      for (const conv of collected.slice(0, MAX_CONVERSATIONS)) {
        if (!conv.id) {
          skipped += 1;
          continue;
        }
        conversations += 1;
        try {
          const thread = await graph<GraphPage<GraphThreadMessage>>(
            `/${conv.id}/messages`,
            {
              token,
              searchParams: {
                fields: "id,created_time,from,to,message",
                limit: MESSAGES_PER_THREAD,
              },
            }
          );
          const participants = Array.isArray(conv.participants?.data)
            ? conv.participants.data
            : [];
          for (const m of (Array.isArray(thread.data) ? thread.data : [])) {
            try {
              const outcome = await ingestThreadMessage({
                workspaceId,
                provider,
                businessId: accountId,
                participants,
                msg: m,
                channel,
                integrationId: integration.id,
              });
              if (outcome === "created") messages += 1;
              else skipped += 1;
            } catch (e) {
              console.warn("[history] skipping thread message", e);
              skipped += 1;
            }
          }
        } catch (e) {
          console.warn("[history] skipping conversation", conv.id, e);
          skipped += 1;
          continue;
        }
        await sleep(RATE_LIMIT_DELAY_MS);
      }

      return { conversations, messages, skipped };
    })();
    return result;
  } finally {
    if (fetchImpl !== fetch) globalThis.fetch = originalFetch;
  }
}
