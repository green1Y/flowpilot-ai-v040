import { NextRequest } from "next/server";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/audit";
import { readinessReport } from "@/lib/workflows/readiness";
import { getScopedWorkflow } from "../../helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const POST = handler(async (req: NextRequest, ctx: Ctx) => {
  const wctx = await requireWorkspace(req);
  // Publishing arms a workflow for live runs: MANAGER+.
  requireRole(wctx, "MANAGER");
  const { workspaceId, userId } = wctx;
  const workflow = await getScopedWorkflow(workspaceId, (await ctx.params).id);

  // Publish gate = the builder readiness report: validateWorkflow errors
  // (config, structure, reachability) PLUS cycle detection — a cyclic graph
  // must not be publishable via direct API call just because the builder
  // warns about it. Disabled nodes are passed through so their config is
  // skipped, matching validateWorkflow semantics (they never run).
  const report = readinessReport(
    workflow.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      type: n.type,
      label: n.label,
      config: JSON.parse(n.config || "{}"),
      disabled: n.disabled,
    })),
    workflow.edges.map((e) => ({ id: e.id, sourceId: e.sourceId, targetId: e.targetId, label: e.label ?? "" }))
  );

  if (!report.ready) {
    throw err("Workflow is not valid — fix the errors before publishing", 422, { errors: report.errors });
  }

  const updated = await db.workflow.update({
    where: { id: workflow.id },
    data: { status: "PUBLISHED" },
  });

  // Batch C — immutable version snapshot. Serialize the exact graph being
  // published in the shape serializeWorkflow / the engine walker use:
  // nodes carry parsed `config`/`position` objects + `disabled`, edges
  // carry parsed `condition`. processWorkflowJob maps this shape back to
  // its ParsedNode/ParsedEdge structures when an execution is pinned.
  // Immutability: if a snapshot already exists for (workflowId, version)
  // (re-publish without edits), it is left untouched — never overwritten
  // and never a publish failure.
  const graph = JSON.stringify({
    nodes: workflow.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      type: n.type,
      label: n.label,
      config: JSON.parse(n.config || "{}"),
      position: JSON.parse(n.position || '{"x":0,"y":0}'),
      disabled: n.disabled ?? false,
    })),
    edges: workflow.edges.map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      label: e.label ?? "",
      condition: JSON.parse(e.condition || "{}"),
    })),
  });
  const existingSnapshot = await db.workflowVersion.findFirst({
    where: { workflowId: workflow.id, version: workflow.version },
    select: { id: true },
  });
  if (!existingSnapshot) {
    try {
      await db.workflowVersion.create({
        data: {
          workflowId: workflow.id,
          version: workflow.version,
          graph,
          createdBy: userId ?? null,
        },
      });
    } catch (e) {
      // Unique race: a concurrent publish created the snapshot first.
      // The first snapshot wins — do not overwrite, do not fail publish.
      if ((e as { code?: string } | null)?.code !== "P2002") throw e;
    }
  }

  await auditLog(workspaceId, userId, "workflow.publish", { type: "workflow", id: workflow.id });
  return ok({ id: updated.id, status: updated.status });
});
