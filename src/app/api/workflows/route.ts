import { NextRequest } from "next/server";
import { handler, ok, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/audit";
import { workflowCreateSchema } from "@/lib/validation";
import { withWorkflowSlot } from "@/lib/billing/usage";
import { serializeWorkflow, freshId } from "./helpers";

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const search = searchParams.get("search");

  const workflows = await db.workflow.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(status ? { status } : {}),
      ...(search ? { name: { contains: search } } : {}),
    },
    include: {
      _count: { select: { executions: true, nodes: true, edges: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 500, // perf: hard cap; workflow lists are user-managed and small
  });

  return ok(
    workflows.map((w) => {
      const s = serializeWorkflow(w);
      return { ...s, runCount: w._count.executions, nodeCount: w._count.nodes, edgeCount: w._count.edges };
    })
  );
});

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Data mutation: AGENT+ only (ANALYST is read-only).
  requireRole(ctx, "AGENT");
  const body = await parseBody(req, workflowCreateSchema);

  // Remap client ids to fresh ids so templates can be instantiated repeatedly.
  const idMap = new Map<string, string>();
  const nodes = (body.nodes ?? []).map((n) => {
    const newId = freshId("n");
    idMap.set(n.id, newId);
    return {
      id: newId,
      kind: n.kind,
      type: n.type,
      label: n.label,
      config: JSON.stringify(n.config ?? {}),
      position: JSON.stringify(n.position ?? { x: 0, y: 0 }),
    };
  });
  const edges = (body.edges ?? []).map((e) => ({
    id: freshId("e"),
    sourceId: idMap.get(e.sourceId) ?? e.sourceId,
    targetId: idMap.get(e.targetId) ?? e.targetId,
    label: e.label ?? "",
    condition: JSON.stringify(e.condition ?? {}),
  }));

  // Plan limit: workflowLimit caps DEFINED workflows. The count and the
  // insert happen inside one transaction (Batch C) so concurrent creates
  // cannot race past the cap; at the cap this throws the honest 402.
  const workflow = await withWorkflowSlot(ctx.workspaceId, (tx) =>
    tx.workflow.create({
      data: {
        workspaceId: ctx.workspaceId,
        name: body.name,
        description: body.description ?? "",
        nodes: { create: nodes },
        edges: { create: edges },
      },
      include: { nodes: true, edges: true },
    })
  );

  await auditLog(ctx.workspaceId, ctx.userId, "workflow.create", {
    type: "workflow",
    id: workflow.id,
    name: workflow.name,
  });

  return ok(serializeWorkflow(workflow), { status: 201 });
});
