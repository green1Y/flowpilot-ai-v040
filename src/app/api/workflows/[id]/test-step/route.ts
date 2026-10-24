import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { NODE_TYPES } from "@/lib/workflows/nodeRegistry";
import { evaluateCondition, evaluateIfElseExpression } from "@/lib/workflows/engine";
import { getScopedWorkflow } from "../../helpers";

/**
 * Test a single condition/flow node against a sample event.
 * Pure evaluation — no side effects, no sends, no DB writes.
 * Supports condition.* nodes and flow.if_else.
 */

interface Ctx {
  params: Promise<{ id: string }>;
}

const testStepSchema = z.object({
  nodeType: z.string().min(1).max(80),
  config: z.record(z.unknown()).default({}),
  event: z.record(z.unknown()).default({}),
});

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const wctx = await requireWorkspace(req);
  requireRole(wctx, "AGENT");
  await getScopedWorkflow(wctx.workspaceId, (await ctx.params).id); // 404 when not in this workspace
  const body = await parseBody(req, testStepSchema);

  const def = NODE_TYPES[body.nodeType];
  if (!def) return err(`Unknown node type "${body.nodeType}"`, 422);
  if (def.kind !== "condition" && body.nodeType !== "flow.if_else") {
    return err("Test Step is only supported for condition nodes and If / Else", 422);
  }
  const cfgParsed = def.configSchema.safeParse({ ...def.defaults, ...body.config });
  if (!cfgParsed.success) {
    const issue = cfgParsed.error.issues[0];
    return err(
      `Invalid config: ${issue.path.join(".") || "config"}: ${issue.message}`,
      422
    );
  }
  const config = cfgParsed.data as Record<string, unknown>;
  const event = body.event ?? {};

  let matched: boolean;
  let note: string | undefined;
  if (body.nodeType === "flow.if_else") {
    const r = evaluateIfElseExpression(
      String(config.expression ?? ""),
      event
    );
    matched = r.result;
    note = r.note;
  } else {
    matched = evaluateCondition(body.nodeType, config, event);
  }

  return ok({ matched, note: note ?? null, mocked: false });
});
