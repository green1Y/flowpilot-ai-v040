import { err } from "@/lib/api";
import { db } from "@/lib/db";

function safeParse(raw: string | null | undefined, fallback: unknown = {}) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Serialize a workflow row with its JSON string fields parsed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeWorkflow(w: any) {
  return {
    id: w.id,
    workspaceId: w.workspaceId,
    name: w.name,
    description: w.description,
    status: w.status,
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodes: (w.nodes ?? []).map((n: any) => ({
      id: n.id,
      kind: n.kind,
      type: n.type,
      label: n.label,
      config: safeParse(n.config),
      position: safeParse(n.position, { x: 0, y: 0 }),
      disabled: n.disabled ?? false,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    edges: (w.edges ?? []).map((e: any) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      label: e.label ?? "",
      condition: safeParse(e.condition),
    })),
    ...(w._count ? { runCount: w._count.executions } : {}),
  };
}

/** Load a workflow scoped to the workspace; throws 404 when missing. */
export async function getScopedWorkflow(workspaceId: string, id: string) {
  const workflow = await db.workflow.findFirst({
    where: { id, workspaceId },
    include: { nodes: true, edges: true },
  });
  if (!workflow) throw err("Workflow not found", 404);
  return workflow;
}

export function freshId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
