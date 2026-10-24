import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/api";
import { requireRole, requireWorkspace } from "@/lib/tenancy";
import { generateReply, buildSystemPrompt } from "@/lib/ai/providers";
import { retrieveKnowledge, chunkToSnippet } from "@/lib/ai/retrieval";
import { parseJson } from "@/lib/serialize";
import { auditLog } from "@/lib/audit";

const testSchema = z.object({
  question: z.string().min(1).max(2000),
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  requireRole(ctx, "AGENT");
  const body = await parseBody(req, testSchema);

  const config = await db.aiConfig.upsert({
    where: { workspaceId: ctx.workspaceId },
    update: {},
    create: { workspaceId: ctx.workspaceId },
  });
  // Stage 4c: retrieve the most relevant knowledge chunks for the test
  // question so the playground shows real grounding, like live replies do.
  const retrieved = await retrieveKnowledge(ctx.workspaceId, body.question, 4);

  const systemPrompt = buildSystemPrompt({
    assistantName: config.assistantName,
    businessName: config.businessName,
    businessDescription: config.businessDescription,
    brandVoice: config.brandVoice,
    tone: config.tone,
    responseLength: config.responseLength,
    fallbackResponse: config.fallbackResponse,
    prohibitedTopics: parseJson<string[]>(config.prohibitedTopics, []),
  });

  const knowledgeSnippets = retrieved.map(chunkToSnippet);
  const result = await generateReply({
    systemPrompt,
    userMessage: body.question,
    knowledgeSnippets,
  });

  // De-duplicated source titles, in relevance order, for the playground UI.
  const sources = [...new Set(retrieved.map((r) => r.docTitle))];

  await auditLog(ctx.workspaceId, ctx.userId, "ai.test", {
    type: "aiTest",
    question: body.question.slice(0, 120),
    sources,
  });

  return ok({
    reply: result.text,
    mocked: result.mocked,
    confidence: result.confidence,
    // Which chunks grounded the answer (shown in the playground).
    snippets: knowledgeSnippets,
    sources,
    // Pass through what the provider claims it used; honest when snippets ran dry.
    sourcesUsed: result.sourcesUsed,
  });
});
