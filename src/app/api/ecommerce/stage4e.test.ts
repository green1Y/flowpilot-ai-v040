/**
 * Stage 4e — e-commerce adapter framework tests.
 *
 * Covers: the mock store's three sample orders, the verified/source
 * branding (mock data is NEVER verified), shipment states, order→contact
 * linking persistence via POST /api/contacts/[id]/orders, tenant isolation
 * of links, and zod rejection of bad orderIds on every route.
 *
 * Auth is stubbed; the ecommerce provider is the in-memory mock store
 * (no network). DB is the fresh test.db per run.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getEcommerceProvider } from "@/lib/ecommerce/provider";
import { DEMO_ORDER_IDS } from "@/lib/ecommerce/mock-store";
import { GET as ordersGET } from "@/app/api/ecommerce/orders/route";
import { GET as orderDetailGET } from "@/app/api/ecommerce/orders/[id]/route";
import { GET as shipmentGET } from "@/app/api/ecommerce/shipment/[orderId]/route";
import { POST as linkPOST } from "@/app/api/contacts/[id]/orders/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

function authedAs(userId: string, email: string) {
  mockedRequireUser.mockResolvedValue({
    userId,
    email,
    user: { id: userId, name: "Test User", email },
  } as any);
}

function req(url: string, workspaceId: string, init?: { method?: string; body?: unknown }): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: { "x-workspace-id": workspaceId, "content-type": "application/json" },
  });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

const suffix = `e4${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userAId = "";
let wsA = "";
let wsB = "";
let contactAId = "";
let contactBId = "";

beforeAll(async () => {
  const a = await db.user.create({ data: { email: `e4-a-${suffix}@example.com`, name: "E4 A", passwordHash: "x" } });
  userAId = a.id;
  const org = await db.organization.create({ data: { name: `E4 Org ${suffix}` } });
  const mkWs = async (name: string) => {
    const w = await db.workspace.create({ data: { orgId: org.id, name, slug: `${name}-${suffix}` } });
    await db.membership.create({ data: { userId: a.id, workspaceId: w.id, role: "OWNER" } });
    return w.id;
  };
  wsA = await mkWs("e4-ws-a");
  wsB = await mkWs("e4-ws-b");

  const cA = await db.contact.create({ data: { workspaceId: wsA, name: `E4 Ana ${suffix}` } });
  contactAId = cA.id;
  const cB = await db.contact.create({ data: { workspaceId: wsB, name: `E4 Bob ${suffix}` } });
  contactBId = cB.id;

  authedAs(userAId, `e4-a-${suffix}@example.com`);
});

describe("mock store", () => {
  it("exposes the three sample orders", () => {
    expect(DEMO_ORDER_IDS).toEqual(["DEMO-1001", "DEMO-2002", "DEMO-3003"]);
  });

  it("returns the pending / shipped / delivered orders", async () => {
    const p = getEcommerceProvider();
    const pending = await p.getOrder("DEMO-1001");
    const shipped = await p.getOrder("DEMO-2002");
    const delivered = await p.getOrder("DEMO-3003");
    expect(pending?.status).toBe("pending");
    expect(shipped?.status).toBe("shipped");
    expect(delivered?.status).toBe("delivered");
    expect(shipped?.items.length).toBeGreaterThan(0);
    expect(pending?.total).toBeGreaterThan(0);
  });

  it("never presents mock data as verified", async () => {
    const p = getEcommerceProvider();
    const recent = await p.listRecentOrders(10);
    expect(recent.length).toBe(3);
    for (const o of recent) {
      expect(o.verified).toBe(false);
      expect(o.source).toBe("mock");
    }
    const shipment = await p.getShipmentStatus("DEMO-2002");
    expect(shipment?.verified).toBe(false);
    expect(shipment?.source).toBe("mock");
  });

  it("tracks the shipped order with carrier info; pending has no shipment", async () => {
    const p = getEcommerceProvider();
    const s = await p.getShipmentStatus("DEMO-2002");
    expect(s?.status).toBe("in_transit");
    expect(s?.trackingNumber).toBeTruthy();
    expect(s?.trackingUrl).toContain("http");
    expect(await p.getShipmentStatus("DEMO-1001")).toBeNull();
    expect(await p.getOrder("NOPE-404")).toBeNull();
  });
});

describe("GET /api/ecommerce/orders/[id]", () => {
  it("returns order detail with verified/source flags", async () => {
    const { status, body } = await jsonBody(
      await orderDetailGET(req("http://x/api/ecommerce/orders/DEMO-2002", wsA), { params: { id: "DEMO-2002" } })
    );
    expect(status).toBe(200);
    expect(body.data.order.orderId).toBe("DEMO-2002");
    expect(body.data.order.status).toBe("shipped");
    expect(body.data.order.verified).toBe(false);
    expect(body.data.order.source).toBe("mock");
    expect(body.data.linked).toBe(false);
  });

  it("404s for an unknown order", async () => {
    const { status } = await jsonBody(
      await orderDetailGET(req("http://x/api/ecommerce/orders/NOPE-404", wsA), { params: { id: "NOPE-404" } })
    );
    expect(status).toBe(404);
  });

  it("zod rejects a malformed orderId", async () => {
    const { status, body } = await jsonBody(
      await orderDetailGET(req("http://x/api/ecommerce/orders/bad%20id!!", wsA), { params: { id: "bad id!!" } })
    );
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
  });
});

describe("GET /api/ecommerce/shipment/[orderId]", () => {
  it("returns shipment status with flags", async () => {
    const { status, body } = await jsonBody(
      await shipmentGET(req("http://x/api/ecommerce/shipment/DEMO-2002", wsA), { params: { orderId: "DEMO-2002" } })
    );
    expect(status).toBe(200);
    expect(body.data.shipment.status).toBe("in_transit");
    expect(body.data.shipment.verified).toBe(false);
    expect(body.data.shipment.source).toBe("mock");
  });

  it("404s when there is no shipment info", async () => {
    const { status } = await jsonBody(
      await shipmentGET(req("http://x/api/ecommerce/shipment/DEMO-1001", wsA), { params: { orderId: "DEMO-1001" } })
    );
    expect(status).toBe(404);
  });

  it("zod rejects a malformed orderId", async () => {
    const { status } = await jsonBody(
      await shipmentGET(req("http://x/api/ecommerce/shipment/..", wsA), { params: { orderId: "../x" } })
    );
    expect(status).toBe(422);
  });
});

describe("order ↔ contact linking", () => {
  it("POST /api/contacts/[id]/orders links an order (idempotent)", async () => {
    const first = await jsonBody(
      await linkPOST(
        req(`http://x/api/contacts/${contactAId}/orders`, wsA, { method: "POST", body: { orderId: "DEMO-1001" } }),
        { params: { id: contactAId } }
      )
    );
    expect(first.status).toBe(201);
    expect(first.body.data.order.orderId).toBe("DEMO-1001");
    expect(first.body.data.order.verified).toBe(false);
    expect(first.body.data.link.contactId).toBe(contactAId);

    const row = await db.contactOrder.findUnique({
      where: { workspaceId_orderId: { workspaceId: wsA, orderId: "DEMO-1001" } },
    });
    expect(row).not.toBeNull();
    expect(row?.contactId).toBe(contactAId);
    expect(row?.verified).toBe(false);
    expect(row?.source).toBe("mock");

    // Idempotent re-link returns 201 without duplicating.
    const second = await jsonBody(
      await linkPOST(
        req(`http://x/api/contacts/${contactAId}/orders`, wsA, { method: "POST", body: { orderId: "DEMO-1001" } }),
        { params: { id: contactAId } }
      )
    );
    expect(second.status).toBe(201);
    const count = await db.contactOrder.count({ where: { workspaceId: wsA, orderId: "DEMO-1001" } });
    expect(count).toBe(1);
  });

  it("GET /api/ecommerce/orders?contactId= lists the linked orders", async () => {
    const { status, body } = await jsonBody(
      await ordersGET(req(`http://x/api/ecommerce/orders?contactId=${contactAId}`, wsA))
    );
    expect(status).toBe(200);
    expect(body.data.orders.length).toBeGreaterThanOrEqual(1);
    const entry = body.data.orders.find((e: any) => e.link.orderId === "DEMO-1001");
    expect(entry).toBeTruthy();
    expect(entry.order.verified).toBe(false);
    expect(entry.order.source).toBe("mock");
    expect(entry.link.verified).toBe(false);
  });

  it("GET /api/ecommerce/orders?orderId= returns a single order", async () => {
    const { status, body } = await jsonBody(
      await ordersGET(req("http://x/api/ecommerce/orders?orderId=DEMO-3003", wsA))
    );
    expect(status).toBe(200);
    expect(body.data.order.orderId).toBe("DEMO-3003");
    expect(body.data.linked).toBe(false);
  });

  it("rejects linking an unknown order", async () => {
    const { status, body } = await jsonBody(
      await linkPOST(
        req(`http://x/api/contacts/${contactAId}/orders`, wsA, { method: "POST", body: { orderId: "NOPE-404" } }),
        { params: { id: contactAId } }
      )
    );
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
  });

  it("zod rejects a malformed orderId in the link body", async () => {
    const { status } = await jsonBody(
      await linkPOST(
        req(`http://x/api/contacts/${contactAId}/orders`, wsA, { method: "POST", body: { orderId: "bad id!!" } }),
        { params: { id: contactAId } }
      )
    );
    expect(status).toBe(422);
  });

  it("zod rejects a malformed orderId in the query", async () => {
    const { status } = await jsonBody(
      await ordersGET(req("http://x/api/ecommerce/orders?orderId=bad%20id!!", wsA))
    );
    expect(status).toBe(422);
  });

  it("requires contactId or orderId in the query", async () => {
    const { status } = await jsonBody(await ordersGET(req("http://x/api/ecommerce/orders", wsA)));
    expect(status).toBe(422);
  });
});

describe("tenant isolation", () => {
  it("workspace B can link the same demo order without seeing A's links", async () => {
    const { status } = await jsonBody(
      await linkPOST(
        req(`http://x/api/contacts/${contactBId}/orders`, wsB, { method: "POST", body: { orderId: "DEMO-1001" } }),
        { params: { id: contactBId } }
      )
    );
    expect(status).toBe(201);

    // A's listing is unaffected by B's link.
    const aList = await jsonBody(
      await ordersGET(req(`http://x/api/ecommerce/orders?contactId=${contactAId}`, wsA))
    );
    expect(aList.body.data.orders.every((e: any) => e.link.contactId !== contactBId)).toBe(true);

    // B cannot list A's contact.
    const cross = await jsonBody(
      await ordersGET(req(`http://x/api/ecommerce/orders?contactId=${contactAId}`, wsB))
    );
    expect(cross.status).toBe(404);

    // A cannot touch B's contact.
    const crossLink = await jsonBody(
      await linkPOST(
        req(`http://x/api/contacts/${contactBId}/orders`, wsA, { method: "POST", body: { orderId: "DEMO-2002" } }),
        { params: { id: contactBId } }
      )
    );
    expect(crossLink.status).toBe(404);
  });
});
