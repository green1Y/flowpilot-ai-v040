/**
 * Stage 4e — reference e-commerce provider: an in-memory MOCK store.
 *
 * ┌────────────────────────────────────────────────────────────┐
 * │  DEMO DATA — nothing here is real.                         │
 * │  Every result is branded { verified: false, source: "mock" }│
 * │  so the UI/API can never present it as verified.           │
 * └────────────────────────────────────────────────────────────┘
 *
 * Three sample orders:
 *  - DEMO-1001: pending (paid, not yet fulfilled)
 *  - DEMO-2002: shipped with carrier tracking
 *  - DEMO-3003: delivered
 *
 * Wire a real provider (Shopify example) by implementing
 * EcommerceProvider against the store's API — see ECOMMERCE_ADAPTER.md.
 */

import {
  EcommerceProvider,
  OrderResult,
  ShipmentResult,
} from "./provider";

const MOCK_SOURCE = "mock" as const;

function branded<T extends object>(r: T): T & { verified: false; source: "mock" } {
  return { ...r, verified: false, source: MOCK_SOURCE };
}

const ORDERS: Record<string, Omit<OrderResult, "verified" | "source">> = {
  "DEMO-1001": {
    orderId: "DEMO-1001",
    status: "pending",
    total: 89.97,
    currency: "USD",
    items: [
      { name: "Everyday Cotton Tee", sku: "TEE-BLK-M", quantity: 2, unitPrice: 29.99, currency: "USD" },
      { name: "Canvas Tote", sku: "TOTE-NAT", quantity: 1, unitPrice: 29.99, currency: "USD" },
    ],
    customerName: "Demo Customer",
    customerEmail: "demo.customer@example.com",
    placedAt: "2026-10-15T09:24:00.000Z",
  },
  "DEMO-2002": {
    orderId: "DEMO-2002",
    status: "shipped",
    total: 149.5,
    currency: "USD",
    items: [
      { name: "Wireless Headphones", sku: "HP-PRO-WHT", quantity: 1, unitPrice: 149.5, currency: "USD" },
    ],
    customerName: "Demo Customer",
    customerEmail: "demo.customer@example.com",
    placedAt: "2026-10-12T14:02:00.000Z",
  },
  "DEMO-3003": {
    orderId: "DEMO-3003",
    status: "delivered",
    total: 59.0,
    currency: "USD",
    items: [
      { name: "Ceramic Pour-Over Set", sku: "POUR-SET", quantity: 1, unitPrice: 59.0, currency: "USD" },
    ],
    customerName: "Demo Customer",
    customerEmail: "demo.customer@example.com",
    placedAt: "2026-10-05T18:40:00.000Z",
  },
};

const SHIPMENTS: Record<string, Omit<ShipmentResult, "verified" | "source">> = {
  "DEMO-2002": {
    orderId: "DEMO-2002",
    status: "in_transit",
    carrier: "UPS",
    trackingNumber: "1Z9999999999999999",
    trackingUrl: "https://www.ups.com/track?tracknum=1Z9999999999999999",
    estimatedDelivery: "2026-10-18T17:00:00.000Z",
  },
  "DEMO-3003": {
    orderId: "DEMO-3003",
    status: "delivered",
    carrier: "USPS",
    trackingNumber: "9400111899999999999999",
    trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899999999999999",
  },
};

export const DEMO_ORDER_IDS = Object.keys(ORDERS);

export class MockStoreProvider implements EcommerceProvider {
  name = "Mock store (demo)";

  /** orderId → contactId associations made via linkOrderToContact (in-memory). */
  private links = new Map<string, string>();

  async getOrder(orderId: string): Promise<OrderResult | null> {
    const o = ORDERS[orderId];
    return o ? branded({ ...o, items: o.items.map((i) => ({ ...i })) }) : null;
  }

  async getShipmentStatus(orderId: string): Promise<ShipmentResult | null> {
    const s = SHIPMENTS[orderId];
    return s ? branded({ ...s }) : null;
  }

  async linkOrderToContact(orderId: string, contactId: string): Promise<void> {
    if (!ORDERS[orderId]) throw new Error(`Unknown order: ${orderId}`);
    this.links.set(orderId, contactId);
  }

  async listRecentOrders(limit: number): Promise<OrderResult[]> {
    const n = Math.max(1, Math.min(100, Math.floor(limit) || 10));
    return DEMO_ORDER_IDS.slice(0, n).map((id) => branded({ ...ORDERS[id], items: ORDERS[id].items.map((i) => ({ ...i })) }));
  }

  /** Demo helper: which contact an order was linked to (in-memory). */
  linkedContact(orderId: string): string | null {
    return this.links.get(orderId) ?? null;
  }
}
