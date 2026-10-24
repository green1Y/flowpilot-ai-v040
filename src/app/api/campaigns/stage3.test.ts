/**
 * Stage 3 — campaign tests: recipient builder (eligibility pre-check with
 * reasons, segment + legacy audiences, idempotent rebuilds), send engine
 * (batch processing, re-check at send time, idempotent reprocess, pause /
 * resume, retry-failed, completion), report accuracy, the inbound reply hook
 * (auto-pause + REPLIED + stage advance toward INTERESTED), process-due, and
 * tenant isolation on every new route.
 *
 * Auth is stubbed and the workspace adapter is mocked (no real Meta calls);
 * DB is the fresh test.db per run. Same harness pattern as stage2.test.ts.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAdapter } from "@/lib/integrations/providers";
import { ingestMetaEvent } from "@/lib/integrations/ingest";
import { POST as buildPOST } from "./[id]/recipients/build/route";
import { POST as startPOST } from "./[id]/start/route";
import { POST as pausePOST } from "./[id]/pause/route";
import { POST as cancelPOST } from "./[id]/cancel/route";
import { POST as processPOST } from "./[id]/process/route";
import { POST as retryPOST } from "./[id]/retry-failed/route";
import { POST as schedulePOST } from "./[id]/schedule/route";
import { GET as reportGET } from "./[id]/report/route";
import { POST as processDuePOST } from "./process-due/route";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
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
const mockedRequireUser = vi.mocked(requireUser);
const mockedGetAdapter = vi.mocked(getWorkspaceAdapter);

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

function noBodyPost(url: string, workspaceId: string): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "x-workspace-id": workspaceId },
  });
}

function withId(fn: (r: NextRequest, ctx: any) => Promise<Response>, r: NextRequest, id: string) {
  return fn(r, { params: { id } });
}

async function jsonBody(res: Response) {
  return { status: res.status, body: (await res.json()) as any };
}

const suffix = `c3${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let userAId = "";
let userBId = "";
let wsA = "";
let wsB = "";
let eligibleId = "";
let suppressedId = "";
let lapsedId = "";
let noIdentityId = "";

const sendMessage = vi.fn();

beforeAll(async () => {
  // Mocked adapter: honest mock. Rejects with a 503-flavored error when the
  // body carries the failure marker (drives the FAILED → retry-failed test).
  sendMessage.mockImplementation(async (args: { body: string }) => {
    if (args.body.includes("FAILMARK")) throw new Error("boom 503 Service Unavailable");
    return { ok: true, mocked: true, externalId: `c3-ext-${Date.now()}` };
  });
  mockedGetAdapter.mockResolvedValue({
    provider: "facebook",
    displayName: "Fake",
    capabilities: [],
    limitations: [],
    requiredPermissions: [],
    connect: async () => ({ ok: true, verified: false, status: "DISCONNECTED", message: "" }),
    verify: async () => ({ ok: true, verified: false, status: "DISCONNECTED", message: "" }),
    sendMessage,
    verifyWebhookSignature: () => true,
  } as any);

  const a = await db.user.create({ data: { email: `c3-a-${suffix}@example.com`, name: "C3 A", passwordHash: "x" } });
  const b = await db.user.create({ data: { email: `c3-b-${suffix}@example.com`, name: "C3 B", passwordHash: "x" } });
  userAId = a.id;
  userBId = b.id;
  const orgA = await db.organization.create({ data: { name: `C3 Org A ${suffix}` } });
  const orgB = await db.organization.create({ data: { name: `C3 Org B ${suffix}` } });
  const wA = await db.workspace.create({ data: { orgId: orgA.id, name: `C3 WS A ${suffix}`, slug: `c3-a-${suffix}` } });
  const wB = await db.workspace.create({ data: { orgId: orgB.id, name: `C3 WS B ${suffix}`, slug: `c3-b-${suffix}` } });
  wsA = wA.id;
  wsB = wB.id;
  await db.membership.create({ data: { userId: a.id, workspaceId: wA.id, role: "OWNER" } });
  await db.membership.create({ data: { userId: b.id, workspaceId: wB.id, role: "OWNER" } });

  const mk = (name: string, extra: Record<string, unknown>) =>
    db.contact.create({ data: { workspaceId: wsA, name, channel: "facebook", ...extra } });

  // Eligible right now: inbound 1h ago + facebook identity.
  const e = await mk(`Eligible Eve ${suffix}`, {
    externalIds: JSON.stringify({ PSID: `c3-psid-eligible-${suffix}` }),
    lastInboundAt: new Date(Date.now() - 3600_000),
  });
  eligibleId = e.id;
  // Suppressed (opted out on all channels).
  const s = await mk(`Suppressed Sam ${suffix}`, {
    externalIds: JSON.stringify({ PSID: `c3-psid-suppressed-${suffix}` }),
    lastInboundAt: new Date(),
  });
  suppressedId = s.id;
  await db.suppression.create({ data: { workspaceId: wsA, contactId: s.id, reason: "opt-out" } });
  // Window lapsed: inbound 30h ago.
  const l = await mk(`Lapsed Lou ${suffix}`, {
    externalIds: JSON.stringify({ PSID: `c3-psid-lapsed-${suffix}` }),
    lastInboundAt: new Date(Date.now() - 30 * 3600_000),
  });
  lapsedId = l.id;
  // No channel identity at all.
  const n = await mk(`NoIdentity Ned ${suffix}`, { lastInboundAt: new Date() });
  noIdentityId = n.id;
});

async function createCampaign(overrides: Record<string, unknown> = {}) {
  return db.campaign.create({
    data: {
      workspaceId: wsA,
      name: `C3 Campaign ${suffix}-${Math.floor(Math.random() * 1_000_000)}`,
      channel: "facebook",
      status: "DRAFT",
      audience: JSON.stringify({ type: "all" }),
      message: JSON.stringify({ text: "Hi {{firstName}}, wave hello!" }),
      messageType: "freeform",
      ratePerSecond: 50,
      ...overrides,
    },
  });
}

async function build(id: string, ws = wsA, segmentId?: string) {
  return jsonBody(
    await withId(
      buildPOST,
      req(`http://x/api/campaigns/${id}/recipients/build`, ws, {
        method: "POST",
        body: segmentId ? { segmentId } : {},
      }),
      id
    )
  );
}

async function start(id: string, ws = wsA) {
  return jsonBody(await withId(startPOST, noBodyPost(`http://x/api/campaigns/${id}/start`, ws), id));
}

async function process(id: string, ws = wsA, batchSize?: number) {
  return jsonBody(
    await withId(
      processPOST,
      batchSize === undefined
        ? noBodyPost(`http://x/api/campaigns/${id}/process`, ws)
        : req(`http://x/api/campaigns/${id}/process`, ws, { method: "POST", body: { batchSize } }),
      id
    )
  );
}

async function report(id: string, ws = wsA) {
  return jsonBody(await withId(reportGET, req(`http://x/api/campaigns/${id}/report`, ws), id));
}

/** One integration row per (workspace, provider); reused across tests. */
async function ensureIntegration(workspaceId: string, provider: string) {
  const existingRow = await db.integration.findFirst({
    where: { workspaceId, provider },
  });
  if (existingRow) {
    return db.integration.update({ where: { id: existingRow.id }, data: { status: "CONNECTED" } });
  }
  return db.integration.create({ data: { workspaceId, provider, status: "CONNECTED" } });
}

/**
 * Create one eligible (inbound now, channel identity) contact tagged with a
 * unique tag, so each test's audience is isolated from the others'.
 */
async function mkEligible(tag: string, name: string, leadStatus = "NEW") {
  const c = await db.contact.create({
    data: {
      workspaceId: wsA,
      name: `${name} ${suffix}`,
      channel: "facebook",
      leadStatus,
      tags: JSON.stringify([tag]),
      externalIds: JSON.stringify({ PSID: `c3-psid-${tag}-${suffix}` }),
      lastInboundAt: new Date(),
    },
  });
  return c.id;
}

describe("recipient builder", () => {
  it("builds PENDING for eligible contacts and SKIPPED with human-readable reasons", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const c = await createCampaign();
    const { status, body } = await build(c.id);
    expect(status).toBe(200);
    const b = body.data.build;
    expect(b.total).toBe(4);
    expect(b.pending).toBe(1);
    expect(b.skipped).toBe(3);

    const rows = await db.campaignRecipient.findMany({ where: { campaignId: c.id } });
    const byContact = new Map(rows.map((r) => [r.contactId, r]));
    expect(byContact.get(eligibleId)?.status).toBe("PENDING");

    const sup = byContact.get(suppressedId)!;
    expect(sup.status).toBe("SKIPPED");
    expect(sup.skipReason).toContain("suppressed");

    const lap = byContact.get(lapsedId)!;
    expect(lap.status).toBe("SKIPPED");
    expect(lap.skipReason).toContain("24h");

    const nid = byContact.get(noIdentityId)!;
    expect(nid.status).toBe("SKIPPED");
    expect(nid.skipReason).toContain("facebook");

    // Skipped sample carries per-contact reason arrays.
    expect(b.skippedSample.length).toBeGreaterThan(0);
    for (const s of b.skippedSample) {
      expect(Array.isArray(s.reasons)).toBe(true);
      expect(s.reasons.length).toBeGreaterThan(0);
    }

    // Idempotency keys are deterministic.
    expect(byContact.get(eligibleId)?.idempotencyKey).toBe(
      `campaign:${c.id}:contact:${eligibleId}`
    );

    // Audit trail.
    const audit = await db.auditEvent.findFirst({
      where: { workspaceId: wsA, action: "campaign.recipients_built" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  it("rebuild is idempotent — no duplicate rows", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const c = await createCampaign();
    await build(c.id);
    const second = await build(c.id);
    expect(second.status).toBe(200);
    expect(second.body.data.build.created).toBe(0);
    const count = await db.campaignRecipient.count({ where: { campaignId: c.id } });
    expect(count).toBe(4);
  });

  it("builds from a saved segment when segmentId is given", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const tagged = await db.contact.create({
      data: {
        workspaceId: wsA,
        name: `Tagged Tess ${suffix}`,
        channel: "facebook",
        tags: JSON.stringify(["vip"]),
        externalIds: JSON.stringify({ PSID: `c3-psid-tagged-${suffix}` }),
        lastInboundAt: new Date(),
      },
    });
    const segment = await db.contactSegment.create({
      data: { workspaceId: wsA, name: `VIPs ${suffix}`, filters: JSON.stringify({ tag: "vip" }) },
    });
    const c = await createCampaign();
    const { status, body } = await build(c.id, wsA, segment.id);
    expect(status).toBe(200);
    expect(body.data.build.total).toBe(1);
    expect(body.data.build.pending).toBe(1);
    const row = await db.campaignRecipient.findFirst({ where: { campaignId: c.id } });
    expect(row?.contactId).toBe(tagged.id);
    // Segment id is remembered on the campaign.
    const updated = await db.campaign.findUnique({ where: { id: c.id } });
    expect(updated?.segmentId).toBe(segment.id);
  });

  it("404s for an unknown segment id", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const c = await createCampaign();
    const { status } = await build(c.id, wsA, "nope-not-a-segment");
    expect(status).toBe(404);
  });

  it("private_reply campaigns skip contacts with no comment", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const tag = `pr-${suffix}`;
    await mkEligible(tag, "PrivateReply Pat");
    const c = await createCampaign({
      messageType: "private_reply",
      audience: JSON.stringify({ type: "tag", tag }),
    });
    const { status, body } = await build(c.id);
    expect(status).toBe(200);
    expect(body.data.build.total).toBe(1);
    expect(body.data.build.pending).toBe(0);
    expect(body.data.build.skipped).toBe(1);
    const rows = await db.campaignRecipient.findMany({ where: { campaignId: c.id } });
    expect(rows.every((r) => r.status === "SKIPPED")).toBe(true);
    expect(rows[0].skipReason).toContain("comment");
  });
});

describe("campaign lifecycle + send engine", () => {
  it("start requires ≥1 PENDING recipient (422 otherwise)", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const c = await createCampaign({ messageType: "private_reply" });
    await build(c.id); // all skipped → 0 pending
    const { status, body } = await start(c.id);
    expect(status).toBe(422);
    expect(body.error).toContain("PENDING");
  });

  it("start → process sends eligible recipients, marks SENT, and completes the campaign", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const tag = `sp-${suffix}`;
    const contactId = await mkEligible(tag, "Send Petra");
    const c = await createCampaign({ audience: JSON.stringify({ type: "tag", tag }) });
    const b = await build(c.id);
    expect(b.body.data.build.pending).toBe(1);

    const started = await start(c.id);
    expect(started.status).toBe(200);
    expect(started.body.data.campaign.status).toBe("RUNNING");

    const { status, body } = await process(c.id);
    expect(status).toBe(200);
    const p = body.data.process;
    expect(p.processed).toBe(1);
    expect(p.sent).toBe(1);
    expect(p.skipped).toBe(0);
    expect(p.failed).toBe(0);
    expect(p.completed).toBe(true);
    expect(p.status).toBe("COMPLETED");

    const rec = await db.campaignRecipient.findFirst({
      where: { campaignId: c.id, contactId },
    });
    expect(rec?.status).toBe("SENT");
    expect(rec?.mocked).toBe(true);
    expect(rec?.providerMessageId).not.toBeNull();
    expect(rec?.sentAt).not.toBeNull();

    // OutboundSend is the audit-grade record: campaignId set, honest mock flag.
    const send = await db.outboundSend.findUnique({
      where: { idempotencyKey: `campaign:${c.id}:contact:${contactId}` },
    });
    expect(send?.status).toBe("SENT");
    expect(send?.campaignId).toBe(c.id);
    expect(send?.mocked).toBe(true);
    expect(send?.body).toContain("Hi Send,"); // {{firstName}} rendered

    const campaign = await db.campaign.findUnique({ where: { id: c.id } });
    expect(campaign?.status).toBe("COMPLETED");
    expect(campaign?.completedAt).not.toBeNull();

    const audit = await db.auditEvent.findFirst({
      where: { workspaceId: wsA, action: "campaign.completed" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  it("reprocess is idempotent — no double sends", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const c = await createCampaign();
    await build(c.id);
    await start(c.id);
    await process(c.id);

    const before = await db.outboundSend.count({
      where: { idempotencyKey: `campaign:${c.id}:contact:${eligibleId}` },
    });
    expect(before).toBe(1);

    // Processing a COMPLETED campaign is rejected — never re-sends.
    const { status } = await process(c.id);
    expect(status).toBe(422);

    const after = await db.outboundSend.count({
      where: { idempotencyKey: `campaign:${c.id}:contact:${eligibleId}` },
    });
    expect(after).toBe(1);
    expect(sendMessage).not.toHaveBeenCalledTimes(0); // sanity: adapter was used
  });

  it("pause stops processing; resume continues where it left off", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    // Two eligible contacts so the batch can be split across process calls.
    const second = await db.contact.create({
      data: {
        workspaceId: wsA,
        name: `Eligible Emma ${suffix}`,
        channel: "facebook",
        externalIds: JSON.stringify({ PSID: `c3-psid-emma-${suffix}` }),
        lastInboundAt: new Date(),
      },
    });
    const c = await createCampaign({ audience: JSON.stringify({ type: "tag", tag: "wave" }) });
    for (const id of [eligibleId, second.id]) {
      await db.contact.update({ where: { id }, data: { tags: JSON.stringify(["wave"]) } });
    }
    await db.contact.update({ where: { id: eligibleId }, data: { lastInboundAt: new Date() } });
    const b = await build(c.id);
    expect(b.body.data.build.pending).toBe(2);
    await start(c.id);

    // Process one, then pause mid-wave.
    const first = await process(c.id, wsA, 1);
    expect(first.body.data.process.sent).toBe(1);
    expect(first.body.data.process.completed).toBe(false);

    const paused = await jsonBody(
      await withId(pausePOST, noBodyPost(`http://x/api/campaigns/${c.id}/pause`, wsA), c.id)
    );
    expect(paused.body.data.campaign.status).toBe("PAUSED");

    const blocked = await process(c.id);
    expect(blocked.status).toBe(422);

    // Resume via start → processes the remainder → completes.
    const resumed = await start(c.id);
    expect(resumed.body.data.campaign.status).toBe("RUNNING");
    const done = await process(c.id);
    expect(done.body.data.process.sent).toBe(1);
    expect(done.body.data.process.completed).toBe(true);

    const sends = await db.outboundSend.count({ where: { campaignId: c.id, status: "SENT" } });
    expect(sends).toBe(2);
  });

  it("eligibility is re-checked at send time — lapsed recipients are SKIPPED, not sent", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const tag = `lapse-${suffix}`;
    const contactId = await mkEligible(tag, "Lapse Larry");
    const c = await createCampaign({ audience: JSON.stringify({ type: "tag", tag }) });
    await build(c.id);
    await start(c.id);

    // The window lapses between build and process.
    await db.contact.update({
      where: { id: contactId },
      data: { lastInboundAt: new Date(Date.now() - 30 * 3600_000) },
    });

    const { body } = await process(c.id);
    expect(body.data.process.skipped).toBe(1);
    expect(body.data.process.sent).toBe(0);

    const rec = await db.campaignRecipient.findFirst({
      where: { campaignId: c.id, contactId },
    });
    expect(rec?.status).toBe("SKIPPED");
    expect(rec?.skipReason).toContain("eligibility lapsed at send time");
  });

  it("retryable failures stay FAILED with the error; retry-failed resets them to PENDING", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const flaky = await db.contact.create({
      data: {
        workspaceId: wsA,
        name: `Flaky Fran ${suffix}`,
        channel: "facebook",
        externalIds: JSON.stringify({ PSID: `c3-psid-flaky-${suffix}` }),
        lastInboundAt: new Date(),
      },
    });
    const c = await createCampaign({
      message: JSON.stringify({ text: "FAILMARK please fail" }),
      audience: JSON.stringify({ type: "tag", tag: `flaky-${suffix}` }),
    });
    await db.contact.update({
      where: { id: flaky.id },
      data: { tags: JSON.stringify([`flaky-${suffix}`]) },
    });
    const b = await build(c.id);
    expect(b.body.data.build.pending).toBe(1);
    await start(c.id);

    const { body } = await process(c.id);
    expect(body.data.process.failed).toBe(1);

    const rec = await db.campaignRecipient.findFirst({
      where: { campaignId: c.id, contactId: flaky.id },
    });
    expect(rec?.status).toBe("FAILED");
    expect(rec?.error).toContain("retryable");

    // Retry: fix the message so the send succeeds this time.
    await db.campaign.update({
      where: { id: c.id },
      data: { message: JSON.stringify({ text: "second try, all good" }) },
    });
    const retried = await jsonBody(
      await withId(retryPOST, noBodyPost(`http://x/api/campaigns/${c.id}/retry-failed`, wsA), c.id)
    );
    expect(retried.status).toBe(200);
    expect(retried.body.data.retry.reset).toBe(1);

    const again = await process(c.id);
    expect(again.body.data.process.sent).toBe(1);
    expect(again.body.data.process.completed).toBe(true);
    const rec2 = await db.campaignRecipient.findFirst({
      where: { campaignId: c.id, contactId: flaky.id },
    });
    expect(rec2?.status).toBe("SENT");
  });

  it("cancel stops the wave; pending recipients are never sent afterwards", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const c = await createCampaign();
    await build(c.id);
    await start(c.id);
    const cancelled = await jsonBody(
      await withId(cancelPOST, noBodyPost(`http://x/api/campaigns/${c.id}/cancel`, wsA), c.id)
    );
    expect(cancelled.body.data.campaign.status).toBe("CANCELLED");
    const blocked = await process(c.id);
    expect(blocked.status).toBe(422);
    const audit = await db.auditEvent.findFirst({
      where: { workspaceId: wsA, action: "campaign.cancelled" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });
});

describe("report", () => {
  it("returns accurate counts and per-recipient rows with honest mocked flags", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const tag = `rep-${suffix}`;
    const okId = await mkEligible(tag, "Report Ron");
    const supId = await db.contact.create({
      data: {
        workspaceId: wsA,
        name: `Report Sup ${suffix}`,
        channel: "facebook",
        tags: JSON.stringify([tag]),
        externalIds: JSON.stringify({ PSID: `c3-psid-repsup-${suffix}` }),
        lastInboundAt: new Date(),
      },
    }).then(async (c) => {
      await db.suppression.create({ data: { workspaceId: wsA, contactId: c.id, reason: "opt-out" } });
      return c.id;
    });
    const lap = await db.contact.create({
      data: {
        workspaceId: wsA,
        name: `Report Lapse ${suffix}`,
        channel: "facebook",
        tags: JSON.stringify([tag]),
        externalIds: JSON.stringify({ PSID: `c3-psid-replap-${suffix}` }),
        lastInboundAt: new Date(Date.now() - 30 * 3600_000),
      },
    });
    const lapId = lap.id;

    const c = await createCampaign({ audience: JSON.stringify({ type: "tag", tag }) });
    await build(c.id);
    await start(c.id);
    await process(c.id);

    const { status, body } = await report(c.id);
    expect(status).toBe(200);
    const r = body.data.report;
    expect(r.total).toBe(3);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(2);
    expect(r.pending).toBe(0);
    expect(r.replied).toBe(0);
    expect(r.attempted).toBe(1); // SENT + FAILED only

    const rows = new Map<string, any>(r.perRecipient.map((x: any) => [x.contactId, x]));
    expect(rows.get(okId).status).toBe("SENT");
    expect(rows.get(okId).mocked).toBe(true);
    expect(rows.get(okId).sentAt).not.toBeNull();
    expect(rows.get(supId).status).toBe("SKIPPED");
    expect(rows.get(supId).skipReason).toContain("suppressed");
    expect(rows.get(lapId).skipReason).toContain("24h");
  });
});

describe("inbound reply hook", () => {
  it("a reply auto-pauses the wave, marks the recipient REPLIED, and advances New → Interested", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const tag = `reply-${suffix}`;
    const psid = `c3-psid-${tag}`;
    const replier = await db.contact.create({
      data: {
        workspaceId: wsA,
        name: `Reply Rita ${suffix}`,
        channel: "facebook",
        leadStatus: "NEW",
        tags: JSON.stringify([tag]),
        externalIds: JSON.stringify({ PSID: psid }),
        lastInboundAt: new Date(),
      },
    });
    // Second recipient keeps the campaign RUNNING after one batch.
    const otherId = await mkEligible(tag, "Reply Other");
    void otherId;

    const c = await createCampaign({ audience: JSON.stringify({ type: "tag", tag }) });
    const b = await build(c.id);
    expect(b.body.data.build.pending).toBe(2);
    await start(c.id);
    // Process exactly one batch so the campaign is still RUNNING.
    const one = await process(c.id, wsA, 1);
    expect(one.body.data.process.sent).toBe(1);
    expect(one.body.data.process.completed).toBe(false);

    const integ = await ensureIntegration(wsA, "facebook");
    const { messages } = await ingestMetaEvent(
      { id: integ.id, workspaceId: wsA, provider: "facebook" },
      {
        messaging: [
          {
            sender: { id: psid },
            message: { mid: `mid-reply-${suffix}`, text: "yes, tell me more" },
            timestamp: Math.floor(Date.now() / 1000),
          },
        ],
      }
    );
    expect(messages).toBe(1);

    const row = await db.campaignRecipient.findFirst({
      where: { campaignId: c.id, contactId: replier.id },
    });
    expect(row?.status).toBe("REPLIED");
    expect(row?.repliedAt).not.toBeNull();

    const campaign = await db.campaign.findUnique({ where: { id: c.id } });
    expect(campaign?.status).toBe("PAUSED"); // pauseOnReply default true

    const contact = await db.contact.findUnique({ where: { id: replier.id } });
    expect(contact?.leadStatus).toBe("INTERESTED");

    const audit = await db.auditEvent.findFirst({
      where: { workspaceId: wsA, action: "campaign.auto_paused_on_reply" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();

    // Report reflects the reply (measured from the real inbound event).
    const { body } = await report(c.id);
    expect(body.data.report.replied).toBe(1);
  });

  it("a wave with pauseOnReply=false stays RUNNING when a recipient replies", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const tag = `nopause-${suffix}`;
    const psid = `c3-psid-${tag}`;
    const replier = await db.contact.create({
      data: {
        workspaceId: wsA,
        name: `NoPause Ned ${suffix}`,
        channel: "facebook",
        leadStatus: "CONTACTED",
        tags: JSON.stringify([tag]),
        externalIds: JSON.stringify({ PSID: psid }),
        lastInboundAt: new Date(),
      },
    });
    await mkEligible(tag, "NoPause Other");

    const c = await createCampaign({
      audience: JSON.stringify({ type: "tag", tag }),
      pauseOnReply: false,
    });
    await build(c.id);
    await start(c.id);
    await process(c.id, wsA, 1);

    const integ = await ensureIntegration(wsA, "facebook");
    await ingestMetaEvent(
      { id: integ.id, workspaceId: wsA, provider: "facebook" },
      {
        messaging: [
          {
            sender: { id: psid },
            message: { mid: `mid-nopause-${suffix}`, text: "ok" },
            timestamp: Math.floor(Date.now() / 1000),
          },
        ],
      }
    );

    const row = await db.campaignRecipient.findFirst({
      where: { campaignId: c.id, contactId: replier.id },
    });
    expect(row?.status).toBe("REPLIED");

    // pauseOnReply=false → the wave keeps running.
    const campaign = await db.campaign.findUnique({ where: { id: c.id } });
    expect(campaign?.status).toBe("RUNNING");

    const contact = await db.contact.findUnique({ where: { id: replier.id } });
    expect(contact?.leadStatus).toBe("INTERESTED"); // Contacted → Interested
  });
});

describe("process-due worker", () => {
  it("flips due SCHEDULED campaigns to RUNNING and processes a batch", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const c = await createCampaign({ status: "SCHEDULED", scheduledAt: new Date(Date.now() - 1000) });
    await build(c.id);

    const future = await createCampaign({
      status: "SCHEDULED",
      scheduledAt: new Date(Date.now() + 3600_000),
    });
    await build(future.id);

    const { status, body } = await jsonBody(
      await processDuePOST(noBodyPost("http://x/api/campaigns/process-due", wsA) as NextRequest, {} as any)
    );
    expect(status).toBe(200);
    expect(body.data.started).toContain(c.id);
    expect(body.data.started).not.toContain(future.id);

    const due = await db.campaign.findUnique({ where: { id: c.id } });
    expect(due?.status).toBe("COMPLETED"); // one eligible recipient → sent → done
    const notDue = await db.campaign.findUnique({ where: { id: future.id } });
    expect(notDue?.status).toBe("SCHEDULED");
  });
});

describe("schedule route", () => {
  it("requires a CONNECTED provider for the channel (422 without one)", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const c = await createCampaign({ channel: "whatsapp" });
    const { status } = await jsonBody(
      await withId(
        schedulePOST,
        req(`http://x/api/campaigns/${c.id}/schedule`, wsA, { method: "POST", body: {} }),
        c.id
      )
    );
    expect(status).toBe(422);

    await db.integration.create({
      data: { workspaceId: wsA, provider: "whatsapp", status: "CONNECTED" },
    });
    const okRes = await jsonBody(
      await withId(
        schedulePOST,
        req(`http://x/api/campaigns/${c.id}/schedule`, wsA, {
          method: "POST",
          body: { scheduledAt: new Date(Date.now() + 3600_000).toISOString() },
        }),
        c.id
      )
    );
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.campaign.status).toBe("SCHEDULED");
  });
});

describe("tenant isolation", () => {
  it("B cannot touch A's campaigns on any new route", async () => {
    authedAs(userAId, `c3-a-${suffix}@example.com`);
    const c = await createCampaign();
    authedAs(userBId, `c3-b-${suffix}@example.com`);

    const paths: [string, (r: NextRequest) => Promise<Response>][] = [
      ["build", (r) => withId(buildPOST, r, c.id)],
      ["start", (r) => withId(startPOST, r, c.id)],
      ["pause", (r) => withId(pausePOST, r, c.id)],
      ["cancel", (r) => withId(cancelPOST, r, c.id)],
      ["process", (r) => withId(processPOST, r, c.id)],
      ["retry", (r) => withId(retryPOST, r, c.id)],
      ["report", (r) => withId(reportGET, r, c.id)],
      ["schedule", (r) => withId(schedulePOST, r, c.id)],
    ];
    for (const [name, call] of paths) {
      const isGet = name === "report";
      const r = isGet
        ? req(`http://x/api/campaigns/${c.id}/${name}`, wsB)
        : name === "build" || name === "schedule"
          ? req(`http://x/api/campaigns/${c.id}/${name === "build" ? "recipients/build" : "schedule"}`, wsB, { method: "POST", body: {} })
          : noBodyPost(`http://x/api/campaigns/${c.id}/${name === "retry" ? "retry-failed" : name}`, wsB);
      const { status } = await jsonBody(await call(r));
      expect(status, `${name} should 404 for another workspace`).toBe(404);
    }

    // B's process-due only sees B's workspace (A's due campaigns untouched).
    const due = await db.campaign.create({
      data: {
        workspaceId: wsA,
        name: `C3 due ${suffix}`,
        channel: "facebook",
        status: "SCHEDULED",
        audience: JSON.stringify({ type: "all" }),
        message: JSON.stringify({ text: "hi" }),
        scheduledAt: new Date(Date.now() - 1000),
      },
    });
    const { body } = await jsonBody(
      await processDuePOST(noBodyPost("http://x/api/campaigns/process-due", wsB) as NextRequest, {} as any)
    );
    expect(body.data.started).not.toContain(due.id);
    const still = await db.campaign.findUnique({ where: { id: due.id } });
    expect(still?.status).toBe("SCHEDULED");
  });
});
