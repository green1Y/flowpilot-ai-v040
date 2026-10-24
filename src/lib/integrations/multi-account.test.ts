/**
 * Batch B — multi-account regression tests.
 *
 * The selected architecture: multiple connected accounts of the SAME
 * provider inside ONE workspace, with explicit account routing and zero
 * credential loss. Covered here (all provider HTTP is stubbed — mocked
 * verification only, nothing here is a live Meta test):
 *
 *  - Connect-level coexistence: upsertAccountRow creates a SECOND row for
 *    account B and never touches account A's stored credentials; a
 *    reconnect of A updates only A.
 *  - Plan limit: identified, non-DISCONNECTED accounts count toward
 *    Plan.connectedAccountLimit; placeholder rows (no provider identity)
 *    do not. At the limit, requireConnectedAccountRoom throws the honest
 *    402 PLAN_LIMIT_EXCEEDED.
 *  - Adapter resolution: default account wins; two usable accounts with
 *    no default = AMBIGUOUS_ACCOUNT (never "first row"); an explicit
 *    account id is used strictly (cross-workspace id = ACCOUNT_NOT_FOUND,
 *    disconnected = ACCOUNT_NOT_CONNECTED), and a send through the
 *    resolved adapter really addresses THAT account's phone_number_id.
 *  - Inbound: a WhatsApp message arriving on account B creates a
 *    conversation + CustomerEvent stamped with B; the same sender on
 *    account A gets a SEPARATE conversation stamped with A; dispatched
 *    workflow executions carry B's account id.
 *  - Send pipeline: sendFollowUp pinned to B sends through B even when A
 *    is the default, stamps OutboundSend.integrationId = B, and an
 *    unpinned send in an ambiguous workspace fails safely (SendError,
 *    FAILED row) instead of picking an account.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { db } from "@/lib/db";
import { encryptCredentials } from "./meta";
import { ingestMetaEvent, seenDeliveryIds } from "./ingest";
import {
  AccountResolutionError,
  resolveWorkspaceAdapter,
} from "./providers";
import {
  ensureDefaultAccount,
  findAccountRow,
  setDefaultAccount,
  upsertAccountRow,
} from "./accounts";
import {
  countConnectedAccounts,
  requireConnectedAccountRoom,
} from "@/lib/billing/usage";
import { sendFollowUp, SendError } from "@/lib/messaging/send";
import { resetQueue } from "@/lib/queue";

const suffix = `ma${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const pnidA = `pnid-a-${suffix}`;
const pnidB = `pnid-b-${suffix}`;
const senderPhone = "15551112222";

const fetchCalls: string[] = [];
const fetchStub = vi.fn(async (url: unknown) => {
  fetchCalls.push(String(url));
  return new Response(
    JSON.stringify({ messages: [{ id: `wamid.OUT.${suffix}.${fetchCalls.length}` }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
});

async function makeWorkspace(tag: string): Promise<string> {
  const org = await db.organization.create({ data: { name: `MA Org ${tag} ${suffix}` } });
  const w = await db.workspace.create({
    data: { orgId: org.id, name: `MA WS ${tag} ${suffix}`, slug: `ma-${tag}-${suffix}` },
  });
  return w.id;
}

async function makeWhatsappAccount(
  workspaceId: string,
  pnid: string,
  opts?: { isDefault?: boolean; status?: string; token?: string }
) {
  return db.integration.create({
    data: {
      workspaceId,
      provider: "whatsapp",
      status: opts?.status ?? "CONNECTED",
      externalAccountId: pnid,
      accountName: `WA ${pnid}`,
      isDefault: opts?.isDefault ?? false,
      verifiedAt: new Date(),
      encryptedCredentials: encryptCredentials({
        provider: "whatsapp",
        accessToken: opts?.token ?? `token-${pnid}`,
        expiresAt: null,
        phoneNumberId: pnid,
      }),
    },
  });
}

async function makeContact(workspaceId: string) {
  return db.contact.create({
    data: {
      workspaceId,
      name: "Multi Molly",
      channel: "whatsapp",
      externalIds: JSON.stringify({ wa: `wa:${senderPhone}` }),
      lastInboundAt: new Date(Date.now() - 5 * 60 * 1000),
    },
  });
}

function whatsappEntry(pnid: string, wamid: string, body: string) {
  return {
    id: `waba-${suffix}`,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: pnid },
          messages: [
            {
              from: senderPhone,
              id: wamid,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: "text",
              text: { body },
            },
          ],
        },
      },
    ],
  };
}

beforeAll(() => {
  vi.stubGlobal("fetch", fetchStub);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  resetQueue();
  seenDeliveryIds.clear();
  fetchCalls.length = 0;
});

describe("connect coexistence — upsertAccountRow", () => {
  it("creates a second account row and never overwrites the first account's credentials", async () => {
    const ws = await makeWorkspace("coexist");
    const credsA = encryptCredentials({
      provider: "whatsapp",
      accessToken: "token-A-original",
      expiresAt: null,
      phoneNumberId: pnidA,
    });
    const a = await upsertAccountRow({
      workspaceId: ws,
      provider: "whatsapp",
      externalAccountId: pnidA,
      create: {
        workspaceId: ws,
        provider: "whatsapp",
        status: "CONNECTED",
        externalAccountId: pnidA,
        encryptedCredentials: credsA,
        verifiedAt: new Date(),
      },
      update: { status: "CONNECTED", encryptedCredentials: credsA },
    });

    // Connect account B (a different WhatsApp number in the same workspace).
    const credsB = encryptCredentials({
      provider: "whatsapp",
      accessToken: "token-B",
      expiresAt: null,
      phoneNumberId: pnidB,
    });
    const b = await upsertAccountRow({
      workspaceId: ws,
      provider: "whatsapp",
      externalAccountId: pnidB,
      create: {
        workspaceId: ws,
        provider: "whatsapp",
        status: "CONNECTED",
        externalAccountId: pnidB,
        encryptedCredentials: credsB,
        verifiedAt: new Date(),
      },
      update: { status: "CONNECTED", encryptedCredentials: credsB },
    });

    expect(b.id).not.toBe(a.id);
    const rows = await db.integration.findMany({
      where: { workspaceId: ws, provider: "whatsapp" },
      orderBy: { externalAccountId: "asc" },
    });
    expect(rows).toHaveLength(2);
    // Both credentials preserved, byte-identical, and distinct.
    const rowA = rows.find((r) => r.externalAccountId === pnidA)!;
    const rowB = rows.find((r) => r.externalAccountId === pnidB)!;
    expect(rowA.encryptedCredentials).toBe(credsA);
    expect(rowB.encryptedCredentials).toBe(credsB);
    expect(rowA.encryptedCredentials).not.toBe(rowB.encryptedCredentials);

    // A reconnect of A (fresh token) updates ONLY A's row.
    const credsA2 = encryptCredentials({
      provider: "whatsapp",
      accessToken: "token-A-rotated",
      expiresAt: null,
      phoneNumberId: pnidA,
    });
    await upsertAccountRow({
      workspaceId: ws,
      provider: "whatsapp",
      externalAccountId: pnidA,
      create: {
        workspaceId: ws,
        provider: "whatsapp",
        status: "CONNECTED",
        externalAccountId: pnidA,
        encryptedCredentials: credsA2,
      },
      update: { status: "CONNECTED", encryptedCredentials: credsA2 },
    });
    const after = await db.integration.findMany({ where: { workspaceId: ws, provider: "whatsapp" } });
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.externalAccountId === pnidA)!.encryptedCredentials).toBe(credsA2);
    expect(after.find((r) => r.externalAccountId === pnidB)!.encryptedCredentials).toBe(credsB);
    expect(await findAccountRow(ws, "whatsapp", pnidB)).not.toBeNull();
  });
});

describe("default account management", () => {
  it("ensureDefaultAccount marks the first CONNECTED account; setDefaultAccount moves it atomically", async () => {
    const ws = await makeWorkspace("defaults");
    const a = await makeWhatsappAccount(ws, pnidA);
    const b = await makeWhatsappAccount(ws, pnidB);

    await ensureDefaultAccount(ws, "whatsapp", a.id);
    await ensureDefaultAccount(ws, "whatsapp", b.id); // must NOT steal the default
    let rows = await db.integration.findMany({ where: { workspaceId: ws, provider: "whatsapp" } });
    expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual([a.id]);

    await setDefaultAccount(ws, b.id);
    rows = await db.integration.findMany({ where: { workspaceId: ws, provider: "whatsapp" } });
    expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual([b.id]);
  });
});

describe("connected-account plan limit", () => {
  it("counts identified live accounts only and throws the honest 402 at the limit", async () => {
    const plan = await db.plan.create({
      data: {
        name: `MA Plan ${suffix}`,
        monthlyMessageLimit: 500,
        workflowLimit: 5,
        seatLimit: 3,
        connectedAccountLimit: 2,
      },
    });
    const org = await db.organization.create({ data: { name: `MA Plan Org ${suffix}` } });
    const w = await db.workspace.create({
      data: { orgId: org.id, name: `MA Plan WS ${suffix}`, slug: `ma-plan-${suffix}`, planId: plan.id },
    });

    // Placeholder rows (no provider identity) never count.
    await db.integration.create({
      data: { workspaceId: w.id, provider: "telegram", status: "DEMO", externalAccountId: null },
    });
    await db.integration.create({
      data: { workspaceId: w.id, provider: "email", status: "NEEDS_ATTENTION", externalAccountId: null },
    });
    expect(await countConnectedAccounts(w.id)).toBe(0);
    await expect(requireConnectedAccountRoom(w.id)).resolves.toBeTruthy();

    await makeWhatsappAccount(w.id, pnidA);
    await makeWhatsappAccount(w.id, pnidB);
    expect(await countConnectedAccounts(w.id)).toBe(2);

    // At the limit: the thrown value is the honest 402 Response.
    let thrown: unknown = null;
    try {
      await requireConnectedAccountRoom(w.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(402);
    const payload = await (thrown as Response).json();
    expect(payload.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(payload.used).toBe(2);
    expect(payload.limit).toBe(2);

    // Disconnecting one frees room again.
    await db.integration.updateMany({
      where: { workspaceId: w.id, externalAccountId: pnidB },
      data: { status: "DISCONNECTED" },
    });
    expect(await countConnectedAccounts(w.id)).toBe(1);
    await expect(requireConnectedAccountRoom(w.id)).resolves.toBeTruthy();
  });
});

describe("adapter resolution — explicit routing", () => {
  it("resolves the default account implicitly, and the pinned account explicitly (send hits THAT phone_number_id)", async () => {
    const ws = await makeWorkspace("resolve");
    const a = await makeWhatsappAccount(ws, pnidA, { isDefault: true });
    const b = await makeWhatsappAccount(ws, pnidB);

    const implicit = await resolveWorkspaceAdapter(ws, "whatsapp", {
      getLastInboundAt: async () => new Date(),
    });
    expect(implicit.integrationId).toBe(a.id);
    expect(implicit.mocked).toBe(false);

    const pinned = await resolveWorkspaceAdapter(ws, "whatsapp", {
      integrationId: b.id,
      getLastInboundAt: async () => new Date(),
    });
    expect(pinned.integrationId).toBe(b.id);
    const res = await pinned.adapter.sendMessage({ to: senderPhone, body: "via B" });
    expect(res.ok).toBe(true);
    // The Graph call must address account B's number — never A's.
    expect(fetchCalls.some((u) => u.includes(`/${pnidB}/messages`))).toBe(true);
    expect(fetchCalls.some((u) => u.includes(`/${pnidA}/messages`))).toBe(false);
  });

  it("fails safe on ambiguity: two usable accounts, no default, no pin", async () => {
    const ws = await makeWorkspace("ambig");
    await makeWhatsappAccount(ws, pnidA);
    await makeWhatsappAccount(ws, pnidB);
    await expect(resolveWorkspaceAdapter(ws, "whatsapp")).rejects.toMatchObject({
      name: "AccountResolutionError",
      code: "AMBIGUOUS_ACCOUNT",
    });
  });

  it("rejects cross-workspace and disconnected explicit accounts", async () => {
    const wsA = await makeWorkspace("xws-a");
    const wsB = await makeWorkspace("xws-b");
    const foreign = await makeWhatsappAccount(wsB, pnidB);
    const gone = await makeWhatsappAccount(wsA, pnidA, { status: "DISCONNECTED" });

    // An id from another workspace must not resolve (and must not leak).
    await expect(
      resolveWorkspaceAdapter(wsA, "whatsapp", { integrationId: foreign.id })
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    await expect(
      resolveWorkspaceAdapter(wsA, "whatsapp", { integrationId: gone.id })
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_CONNECTED" });
    expect(new AccountResolutionError("ACCOUNT_NOT_FOUND", "x")).toBeInstanceOf(Error);
  });
});

describe("inbound ingest — account-stamped, account-scoped", () => {
  it("stamps conversations/events/executions with the receiving account and keeps per-account conversations separate", async () => {
    const ws = await makeWorkspace("ingest");
    const a = await makeWhatsappAccount(ws, pnidA, { isDefault: true });
    const b = await makeWhatsappAccount(ws, pnidB);

    // A PUBLISHED workflow proves dispatch keeps the account too.
    const wf = await db.workflow.create({
      data: {
        workspaceId: ws,
        name: `MA WF ${suffix}`,
        status: "PUBLISHED",
        nodes: {
          create: [
            {
              id: `ma-t-${suffix}`,
              kind: "trigger",
              type: "trigger.new_message",
              label: "New message",
              config: "{}",
              position: "{}",
            },
            {
              id: `ma-a-${suffix}`,
              kind: "action",
              type: "action.add_tag",
              label: "Tag",
              config: JSON.stringify({ tag: "auto" }),
              position: "{}",
            },
          ],
        },
        edges: {
          create: [{ id: `ma-e-${suffix}`, sourceId: `ma-t-${suffix}`, targetId: `ma-a-${suffix}`, label: "", condition: "{}" }],
        },
      },
    });

    const r1 = await ingestMetaEvent(
      { id: b.id, workspaceId: ws, provider: "whatsapp" },
      whatsappEntry(pnidB, `wamid.IN.B.${suffix}`, "hello via B")
    );
    expect(r1.failed).toBe(false);
    expect(r1.messages).toBe(1);

    const convsB = await db.conversation.findMany({ where: { workspaceId: ws, integrationId: b.id } });
    expect(convsB).toHaveLength(1);
    const evB = await db.customerEvent.findFirst({
      where: { workspaceId: ws, type: "message_received", providerEventId: `wamid:wamid.IN.B.${suffix}` },
    });
    expect(evB?.integrationId).toBe(b.id);

    const exec = await db.workflowExecution.findFirst({ where: { workflowId: wf.id } });
    expect(exec).not.toBeNull();
    expect(exec!.integrationId).toBe(b.id);

    // Same human, same channel — but arriving on account A: a SEPARATE
    // conversation, stamped A. The contact is shared (per-channel
    // identity); conversations are the isolation boundary.
    const r2 = await ingestMetaEvent(
      { id: a.id, workspaceId: ws, provider: "whatsapp" },
      whatsappEntry(pnidA, `wamid.IN.A.${suffix}`, "hello via A")
    );
    expect(r2.messages).toBe(1);
    const allConvs = await db.conversation.findMany({ where: { workspaceId: ws } });
    expect(allConvs).toHaveLength(2);
    expect(allConvs.find((c) => c.id === convsB[0].id)).toBeTruthy();
    expect(allConvs.some((c) => c.integrationId === a.id)).toBe(true);
  });
});

describe("send pipeline — account pinning", () => {
  it("sends through the pinned account even when another account is default, and stamps the send", async () => {
    const ws = await makeWorkspace("sendpin");
    const a = await makeWhatsappAccount(ws, pnidA, { isDefault: true });
    const b = await makeWhatsappAccount(ws, pnidB);
    const contact = await makeContact(ws);

    const result = await sendFollowUp({
      workspaceId: ws,
      userId: null,
      contactId: contact.id,
      channel: "whatsapp",
      messageType: "freeform",
      body: "pinned to B",
      idempotencyKey: `ma-pin-b-${suffix}`,
      integrationId: b.id,
    });
    expect(result.status).toBe("SENT");
    expect(result.mocked).toBe(false);
    expect(result.integrationId).toBe(b.id);
    expect(fetchCalls.some((u) => u.includes(`/${pnidB}/messages`))).toBe(true);
    expect(fetchCalls.some((u) => u.includes(`/${pnidA}/messages`))).toBe(false);

    const row = await db.outboundSend.findUnique({ where: { idempotencyKey: `ma-pin-b-${suffix}` } });
    expect(row!.integrationId).toBe(b.id);

    // Unpinned: the default account (A) is used deterministically.
    fetchCalls.length = 0;
    const result2 = await sendFollowUp({
      workspaceId: ws,
      userId: null,
      contactId: contact.id,
      channel: "whatsapp",
      messageType: "freeform",
      body: "default route",
      idempotencyKey: `ma-pin-default-${suffix}`,
    });
    expect(result2.integrationId).toBe(a.id);
    expect(fetchCalls.some((u) => u.includes(`/${pnidA}/messages`))).toBe(true);
  });

  it("fails safely (no silent re-route) when the workspace's accounts are ambiguous", async () => {
    const ws = await makeWorkspace("sendambig");
    await makeWhatsappAccount(ws, pnidA);
    await makeWhatsappAccount(ws, pnidB);
    const contact = await makeContact(ws);

    let thrown: unknown = null;
    try {
      await sendFollowUp({
        workspaceId: ws,
        userId: null,
        contactId: contact.id,
        channel: "whatsapp",
        messageType: "freeform",
        body: "should not send",
        idempotencyKey: `ma-ambig-${suffix}`,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SendError);
    expect((thrown as SendError).extra?.code).toBe("AMBIGUOUS_ACCOUNT");
    // No Graph call was made, and the failure is on record.
    expect(fetchCalls).toHaveLength(0);
    const row = await db.outboundSend.findUnique({ where: { idempotencyKey: `ma-ambig-${suffix}` } });
    expect(row!.status).toBe("FAILED");
    expect(row!.error).toContain("refusing to guess");
  });
});
