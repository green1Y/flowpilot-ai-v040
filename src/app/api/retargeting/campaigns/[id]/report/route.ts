import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import {
  retargetingReport,
  mapRetargetingError,
} from "@/lib/retargeting/campaigns";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/retargeting/campaigns/:id/report
 * Every metric is labeled measured / estimated / not_tracked.
 * Spend and ROAS are "not tracked" unless real provider data exists —
 * revenue is never invented.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  try {
    const report = await retargetingReport(ctx.workspaceId, (await params).id);
    return ok({ report });
  } catch (e) {
    mapRetargetingError(e);
  }
});
