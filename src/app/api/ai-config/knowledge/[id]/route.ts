import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { knowledgeDocSchema } from "@/lib/validation";
import { auditLog } from "@/lib/audit";
import { indexDocument } from "@/lib/ai/chunks";

const knowledgeDocUpdateSchema = knowledgeDocSchema.partial().refine(
  (b) => b.title !== undefined || b.content !== undefined,
  { message: "Provide title and/or content to update" }
);

/** Update title/content; re-indexes chunks when the content changes. */
export const PATCH = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
    requireRole(ctx, "AGENT");
    const body = await parseBody(req, knowledgeDocUpdateSchema);

    const data: { title?: string; content?: string } = {};
    if (body.title !== undefined) data.title = body.title.trim();
    if (body.content !== undefined) data.content = body.content;

    const updated = await db.knowledgeDoc.updateMany({
      where: { id: (await params).id, workspaceId: ctx.workspaceId },
      data,
    });
    if (updated.count === 0) throw err("Knowledge doc not found", 404);

    let chunkCount: number | undefined;
    if (body.content !== undefined) {
      // Stage 4c: rebuild chunks so retrieval reflects the new content.
      chunkCount = await indexDocument((await params).id);
    } else {
      chunkCount = await db.knowledgeChunk.count({ where: { docId: (await params).id } });
    }

    const doc = await db.knowledgeDoc.findUnique({ where: { id: (await params).id } });

    await auditLog(ctx.workspaceId, ctx.userId, "ai.knowledge.updated", {
      type: "knowledgeDoc",
      id: (await params).id,
      ...(chunkCount !== undefined ? { chunkCount } : {}),
    });

    return ok({ doc: doc ? { ...doc, chunkCount } : null });
  }
);

export const DELETE = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireWorkspace(req);
    requireRole(ctx, "AGENT");
    const deleted = await db.knowledgeDoc.deleteMany({
      where: { id: (await params).id, workspaceId: ctx.workspaceId },
    });
    if (deleted.count === 0) throw err("Knowledge doc not found", 404);

    await auditLog(ctx.workspaceId, ctx.userId, "ai.knowledge.deleted", {
      type: "knowledgeDoc",
      id: (await params).id,
    });

    return ok({ ok: true });
  }
);
