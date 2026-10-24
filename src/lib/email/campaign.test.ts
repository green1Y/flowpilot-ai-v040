/**
 * Email campaign sender tests (Wave 2E).
 * - Suppression (channel "email" or all-channel null) → SKIPPED, no send.
 * - Suppression for another channel does NOT block email.
 * - Missing email address → SKIPPED, no send.
 * - Unconfigured Resend → honest EMAIL_NOT_CONFIGURED failure, no fake success.
 * - Template variables come from verified contact fields only; unknown
 *   {{variables}} are left untouched; footer carries a verifiable
 *   unsubscribe URL.
 * - Provider errors → honest failure, never a fake success.
 * Sender is mocked; suppression + demo guard use the real DB/guard.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { db } from "@/lib/db";
import { getEmailSender } from "./sender";
import {
  sendCampaignEmail,
  renderCampaignEmailBody,
  campaignEmailVariables,
} from "./campaign";
import { verifyUnsubscribeToken } from "./unsubscribe";

vi.mock("./sender", () => ({ getEmailSender: vi.fn() }));

const mockedGetEmailSender = vi.mocked(getEmailSender);
const sendFn = vi.fn(
  async (_to: string, _subject: string, _html: string) => ({ ok: true, messageId: "resend_123" })
);

const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const fixtures: { wsId: string; orgId: string; contactIds: string[] } = {
  wsId: "",
  orgId: "",
  contactIds: [],
};

async function makeContact(tag: string, email: string | null, customFields = "{}") {
  const c = await db.contact.create({
    data: {
      workspaceId: fixtures.wsId,
      name: `Campaign ${tag} Person`,
      email,
      customFields,
    },
  });
  fixtures.contactIds.push(c.id);
  return c;
}

beforeEach(async () => {
  if (!fixtures.wsId) {
    const org = await db.organization.create({
      data: { name: `Email Camp Org ${suffix}` },
    });
    const ws = await db.workspace.create({
      data: {
        orgId: org.id,
        name: `Email Camp WS ${suffix}`,
        slug: `email-camp-ws-${suffix}`,
      },
    });
    fixtures.orgId = org.id;
    fixtures.wsId = ws.id;
  }
  vi.clearAllMocks();
  mockedGetEmailSender.mockReturnValue({ send: sendFn });
});

afterAll(async () => {
  await db.suppression.deleteMany({ where: { workspaceId: fixtures.wsId } });
  await db.contact.deleteMany({ where: { workspaceId: fixtures.wsId } });
  await db.membership.deleteMany({ where: { workspaceId: fixtures.wsId } });
  await db.workspace.deleteMany({ where: { id: fixtures.wsId } });
  await db.organization.deleteMany({ where: { id: fixtures.orgId } });
});

const campaign = { id: "camp_1", name: "Launch", message: null };

describe("suppression", () => {
  it("skips a contact suppressed for email without calling the sender", async () => {
    const c = await makeContact("supp-email", "supp@example.com");
    await db.suppression.create({
      data: {
        workspaceId: fixtures.wsId,
        contactId: c.id,
        channel: "email",
        reason: "unsubscribed",
      },
    });
    const res = await sendCampaignEmail({
      workspaceId: fixtures.wsId,
      campaign,
      recipient: { id: c.id, name: c.name, email: c.email },
      templateBody: "Hi {{name}}",
    });
    expect(res).toMatchObject({ skipped: true });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("skips a contact suppressed for all channels (null channel)", async () => {
    const c = await makeContact("supp-all", "suppall@example.com");
    await db.suppression.create({
      data: {
        workspaceId: fixtures.wsId,
        contactId: c.id,
        channel: null,
        reason: "global opt-out",
      },
    });
    const res = await sendCampaignEmail({
      workspaceId: fixtures.wsId,
      campaign,
      recipient: { id: c.id, name: c.name, email: c.email },
      templateBody: "Hi {{name}}",
    });
    expect(res).toMatchObject({ skipped: true });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("does NOT skip for a suppression on another channel", async () => {
    const c = await makeContact("supp-ig", "igonly@example.com");
    await db.suppression.create({
      data: {
        workspaceId: fixtures.wsId,
        contactId: c.id,
        channel: "instagram",
        reason: "ig opt-out",
      },
    });
    const res = await sendCampaignEmail({
      workspaceId: fixtures.wsId,
      campaign,
      recipient: { id: c.id, name: c.name, email: c.email },
      templateBody: "Hi {{name}}",
    });
    expect(res).toMatchObject({ accepted: true, providerMessageId: "resend_123" });
    expect(sendFn).toHaveBeenCalledTimes(1);
  });
});

describe("addressing and configuration honesty", () => {
  it("skips a contact with no email address without calling the sender", async () => {
    const c = await makeContact("no-email", null);
    const res = await sendCampaignEmail({
      workspaceId: fixtures.wsId,
      campaign,
      recipient: { id: c.id, name: c.name, email: c.email },
      templateBody: "Hi {{name}}",
    });
    expect(res).toMatchObject({ skipped: true });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("returns honest EMAIL_NOT_CONFIGURED when no sender is configured", async () => {
    mockedGetEmailSender.mockReturnValue(null);
    const c = await makeContact("unconfig", "unconfig@example.com");
    const res = await sendCampaignEmail({
      workspaceId: fixtures.wsId,
      campaign,
      recipient: { id: c.id, name: c.name, email: c.email },
      templateBody: "Hi {{name}}",
    });
    expect(res).toMatchObject({ accepted: false, code: "EMAIL_NOT_CONFIGURED" });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("returns a failure (never a fake success) when the provider throws", async () => {
    sendFn.mockRejectedValueOnce(new Error("[email] Resend send failed (HTTP 401)"));
    const c = await makeContact("prov-err", "perr@example.com");
    const res = await sendCampaignEmail({
      workspaceId: fixtures.wsId,
      campaign,
      recipient: { id: c.id, name: c.name, email: c.email },
      templateBody: "Hi {{name}}",
    });
    expect(res).toMatchObject({ accepted: false });
    expect((res as { error: string }).error).toContain("401");
  });
});

describe("template rendering", () => {
  it("substitutes verified fields only and leaves unknown variables untouched", () => {
    const out = renderCampaignEmailBody(
      "Hi {{name}} ({{firstName}}) from {{company}} <{{email}}> and {{secret}}",
      {
        id: "c1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        customFields: JSON.stringify({ company: "Analytical Engines Ltd" }),
      }
    );
    expect(out).toBe(
      "Hi Ada Lovelace (Ada) from Analytical Engines Ltd <ada@example.com> and {{secret}}"
    );
  });

  it("renders missing company as empty, never invented", () => {
    expect(
      campaignEmailVariables({ id: "c1", name: "Bo", email: "bo@example.com" }).company
    ).toBe("");
  });

  it("appends a footer whose unsubscribe token verifies for this contact", async () => {
    const c = await makeContact("footer", "footer@example.com");
    await sendCampaignEmail({
      workspaceId: fixtures.wsId,
      campaign,
      recipient: { id: c.id, name: c.name, email: c.email },
      templateBody: "Hello {{name}}",
    });
    const html = sendFn.mock.calls[0][2] as string;
    expect(html).toContain("unsubscribe");
    const match = html.match(/\/api\/unsubscribe\?token=([^"&\s<]+)/);
    expect(match).not.toBeNull();
    const verified = verifyUnsubscribeToken(decodeURIComponent(match![1]));
    expect(verified).toMatchObject({
      workspaceId: fixtures.wsId,
      contactId: c.id,
      channel: "email",
    });
    // Subject falls back to the campaign name when message JSON has none.
    expect(sendFn.mock.calls[0][1]).toBe("Launch");
  });

  it("uses a subject from campaign.message JSON when present", async () => {
    const c = await makeContact("subj", "subj@example.com");
    await sendCampaignEmail({
      workspaceId: fixtures.wsId,
      campaign: {
        id: "camp_2",
        name: "Launch",
        message: JSON.stringify({ subject: "Big news", text: "Hi" }),
      },
      recipient: { id: c.id, name: c.name, email: c.email },
      templateBody: "Hi {{name}}",
    });
    expect(sendFn.mock.calls[0][1]).toBe("Big news");
  });
});
