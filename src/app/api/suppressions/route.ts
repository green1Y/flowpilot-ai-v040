import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { CHANNELS } from "@/lib/messaging/send";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const sp = new URL(req.url).searchParams;
  const contactId = sp.get("contactId");

  const rows = await db.suppression.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(contactId ? { contactId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500, // perf: hard cap on the suppression list
    include: { contact: { select: { id: true, name: true } } },
  });

  return ok({
    items: rows.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      contactName: r.contact?.name ?? null,
      channel: r.channel,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

const createSchema = z.object({
  contactId: z.string().min(1),
  channel: z.enum(CHANNELS).nullable().optional(),
  reason: z.string().max(500).optional(),
});

/**
 * Suppress a contact: no channel (null) = all channels, otherwise only that
 * channel. Any suppression row makes the contact ineligible for outbound
 * messaging (see the eligibility checker).
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "AGENT");
  const parsed = await parseBody(req, createSchema);

  const contact = await db.contact.findFirst({
    where: { id: parsed.contactId, workspaceId: ctx.workspaceId },
  });
  if (!contact) throw err("Contact not found", 404);

  const channel = parsed.channel ?? null;
  // Note: SQLite treats NULL as distinct in unique indexes, so we check
  // with findFirst instead of relying on the @@unique constraint.
  const existing = await db.suppression.findFirst({
    where: { workspaceId: ctx.workspaceId, contactId: contact.id, channel },
  });
  if (existing) {
    return ok({ suppression: { id: existing.id }, duplicate: true });
  }

  const suppression = await db.suppression.create({
    data: {
      workspaceId: ctx.workspaceId,
      contactId: contact.id,
      channel,
      reason: parsed.reason?.trim() ?? "",
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "suppression.created", {
    type: "suppression", id: suppression.id, contactId: contact.id, channel,
  });

  return ok(
    {
      suppression: {
        id: suppression.id,
        contactId: suppression.contactId,
        channel: suppression.channel,
        reason: suppression.reason,
      },
      duplicate: false,
    },
    { status: 201 }
  );
});
