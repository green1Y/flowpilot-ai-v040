import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";

/** Summarize the audit entity JSON into a short human-readable body. */
function summarizeEntity(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { type?: string; id?: string };
    if (parsed && typeof parsed === "object" && parsed.type) {
      return parsed.id ? `${parsed.type} · ${parsed.id}` : parsed.type;
    }
  } catch {
    // Fall through to the raw slice below.
  }
  return raw.slice(0, 120);
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const events = await db.auditEvent.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  return ok({
    notifications: events.map((e) => ({
      id: e.id,
      title: e.action,
      body: summarizeEntity(e.entity),
      createdAt: e.createdAt,
    })),
  });
});
