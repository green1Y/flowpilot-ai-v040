import { NextRequest } from "next/server";
import { handler, ok, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import {
  launchRetargetingCampaign,
  mapRetargetingError,
} from "@/lib/retargeting/campaigns";
import { launchSchema } from "@/lib/retargeting/schemas";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/retargeting/campaigns/:id/launch  { confirmed: true }
 * MANAGER+ only. For paid_ad this returns the Meta setup checklist +
 * audience CSV — it never creates ads/audiences or fabricates ad ids.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, launchSchema);
  try {
    const result = await launchRetargetingCampaign(ctx.workspaceId, (await params).id, {
      userId: ctx.userId,
      confirmed: body.confirmed,
    });
    return ok(result);
  } catch (e) {
    mapRetargetingError(e);
  }
});
