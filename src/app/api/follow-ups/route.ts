import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import {
  sendFollowUp,
  newIdempotencyKey,
  SendError,
  CHANNELS,
} from "@/lib/messaging/send";
import { requirePlanLimit } from "@/lib/billing/usage";

const channelEnum = z.enum(CHANNELS);
const messageTypeEnum = z.enum(["freeform", "template", "private_reply"]);

function serialize(fu: {
  id: string; contactId: string; channel: string; messageType: string;
  templateId: string | null; body: string; commentId: string | null;
  scheduledAt: Date; status: string; sentAt: Date | null;
  cancelReason: string | null; createdAt: Date; createdBy: string | null;
}) {
  return {
    id: fu.id,
    contactId: fu.contactId,
    channel: fu.channel,
    messageType: fu.messageType,
    templateId: fu.templateId,
    body: fu.body,
    commentId: fu.commentId,
    scheduledAt: fu.scheduledAt.toISOString(),
    status: fu.status,
    sentAt: fu.sentAt?.toISOString() ?? null,
    cancelReason: fu.cancelReason,
    createdAt: fu.createdAt.toISOString(),
    createdBy: fu.createdBy,
  };
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const sp = new URL(req.url).searchParams;

  const where: { workspaceId: string; status?: string; contactId?: string } = {
    workspaceId: ctx.workspaceId,
  };
  const status = sp.get("status");
  if (status) where.status = status;
  const contactId = sp.get("contactId");
  if (contactId) where.contactId = contactId;

  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") ?? "20", 10) || 20));

  const [total, items] = await Promise.all([
    db.followUp.count({ where }),
    db.followUp.findMany({
      where,
      orderBy: { scheduledAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { contact: { select: { id: true, name: true } } },
    }),
  ]);

  return ok({
    items: items.map((f) => ({
      ...serialize(f),
      contactName: f.contact?.name ?? null,
    })),
    total, page, pageSize,
  });
});

const createSchema = z.object({
  contactId: z.string().min(1),
  channel: channelEnum,
  messageType: messageTypeEnum,
  templateId: z.string().min(1).optional(),
  body: z.string().max(4096).optional(),
  commentId: z.string().min(1).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Data mutation: AGENT+ only (ANALYST is read-only).
  requireRole(ctx, "AGENT");
  const parsed = await parseBody(req, createSchema);

  const contact = await db.contact.findFirst({
    where: { id: parsed.contactId, workspaceId: ctx.workspaceId },
  });
  if (!contact) throw err("Contact not found", 404);

  if (parsed.templateId) {
    const template = await db.messageTemplate.findFirst({
      where: { id: parsed.templateId, workspaceId: ctx.workspaceId },
    });
    if (!template) throw err("Message template not found", 404);
    if (template.channel !== parsed.channel) {
      throw err(
        `Template channel (${template.channel}) does not match the send channel (${parsed.channel})`,
        422
      );
    }
  }
  if (!parsed.templateId && !parsed.body?.trim()) {
    throw err("Either templateId or body is required", 422);
  }
  if (parsed.messageType === "private_reply" && !parsed.commentId) {
    throw err("commentId is required for private_reply", 422);
  }
  if (parsed.messageType === "template" && parsed.channel !== "whatsapp") {
    throw err("Templates are only supported on WhatsApp in this version", 422);
  }

  const idempotencyKey = parsed.idempotencyKey ?? newIdempotencyKey();

  // Idempotent create: a retry with the same key returns the existing row.
  const existing = await db.followUp.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.workspaceId !== ctx.workspaceId) {
      throw err("Idempotency key already in use", 409);
    }
    return ok({ followUp: serialize(existing), duplicate: true });
  }

  const scheduledAt = parsed.scheduledAt ? new Date(parsed.scheduledAt) : new Date();
  // No scheduledAt, or a time already passed → send immediately through the
  // pipeline. A future scheduledAt creates a SCHEDULED row for the worker.
  const immediate = !parsed.scheduledAt || scheduledAt.getTime() <= Date.now();

  const followUp = await db.followUp.create({
    data: {
      workspaceId: ctx.workspaceId,
      contactId: contact.id,
      channel: parsed.channel,
      messageType: parsed.messageType,
      templateId: parsed.templateId ?? null,
      body: parsed.body?.trim() ?? "",
      commentId: parsed.commentId ?? null,
      scheduledAt,
      status: "SCHEDULED",
      idempotencyKey,
      createdBy: ctx.userId,
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "followup.created", {
    type: "followup", id: followUp.id, contactId: contact.id,
    channel: parsed.channel, immediate,
  });

  if (immediate) {
    // Stage 4d: enforce the plan message limit before an actual send.
    // (Future-scheduled follow-ups are checked when they process.)
    await requirePlanLimit(ctx.workspaceId, "messages");
    // Send right now through the pipeline (re-checks eligibility, records
    // the attempt, marks the follow-up SENT/FAILED/CANCELLED).
    try {
      const result = await sendFollowUp({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        contactId: contact.id,
        channel: parsed.channel,
        messageType: parsed.messageType,
        templateId: parsed.templateId,
        body: parsed.body,
        commentId: parsed.commentId,
        idempotencyKey,
        followUpId: followUp.id,
      });
      const updated = await db.followUp.findUnique({ where: { id: followUp.id } });
      return ok({ followUp: serialize(updated!), duplicate: false, send: result });
    } catch (e) {
      const updated = await db.followUp.findUnique({ where: { id: followUp.id } });
      if (e instanceof SendError) {
        throw err(e.message, e.status, { followUp: serialize(updated!), ...e.extra });
      }
      throw e;
    }
  }

  return ok({ followUp: serialize(followUp), duplicate: false }, { status: 201 });
});
