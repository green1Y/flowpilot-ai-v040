import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { db } from "@/lib/db";
import { getScopedWorkflow } from "../../helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

function countGraph(raw: string): { nodeCount: number; edgeCount: number } {
  try {
    const graph = JSON.parse(raw) as { nodes?: unknown[]; edges?: unknown[] };
    return {
      nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
      edgeCount: Array.isArray(graph.edges) ? graph.edges.length : 0,
    };
  } catch {
    return { nodeCount: 0, edgeCount: 0 };
  }
}

export const GET = handler(async (req: NextRequest, ctx: Ctx) => {
  const { workspaceId } = await requireWorkspace(req);
  const workflow = await getScopedWorkflow(workspaceId, (await ctx.params).id);

  const versions = await db.workflowVersion.findMany({
    where: { workflowId: workflow.id },
    orderBy: { version: "desc" },
  });

  return ok(
    versions.map((v) => ({
      version: v.version,
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      ...countGraph(v.graph),
    }))
  );
});
