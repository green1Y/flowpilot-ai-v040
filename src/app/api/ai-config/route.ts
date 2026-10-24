import { NextRequest } from "next/server";
import type { AiConfig } from "@prisma/client";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { aiConfigSchema } from "@/lib/validation";
import { parseJson } from "@/lib/serialize";
import { auditLog } from "@/lib/audit";

/** AiConfig row → API shape (JSON string columns parsed for consumers). */
function serializeAiConfig(c: AiConfig) {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    assistantName: c.assistantName,
    businessName: c.businessName,
    businessDescription: c.businessDescription,
    brandVoice: c.brandVoice,
    tone: c.tone,
    responseLength: c.responseLength,
    languages: parseJson<string[]>(c.languages, ["en"]),
    businessHours: parseJson<Record<string, unknown>>(c.businessHours, {}),
    escalationRules: parseJson<Record<string, unknown>>(c.escalationRules, {}),
    confidenceThreshold: c.confidenceThreshold,
    requireApproval: c.requireApproval,
    fallbackResponse: c.fallbackResponse,
    prohibitedTopics: parseJson<string[]>(c.prohibitedTopics, []),
  };
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // One config per workspace — create the default row lazily.
  const config = await db.aiConfig.upsert({
    where: { workspaceId: ctx.workspaceId },
    update: {},
    create: { workspaceId: ctx.workspaceId },
  });
  const rawDocs = await db.knowledgeDoc.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "desc" },
  });
  // Stage 4c: expose per-doc chunk counts for the knowledge UI.
  const knowledgeDocs = await Promise.all(
    rawDocs.map(async (d) => ({
      ...d,
      chunkCount: await db.knowledgeChunk.count({ where: { docId: d.id } }),
    }))
  );
  return ok({ config: serializeAiConfig(config), knowledgeDocs });
});

export const PUT = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "MANAGER");
  const body = await parseBody(req, aiConfigSchema);

  const data = {
    assistantName: body.assistantName,
    businessName: body.businessName ?? "",
    businessDescription: body.businessDescription ?? "",
    brandVoice: body.brandVoice ?? "friendly",
    tone: body.tone ?? "professional",
    responseLength: body.responseLength,
    languages: JSON.stringify(body.languages ?? ["en"]),
    businessHours: JSON.stringify(body.businessHours ?? {}),
    escalationRules: JSON.stringify(body.escalationRules ?? {}),
    confidenceThreshold: body.confidenceThreshold,
    requireApproval: body.requireApproval,
    fallbackResponse: body.fallbackResponse,
    prohibitedTopics: JSON.stringify(body.prohibitedTopics ?? []),
  };

  const config = await db.aiConfig.upsert({
    where: { workspaceId: ctx.workspaceId },
    update: data,
    create: { workspaceId: ctx.workspaceId, ...data },
  });

  await auditLog(ctx.workspaceId, ctx.userId, "ai.config.updated", {
    type: "aiConfig",
    id: config.id,
  });

  return ok({ config: serializeAiConfig(config) });
});
