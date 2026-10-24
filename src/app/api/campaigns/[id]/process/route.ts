import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { processCampaign } from "@/lib/messaging/campaigns";
import {
  scopedCampaign,
  mapSendError,
} from "@/app/api/campaigns/campaign-helpers";

const processSchema = z.object({
  batchSize: z.number().int().min(1).max(200).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

/**
 * Process one batch of a RUNNING campaign (the endpoint the scheduler/cron
 * hits repeatedly). Re-checks eligibility per recipient at send time and
 * completes the campaign when no PENDING recipients remain.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Launch-control / send-adjacent action: MANAGER+.
  requireRole(ctx, "MANAGER");
  // Body is optional — an empty POST processes the default batch size.
  let body: { batchSize?: number } = {};
  const raw = (await req.text()).trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw err("Invalid JSON body", 400);
    }
    const checked = processSchema.safeParse(parsed);
    if (!checked.success) throw err("Validation failed", 422);
    body = checked.data;
  }
  await scopedCampaign(ctx.workspaceId, (await params).id);
  try {
    const result = await processCampaign(ctx.workspaceId, (await params).id, {
      batchSize: body.batchSize,
      userId: ctx.userId,
    });
    return ok({ process: result });
  } catch (e) {
    mapSendError(e);
  }
});
