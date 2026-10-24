import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, err, parseQuery } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { ecommerceOrdersQuerySchema } from "@/lib/validation";
import { getEcommerceProvider } from "@/lib/ecommerce/provider";

/**
 * Stage 4e — list orders.
 *
 *   GET /api/ecommerce/orders?contactId=<id>  — orders linked to a contact
 *   GET /api/ecommerce/orders?orderId=<id>    — one order, provider detail
 *
 * Every order carries `verified` + `source` flags — mock results are always
 * { verified: false, source: "mock" } and the UI renders a DEMO badge for them.
 */
export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const q = parseQuery(req, ecommerceOrdersQuerySchema);
  const provider = getEcommerceProvider();

  if (q.orderId) {
    const order = await provider.getOrder(q.orderId);
    if (!order) throw err("Order not found in the connected store", 404);
    const link = await db.contactOrder.findUnique({
      where: { workspaceId_orderId: { workspaceId: ctx.workspaceId, orderId: q.orderId } },
      select: { contactId: true, linkedAt: true },
    });
    return ok({
      order,
      linked: !!link,
      contactId: link?.contactId ?? null,
      provider: provider.name,
    });
  }

  if (q.contactId) {
    const contact = await db.contact.findFirst({
      where: { id: q.contactId, workspaceId: ctx.workspaceId },
      select: { id: true },
    });
    if (!contact) throw err("Contact not found", 404);

    const links = await db.contactOrder.findMany({
      where: { workspaceId: ctx.workspaceId, contactId: contact.id },
      orderBy: { linkedAt: "desc" },
    });
    const orders = await Promise.all(
      links.map(async (l) => ({
        link: { id: l.id, orderId: l.orderId, linkedAt: l.linkedAt.toISOString(), verified: l.verified, source: l.source },
        order: await provider.getOrder(l.orderId),
      }))
    );
    return ok({ contactId: contact.id, orders, provider: provider.name });
  }

  throw err("Query requires contactId or orderId", 422);
});
