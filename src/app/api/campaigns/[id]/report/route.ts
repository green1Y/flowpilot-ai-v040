import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { serializeCampaign } from "@/lib/serialize";
import { scopedCampaign } from "@/app/api/campaigns/campaign-helpers";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Campaign report. "Replied" counts recipients whose repliedAt was set from an
 * actual inbound event (never estimated). Per-recipient rows carry the honest
 * mocked flag for each send.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  const campaign = await scopedCampaign(ctx.workspaceId, (await params).id);

  const recipients = await db.campaignRecipient.findMany({
    where: { campaignId: campaign.id },
    include: { contact: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });

  const counts = { pending: 0, skipped: 0, sent: 0, failed: 0, replied: 0 };
  for (const r of recipients) {
    if (r.status === "PENDING") counts.pending++;
    else if (r.status === "SKIPPED") counts.skipped++;
    else if (r.status === "SENT") counts.sent++;
    else if (r.status === "FAILED") counts.failed++;
    else if (r.status === "REPLIED") counts.replied++;
  }

  return ok({
    campaign: serializeCampaign(campaign),
    report: {
      attempted: counts.sent + counts.failed,
      sent: counts.sent,
      failed: counts.failed,
      skipped: counts.skipped,
      replied: counts.replied,
      pending: counts.pending,
      total: recipients.length,
      perRecipient: recipients.map((r) => ({
        contactId: r.contactId,
        name: r.contact.name,
        channel: campaign.channel,
        status: r.status,
        // Skip reasons and send errors, whichever applies to this row.
        skipReason: r.skipReason,
        error: r.error,
        sentAt: r.sentAt,
        repliedAt: r.repliedAt,
        providerMessageId: r.providerMessageId,
        mocked: r.mocked,
      })),
    },
  });
});
