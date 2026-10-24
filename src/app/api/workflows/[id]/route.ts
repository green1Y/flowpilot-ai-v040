import { NextRequest } from "next/server";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/audit";
import { workflowUpdateSchema } from "@/lib/validation";
import { validateWorkflow } from "@/lib/workflows/validate";
import { serializeWorkflow, getScopedWorkflow, freshId } from "../helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = handler(async (req: NextRequest, ctx: Ctx) => {
  const { workspaceId } = await requireWorkspace(req);
  const workflow = await getScopedWorkflow(workspaceId, (await ctx.params).id);
  return ok(serializeWorkflow(workflow));
});

export const PATCH = handler(async (req: NextRequest, ctx: Ctx) => {
  const wctx = await requireWorkspace(req);
  // Data mutation: AGENT+ only (ANALYST is read-only).
  requireRole(wctx, "AGENT");
  const { workspaceId, userId } = wctx;
  const id = (await ctx.params).id;
  await getScopedWorkflow(workspaceId, id); // 404 when not in this workspace
  const body = await parseBody(req, workflowUpdateSchema);

  // Replacing nodes without edges would silently orphan the graph: node ids
  // are recreated, so edges must be supplied together with nodes.
  if (body.nodes && body.edges === undefined) {
    throw err(
      "When replacing nodes, edges must be provided as well (send the current edges unchanged to keep them)",
      422
    );
  }

  // Conflict-safe autosave: reject when the row changed since the client's
  // copy (another tab or user saved first). The client reloads or keeps
  // its version explicitly.
  if (body.expectedUpdatedAt) {
    const current = await db.workflow.findFirst({
      where: { id, workspaceId },
      select: { updatedAt: true },
    });
    if (current && current.updatedAt.getTime() > new Date(body.expectedUpdatedAt).getTime()) {
      throw err("This workflow changed since you loaded it — reload to merge", 409, {
        code: "SAVE_CONFLICT",
        serverUpdatedAt: current.updatedAt.toISOString(),
      });
    }
  }

  const updated = await db.$transaction(async (tx) => {
    if (body.nodes) {
      await tx.workflowEdge.deleteMany({ where: { workflowId: id } });
      await tx.workflowNode.deleteMany({ where: { workflowId: id } });
      if (body.nodes.length > 0) {
        await tx.workflowNode.createMany({
          data: body.nodes.map((n) => ({
            id: n.id || freshId("n"),
            workflowId: id,
            kind: n.kind,
            type: n.type,
            label: n.label,
            config: JSON.stringify(n.config ?? {}),
            position: JSON.stringify(n.position ?? { x: 0, y: 0 }),
            disabled: n.disabled ?? false,
          })),
        });
      }
      const edges = body.edges ?? [];
      if (edges.length > 0) {
        await tx.workflowEdge.createMany({
          data: edges.map((e) => ({
            id: e.id || freshId("e"),
            workflowId: id,
            sourceId: e.sourceId,
            targetId: e.targetId,
            label: e.label ?? "",
            condition: JSON.stringify(e.condition ?? {}),
          })),
        });
      }
    }
    return tx.workflow.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        version: { increment: 1 },
      },
      include: { nodes: true, edges: true },
    });
  });

  await auditLog(workspaceId, userId, "workflow.update", {
    type: "workflow",
    id,
    version: updated.version,
  });

  const serialized = serializeWorkflow(updated);
  // Server-side validation on save (non-blocking for drafts — publish
  // enforces it): the builder surfaces these in the readiness indicator.
  const validation = validateWorkflow(
    serialized.nodes.map((n: { id: string; kind: string; type: string; label: string; config: Record<string, unknown>; disabled?: boolean }) => ({
      id: n.id,
      kind: n.kind,
      type: n.type,
      label: n.label,
      config: n.config,
      disabled: n.disabled,
    })),
    serialized.edges.map((e: { id: string; sourceId: string; targetId: string; label: string }) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      label: e.label,
    }))
  );
  return ok({ ...serialized, validation: { valid: validation.valid, errors: validation.errors } });
});

export const DELETE = handler(async (req: NextRequest, ctx: Ctx) => {
  const wctx = await requireWorkspace(req);
  // Data mutation: AGENT+ only (ANALYST is read-only).
  requireRole(wctx, "AGENT");
  const { workspaceId, userId } = wctx;
  const id = (await ctx.params).id;
  const workflow = await getScopedWorkflow(workspaceId, id);
  // Nodes, edges, executions and steps cascade via the Prisma schema.
  await db.workflow.delete({ where: { id } });
  await auditLog(workspaceId, userId, "workflow.delete", {
    type: "workflow",
    id,
    name: workflow.name,
  });
  return ok({ deleted: true, id });
});
