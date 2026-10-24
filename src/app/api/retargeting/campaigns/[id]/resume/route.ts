import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import {
  resumeRetargetingCampaign,
  mapRetargetingError,
} from "@/lib/retargeting/campaigns";
import { serializeRetargetingCampaign } from "@/lib/retargeting/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  try {
    const campaign = await resumeRetargetingCampaign(ctx.workspaceId, (await params).id, ctx.userId);
    return ok({ campaign: serializeRetargetingCampaign(campaign) });
  } catch (e) {
    mapRetargetingError(e);
  }
});
