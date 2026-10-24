import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import {
  scopedRetargetingCampaign,
  buildRecipients,
  mapRetargetingError,
} from "@/lib/retargeting/campaigns";
import {
  serializeRetargetingRecipient,
} from "@/lib/retargeting/schemas";
import {
  parseConditions,
  describeConditions,
  availabilityWarningsFor,
} from "@/lib/retargeting/segments";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/retargeting/campaigns/:id/review
 * Dry-run build: per-recipient eligibility verdicts + counts + exclusions.
 * Persists nothing — safe to call repeatedly before launch.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  const campaign = await scopedRetargetingCampaign(ctx.workspaceId, (await params).id);

  let summary = "No audience segment selected";
  let availabilityWarnings: string[] = [];
  if (campaign.segmentId) {
    const segment = await db.audienceSegment.findFirst({
      where: { id: campaign.segmentId, workspaceId: ctx.workspaceId },
    });
    if (segment) {
      const tree = parseConditions(segment.conditions);
      summary = describeConditions(tree);
      availabilityWarnings = availabilityWarningsFor(tree);
    }
  }

  try {
    const built = await buildRecipients(ctx.workspaceId, campaign.id, {
      userId: ctx.userId,
      dryRun: true,
    });
    const verdicts = (built.verdicts ?? []).map((v) => ({
      contactId: v.contactId,
      name: v.name,
      eligible: v.verdict.eligible,
      channel: v.verdict.channel,
      simulated: v.verdict.simulated,
      reasons: v.verdict.reasons,
      ineligibleReasons: v.verdict.ineligibleReasons,
    }));
    // Persisted recipients from an earlier real build (review is read-only —
    // we show them for context, not recompute them).
    const persisted = await db.retargetingRecipient.findMany({
      where: { campaignId: campaign.id },
      include: { contact: { select: { name: true, email: true, phone: true } } },
      orderBy: { id: "asc" },
      take: 200,
    });
    return ok({
      campaignId: campaign.id,
      type: campaign.type,
      channel: campaign.channel,
      dryRun: campaign.dryRun,
      segmentSummary: summary,
      availabilityWarnings,
      eligible: built.eligible,
      skipped: built.skipped,
      skippedSample: built.skippedSample,
      verdicts,
      persistedRecipients: persisted.map(serializeRetargetingRecipient),
    });
  } catch (e) {
    mapRetargetingError(e);
  }
});
