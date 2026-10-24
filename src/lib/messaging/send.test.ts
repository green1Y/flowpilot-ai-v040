/**
 * Stage 2 — send pipeline tests.
 *
 * renderTemplate: pure unit tests.
 * sendFollowUp / processDueFollowUps: DB-backed with the workspace adapter
 * resolution mocked out (no real Meta calls; the mock adapter path is what
 * the pipeline uses without CONNECTED credentials anyway).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { db } from "@/lib/db";
import { getWorkspaceAdapter } from "@/lib/integrations/providers";
import {
  renderTemplate,
  sendFollowUp,
  processDueFollowUps,
  SendError,
} from "./send";

vi.mock("@/lib/integrations/providers", () => {
  // Batch B: the send pipeline / engine resolve adapters via
  // resolveWorkspaceAdapter (which also reports the account used).
  // Delegate it to the getWorkspaceAdapter stub so this file's existing
  // fake-adapter setups keep working unchanged; resolution reports the
  // mock path (integrationId null), as these tests predate account routing.
  const getWorkspaceAdapter = vi.fn();
  const resolveWorkspaceAdapter = vi.fn(
    async (...args: unknown[]) => {
      const adapter = await (getWorkspaceAdapter as any)(...args);
      return { adapter, integrationId: null, mocked: true };
    }
  );
  class AccountResolutionError extends Error {
    code = "AMBIGUOUS_ACCOUNT";
  }
  return { getWorkspaceAdapter, resolveWorkspaceAdapter, AccountResolutionError };
});
const mockedGetAdapter = vi.mocked(getWorkspaceAdapter);

/** Fake adapter; sendMessage is a per-test vi.fn we can assert on. */
function fakeAdapter(opts?: {
  sendImpl?: (input: { to: string; body: string; templateName?: string }) => Promise<any>;
  replyImpl?: (input: { commentId: string; body: string }) => Promise<any>;
  withReply?: boolean;
}) {
  const sendMessage = vi.fn(async (input: { to: string; body: string; templateName?: string }) => {
    if (opts?.sendImpl) return opts.sendImpl(input);
    return { ok: true, mocked: true, externalId: "mock-ext-1" };
  });
  const adapter: any = {
    provider: "facebook",
    displayName: "Fake",
    capabilities: [],
    limitations: [],
    requiredPermissions: [],
    connect: async () => ({ ok: true, verified: false, status: "DISCONNECTED", message: "" }),
    verify: async () => ({ ok: true, verified: false, status: "DISCONNECTED", message: "" }),
    sendMessage,
    verifyWebhookSignature: () => true,
    __sendMessage: sendMessage,
  };
  if (opts?.withReply) {
    const replyToComment = vi.fn(async (input: { commentId: string; body: string }) => {
      if (opts?.replyImpl) return opts.replyImpl(input);
      return { ok: true, mocked: true, externalId: "mock-pr-1" };
    });
    adapter.replyToComment = replyToComment;
    adapter.__replyToComment = replyToComment;
  }
  mockedGetAdapter.mockResolvedValue(adapter);
  return adapter;
}

const suffix = `s2${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsId = "";
let userId = "";
let integId = "";

async function makeContact(overrides: Record<string, any> = {}) {
  return db.contact.create({
    data: {
      workspaceId: wsId,
      name: "Ada Lovelace",
      channel: "facebook",
      externalIds: JSON.stringify({ PSID: `psid-${suffix}-${Math.random()}` }),
      ...overrides,
    },
  });
}

function sendInput(contactId: string, overrides: Record<string, any> = {}) {
  return {
    workspaceId: wsId,
    userId,
    contactId,
    channel: "facebook" as const,
    messageType: "freeform" as const,
    body: "Hi {{firstName}}, just checking in!",
    idempotencyKey: `key-${suffix}-${Math.random()}`,
    ...overrides,
  };
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `s2-${suffix}@example.com`, name: "S2 User", passwordHash: "x" },
  });
  userId = user.id;
  const org = await db.organization.create({ data: { name: `S2 Org ${suffix}` } });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `S2 WS ${suffix}`, slug: `s2-${suffix}` },
  });
  wsId = ws.id;
  const integ = await db.integration.create({
    data: { workspaceId: wsId, provider: "instagram", status: "DISCONNECTED" },
  });
  integId = integ.id;
});

describe("renderTemplate", () => {
  const contact = { id: "c", name: "Ada Lovelace" };
  it("replaces {{name}}, {{firstName}} and {{channel}}", () => {
    expect(renderTemplate("Hi {{firstName}} ({{name}}) via {{channel}}", contact, "whatsapp")).toBe(
      "Hi Ada (Ada Lovelace) via whatsapp"
    );
  });
  it("tolerates whitespace inside braces", () => {
    expect(renderTemplate("Hi {{ firstName }}", contact, "instagram")).toBe("Hi Ada");
  });
  it("leaves unknown variables as-is", () => {
    expect(renderTemplate("Hi {{nickname}}", contact, "instagram")).toBe("Hi {{nickname}}");
  });
  it("handles single-word names for firstName", () => {
    expect(renderTemplate("Hi {{firstName}}", { id: "c", name: "Plato" }, "facebook")).toBe("Hi Plato");
  });
});

describe("sendFollowUp", () => {
  it("404s for a missing contact", async () => {
    fakeAdapter();
    await expect(sendFollowUp(sendInput("nope"))).rejects.toMatchObject({ status: 404 });
  });

  it("blocks suppressed contacts: 422 + SKIPPED row + no send call", async () => {
    const adapter = fakeAdapter();
    const contact = await makeContact({ lastInboundAt: new Date() });
    await db.suppression.create({
      data: { workspaceId: wsId, contactId: contact.id, channel: null, reason: "opt-out" },
    });
    const input = sendInput(contact.id);
    const followUp = await db.followUp.create({
      data: {
        workspaceId: wsId, contactId: contact.id, channel: "facebook",
        messageType: "freeform", body: "x", scheduledAt: new Date(),
        status: "SCHEDULED", idempotencyKey: input.idempotencyKey,
      },
    });
    await expect(
      sendFollowUp({ ...input, followUpId: followUp.id })
    ).rejects.toMatchObject({ status: 422, message: "Contact is suppressed" });

    expect(adapter.__sendMessage).not.toHaveBeenCalled();
    const skipped = await db.outboundSend.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    expect(skipped?.status).toBe("SKIPPED");
    const fu = await db.followUp.findUnique({ where: { id: followUp.id } });
    expect(fu?.status).toBe("CANCELLED");
  });

  it("blocks ineligible contacts (window lapsed): 422 + SKIPPED + no send", async () => {
    const adapter = fakeAdapter();
    const contact = await makeContact({
      lastInboundAt: new Date(Date.now() - 48 * 3600 * 1000), // 48h ago
    });
    const input = sendInput(contact.id);
    await expect(sendFollowUp(input)).rejects.toMatchObject({ status: 422 });
    expect(adapter.__sendMessage).not.toHaveBeenCalled();
    const skipped = await db.outboundSend.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    expect(skipped?.status).toBe("SKIPPED");
    expect(skipped?.error).toContain("24-hour");
  });

  it("is idempotent: retry with the same key sends exactly once", async () => {
    const adapter = fakeAdapter();
    const contact = await makeContact({ lastInboundAt: new Date() });
    const input = sendInput(contact.id);
    const first = await sendFollowUp(input);
    expect(first.duplicate).toBe(false);
    expect(first.status).toBe("SENT");
    const second = await sendFollowUp(input);
    expect(second.duplicate).toBe(true);
    expect(second.outboundSendId).toBe(first.outboundSendId);
    expect(adapter.__sendMessage).toHaveBeenCalledTimes(1);
  });

  it("success path: SENT + honest mocked Message + lastOutboundAt + audit", async () => {
    const adapter = fakeAdapter();
    const contact = await makeContact({ lastInboundAt: new Date() });
    const input = sendInput(contact.id, { body: "Hello {{name}}" });
    const followUp = await db.followUp.create({
      data: {
        workspaceId: wsId, contactId: contact.id, channel: "facebook",
        messageType: "freeform", body: "Hello {{name}}", scheduledAt: new Date(),
        status: "SCHEDULED", idempotencyKey: input.idempotencyKey,
      },
    });
    const result = await sendFollowUp({ ...input, followUpId: followUp.id });
    expect(result.status).toBe("SENT");
    expect(result.mocked).toBe(true);
    expect(result.providerMessageId).toBe("mock-ext-1");

    const [toArg] = adapter.__sendMessage.mock.calls[0];
    expect(toArg.body).toBe("Hello Ada Lovelace"); // rendered
    expect(toArg.to).toContain("psid-");

    const fu = await db.followUp.findUnique({ where: { id: followUp.id } });
    expect(fu?.status).toBe("SENT");
    expect(fu?.sentAt).not.toBeNull();

    const updated = await db.contact.findUnique({ where: { id: contact.id } });
    expect(updated?.lastOutboundAt).not.toBeNull();

    const conv = await db.conversation.findFirst({
      where: { workspaceId: wsId, contactId: contact.id },
    });
    const msg = await db.message.findFirst({
      where: { conversationId: conv!.id, direction: "OUTBOUND" },
      orderBy: { createdAt: "desc" },
    });
    expect(msg?.mocked).toBe(true);
    expect(msg?.body).toBe("Hello Ada Lovelace");

    const audit = await db.auditEvent.findFirst({
      where: { workspaceId: wsId, action: "followup.sent" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  it("records FAILED + marks follow-up on provider errors", async () => {
    fakeAdapter({
      sendImpl: async () => ({ ok: false, mocked: false, externalId: null, error: "boom 503" }),
    });
    const contact = await makeContact({ lastInboundAt: new Date() });
    const input = sendInput(contact.id);
    const followUp = await db.followUp.create({
      data: {
        workspaceId: wsId, contactId: contact.id, channel: "facebook",
        messageType: "freeform", body: "x", scheduledAt: new Date(),
        status: "SCHEDULED", idempotencyKey: input.idempotencyKey,
      },
    });
    await expect(sendFollowUp({ ...input, followUpId: followUp.id })).rejects.toBeInstanceOf(SendError);
    const failed = await db.outboundSend.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    expect(failed?.status).toBe("FAILED");
    expect(failed?.error).toContain("retryable"); // 503 is retryable
    const fu = await db.followUp.findUnique({ where: { id: followUp.id } });
    expect(fu?.status).toBe("FAILED");
  });

  it("private_reply uses replyToComment and stamps the comment", async () => {
    const adapter = fakeAdapter({ withReply: true });
    const contact = await makeContact({ channel: "instagram" });
    const comment = await db.comment.create({
      data: {
        workspaceId: wsId, contactId: contact.id, integrationId: integId,
        externalId: `cmt-${suffix}-${Math.random()}`, authorExternalId: "ig1",
        mediaId: "m1", text: "nice!", commentedAt: new Date(),
        privateReplyEligibleUntil: new Date(Date.now() + 6 * 86400000),
      },
    });
    const input = sendInput(contact.id, {
      channel: "instagram" as const,
      messageType: "private_reply" as const,
      commentId: comment.externalId,
    });
    const result = await sendFollowUp(input);
    expect(result.status).toBe("SENT");
    expect(adapter.__replyToComment).toHaveBeenCalledTimes(1);
    const updated = await db.comment.findUnique({ where: { id: comment.id } });
    expect(updated?.privateRepliedAt).not.toBeNull();
  });

  it("private_reply fails honestly when the adapter has no private-reply path", async () => {
    fakeAdapter(); // no replyToComment
    const contact = await makeContact({ channel: "instagram" });
    const comment = await db.comment.create({
      data: {
        workspaceId: wsId, contactId: contact.id, integrationId: integId,
        externalId: `cmt2-${suffix}-${Math.random()}`, authorExternalId: "ig1",
        mediaId: "m1", text: "nice!", commentedAt: new Date(),
        privateReplyEligibleUntil: new Date(Date.now() + 6 * 86400000),
      },
    });
    const input = sendInput(contact.id, {
      channel: "instagram" as const,
      messageType: "private_reply" as const,
      commentId: comment.externalId,
    });
    await expect(sendFollowUp(input)).rejects.toMatchObject({ status: 502 });
    const failed = await db.outboundSend.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    expect(failed?.status).toBe("FAILED");
  });

  it("enforces one private reply per comment", async () => {
    fakeAdapter({ withReply: true });
    const contact = await makeContact({ channel: "instagram" });
    const comment = await db.comment.create({
      data: {
        workspaceId: wsId, contactId: contact.id, integrationId: integId,
        externalId: `cmt3-${suffix}-${Math.random()}`, authorExternalId: "ig1",
        mediaId: "m1", text: "nice!", commentedAt: new Date(),
        privateRepliedAt: new Date(), // already replied
        privateReplyEligibleUntil: new Date(Date.now() + 6 * 86400000),
      },
    });
    const adapter = fakeAdapter({ withReply: true });
    const input = sendInput(contact.id, {
      channel: "instagram" as const,
      messageType: "private_reply" as const,
      commentId: comment.externalId,
    });
    await expect(sendFollowUp(input)).rejects.toMatchObject({ status: 422 });
    expect(adapter.__replyToComment).not.toHaveBeenCalled();
  });
});

describe("sendFollowUp token refresh (D2)", () => {
  it("refreshes an expiring token before sending and persists it re-encrypted", async () => {
    // Refresh path reads Meta env lazily.
    process.env.META_APP_ID = "test-app-id";
    process.env.META_APP_SECRET = "test-app-secret";
    process.env.META_VERIFY_TOKEN = "test-verify-token";
    process.env.APP_PUBLIC_URL = "https://example.test";
    const freshToken = `fresh-send-${suffix}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: freshToken, expires_in: 60 * 24 * 60 * 60 }),
      }))
    );
    const { encryptCredentials, decryptCredentials } = await import(
      "@/lib/integrations/meta"
    );
    const row = await db.integration.create({
      data: {
        workspaceId: wsId,
        provider: "facebook",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "facebook",
          accessToken: `stale-send-${suffix}`,
          // Inside the 7-day refresh window.
          expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
          pageId: `page-send-${suffix}`,
        }),
      },
    });
    try {
      fakeAdapter();
      const contact = await makeContact({ lastInboundAt: new Date() });
      const result = await sendFollowUp(sendInput(contact.id));
      expect(result.status).toBe("SENT");
      const reloaded = await db.integration.findUnique({ where: { id: row.id } });
      expect(decryptCredentials(reloaded!.encryptedCredentials!).accessToken).toBe(
        freshToken
      );
    } finally {
      vi.unstubAllGlobals();
      await db.integration.delete({ where: { id: row.id } });
    }
  });

  it("a refresh failure never breaks the send (best-effort, old semantics kept)", async () => {
    process.env.META_APP_ID = "test-app-id";
    process.env.META_APP_SECRET = "test-app-secret";
    process.env.META_VERIFY_TOKEN = "test-verify-token";
    process.env.APP_PUBLIC_URL = "https://example.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "Session expired", code: 190 } }),
      }))
    );
    const { encryptCredentials, decryptCredentials } = await import(
      "@/lib/integrations/meta"
    );
    const row = await db.integration.create({
      data: {
        workspaceId: wsId,
        provider: "facebook",
        status: "CONNECTED",
        encryptedCredentials: encryptCredentials({
          provider: "facebook",
          accessToken: `stale-send2-${suffix}`,
          expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
          pageId: `page-send2-${suffix}`,
        }),
      },
    });
    try {
      fakeAdapter();
      const contact = await makeContact({ lastInboundAt: new Date() });
      const result = await sendFollowUp(sendInput(contact.id));
      expect(result.status).toBe("SENT");
      const reloaded = await db.integration.findUnique({ where: { id: row.id } });
      expect(decryptCredentials(reloaded!.encryptedCredentials!).accessToken).toBe(
        `stale-send2-${suffix}`
      );
    } finally {
      vi.unstubAllGlobals();
      await db.integration.delete({ where: { id: row.id } });
    }
  });
});

describe("processDueFollowUps", () => {
  it("sends due follow-ups and skips ones whose eligibility lapsed", async () => {
    const adapter = fakeAdapter();
    const eligible = await makeContact({ lastInboundAt: new Date() });
    const lapsed = await makeContact({
      lastInboundAt: new Date(Date.now() - 30 * 3600 * 1000),
    });
    const past = new Date(Date.now() - 60_000);
    const fu1 = await db.followUp.create({
      data: {
        workspaceId: wsId, contactId: eligible.id, channel: "facebook",
        messageType: "freeform", body: "due now", scheduledAt: past,
        status: "SCHEDULED", idempotencyKey: `due1-${suffix}-${Math.random()}`,
      },
    });
    const fu2 = await db.followUp.create({
      data: {
        workspaceId: wsId, contactId: lapsed.id, channel: "facebook",
        messageType: "freeform", body: "due but lapsed", scheduledAt: past,
        status: "SCHEDULED", idempotencyKey: `due2-${suffix}-${Math.random()}`,
      },
    });
    // Not due yet — must be untouched.
    const fu3 = await db.followUp.create({
      data: {
        workspaceId: wsId, contactId: eligible.id, channel: "facebook",
        messageType: "freeform", body: "future", scheduledAt: new Date(Date.now() + 3600_000),
        status: "SCHEDULED", idempotencyKey: `due3-${suffix}-${Math.random()}`,
      },
    });

    const results = await processDueFollowUps(wsId, null);
    const byId = new Map(results.map((r) => [r.followUpId, r]));
    expect(byId.get(fu1.id)?.status).toBe("SENT");
    expect(byId.get(fu2.id)?.status).toBe("CANCELLED"); // lapsed → SKIPPED + cancelled
    expect(byId.has(fu3.id)).toBe(false);

    expect(adapter.__sendMessage).toHaveBeenCalledTimes(1);
    const skipped = await db.outboundSend.findUnique({
      where: { idempotencyKey: fu2.idempotencyKey },
    });
    expect(skipped?.status).toBe("SKIPPED");
  });
});
