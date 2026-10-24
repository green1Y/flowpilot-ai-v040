import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { contactSchema } from "@/lib/validation";
import { serializeContact } from "@/lib/serialize";
import { auditLog } from "@/lib/audit";
import {
  applyContactFilters,
  filtersFromQuery,
  filtersFromSegmentJson,
} from "@/lib/contacts/filters";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const sp = new URL(req.url).searchParams;

  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") ?? "20", 10) || 20));

  const where: Prisma.ContactWhereInput = { workspaceId: ctx.workspaceId };

  // Saved segment: loads stored filters (tenant-scoped) and merges them
  // under any explicit query params, which win on conflict.
  const segmentId = sp.get("segmentId");
  if (segmentId) {
    const segment = await db.contactSegment.findFirst({
      where: { id: segmentId, workspaceId: ctx.workspaceId },
    });
    if (!segment) throw err("Segment not found", 404);
    applyContactFilters(where, filtersFromSegmentJson(segment.filters));
  }
  const queryFilters = filtersFromQuery(sp);
  applyContactFilters(where, {
    channel: queryFilters.channel,
    tag: queryFilters.tag,
    leadStatus: queryFilters.leadStatus,
    search: queryFilters.search,
    from: queryFilters.from,
    to: queryFilters.to,
  });

  const [total, items] = await Promise.all([
    db.contact.count({ where }),
    db.contact.findMany({
      where,
      orderBy: { firstSeenAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return ok({ items: items.map(serializeContact), total, page, pageSize });
});

const contactCreateSchema = contactSchema.extend({ force: z.boolean().optional() });

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Data mutation: AGENT+ only (ANALYST is read-only).
  requireRole(ctx, "AGENT");
  const body = await parseBody(req, contactCreateSchema);

  const name = body.name.trim();
  const channel = body.channel || "web";
  const email = body.email?.trim().toLowerCase() || null;

  // Duplicate detection: same email, or same name+channel, within the workspace.
  if (!body.force) {
    let existing = null;
    if (email) {
      existing = await db.contact.findFirst({
        where: { workspaceId: ctx.workspaceId, email },
      });
    }
    if (!existing) {
      existing = await db.contact.findFirst({
        where: { workspaceId: ctx.workspaceId, name, channel },
      });
    }
    if (existing) {
      throw err("A matching contact already exists in this workspace", 409, {
        duplicate: true,
        existing: serializeContact(existing),
      });
    }
  }

  const contact = await db.contact.create({
    data: {
      workspaceId: ctx.workspaceId,
      name,
      channel,
      email,
      phone: body.phone?.trim() || null,
      tags: JSON.stringify(body.tags ?? []),
      leadStatus: body.leadStatus,
      leadScore: body.leadScore,
      customFields: JSON.stringify(body.customFields ?? {}),
      notes: body.notes ?? "",
      assignedTo: body.assignedTo,
    },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "contact.created", {
    type: "contact",
    id: contact.id,
  });

  return ok({ contact: serializeContact(contact) }, { status: 201 });
});
