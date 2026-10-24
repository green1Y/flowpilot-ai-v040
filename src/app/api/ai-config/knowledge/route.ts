import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { knowledgeDocSchema } from "@/lib/validation";
import { auditLog } from "@/lib/audit";
import { indexDocument } from "@/lib/ai/chunks";

// The doc list is included in GET /api/ai-config.
export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "AGENT");
  const body = await parseBody(req, knowledgeDocSchema);

  const doc = await db.knowledgeDoc.create({
    data: {
      workspaceId: ctx.workspaceId,
      title: body.title.trim(),
      content: body.content,
    },
  });

  // Stage 4c: chunk the doc so retrieval can ground AI replies.
  const chunkCount = await indexDocument(doc.id);

  await auditLog(ctx.workspaceId, ctx.userId, "ai.knowledge.created", {
    type: "knowledgeDoc",
    id: doc.id,
    chunkCount,
  });

  return ok({ doc: { ...doc, chunkCount } }, { status: 201 });
});
