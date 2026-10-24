/**
 * Webhook acceptance semantics (Batch A refinement — JOE criterion 3).
 *
 * 200 means "safely accepted for processing". When workflow dispatch
 * fails (here: the workspace is in demo mode, so the engine guard blocks
 * the run), the webhook must answer 5xx so Meta redelivers. The redelivery
 * — after the blocking condition clears — must process the event exactly
 * once: the message is not duplicated (durable CustomerEvent dedupe) and
 * the workflow executes exactly once (dispatch idempotency key), with the
 * matched integration's id recorded in the execution payload.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { POST } from "./route";
import { seenDeliveryIds } from "@/lib/integrations/ingest";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
const mockedRequireUser = vi.mocked(requireUser);

process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-app-secret-for-redelivery";
process.env.META_VERIFY_TOKEN = "test-verify-token-rd";
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

const suffix = `rd${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const pnid = `pnid-rd-${suffix}`;
const wamid = `wamid.RD.${suffix}.1`;

let wsId = "";
let integrationId = "";
let wfId = "";

function payload(): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: `waba-${suffix}`,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: pnid },
              messages: [
                {
                  from: "15551112222",
                  id: wamid,
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "redeliver me" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function messageCount(): Promise<number> {
  return db.message.count({ where: { conversation: { workspaceId: wsId } } });
}

beforeAll(async () => {
  mockedRequireUser.mockResolvedValue({
    userId: "rd-user",
    email: "rd@example.com",
    user: { id: "rd-user", name: "RD", email: "rd@example.com" },
  } as any);

  const org = await db.organization.create({ data: { name: `RD Org ${suffix}` } });
  const w = await db.workspace.create({
    data: {
      orgId: org.id,
      name: `RD WS ${suffix}`,
      slug: `rd-${suffix}`,
      isDemo: true, // engine guard blocks dispatch → transient failure for this test
    },
  });
  wsId = w.id;

  const integ = await db.integration.create({
    data: {
      workspaceId: w.id,
      provider: "whatsapp",
      status: "CONNECTED",
      externalAccountId: pnid,
      verifiedAt: new Date(),
    },
  });
  integrationId = integ.id;

  const wf = await db.workflow.create({
    data: {
      workspaceId: w.id,
      name: `RD WF ${suffix}`,
      status: "PUBLISHED",
      nodes: {
        create: [
          {
            id: `rd-t-${suffix}`,
            kind: "trigger",
            type: "trigger.new_message",
            label: "New message",
            config: "{}",
            position: JSON.stringify({ x: 0, y: 0 }),
          },
          {
            id: `rd-a-${suffix}`,
            kind: "action",
            type: "action.add_tag",
            label: "Tag",
            config: JSON.stringify({ tag: "auto" }),
            position: JSON.stringify({ x: 0, y: 0 }),
          },
        ],
      },
      edges: {
        create: [
          {
            id: `rd-e-${suffix}`,
            sourceId: `rd-t-${suffix}`,
            targetId: `rd-a-${suffix}`,
            label: "",
            condition: "{}",
          },
        ],
      },
    },
  });
  wfId = wf.id;
});

describe("webhook 5xx-on-failure + redelivery", () => {
  it("answers 500 when dispatch fails, then processes the redelivery exactly once", async () => {
    // First delivery: message persists, dispatch blocked (demo) → 500.
    const r1 = await POST(postReq(payload()));
    expect(r1.status).toBe(500);
    expect(await messageCount()).toBe(1); // persistence already happened
    expect(await db.workflowExecution.count({ where: { workflowId: wfId } })).toBe(0);

    // The blocking condition clears; Meta redelivers (post-restart, so the
    // in-memory dedupe set is empty).
    await db.workspace.update({ where: { id: wsId }, data: { isDemo: false } });
    seenDeliveryIds.clear();

    const r2 = await POST(postReq(payload()));
    expect(r2.status).toBe(200);
    // Exactly-once end state: one message, one execution.
    expect(await messageCount()).toBe(1);
    const execs = await db.workflowExecution.findMany({ where: { workflowId: wfId } });
    expect(execs.length).toBe(1);
    expect(execs[0].idempotencyKey).toBe(`inbound:wamid:${wamid}:${wfId}`);
    // The execution payload names the account that received the event.
    expect(JSON.parse(execs[0].triggerEvent).integrationId).toBe(integrationId);

    // A further redelivery stays exactly-once and keeps answering 200.
    seenDeliveryIds.clear();
    const r3 = await POST(postReq(payload()));
    expect(r3.status).toBe(200);
    expect(await messageCount()).toBe(1);
    expect(await db.workflowExecution.count({ where: { workflowId: wfId } })).toBe(1);
  });
});
