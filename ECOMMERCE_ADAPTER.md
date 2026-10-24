# E-commerce adapter framework (Stage 4e)

FlowPilot talks to online stores through the `EcommerceProvider` interface
(`src/lib/ecommerce/provider.ts`). The interface is store-agnostic: one
implementation per store backend (Shopify, WooCommerce, …). Today the only
implementation is the in-memory **mock store** (`src/lib/ecommerce/mock-store.ts`)
with clearly-labeled **DEMO** data.

## The honesty rule

Every result type is branded:

```ts
interface OrderResult {
  orderId: string;
  status: OrderStatus;
  total: number;
  currency: string;
  items: OrderItem[];
  customerName?: string;
  customerEmail?: string;
  placedAt: string;
  verified: boolean;          // ALWAYS present
  source: "mock" | "api";     // ALWAYS present
}
```

- `verified: true` is allowed **only** when the data came from a **live
  provider API call** made with the workspace's own stored credentials.
- Mock/demo data is **always** `{ verified: false, source: "mock" }` and the
  UI renders a **DEMO badge** for it. Never present mock data as verified —
  not in API responses, not in the contact drawer, not in AI replies.

## Routes

| Method & path | Purpose |
|---|---|
| `GET /api/ecommerce/orders?contactId=<id>` | Orders linked to a contact (tenant-scoped) |
| `GET /api/ecommerce/orders?orderId=<id>` | Single order via the provider |
| `GET /api/ecommerce/orders/<id>` | Order detail + link state |
| `GET /api/ecommerce/shipment/<orderId>` | Shipment / tracking status |
| `POST /api/contacts/<id>/orders` `{ orderId }` | Link an order to a contact (idempotent) |

All require `requireWorkspace` + zod validation. Links persist in the
`ContactOrder` table (`@@unique([workspaceId, orderId])`).

## Adding a real provider — Shopify example

1. **Create the adapter** in `src/lib/ecommerce/shopify.ts`:

```ts
import { EcommerceProvider, OrderResult, ShipmentResult } from "./provider";

export class ShopifyProvider implements EcommerceProvider {
  name = "Shopify";
  constructor(private shop: string, private accessToken: string) {}

  async getOrder(orderId: string): Promise<OrderResult | null> {
    // GET https://{shop}.myshopify.com/admin/api/2024-10/orders/{orderId}.json
    //   headers: { "X-Shopify-Access-Token": this.accessToken }
    const res = await fetch(
      `https://${this.shop}.myshopify.com/admin/api/2024-10/orders/${orderId}.json`,
      { headers: { "X-Shopify-Access-Token": this.accessToken } }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Shopify order lookup failed (${res.status})`);
    const { order } = await res.json();
    return {
      orderId: String(order.id),
      status: mapShopifyStatus(order),
      total: Number(order.total_price),
      currency: order.currency,
      items: order.line_items.map((li: any) => ({
        name: li.title, sku: li.sku, quantity: li.quantity,
        unitPrice: Number(li.price), currency: order.currency,
      })),
      customerName: `${order.customer?.first_name ?? ""} ${order.customer?.last_name ?? ""}`.trim(),
      customerEmail: order.email,
      placedAt: order.created_at,
      verified: true,          // ← live API call with real credentials
      source: "api",
    };
  }

  async getShipmentStatus(orderId: string): Promise<ShipmentResult | null> {
    // Fulfillments carry tracking info:
    // GET https://{shop}.myshopify.com/admin/api/2024-10/orders/{orderId}/fulfillments.json
    // (or /fulfillment_orders.json + fulfillment per fulfillment order)
    // → first fulfillment's tracking_number / tracking_urls / shipment_status.
    // Return null when the order has no fulfillments yet.
    ...
    return { orderId, status, carrier, trackingNumber, trackingUrl, estimatedDelivery, verified: true, source: "api" };
  }

  async linkOrderToContact(orderId: string, contactId: string): Promise<void> {
    // Optional provider-side note, e.g. POST .../orders/{id}.json { note: `FlowPilot contact ${contactId}` }.
    // The DB ContactOrder row is the source of truth; this is best-effort.
  }

  async listRecentOrders(limit: number): Promise<OrderResult[]> {
    // GET https://{shop}.myshopify.com/admin/api/2024-10/orders.json?status=any&limit={limit}&order=created_at%20desc
    // → map each order like getOrder (verified: true, source: "api").
  }
}
```

2. **Select it per workspace** in `getEcommerceProvider()` (provider.ts):
   read the workspace's Shopify integration credentials (encrypted, never
   logged) and return `new ShopifyProvider(shop, token)` when connected;
   otherwise keep returning the mock store.

3. **What "verified" means**: the row reached us through an authenticated
   HTTPS call to the store's API using that workspace's credentials, in the
   current request — no cache older than the request, no demo fixtures.

## Going-live checklist

- [ ] Store credentials stored encrypted (never plaintext, never in logs).
- [ ] `verified: true` only on the live-API code path; mock path untouched.
- [ ] Webhook signatures verified (HMAC) before ingesting order events.
- [ ] Every route still passes `requireWorkspace` + zod; no cross-tenant reads.
- [ ] Rate-limit handling: back off on 429, surface honest errors.
- [ ] `ContactOrder.source` shows `"api"` for real links; DEMO badges gone
      from the UI for those orders.
- [ ] Tested against the stage4e test suite **plus** a live sandbox store
      before pointing at production data.
