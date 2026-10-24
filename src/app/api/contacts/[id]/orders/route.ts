import { NextRequest } from "next/server";
import { handler, ok, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { linkOrderSchema } from "@/lib/validation";
import { linkOrder } from "@/lib/ecommerce/orders";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Stage 4e — link a store order to a contact. Body: { orderId } (zod).
 * Idempotent: re-linking the same order returns the existing link.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);
  // Data mutation: AGENT+ only (ANALYST is read-only).
  requireRole(ctx, "AGENT");
  const body = await parseBody(req, linkOrderSchema);

  const { link, order } = await linkOrder(ctx.workspaceId, ctx.userId, (await params).id, body.orderId);

  return ok(
    {
      link: {
        id: link.id,
        orderId: link.orderId,
        contactId: link.contactId,
        linkedAt: link.linkedAt.toISOString(),
        verified: link.verified,
        source: link.source,
      },
      order,
    },
    { status: 201 }
  );
});
