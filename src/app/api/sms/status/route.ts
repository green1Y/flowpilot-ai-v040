import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { getSmsStatus } from "@/lib/sms/providers";

/** SMS status (Wave 2D). Any workspace member may read it; it never sends. */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  return ok({ sms: getSmsStatus(), workspaceId: ctx.workspaceId });
});
