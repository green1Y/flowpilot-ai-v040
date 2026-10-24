/**
 * Demo-mode send guard tests (Batch B public-beta readiness).
 *
 * Every real-send boundary must refuse with 403 when the workspace is a
 * demo workspace (isDemo=true) or when DEMO_MODE=true — and must NOT call
 * any provider adapter. Live workspaces proceed normally.
 *
 * Boundaries covered:
 *  - sendFollowUp (single sends + scheduler worker + campaign per-recipient
 *    + retargeting DM per-recipient all funnel through it)
 *  - processCampaign (legacy campaign batch, per-campaign guard)
 *  - launchRetargetingCampaign / processDueRetargeting (per-campaign guard)
 *  - executeWorkflow (enqueue guard; dry-run stays allowed)
 *  - processWorkflowJob runAction cases: action.send_message,
 *    action.reply_comment path, action.send_email, action.send_whatsapp_template
 *    (queue retry re-entry — the guard runs on retry too)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import { getWorkspaceAdapter } from "@/lib/integrations/providers";
import type { Job } from "@/lib/queue";
import { sendFollowUp } from "@/lib/messaging/send";
import { processCampaign } from "@/lib/messaging/campaigns";
import { executeWorkflow, processWorkflowJob } from "@/lib/workflows/engine";
import {
  launchRetargetingCampaign,
  processDueRetargeting,
} from "@/lib/retargeting/campaigns";

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
  return { getAdapter: vi.fn(), getWorkspaceAdapter, resolveWorkspaceAdapter, AccountResolutionError };
});
const mockedGetAdapter = vi.mocked(getWorkspaceAdapter);

const sendMessage = vi.fn(async () => ({ ok: true, mocked: true, externalId: "mock-ext-1" }));
const replyToComment = vi.fn(async () => ({ ok: true, mocked: true, externalId: "mock-pr-1" }));

function fakeAdapter() {
  mockedGetAdapter.mockResolvedValue({
    provider: "facebook",
    displayName: "Fake",
    sendMessage,
    replyToComment,
  } as any);
}

const suffix = `demo${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let demoWs = "";
let liveWs = "";
let userId = "";
let demoContactId = "";
let liveContactId = "";

async function makeContact(workspaceId: string, name: string) {
  return db.contact.create({
    data: {
      workspaceId,
      name,
      channel: "facebook",
      externalIds: JSON.stringify({ PSID: `psid-${suffix}-${Math.random()}` }),
      lastInboundAt: new Date(),
    },
  });
}

async function makeWorkflow(workspaceId: string, actionType: string, actionConfig: Record<string, unknown>) {
  const wf = await db.workflow.create({
    data: { workspaceId, name: `WF ${suffix}-${Math.random()}`, status: "PUBLISHED" },
  });
  const trigger = await db.workflowNode.create({
    data: { workflowId: wf.id, kind: "trigger", type: "trigger.new_message", label: "Trigger" },
  });
  const action = await db.workflowNode.create({
    data: {
      workflowId: wf.id,
      kind: "action",
      type: actionType,
      label: "Action",
      config: JSON.stringify(actionConfig),
    },
  });
  await db.workflowEdge.create({
    data: { workflowId: wf.id, sourceId: trigger.id, targetId: action.id },
  });
  return wf;
}

async function makeExecution(workflowId: string, dryRun: boolean) {
  return db.workflowExecution.create({
    data: {
      workflowId,
      triggerEvent: JSON.stringify({
        type: "new_message",
        from: "psid-live",
        text: "hello",
        channel: "facebook",
      }),
      status: "QUEUED",
      idempotencyKey: `exec-${suffix}-${Math.random()}`,
      dryRun,
    },
  });
}

function jobFor(executionId: string): Job {
  return {
    id: `job-${Math.random()}`,
    type: "workflow_execution",
    payload: { executionId },
    attempts: 0,
    maxAttempts: 1,
    notBefore: Date.now(),
  };
}

/** Extract the thrown guard Response (or rethrow anything else). */
async function catchGuard(p: Promise<unknown>): Promise<Response> {
  const e = await p.catch((err) => err);
  expect(e).toBeInstanceOf(Response);
  return e as Response;
}

beforeAll(async () => {
  fakeAdapter();
  const user = await db.user.create({
    data: { email: `demo-guard-${suffix}@example.com`, name: "Demo Guard", passwordHash: "x" },
  });
  userId = user.id;
  const org = await db.organization.create({ data: { name: `Demo Guard Org ${suffix}` } });
  const demo = await db.workspace.create({
    data: { orgId: org.id, name: `Demo WS ${suffix}`, slug: `demo-ws-${suffix}`, isDemo: true },
  });
  const live = await db.workspace.create({
    data: { orgId: org.id, name: `Live WS ${suffix}`, slug: `live-ws-${suffix}`, isDemo: false },
  });
  demoWs = demo.id;
  liveWs = live.id;
  await db.membership.createMany({
    data: [
      { userId, workspaceId: demoWs, role: "OWNER" },
      { userId, workspaceId: liveWs, role: "OWNER" },
    ],
  });
  demoContactId = (await makeContact(demoWs, "Demo Contact")).id;
  liveContactId = (await makeContact(liveWs, "Live Contact")).id;
});

beforeEach(() => {
  sendMessage.mockClear();
  replyToComment.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sendFollowUp", () => {
  it("refuses with 403 on a demo workspace and never calls the adapter", async () => {
    const res = await catchGuard(
      sendFollowUp({
        workspaceId: demoWs,
        userId,
        contactId: demoContactId,
        channel: "facebook",
        messageType: "freeform",
        body: "hello",
        idempotencyKey: `demo-${suffix}-${Math.random()}`,
      })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("DEMO_WORKSPACE_SEND_BLOCKED");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      await db.outboundSend.count({ where: { workspaceId: demoWs } })
    ).toBe(0);
  });

  it("refuses with 403 when DEMO_MODE=true even for a live workspace", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = await catchGuard(
      sendFollowUp({
        workspaceId: liveWs,
        userId,
        contactId: liveContactId,
        channel: "facebook",
        messageType: "freeform",
        body: "hello",
        idempotencyKey: `global-${suffix}-${Math.random()}`,
      })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("DEMO_MODE_SEND_BLOCKED");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("lets live workspace sends proceed when DEMO_MODE is off", async () => {
    const result = await sendFollowUp({
      workspaceId: liveWs,
      userId,
      contactId: liveContactId,
      channel: "facebook",
      messageType: "freeform",
      body: "hello live",
      idempotencyKey: `live-${suffix}-${Math.random()}`,
    });
    expect(result.status).toBe("SENT");
    expect(result.mocked).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("processCampaign (legacy)", () => {
  it("refuses with 403 on a demo workspace before loading recipients", async () => {
    const campaign = await db.campaign.create({
      data: {
        workspaceId: demoWs,
        name: `Camp ${suffix}`,
        channel: "facebook",
        messageType: "template",
        status: "RUNNING",
        message: JSON.stringify({ text: "hi" }),
      },
    });
    const res = await catchGuard(processCampaign(demoWs, campaign.id));
    expect(res.status).toBe(403);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refuses with 403 when DEMO_MODE=true even for a live workspace", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const campaign = await db.campaign.create({
      data: {
        workspaceId: liveWs,
        name: `Camp live ${suffix}`,
        channel: "facebook",
        messageType: "template",
        status: "RUNNING",
        message: JSON.stringify({ text: "hi" }),
      },
    });
    const res = await catchGuard(processCampaign(liveWs, campaign.id));
    expect(res.status).toBe(403);
  });
});

describe("retargeting campaigns", () => {
  async function makeRetargetingCampaign(workspaceId: string, status: string, type = "dm_reengagement") {
    const segment = await db.audienceSegment.create({
      data: {
        workspaceId,
        name: `Seg ${suffix}-${Math.random()}`,
        conditions: JSON.stringify({ op: "and", rules: [] }),
      },
    });
    return db.retargetingCampaign.create({
      data: {
        workspaceId,
        name: `RTC ${suffix}-${Math.random()}`,
        type,
        status,
        channel: "facebook",
        segmentId: segment.id,
        message: JSON.stringify({ body: "Hi!" }),
        schedule: JSON.stringify({}),
        createdById: userId,
      },
    });
  }

  it("launchRetargetingCampaign refuses with 403 on a demo workspace", async () => {
    const campaign = await makeRetargetingCampaign(demoWs, "draft");
    const res = await catchGuard(
      launchRetargetingCampaign(demoWs, campaign.id, { userId, confirmed: true })
    );
    expect(res.status).toBe(403);
    // Campaign was not launched.
    expect((await db.retargetingCampaign.findUnique({ where: { id: campaign.id } }))?.status).toBe("draft");
  });

  it("processDueRetargeting refuses with 403 on a demo workspace (per-campaign fail-fast)", async () => {
    const campaign = await makeRetargetingCampaign(demoWs, "running");
    const res = await catchGuard(processDueRetargeting(demoWs, campaign.id));
    expect(res.status).toBe(403);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("launchRetargetingCampaign lets live workspaces proceed", async () => {
    // Fresh contact: the earlier live sendFollowUp consumed this workspace's
    // contact's 1/day retargeting frequency cap.
    const fresh = await makeContact(liveWs, "Launch Contact");
    expect(fresh.id).toBeTruthy();
    const campaign = await makeRetargetingCampaign(liveWs, "draft");
    // The fresh contact is eligible (recent inbound + PSID), so launch
    // succeeds — proving the demo guard passed through instead of 403.
    const launched = await launchRetargetingCampaign(liveWs, campaign.id, {
      userId,
      confirmed: true,
    });
    expect(launched.status).toBe("running");
  });
});

describe("workflow engine", () => {
  it("executeWorkflow refuses with 403 on a demo workspace (no execution created)", async () => {
    const wf = await makeWorkflow(demoWs, "action.send_message", {
      channel: "facebook",
      body: "hello",
    });
    const key = `nope-${suffix}-${Math.random()}`;
    const res = await catchGuard(
      executeWorkflow({ workflowId: wf.id, workspaceId: demoWs, event: {}, idempotencyKey: key })
    );
    expect(res.status).toBe(403);
    expect(await db.workflowExecution.findUnique({ where: { idempotencyKey: key } })).toBeNull();
  });

  it("executeWorkflow refuses with 403 when DEMO_MODE=true even for a live workspace", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const wf = await makeWorkflow(liveWs, "action.send_message", {
      channel: "facebook",
      body: "hello",
    });
    const res = await catchGuard(
      executeWorkflow({
        workflowId: wf.id,
        workspaceId: liveWs,
        event: {},
        idempotencyKey: `nope2-${suffix}-${Math.random()}`,
      })
    );
    expect(res.status).toBe(403);
  });

  it("executeWorkflow still allows dry-run executions on a demo workspace", async () => {
    const wf = await makeWorkflow(demoWs, "action.send_message", {
      channel: "facebook",
      body: "hello",
    });
    const { executionId } = await executeWorkflow({
      workflowId: wf.id,
      workspaceId: demoWs,
      event: {},
      idempotencyKey: `dry-${suffix}-${Math.random()}`,
      dryRun: true,
    });
    expect(executionId).toBeTruthy();
  });

  it("processWorkflowJob refuses action.send_message with 403 on retry re-entry (demo)", async () => {
    const wf = await makeWorkflow(demoWs, "action.send_message", {
      channel: "facebook",
      body: "hello",
    });
    const exec = await makeExecution(wf.id, false);
    const res = await catchGuard(processWorkflowJob(jobFor(exec.id)));
    expect(res.status).toBe(403);
    expect(sendMessage).not.toHaveBeenCalled();
    // The step was recorded FAILED (loud, retryable-by-queue) — and the
    // failure is the 403, not a provider error.
    const step = await db.executionStep.findFirst({
      where: { executionId: exec.id, nodeLabel: "Action" },
    });
    expect(step?.status).toBe("FAILED");
  });

  it("processWorkflowJob refuses action.send_email with 403 on a demo workspace", async () => {
    const wf = await makeWorkflow(demoWs, "action.send_email", {
      to: "a@example.com",
      subject: "Hi",
      body: "Hello",
    });
    const exec = await makeExecution(wf.id, false);
    const res = await catchGuard(processWorkflowJob(jobFor(exec.id)));
    expect(res.status).toBe(403);
  });

  it("processWorkflowJob refuses action.send_whatsapp_template with 403 on a demo workspace", async () => {
    const wf = await makeWorkflow(demoWs, "action.send_whatsapp_template", {
      templateName: "hello_world",
      params: [],
    });
    const exec = await makeExecution(wf.id, false);
    const res = await catchGuard(processWorkflowJob(jobFor(exec.id)));
    expect(res.status).toBe(403);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("processWorkflowJob sends on a live workspace (guard passes through)", async () => {
    const wf = await makeWorkflow(liveWs, "action.send_message", {
      channel: "facebook",
      body: "hello live",
    });
    const exec = await makeExecution(wf.id, false);
    await processWorkflowJob(jobFor(exec.id));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const step = await db.executionStep.findFirst({
      where: { executionId: exec.id, nodeLabel: "Action" },
    });
    expect(step?.status).toBe("SUCCEEDED");
  });
});
