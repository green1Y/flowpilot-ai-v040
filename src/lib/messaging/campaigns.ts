/**
 * Stage 3 — campaign send engine + recipient builder.
 *
 * Guarantees (enforced in code, not just docs):
 *  - NEVER sends to a suppressed or ineligible contact. Eligibility is
 *    evaluated at BUILD time (PENDING vs SKIPPED with human-readable reasons)
 *    and RE-CHECKED at send time for every recipient.
 *  - Idempotency: idempotencyKey = `campaign:<id>:contact:<contactId>`; a
 *    repeated build skips existing rows (@@unique), and a repeated process
 *    call never re-sends (only PENDING recipients are picked up, and
 *    sendFollowUp's own idempotency guard catches crash-between-write cases).
 *  - SENT is marked ONLY after the adapter returns ok:true (provider-accepted)
 *    — never on queue/enqueue alone.
 *  - Rate cap: `sleep(1000 / ratePerSecond)` between sends.
 *  - One bad recipient never stops the batch; failures stay FAILED so the
 *    retry-failed route can reset them to PENDING.
 *  - Honest mocked flags: the mock adapter path is labeled mocked:true.
 *  - No secrets in logs: error strings come from adapter results.
 */

import type { Campaign, Prisma } from "@prisma/client";
import { db } from "../db";
import { auditLog } from "../audit";
import { checkEligibility } from "./eligibility";
import {
  CHANNELS,
  isSuppressed,
  resolveRecipientAddress,
  sendFollowUp,
  SendError,
  type FollowUpMessageType,
  type SendChannel,
} from "./send";
import {
  applyContactFilters,
  filtersFromSegmentJson,
} from "../contacts/filters";
import { assertLiveSendAllowed } from "../demo/guard";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Recipient key: deterministic, unique per (campaign, contact). */
export function campaignRecipientKey(campaignId: string, contactId: string): string {
  return `campaign:${campaignId}:contact:${contactId}`;
}

/** Parse the campaign.message JSON column (tolerates legacy double-encoding). */
export function parseCampaignMessage(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    let parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") parsed = JSON.parse(parsed); // legacy double-encode
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The message text configured on the campaign (message JSON {text}). */
export function campaignMessageText(raw: string | null | undefined): string {
  const m = parseCampaignMessage(raw);
  return typeof m.text === "string" ? m.text : "";
}

/** Parse the legacy campaign.audience JSON (tolerates double-encoding). */
export function parseCampaignAudience(raw: string | null | undefined): {
  type?: string;
  tag?: string;
} {
  const m = parseCampaignMessage(raw);
  return {
    type: typeof m.type === "string" ? m.type : undefined,
    tag: typeof m.tag === "string" ? m.tag : undefined,
  };
}

function ago(from: Date, now: Date): string {
  const ms = now.getTime() - from.getTime();
  if (ms < 0) return "in the future";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function asSendChannel(channel: string): SendChannel {
  if ((CHANNELS as readonly string[]).includes(channel)) return channel as SendChannel;
  // Campaigns target Meta messaging channels; anything else is unsupported.
  throw new SendError(
    `Unsupported campaign channel "${channel}" — campaigns support: ${CHANNELS.join(", ")}`,
    422
  );
}

function asMessageType(messageType: string): FollowUpMessageType {
  if (messageType === "freeform" || messageType === "template" || messageType === "private_reply") {
    return messageType;
  }
  throw new SendError(`Unsupported campaign messageType "${messageType}"`, 422);
}

export interface RecipientVerdict {
  eligible: boolean;
  /** Human-readable blocking reasons (empty when eligible). */
  reasons: string[];
  /** For private_reply: the Comment.externalId to reply to. */
  commentId: string | null;
}

/**
 * Evaluate one (campaign, contact) pair: suppression → addressability →
 * platform eligibility. Used at build time AND re-checked at send time.
 */
export async function evaluateCampaignRecipient(
  workspaceId: string,
  campaign: Campaign,
  contactId: string,
  now: Date
): Promise<RecipientVerdict> {
  // v0.4.0: email campaigns do not use the Meta send pipeline — no channel
  // identity, no 24h window. Eligibility is: not suppressed for email,
  // and a deliverable address on file. The email send itself happens in
  // the separate process-email route (Resend, accepted ≠ delivered).
  if (campaign.channel === "email") {
    const contact = await db.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!contact) {
      return { eligible: false, reasons: ["contact no longer exists"], commentId: null };
    }
    if (await isSuppressed(workspaceId, contactId, "email")) {
      return { eligible: false, reasons: ["contact is suppressed/opted out"], commentId: null };
    }
    if (!contact.email) {
      return { eligible: false, reasons: ["contact has no email address — cannot address this send"], commentId: null };
    }
    return { eligible: true, reasons: [], commentId: null };
  }

  const channel = asSendChannel(campaign.channel);
  const messageType = asMessageType(campaign.messageType);

  const contact = await db.contact.findFirst({
    where: { id: contactId, workspaceId },
  });
  if (!contact) {
    return { eligible: false, reasons: ["contact no longer exists"], commentId: null };
  }

  // 1) Suppression blocks everything.
  if (await isSuppressed(workspaceId, contactId, channel)) {
    return { eligible: false, reasons: ["contact is suppressed/opted out"], commentId: null };
  }

  // 2) Addressability — the send path cannot address the contact without a
  //    channel identity, so fail fast with a clear reason.
  if (
    messageType !== "private_reply" &&
    !resolveRecipientAddress(channel, contact.externalIds)
  ) {
    return {
      eligible: false,
      reasons: [`contact has no ${channel} identity — cannot address this send`],
      commentId: null,
    };
  }

  // 3) Private replies are evaluated against the contact's latest comment.
  if (messageType === "private_reply") {
    const comment = await db.comment.findFirst({
      where: { workspaceId, contactId },
      orderBy: { commentedAt: "desc" },
    });
    if (!comment) {
      return {
        eligible: false,
        reasons: ["no comment found for this contact — private replies need a comment to reply to"],
        commentId: null,
      };
    }
    const eligibility = checkEligibility({
      channel,
      messageType,
      commentCreatedAt: comment.commentedAt,
      privateRepliedAt: comment.privateRepliedAt,
      now,
    });
    return {
      eligible: eligibility.eligible,
      reasons: eligibility.ineligibleReasons,
      commentId: comment.externalId,
    };
  }

  // 4) Freeform / template: 24h window from last inbound (templates on
  //    WhatsApp are eligible outside the window — encoded in the checker).
  const eligibility = checkEligibility({
    channel,
    messageType,
    lastInboundAt: contact.lastInboundAt,
    now,
  });
  if (!eligibility.eligible) {
    const reasons = [...eligibility.ineligibleReasons];
    if (contact.lastInboundAt && messageType === "freeform") {
      reasons.unshift(`outside 24h window (last inbound ${ago(contact.lastInboundAt, now)})`);
    }
    return { eligible: false, reasons, commentId: null };
  }
  return { eligible: true, reasons: [], commentId: null };
}

interface AudienceContact {
  id: string;
  name: string;
}

/** Resolve the contacts a campaign should target (segment or legacy audience). */
async function resolveAudienceContacts(
  workspaceId: string,
  campaign: Campaign,
  segmentId: string | null
): Promise<AudienceContact[]> {
  const where: Prisma.ContactWhereInput = { workspaceId };
  if (segmentId) {
    const segment = await db.contactSegment.findFirst({
      where: { id: segmentId, workspaceId },
    });
    if (!segment) throw new SendError("Contact segment not found", 404);
    applyContactFilters(where, filtersFromSegmentJson(segment.filters));
  } else {
    const audience = parseCampaignAudience(campaign.audience);
    if (audience.type === "tag" && audience.tag) {
      applyContactFilters(where, { tag: audience.tag });
    }
    // {type:"all"} (or unparseable legacy shapes) → every contact in the workspace.
  }
  return db.contact.findMany({ where, select: { id: true, name: true } });
}

export interface BuildRecipientsResult {
  campaignId: string;
  /** Total recipient rows (including previously built). */
  total: number;
  pending: number;
  skipped: number;
  /** Rows newly inserted by this call. */
  created: number;
  skippedSample: { contactId: string; name: string; reasons: string[] }[];
}

/**
 * Build the campaign recipient list. Idempotent: existing rows (by
 * @@unique([campaignId, contactId])) are never duplicated — a rebuild only
 * adds contacts that are not yet rows.
 */
export async function buildRecipients(
  workspaceId: string,
  campaignId: string,
  opts?: { segmentId?: string | null; userId?: string | null; now?: Date }
): Promise<BuildRecipientsResult> {
  const now = opts?.now ?? new Date();
  const userId = opts?.userId ?? null;
  const segmentId = opts?.segmentId ?? null;

  const campaign = await db.campaign.findFirst({ where: { id: campaignId, workspaceId } });
  if (!campaign) throw new SendError("Campaign not found", 404);
  if (!["DRAFT", "PAUSED", "SCHEDULED"].includes(campaign.status)) {
    throw new SendError(
      `Cannot build recipients while campaign is ${campaign.status} — pause or reset to draft first`,
      422
    );
  }
  // Validate channel/messageType up front so a misconfigured campaign fails
  // at build time, not mid-batch.
  asSendChannel(campaign.channel);
  asMessageType(campaign.messageType);

  const contacts = await resolveAudienceContacts(workspaceId, campaign, segmentId);

  if (segmentId) {
    await db.campaign.update({ where: { id: campaignId }, data: { segmentId } });
  }

  const existing = await db.campaignRecipient.findMany({
    where: { campaignId },
    select: { contactId: true },
  });
  const existingIds = new Set(existing.map((e) => e.contactId));
  const fresh = contacts.filter((c) => !existingIds.has(c.id));

  const rows: Prisma.CampaignRecipientCreateManyInput[] = [];
  const skippedSample: BuildRecipientsResult["skippedSample"] = [];
  for (const contact of fresh) {
    const verdict = await evaluateCampaignRecipient(workspaceId, campaign, contact.id, now);
    rows.push({
      campaignId,
      contactId: contact.id,
      status: verdict.eligible ? "PENDING" : "SKIPPED",
      skipReason: verdict.eligible ? null : verdict.reasons.join("; ").slice(0, 2000),
      idempotencyKey: campaignRecipientKey(campaignId, contact.id),
    });
    if (!verdict.eligible && skippedSample.length < 10) {
      skippedSample.push({ contactId: contact.id, name: contact.name, reasons: verdict.reasons });
    }
  }

  let created = 0;
  if (rows.length > 0) {
    try {
      const res = await db.campaignRecipient.createMany({ data: rows });
      created = res.count;
    } catch (e) {
      // P2002 race (two concurrent builds): rows are identical, re-reading
      // below gives the true counts; the build stays idempotent.
      if (!(e instanceof Error) || !/P2002|unique/i.test(e.message)) throw e;
      created = await db.campaignRecipient.count({
        where: { campaignId, contactId: { in: fresh.map((c) => c.id) } },
      });
    }
  }

  const counts = await db.campaignRecipient.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { status: true },
  });
  const byStatus = new Map(counts.map((c) => [c.status, c._count.status]));

  const result: BuildRecipientsResult = {
    campaignId,
    total: await db.campaignRecipient.count({ where: { campaignId } }),
    pending: byStatus.get("PENDING") ?? 0,
    skipped: byStatus.get("SKIPPED") ?? 0,
    created,
    skippedSample,
  };

  await auditLog(workspaceId, userId, "campaign.recipients_built", {
    type: "campaign",
    id: campaignId,
    segmentId,
    total: result.total,
    pending: result.pending,
    skipped: result.skipped,
    created: result.created,
  });

  return result;
}

export interface ProcessCampaignResult {
  campaignId: string;
  status: string;
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  completed: boolean;
}

/**
 * Process one batch of a RUNNING campaign. For each PENDING recipient:
 * re-check eligibility at send time → send through the Stage-2 pipeline →
 * record SENT / FAILED / SKIPPED. Per-recipient errors never stop the batch.
 * When no PENDING recipients remain (and the campaign is still RUNNING),
 * the campaign completes.
 */
export async function processCampaign(
  workspaceId: string,
  campaignId: string,
  opts?: { batchSize?: number; now?: Date; userId?: string | null }
): Promise<ProcessCampaignResult> {
  // Demo-mode guard (per-campaign): a demo workspace (or DEMO_MODE=true)
  // cannot run a send batch at all. Per-recipient sends are additionally
  // guarded inside sendFollowUp.
  await assertLiveSendAllowed(workspaceId);

  const now = opts?.now ?? new Date();
  const userId = opts?.userId ?? null;
  const batchSize = Math.min(Math.max(opts?.batchSize ?? 25, 1), 200);

  const campaign = await db.campaign.findFirst({ where: { id: campaignId, workspaceId } });
  if (!campaign) throw new SendError("Campaign not found", 404);
  if (campaign.status !== "RUNNING") {
    throw new SendError(
      `Campaign is ${campaign.status} — only RUNNING campaigns can be processed`,
      422
    );
  }

  const channel = asSendChannel(campaign.channel);
  const messageType = asMessageType(campaign.messageType);
  const rate = Math.max(campaign.ratePerSecond > 0 ? campaign.ratePerSecond : 1, 0.1);
  const delayMs = 1000 / rate;
  const body = campaignMessageText(campaign.message) || undefined;

  const recipients = await db.campaignRecipient.findMany({
    where: { campaignId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];

    // Re-check eligibility at send time — contact state may have changed
    // since the build (opt-out, window lapsed, identity removed).
    const verdict = await evaluateCampaignRecipient(workspaceId, campaign, r.contactId, now);
    if (!verdict.eligible) {
      await db.campaignRecipient.update({
        where: { id: r.id },
        data: {
          status: "SKIPPED",
          skipReason: `eligibility lapsed at send time: ${verdict.reasons.join("; ")}`.slice(0, 2000),
        },
      });
      skipped++;
      continue;
    }

    try {
      const result = await sendFollowUp({
        workspaceId,
        userId,
        contactId: r.contactId,
        channel,
        messageType,
        templateId: campaign.templateId ?? undefined,
        body,
        commentId: verdict.commentId ?? undefined,
        idempotencyKey: campaignRecipientKey(campaignId, r.contactId),
        campaignId: campaign.id,
        now,
      });

      // SENT is recorded ONLY when the adapter accepted the send
      // (sendFollowUp returns SENT only after adapter ok:true).
      if (result.status === "SENT") {
        await db.campaignRecipient.update({
          where: { id: r.id },
          data: {
            status: "SENT",
            sentAt: now,
            providerMessageId: result.providerMessageId,
            mocked: result.mocked,
          },
        });
        sent++;
      } else {
        // Defensive: the pre-check should have caught these. Never mark SENT.
        await db.campaignRecipient.update({
          where: { id: r.id },
          data: {
            status: result.status === "SKIPPED" ? "SKIPPED" : "FAILED",
            skipReason: result.status === "SKIPPED" ? "blocked at send time" : undefined,
            error: result.status === "FAILED" ? "send reported failure" : undefined,
          },
        });
        if (result.status === "SKIPPED") skipped++;
        else failed++;
      }
    } catch (e) {
      // Demo-mode policy block (403 Response from assertLiveSendAllowed) is
      // never a per-recipient failure — re-throw so the batch stops loudly
      // instead of recording misleading "failed" rows.
      if (e instanceof Response && e.status === 403) throw e;
      if (e instanceof SendError && e.status === 422) {
        // Suppression / eligibility lapsed between the pre-check and the send.
        const reasons = e.extra?.ineligibleReasons as string[] | undefined;
        await db.campaignRecipient.update({
          where: { id: r.id },
          data: {
            status: "SKIPPED",
            skipReason: `eligibility lapsed at send time: ${(reasons?.join("; ") ?? e.message)}`.slice(0, 2000),
          },
        });
        skipped++;
      } else {
        // Provider/routing error: FAILED with the error text. Retryable
        // failures (429/5xx, surfaced as "(retryable)") stay FAILED — the
        // retry-failed route resets them to PENDING.
        const message = e instanceof Error ? e.message : String(e);
        await db.campaignRecipient.update({
          where: { id: r.id },
          data: { status: "FAILED", error: message.slice(0, 2000) },
        });
        failed++;
      }
    }

    // Rate cap between sends (not after the last one).
    if (i < recipients.length - 1) await sleep(delayMs);
  }

  const processed = recipients.length;

  // Complete only when nothing is PENDING and the campaign is still RUNNING
  // (a pause/cancel that landed mid-batch wins over completion).
  let completed = false;
  const remaining = await db.campaignRecipient.count({ where: { campaignId, status: "PENDING" } });
  if (remaining === 0) {
    const fresh = await db.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true, workspaceId: true },
    });
    if (fresh && fresh.workspaceId === workspaceId && fresh.status === "RUNNING") {
      await db.campaign.update({
        where: { id: campaignId },
        data: { status: "COMPLETED", completedAt: now },
      });
      await auditLog(workspaceId, userId, "campaign.completed", {
        type: "campaign",
        id: campaignId,
        sent,
        failed,
        skipped,
      });
      completed = true;
    }
  }

  await auditLog(workspaceId, userId, "campaign.batch_processed", {
    type: "campaign",
    id: campaignId,
    processed,
    sent,
    failed,
    skipped,
    pendingRemaining: remaining,
  });

  const finalStatus = (
    await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true } })
  )?.status;

  return {
    campaignId,
    status: finalStatus ?? campaign.status,
    processed,
    sent,
    failed,
    skipped,
    completed,
  };
}

/**
 * Reset FAILED recipients to PENDING so the wave can retry them.
 * When the campaign had already COMPLETED with failures, it moves back to
 * RUNNING so the retried recipients can actually be processed.
 */
export async function retryFailedRecipients(
  workspaceId: string,
  campaignId: string,
  userId: string | null
): Promise<{ campaignId: string; reset: number; status: string }> {
  const campaign = await db.campaign.findFirst({ where: { id: campaignId, workspaceId } });
  if (!campaign) throw new SendError("Campaign not found", 404);
  if (!["RUNNING", "PAUSED", "DRAFT", "COMPLETED", "SCHEDULED"].includes(campaign.status)) {
    throw new SendError(`Cannot retry while campaign is ${campaign.status}`, 422);
  }
  // Collect the keys before resetting: a FAILED OutboundSend never delivered
  // anything, so its idempotency key is recycled to allow the actual retry.
  const failed = await db.campaignRecipient.findMany({
    where: { campaignId, status: "FAILED" },
    select: { contactId: true },
  });
  const { count } = await db.campaignRecipient.updateMany({
    where: { campaignId, status: "FAILED" },
    data: { status: "PENDING", error: null },
  });
  if (count > 0) {
    await db.outboundSend.deleteMany({
      where: {
        idempotencyKey: {
          in: failed.map((f) => campaignRecipientKey(campaignId, f.contactId)),
        },
        status: "FAILED",
      },
    });
  }
  let status = campaign.status;
  if (count > 0 && campaign.status === "COMPLETED") {
    await db.campaign.update({
      where: { id: campaignId },
      data: { status: "RUNNING", completedAt: null },
    });
    status = "RUNNING";
  }
  await auditLog(workspaceId, userId, "campaign.retry_failed", {
    type: "campaign",
    id: campaignId,
    reset: count,
    resumed: status,
  });
  return { campaignId, reset: count, status };
}
