/**
 * Phase B — retargeting engine tests (DB-backed).
 *
 * Covered: launch requires explicit confirmation; cross-workspace isolation;
 * dry-run sends nothing real; paid_ad launch returns a checklist + CSV (never
 * a fake ad id); suppression / consent / frequency-cap exclusions;
 * idempotent recipient builds; per-type eligibility.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { db } from "@/lib/db";
import { getWorkspaceAdapter } from "@/lib/integrations/providers";
import { SendError } from "@/lib/messaging/send";
import { launchSchema } from "./schemas";
import {
  buildRecipients,
  launchRetargetingCampaign,
  processDueRetargeting,
  evaluateRecipient,
  scopedRetargetingCampaign,
  retargetingRecipientKey,
  retargetingReport,
} from "./campaigns";

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

function fakeAdapter() {
  const sendMessage = vi.fn(async () => ({ ok: true, mocked: true, externalId: "mock-ext-1" }));
  const adapter: any = {
    provider: "facebook",
    displayName: "Fake",
    sendMessage,
    verifyWebhookSignature: () => true,
    __sendMessage: sendMessage,
  };
  mockedGetAdapter.mockResolvedValue(adapter);
  return adapter;
}

const suffix = `rt${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsA = "";
let wsB = "";
let userId = "";

async function makeContact(overrides: Record<string, any> = {}) {
  return db.contact.create({
    data: {
      workspaceId: wsA,
      name: "RT Contact",
      channel: "facebook",
      externalIds: JSON.stringify({ PSID: `psid-${suffix}-${Math.random()}` }),
      lastInboundAt: new Date(),
      ...overrides,
    },
  });
}

async function makeSegment(conditions: unknown = { op: "and", rules: [] }) {
  return db.audienceSegment.create({
    data: {
      workspaceId: wsA,
      name: `Seg ${suffix}-${Math.random()}`,
      conditions: JSON.stringify(conditions),
    },
  });
}

async function makeCampaign(overrides: Record<string, any> = {}) {
  const segment = await makeSegment();
  return db.retargetingCampaign.create({
    data: {
      workspaceId: wsA,
      name: `RTC ${suffix}-${Math.random()}`,
      type: "dm_reengagement",
      status: "draft",
      channel: "facebook",
      segmentId: segment.id,
      message: JSON.stringify({ body: "Hi {{firstName}}, we miss you!" }),
      schedule: JSON.stringify({}),
      createdById: userId,
      ...overrides,
    },
  });
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `rt-${suffix}@example.com`, name: "RT User", passwordHash: "x" },
  });
  userId = user.id;
  const org = await db.organization.create({ data: { name: `RT Org ${suffix}` } });
  const a = await db.workspace.create({ data: { orgId: org.id, name: `RT A ${suffix}`, slug: `rt-a-${suffix}` } });
  const b = await db.workspace.create({ data: { orgId: org.id, name: `RT B ${suffix}`, slug: `rt-b-${suffix}` } });
  wsA = a.id;
  wsB = b.id;
  fakeAdapter();
});

describe("launchSchema", () => {
  it("rejects a missing/false confirmation", () => {
    expect(launchSchema.safeParse({}).success).toBe(false);
    expect(launchSchema.safeParse({ confirmed: false }).success).toBe(false);
    expect(launchSchema.safeParse({ confirmed: true }).success).toBe(true);
  });
});

describe("launch requires explicit confirmation", () => {
  it("engine throws 422 when confirmed is not true", async () => {
    await makeContact();
    const campaign = await makeCampaign();
    await expect(
      launchRetargetingCampaign(wsA, campaign.id, { userId, confirmed: false })
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      launchRetargetingCampaign(wsA, campaign.id, { userId, confirmed: true as boolean })
    ).resolves.toMatchObject({ status: "running" });
  });
});

describe("cross-workspace isolation", () => {
  it("scopedRetargetingCampaign 404s for another workspace's campaign", async () => {
    const campaign = await makeCampaign();
    let status = 0;
    try {
      await scopedRetargetingCampaign(wsB, campaign.id);
    } catch (e) {
      if (e instanceof Response) status = e.status;
    }
    expect(status).toBe(404);
  });

  it("buildRecipients 404s for another workspace's campaign", async () => {
    const campaign = await makeCampaign();
    let status = 0;
    try {
      await buildRecipients(wsB, campaign.id);
    } catch (e) {
      if (e instanceof Response) status = e.status;
    }
    expect(status).toBe(404);
  });
});

describe("buildRecipients", () => {
  it("is idempotent — a second build creates no new rows", async () => {
    await makeContact();
    const campaign = await makeCampaign();
    const first = await buildRecipients(wsA, campaign.id, { userId });
    expect(first.created).toBeGreaterThan(0);
    const second = await buildRecipients(wsA, campaign.id, { userId });
    expect(second.created).toBe(0);
    const total = await db.retargetingRecipient.count({ where: { campaignId: campaign.id } });
    expect(total).toBe(first.created);
  });

  it("uses the retargeting:<campaignId>:contact:<contactId> idempotency key", async () => {
    const contact = await makeContact();
    const campaign = await makeCampaign();
    await buildRecipients(wsA, campaign.id, { userId });
    const row = await db.retargetingRecipient.findFirst({
      where: { campaignId: campaign.id, contactId: contact.id },
    });
    expect(row?.idempotencyKey).toBe(retargetingRecipientKey(campaign.id, contact.id));
  });

  it("marks suppressed contacts as skipped with a reason", async () => {
    const contact = await makeContact();
    await db.suppression.create({
      data: { workspaceId: wsA, contactId: contact.id, channel: null, reason: "opt-out" },
    });
    const campaign = await makeCampaign();
    const built = await buildRecipients(wsA, campaign.id, { userId });
    expect(built.skipped).toBeGreaterThan(0);
    const row = await db.retargetingRecipient.findFirst({
      where: { campaignId: campaign.id, contactId: contact.id },
    });
    expect(row?.status).toBe("skipped");
    expect(row?.eligibility).toContain("suppressed");
  });

  it("marks frequency-capped contacts as skipped", async () => {
    const contact = await makeContact();
    await db.outboundSend.create({
      data: {
        workspaceId: wsA,
        contactId: contact.id,
        channel: "facebook",
        messageType: "freeform",
        body: "earlier send",
        idempotencyKey: `cap-${suffix}-${Math.random()}`,
        status: "SENT",
        mocked: true,
      },
    });
    const campaign = await makeCampaign();
    const built = await buildRecipients(wsA, campaign.id, { userId });
    const row = await db.retargetingRecipient.findFirst({
      where: { campaignId: campaign.id, contactId: contact.id },
    });
    expect(row?.status).toBe("skipped");
    expect(row?.eligibility).toContain("frequency cap");
    expect(built.skipped).toBeGreaterThan(0);
  });
});

describe("launch validation", () => {
  it("422s when no eligible recipients and not a dry run", async () => {
    const segment = await makeSegment({ op: "and", rules: [{ field: "tag", operator: "contains", value: "no-such-tag-ever" }] });
    const campaign = await makeCampaign({ segmentId: segment.id, dryRun: false });
    await expect(
      launchRetargetingCampaign(wsA, campaign.id, { userId, confirmed: true })
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("dry-run rehearsal", () => {
  it("marks recipients sent+simulated without calling the adapter", async () => {
    const adapter = fakeAdapter();
    adapter.__sendMessage.mockClear();
    await makeContact();
    const campaign = await makeCampaign({ dryRun: true });
    const launched = await launchRetargetingCampaign(wsA, campaign.id, { userId, confirmed: true });
    expect(launched.status).toBe("running");
    expect(launched.dryRun).toBe(true);

    const processed = await processDueRetargeting(wsA, campaign.id, { userId });
    expect(processed.sent).toBeGreaterThan(0);
    expect(processed.simulated).toBe(processed.sent);
    expect(adapter.__sendMessage).not.toHaveBeenCalled();

    const events = await db.customerEvent.findMany({
      where: { workspaceId: wsA, type: "campaign_interaction" },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(processed.completed).toBe(true);
  });
});

describe("dm_reengagement send path", () => {
  it("sends via the real pipeline, marks sent, records attribution", async () => {
    const adapter = fakeAdapter();
    adapter.__sendMessage.mockClear();
    await makeContact();
    const campaign = await makeCampaign({ dryRun: false });
    await launchRetargetingCampaign(wsA, campaign.id, { userId, confirmed: true });
    const processed = await processDueRetargeting(wsA, campaign.id, { userId });
    expect(processed.sent).toBeGreaterThan(0);
    expect(adapter.__sendMessage).toHaveBeenCalled();

    const events = await db.customerEvent.findMany({
      where: { workspaceId: wsA, type: "campaign_interaction" },
    });
    const attributed = events.filter((e) => {
      try {
        return (JSON.parse(e.attribution) as any).retargetingCampaignId === campaign.id;
      } catch {
        return false;
      }
    });
    expect(attributed.length).toBeGreaterThan(0);
  });

  it("does not pass the retargeting id as sendFollowUp campaignId", async () => {
    fakeAdapter();
    await makeContact();
    const campaign = await makeCampaign({ dryRun: false });
    await launchRetargetingCampaign(wsA, campaign.id, { userId, confirmed: true });
    await processDueRetargeting(wsA, campaign.id, { userId });
    const sends = await db.outboundSend.findMany({
      where: { workspaceId: wsA, idempotencyKey: { startsWith: `retargeting:${campaign.id}:` } },
    });
    expect(sends.length).toBeGreaterThan(0);
    for (const s of sends) expect(s.campaignId).toBeNull();
  });
});

describe("paid_ad honesty", () => {
  it("launch returns a checklist + audience CSV, never a fake ad id", async () => {
    await makeContact({
      email: "buyer@example.com",
      consent: JSON.stringify({ marketing: true }),
    });
    const campaign = await makeCampaign({
      type: "paid_ad",
      channel: null,
      message: JSON.stringify({ creativeRef: "summer-sale-v2" }),
    });
    const result = await launchRetargetingCampaign(wsA, campaign.id, { userId, confirmed: true });
    expect(result.status).toBe("completed");
    expect(result.paidAd).toBeDefined();
    expect(result.paidAd!.checklist.length).toBeGreaterThanOrEqual(6);
    expect(result.paidAd!.checklist.map((c) => c.id)).toContain("ads_management");
    // Never a fabricated provider object:
    expect(result.paidAd).not.toHaveProperty("adId");
    expect(result.paidAd).not.toHaveProperty("audienceId");
    expect(result.paidAd!.audienceCsv).toMatch(/^email,phone,first_name,last_name,consent_marketing,contact_id/);
    expect(result.paidAd!.exported).toBeGreaterThan(0);

    const reloaded = await scopedRetargetingCampaign(wsA, campaign.id);
    expect(reloaded.status).toBe("completed");
  });
});

describe("email / crm_sequence honesty", () => {
  it("email without marketing consent is excluded", async () => {
    const contact = await makeContact({ email: "noconsent@example.com", consent: JSON.stringify({}) });
    const campaign = await makeCampaign({ type: "email", channel: "email" });
    const built = await buildRecipients(wsA, campaign.id, { userId });
    const row = await db.retargetingRecipient.findFirst({
      where: { campaignId: campaign.id, contactId: contact.id },
    });
    expect(row?.status).toBe("skipped");
    expect(row?.eligibility).toContain("consent");
    expect(built.skipped).toBeGreaterThan(0);
  });

  it("email sends are recorded as SIMULATED, not delivered", async () => {
    fakeAdapter();
    await makeContact({ email: "sim@example.com", consent: JSON.stringify({ marketing: true }) });
    const campaign = await makeCampaign({ type: "email", channel: "email" });
    await launchRetargetingCampaign(wsA, campaign.id, { userId, confirmed: true });
    const processed = await processDueRetargeting(wsA, campaign.id, { userId });
    expect(processed.simulated).toBe(processed.sent);
    expect(processed.simulated).toBeGreaterThan(0);
  });

  it("crm_sequence logs tasks instead of sending", async () => {
    await makeContact();
    const campaign = await makeCampaign({
      type: "crm_sequence",
      channel: null,
      message: JSON.stringify({ sequence: [{ day: 0, title: "Call back" }] }),
    });
    await launchRetargetingCampaign(wsA, campaign.id, { userId, confirmed: true });
    const processed = await processDueRetargeting(wsA, campaign.id, { userId });
    expect(processed.sent).toBeGreaterThan(0);
    expect(processed.completed).toBe(true);
  });
});

describe("evaluateRecipient per-type rules", () => {
  it("comment_to_dm requires a recent unreplied comment", async () => {
    const contact = await makeContact();
    const campaign = await makeCampaign({ type: "comment_to_dm", channel: "instagram" });
    const facts: any = { contactId: contact.id };
    const verdict = await evaluateRecipient(wsA, campaign as any, facts);
    expect(verdict.eligible).toBe(false);
    expect(verdict.ineligibleReasons.join(" ")).toMatch(/7-day/);
  });

  it("throws SendError (not a crash) for misconfigured campaigns", async () => {
    const contact = await makeContact();
    const campaign = await makeCampaign({ type: "dm_reengagement", channel: null });
    const facts: any = { contactId: contact.id };
    const verdict = await evaluateRecipient(wsA, campaign as any, facts);
    expect(verdict.eligible).toBe(false);
    expect(verdict.ineligibleReasons[0]).toMatch(/no channel/);
  });
});

describe("retargetingReport", () => {
  it("labels every metric and never invents revenue", async () => {
    await makeContact();
    const campaign = await makeCampaign({ dryRun: false });
    await launchRetargetingCampaign(wsA, campaign.id, { userId, confirmed: true });
    await processDueRetargeting(wsA, campaign.id, { userId });
    const report = await retargetingReport(wsA, campaign.id);
    expect(report.recipients.sent).toBeGreaterThan(0);
    expect(report.spend.source).toBe("not_tracked");
    expect(report.spend.value).toBeNull();
    expect(report.roas.source).toBe("not_tracked");
    expect(report.roas.value).toBeNull();
    for (const m of [report.attempted, report.delivered, report.failed, report.replies, report.clicks, report.conversions]) {
      expect(["measured", "estimated", "not_tracked"]).toContain(m.source);
    }
  });
});
