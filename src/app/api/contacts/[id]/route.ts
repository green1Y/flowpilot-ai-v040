import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { contactPatchSchema } from "@/lib/validation";
import { serializeContact } from "@/lib/serialize";
import { auditLog } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

/** Load a contact scoped to the caller's workspace (tenant isolation). */
async function scopedContact(workspaceId: string, id: string) {
  const contact = await db.contact.findFirst({ where: { id, workspaceId } });
  if (!contact) throw err("Contact not found", 404);
  return contact;
}

export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  const contact = await scopedContact(ctx.workspaceId, (await params).id);
  return ok({ contact: serializeContact(contact) });
});

export const PATCH = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Data mutation: AGENT+ only (ANALYST is read-only).
  requireRole(ctx, "AGENT");
  const before = await scopedContact(ctx.workspaceId, (await params).id);
  const body = await parseBody(req, contactPatchSchema);

  const data: Prisma.ContactUpdateInput = {};
  if (body.name !== undefined) data.name = body.name.trim();
  if (body.channel !== undefined) data.channel = body.channel;
  if (body.email !== undefined) data.email = body.email.trim().toLowerCase() || null;
  if (body.phone !== undefined) data.phone = body.phone.trim() || null;
  if (body.tags !== undefined) data.tags = JSON.stringify(body.tags);
  if (body.leadStatus !== undefined) data.leadStatus = body.leadStatus;
  if (body.leadScore !== undefined) data.leadScore = body.leadScore;
  if (body.customFields !== undefined) data.customFields = JSON.stringify(body.customFields);
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.assignedTo !== undefined) data.assignedTo = body.assignedTo;

  const updated = await db.contact.update({ where: { id: (await params).id }, data });
  const entity: Record<string, unknown> = { type: "contact", id: updated.id };
  // Record lead-stage transitions so the contact timeline can surface them.
  if (
    body.leadStatus !== undefined &&
    body.leadStatus !== before.leadStatus
  ) {
    entity.leadStageChange = { from: before.leadStatus, to: body.leadStatus };
  }
  await auditLog(ctx.workspaceId, ctx.userId, "contact.updated", entity);

  return ok({ contact: serializeContact(updated) });
});

export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Data mutation: AGENT+ only (ANALYST is read-only).
  requireRole(ctx, "AGENT");
  const contact = await scopedContact(ctx.workspaceId, (await params).id);

  // Conversations cascade-delete via the Prisma relation (onDelete: Cascade).
  await db.contact.delete({ where: { id: contact.id } });
  await auditLog(ctx.workspaceId, ctx.userId, "contact.deleted", {
    type: "contact",
    id: contact.id,
  });

  return ok({ ok: true });
});
