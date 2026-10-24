import { NextRequest } from "next/server";
import { handler, ok, parseQuery } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { listJobs, serializeJob } from "@/lib/jobs";
import { z } from "zod";

/**
 * GET /api/jobs — list durable background jobs for this workspace
 * (Member read; ANALYST included). `deadLetters` is the DEAD_LETTER
 * subset, so operators can spot exhausted jobs without filtering.
 * Optional query: status, type, limit.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const q = parseQuery(
    req,
    z.object({
      status: z.string().optional(),
      type: z.string().optional(),
      limit: z.string().optional(),
    })
  );
  const limit = q.limit ? parseInt(q.limit, 10) || 100 : 100;
  const items = await listJobs({
    workspaceId: ctx.workspaceId,
    status: q.status,
    type: q.type,
    limit,
  });
  const deadLetters = await listJobs({ workspaceId: ctx.workspaceId, status: "DEAD_LETTER", limit: 100 });
  return ok({
    items: items.map(serializeJob),
    deadLetters: deadLetters.map(serializeJob),
  });
});
