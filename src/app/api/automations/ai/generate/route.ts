import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import {
  runCopilotOp,
  CopilotRateLimitedError,
  type CopilotOp,
} from "@/lib/copilot/service";
import { AiNotConfiguredError, AiTimeoutError, isAiConfigured } from "@/lib/ai/structured";

/**
 * AI workflow copilot.
 *
 * GET  /api/automations/ai/generate → { configured, provider, mocked }
 *      Honest capability probe for the UI badge (no generation, no secrets).
 *
 * POST /api/automations/ai/generate
 *   { op, prompt, answers?, workflowId?, executionId?, locale? }
 *
 * Ops:
 *   generate            → { questions } | { spec, repaired, mocked: false }
 *   explain             → { text }
 *   diagnose            → { text }  (last failed execution, workspace-scoped)
 *   add_condition/delay/error_handling → { spec } (fragment to append)
 *   translate           → { text }  (JSON { labels } for the UI to apply)
 *
 * Honesty contract: when no AI provider is configured the route answers
 * 503 AI_PROVIDER_NOT_CONFIGURED — the mock provider is never used to fake
 * generations. All ops are workspace-scoped (server-enforced tenant
 * isolation); nothing here mutates workflows — the client applies accepted
 * previews through the normal undoable canvas path.
 */

const copilotBodySchema = z.object({
  op: z.enum([
    "generate",
    "explain",
    "diagnose",
    "add_condition",
    "add_delay",
    "add_error_handling",
    "translate",
  ]),
  prompt: z.string().max(4000).default(""),
  answers: z.record(z.string()).optional(),
  workflowId: z.string().max(64).optional(),
  executionId: z.string().max(64).optional(),
  locale: z.enum(["en", "ar"]).optional(),
});

export const GET = handler(async (req: NextRequest) => {
  await requireWorkspace(req);
  const configured = isAiConfigured();
  return ok({
    configured,
    provider: configured ? process.env.AI_PROVIDER || "openai" : "none",
    mocked: false,
    message: configured
      ? null
      : "AI provider not configured — set OPENAI_API_KEY (see INTEGRATIONS_SETUP.md)",
  });
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Copilot output becomes workflow content: AGENT+ only (ANALYST read-only).
  requireRole(ctx, "AGENT");
  const body = await parseBody(req, copilotBodySchema);

  try {
    const result = await runCopilotOp({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      op: body.op as CopilotOp,
      prompt: body.prompt ?? "",
      answers: body.answers,
      workflowId: body.workflowId,
      executionId: body.executionId,
      locale: body.locale,
    });

    await auditLog(ctx.workspaceId, ctx.userId, "copilot.generate", {
      type: "copilot",
      op: body.op,
      kind: result.kind,
    });

    return ok(result);
  } catch (e) {
    if (e instanceof AiNotConfiguredError) {
      return err(e.message, 503, { code: e.code });
    }
    if (e instanceof CopilotRateLimitedError) {
      return err(e.message, 429, { code: e.code });
    }
    if (e instanceof AiTimeoutError) {
      return err(e.message, 504, { code: e.code });
    }
    const withStatus = e as Error & { status?: number };
    if (withStatus.status === 404) return err("Workflow not found", 404);
    if (e instanceof Error && /Empty prompt/i.test(e.message)) {
      return err("Describe the automation you want first.", 422);
    }
    throw e;
  }
});
