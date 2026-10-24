/**
 * Inbound → workflow dispatch tests (Batch A item 5).
 *
 * Exercises dispatchInboundWorkflows directly and through the real ingest
 * path (ingestMetaEvent): PUBLISHED workflows fire on matching inbound
 * events; DRAFT/PAUSED never fire; keyword and channel_is gates are
 * honored; a webhook redelivery after restart (in-memory dedupe cleared)
 * produces neither a duplicate Message nor a duplicate dispatch.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { resetQueue } from "@/lib/queue";
import { dispatchInboundWorkflows } from "./dispatch";
import { ingestMetaEvent, seenDeliveryIds } from "@/lib/integrations/ingest";

let seq = 0;
const suffix = `dsp${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

async function makeWorkspace(isDemo = false): Promise<string> {
  seq += 1;
  const org = await db.organization.create({ data: { name: `Dispatch Org ${seq} ${suffix}` } });
  const w = await db.workspace.create({
    data: {
      orgId: org.id,
      name: `Dispatch WS ${seq}`,
      slug: `dispatch-ws-${seq}-${suffix}`,
      isDemo,
    },
  });
  return w.id;
}

interface N {
  key: string;
  kind: string;
  type: string;
  config?: Record<string, unknown>;
  disabled?: boolean;
}

async function makeWorkflow(
  workspaceId: string,
  status: string,
  nodes: N[],
  edges: [string, string][]
): Promise<string> {
  seq += 1;
  const p = `d${seq}`;
  const idOf = (k: string) => `${p}-${k}-${suffix}`;
  const wf = await db.workflow.create({
    data: {
      workspaceId,
      name: `Dispatch WF ${seq} ${suffix}`,
      status,
      nodes: {
        create: nodes.map((n) => ({
          id: idOf(n.key),
          kind: n.kind,
          type: n.type,
          label: n.type,
          config: JSON.stringify(n.config ?? {}),
          position: JSON.stringify({ x: 0, y: 0 }),
          disabled: n.disabled ?? false,
        })),
      },
      edges: {
        create: edges.map(([s, t], i) => ({
          id: `${p}-e${i}-${suffix}`,
          sourceId: idOf(s),
          targetId: idOf(t),
          label: "",
          condition: "{}",
        })),
      },
    },
  });
  return wf.id;
}

const SIMPLE: N[] = [
  { key: "t", kind: "trigger", type: "trigger.new_message" },
  { key: "a", kind: "action", type: "action.add_tag", config: { tag: "auto" } },
];
const SIMPLE_EDGES: [string, string][] = [["t", "a"]];

async function executionCount(workspaceId: string): Promise<number> {
  return db.workflowExecution.count({
    where: { workflow: { workspaceId } },
  });
}

beforeEach(() => {
  resetQueue();
});

describe("dispatchInboundWorkflows", () => {
  it("executes a PUBLISHED new_message workflow and is idempotent per provider event", async () => {
    const ws = await makeWorkspace();
    const wfId = await makeWorkflow(ws, "PUBLISHED", SIMPLE, SIMPLE_EDGES);
    const input = {
      kind: "message" as const,
      channel: "whatsapp",
      integrationId: `int-${suffix}`,
      contactId: "c1",
      conversationId: "conv1",
      from: "15550001",
      text: "hi there",
      providerEventId: `wamid:dup-${suffix}`,
    };
    const first = await dispatchInboundWorkflows(ws, input);
    expect(first).toEqual({ dispatched: 1, failed: 0 });
    const second = await dispatchInboundWorkflows(ws, input);
    expect(second.dispatched).toBe(0); // engine dedupe on the derived idempotency key
    expect(await executionCount(ws)).toBe(1);
    const exec = await db.workflowExecution.findFirst({ where: { workflowId: wfId } });
    expect(exec!.idempotencyKey).toBe(`inbound:wamid:dup-${suffix}:${wfId}`);
    // The matched account's identity travels with the execution payload.
    expect(JSON.parse(exec!.triggerEvent).integrationId).toBe(`int-${suffix}`);
  });

  it("never dispatches DRAFT or PAUSED workflows", async () => {
    const ws = await makeWorkspace();
    await makeWorkflow(ws, "DRAFT", SIMPLE, SIMPLE_EDGES);
    await makeWorkflow(ws, "PAUSED", SIMPLE, SIMPLE_EDGES);
    const n = await dispatchInboundWorkflows(ws, {
      kind: "message",
      channel: "instagram",
      integrationId: `int-${suffix}`,
      contactId: "c1",
      conversationId: "conv1",
      from: "u1",
      text: "hi",
      providerEventId: `mid:draft-${suffix}`,
    });
    expect(n).toEqual({ dispatched: 0, failed: 0 });
    expect(await executionCount(ws)).toBe(0);
  });

  it("keyword triggers fire only when the keyword matches", async () => {
    const ws = await makeWorkspace();
    await makeWorkflow(
      ws,
      "PUBLISHED",
      [
        { key: "t", kind: "trigger", type: "trigger.keyword", config: { keyword: "price" } },
        { key: "a", kind: "action", type: "action.add_tag", config: { tag: "pricing" } },
      ],
      SIMPLE_EDGES
    );
    const base = {
      kind: "message" as const,
      channel: "instagram",
      integrationId: `int-${suffix}`,
      contactId: "c1",
      conversationId: "conv1",
      from: "u1",
    };
    expect(
      (await dispatchInboundWorkflows(ws, { ...base, text: "hello", providerEventId: `mid:kw1-${suffix}` })).dispatched
    ).toBe(0);
    expect(
      (await dispatchInboundWorkflows(ws, { ...base, text: "What is the PRICE?", providerEventId: `mid:kw2-${suffix}` })).dispatched
    ).toBe(1);
    expect(await executionCount(ws)).toBe(1);
  });

  it("honors a condition.channel_is gate directly downstream of the trigger", async () => {
    const ws = await makeWorkspace();
    await makeWorkflow(
      ws,
      "PUBLISHED",
      [
        { key: "t", kind: "trigger", type: "trigger.new_message" },
        { key: "c", kind: "condition", type: "condition.channel_is", config: { channel: "facebook" } },
        { key: "a", kind: "action", type: "action.add_tag", config: { tag: "fb" } },
      ],
      [
        ["t", "c"],
        ["c", "a"],
      ]
    );
    const base = {
      kind: "message" as const,
      integrationId: `int-${suffix}`,
      contactId: "c1",
      conversationId: "conv1",
      from: "u1",
      text: "hi",
    };
    expect(
      (await dispatchInboundWorkflows(ws, { ...base, channel: "whatsapp", providerEventId: `mid:gate1-${suffix}` })).dispatched
    ).toBe(0);
    expect(
      (await dispatchInboundWorkflows(ws, { ...base, channel: "facebook", providerEventId: `mid:gate2-${suffix}` })).dispatched
    ).toBe(1);
  });

  it("does not throw for a demo workspace, but reports the dispatch failure", async () => {
    const ws = await makeWorkspace(true);
    await makeWorkflow(ws, "PUBLISHED", SIMPLE, SIMPLE_EDGES);
    const n = await dispatchInboundWorkflows(ws, {
      kind: "message",
      channel: "whatsapp",
      integrationId: `int-${suffix}`,
      contactId: "c1",
      conversationId: "conv1",
      from: "15550001",
      text: "hi",
      providerEventId: `wamid:demo-${suffix}`,
    });
    // The engine's demo guard blocks the run; dispatch counts it as failed
    // so the webhook layer can answer 5xx instead of silently accepting.
    expect(n).toEqual({ dispatched: 0, failed: 1 });
    expect(await executionCount(ws)).toBe(0);
  });
});

describe("ingest → dispatch (real path)", () => {
  it("an inbound message fires the workflow once; a post-restart redelivery fires neither message nor workflow twice", async () => {
    const ws = await makeWorkspace();
    const wfId = await makeWorkflow(ws, "PUBLISHED", SIMPLE, SIMPLE_EDGES);
    const mid = `mid.ingest-${suffix}`;
    const entry = {
      id: `page-${suffix}`,
      time: 1_700_000_500,
      messaging: [
        {
          sender: { id: `user-${suffix}` },
          message: { mid, text: "hello dispatch" },
          timestamp: 1_700_000_500,
        },
      ],
    };
    const integration = { id: `int-${suffix}`, workspaceId: ws, provider: "facebook" };

    const r1 = await ingestMetaEvent(integration, entry);
    expect(r1.messages).toBe(1);
    expect(r1.failed).toBe(false);
    expect(await executionCount(ws)).toBe(1);
    const exec = await db.workflowExecution.findFirst({ where: { workflowId: wfId } });
    expect(exec!.idempotencyKey).toBe(`inbound:mid:${mid}:${wfId}`);
    // The execution payload names the account that received the event.
    expect(JSON.parse(exec!.triggerEvent).integrationId).toBe(integration.id);

    // Simulate restart: in-memory dedupe gone; Meta redelivers the same entry.
    seenDeliveryIds.clear();
    const r2 = await ingestMetaEvent(integration, entry);
    expect(r2.messages).toBe(0);
    expect(r2.failed).toBe(false);
    expect(await executionCount(ws)).toBe(1);
    const msgCount = await db.message.count({ where: { conversation: { workspaceId: ws } } });
    expect(msgCount).toBe(1);
  });
});
