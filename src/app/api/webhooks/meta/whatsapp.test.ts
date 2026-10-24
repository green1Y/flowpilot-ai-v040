/**
 * WhatsApp Cloud API webhook tests (Batch A — mocked HTTP, no real Meta
 * traffic). Covers the gaps the release audit found:
 *  - object "whatsapp_business_account" is routed into ingest (was dropped).
 *  - Inbound message → contact / conversation / message rows, provider id
 *    stamped on the Message.
 *  - value.statuses[] transitions OutboundSend.deliveryStatus (+ visible
 *    Message copy) and emits message_delivered / message_read /
 *    message_failed CustomerEvents; SENT stays the acceptance record.
 *  - Redelivery after a process restart (in-memory dedupe cleared) still
 *    produces exactly one Message — the durable CustomerEvent gate.
 *  - Fan-out guard: one phone_number_id connected in two workspaces routes
 *    only to the credential-confirmed owner; a fully ambiguous match
 *    ingests nowhere.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { POST } from "./route";
import { seenDeliveryIds } from "@/lib/integrations/ingest";
import { encryptCredentials } from "@/lib/integrations/meta";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-app-secret-for-whatsapp";
process.env.META_VERIFY_TOKEN = "test-verify-token-wa";
process.env.APP_PUBLIC_URL = "https://example.test";

function sign(raw: string): string {
  return (
    "sha256=" +
    createHmac("sha256", process.env.META_APP_SECRET as string)
      .update(raw, "utf8")
      .digest("hex")
  );
}

function postReq(raw: string): NextRequest {
  return new NextRequest("http://x/api/webhooks/meta", {
    method: "POST",
    headers: { "x-hub-signature-256": sign(raw), "content-type": "application/json" },
    body: raw,
  });
}

const suffix = `wa${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const pnidMain = `pnid-main-${suffix}`;
const pnidShared = `pnid-shared-${suffix}`;
const pnidAmb = `pnid-amb-${suffix}`;
const wabaId = `waba-${suffix}`;
const senderPhone = "15559998888";

let wsMain = "";
let wsOwner = "";
let wsOther = "";
let wsAmbA = "";
let wsAmbB = "";

async function makeWorkspace(tag: string): Promise<string> {
  const org = await db.organization.create({ data: { name: `WA Org ${tag} ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `WA WS ${tag} ${suffix}`, slug: `wa-${tag}-${suffix}` },
  });
  return w.id;
}

async function makeWhatsappIntegration(
  workspaceId: string,
  pnid: string,
  credPhoneNumberId?: string
) {
  return db.integration.create({
    data: {
      workspaceId,
      provider: "whatsapp",
      status: "CONNECTED",
      externalAccountId: pnid,
      verifiedAt: new Date(),
      ...(credPhoneNumberId
        ? {
            encryptedCredentials: encryptCredentials({
              provider: "whatsapp",
              accessToken: "test-token",
              expiresAt: null,
              phoneNumberId: credPhoneNumberId,
            }),
          }
        : {}),
    },
  });
}

beforeAll(async () => {
  mockedRequireUser.mockResolvedValue({
    userId: "wa-user",
    email: "wa@example.com",
    user: { id: "wa-user", name: "WA", email: "wa@example.com" },
  } as any);

  wsMain = await makeWorkspace("main");
  await makeWhatsappIntegration(wsMain, pnidMain);

  // Fan-out: the same number connected in two workspaces. Only wsOwner's
  // credentials actually contain the phone_number_id.
  wsOwner = await makeWorkspace("owner");
  wsOther = await makeWorkspace("other");
  await makeWhatsappIntegration(wsOwner, pnidShared, pnidShared);
  await makeWhatsappIntegration(wsOther, pnidShared, `different-${suffix}`);

  // Fully ambiguous: both workspaces' credentials contain the number.
  wsAmbA = await makeWorkspace("amba");
  wsAmbB = await makeWorkspace("ambb");
  await makeWhatsappIntegration(wsAmbA, pnidAmb, pnidAmb);
  await makeWhatsappIntegration(wsAmbB, pnidAmb, pnidAmb);
});

function waMessageBody(pnid: string, wamid: string, text: string, entryTime?: number) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: wabaId,
        ...(entryTime != null ? { time: entryTime } : {}),
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: pnid },
              contacts: [{ profile: { name: "Wa User" }, wa_id: senderPhone }],
              messages: [
                {
                  from: senderPhone,
                  id: wamid,
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

function waStatusBody(pnid: string, wamid: string, status: string, ts: string, withError = false) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: pnid },
              statuses: [
                {
                  id: wamid,
                  status,
                  timestamp: ts,
                  recipient_id: senderPhone,
                  ...(withError
                    ? { errors: [{ code: 131047, title: "Re-engagement message", message: "24h window expired" }] }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function messagesIn(wsId: string) {
  return db.message.findMany({
    where: { conversation: { workspaceId: wsId } },
    include: { conversation: true },
  });
}

describe("WhatsApp inbound webhook (object routing + ingest)", () => {
  const wamid = `wamid.IN.${suffix}.1`;

  it("creates contact, conversation and message from a whatsapp_business_account payload", async () => {
    const res = await POST(postReq(waMessageBody(pnidMain, wamid, "hello whatsapp")));
    expect(res.status).toBe(200);

    const msgs = await messagesIn(wsMain);
    const inbound = msgs.filter((m) => m.direction === "INBOUND");
    expect(inbound.length).toBe(1);
    expect(inbound[0].body).toBe("hello whatsapp");
    expect(inbound[0].providerMessageId).toBe(wamid);
    expect(inbound[0].conversation.channel).toBe("whatsapp");

    const contact = await db.contact.findFirst({ where: { workspaceId: wsMain } });
    expect(contact).not.toBeNull();
    const ids = JSON.parse(contact!.externalIds || "{}");
    expect(ids.wa).toBe(`wa:${senderPhone}`);
    expect(contact!.lastInboundAt).not.toBeNull();
  });

  it("redelivery after restart (in-memory dedupe cleared) does not duplicate the message", async () => {
    const before = (await messagesIn(wsMain)).length;
    // Simulate a process restart: the in-memory seen-set is empty again.
    seenDeliveryIds.clear();
    const res = await POST(postReq(waMessageBody(pnidMain, wamid, "hello whatsapp")));
    expect(res.status).toBe(200);
    expect((await messagesIn(wsMain)).length).toBe(before);
    // And only one message_received event exists for this wamid.
    const events = await db.customerEvent.count({
      where: { workspaceId: wsMain, providerEventId: `wamid:${wamid}`, type: "message_received" },
    });
    expect(events).toBe(1);
  });
});

describe("WhatsApp delivery statuses", () => {
  const outWamid = `wamid.OUT.${suffix}.1`;
  const failWamid = `wamid.OUT.${suffix}.2`;
  let outboundId = "";

  beforeAll(async () => {
    const contact = await db.contact.findFirst({ where: { workspaceId: wsMain } });
    const conv = await db.conversation.findFirst({ where: { workspaceId: wsMain } });
    const send = await db.outboundSend.create({
      data: {
        workspaceId: wsMain,
        contactId: contact!.id,
        channel: "whatsapp",
        messageType: "freeform",
        body: "your order shipped",
        idempotencyKey: `wa-status-test-${suffix}`,
        status: "SENT",
        providerMessageId: outWamid,
        mocked: false,
      },
    });
    outboundId = send.id;
    await db.outboundSend.create({
      data: {
        workspaceId: wsMain,
        contactId: contact!.id,
        channel: "whatsapp",
        messageType: "template",
        body: "template body",
        idempotencyKey: `wa-status-test-fail-${suffix}`,
        status: "SENT",
        providerMessageId: failWamid,
        mocked: false,
      },
    });
    await db.message.create({
      data: {
        conversationId: conv!.id,
        direction: "OUTBOUND",
        body: "your order shipped",
        providerMessageId: outWamid,
        mocked: false,
      },
    });
  });

  it("transitions deliveryStatus sent → delivered → read and keeps status = SENT (acceptance)", async () => {
    let res = await POST(postReq(waStatusBody(pnidMain, outWamid, "sent", "1700000100")));
    expect(res.status).toBe(200);
    let row = await db.outboundSend.findUnique({ where: { id: outboundId } });
    expect(row!.deliveryStatus).toBe("sent");
    expect(row!.status).toBe("SENT");

    res = await POST(postReq(waStatusBody(pnidMain, outWamid, "delivered", "1700000200")));
    expect(res.status).toBe(200);
    row = await db.outboundSend.findUnique({ where: { id: outboundId } });
    expect(row!.deliveryStatus).toBe("delivered");
    expect(row!.deliveryStatusAt).not.toBeNull();
    expect(row!.status).toBe("SENT");

    res = await POST(postReq(waStatusBody(pnidMain, outWamid, "read", "1700000300")));
    expect(res.status).toBe(200);
    row = await db.outboundSend.findUnique({ where: { id: outboundId } });
    expect(row!.deliveryStatus).toBe("read");

    // Out-of-order redelivery of "delivered" must not move it backwards.
    res = await POST(postReq(waStatusBody(pnidMain, outWamid, "delivered", "1700000200")));
    expect(res.status).toBe(200);
    row = await db.outboundSend.findUnique({ where: { id: outboundId } });
    expect(row!.deliveryStatus).toBe("read");

    // Visible message copy mirrors the most recently received status
    // (the monotonic record of truth is OutboundSend, asserted above).
    const copy = await db.message.findFirst({
      where: { providerMessageId: outWamid, direction: "OUTBOUND" },
    });
    expect(copy!.deliveryStatus).toBe("delivered");

    const delivered = await db.customerEvent.count({
      where: { workspaceId: wsMain, type: "message_delivered", providerEventId: `wa-status:${outWamid}:delivered` },
    });
    const read = await db.customerEvent.count({
      where: { workspaceId: wsMain, type: "message_read", providerEventId: `wa-status:${outWamid}:read` },
    });
    expect(delivered).toBe(1);
    expect(read).toBe(1);
  });

  it("records failed delivery with the provider error and emits message_failed", async () => {
    const res = await POST(postReq(waStatusBody(pnidMain, failWamid, "failed", "1700000400", true)));
    expect(res.status).toBe(200);
    const row = await db.outboundSend.findFirst({ where: { providerMessageId: failWamid } });
    expect(row!.deliveryStatus).toBe("failed");
    expect(row!.status).toBe("SENT"); // acceptance record unchanged
    const ev = await db.customerEvent.findFirst({
      where: { workspaceId: wsMain, type: "message_failed", providerEventId: `wa-status:${failWamid}:failed` },
    });
    expect(ev).not.toBeNull();
    expect(JSON.parse(ev!.metadata).error).toContain("Re-engagement message");
  });
});

describe("webhook fan-out guard", () => {
  it("routes a shared phone_number_id only to the credential-confirmed workspace", async () => {
    const wamid = `wamid.SHARED.${suffix}.1`;
    const res = await POST(postReq(waMessageBody(pnidShared, wamid, "shared number hello")));
    expect(res.status).toBe(200);
    expect((await messagesIn(wsOwner)).length).toBe(1);
    expect((await messagesIn(wsOther)).length).toBe(0);
  });

  it("ingests nowhere when the cross-workspace match is fully ambiguous", async () => {
    const wamid = `wamid.AMB.${suffix}.1`;
    const res = await POST(postReq(waMessageBody(pnidAmb, wamid, "ambiguous hello")));
    expect(res.status).toBe(200);
    expect((await messagesIn(wsAmbA)).length).toBe(0);
    expect((await messagesIn(wsAmbB)).length).toBe(0);
  });
});
