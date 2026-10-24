import { db } from "./db";

/** Append an audit event. Never throws — audit must not break the request path. */
export async function auditLog(
  workspaceId: string,
  actorId: string | null,
  action: string,
  entity: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: { workspaceId, actorId, action, entity: JSON.stringify(entity) },
    });
  } catch (e) {
    console.error("[audit] failed to write audit event", e);
  }
}

// Legacy metric names → aggregated usage counters. Never throws —
// recordUsage() itself swallows errors so metering can't break callers.
const METRIC_TO_COUNTER: Record<string, "messagesSent" | "messagesReceived" | "workflowsRun" | "automationsRun" | "apiCalls"> = {
  messages_sent: "messagesSent",
  messages_received: "messagesReceived",
  workflow_runs: "workflowsRun",
  automations_run: "automationsRun",
  api_calls: "apiCalls",
};

export async function trackUsage(workspaceId: string, metric: string, quantity = 1) {
  const counter = METRIC_TO_COUNTER[metric];
  if (!counter) {
    console.warn(`[usage] unknown metric "${metric}" — not recorded`);
    return;
  }
  const { recordUsage } = await import("./billing/usage");
  await recordUsage(workspaceId, { [counter]: quantity });
}
