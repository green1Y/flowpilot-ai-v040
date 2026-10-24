import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { validateWorkflow } from "@/lib/workflows/validate";
import { executeWorkflow } from "@/lib/workflows/engine";
import { ensureWorkflowWorker } from "@/lib/workflows/worker";
import { getScopedWorkflow } from "../../helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

const testSchema = z.object({
  event: z.record(z.unknown()),
});

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const wctx = await requireWorkspace(req);
  // Dry-run test: AGENT+ only (ANALYST is read-only).
  requireRole(wctx, "AGENT");
  const { workspaceId } = wctx;
  const workflow = await getScopedWorkflow(workspaceId, (await ctx.params).id);
  const body = await parseBody(req, testSchema);

  const { valid, errors } = validateWorkflow(
    workflow.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      type: n.type,
      label: n.label,
      config: JSON.parse(n.config || "{}"),
    })),
    workflow.edges.map((e) => ({ id: e.id, sourceId: e.sourceId, targetId: e.targetId, label: e.label ?? "" }))
  );
  if (!valid) {
    throw err("Workflow is not valid — fix the errors before testing", 422, { errors });
  }

  ensureWorkflowWorker();
  const { executionId } = await executeWorkflow({
    workflowId: workflow.id,
    workspaceId,
    event: body.event,
    dryRun: true,
    idempotencyKey: `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  });

  return ok({
    executionId,
    dryRun: true,
    note: "Dry run — no external actions performed",
  });
});
