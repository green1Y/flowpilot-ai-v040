import { NextRequest } from "next/server";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { executeSchema } from "@/lib/validation";
import { executeWorkflow } from "@/lib/workflows/engine";
import { ensureWorkflowWorker } from "@/lib/workflows/worker";
import { getScopedWorkflow } from "../../helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

// Start the background worker when this route module loads so the dev
// server processes workflow jobs without any extra setup.
ensureWorkflowWorker();

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const wctx = await requireWorkspace(req);
  // Executing a workflow sends real messages/actions: MANAGER+.
  requireRole(wctx, "MANAGER");
  const { workspaceId } = wctx;
  const workflow = await getScopedWorkflow(workspaceId, (await ctx.params).id);
  const body = await parseBody(req, executeSchema);

  ensureWorkflowWorker();
  let result;
  try {
    result = await executeWorkflow({
      workflowId: workflow.id,
      workspaceId,
      event: body.event,
      idempotencyKey: body.idempotencyKey,
      dryRun: body.dryRun,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The engine refuses to run DRAFT/PAUSED workflows — surface that as a
    // 409 with the real reason instead of a generic 500.
    if (/DRAFT|PAUSED/i.test(message)) throw err(message, 409);
    throw e;
  }

  return ok(result, { status: result.duplicate ? 200 : 202 });
});
