import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";
import { withWorkflowSlot } from "@/lib/billing/usage";
import { serializeWorkflow, getScopedWorkflow, freshId } from "../../helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const wctx = await requireWorkspace(req);
  // Data mutation: AGENT+ only (ANALYST is read-only).
  requireRole(wctx, "AGENT");
  const { workspaceId, userId } = wctx;
  const workflow = await getScopedWorkflow(workspaceId, (await ctx.params).id);

  const idMap = new Map<string, string>();
  const nodes = workflow.nodes.map((n) => {
    const newId = freshId("n");
    idMap.set(n.id, newId);
    return {
      id: newId,
      kind: n.kind,
      type: n.type,
      label: n.label,
      config: n.config,
      position: n.position,
    };
  });
  const edges = workflow.edges.map((e) => ({
    id: freshId("e"),
    sourceId: idMap.get(e.sourceId) ?? e.sourceId,
    targetId: idMap.get(e.targetId) ?? e.targetId,
    label: e.label,
    condition: e.condition,
  }));

  // Duplicating creates a NEW defined workflow, so it consumes a
  // workflow slot under the same atomic limit as POST /api/workflows.
  const copy = await withWorkflowSlot(workspaceId, (tx) =>
    tx.workflow.create({
      data: {
        workspaceId,
        name: `${workflow.name} (copy)`,
        description: workflow.description,
        status: "DRAFT",
        version: 1,
        nodes: { create: nodes },
        edges: { create: edges },
      },
      include: { nodes: true, edges: true },
    })
  );

  await auditLog(workspaceId, userId, "workflow.duplicate", {
    type: "workflow",
    id: copy.id,
    sourceId: workflow.id,
  });

  return ok(serializeWorkflow(copy), { status: 201 });
});
