/**
 * WhatsApp freeform send through the real send pipeline (Batch A item 2).
 *
 * Regression test for the audit finding: sendFollowUp resolved the adapter
 * WITHOUT the getLastInboundAt lookup, so the real WhatsAppAdapter treated
 * every freeform send as outside the 24h window and threw — even when the
 * contact had messaged minutes earlier. Here the REAL adapter is built
 * from a CONNECTED integration's (encrypted, test) credentials and only
 * the Graph HTTP call is stubbed, so the send succeeds solely if the
 * pipeline wires the window lookup through.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db } from "@/lib/db";
import { encryptCredentials } from "@/lib/integrations/meta";
import { sendFollowUp, SendError } from "./send";

const suffix = `waw${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const pnid = `pnid-send-${suffix}`;
const phone = "15557654321";
const outWamid = `wamid.SEND.${suffix}.1`;

let wsId = "";
let userId = "";
let freshContactId = "";
let staleContactId = "";

const fetchStub = vi.fn(async () => {
  return new Response(JSON.stringify({ messages: [{ id: outWamid }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchStub);

  const user = await db.user.create({
    data: { email: `waw-${suffix}@example.com`, name: "WAW", passwordHash: "x" },
  });
  userId = user.id;
  const org = await db.organization.create({ data: { name: `WAW Org ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `WAW WS ${suffix}`, slug: `waw-${suffix}` },
  });
  wsId = w.id;
  await db.membership.create({ data: { userId: user.id, workspaceId: w.id, role: "OWNER" } });

  await db.integration.create({
    data: {
      workspaceId: w.id,
      provider: "whatsapp",
      status: "CONNECTED",
      externalAccountId: pnid,
      verifiedAt: new Date(),
      encryptedCredentials: encryptCredentials({
        provider: "whatsapp",
        accessToken: "test-token",
        expiresAt: null,
        phoneNumberId: pnid,
      }),
    },
  });

  const fresh = await db.contact.create({
    data: {
      workspaceId: w.id,
      name: "Fresh Fred",
      channel: "whatsapp",
      externalIds: JSON.stringify({ wa: `wa:${phone}` }),
      lastInboundAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
    },
  });
  freshContactId = fresh.id;

  const stale = await db.contact.create({
    data: {
      workspaceId: w.id,
      name: "Stale Sue",
      channel: "whatsapp",
      externalIds: JSON.stringify({ wa: `wa:15550009999` }),
      lastInboundAt: new Date(Date.now() - 48 * 3600 * 1000), // 48 hours ago
    },
  });
  staleContactId = stale.id;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("sendFollowUp — WhatsApp 24h window wiring", () => {
  it("sends a freeform message inside the window via the real adapter (stubbed Graph)", async () => {
    const result = await sendFollowUp({
      workspaceId: wsId,
      userId,
      contactId: freshContactId,
      channel: "whatsapp",
      messageType: "freeform",
      body: "Hi Fred, your order is ready!",
      idempotencyKey: `waw-fresh-${suffix}`,
    });
    expect(result.status).toBe("SENT");
    expect(result.mocked).toBe(false); // real adapter, not the mock
    expect(result.providerMessageId).toBe(outWamid);
    expect(fetchStub).toHaveBeenCalled();

    const row = await db.outboundSend.findUnique({
      where: { idempotencyKey: `waw-fresh-${suffix}` },
    });
    expect(row!.status).toBe("SENT");
    expect(row!.providerMessageId).toBe(outWamid);

    // The visible conversation copy carries the provider id so delivery
    // status webhooks can update it.
    const copy = await db.message.findFirst({
      where: { providerMessageId: outWamid, direction: "OUTBOUND" },
    });
    expect(copy).not.toBeNull();
    expect(copy!.body).toBe("Hi Fred, your order is ready!");
  });

  it("blocks a freeform message outside the window at the eligibility layer (422)", async () => {
    await expect(
      sendFollowUp({
        workspaceId: wsId,
        userId,
        contactId: staleContactId,
        channel: "whatsapp",
        messageType: "freeform",
        body: "Hi Sue, still there?",
        idempotencyKey: `waw-stale-${suffix}`,
      })
    ).rejects.toBeInstanceOf(SendError);
    const row = await db.outboundSend.findUnique({
      where: { idempotencyKey: `waw-stale-${suffix}` },
    });
    expect(row!.status).toBe("SKIPPED");
  });
});
