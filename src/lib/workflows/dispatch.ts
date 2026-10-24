/**
 * Inbound → workflow dispatch (Batch A, audit §7 item 5).
 *
 * After a Meta webhook event is ingested (message or comment, any Meta
 * channel), PUBLISHED workflows in the same workspace whose trigger matches
 * the event are executed via the existing engine. This is the missing link
 * that made automations fire only from the manual execute route.
 *
 * Safety properties:
 *  - Execution idempotency key is derived from the provider event id +
 *    workflow id, so a Meta redelivery can never dispatch twice (the engine
 *    dedupes on WorkflowExecution.idempotencyKey; durable CustomerEvent
 *    dedupe in ingest normally stops redeliveries even earlier).
 *  - Keyword triggers fire only when the keyword actually matches the text.
 *  - A `condition.channel_is` gate sitting between the trigger and the rest
 *    of the graph (reachable through flow nodes only) restricts the
 *    workflow to that channel — a WhatsApp event never fires a workflow
 *    gated to Instagram.
 *  - Human takeover and demo-mode blocking are enforced inside the engine
 *    (takeoverSkip / assertLiveSendAllowed) — dispatch is a real trigger
 *    (dryRun stays false) and relies on those guards.
 *  - Dispatch never throws to the caller, but it REPORTS failures in its
 *    result: the webhook route turns a failed dispatch into a 5xx so Meta
 *    redelivers (safe — the execution idempotency key prevents a duplicate
 *    run, and ingest retries dispatch on redelivery even when the message
 *    itself was already persisted).
 */

import { db } from "@/lib/db";
import { executeWorkflow } from "./engine";
import { TRIGGER_EVENT_MAP } from "./nodeRegistry";

export interface InboundDispatchInput {
  kind: "message" | "comment";
  /** Provider/channel the event arrived on: instagram | facebook | whatsapp. */
  channel: string;
  /**
   * The Integration row that actually received this event (matched by the
   * webhook router). Carried into the execution's triggerEvent AND stamped
   * on WorkflowExecution.integrationId (Batch B) so runs are attributable
   * to the exact connected account — never resolved by "first account in
   * a query".
   */
  integrationId: string;
  contactId: string;
  conversationId: string;
  /** Sender's provider-scoped id (PSID / IGSID / phone) — the engine's `event.from`. */
  from: string;
  name?: string;
  text?: string;
  /** Stable provider event id (e.g. "mid:…", "wamid:…", "comment:…"). */
  providerEventId: string;
  /** True when this event opened the conversation (enables new_conversation triggers). */
  conversationCreated?: boolean;
  commentId?: string;
  postId?: string;
}

interface DispatchNode {
  id: string;
  kind: string;
  type: string;
  config: Record<string, unknown>;
  disabled: boolean;
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Walk downstream from a trigger through flow nodes only. If a
 * `condition.channel_is` gate is found before any action/other condition,
 * the workflow only fires for that channel. Returns false when gated out.
 */
function channelGatePasses(
  nodes: DispatchNode[],
  edges: { sourceId: string; targetId: string }[],
  triggerId: string,
  channel: string
): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    if (!outgoing.has(e.sourceId)) outgoing.set(e.sourceId, []);
    outgoing.get(e.sourceId)!.push(e.targetId);
  }
  const seen = new Set<string>([triggerId]);
  const queue = [triggerId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const targetId of outgoing.get(id) ?? []) {
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      const node = byId.get(targetId);
      if (!node || node.disabled) continue;
      if (node.type === "condition.channel_is") {
        const want = String(node.config.channel ?? "");
        if (want && want !== channel) return false;
        continue; // gates are not traversed past — deeper ones are branch-local
      }
      if (node.kind === "flow") queue.push(targetId);
      // Actions and other conditions end the gate search on this path.
    }
  }
  return true;
}

export interface DispatchResult {
  /** Workflows newly executed (duplicates excluded). */
  dispatched: number;
  /** Workflows whose dispatch attempt failed (transient or policy block). */
  failed: number;
}

/**
 * Dispatch an ingested inbound event to matching PUBLISHED workflows.
 * Never throws; failures are counted in the result so the webhook layer
 * can answer 5xx and let Meta redeliver.
 */
export async function dispatchInboundWorkflows(
  workspaceId: string,
  input: InboundDispatchInput
): Promise<DispatchResult> {
  const eventTypes: string[] =
    input.kind === "comment"
      ? ["new_comment"]
      : input.conversationCreated
        ? ["new_message", "new_conversation"]
        : ["new_message"];

  let dispatched = 0;
  let failed = 0;
  try {
    const workflows = await db.workflow.findMany({
      where: { workspaceId, status: "PUBLISHED" },
      include: { nodes: true, edges: true },
    });

    for (const wf of workflows) {
      try {
        const nodes: DispatchNode[] = wf.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          type: n.type,
          config: parseConfig(n.config),
          disabled: n.disabled,
        }));
        const triggers = nodes.filter((n) => n.kind === "trigger" && !n.disabled);

        for (const trigger of triggers) {
          const expected = TRIGGER_EVENT_MAP[trigger.type];
          if (!expected || !eventTypes.includes(expected)) continue;

          // Keyword triggers fire only on an actual keyword match.
          if (trigger.type === "trigger.keyword") {
            const kw = String(trigger.config.keyword ?? "").trim();
            const text = input.text ?? "";
            if (!kw || !text.toLowerCase().includes(kw.toLowerCase())) continue;
          }

          if (!channelGatePasses(nodes, wf.edges, trigger.id, input.channel)) continue;

          const event: Record<string, unknown> = {
            type: expected,
            channel: input.channel,
            integrationId: input.integrationId,
            from: input.from,
            name: input.name ?? "",
            text: input.text ?? "",
            contactId: input.contactId,
            conversationId: input.conversationId,
            ...(input.commentId ? { commentId: input.commentId } : {}),
            ...(input.postId ? { postId: input.postId } : {}),
          };

          const res = await executeWorkflow({
            workflowId: wf.id,
            workspaceId,
            event,
            idempotencyKey: `inbound:${input.providerEventId}:${wf.id}`,
          });
          if (!res.duplicate) dispatched += 1;
          // One execution per workflow per event — further matching
          // triggers dedupe on the same key anyway; stop early.
          break;
        }
      } catch (e) {
        // Includes the demo-mode 403 Response from the engine guard.
        // Counted (not swallowed): the webhook answers 5xx so Meta
        // redelivers, and the idempotency key makes the retry safe.
        failed += 1;
        console.error(
          "[dispatch] workflow dispatch failed",
          { workspaceId, workflowId: wf.id },
          e instanceof Error ? e.message : e
        );
      }
    }
  } catch (e) {
    console.error("[dispatch] failed to load workflows", e);
    failed += 1;
  }
  return { dispatched, failed };
}
