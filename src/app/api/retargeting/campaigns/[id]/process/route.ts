import { NextRequest } from "next/server";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { z } from "zod";
import {
  processDueRetargeting,
  mapRetargetingError,
} from "@/lib/retargeting/campaigns";

type Ctx = { params: Promise<{ id: string }> };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * POST /api/retargeting/campaigns/:id/process?limit=50
 * Send the next rate-capped batch of pending recipients. MANAGER+.
 * (A scheduler/cron can call this on an interval for running campaigns.)
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const q = parseQuery(req, querySchema);
  try {
    const result = await processDueRetargeting(ctx.workspaceId, (await params).id, {
      userId: ctx.userId,
      limit: q.limit,
    });
    return ok({ result });
  } catch (e) {
    mapRetargetingError(e);
  }
});
