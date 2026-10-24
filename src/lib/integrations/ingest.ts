import { db } from "../db";
import { recordCustomerEvent } from "../events/record";
import { auditLog } from "../audit";
import { dispatchInboundWorkflows } from "../workflows/dispatch";
import { processCommentForRules } from "../comment-dm/process";

/**
 * Ingestion of Meta webhook events (Facebook / Instagram / WhatsApp) into
 * Contacts → Conversations → Messages.
 *
 * Identity mapping: each channel's sender id is stored in Contact.externalIds
 * under a channel-scoped key so the same human across channels never collides:
 *   facebook  → { PSID: "<page-scoped id>" }
 *   instagram → { IGSID: "<instagram-scoped id>" }
 *   whatsapp  → { wa: "wa:<phone>" }   (value prefixed so a raw phone contact
 *                                        can never match a WhatsApp sender)
 * SQLite has no JSON-contains operator in this Prisma version, so the
 * externalIds lookup is done in JS (findMany + JSON.parse scan).
 *
 * Never throws for a single bad item — each item is wrapped in try/catch and
 * skipped with a console.warn. Webhook delivery must never 500 to Meta.
 */

/** Seen delivery/message/comment ids. Module-level, per-process, bounded. */
// NOTE: for production (multiple processes/restarts) replace this with Redis
// (e.g. SETNX with a TTL) so dedupe survives deploys and horizontal scaling.
export const seenDeliveryIds = new Set<string>();

/** Returns true when the key was already seen (duplicate). */
export function markSeen(key: string): boolean {
  if (seenDeliveryIds.has(key)) return true;
  if (seenDeliveryIds.size > 50_000) seenDeliveryIds.clear();
  seenDeliveryIds.add(key);
  return false;
}

export interface IngestIntegration {
  id: string;
  workspaceId: string;
  provider: string; // "instagram" | "facebook" | "whatsapp"
}

function externalKey(provider: string): string {
  if (provider === "facebook") return "PSID";
  if (provider === "instagram") return "IGSID";
  return "wa";
}

function normalizeSenderId(provider: string, raw: unknown): string {
  const s = typeof raw === "string" && raw ? raw : "unknown";
  return provider === "whatsapp" ? `wa:${s}` : s;
}

export async function findOrCreateContact(
  workspaceId: string,
  provider: string,
  senderId: string,
  name: string
): Promise<string> {
  const key = externalKey(provider);
  const contacts = await db.contact.findMany({
    where: { workspaceId },
    select: { id: true, externalIds: true },
  });
  for (const c of contacts) {
    try {
      const ids = JSON.parse(c.externalIds || "{}") as Record<string, unknown>;
      if (ids && ids[key] === senderId) {
        // Refresh last-seen on reuse (best-effort).
        await db.contact
          .update({ where: { id: c.id }, data: { lastSeenAt: new Date() } })
          .catch(() => undefined);
        return c.id;
      }
    } catch {
      // Malformed externalIds — ignore this row.
    }
  }
  const created = await db.contact.create({
    data: {
      workspaceId,
      name,
      externalIds: JSON.stringify({ [key]: senderId }),
      channel: provider,
    },
  });
  return created.id;
}

/**
 * Record an inbound interaction for the 24h messaging-window eligibility
 * checker. Best-effort: never throws.
 */
async function recordInboundAt(contactId: string, at: Date): Promise<void> {
  try {
    await db.contact.update({
      where: { id: contactId },
      data: { lastInboundAt: at },
    });
  } catch (e) {
    console.warn("[ingest] failed to set lastInboundAt", e);
  }
}

/**
 * Stage 3 — campaign reply hook. When a contact who is a SENT/PENDING
 * recipient of a RUNNING campaign writes back:
 *  (a) their recipient rows are marked REPLIED (repliedAt = the actual
 *      inbound event time — never estimated), and
 *  (b) each campaign with pauseOnReply is auto-paused
 *      (audit: campaign.auto_paused_on_reply).
 * Stage 2 (below) then cancels pending follow-up nudges and advances the
 * lead stage — toward INTERESTED when this reply was to a campaign wave
 * (only from NEW/CONTACTED), otherwise NEW → CONTACTED as before.
 * Best-effort: never throws, never breaks webhook delivery.
 */
async function handleCampaignReply(
  workspaceId: string,
  contactId: string,
  at: Date,
  integrationId?: string
): Promise<boolean> {
  try {
    const running = await db.campaign.findMany({
      where: { workspaceId, status: "RUNNING" },
      select: { id: true, pauseOnReply: true },
    });
    let repliedToWave = false;
    for (const campaign of running) {
      const { count } = await db.campaignRecipient.updateMany({
        where: {
          campaignId: campaign.id,
          contactId,
          status: { in: ["SENT", "PENDING"] },
        },
        data: { status: "REPLIED", repliedAt: at },
      });
      if (count === 0) continue;
      repliedToWave = true;
      // Phase 3A: record the reply as a campaign interaction (idempotent on
      // campaign+contact so re-ingestion never double-records).
      await recordCustomerEvent({
        workspaceId,
        contactId,
        integrationId: integrationId ?? null,
        type: "campaign_interaction",
        source: "webhook",
        metadata: { interaction: "reply" },
        attribution: { campaignId: campaign.id },
        providerEventId: `campaign-reply:${campaign.id}:${contactId}`,
        timestamp: at,
      });
      if (campaign.pauseOnReply) {
        await db.campaign.update({
          where: { id: campaign.id },
          data: { status: "PAUSED" },
        });
        await auditLog(workspaceId, null, "campaign.auto_paused_on_reply", {
          type: "campaign",
          id: campaign.id,
          contactId,
          reason: "recipient replied",
        });
      }
    }
    return repliedToWave;
  } catch (e) {
    console.warn("[ingest] campaign reply hook failed", e);
    return false;
  }
}

/**
 * Stage 2 — inbound engagement hook. When a contact writes back:
 *  (a) any SCHEDULED follow-ups for them are auto-cancelled (the human is
 *      already talking — no need for the nudge), and
 *  (b) a contact still in the NEW lead stage advances to CONTACTED —
 *      or, when the reply came from a campaign wave (Stage 3), the stage
 *      advances toward INTERESTED (only from NEW/CONTACTED).
 * Best-effort: never throws, never breaks webhook delivery.
 */
async function handleInboundEngagement(
  workspaceId: string,
  contactId: string,
  at?: Date,
  integrationId?: string
): Promise<void> {
  try {
    // Stage 3 first: mark campaign recipients REPLIED and auto-pause waves
    // with pauseOnReply (best-effort; never blocks the rest of the hook).
    const repliedToWave = await handleCampaignReply(workspaceId, contactId, at ?? new Date(), integrationId);

    const scheduled = await db.followUp.findMany({
      where: { workspaceId, contactId, status: "SCHEDULED" },
      select: { id: true },
    });
    for (const fu of scheduled) {
      await db.followUp.update({
        where: { id: fu.id },
        data: { status: "CANCELLED", cancelReason: "contact replied" },
      });
      await auditLog(workspaceId, null, "followup.auto_cancelled", {
        type: "followup",
        id: fu.id,
        contactId,
        reason: "contact replied",
      });
    }

    const contact = await db.contact.findUnique({
      where: { id: contactId },
      select: { workspaceId: true, leadStatus: true },
    });
    // Tenant guard: the contact id came from our own lookup, but never
    // mutate across workspaces.
    if (!contact || contact.workspaceId !== workspaceId) return;
    const stage = contact.leadStatus.toUpperCase();

    // A reply to a campaign wave signals interest: advance New/Contacted →
    // INTERESTED. Ordinary inbound replies keep the old New → Contacted step.
    const target = repliedToWave
      ? stage === "NEW" || stage === "CONTACTED"
        ? "INTERESTED"
        : null
      : stage === "NEW"
        ? "CONTACTED"
        : null;
    if (target) {
      await db.contact.update({
        where: { id: contactId },
        data: { leadStatus: target },
      });
      await auditLog(workspaceId, null, "contact.stage_changed", {
        type: "contact",
        id: contactId,
        from: contact.leadStatus,
        to: target,
        reason: repliedToWave ? "inbound reply to campaign wave" : "inbound reply",
      });
    }
  } catch (e) {
    console.warn("[ingest] inbound engagement hook failed", e);
  }
}

/** Meta webhook timestamps are unix seconds (string or number). */
function parseEventTime(raw: unknown): Date | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return new Date(raw * 1000);
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    return new Date(Number(raw) * 1000);
  }
  return null;
}

/**
 * Find-or-create the OPEN conversation for a contact on a channel.
 *
 * Batch B account scoping: when `integrationId` is given (an inbound event
 * or a send resolved to an exact connected account), the conversation is
 * scoped to that account — the same contact talking to two accounts of
 * one provider gets one conversation PER ACCOUNT, which is the isolation
 * boundary for account-level data. A legacy conversation with no account
 * stamp is adopted (and stamped) rather than split, so pre-Batch-B
 * threads stay single. Without `integrationId`, behavior is unchanged.
 */
export async function findOrCreateConversation(
  workspaceId: string,
  contactId: string,
  channel: string,
  integrationId?: string | null
): Promise<{ id: string; created: boolean }> {
  if (integrationId) {
    const scoped = await db.conversation.findFirst({
      where: { workspaceId, contactId, channel, status: "OPEN", integrationId },
      orderBy: { updatedAt: "desc" },
    });
    if (scoped) return { id: scoped.id, created: false };
    const legacy = await db.conversation.findFirst({
      where: { workspaceId, contactId, channel, status: "OPEN", integrationId: null },
      orderBy: { updatedAt: "desc" },
    });
    if (legacy) {
      await db.conversation
        .update({ where: { id: legacy.id }, data: { integrationId } })
        .catch(() => undefined);
      return { id: legacy.id, created: false };
    }
    const created = await db.conversation.create({
      data: { workspaceId, contactId, channel, status: "OPEN", integrationId },
    });
    return { id: created.id, created: true };
  }
  const existing = await db.conversation.findFirst({
    where: { workspaceId, contactId, channel, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
  });
  if (existing) return { id: existing.id, created: false };
  const created = await db.conversation.create({
    data: { workspaceId, contactId, channel, status: "OPEN" },
  });
  return { id: created.id, created: true };
}

export async function createInboundMessage(
  conversationId: string,
  body: string,
  media: string,
  opts?: { direction?: "INBOUND" | "OUTBOUND"; createdAt?: Date; providerMessageId?: string | null }
): Promise<string> {
  const created = await db.message.create({
    data: {
      conversationId,
      direction: opts?.direction ?? "INBOUND",
      body,
      media,
      mocked: false,
      providerMessageId: opts?.providerMessageId ?? null,
      ...(opts?.createdAt ? { createdAt: opts.createdAt } : {}),
    },
    select: { id: true },
  });
  return created.id;
}

interface ParsedItem {
  senderRaw: unknown;
  name: string;
  dedupeKey: string | null;
  /** Provider-side message id (MID / wamid) when the payload carries one. */
  providerMessageId: string | null;
  body: string;
  media: string;
  /** Event time from the webhook payload (unix seconds → Date), if present. */
  eventAt: Date | null;
}

/** Parse one entry.messaging[] item into a ParsedItem, or null to skip. */
function parseMessagingItem(
  item: Record<string, unknown>,
  provider: string
): ParsedItem | null {
  const sender = item.sender as { id?: unknown } | undefined;
  const senderRaw = sender?.id;
  const eventAt = parseEventTime(item.timestamp);

  const message = item.message as
    | { mid?: unknown; is_echo?: unknown; text?: unknown }
    | undefined;
  const postback = item.postback as { mid?: unknown; payload?: unknown } | undefined;
  const referral = item.referral as { ref?: unknown } | undefined;

  if (message && !message.is_echo) {
    const text =
      typeof message.text === "string" && message.text
        ? message.text
        : "[attachment]";
    return {
      senderRaw,
      name: String(senderRaw ?? "unknown"),
      dedupeKey:
        typeof message.mid === "string" ? `mid:${message.mid}` : null,
      providerMessageId: typeof message.mid === "string" ? message.mid : null,
      body: text,
      media: "[]",
      eventAt,
    };
  }

  if (postback || referral) {
    // Postbacks and referrals carry no free text; store the payload so
    // workflows/automation can still route on it.
    const payload = postback?.payload ?? referral?.ref ?? "";
    const mid = postback?.mid;
    return {
      senderRaw,
      name: String(senderRaw ?? "unknown"),
      dedupeKey:
        typeof mid === "string"
          ? `mid:${mid}`
          : `pb:${provider}:${String(senderRaw ?? "unknown")}:${String(payload)}`,
      providerMessageId: typeof mid === "string" ? mid : null,
      body: `[postback] ${String(payload)}`,
      media: "[]",
      eventAt,
    };
  }

  // Delivery/read receipts, echoes, and unknown shapes are not messages.
  return null;
}

/** Parse one WhatsApp Cloud API value.messages[] item, or null to skip. */
function parseWhatsappMessage(
  msg: Record<string, unknown>,
  value: Record<string, unknown>
): ParsedItem | null {
  const from = msg.from;
  const id = msg.id;
  const type = typeof msg.type === "string" ? msg.type : "message";
  let body: string;
  if (type === "text") {
    const text = msg.text as { body?: unknown } | undefined;
    body =
      text && typeof text.body === "string" && text.body
        ? text.body
        : "[empty message]";
  } else {
    body = `[${type}]`;
  }
  return {
    senderRaw: from,
    name: String(from ?? "unknown"),
    dedupeKey: typeof id === "string" ? `wamid:${id}` : null,
    providerMessageId: typeof id === "string" ? id : null,
    body,
    // Keep the WABA + phone context on the message for routing/debugging.
    media: JSON.stringify({
      wabaId: value?.metadata
        ? (value.metadata as { waba_id?: unknown }).waba_id ?? null
        : null,
      type,
    }),
    eventAt: parseEventTime(msg.timestamp),
  };
}

/** Monotonic rank for provider delivery states (failed handled separately). */
const DELIVERY_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

/**
 * WhatsApp delivery-status webhooks (value.statuses[]) — Batch A item 3.
 *
 * Matches each status to the OutboundSend that produced it by provider
 * message id (wamid) and records it on `deliveryStatus`/`deliveryStatusAt`.
 * `OutboundSend.status` stays the API-acceptance record (SENT = Graph API
 * accepted the request); deliveryStatus carries the provider-reported
 * sent/delivered/read/failed progression. Updates are monotonic so
 * out-of-order status webhooks never move a message backwards. Emits
 * message_delivered / message_read / message_failed CustomerEvents
 * (idempotent per wamid + status). Never throws.
 */
async function handleWhatsappStatuses(
  workspaceId: string,
  provider: string,
  value: Record<string, unknown>,
  integrationId?: string
): Promise<void> {
  const statuses = Array.isArray(value.statuses) ? value.statuses : [];
  for (const raw of statuses) {
    try {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      const wamid = typeof s.id === "string" ? s.id : "";
      const status = typeof s.status === "string" ? s.status : "";
      if (!wamid || !status) continue;
      const at = parseEventTime(s.timestamp) ?? new Date();

      let errorText: string | undefined;
      const errs = Array.isArray(s.errors) ? s.errors : [];
      const firstErr =
        errs[0] && typeof errs[0] === "object"
          ? (errs[0] as Record<string, unknown>)
          : undefined;
      if (firstErr) {
        errorText = [firstErr.title, firstErr.message, firstErr.code != null ? `code ${firstErr.code}` : ""]
          .filter(Boolean)
          .join(" — ")
          .slice(0, 500);
      }

      const send = await db.outboundSend.findFirst({
        where: { workspaceId, providerMessageId: wamid },
        select: { id: true, contactId: true, deliveryStatus: true, integrationId: true },
      });

      if (send) {
        const cur = send.deliveryStatus ?? "";
        const shouldUpdate =
          status === "failed"
            ? cur !== "read" && cur !== "failed"
            : (DELIVERY_RANK[status] ?? 0) > (DELIVERY_RANK[cur] ?? 0);
        if (shouldUpdate) {
          await db.outboundSend.update({
            where: { id: send.id },
            data: { deliveryStatus: status, deliveryStatusAt: at },
          });
        }
      }

      // Mirror onto the visible outbound Message copy (send pipeline stamps
      // providerMessageId on it for exactly this match).
      await db.message
        .updateMany({
          where: {
            providerMessageId: wamid,
            direction: "OUTBOUND",
            conversation: { workspaceId },
          },
          data: { deliveryStatus: status },
        })
        .catch(() => undefined);

      if (status === "delivered" || status === "read" || status === "failed") {
        await recordCustomerEvent({
          workspaceId,
          contactId: send?.contactId ?? null,
          integrationId: integrationId ?? send?.integrationId ?? null,
          type:
            status === "delivered"
              ? "message_delivered"
              : status === "read"
                ? "message_read"
                : "message_failed",
          provider,
          providerEventId: `wa-status:${wamid}:${status}`,
          timestamp: at,
          source: "webhook",
          metadata: { wamid, status, ...(errorText ? { error: errorText } : {}) },
        });
      }
    } catch (err) {
      console.warn("[ingest] skipping bad WhatsApp status item", err);
    }
  }
}

/**
 * Ingest one Meta webhook `entry` for a matched integration.
 * Returns the number of messages created, plus `failed: true` when any
 * persistence or workflow-dispatch step failed — the webhook route turns
 * that into a 5xx so Meta redelivers (safe: durable dedupe + dispatch
 * idempotency keys make redelivery exactly-once).
 */
export async function ingestMetaEvent(
  integration: IngestIntegration,
  entry: unknown
): Promise<{ messages: number; failed: boolean }> {
  const { workspaceId, provider } = integration;
  const e = (entry ?? {}) as Record<string, unknown>;
  let count = 0;
  let failed = false;

  const items: ParsedItem[] = [];

  // 1) Messenger / Instagram messaging events: entry.messaging[]
  const messaging = Array.isArray(e.messaging) ? e.messaging : [];
  for (const raw of messaging) {
    try {
      const parsed =
        raw && typeof raw === "object"
          ? parseMessagingItem(raw as Record<string, unknown>, provider)
          : null;
      if (parsed) items.push(parsed);
    } catch (err) {
      console.warn("[ingest] skipping bad messaging item", err);
    }
  }

  // 2) Page/Instagram feed changes: entry.changes[] (comments) and
  //    WhatsApp Cloud API changes: value.messages[]
  const changes = Array.isArray(e.changes) ? e.changes : [];
  for (const rawChange of changes) {
    try {
      const value =
        rawChange && typeof rawChange === "object"
          ? ((rawChange as Record<string, unknown>).value as
              | Record<string, unknown>
              | undefined)
          : undefined;
      if (!value || typeof value !== "object") continue;

      // WhatsApp inbound messages + delivery statuses.
      if (value.messaging_product === "whatsapp") {
        if (Array.isArray(value.statuses)) {
          await handleWhatsappStatuses(workspaceId, provider, value, integration.id);
        }
        if (Array.isArray(value.messages)) {
          for (const rawMsg of value.messages as unknown[]) {
            try {
              const parsed =
                rawMsg && typeof rawMsg === "object"
                  ? parseWhatsappMessage(
                      rawMsg as Record<string, unknown>,
                      value
                    )
                  : null;
              if (parsed) items.push(parsed);
            } catch (err) {
              console.warn("[ingest] skipping bad WhatsApp message", err);
            }
          }
        }
        continue;
      }

      // Page/Instagram comments (feed webhooks).
      if (value.item === "comment") {
        const commentId =
          typeof value.comment_id === "string" ? value.comment_id : "";
        if (!commentId) continue;
        if (markSeen(`comment:${commentId}`)) continue;

        const text =
          (typeof value.message === "string" && value.message) ||
          (typeof value.text === "string" && value.text) ||
          "";
        const from = value.from as
          | { id?: unknown; username?: unknown }
          | undefined;
        const fromId = from?.id ?? "unknown";
        const username =
          typeof from?.username === "string" ? from.username : undefined;

        const contactId = await findOrCreateContact(
          workspaceId,
          provider,
          normalizeSenderId(provider, fromId),
          username ?? String(fromId)
        );
        const { id: conversationId } = await findOrCreateConversation(
          workspaceId,
          contactId,
          provider,
          integration.id
        );

        const commentedAt =
          parseEventTime(value.created_time) ?? new Date();
        // Meta allows one private reply per comment within 7 days (error 551).
        const privateReplyEligibleUntil = new Date(
          commentedAt.getTime() + 7 * 24 * 60 * 60 * 1000
        );
        const mediaId =
          (typeof value.post_id === "string" && value.post_id) ||
          (typeof value.media_id === "string" && value.media_id) ||
          "";

        // Persist the comment (DB unique constraint on externalId is the
        // second dedupe layer; race-safe across processes).
        try {
          await db.comment.upsert({
            where: { externalId: commentId },
            update: {},
            create: {
              workspaceId,
              contactId,
              integrationId: integration.id,
              externalId: commentId,
              authorExternalId: String(fromId),
              authorName: username ?? String(fromId),
              mediaId,
              mediaType:
                typeof value.media_type === "string" ? value.media_type : null,
              text,
              commentedAt,
              privateReplyEligibleUntil,
            },
          });
        } catch (e) {
          console.warn("[ingest] failed to persist comment", e);
          failed = true;
        }

        // Wave 2C — Comment-to-DM rules: run AFTER the Comment row is
        // created, and ONLY here (no other ingest behavior changed).
        // Best-effort by contract: a matcher failure (rule lookup, send
        // error, anything) must never break ingestion or webhook
        // delivery, so it is caught, logged, and skipped. The processor
        // itself records SENT/FAILED/SKIPPED/DRY_RUN events per rule.
        try {
          await processCommentForRules({
            workspaceId,
            integrationId: integration.id,
            commentId,
            mediaId,
            commentText: text,
            commentedAt,
          });
        } catch (e) {
          console.warn("[ingest] comment-to-dm processing failed", e);
        }

        // A comment is an inbound interaction: it refreshes the channel's
        // messaging context and the eligibility window data.
        await recordInboundAt(contactId, commentedAt);
        // Stage 2: a comment from the contact cancels pending nudges and
        // advances the lead stage. Stage 3: marks campaign recipients REPLIED
        // at the real event time.
        await handleInboundEngagement(workspaceId, contactId, commentedAt, integration.id);

        // media intentionally stores a JSON OBJECT (not the default "[]" array)
        // for comment events: private-reply automation needs {commentId, postId}
        // to reply in-thread. Consumers must JSON.parse media and check for
        // the commentId property before treating it as an attachment list.
        await createInboundMessage(
          conversationId,
          text,
          JSON.stringify({
            commentId,
            postId: value.post_id ?? null,
            eligibleForPrivateReply: true,
          })
        );
        // Phase 3A: unified event log (idempotent on the comment id).
        await recordCustomerEvent({
          workspaceId,
          contactId,
          integrationId: integration.id,
          type: "comment_received",
          provider,
          providerEventId: `comment:${commentId}`,
          timestamp: commentedAt,
          source: "webhook",
          metadata: { commentId, mediaId, text: text.slice(0, 500) },
        });
        // Batch A item 5: fire matching PUBLISHED workflows (new_comment).
        // Dispatch is idempotent on the comment id, so a redelivery after
        // restart cannot re-fire a workflow even though the comment path's
        // in-memory dedupe was lost.
        const d = await dispatchInboundWorkflows(workspaceId, {
          kind: "comment",
          channel: provider,
          integrationId: integration.id,
          contactId,
          conversationId,
          from: String(fromId),
          name: username ?? String(fromId),
          text,
          providerEventId: `comment:${commentId}`,
          commentId,
          postId: typeof value.post_id === "string" ? value.post_id : undefined,
        });
        if (d.failed > 0) failed = true;
        count += 1;
      }
      // Other change types are intentionally ignored. (WhatsApp statuses
      // are handled in the whatsapp branch above.)
    } catch (err) {
      console.warn("[ingest] skipping bad change item", err);
      failed = true;
    }
  }

  // 3) Persist the messaging/WhatsApp items collected above.
  for (const item of items) {
    try {
      if (item.dedupeKey && markSeen(item.dedupeKey)) continue;
      // Durable dedupe gate (Batch A item 4): the in-memory set above is
      // lost on restart, so a Meta redelivery after a restart would
      // re-create the inbox Message. The message_received CustomerEvent
      // below is written under the same providerEventId with a DB unique
      // constraint on (workspaceId, providerEventId) — if it already
      // exists, the message was already persisted: skip persistence and
      // the engagement hooks, but STILL attempt workflow dispatch below,
      // because a failed first dispatch is exactly why Meta redelivers,
      // and the dispatch idempotency key makes the retry exactly-once.
      const alreadyRecorded = item.dedupeKey
        ? (await db.customerEvent.findUnique({
            where: {
              workspaceId_providerEventId: {
                workspaceId,
                providerEventId: item.dedupeKey,
              },
            },
            select: { id: true },
          })) !== null
        : false;
      const senderId = normalizeSenderId(provider, item.senderRaw);
      const contactId = await findOrCreateContact(
        workspaceId,
        provider,
        senderId,
        item.name
      );
      const { id: conversationId, created: convCreated } = await findOrCreateConversation(
        workspaceId,
        contactId,
        provider,
        integration.id
      );
      let messageId: string | null = null;
      if (!alreadyRecorded) {
        messageId = await createInboundMessage(conversationId, item.body, item.media, {
          providerMessageId: item.providerMessageId,
        });
        // Phase 3A: unified event log. providerEventId = the dedupe key
        // (mid:/wamid:...) so re-ingestion never double-records.
        if (convCreated) {
          await recordCustomerEvent({
            workspaceId,
            contactId,
            integrationId: integration.id,
            type: "conversation_started",
            provider,
            providerEventId: `conv:${conversationId}`,
            timestamp: item.eventAt ?? new Date(),
            source: "webhook",
          });
        }
        await recordCustomerEvent({
          workspaceId,
          contactId,
          integrationId: integration.id,
          type: "message_received",
          provider,
          providerEventId: item.dedupeKey,
          timestamp: item.eventAt ?? new Date(),
          source: "webhook",
          metadata: { body: item.body.slice(0, 500) },
        });
        // Every inbound message refreshes the 24h window data.
        await recordInboundAt(contactId, item.eventAt ?? new Date());
        // Stage 2: a reply cancels pending follow-up nudges and advances
        // the lead stage when the contact is still NEW. Stage 3: marks
        // campaign recipients REPLIED at the real event time.
        await handleInboundEngagement(workspaceId, contactId, item.eventAt ?? new Date(), integration.id);
        count += 1;
      }
      // Batch A item 5: fire matching PUBLISHED workflows (new_message, and
      // new_conversation when this message opened the thread). Runs on
      // redeliveries too (see the durable-gate note above); failures are
      // reported so the webhook can answer 5xx and Meta will redeliver.
      const d = await dispatchInboundWorkflows(workspaceId, {
        kind: "message",
        channel: provider,
        integrationId: integration.id,
        contactId,
        conversationId,
        from: String(item.senderRaw ?? senderId),
        name: item.name,
        text: item.body,
        providerEventId: item.dedupeKey ?? `msg:${messageId ?? "unknown"}`,
        conversationCreated: convCreated && !alreadyRecorded,
      });
      if (d.failed > 0) failed = true;
    } catch (err) {
      console.warn("[ingest] skipping message item", err);
      failed = true;
    }
  }

  return { messages: count, failed };
}
