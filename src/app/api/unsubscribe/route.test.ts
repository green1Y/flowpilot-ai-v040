/**
 * GET /api/unsubscribe tests (Wave 2E).
 * - Valid token → 200 confirmation page + Suppression (email) + one
 *   OPTED_OUT ConsentRecord; a repeat click stays 200 and adds no
 *   duplicate ConsentRecord.
 * - Missing or invalid token → generic 400, no rows written.
 * Real DB fixtures; no auth (the token is the authorization).
 */
import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { createUnsubscribeToken } from "@/lib/email/unsubscribe";
import { GET } from "./route";

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let wsId = "";
let orgId = "";
let contactId = "";

async function fixture() {
  if (wsId) return;
  const org = await db.organization.create({
    data: { name: `Unsub Org ${suffix}` },
  });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `Unsub WS ${suffix}`, slug: `unsub-ws-${suffix}` },
  });
  const contact = await db.contact.create({
    data: { workspaceId: ws.id, name: "Unsub Person", email: "unsub@example.com" },
  });
  orgId = org.id;
  wsId = ws.id;
  contactId = contact.id;
}

afterAll(async () => {
  await db.consentRecord.deleteMany({ where: { workspaceId: wsId } });
  await db.suppression.deleteMany({ where: { workspaceId: wsId } });
  await db.contact.deleteMany({ where: { workspaceId: wsId } });
  await db.membership.deleteMany({ where: { workspaceId: wsId } });
  await db.workspace.deleteMany({ where: { id: wsId } });
  await db.organization.deleteMany({ where: { id: orgId } });
});

function getReq(token: string | null): NextRequest {
  const url =
    token === null
      ? "http://localhost/api/unsubscribe"
      : `http://localhost/api/unsubscribe?token=${encodeURIComponent(token)}`;
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/unsubscribe", () => {
  it("unsubscribes on a valid token and stays idempotent on repeat clicks", async () => {
    await fixture();
    const token = createUnsubscribeToken(wsId, contactId);

    const res1 = await GET(getReq(token));
    expect(res1.status).toBe(200);
    expect(await res1.text()).toContain("unsubscribed");

    const suppression = await db.suppression.findFirst({
      where: { workspaceId: wsId, contactId, channel: "email" },
    });
    expect(suppression).not.toBeNull();
    const consents = await db.consentRecord.findMany({
      where: { workspaceId: wsId, contactId, channel: "email", status: "OPTED_OUT" },
    });
    expect(consents).toHaveLength(1);
    expect(consents[0].source).toBe("unsubscribe");

    const res2 = await GET(getReq(token));
    expect(res2.status).toBe(200);
    const consentsAfter = await db.consentRecord.findMany({
      where: { workspaceId: wsId, contactId, channel: "email", status: "OPTED_OUT" },
    });
    expect(consentsAfter).toHaveLength(1);
  });

  it("returns a generic 400 for an invalid token and writes nothing", async () => {
    await fixture();
    const before = await db.suppression.count({ where: { workspaceId: wsId } });
    const res = await GET(getReq("bogus.token"));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid");
    expect(await db.suppression.count({ where: { workspaceId: wsId } })).toBe(before);
  });

  it("returns a generic 400 when the token is missing", async () => {
    await fixture();
    const res = await GET(getReq(null));
    expect(res.status).toBe(400);
  });
});
