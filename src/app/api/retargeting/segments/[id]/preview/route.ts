import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import {
  parseConditions,
  resolveSegmentContacts,
  describeConditions,
  availabilityWarningsFor,
} from "@/lib/retargeting/segments";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/retargeting/segments/:id/preview
 * → { count, sample (≤10 contacts), summary, availabilityWarnings }
 * Read-only: evaluates the segment against live workspace data, persists nothing.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  const segment = await db.audienceSegment.findFirst({
    where: { id: (await params).id, workspaceId: ctx.workspaceId },
  });
  if (!segment) throw err("Audience segment not found", 404);

  const tree = parseConditions(segment.conditions);
  const { count, contacts } = await resolveSegmentContacts(ctx.workspaceId, tree, {
    limit: 10,
  });

  return ok({
    count,
    sample: contacts.map((c) => ({
      contactId: c.contactId,
      name: c.name,
      channel: c.channel,
      leadStatus: c.leadStatus,
      tags: c.tags,
      messageCount: c.messageCount,
      purchaseCount: c.purchaseCount,
    })),
    summary: describeConditions(tree),
    availabilityWarnings: availabilityWarningsFor(tree),
  });
});
