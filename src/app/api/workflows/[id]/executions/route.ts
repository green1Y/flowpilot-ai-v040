import { NextRequest } from "next/server";
import { handler, ok } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { db } from "@/lib/db";
import { getScopedWorkflow } from "../../helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

function safeParse(raw: string | null | undefined, fallback: unknown = {}) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export const GET = handler(async (req: NextRequest, ctx: Ctx) => {
  const { workspaceId } = await requireWorkspace(req);
  const workflow = await getScopedWorkflow(workspaceId, (await ctx.params).id);

  const executions = await db.workflowExecution.findMany({
    where: { workflowId: workflow.id },
    include: { steps: { orderBy: { createdAt: "asc" } } },
    orderBy: { startedAt: "desc" },
    take: 50,
  });

  return ok(
    executions.map((e) => ({
      id: e.id,
      status: e.status,
      dryRun: e.dryRun,
      workflowVersion: e.workflowVersion ?? null,
      error: e.error,
      attempts: e.attempts,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
      // Included so the builder can offer a safe retry of the same event
      // (retry uses a fresh idempotency key — never a duplicate).
      triggerEvent: safeParse(e.triggerEvent),
      durationMs:
        e.finishedAt && e.startedAt
          ? new Date(e.finishedAt).getTime() - new Date(e.startedAt).getTime()
          : null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      steps: e.steps.map((s: any) => ({
        id: s.id,
        nodeId: s.nodeId,
        nodeLabel: s.nodeLabel,
        status: s.status,
        input: safeParse(s.input),
        output: safeParse(s.output),
        error: s.error,
        createdAt: s.createdAt,
      })),
    }))
  );
});
