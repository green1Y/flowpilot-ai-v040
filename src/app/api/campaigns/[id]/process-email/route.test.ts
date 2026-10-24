/**
 * POST /api/campaigns/[id]/process-email tests (Wave 2E).
 * - Email RUNNING campaign: accepted → SENT, skipped → SKIPPED,
 *   failed → FAILED; batch completes the campaign when nothing is PENDING.
 * - Non-email campaign → 422 (this route is email-only).
 * - Non-RUNNING campaign → 422.
 * - Campaign with no body → 422 before any send.
 * Tenancy + campaign sender are mocked; campaign/recipient/contact rows
 * and audit events use the real DB. (The sender itself is covered by
 * src/lib/email/campaign.test.ts.)
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/tenancy";
import { sendCampaignEmail } from "@/lib/email/campaign";
import { POST } from "./route";

vi.mock("@/lib/tenancy", () => ({
  requireWorkspace: vi.fn(),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/email/campaign", () => ({
  sendCampaignEmail: vi.fn(),
  renderCampaignEmailBody: vi.fn(),
  campaignEmailVariables: vi.fn(),
  resolveCampaignEmailSubject: vi.fn(),
  campaignEmailHtml: vi.fn(),
  isEmailSuppressed: vi.fn(),
}));

const mockedRequireWorkspace = vi.mocked(requireWorkspace);
const mockedSend = vi.mocked(sendCampaignEmail);

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let wsId = "";
let orgId = "";

async function fixture() {
  if (wsId) return;
  const org = await db.organization.create({
    data: { name: `Proc Email Org ${suffix}` },
  });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `Proc Email WS ${suffix}`, slug: `proc-email-ws-${suffix}` },
  });
  orgId = org.id;
  wsId = ws.id;
}

async function makeCampaign(
  tag: string,
  overrides: Record<string, unknown> = {}
) {
  return db.campaign.create({
    data: {
      workspaceId: wsId,
      name: `Email Camp ${tag}`,
      channel: "email",
      status: "RUNNING",
      message: JSON.stringify({ text: "Hello {{name}}", subject: "Hi" }),
      ratePerSecond: 50,
      ...overrides,
    },
  });
}

async function makeRecipient(campaignId: string, tag: string) {
  const contact = await db.contact.create({
    data: { workspaceId: wsId, name: `Proc ${tag}`, email: `${tag}@example.com` },
  });
  const recipient = await db.campaignRecipient.create({
    data: {
      campaignId,
      contactId: contact.id,
      status: "PENDING",
      idempotencyKey: `campaign:${campaignId}:contact:${contact.id}`,
    },
  });
  return { contact, recipient };
}

function postReq(campaignId: string, body: unknown = {}): NextRequest {
  return new NextRequest(`http://localhost/api/campaigns/${campaignId}/process-email`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  await fixture();
  mockedRequireWorkspace.mockResolvedValue({
    userId: "u_1",
    workspaceId: wsId,
    role: "MANAGER",
  } as never);
  vi.clearAllMocks();
  mockedSend.mockResolvedValue({ accepted: true, providerMessageId: "resend_9" });
});

afterAll(async () => {
  await db.campaignRecipient.deleteMany({
    where: { campaign: { workspaceId: wsId } },
  });
  await db.campaign.deleteMany({ where: { workspaceId: wsId } });
  await db.contact.deleteMany({ where: { workspaceId: wsId } });
  await db.auditEvent.deleteMany({ where: { workspaceId: wsId } });
  await db.membership.deleteMany({ where: { workspaceId: wsId } });
  await db.workspace.deleteMany({ where: { id: wsId } });
  await db.organization.deleteMany({ where: { id: orgId } });
});

describe("POST /process-email", () => {
  it("marks accepted/skipped/failed per recipient and completes the campaign", async () => {
    const campaign = await makeCampaign("mix");
    const a = await makeRecipient(campaign.id, "mix-a");
    const b = await makeRecipient(campaign.id, "mix-b");
    const c = await makeRecipient(campaign.id, "mix-c");
    mockedSend
      .mockResolvedValueOnce({ accepted: true, providerMessageId: "resend_a" })
      .mockResolvedValueOnce({ skipped: true, reason: "contact is suppressed/opted out of email" })
      .mockResolvedValueOnce({ accepted: false, error: "provider boom" });

    const res = await POST(postReq(campaign.id), {
      params: Promise.resolve({ id: campaign.id }),
    });
    const body = await res.json();
    expect(body.data.process).toMatchObject({
      processed: 3,
      sent: 1,
      skipped: 1,
      failed: 1,
      completed: true,
    });
    expect(
      (await db.campaignRecipient.findUnique({ where: { id: a.recipient.id } }))?.status
    ).toBe("SENT");
    expect(
      (await db.campaignRecipient.findUnique({ where: { id: b.recipient.id } }))?.status
    ).toBe("SKIPPED");
    expect(
      (await db.campaignRecipient.findUnique({ where: { id: c.recipient.id } }))?.status
    ).toBe("FAILED");
    expect(
      (await db.campaign.findUnique({ where: { id: campaign.id } }))?.status
    ).toBe("COMPLETED");
  });

  it("rejects a non-email campaign with 422 and sends nothing", async () => {
    const campaign = await makeCampaign("meta", { channel: "instagram" });
    await makeRecipient(campaign.id, "meta-a");
    const res = await POST(postReq(campaign.id), {
      params: Promise.resolve({ id: campaign.id }),
    });
    expect(res.status).toBe(422);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("rejects a non-RUNNING campaign with 422", async () => {
    const campaign = await makeCampaign("draft", { status: "DRAFT" });
    const res = await POST(postReq(campaign.id), {
      params: Promise.resolve({ id: campaign.id }),
    });
    expect(res.status).toBe(422);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("rejects a campaign with no email body before any send", async () => {
    const campaign = await makeCampaign("nobody", {
      message: JSON.stringify({ text: "   " }),
      templateId: null,
    });
    await makeRecipient(campaign.id, "nobody-a");
    const res = await POST(postReq(campaign.id), {
      params: Promise.resolve({ id: campaign.id }),
    });
    expect(res.status).toBe(422);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("respects batchSize and leaves the campaign RUNNING while PENDING remain", async () => {
    const campaign = await makeCampaign("batch");
    await makeRecipient(campaign.id, "batch-a");
    await makeRecipient(campaign.id, "batch-b");
    await makeRecipient(campaign.id, "batch-c");
    const res = await POST(postReq(campaign.id, { batchSize: 2 }), {
      params: Promise.resolve({ id: campaign.id }),
    });
    const body = await res.json();
    expect(body.data.process).toMatchObject({
      processed: 2,
      sent: 2,
      completed: false,
    });
    expect(
      (await db.campaign.findUnique({ where: { id: campaign.id } }))?.status
    ).toBe("RUNNING");
  });
});
