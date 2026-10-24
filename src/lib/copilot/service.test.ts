/**
 * Copilot service tests: generation via a stubbed AI provider, the honest
 * unconfigured state, timeout mapping, tenant isolation, and the
 * clarifying-question flow. The mock AI provider is never used — tests set
 * AI_PROVIDER=openai + OPENAI_API_KEY and stub fetch.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { db } from "@/lib/db";
import {
  runCopilotOp,
  CopilotRateLimitedError,
  loadWorkflowSummary,
} from "./service";
import { AiNotConfiguredError, AiTimeoutError } from "@/lib/ai/structured";
import { resetCopilotRateLimit } from "./rateLimit";

let seq = 0;
const cleanup: Array<() => Promise<unknown>> = [];

const OLD_AI_PROVIDER = process.env.AI_PROVIDER;
const OLD_OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function makeWorkspace(name: string) {
  seq += 1;
  const org = await db.organization.create({ data: { name: `Copilot Org ${Date.now()}-${seq}` } });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name, slug: `copilot-ws-${Date.now()}-${seq}` },
  });
  cleanup.push(async () => {
    await db.workflow.deleteMany({ where: { workspaceId: ws.id } });
    await db.workspace.delete({ where: { id: ws.id } });
    await db.organization.delete({ where: { id: org.id } });
  });
  return ws;
}

async function makeWorkflow(workspaceId: string) {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  const wf = await db.workflow.create({
    data: {
      workspaceId,
      name: `Copilot WF ${tag}`,
      status: "DRAFT",
      nodes: {
        create: [
          { id: `t-${tag}`, kind: "trigger", type: "trigger.new_message", label: "New message", config: "{}", position: '{"x":80,"y":120}' },
          { id: `a-${tag}`, kind: "action", type: "action.send_message", label: "Reply", config: '{"channel":"instagram","body":"Hi"}', position: '{"x":340,"y":120}' },
        ],
      },
      edges: {
        create: [{ id: `e-${tag}`, sourceId: `t-${tag}`, targetId: `a-${tag}`, label: "", condition: "{}" }],
      },
    },
  });
  return wf;
}

function stubFetchWith(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    })
  );
}

const SPEC_FIXTURE = JSON.stringify({
  nodes: [
    { id: "t1", kind: "trigger", type: "trigger.keyword", label: "Price keyword", config: { keyword: "price" }, x: 80, y: 120 },
    { id: "a1", kind: "action", type: "action.send_message", label: "Send pricing", config: { channel: "instagram", body: "Our plans start at $9." }, x: 340, y: 120 },
    { id: "a2", kind: "action", type: "action.add_tag", label: "Tag lead", config: { tag: "lead" }, x: 600, y: 120 },
  ],
  edges: [
    { sourceId: "t1", targetId: "a1", label: "" },
    { sourceId: "a1", targetId: "a2", label: "" },
  ],
});

const COMPLETE_PROMPT =
  "When a new message arrives on Instagram containing the word price, send a reply message with our pricing and tag the contact as lead.";

beforeEach(() => {
  resetCopilotRateLimit();
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.AI_PROVIDER = OLD_AI_PROVIDER;
  if (OLD_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = OLD_OPENAI_API_KEY;
});

afterAll(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe("runCopilotOp — generate", () => {
  it("returns clarifying questions for a vague prompt (no AI call)", async () => {
    const ws = await makeWorkspace("Q WS");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const result = await runCopilotOp({
      workspaceId: ws.id,
      userId: "u1",
      op: "generate",
      prompt: "automate stuff",
    });
    expect(result.kind).toBe("questions");
    expect(spy).not.toHaveBeenCalled();
  });

  it("generates a valid spec with a configured provider (mocked fetch)", async () => {
    const ws = await makeWorkspace("Gen WS");
    stubFetchWith(SPEC_FIXTURE);
    const result = await runCopilotOp({
      workspaceId: ws.id,
      userId: "u1",
      op: "generate",
      prompt: COMPLETE_PROMPT,
    });
    expect(result.kind).toBe("spec");
    if (result.kind !== "spec") return;
    expect(result.mocked).toBe(false);
    expect(result.spec.nodes.map((n) => n.type)).toContain("trigger.keyword");
    expect(result.spec.nodes.map((n) => n.type)).toContain("action.send_message");
  });

  it("skips questions when answers are provided", async () => {
    const ws = await makeWorkspace("Ans WS");
    stubFetchWith(SPEC_FIXTURE);
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: SPEC_FIXTURE } }] }),
    });
    vi.stubGlobal("fetch", spy);
    const result = await runCopilotOp({
      workspaceId: ws.id,
      userId: "u1",
      op: "generate",
      prompt: "automate stuff",
      answers: { channel: "instagram", trigger: "new_message", content: "send hello" },
    });
    expect(result.kind).toBe("spec");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("throws an honest AiNotConfiguredError when no provider is set", async () => {
    const ws = await makeWorkspace("Unconf WS");
    delete process.env.OPENAI_API_KEY;
    process.env.AI_PROVIDER = "mock";
    await expect(
      runCopilotOp({ workspaceId: ws.id, userId: "u1", op: "generate", prompt: COMPLETE_PROMPT })
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it("maps provider timeouts to AiTimeoutError", async () => {
    const ws = await makeWorkspace("Timeout WS");
    const timeoutErr = new Error("timed out");
    timeoutErr.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutErr));
    await expect(
      runCopilotOp({ workspaceId: ws.id, userId: "u1", op: "generate", prompt: COMPLETE_PROMPT })
    ).rejects.toBeInstanceOf(AiTimeoutError);
  });

  it("enforces the per-workspace rate limit", async () => {
    const ws = await makeWorkspace("RL WS");
    stubFetchWith(SPEC_FIXTURE);
    for (let i = 0; i < 20; i++) {
      await runCopilotOp({ workspaceId: ws.id, userId: "u1", op: "generate", prompt: COMPLETE_PROMPT });
    }
    await expect(
      runCopilotOp({ workspaceId: ws.id, userId: "u1", op: "generate", prompt: COMPLETE_PROMPT })
    ).rejects.toBeInstanceOf(CopilotRateLimitedError);
  });
});

describe("runCopilotOp — explain / diagnose", () => {
  it("explains a workflow with AI text", async () => {
    const ws = await makeWorkspace("Explain WS");
    const wf = await makeWorkflow(ws.id);
    stubFetchWith("This workflow replies to new Instagram messages.");
    const result = await runCopilotOp({
      workspaceId: ws.id,
      userId: "u1",
      op: "explain",
      prompt: "",
      workflowId: wf.id,
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text).toContain("Instagram");
  });

  it("diagnose reports honestly when there are no failed executions", async () => {
    const ws = await makeWorkspace("Diag WS");
    const wf = await makeWorkflow(ws.id);
    const result = await runCopilotOp({
      workspaceId: ws.id,
      userId: "u1",
      op: "diagnose",
      prompt: "",
      workflowId: wf.id,
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text).toMatch(/no failed executions/i);
  });
});

describe("runCopilotOp — add-step / translate", () => {
  it("add_delay returns an appendable fragment spec", async () => {
    const ws = await makeWorkspace("AddDelay WS");
    const wf = await makeWorkflow(ws.id);
    stubFetchWith(
      JSON.stringify({
        nodes: [
          { id: "n_new_1", kind: "flow", type: "flow.delay", label: "Wait", config: { seconds: 300 }, x: 600, y: 120 },
        ],
        edges: [{ sourceId: wf.id ? "x" : "x", targetId: "n_new_1", label: "" }],
      })
    );
    const result = await runCopilotOp({
      workspaceId: ws.id,
      userId: "u1",
      op: "add_delay",
      prompt: "",
      workflowId: wf.id,
    });
    expect(result.kind).toBe("spec");
  });

  it("translate returns a label mapping as text JSON", async () => {
    const ws = await makeWorkspace("Translate WS");
    const wf = await makeWorkflow(ws.id);
    stubFetchWith(JSON.stringify({ labels: { "some-id": "رسالة جديدة" } }));
    const result = await runCopilotOp({
      workspaceId: ws.id,
      userId: "u1",
      op: "translate",
      prompt: "",
      workflowId: wf.id,
      locale: "ar",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      const parsed = JSON.parse(result.text) as { labels: Record<string, string> };
      expect(parsed.labels["some-id"]).toBe("رسالة جديدة");
    }
  });
});

describe("runCopilotOp — tenant isolation", () => {
  it("workspace B cannot explain workspace A's workflow", async () => {
    const wsA = await makeWorkspace("Tenant A");
    const wsB = await makeWorkspace("Tenant B");
    const wfA = await makeWorkflow(wsA.id);
    await expect(
      runCopilotOp({ workspaceId: wsB.id, userId: "u1", op: "explain", prompt: "", workflowId: wfA.id })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("loadWorkflowSummary is workspace-scoped", async () => {
    const wsA = await makeWorkspace("Tenant A2");
    const wsB = await makeWorkspace("Tenant B2");
    const wfA = await makeWorkflow(wsA.id);
    await expect(loadWorkflowSummary(wsB.id, wfA.id)).rejects.toMatchObject({ status: 404 });
    const okSummary = await loadWorkflowSummary(wsA.id, wfA.id);
    expect(okSummary.nodes).toHaveLength(2);
  });
});
