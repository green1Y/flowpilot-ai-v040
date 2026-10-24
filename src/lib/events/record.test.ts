/**
 * Phase 3A — CustomerEvent recording: idempotency + tenant isolation.
 * DB is the fresh test.db per run (vitest global setup).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  recordCustomerEvent,
  recordCustomerEventStrict,
} from "./record";

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let wsA = "";
let wsB = "";
let contactA = "";

beforeAll(async () => {
  const orgA = await db.organization.create({ data: { name: `EV Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `EV Org B ${suffix}` } });
  const wA = await db.workspace.create({
    data: { orgId: orgA.id, name: `EV WS A ${suffix}`, slug: `ev-a-${suffix}` },
  });
  const wB = await db.workspace.create({
    data: { orgId: orgB.id, name: `EV WS B ${suffix}`, slug: `ev-b-${suffix}` },
  });
  wsA = wA.id;
  wsB = wB.id;
  const c = await db.contact.create({
    data: { workspaceId: wsA, name: `EV Contact ${suffix}` },
  });
  contactA = c.id;
});

describe("recordCustomerEvent", () => {
  it("records an event and returns its id", async () => {
    const id = await recordCustomerEventStrict({
      workspaceId: wsA,
      contactId: contactA,
      type: "message_received",
      provider: "instagram",
      providerEventId: `ev-test-mid-${suffix}-1`,
      source: "webhook",
      metadata: { body: "hello" },
      attribution: { campaignId: "c1" },
    });
    expect(typeof id).toBe("string");
    const row = await db.customerEvent.findUnique({ where: { id } });
    expect(row?.workspaceId).toBe(wsA);
    expect(row?.contactId).toBe(contactA);
    expect(row?.type).toBe("message_received");
    expect(JSON.parse(row?.metadata ?? "{}").body).toBe("hello");
    expect(JSON.parse(row?.attribution ?? "{}").campaignId).toBe("c1");
  });

  it("is idempotent: re-ingesting the same provider event returns the existing id", async () => {
    const key = `ev-test-mid-${suffix}-dupe`;
    const first = await recordCustomerEventStrict({
      workspaceId: wsA,
      type: "comment_received",
      provider: "facebook",
      providerEventId: key,
      source: "webhook",
    });
    const second = await recordCustomerEventStrict({
      workspaceId: wsA,
      type: "comment_received",
      provider: "facebook",
      providerEventId: key,
      source: "webhook",
    });
    expect(second).toBe(first);
    const count = await db.customerEvent.count({
      where: { workspaceId: wsA, providerEventId: key },
    });
    expect(count).toBe(1);
  });

  it("isolates tenants: the same providerEventId in another workspace creates a separate event", async () => {
    const key = `ev-test-mid-${suffix}-tenant`;
    const idA = await recordCustomerEventStrict({
      workspaceId: wsA,
      type: "message_received",
      providerEventId: key,
      source: "webhook",
    });
    const idB = await recordCustomerEventStrict({
      workspaceId: wsB,
      type: "message_received",
      providerEventId: key,
      source: "webhook",
    });
    expect(idB).not.toBe(idA);
    const total = await db.customerEvent.count({
      where: { providerEventId: key },
    });
    expect(total).toBe(2);
  });

  it("allows events without a providerEventId (no dedupe key)", async () => {
    const a = await recordCustomerEventStrict({
      workspaceId: wsA,
      type: "workflow_executed",
      source: "engine",
    });
    const b = await recordCustomerEventStrict({
      workspaceId: wsA,
      type: "workflow_executed",
      source: "engine",
    });
    expect(a).not.toBe(b);
  });

  it("never throws: returns null when the workspace does not exist", async () => {
    const id = await recordCustomerEvent({
      workspaceId: "ws_does_not_exist",
      type: "message_sent",
      source: "engine",
    });
    expect(id).toBeNull();
  });
});
