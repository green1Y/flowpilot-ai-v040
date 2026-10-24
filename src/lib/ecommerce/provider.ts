/**
 * Stage 4e — e-commerce adapter framework.
 *
 * EcommerceProvider is the interface every store adapter implements
 * (mock today, Shopify/WooCommerce/… tomorrow). Two honesty rules are
 * baked into the types:
 *
 *  - Every result carries `verified: boolean` and `source: "mock" | "api"`.
 *  - `verified` is true ONLY when the data came from a live provider API
 *    call with the workspace's own credentials. Mock/demo data is NEVER
 *    verified — the UI shows a DEMO badge for it.
 *
 * Get the active provider with getEcommerceProvider(). Today that is always
 * the in-memory mock store (src/lib/ecommerce/mock-store.ts); a real
 * provider can be selected per workspace later without changing callers.
 */

export type EcommerceSource = "mock" | "api";

export type OrderStatus = "pending" | "shipped" | "delivered" | "cancelled" | "refunded";
export type ShipmentStatus = "pending" | "in_transit" | "delivered" | "exception" | "unknown";

export interface OrderItem {
  name: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
  currency: string;
}

/** branded: verified + source are ALWAYS present — never present mock data as verified. */
export interface OrderResult {
  orderId: string;
  status: OrderStatus;
  total: number;
  currency: string;
  items: OrderItem[];
  customerName?: string;
  customerEmail?: string;
  /** ISO timestamp when the order was placed. */
  placedAt: string;
  /** true ONLY when fetched from a live provider API with real credentials. */
  verified: boolean;
  /** "mock" for demo data, "api" for a live provider call. */
  source: EcommerceSource;
}

/** branded: verified + source are ALWAYS present — never present mock data as verified. */
export interface ShipmentResult {
  orderId: string;
  status: ShipmentStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  /** ISO timestamp, when the carrier provides one. */
  estimatedDelivery?: string;
  /** true ONLY when fetched from a live provider API with real credentials. */
  verified: boolean;
  /** "mock" for demo data, "api" for a live provider call. */
  source: EcommerceSource;
}

export interface EcommerceProvider {
  /** Human-readable adapter name, e.g. "Mock store (demo)" / "Shopify". */
  name: string;
  /** Order detail; null when the order id is unknown to this provider. */
  getOrder(orderId: string): Promise<OrderResult | null>;
  /** Shipment/tracking state; null when the provider has no shipment info. */
  getShipmentStatus(orderId: string): Promise<ShipmentResult | null>;
  /** Provider-side association of an order with a FlowPilot contact id. */
  linkOrderToContact(orderId: string, contactId: string): Promise<void>;
  /** Most recent orders, newest first, capped at `limit`. */
  listRecentOrders(limit: number): Promise<OrderResult[]>;
}

import { MockStoreProvider } from "./mock-store";

let cached: EcommerceProvider | null = null;

/**
 * The active provider. Today: always the mock store. A real provider
 * (Shopify, …) slots in here later — see ECOMMERCE_ADAPTER.md. Callers must
 * treat every result as untrusted store data and surface verified/source.
 */
export function getEcommerceProvider(): EcommerceProvider {
  if (!cached) cached = new MockStoreProvider();
  return cached;
}

/** Test seam: replace the cached provider (tests only). */
export function __setEcommerceProvider(p: EcommerceProvider | null): void {
  cached = p;
}
