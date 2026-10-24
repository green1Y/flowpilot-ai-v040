/**
 * Stage 2 — outbound send pipeline for individual follow-ups.
 *
 * Guarantees (enforced in code, not just docs):
 *  - NEVER sends when the contact is suppressed or ineligible. Every blocked
 *    attempt is recorded as an OutboundSend with status SKIPPED.
 *  - Idempotency: a repeated call with the same idempotencyKey returns the
 *    existing OutboundSend without a duplicate provider send.
 *  - Honest mocked flags: the mock adapter path is labeled mocked:true on
 *    both OutboundSend and the visible Message row.
 *  - Eligibility is re-checked AT SEND TIME (scheduled follow-ups go through
 *    this same function via processDueFollowUps).
 *  - No secrets in logs: error strings come from adapter results; credential
 *    values never enter this module.
 */

import { randomUUID } from "crypto";
import { db } from "../db";
import { auditLog, trackUsage } from "../audit";
import { recordCustomerEvent } from "../events/record";
import { assertLiveSendAllowed } from "../demo/guard";
import { checkEligibility, EligibilityResult } from "./eligibility";
import {
  AccountResolutionError,
  resolveWorkspaceAdapter,
} from "../integrations/providers";
import { logAccountRoutingDiagnostic } from "../integrations/accounts";
import { findOrCreateConversation } from "../integrations/ingest";
import {
  decryptCredentials,
  encryptCredentials,
  getValidAccessToken,
} from "../integrations/meta";
import {
  decryptTikTokCredentials,
  encryptTikTokCredentials,
  getValidTikTokToken,
} from "../integrations/tiktok";

export const CHANNELS = ["instagram", "facebook", "whatsapp"] as const;
export type SendChannel = (typeof CHANNELS)[number];
export type FollowUpMessageType = "freeform" | "template" | "private_reply";

/** Error thrown by the pipeline for blocked/failed sends. Routes map this to err(). */
export class SendError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(message: string, status = 400, extra?: Record<string, unknown>) {
    super(message);
    this.name = "SendError";
    this.status = status;
    this.extra = extra;
  }
}

interface ContactLike {
  id: string;
  name: string;
}

/**
 * Render {{name}}, {{firstName}} (first token of name) and {{channel}}.
 * Unknown variables are left as-is so typos stay visible instead of
 * silently disappearing.
 */
export function renderTemplate(body: string, contact: ContactLike, channel: string): string {
  const name = contact.name ?? "";
  const firstName = name.trim().split(/\s+/)[0] ?? "";
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, varName: string) => {
    switch (varName) {
      case "name":
        return name;
      case "firstName":
        return firstName;
      case "channel":
        return channel;
      default:
        return match; // unknown variable — leave untouched
    }
  });
}

/**
 * Resolve the provider-side recipient address from the contact's externalIds.
 * Exported for the campaign builder's addressability pre-check (same rule as
 * the send path: no identity on this channel means we cannot send to it).
 */
export function resolveRecipientAddress(
  channel: SendChannel,
  externalIdsRaw: string
): string | null {
  let ids: Record<string, unknown> = {};
  try {
    ids = JSON.parse(externalIdsRaw || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
  if (channel === "facebook" && typeof ids.PSID === "string" && ids.PSID) return ids.PSID;
  if (channel === "instagram" && typeof ids.IGSID === "string" && ids.IGSID) return ids.IGSID;
  if (channel === "whatsapp" && typeof ids.wa === "string" && ids.wa) {
    // Stored as "wa:<phone>" so a raw phone contact can never match a
    // WhatsApp sender; the Cloud API wants the bare phone number.
    return ids.wa.replace(/^wa:/, "");
  }
  return null;
}

export interface SendFollowUpInput {
  workspaceId: string;
  /** Actor id for auditLog; null for system/scheduler sends. */
  userId: string | null;
  contactId: string;
  channel: SendChannel;
  messageType: FollowUpMessageType;
  /** When set, the template body (tenant-scoped) is used instead of `body`. */
  templateId?: string | null;
  /** Raw body with {{variables}}; required unless templateId is set. */
  body?: string;
  /** Comment.externalId — required for private_reply. */
  commentId?: string | null;
  /** Caller-generated; duplicates return the existing OutboundSend. */
  idempotencyKey: string;
  /** Existing FollowUp to mark SENT/FAILED/CANCELLED (process-due path). */
  followUpId?: string | null;
  /** Stage 3: the campaign this send belongs to (written onto OutboundSend). */
  campaignId?: string | null;
  /**
   * Batch B: pin this send to an exact connected account. Strict — an
   * unknown/disconnected/ambiguous account fails the send honestly rather
   * than re-routing through a different account.
   */
  integrationId?: string | null;
  now?: Date;
}

export interface SendFollowUpResult {
  /** True when no provider call was made because the key was already used. */
  duplicate: boolean;
  mocked: boolean;
  providerMessageId: string | null;
  outboundSendId: string;
  status: "SENT" | "FAILED" | "SKIPPED";
  /** Batch B: the connected account the send went through (null = mock path). */
  integrationId: string | null;
}

async function recordSkipped(args: {
  workspaceId: string;
  contactId: string;
  followUpId?: string | null;
  campaignId?: string | null;
  integrationId?: string | null;
  channel: string;
  messageType: string;
  body: string;
  idempotencyKey: string;
  reason: string;
}): Promise<void> {
  await db.outboundSend.create({
    data: {
      workspaceId: args.workspaceId,
      integrationId: args.integrationId ?? null,
      contactId: args.contactId,
      followUpId: args.followUpId ?? null,
      campaignId: args.campaignId ?? null,
      channel: args.channel,
      messageType: args.messageType,
      body: args.body,
      idempotencyKey: args.idempotencyKey,
      status: "SKIPPED",
      mocked: false,
      error: args.reason,
    },
  });
}

async function markFollowUp(
  followUpId: string | null | undefined,
  data: { status: string; sentAt?: Date; cancelReason?: string }
): Promise<void> {
  if (!followUpId) return;
  await db.followUp
    .update({ where: { id: followUpId }, data })
    .catch((e) => console.warn("[send] failed to update follow-up status", e));
}

/**
 * Check whether the contact is suppressed on this channel. A Suppression row
 * with channel=null blocks all channels; a channel-specific row blocks only
 * that channel.
 */
export async function isSuppressed(
  workspaceId: string,
  contactId: string,
  channel: string
): Promise<boolean> {
  const rows = await db.suppression.findMany({
    where: { workspaceId, contactId },
    select: { channel: true },
  });
  return rows.some((r) => r.channel === null || r.channel === channel);
}

/**
 * Wave 2A (D2): refresh the workspace's CONNECTED credentials for this
 * channel when they are inside the provider's refresh window, persisting
 * the refreshed credentials (re-encrypted) so the adapter built below uses
 * a live token. Pinned sends refresh only the pinned account; implicit
 * sends refresh every CONNECTED account for the channel (cheap: providers
 * return the stored token untouched when outside the window, no network).
 * Any failure (undecryptable row, expired token, provider error) is
 * swallowed — the adapter/send path below surfaces the real failure, and
 * a refresh problem must never turn a would-be send into a new error type.
 * Never logs or returns credential material.
 */
export async function refreshConnectedCredentials(
  workspaceId: string,
  provider: string,
  pinnedIntegrationId?: string
): Promise<void> {
  let rows;
  if (pinnedIntegrationId) {
    const row = await db.integration.findFirst({
      where: { id: pinnedIntegrationId, workspaceId },
    });
    rows = row ? [row] : [];
  } else {
    rows = await db.integration.findMany({
      where: { workspaceId, provider, status: "CONNECTED" },
    });
  }
  for (const row of rows) {
    if (!row.encryptedCredentials) continue;
    try {
      if (provider === "instagram" || provider === "facebook" || provider === "whatsapp") {
        const creds = decryptCredentials(row.encryptedCredentials);
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
      } else if (provider === "tiktok") {
        const creds = decryptTikTokCredentials(row.encryptedCredentials);
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
      }
    } catch {
      // Best-effort only — see the doc comment above.
      continue;
    }
  }
}

/**
 * Run the full send pipeline: load → suppression → eligibility → idempotency
 * → adapter send → bookkeeping. Throws SendError (never sends) on 404/422;
 * records FAILED and rethrows on provider errors.
 */
export async function sendFollowUp(input: SendFollowUpInput): Promise<SendFollowUpResult> {
  // Demo-mode guard (public-beta readiness): real external sends are blocked
  // server-side for demo workspaces, or when DEMO_MODE=true — 403 before any
  // provider call, queue enqueue, or bookkeeping. Every re-entry path
  // (scheduler worker, campaign batches, retargeting DMs, retries) funnels
  // through this function, so the check also covers retries.
  await assertLiveSendAllowed(input.workspaceId);

  const now = input.now ?? new Date();
  const {
    workspaceId,
    userId,
    contactId,
    channel,
    messageType,
    templateId,
    commentId,
  } = input;

  // a) Load contact (tenant-scoped).
  const contact = await db.contact.findFirst({
    where: { id: contactId, workspaceId },
  });
  if (!contact) {
    throw new SendError("Contact not found", 404);
  }

  // Resolve the message body (template wins over raw body).
  let rawBody = input.body ?? "";
  let templateName: string | undefined;
  if (templateId) {
    const template = await db.messageTemplate.findFirst({
      where: { id: templateId, workspaceId },
    });
    if (!template) throw new SendError("Message template not found", 404);
    rawBody = template.body;
    // For WhatsApp, Meta expects the approved template name — the template's
    // name field doubles as that (documented on the templates UI).
    templateName = template.name;
  }
  const body = renderTemplate(rawBody, contact, channel).trim();
  if (!body) {
    throw new SendError("Message body is empty", 422);
  }

  // Idempotency first: an existing OutboundSend with this key means we
  // already attempted this send — return it, never re-send.
  const existing = await db.outboundSend.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    if (existing.workspaceId !== workspaceId) {
      // Key collision across tenants must never leak another workspace's row.
      throw new SendError("Idempotency key already in use", 409);
    }
    return {
      duplicate: true,
      mocked: existing.mocked,
      providerMessageId: existing.providerMessageId,
      outboundSendId: existing.id,
      status: existing.status as SendFollowUpResult["status"],
      integrationId: existing.integrationId,
    };
  }

  // b) Suppression check — never send to suppressed contacts.
  if (await isSuppressed(workspaceId, contactId, channel)) {
    await recordSkipped({
      workspaceId, contactId, followUpId: input.followUpId,
      campaignId: input.campaignId,
      integrationId: input.integrationId ?? null,
      channel, messageType, body,
      idempotencyKey: input.idempotencyKey,
      reason: "contact is suppressed",
    });
    await markFollowUp(input.followUpId, {
      status: "CANCELLED",
      cancelReason: "contact is suppressed",
    });
    await auditLog(workspaceId, userId, "followup.skipped", {
      type: "followup", contactId, channel, reason: "suppressed",
    });
    throw new SendError("Contact is suppressed", 422, {
      ineligibleReasons: ["contact is suppressed/opted out"],
    });
  }

  // c) Eligibility check at send time.
  let eligibility: EligibilityResult;
  if (messageType === "private_reply") {
    if (!commentId) {
      throw new SendError("commentId is required for private_reply", 422);
    }
    const comment = await db.comment.findFirst({
      where: { externalId: commentId, workspaceId },
    });
    if (!comment) throw new SendError("Comment not found", 404);
    eligibility = checkEligibility({
      channel,
      messageType,
      commentCreatedAt: comment.commentedAt,
      privateRepliedAt: comment.privateRepliedAt,
      now,
    });
  } else {
    eligibility = checkEligibility({
      channel,
      messageType,
      lastInboundAt: contact.lastInboundAt,
      now,
    });
  }

  if (!eligibility.eligible) {
    const reason = eligibility.ineligibleReasons.join("; ");
    await recordSkipped({
      workspaceId, contactId, followUpId: input.followUpId,
      campaignId: input.campaignId,
      integrationId: input.integrationId ?? null,
      channel, messageType, body,
      idempotencyKey: input.idempotencyKey,
      reason,
    });
    await markFollowUp(input.followUpId, {
      status: "CANCELLED",
      cancelReason: `eligibility lapsed: ${reason}`,
    });
    await auditLog(workspaceId, userId, "followup.skipped", {
      type: "followup", contactId, channel,
      reason: "ineligible", ineligibleReasons: eligibility.ineligibleReasons,
    });
    throw new SendError("Contact is not eligible for this message", 422, {
      ineligibleReasons: eligibility.ineligibleReasons,
      windowEndsAt: eligibility.windowEndsAt?.toISOString() ?? null,
    });
  }

  // Wave 2A (D2): outbound sends never refreshed tokens — a send through
  // an account whose token was inside the refresh window used the stale
  // token and failed, even though a refresh would have succeeded. Refresh
  // (and persist) credentials BEFORE the adapter is built, so the adapter
  // is constructed from the fresh token. Best-effort by design: a refresh
  // failure is swallowed here and the send proceeds to fail honestly via
  // the adapter path, exactly as before — no new failure mode is added.
  await refreshConnectedCredentials(workspaceId, channel, input.integrationId ?? undefined);

  // e) Resolve adapter: real when a CONNECTED integration exists, honest
  //    mock otherwise. Private replies need replyToComment support.
  //    The WhatsApp adapter enforces the 24h customer-service window via an
  //    injected getLastInboundAt LOOKUP — wire the real lookup (resolves
  //    the recipient address back to a workspace contact, same semantics
  //    as the workflow engine's wiring) so the adapter's window check runs
  //    on real data as the second gate after the eligibility check above.
  //    Without it, every connected WhatsApp freeform send was treated as
  //    outside the window and threw.
  //    Batch B: resolution is account-explicit. A pinned account
  //    (input.integrationId) is used strictly; otherwise the workspace's
  //    default/single connected account. An AccountResolutionError is a
  //    routing failure — record it as a FAILED send and surface it; the
  //    message is NEVER silently re-routed through another account.
  let resolved: Awaited<ReturnType<typeof resolveWorkspaceAdapter>>;
  try {
    resolved = await resolveWorkspaceAdapter(workspaceId, channel, {
      integrationId: input.integrationId ?? undefined,
      getLastInboundAt: (to) =>
        lookupLastInboundAt(workspaceId, to, {
          id: contact.id,
          lastInboundAt: contact.lastInboundAt,
        }),
    });
  } catch (e) {
    if (e instanceof AccountResolutionError) {
      logAccountRoutingDiagnostic("send.account_resolution_failed", {
        workspaceId,
        channel,
        requestedIntegrationId: input.integrationId ?? null,
        code: e.code,
      });
      await db.outboundSend.create({
        data: {
          workspaceId, contactId, followUpId: input.followUpId ?? null,
          campaignId: input.campaignId ?? null,
          integrationId: input.integrationId ?? null,
          channel, messageType, body,
          idempotencyKey: input.idempotencyKey,
          status: "FAILED",
          mocked: false,
          error: e.message.slice(0, 2000),
        },
      });
      await markFollowUp(input.followUpId, { status: "FAILED" });
      await auditLog(workspaceId, userId, "followup.failed", {
        type: "followup", contactId, channel,
        error: e.message.slice(0, 500),
        reason: "account_resolution",
        code: e.code,
      });
      throw new SendError(e.message, 422, { code: e.code });
    }
    throw e;
  }
  const adapter = resolved.adapter;
  const resolvedIntegrationId = resolved.integrationId;

  let providerMessageId: string | null = null;
  let mocked = true;
  try {
    if (messageType === "private_reply") {
      if (!adapter.replyToComment || !commentId) {
        throw new Error(
          `The ${adapter.displayName} adapter has no private-reply path — private replies cannot be sent on this connection.`
        );
      }
      const result = await adapter.replyToComment({ commentId, body });
      if (!result.ok) throw new Error(result.error ?? "private reply failed");
      providerMessageId = result.externalId;
      mocked = result.mocked;
      // Enforce one-reply-per-comment locally as well.
      await db.comment
        .updateMany({
          where: { externalId: commentId, workspaceId },
          data: { privateRepliedAt: now },
        })
        .catch((e) => console.warn("[send] failed to stamp privateRepliedAt", e));
    } else {
      const to = resolveRecipientAddress(channel, contact.externalIds);
      if (!to) {
        throw new Error(
          `Contact has no ${channel} identity (external id) — cannot address this send.`
        );
      }
      const templateNameForProvider =
        messageType === "template" ? templateName : undefined;
      const result = await adapter.sendMessage({ to, body, templateName: templateNameForProvider });
      if (!result.ok) throw new Error(result.error ?? "send failed");
      providerMessageId = result.externalId;
      mocked = result.mocked;
    }
  } catch (e) {
    // Provider (or routing) error: record FAILED, mark follow-up, rethrow.
    // Retryable signals (429 / 5xx) are surfaced in the message so the
    // caller can decide to retry; never include credential material.
    const message = e instanceof Error ? e.message : String(e);
    const retryable = /429|rate.?limit|5\d\d|timeout|temporar/i.test(message);
    const errorText = retryable ? `${message} (retryable)` : message;
    await db.outboundSend.create({
      data: {
        workspaceId, contactId, followUpId: input.followUpId ?? null,
        campaignId: input.campaignId ?? null,
        integrationId: resolvedIntegrationId,
        channel, messageType, body,
        idempotencyKey: input.idempotencyKey,
        status: "FAILED",
        mocked: false,
        error: errorText.slice(0, 2000),
      },
    });
    await markFollowUp(input.followUpId, { status: "FAILED" });
    await auditLog(workspaceId, userId, "followup.failed", {
      type: "followup", contactId, channel, error: errorText.slice(0, 500),
      retryable,
    });
    // Phase 3A: unified event log (idempotent on the send idempotency key).
    await recordCustomerEvent({
      workspaceId,
      contactId,
      integrationId: resolvedIntegrationId,
      type: "message_failed",
      provider: channel,
      providerEventId: `outbound:${input.idempotencyKey}`,
      source: "engine",
      metadata: { channel, messageType, error: errorText.slice(0, 500) },
      attribution: input.campaignId
        ? { campaignId: input.campaignId }
        : input.followUpId
          ? { followUpId: input.followUpId }
          : {},
    });
    throw new SendError(`Send failed: ${errorText}`, retryable ? 503 : 502, { retryable });
  }

  // f) Success bookkeeping.
  const outboundSend = await db.outboundSend.create({
    data: {
      workspaceId, contactId, followUpId: input.followUpId ?? null,
      campaignId: input.campaignId ?? null,
      integrationId: resolvedIntegrationId,
      channel, messageType, body,
      idempotencyKey: input.idempotencyKey,
      status: "SENT",
      providerMessageId,
      mocked,
    },
  });

  // Visible copy on the conversation (honest mocked flag). Batch B: the
  // copy lands on the resolved account's conversation thread.
  try {
    const { id: conversationId } = await findOrCreateConversation(
      workspaceId,
      contactId,
      channel,
      resolvedIntegrationId
    );
    await db.message.create({
      data: {
        conversationId,
        direction: "OUTBOUND",
        body,
        mocked,
        // Lets WhatsApp delivery-status webhooks (matched by wamid) update
        // this visible copy's deliveryStatus.
        providerMessageId,
      },
    });
  } catch (e) {
    console.warn("[send] failed to persist outbound message copy", e);
  }

  await db.contact
    .update({ where: { id: contactId }, data: { lastOutboundAt: now } })
    .catch((e) => console.warn("[send] failed to set lastOutboundAt", e));

  await markFollowUp(input.followUpId, { status: "SENT", sentAt: now });

  await auditLog(workspaceId, userId, "followup.sent", {
    type: "followup", contactId, channel, mocked, providerMessageId,
  });

  // Phase 3A: unified event log (idempotent on the send idempotency key —
  // retries/crash-recovery never double-record).
  await recordCustomerEvent({
    workspaceId,
    contactId,
    integrationId: resolvedIntegrationId,
    type: "message_sent",
    provider: channel,
    providerEventId: `outbound:${input.idempotencyKey}`,
    source: "engine",
    metadata: { channel, messageType, mocked, providerMessageId: providerMessageId ?? null },
    attribution: input.campaignId
      ? { campaignId: input.campaignId }
      : input.followUpId
        ? { followUpId: input.followUpId }
        : {},
  });

  // Stage 4d: meter every successful send. trackUsage never throws, so
  // metering can never break the send pipeline.
  await trackUsage(workspaceId, "messages_sent", 1);

  return {
    duplicate: false,
    mocked,
    providerMessageId,
    outboundSendId: outboundSend.id,
    status: "SENT",
    integrationId: resolvedIntegrationId,
  };
}

/** Generate a fresh idempotency key when the caller does not supply one. */
export function newIdempotencyKey(): string {
  return `fu_${randomUUID()}`;
}

/**
 * Adapter-facing last-inbound lookup for the WhatsApp 24-hour window.
 * Resolves a provider recipient address back to workspace contact(s) —
 * tolerating the "wa:" storage prefix, mirroring the workflow engine's
 * lookup — and returns the newest inbound timestamp: `Contact.lastInboundAt`
 * when recorded, otherwise the newest INBOUND message on their
 * conversations. Returns null when the recipient is unknown (the adapter
 * then refuses a freeform send rather than risking an out-of-window one).
 * Never throws.
 */
export async function lookupLastInboundAt(
  workspaceId: string,
  recipient: string,
  hint?: { id: string; lastInboundAt: Date | null }
): Promise<Date | null> {
  try {
    const norm = recipient.replace(/^wa:/, "");
    const contacts = await db.contact.findMany({
      where: { workspaceId },
      select: { id: true, externalIds: true, lastInboundAt: true },
    });
    const matches = contacts.filter((c) => {
      try {
        const ids = JSON.parse(c.externalIds || "{}") as Record<string, unknown>;
        return Object.values(ids).some(
          (v) =>
            typeof v === "string" &&
            (v === recipient || v.replace(/^wa:/, "") === norm)
        );
      } catch {
        return false;
      }
    });
    const pool =
      matches.length > 0
        ? matches
        : hint
          ? [{ id: hint.id, externalIds: "", lastInboundAt: hint.lastInboundAt }]
          : [];
    if (pool.length === 0) return null;
    const stamps = pool
      .map((c) => c.lastInboundAt)
      .filter((d): d is Date => d instanceof Date);
    if (stamps.length > 0) {
      return new Date(Math.max(...stamps.map((d) => d.getTime())));
    }
    const msg = await db.message.findFirst({
      where: {
        direction: "INBOUND",
        conversation: { workspaceId, contactId: { in: pool.map((c) => c.id) } },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return msg?.createdAt ?? null;
  } catch {
    return null;
  }
}

export interface DueFollowUpResult {
  followUpId: string;
  status: string;
  error?: string;
}

/**
 * Scheduler worker: send every SCHEDULED follow-up whose scheduledAt has
 * passed. Eligibility is re-checked at send time inside sendFollowUp; lapsed
 * follow-ups become CANCELLED (recorded as SKIPPED), provider failures become
 * FAILED. One bad row never stops the batch.
 */
export async function processDueFollowUps(
  workspaceId: string,
  userId: string | null,
  opts?: { limit?: number; now?: Date }
): Promise<DueFollowUpResult[]> {
  const now = opts?.now ?? new Date();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);

  const due = await db.followUp.findMany({
    where: { workspaceId, status: "SCHEDULED", scheduledAt: { lte: now } },
    orderBy: { scheduledAt: "asc" },
    take: limit,
  });

  const results: DueFollowUpResult[] = [];
  for (const fu of due) {
    try {
      await sendFollowUp({
        workspaceId,
        userId,
        contactId: fu.contactId,
        channel: fu.channel as SendChannel,
        messageType: fu.messageType as FollowUpMessageType,
        templateId: fu.templateId,
        body: fu.body,
        commentId: fu.commentId,
        idempotencyKey: fu.idempotencyKey,
        followUpId: fu.id,
        now,
      });
      const updated = await db.followUp.findUnique({ where: { id: fu.id }, select: { status: true } });
      results.push({ followUpId: fu.id, status: updated?.status ?? "SENT" });
    } catch (e) {
      // Demo-mode policy block (403 Response from assertLiveSendAllowed):
      // re-throw so the scheduler reports 403 instead of per-item errors —
      // no follow-up in a demo workspace can send, now or on retry.
      if (e instanceof Response && e.status === 403) throw e;
      const updated = await db.followUp.findUnique({ where: { id: fu.id }, select: { status: true } });
      const status = updated?.status ?? "FAILED";
      results.push({
        followUpId: fu.id,
        status,
        error: e instanceof SendError ? e.message : "unexpected error",
      });
    }
  }
  return results;
}
