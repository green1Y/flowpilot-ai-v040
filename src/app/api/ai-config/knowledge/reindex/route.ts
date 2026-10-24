import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { indexDocument } from "@/lib/ai/chunks";

/**
 * POST /api/ai-config/knowledge/reindex
 * Backfills the chunk index for every knowledge doc in the workspace —
 * used for docs created before chunking existed (Stage 4c).
 */
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");

  const docs = await db.knowledgeDoc.findMany({
    where: { workspaceId: ctx.workspaceId },
    select: { id: true, title: true },
  });

  const results: Array<{ id: string; title: string; chunkCount: number }> = [];
  for (const d of docs) {
    const chunkCount = await indexDocument(d.id);
    results.push({ id: d.id, title: d.title, chunkCount });
  }

  await auditLog(ctx.workspaceId, ctx.userId, "ai.knowledge.reindexed", {
    type: "knowledgeReindex",
    docs: docs.length,
    chunks: results.reduce((n, r) => n + r.chunkCount, 0),
  });

  return ok({ docs: results });
});
