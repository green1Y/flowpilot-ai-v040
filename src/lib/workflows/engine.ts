import { db } from "@/lib/db";
import { enqueue, type Job } from "@/lib/queue";
import { getAdapter, resolveWorkspaceAdapter } from "@/lib/integrations/providers";
import { MetaTokenExpiredError } from "@/lib/integrations/meta";
import { generateReply, buildSystemPrompt } from "@/lib/ai/providers";
import { retrieveKnowledge, chunkToSnippet } from "@/lib/ai/retrieval";
import { auditLog, trackUsage } from "@/lib/audit";
import { recordCustomerEvent } from "@/lib/events/record";
import { assertLiveSendAllowed } from "@/lib/demo/guard";
import { TRIGGER_EVENT_MAP } from "./nodeRegistry";

/**
 * Workflow execution engine.
 *
 * `executeWorkflow` is the entry point: idempotent enqueue of a run.
 * `processWorkflowJob` is the queue worker: walks the graph node by node,
 * records an ExecutionStep per visit, and dispatches actions honestly —
 * sends go through the real provider adapter when the workspace has a
 * verified CONNECTED integration, otherwise through the mock adapter labeled
 * `mocked: true`. Nothing is ever misrepresented as a real send.
 */

export interface ExecuteWorkflowOpts {
  workflowId: string;
  workspaceId: string;
  event: Record<string, unknown>;
  idempotencyKey: string;
  dryRun?: boolean;
}

export async function executeWorkflow(
  opts: ExecuteWorkflowOpts
): Promise<{ duplicate: boolean; executionId: string }> {
  const { workflowId, workspaceId, event, idempotencyKey, dryRun = false } = opts;

  // Demo-mode guard (public-beta readiness): a demo workspace (or
  // DEMO_MODE=true) cannot enqueue a real workflow run — 403 before any
  // provider call or queue enqueue. Dry-run executions are side-effect-free
  // (no adapter calls) and stay allowed; the per-action guards below cover
  // the execution path itself, including queue-worker retries.
  if (!dryRun) await assertLiveSendAllowed(workspaceId);

  // Duplicate prevention: one execution row per idempotency key.
  const existing = await db.workflowExecution.findUnique({ where: { idempotencyKey } });
  if (existing) return { duplicate: true, executionId: existing.id };

  const workflow = await db.workflow.findFirst({ where: { id: workflowId, workspaceId } });
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  if (workflow.status === "DRAFT" && !dryRun) {
    throw new Error("Cannot execute a DRAFT workflow — publish it first");
  }
  if (workflow.status === "PAUSED" && !dryRun) {
    throw new Error("Cannot execute a PAUSED workflow — resume it first");
  }

  // Batch B: stamp the execution with the exact connected account the
  // trigger event arrived on (inbound dispatch sets event.integrationId).
  // The account an action later resolves is backfilled by the worker when
  // the trigger carried none.
  const eventIntegrationId =
    typeof event?.integrationId === "string" && event.integrationId
      ? event.integrationId
      : null;

  let execution;
  try {
    execution = await db.workflowExecution.create({
      data: {
        workflowId: workflow.id,
        integrationId: eventIntegrationId,
        // Batch C: pin this run to the workflow's current version at
        // enqueue time — the worker executes that version's snapshot.
        workflowVersion: workflow.version,
        triggerEvent: JSON.stringify(event ?? {}),
        status: dryRun ? "DRY_RUN" : "QUEUED",
        idempotencyKey,
        dryRun,
      },
    });
  } catch (e) {
    // Race: a concurrent call with the same idempotency key won the create
    // between our findUnique above and this insert (unique constraint on
    // idempotencyKey). That is a duplicate, not an error — return the
    // winner's execution instead of throwing.
    if ((e as { code?: string } | null)?.code === "P2002") {
      const winner = await db.workflowExecution.findUnique({ where: { idempotencyKey } });
      if (winner) return { duplicate: true, executionId: winner.id };
    }
    throw e;
  }

  enqueue(
    "workflow_execution",
    { executionId: execution.id },
    { idempotencyKey: `wf:${idempotencyKey}`, maxAttempts: 3 }
  );

  // Phase 3A: unified event log. Dry runs (simulation) are NOT recorded —
  // they must never pollute real analytics.
  if (!dryRun) {
    await recordCustomerEvent({
      workspaceId,
      integrationId: eventIntegrationId,
      type: "workflow_executed",
      provider: "system",
      providerEventId: `wf-exec:${execution.id}`,
      source: "engine",
      attribution: { workflowId: workflow.id, idempotencyKey },
    });
  }

  return { duplicate: false, executionId: execution.id };
}

// ── Small helpers ────────────────────────────────────────────────────────

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function getStr(event: Record<string, unknown>, key: string): string {
  const v = event[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function getNum(event: Record<string, unknown>, key: string): number | null {
  const v = event[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function getArr(event: Record<string, unknown>, key: string): unknown[] {
  const v = event[key];
  return Array.isArray(v) ? v : [];
}

function lookupPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/** Render `{{path.to.value}}` placeholders from the event. */
export function renderTemplate(tpl: string, event: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const v = lookupPath(event, path);
    return v == null ? "" : String(v);
  });
}

// ── Condition evaluation ─────────────────────────────────────────────────

/**
 * Evaluate a condition / if_else node against the trigger event.
 * Exported for tests. `business_hours` is a mock (always true) — the step
 * output notes this so nobody mistakes it for a real schedule check.
 */
export function evaluateCondition(
  type: string,
  config: Record<string, unknown>,
  event: Record<string, unknown>
): boolean {
  const text = getStr(event, "text");
  switch (type) {
    case "condition.keyword_contains": {
      const kw = String(config.keyword ?? "");
      return kw.length > 0 && text.toLowerCase().includes(kw.toLowerCase());
    }
    case "condition.comment_matches": {
      const phrase = String(config.phrase ?? "").toLowerCase();
      const t = text.toLowerCase();
      return phrase.length > 0 && (t === phrase || t.includes(phrase));
    }
    case "condition.is_new_contact":
      return event.isNewContact === true;
    case "condition.has_tag": {
      const tag = String(config.tag ?? "");
      return tag.length > 0 && getArr(event, "tags").map(String).includes(tag);
    }
    case "condition.lead_score_gte": {
      const threshold = Number(config.score ?? 0);
      const score = getNum(event, "leadScore");
      return score !== null && score >= threshold;
    }
    case "condition.channel_is":
      return getStr(event, "channel") === String(config.channel ?? "");
    case "condition.ai_intent":
      return getStr(event, "intent").toLowerCase() === String(config.intent ?? "").toLowerCase();
    case "condition.business_hours":
      return true; // mock — see note above
    case "condition.qualification_rule":
      return event.qualified === true;
    case "flow.if_else":
      return evaluateIfElseExpression(String(config.expression ?? ""), event).result;
    default:
      return false;
  }
}

/**
 * Tiny expression DSL for `flow.if_else`: `field op value`
 * where op is one of: includes == != > >= < <=.
 * `field` is a dot-path into the event (the `event.` prefix is optional).
 * A bare field name evaluates its truthiness. Anything else → false + note.
 */
export function evaluateIfElseExpression(
  expression: string,
  event: Record<string, unknown>
): { result: boolean; note?: string } {
  const expr = expression.trim();
  const m = expr.match(/^(.+?)\s+(includes|==|!=|>=|<=|>|<)\s+(.+)$/);
  if (!m) {
    if (/^[A-Za-z_][\w.]*$/.test(expr)) {
      return { result: !!lookupPath(event, expr.replace(/^event\./, "")) };
    }
    return {
      result: false,
      note: `expression "${expression}" is not valid (expected "field op value", op ∈ includes == != > >= < <=) — evaluated as false`,
    };
  }
  const field = m[1].trim().replace(/^event\./, "");
  const op = m[2];
  let value: unknown = m[3].trim();
  const quoted = /^(["'])(.*)\1$/.exec(String(value));
  if (quoted) value = quoted[2];
  else if (/^-?\d+(\.\d+)?$/.test(String(value))) value = Number(value);
  else if (value === "true") value = true;
  else if (value === "false") value = false;

  const actual = lookupPath(event, field);
  const num = (v: unknown) => Number(v);
  const looseEq = (a: unknown, b: unknown) => a === b || String(a) === String(b);
  switch (op) {
    case "includes":
      return {
        result: String(actual ?? "").toLowerCase().includes(String(value).toLowerCase()),
      };
    case "==":
      return { result: looseEq(actual, value) };
    case "!=":
      return { result: !looseEq(actual, value) };
    case ">":
      return { result: num(actual) > num(value) };
    case ">=":
      return { result: num(actual) >= num(value) };
    case "<":
      return { result: num(actual) < num(value) };
    case "<=":
      return { result: num(actual) <= num(value) };
    default:
      return { result: false, note: `unsupported operator "${op}" — evaluated as false` };
  }
}

// ── Worker ───────────────────────────────────────────────────────────────

interface ParsedNode {
  id: string;
  kind: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  disabled: boolean;
}

interface ParsedEdge {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
}

interface NodeOutcome {
  output: Record<string, unknown>;
  next: string[];
  halt?: boolean;
  haltNote?: string;
  /** Set when the step itself failed terminally (recorded FAILED, no retry). */
  stepFailed?: string;
  /** Set to skip the step without error (recorded SKIPPED) — e.g. human takeover. */
  stepSkipped?: string;
}

const MAX_VISITS = 100;

/**
 * Queue job handler: run one workflow execution to completion.
 * Re-throws on node failure so the queue retries; on the final attempt the
 * execution is marked DEAD_LETTER.
 */
export async function processWorkflowJob(job: Job): Promise<void> {
  const executionId = job.payload.executionId as string;
  const execution = await db.workflowExecution.findUnique({
    where: { id: executionId },
    include: { workflow: { include: { nodes: true, edges: true } } },
  });
  if (!execution) throw new Error(`Workflow execution not found: ${executionId}`);
  // Destructure for nested closures: TS does not narrow captured variables
  // inside nested function declarations, so keep a non-nullable alias.
  const execId = execution.id;

  const workflow = execution.workflow;
  const workspaceId = workflow.workspaceId;
  const event = parseJson<Record<string, unknown>>(execution.triggerEvent, {});
  const eventType = getStr(event, "type");
  const dryRun = execution.dryRun;
  const maxAttempts = job.maxAttempts || 3;

  // Batch B: the account this execution is scoped to. Starts from the
  // stamped trigger account; when an action resolves an account and the
  // execution has none yet, it is backfilled (see noteResolvedAccount).
  let executionIntegrationId: string | null =
    execution.integrationId ??
    (typeof event.integrationId === "string" && event.integrationId
      ? event.integrationId
      : null);
  async function noteResolvedAccount(integrationId: string | null): Promise<void> {
    if (!integrationId || executionIntegrationId) return;
    executionIntegrationId = integrationId;
    await db.workflowExecution
      .update({ where: { id: execId }, data: { integrationId } })
      .catch(() => undefined);
  }

  /**
   * Batch B explicit account pinning for an action node: the node's own
   * configured account wins; otherwise the account the trigger event
   * arrived on (a reply must leave through the account that received the
   * message). Undefined = resolve by workspace default/single/ambiguous
   * rules — never an arbitrary first row.
   */
  function pinnedAccountId(cfg: Record<string, unknown>): string | undefined {
    const fromCfg = String(cfg.integrationId ?? "").trim();
    if (fromCfg) return fromCfg;
    const fromEvent = getStr(event, "integrationId");
    return fromEvent || undefined;
  }

  await db.workflowExecution.update({
    where: { id: execution.id },
    data: { status: "RUNNING", attempts: { increment: 1 } },
  });
  const attemptNumber = execution.attempts + 1;

  // Batch C — pinned execution: when this execution carries a
  // workflowVersion and an immutable WorkflowVersion snapshot exists for
  // it, execute THAT graph instead of the live workflow nodes/edges, so
  // editing a workflow after enqueue cannot change what this run does.
  // Fall back to the live graph only when no snapshot exists (legacy
  // executions created before versioning, or never-published dry runs).
  // Snapshot graph shape is the publish-time serialization (see publish
  // route): nodes { id, kind, type, label, config (parsed object),
  // position, disabled }, edges { id, sourceId, targetId, label,
  // condition } — mapped here into the same ParsedNode/ParsedEdge shape
  // the walker consumes for the live graph. `config` is also tolerated
  // as a raw JSON string for robustness.
  let nodes: ParsedNode[] | null = null;
  let edges: ParsedEdge[] | null = null;
  if (execution.workflowVersion != null) {
    const snapshot = await db.workflowVersion
      .findFirst({
        where: { workflowId: workflow.id, version: execution.workflowVersion },
      })
      .catch(() => null);
    if (snapshot) {
      try {
        const graph = JSON.parse(snapshot.graph) as {
          nodes?: Array<Record<string, unknown>>;
          edges?: Array<Record<string, unknown>>;
        };
        if (Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
          nodes = graph.nodes.map((n) => ({
            id: String(n.id),
            kind: String(n.kind),
            type: String(n.type),
            label: String(n.label ?? ""),
            config:
              typeof n.config === "string"
                ? parseJson<Record<string, unknown>>(n.config, {})
                : ((n.config as Record<string, unknown>) ?? {}),
            disabled: Boolean(n.disabled ?? false),
          }));
          edges = graph.edges.map((e) => ({
            id: String(e.id),
            sourceId: String(e.sourceId),
            targetId: String(e.targetId),
            label: String(e.label ?? ""),
          }));
        }
      } catch {
        // Corrupt snapshot JSON: fall through to the live graph rather
        // than failing a run that would otherwise have executed.
        nodes = null;
        edges = null;
      }
    }
  }
  if (!nodes || !edges) {
    nodes = workflow.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      type: n.type,
      label: n.label,
      config: parseJson<Record<string, unknown>>(n.config, {}),
      disabled: n.disabled ?? false,
    }));
    edges = workflow.edges.map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      label: e.label ?? "",
    }));
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, ParsedEdge[]>();
  for (const e of edges) {
    if (!outgoing.has(e.sourceId)) outgoing.set(e.sourceId, []);
    outgoing.get(e.sourceId)!.push(e);
  }
  const outOf = (id: string): ParsedEdge[] => outgoing.get(id) ?? [];

  let visits = 0;
  let halted = false;
  let haltNote = "";
  const executed = new Set<string>();
  const skipped = new Set<string>();
  const dedupeKeys = new Set<string>();

  async function recordStep(
    nodeId: string,
    nodeLabel: string,
    status: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>,
    error?: string
  ) {
    return db.executionStep.create({
      data: {
        executionId: execId,
        nodeId,
        nodeLabel,
        status,
        input: JSON.stringify(input),
        output: JSON.stringify(output),
        error: error ?? null,
      },
    });
  }

  /** Record SKIPPED steps for a branch whose condition evaluated false. */
  async function markBranchSkipped(startId: string): Promise<void> {
    const stack = [startId];
    while (stack.length) {
      const id = stack.pop()!;
      if (executed.has(id) || skipped.has(id)) continue;
      const node = byId.get(id);
      if (!node) continue;
      skipped.add(id);
      await recordStep(
        node.id,
        node.label,
        "SKIPPED",
        { event, config: node.config },
        { reason: "upstream condition evaluated to false" }
      );
      for (const e of outOf(id)) stack.push(e.targetId);
    }
  }

  function triggerMatches(node: ParsedNode): boolean {
    if (TRIGGER_EVENT_MAP[node.type] !== eventType) return false;
    const text = getStr(event, "text");
    switch (node.type) {
      case "trigger.keyword": {
        const kw = String(node.config.keyword ?? "");
        return kw.length > 0 && text.toLowerCase().includes(kw.toLowerCase());
      }
      case "trigger.tag_added": {
        const want = String(node.config.tag ?? "");
        const got = getStr(event, "tag");
        return want.length === 0 || got === want;
      }
      case "trigger.commerce_event": {
        const want = String(node.config.eventName ?? "");
        const got = getStr(event, "eventName");
        return want.length === 0 || got === want;
      }
      default:
        return true;
    }
  }

  async function runTrigger(node: ParsedNode): Promise<NodeOutcome> {
    const output: Record<string, unknown> = { matched: true, eventType };
    if (node.type === "trigger.keyword") output.keyword = String(node.config.keyword ?? "");
    return { output, next: outOf(node.id).map((e) => e.targetId) };
  }

  async function runCondition(node: ParsedNode): Promise<NodeOutcome> {
    const result = evaluateCondition(node.type, node.config, event);
    const outs = outOf(node.id);
    if (node.type === "flow.if_else") {
      const want = result ? "true" : "false";
      const branch =
        outs.find((e) => e.label.trim().toLowerCase() === want) ?? outs[0];
      const note =
        node.type === "flow.if_else"
          ? evaluateIfElseExpression(String(node.config.expression ?? ""), event).note
          : undefined;
      return {
        output: { result, expression: String(node.config.expression ?? ""), branch: branch?.label ?? null, ...(note ? { note } : {}) },
        next: branch ? [branch.targetId] : [],
      };
    }
    if (!result) {
      for (const e of outs) await markBranchSkipped(e.targetId);
      const output: Record<string, unknown> = { result: false, skippedBranches: outs.length };
      if (node.type === "condition.business_hours") {
        output.note = "business_hours is a mock check (always true in this build)";
      }
      return { output, next: [] };
    }
    return { output: { result: true }, next: outs.map((e) => e.targetId) };
  }

  async function runFlow(node: ParsedNode): Promise<NodeOutcome> {
    const next = outOf(node.id).map((e) => e.targetId);
    switch (node.type) {
      case "flow.delay":
      case "flow.retry":
      case "flow.timeout":
      case "flow.error_branch":
        return { output: { ...node.config, dryRun }, next };
      case "flow.dedupe": {
        const key = renderTemplate(String(node.config.key ?? ""), event);
        if (dedupeKeys.has(key)) {
          return { output: { key, duplicate: true, note: "key already seen in this run — branch skipped" }, next: [] };
        }
        dedupeKeys.add(key);
        return { output: { key, duplicate: false }, next };
      }
      default:
        return { output: {}, next: [] }; // flow.end and unknown flow nodes stop the branch
    }
  }

  async function findContact(contactId: string) {
    return db.contact.findFirst({ where: { id: contactId, workspaceId } });
  }

  async function findConversation(conversationId: string) {
    return db.conversation.findFirst({ where: { id: conversationId, workspaceId } });
  }

  async function requireConnectedIntegration(provider: string, integrationId?: string) {
    if (integrationId) {
      // Pinned account: only THAT account satisfies the requirement —
      // another connected account of the same provider does not.
      return db.integration.findFirst({
        where: { id: integrationId, workspaceId, provider, status: "CONNECTED" },
      });
    }
    return db.integration.findFirst({ where: { workspaceId, provider, status: "CONNECTED" } });
  }

  /**
   * Newest inbound message timestamp from a recipient (matched by stable
   * external id, tolerating the "wa:" prefix). Used for WhatsApp's 24-hour
   * customer-service window. Returns null when unknown — the adapter then
   * requires a template instead of risking an out-of-window free-form send.
   */
  async function getLastInboundAt(recipient: string): Promise<Date | null> {
    try {
      const norm = recipient.replace(/^wa:/, "");
      const contacts = await db.contact.findMany({ where: { workspaceId } });
      const ids: string[] = [];
      for (const c of contacts) {
        const ext = parseJson<Record<string, string>>(c.externalIds, {});
        const hit = Object.values(ext).some(
          (v) => v === recipient || String(v).replace(/^wa:/, "") === norm
        );
        if (hit) ids.push(c.id);
      }
      if (ids.length === 0) return null;
      const msg = await db.message.findFirst({
        where: { direction: "INBOUND", conversation: { workspaceId, contactId: { in: ids } } },
        orderBy: { createdAt: "desc" },
      });
      return msg?.createdAt ?? null;
    } catch {
      return null;
    }
  }

  async function runAction(node: ParsedNode): Promise<NodeOutcome> {
    const cfg = node.config;
    const next = outOf(node.id).map((e) => e.targetId);
    const dryNote = "skipped in dry-run — no side effects performed";

    /**
     * Stage 4a human takeover: when the event targets a conversation where a
     * human has taken over, every auto-response action on that conversation is
     * paused. The step is recorded SKIPPED (not FAILED) with an honest reason,
     * and no message is created or sent.
     */
    async function takeoverSkip(conversationId: string): Promise<NodeOutcome | null> {
      if (!conversationId) return null;
      const convo = await db.conversation.findFirst({
        where: { id: conversationId, workspaceId },
        select: { humanTakeover: true },
      });
      if (!convo?.humanTakeover) return null;
      return {
        output: { conversationId, mocked: true, note: "no message created or sent" },
        next,
        stepSkipped: "human takeover active — AI paused",
      };
    }

    switch (node.type) {
      case "action.send_message":
      case "action.reply_comment": {
        const channel =
          node.type === "action.send_message" ? String(cfg.channel ?? "webchat") : getStr(event, "channel") || "webchat";
        const body = renderTemplate(String(cfg.body ?? ""), event);
        const to = getStr(event, "from") || "unknown";
        if (dryRun) {
          return { output: { mocked: true, dryRun: true, channel, to, body, note: dryNote }, next };
        }
        // Demo-mode: real sends are blocked server-side for demo workspaces
        // (or DEMO_MODE=true). Dry-run rehearsals above stay allowed.
        await assertLiveSendAllowed(workspaceId);
        // Stage 4a: human takeover pauses auto-responses on this conversation.
        const takeover = await takeoverSkip(getStr(event, "conversationId"));
        if (takeover) return takeover;
        // Real adapter when the workspace has a verified CONNECTED integration
        // for this provider; honest mock otherwise. Batch B: a node-pinned
        // (or trigger-carried) account is resolved strictly — resolution
        // failure fails the step honestly instead of re-routing the send
        // through a different account.
        const resolved = await resolveWorkspaceAdapter(workspaceId, channel, {
          getLastInboundAt,
          integrationId: pinnedAccountId(cfg),
        });
        const adapter = resolved.adapter;
        await noteResolvedAccount(resolved.integrationId);
        let note: string | undefined;
        let result;
        try {
          if (node.type === "action.reply_comment") {
            const commentId = getStr(event, "commentId");
            const eligible = event.commentEligible !== false;
            if (adapter.replyToComment && commentId && eligible) {
              result = await adapter.replyToComment({ commentId, body });
            } else {
              result = await adapter.sendMessage({ to, body });
              note = !commentId
                ? "no commentId on event — sent as regular message"
                : !eligible
                  ? "comment not eligible for private reply — sent as regular message"
                  : "adapter has no private-reply path — sent as regular message";
            }
          } else {
            const templateName =
              channel === "whatsapp" ? String(cfg.templateName ?? "") || undefined : undefined;
            result = await adapter.sendMessage({ to, body, templateName });
          }
        } catch (e) {
          if (e instanceof MetaTokenExpiredError) {
            // Scope the attention flag to the account that actually
            // failed — never to every account of the provider.
            await db.integration.updateMany({
              where: resolved.integrationId
                ? { id: resolved.integrationId }
                : { workspaceId, provider: channel },
              data: { status: "NEEDS_ATTENTION" },
            });
          }
          throw e;
        }
        if (!result.ok) throw new Error(`${node.type} failed via ${channel}: ${result.error ?? "unknown error"}`);
        // Keep a visible copy on the conversation when we have one.
        const conversationId = getStr(event, "conversationId");
        if (conversationId && (await findConversation(conversationId))) {
          await db.message.create({
            data: {
              conversationId,
              direction: "OUTBOUND",
              body,
              aiGenerated: false,
              mocked: result.mocked,
              providerMessageId: result.externalId ?? null,
            },
          });
        }
        return {
          output: {
            mocked: result.mocked,
            externalId: result.externalId,
            channel,
            to,
            integrationId: resolved.integrationId,
            ...(note ? { note } : {}),
          },
          next,
        };
      }

      case "action.ai_reply": {
        if (dryRun) {
          return { output: { mocked: true, dryRun: true, note: dryNote }, next };
        }
        // Stage 4a: human takeover pauses the AI reply for this conversation.
        const aiTakeover = await takeoverSkip(getStr(event, "conversationId"));
        if (aiTakeover) return aiTakeover;
        const aiCfg = await db.aiConfig.findUnique({ where: { workspaceId } }).catch(() => null);
        const threshold = Number(aiCfg?.confidenceThreshold ?? cfg.confidenceThreshold ?? 0.7);
        const systemPrompt = buildSystemPrompt({
          assistantName: aiCfg?.assistantName ?? "FlowPilot Assistant",
          businessName: aiCfg?.businessName ?? "",
          businessDescription: aiCfg?.businessDescription ?? "",
          brandVoice: aiCfg?.brandVoice ?? "friendly",
          tone: aiCfg?.tone ?? "professional",
          responseLength: aiCfg?.responseLength ?? "concise",
          fallbackResponse: aiCfg?.fallbackResponse ?? "Thanks for reaching out! A team member will get back to you shortly.",
          prohibitedTopics: parseJson<string[]>(aiCfg?.prohibitedTopics ?? null, []),
        });
        // Stage 4c: ground the reply in the workspace's knowledge base.
        const userMessage = getStr(event, "text");
        const retrieved = await retrieveKnowledge(workspaceId, userMessage, 4);
        const sourcesUsed = [...new Set(retrieved.map((r) => r.docTitle))];
        const reply = await generateReply({
          systemPrompt,
          userMessage,
          knowledgeSnippets: retrieved.map(chunkToSnippet),
          tone: aiCfg?.tone ?? "professional",
          responseLength: aiCfg?.responseLength ?? "concise",
        });
        const conversationId = getStr(event, "conversationId");
        const conversation = conversationId ? await findConversation(conversationId) : null;
        // Stage 4c escalation (additive — no existing approval flow is changed):
        // never auto-send a reply the AI isn't confident about, or one the
        // workspace wants a human to approve. Instead, queue it for review.
        const belowThreshold = reply.confidence < threshold;
        const approvalRequired = aiCfg?.requireApproval ?? false;
        if (belowThreshold || approvalRequired) {
          const reason = belowThreshold
            ? `low confidence ${reply.confidence.toFixed(2)} < ${threshold.toFixed(2)}`
            : "human approval required";
          const contactId = getStr(event, "contactId");
          const escalation = await db.escalation.create({
            data: {
              workspaceId,
              conversationId: conversation ? conversation.id : null,
              contactId: contactId && (await findContact(contactId)) ? contactId : null,
              reason,
            },
          });
          await auditLog(workspaceId, null, "ai.escalated", {
            type: "escalation",
            id: escalation.id,
            reason,
            ...(conversation ? { conversationId: conversation.id } : {}),
          });
          return {
            output: {
              mocked: true,
              text: reply.text,
              confidence: reply.confidence,
              threshold,
              belowThreshold,
              sourcesUsed,
              escalationId: escalation.id,
              note: "reply held for human review — no message created or sent",
            },
            next,
            stepSkipped: `AI reply escalated: ${reason}`,
          };
        }
        if (conversation) {
          await db.message.create({
            data: { conversationId: conversation.id, direction: "OUTBOUND", body: reply.text, aiGenerated: true, mocked: reply.mocked },
          });
        }
        return {
          output: {
            mocked: reply.mocked,
            text: reply.text,
            confidence: reply.confidence,
            threshold,
            belowThreshold,
            sourcesUsed,
            // Batch B attribution: the account this reply belongs to —
            // the node's pinned account, else the conversation's account,
            // else the trigger event's account. (ai_reply writes onto the
            // conversation directly; no adapter is resolved.)
            integrationId:
              String(cfg.integrationId ?? "").trim() ||
              conversation?.integrationId ||
              getStr(event, "integrationId") ||
              null,
          },
          next,
        };
      }

      case "action.add_tag": {
        const tag = String(cfg.tag ?? "");
        const contactId = getStr(event, "contactId");
        if (dryRun) return { output: { mocked: true, dryRun: true, tag, note: dryNote }, next };
        const contact = contactId ? await findContact(contactId) : null;
        if (!contact) return { output: { tag, skipped: true, note: "no contact on event — tag not applied" }, next };
        const tags = parseJson<string[]>(contact.tags, []);
        if (!tags.includes(tag)) {
          tags.push(tag);
          await db.contact.update({ where: { id: contact.id }, data: { tags: JSON.stringify(tags) } });
        }
        return { output: { tag, contactId: contact.id, applied: true }, next };
      }

      case "action.create_lead": {
        const name = renderTemplate(String(cfg.name ?? "New Lead"), event);
        if (dryRun) return { output: { mocked: true, dryRun: true, name, note: dryNote }, next };
        const lead = await db.contact.create({
          data: { workspaceId, name, channel: getStr(event, "channel") || "web", leadStatus: "NEW" },
        });
        return { output: { contactId: lead.id, name }, next };
      }

      case "action.internal_note": {
        const note = renderTemplate(String(cfg.note ?? ""), event);
        const conversationId = getStr(event, "conversationId");
        if (dryRun) return { output: { mocked: true, dryRun: true, note: dryNote }, next };
        if (!conversationId || !(await findConversation(conversationId))) {
          return { output: { skipped: true, note: "no conversation on event — note not saved" }, next };
        }
        const msg = await db.message.create({
          data: { conversationId, direction: "INTERNAL_NOTE", body: note, aiGenerated: false, mocked: true },
        });
        return { output: { messageId: msg.id }, next };
      }

      case "action.assign_conversation": {
        const assignee = String(cfg.assignee ?? "");
        const conversationId = getStr(event, "conversationId");
        if (dryRun) return { output: { mocked: true, dryRun: true, assignee, note: dryNote }, next };
        if (!conversationId || !(await findConversation(conversationId))) {
          return { output: { skipped: true, note: "no conversation on event — not assigned" }, next };
        }
        await db.conversation.updateMany({ where: { id: conversationId, workspaceId }, data: { assignedTo: assignee } });
        return { output: { conversationId, assignee }, next };
      }

      case "action.update_crm_field": {
        const field = String(cfg.field ?? "");
        const value = renderTemplate(String(cfg.value ?? ""), event);
        const contactId = getStr(event, "contactId");
        if (dryRun) return { output: { mocked: true, dryRun: true, field, value, note: dryNote }, next };
        const contact = contactId ? await findContact(contactId) : null;
        if (!contact) return { output: { skipped: true, note: "no contact on event — field not updated" }, next };
        const customFields = parseJson<Record<string, string>>(contact.customFields, {});
        customFields[field] = value;
        await db.contact.update({ where: { id: contact.id }, data: { customFields: JSON.stringify(customFields) } });
        return { output: { contactId: contact.id, field, value }, next };
      }

      case "action.wait": {
        const seconds = Number(cfg.seconds ?? 0);
        return { output: { delayed: seconds, note: dryRun ? "skipped in dry-run" : "scheduled" }, next };
      }

      case "action.send_email": {
        const to = renderTemplate(String(cfg.to ?? ""), event);
        const subject = renderTemplate(String(cfg.subject ?? ""), event);
        const body = renderTemplate(String(cfg.body ?? ""), event);
        if (dryRun) return { output: { mocked: true, dryRun: true, to, subject, note: dryNote }, next };
        // Demo-mode: real email sends are blocked server-side for demo
        // workspaces (or DEMO_MODE=true). Dry-run rehearsals above stay allowed.
        await assertLiveSendAllowed(workspaceId);
        const integration = await requireConnectedIntegration("email", pinnedAccountId(cfg));
        if (!integration) {
          const approval = await db.approvalRequest.create({
            data: {
              workspaceId,
              executionId: execId,
              action: JSON.stringify({ type: "action.send_email", to, subject, body, reason: "email provider not connected" }),
              status: "PENDING",
            },
          });
          // Honest failure, no fake send — and no retry storm: approval is
          // requested once and this branch stops here.
          return {
            output: { approvalRequestId: approval.id },
            next: [],
            stepFailed: "requires connected provider — approval requested",
          };
        }
        const adapter = getAdapter("email");
        const result = await adapter.sendMessage({ to, body: `Subject: ${subject}\n\n${body}` });
        if (!result.ok) throw new Error(`send_email failed: ${result.error ?? "unknown error"}`);
        await noteResolvedAccount(integration.id);
        return { output: { mocked: result.mocked, externalId: result.externalId, to, subject, integrationId: integration.id }, next };
      }

      case "action.send_whatsapp_template": {
        const templateName = String(cfg.templateName ?? "");
        const params = (Array.isArray(cfg.params) ? cfg.params : []).map((p) => renderTemplate(String(p), event));
        const to = getStr(event, "from") || "unknown";
        if (dryRun) return { output: { mocked: true, dryRun: true, templateName, params, note: dryNote }, next };
        // Demo-mode: real WhatsApp sends are blocked server-side for demo
        // workspaces (or DEMO_MODE=true). Dry-run rehearsals above stay allowed.
        await assertLiveSendAllowed(workspaceId);
        const integration = await requireConnectedIntegration("whatsapp", pinnedAccountId(cfg));
        if (!integration) {
          const approval = await db.approvalRequest.create({
            data: {
              workspaceId,
              executionId: execId,
              action: JSON.stringify({ type: "action.send_whatsapp_template", templateName, params, to, reason: "whatsapp provider not connected" }),
              status: "PENDING",
            },
          });
          // Honest failure, no fake send — and no retry storm: the approval is
          // requested once, the step is recorded FAILED, and this branch stops.
          return {
            output: { approvalRequestId: approval.id },
            next: [],
            stepFailed: "requires connected provider — approval requested",
          };
        }
        // Batch B: when the node (or trigger) pins an account, the send
        // goes through THAT account; otherwise the resolver applies the
        // default/single/ambiguous rules. The CONNECTED gate above has
        // already confirmed the pinned account specifically.
        const pin = pinnedAccountId(cfg);
        const resolved = await resolveWorkspaceAdapter(workspaceId, "whatsapp", {
          getLastInboundAt,
          integrationId: pin,
        });
        const adapter = resolved.adapter;
        await noteResolvedAccount(resolved.integrationId);
        const result = await adapter.sendMessage({ to, body: `[template:${templateName}] ${params.join(" | ")}`, templateName });
        if (!result.ok) throw new Error(`send_whatsapp_template failed: ${result.error ?? "unknown error"}`);
        return { output: { mocked: result.mocked, externalId: result.externalId, templateName, to, integrationId: resolved.integrationId }, next };
      }

      case "action.call_webhook": {
        const url = String(cfg.url ?? "");
        // Never actually fetch — honest simulation.
        return { output: { mocked: true, url, note: "webhook call simulated — no external request made" }, next };
      }

      case "action.notify_team": {
        const message = renderTemplate(String(cfg.message ?? ""), event);
        if (!dryRun) {
          await auditLog(workspaceId, null, "workflow.notify_team", {
            executionId: execId,
            workflowId: workflow.id,
            message,
          });
        }
        return { output: { notified: !dryRun, message, ...(dryRun ? { note: dryNote } : {}) }, next };
      }

      case "action.request_approval": {
        const instructions = renderTemplate(String(cfg.instructions ?? ""), event);
        if (dryRun) {
          return {
            output: { mocked: true, dryRun: true, note: "would request approval — skipped in dry-run" },
            next: [],
            halt: true,
            haltNote: "dry-run stopped at request_approval",
          };
        }
        const approval = await db.approvalRequest.create({
          data: {
            workspaceId,
            executionId: execId,
            action: JSON.stringify({ type: "action.request_approval", instructions }),
            status: "PENDING",
          },
        });
        return {
          output: { approvalRequestId: approval.id, status: "PENDING" },
          next: [],
          halt: true,
          haltNote: `stopped — approval requested (${approval.id})`,
        };
      }

      case "action.end":
      default:
        return { output: { note: node.type === "action.end" ? "branch ended" : `unknown action "${node.type}" — treated as end` }, next: [] };
    }
  }

  async function visit(nodeId: string): Promise<void> {
    if (halted) return;
    if (++visits > MAX_VISITS) {
      throw new Error(`Workflow exceeded ${MAX_VISITS} node visits — possible cycle`);
    }
    const node = byId.get(nodeId);
    if (!node) return;
    // Disabled nodes (builder toggle): record an honest SKIPPED step and
    // continue the branch — the step's effect never runs.
    if (node.disabled) {
      await recordStep(
        node.id,
        node.label,
        "SKIPPED",
        { event, config: node.config },
        { reason: "node disabled in the builder — step skipped, flow continues" }
      );
      executed.add(node.id);
      for (const e of outOf(nodeId)) await visit(e.targetId);
      return;
    }
    const step = await recordStep(
      node.id,
      node.label,
      "RUNNING",
      { event, config: node.config },
      {}
    );
    try {
      let outcome: NodeOutcome;
      if (node.kind === "trigger") outcome = await runTrigger(node);
      else if (node.kind === "condition" || node.type === "flow.if_else") outcome = await runCondition(node);
      else if (node.kind === "flow") outcome = await runFlow(node);
      else outcome = await runAction(node);

      await db.executionStep.update({
        where: { id: step.id },
        data: outcome.stepFailed
          ? { status: "FAILED", error: outcome.stepFailed, output: JSON.stringify(outcome.output) }
          : outcome.stepSkipped
            ? {
                status: "SKIPPED",
                output: JSON.stringify({ reason: outcome.stepSkipped, ...outcome.output }),
              }
            : { status: "SUCCEEDED", output: JSON.stringify(outcome.output) },
      });
      executed.add(node.id);
      if (outcome.halt) {
        halted = true;
        haltNote = outcome.haltNote ?? "halted";
        return;
      }
      for (const nextId of outcome.next) await visit(nextId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await db.executionStep.update({
        where: { id: step.id },
        data: { status: "FAILED", error: message },
      });
      throw e;
    }
  }

  try {
    const triggers = nodes.filter((n) => n.kind === "trigger" && triggerMatches(n));
    if (triggers.length === 0) {
      // No trigger matched: record why in the log instead of succeeding silently.
      const firstTrigger = nodes.find((n) => n.kind === "trigger");
      await recordStep(
        firstTrigger?.id ?? "trigger",
        firstTrigger?.label ?? "Trigger",
        "SKIPPED",
        { event },
        {
          reason: "no trigger matched this event — workflow did not run",
          eventType,
          hint: "trigger.new_message expects event.type to be 'new_message'",
        }
      );
    }
    for (const t of triggers) {
      if (halted) break;
      await visit(t.id);
    }

    await db.workflowExecution.update({
      where: { id: execution.id },
      data: {
        status: dryRun ? "DRY_RUN" : "SUCCEEDED",
        finishedAt: new Date(),
        error: haltNote || null,
      },
    });
    await trackUsage(workspaceId, "workflow_runs");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const finalAttempt = attemptNumber >= maxAttempts;
    await db.workflowExecution.update({
      where: { id: execution.id },
      data: {
        status: finalAttempt ? "DEAD_LETTER" : "FAILED",
        error: message,
        finishedAt: finalAttempt ? new Date() : null,
      },
    });
    throw e; // let the queue retry / dead-letter the job
  }
}
