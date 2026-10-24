import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { simulateWorkflow } from "@/lib/workflows/simulate";
import { getScopedWorkflow } from "../../helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

const simulateSchema = z.object({
  sampleEvent: z.record(z.unknown()).default({}),
});

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const { workspaceId, userId } = await requireWorkspace(req);
  // getScopedWorkflow throws 404 when the workflow is not in this workspace.
  const workflow = await getScopedWorkflow(workspaceId, (await ctx.params).id);
  const body = await parseBody(req, simulateSchema);

  const result = await simulateWorkflow(workflow.id, workspaceId, body.sampleEvent ?? {});

  // The simulation itself writes nothing; this audit entry is the only
  // record, matching how "workflow.simulated" runs are tracked.
  await auditLog(workspaceId, userId, "workflow.simulated", {
    workflowId: workflow.id,
    workflowName: workflow.name,
    matched: result.matched,
    wouldSend: result.wouldSend,
    steps: result.path.length,
    messages: result.messages.length,
    errors: result.errors.length,
    warnings: result.warnings.length,
  });

  return ok(result);
});
