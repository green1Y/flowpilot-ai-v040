import { db } from "@/lib/db";
import { err } from "@/lib/api";
import { getEcommerceProvider } from "@/lib/ecommerce/provider";
import { auditLog } from "@/lib/audit";

/**
 * Stage 4e — link an order to a contact (idempotent).
 *
 * Lives here (not in the ecommerce/orders route file) because Next.js route
 * modules may only export route handlers — a helper exported from a
 * `route.ts` breaks the production build's route type validation.
 */
export async function linkOrder(
  workspaceId: string,
  userId: string | null,
  contactId: string,
  orderId: string
) {
  const contact = await db.contact.findFirst({ where: { id: contactId, workspaceId } });
  if (!contact) throw err("Contact not found", 404);

  const provider = getEcommerceProvider();
  const order = await provider.getOrder(orderId);
  if (!order) throw err("Order not found in the connected store", 404);

  // Provider-side association is best-effort; the DB row is the source of truth.
  try {
    await provider.linkOrderToContact(orderId, contactId);
  } catch (e) {
    console.warn("[ecommerce] provider linkOrderToContact failed (non-fatal)", e);
  }

  const link = await db.contactOrder.upsert({
    where: { workspaceId_orderId: { workspaceId, orderId } },
    create: {
      workspaceId,
      contactId,
      orderId,
      verified: order.verified,
      source: order.source,
    },
    update: { contactId, verified: order.verified, source: order.source },
  });

  await auditLog(workspaceId, userId, "ecommerce.order_linked", {
    type: "contact_order",
    id: link.id,
    orderId,
    contactId,
    verified: order.verified,
    source: order.source,
  });

  return { link, order };
}
