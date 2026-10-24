import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { orderIdSchema } from "@/lib/validation";
import { getEcommerceProvider } from "@/lib/ecommerce/provider";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Stage 4e — order detail. Always carries `verified` + `source` flags;
 * mock results are { verified: false, source: "mock" } — never presented
 * as verified.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const ctx = await requireWorkspace(req);

  const parsed = orderIdSchema.safeParse((await params).id);
  if (!parsed.success) throw err("Invalid orderId", 422);

  const provider = getEcommerceProvider();
  const order = await provider.getOrder(parsed.data);
  if (!order) throw err("Order not found in the connected store", 404);

  const link = await db.contactOrder.findUnique({
    where: { workspaceId_orderId: { workspaceId: ctx.workspaceId, orderId: parsed.data } },
    select: { contactId: true, linkedAt: true, verified: true, source: true },
  });

  return ok({
    order,
    linked: !!link,
    contactId: link?.contactId ?? null,
    provider: provider.name,
  });
});
