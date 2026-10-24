import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";

/** GET /api/ai-config/escalations?status=OPEN|RESOLVED|ALL — the AI escalation queue. */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const statusParam = new URL(req.url).searchParams.get("status");
  const status = statusParam === "OPEN" || statusParam === "RESOLVED" ? statusParam : "ALL";

  const rows = await db.escalation.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(status === "ALL" ? {} : { status }),
    },
    include: {
      contact: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return ok({
    escalations: rows.map((e) => ({
      id: e.id,
      conversationId: e.conversationId,
      contact: e.contact,
      reason: e.reason,
      status: e.status,
      createdAt: e.createdAt,
      resolvedAt: e.resolvedAt,
    })),
  });
});
