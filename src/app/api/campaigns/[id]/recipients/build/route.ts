import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { buildRecipients } from "@/lib/messaging/campaigns";
import {
  scopedCampaign,
  mapSendError,
} from "@/app/api/campaigns/campaign-helpers";

const buildSchema = z.object({
  /** Optional ContactSegment id — when omitted the legacy campaign.audience JSON is used. */
  segmentId: z.string().min(1).max(64).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

/**
 * Build (or rebuild) the recipient list: resolve contacts from the segment
 * (or legacy audience), evaluate suppression + eligibility per contact, and
 * create CampaignRecipient rows — PENDING when eligible, SKIPPED with
 * human-readable reasons when not. Idempotent: existing rows are kept.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Launch-control / send-adjacent action: MANAGER+.
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, buildSchema);
  await scopedCampaign(ctx.workspaceId, (await params).id);
  try {
    const result = await buildRecipients(ctx.workspaceId, (await params).id, {
      segmentId: body.segmentId ?? null,
      userId: ctx.userId,
    });
    return ok({ build: result });
  } catch (e) {
    mapSendError(e);
  }
});
