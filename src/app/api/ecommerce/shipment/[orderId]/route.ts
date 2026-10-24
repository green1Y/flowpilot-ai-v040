import { NextRequest } from "next/server";
import { handler, ok, err } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { orderIdSchema } from "@/lib/validation";
import { getEcommerceProvider } from "@/lib/ecommerce/provider";

type Ctx = { params: Promise<{ orderId: string }> };

/**
 * Stage 4e — shipment status for an order. Always carries `verified` +
 * `source` flags; mock results are { verified: false, source: "mock" }.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  await requireWorkspace(req);

  const parsed = orderIdSchema.safeParse((await params).orderId);
  if (!parsed.success) throw err("Invalid orderId", 422);

  const provider = getEcommerceProvider();
  const shipment = await provider.getShipmentStatus(parsed.data);
  if (!shipment) throw err("No shipment information for this order", 404);

  return ok({ shipment, provider: provider.name });
});
