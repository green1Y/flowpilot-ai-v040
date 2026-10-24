import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().trim().min(1).max(120).optional(),
});

function safeEntity(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Recent audit history for this workspace (tenant-scoped). Any member can
 * read; the entity JSON is parsed server-side. `action` filters by prefix
 * (e.g. `action=auth` for security events).
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const q = parseQuery(req, querySchema);

  const events = await db.auditEvent.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(q.action ? { action: { startsWith: q.action } } : {}),
    },
    include: { actor: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: q.limit,
  });

  return ok({
    events: events.map((e) => ({
      id: e.id,
      action: e.action,
      entity: safeEntity(e.entity),
      actor: e.actor ? { id: e.actor.id, name: e.actor.name, email: e.actor.email } : null,
      createdAt: e.createdAt.toISOString(),
    })),
  });
});
