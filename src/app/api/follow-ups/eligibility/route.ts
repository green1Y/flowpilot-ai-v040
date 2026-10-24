import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { checkEligibility } from "@/lib/messaging/eligibility";
import { isSuppressed, CHANNELS } from "@/lib/messaging/send";

const querySchema = z.object({
  contactId: z.string().min(1),
  channel: z.enum(CHANNELS),
  messageType: z.enum(["freeform", "template", "private_reply"]),
  commentId: z.string().min(1).optional(),
});

/**
 * Eligibility verdict WITHOUT sending — used by the composer to show a
 * green/red panel before the user hits Send. Pure read path.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const sp = new URL(req.url).searchParams;
  const parsed = querySchema.safeParse({
    contactId: sp.get("contactId") ?? undefined,
    channel: sp.get("channel") ?? undefined,
    messageType: sp.get("messageType") ?? undefined,
    commentId: sp.get("commentId") ?? undefined,
  });
  if (!parsed.success) {
    throw err("Validation failed", 422, {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const { contactId, channel, messageType, commentId } = parsed.data;

  const contact = await db.contact.findFirst({
    where: { id: contactId, workspaceId: ctx.workspaceId },
    select: { id: true, name: true, lastInboundAt: true },
  });
  if (!contact) throw err("Contact not found", 404);

  const suppressed = await isSuppressed(ctx.workspaceId, contactId, channel);

  let commentCreatedAt: Date | null = null;
  let privateRepliedAt: Date | null = null;
  if (messageType === "private_reply") {
    if (!commentId) {
      throw err("commentId is required for private_reply", 422);
    }
    const comment = await db.comment.findFirst({
      where: { externalId: commentId, workspaceId: ctx.workspaceId },
      select: { commentedAt: true, privateRepliedAt: true },
    });
    if (!comment) throw err("Comment not found", 404);
    commentCreatedAt = comment.commentedAt;
    privateRepliedAt = comment.privateRepliedAt;
  }

  const verdict = checkEligibility({
    channel,
    messageType,
    lastInboundAt: contact.lastInboundAt,
    commentCreatedAt,
    privateRepliedAt,
    suppressed,
  });

  return ok({
    contactId,
    contactName: contact.name,
    channel,
    messageType,
    suppressed,
    eligible: verdict.eligible,
    reasons: verdict.reasons,
    ineligibleReasons: verdict.ineligibleReasons,
    windowEndsAt: verdict.windowEndsAt?.toISOString() ?? null,
  });
});
