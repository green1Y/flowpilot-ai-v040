import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { retryFailedRecipients } from "@/lib/messaging/campaigns";
import {
  scopedCampaign,
  mapSendError,
} from "@/app/api/campaigns/campaign-helpers";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Reset FAILED recipients back to PENDING so the next process batch retries
 * them (eligibility is re-checked at send time). Retryable provider errors
 * (429/5xx, marked "(retryable)") are the intended use case.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Launch-control / send-adjacent action: MANAGER+.
  requireRole(ctx, "MANAGER");
  await scopedCampaign(ctx.workspaceId, (await params).id);
  try {
    const result = await retryFailedRecipients(ctx.workspaceId, (await params).id, ctx.userId);
    return ok({ retry: result });
  } catch (e) {
    mapSendError(e);
  }
});
