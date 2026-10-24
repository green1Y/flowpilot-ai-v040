/**
 * POST /api/campaigns/[id]/process-email — email-campaign batch processor
 * (Wave 2E).
 *
 * WHY A SEPARATE ROUTE: the shared process route delegates to
 * processCampaign(), whose channel gate only accepts instagram / facebook
 * / whatsapp and whose eligibility engine is built around the 24h
 * messaging window and Meta identities. Routing email through it would
 * mean widening that shared engine (owned by other waves' concerns).
 * This route therefore implements the SAME batch semantics for email
 * campaigns only, mirroring processCampaign step for step:
 *
 *  - MANAGER+; body { batchSize } optional, 1–200, default 25.
 *  - Campaign must exist (tenant-scoped), be channel "email", and be
 *    RUNNING — otherwise 422.
 *  - Demo-mode guard at batch level (403 stops the batch loudly, exactly
 *    like processCampaign; per-recipient sends are additionally guarded
 *    inside sendCampaignEmail).
 *  - PENDING recipients oldest-first; per recipient: suppression and
 *    missing-address are SKIPPED (never sent), Resend acceptance is SENT
 *    with providerMessageId + sentAt, provider/config failures are FAILED
 *    with the error text (retryable via retry-failed after fixing config).
 *    One bad recipient never stops the batch.
 *  - Rate cap sleep(1000 / ratePerSecond) between sends, not after the last.
 *  - When no PENDING recipients remain and the campaign is still RUNNING,
 *    it completes (campaign.completed audit); every batch writes
 *    campaign.batch_processed — the same audit events processCampaign
 *    writes, so reporting stays uniform.
 *
 * Body resolution: a linked MessageTemplate's body wins when templateId
 * is set (its row must exist, else 422); otherwise the campaign.message
 * JSON { text } is used, and { subject } supplies the subject (falling
 * back to the campaign name inside sendCampaignEmail).
 *
 * HONESTY: SENT here means Resend's API accepted the message — never
 * "delivered". No delivery/open tracking exists in this wave.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/audit";
import { assertLiveSendAllowed } from "@/lib/demo/guard";
import { sendCampaignEmail } from "@/lib/email/campaign";
import { scopedCampaign } from "@/app/api/campaigns/campaign-helpers";

const processEmailSchema = z.object({
  batchSize: z.number().int().min(1).max(200).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse campaign.message JSON (tolerates legacy double-encoding). */
function parseCampaignMessage(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    let parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Contact.company for templates: explicit customFields.company, else "". */
function companyFromCustomFields(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).company === "string"
    ) {
      return (parsed as Record<string, string>).company;
    }
  } catch {
    // Unparseable: no company.
  }
  return null;
}

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");

  let body: { batchSize?: number } = {};
  const raw = (await req.text()).trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw err("Invalid JSON body", 400);
    }
    const checked = processEmailSchema.safeParse(parsed);
    if (!checked.success) throw err("Validation failed", 422);
    body = checked.data;
  }

  const campaign = await scopedCampaign(ctx.workspaceId, (await params).id);
  if (campaign.channel !== "email") {
    throw err(
      "process-email only handles email campaigns — use /process for messaging channels",
      422
    );
  }
  if (campaign.status !== "RUNNING") {
    throw err(
      `Campaign is ${campaign.status} — only RUNNING campaigns can be processed`,
      422
    );
  }

  // Batch-level demo guard (per-recipient sends are guarded again inside
  // sendCampaignEmail); a 403 here stops the batch loudly.
  await assertLiveSendAllowed(ctx.workspaceId);

  const now = new Date();
  const batchSize = Math.min(Math.max(body.batchSize ?? 25, 1), 200);
  const rate = Math.max(campaign.ratePerSecond > 0 ? campaign.ratePerSecond : 1, 0.1);
  const delayMs = 1000 / rate;

  const messageJson = parseCampaignMessage(campaign.message);
  let templateBody: string;
  if (campaign.templateId) {
    const template = await db.messageTemplate.findFirst({
      where: { id: campaign.templateId, workspaceId: ctx.workspaceId },
      select: { body: true },
    });
    if (!template) throw err("Campaign template not found", 422);
    templateBody = template.body;
  } else {
    templateBody =
      typeof messageJson.text === "string" ? messageJson.text : "";
  }
  if (!templateBody.trim()) {
    throw err("Campaign has no email body — set a message text or template", 422);
  }
  const subject =
    typeof messageJson.subject === "string" && messageJson.subject
      ? messageJson.subject
      : undefined;

  const recipients = await db.campaignRecipient.findMany({
    where: { campaignId: campaign.id, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const contact = await db.contact.findFirst({
      where: { id: r.contactId, workspaceId: ctx.workspaceId },
      select: { id: true, name: true, email: true, customFields: true },
    });
    if (!contact) {
      await db.campaignRecipient.update({
        where: { id: r.id },
        data: {
          status: "SKIPPED",
          skipReason: "contact no longer exists",
        },
      });
      skipped++;
      if (i < recipients.length - 1) await sleep(delayMs);
      continue;
    }

    try {
      const result = await sendCampaignEmail({
        workspaceId: ctx.workspaceId,
        campaign: {
          id: campaign.id,
          name: campaign.name,
          message: campaign.message,
        },
        recipient: {
          id: contact.id,
          name: contact.name,
          email: contact.email,
          company: companyFromCustomFields(contact.customFields),
          customFields: contact.customFields,
        },
        templateBody,
        subject,
      });

      if ("skipped" in result && result.skipped) {
        await db.campaignRecipient.update({
          where: { id: r.id },
          data: { status: "SKIPPED", skipReason: result.reason.slice(0, 2000) },
        });
        skipped++;
      } else if ("accepted" in result && result.accepted) {
        await db.campaignRecipient.update({
          where: { id: r.id },
          data: {
            status: "SENT",
            sentAt: now,
            providerMessageId: result.providerMessageId,
          },
        });
        sent++;
      } else if ("accepted" in result) {
        await db.campaignRecipient.update({
          where: { id: r.id },
          data: { status: "FAILED", error: result.error.slice(0, 2000) },
        });
        failed++;
      }
    } catch (e) {
      // Demo-mode policy block (403 Response) is never a per-recipient
      // failure — re-throw so the batch stops loudly.
      if (e instanceof Response && e.status === 403) throw e;
      const message = e instanceof Error ? e.message : String(e);
      await db.campaignRecipient.update({
        where: { id: r.id },
        data: { status: "FAILED", error: message.slice(0, 2000) },
      });
      failed++;
    }

    if (i < recipients.length - 1) await sleep(delayMs);
  }

  const processed = recipients.length;

  let completed = false;
  const remaining = await db.campaignRecipient.count({
    where: { campaignId: campaign.id, status: "PENDING" },
  });
  if (remaining === 0) {
    const fresh = await db.campaign.findUnique({
      where: { id: campaign.id },
      select: { status: true, workspaceId: true },
    });
    if (fresh && fresh.workspaceId === ctx.workspaceId && fresh.status === "RUNNING") {
      await db.campaign.update({
        where: { id: campaign.id },
        data: { status: "COMPLETED", completedAt: now },
      });
      await auditLog(ctx.workspaceId, ctx.userId, "campaign.completed", {
        type: "campaign",
        id: campaign.id,
        sent,
        failed,
        skipped,
      });
      completed = true;
    }
  }

  await auditLog(ctx.workspaceId, ctx.userId, "campaign.batch_processed", {
    type: "campaign",
    id: campaign.id,
    processed,
    sent,
    failed,
    skipped,
    pendingRemaining: remaining,
  });

  const finalStatus = (
    await db.campaign.findUnique({
      where: { id: campaign.id },
      select: { status: true },
    })
  )?.status;

  return ok({
    process: {
      campaignId: campaign.id,
      status: finalStatus ?? campaign.status,
      processed,
      sent,
      failed,
      skipped,
      completed,
    },
  });
});
