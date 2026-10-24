import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";

const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

/** Cancel a SCHEDULED follow-up. Terminal states cannot be cancelled. */
export const POST = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const wctx = await requireWorkspace(req);
    // Data mutation: AGENT+ only (ANALYST is read-only).
    requireRole(wctx, "AGENT");
    // Lenient body: cancel works with an empty body too.
    let reason: string | undefined;
    try {
      const raw = await req.text();
      if (raw.trim()) {
        const parsed = cancelSchema.safeParse(JSON.parse(raw));
        if (parsed.success) reason = parsed.data.reason;
      }
    } catch {
      // Ignore malformed bodies — default reason applies.
    }

    const followUp = await db.followUp.findFirst({
      where: { id: (await ctx.params).id, workspaceId: wctx.workspaceId },
    });
    if (!followUp) throw err("Follow-up not found", 404);
    if (followUp.status !== "SCHEDULED") {
      throw err(`Only SCHEDULED follow-ups can be cancelled (status: ${followUp.status})`, 422);
    }

    const updated = await db.followUp.update({
      where: { id: followUp.id },
      data: {
        status: "CANCELLED",
        cancelReason: reason?.trim() || "cancelled by user",
      },
    });

    await auditLog(wctx.workspaceId, wctx.userId, "followup.cancelled", {
      type: "followup",
      id: followUp.id,
      contactId: followUp.contactId,
      reason: updated.cancelReason,
    });

    return ok({ followUp: { id: updated.id, status: updated.status, cancelReason: updated.cancelReason } });
  }
);
