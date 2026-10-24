import { db } from "@/lib/db";
import { TRIGGER_EVENT_MAP, SUPPORTED_CHANNELS } from "./nodeRegistry";
import { validateWorkflow } from "./validate";
import { evaluateCondition, evaluateIfElseExpression, renderTemplate } from "./engine";
import { PROVIDERS } from "@/lib/integrations/providers";

/**
 * Workflow simulation mode.
 *
 * `simulateWorkflow` loads a workflow's graph, validates it, and walks the
 * graph against a sample event WITHOUT executing any side effects:
 *
 *   - NEVER calls provider adapters (`getAdapter` / `getWorkspaceAdapter`
 *     are never referenced here — capability checks use the static PROVIDERS
 *     list only).
 *   - NEVER enqueues queue jobs, calls the AI, or writes to the database
 *     (reads only: the workflow graph + integration statuses for the
 *     "missing credentials" check).
 *   - Condition evaluation reuses the engine's pure functions
 *     (`evaluateCondition`, `evaluateIfElseExpression`) and template
 *     previews reuse `renderTemplate` — no duplicated logic.
 *
 * How this differs from `executeWorkflow({ dryRun: true })`:
 *   - dryRun goes through the real queue: it creates a WorkflowExecution
 *     row (status DRY_RUN), records ExecutionStep rows, enqueues a job that
 *     the worker picks up asynchronously, and calls trackUsage
 *     ("workflow_runs"). Simulation is fully synchronous and in-memory —
 *     zero rows, zero jobs, zero usage counters.
 *   - dryRun refuses DRAFT workflows only via the execute gate... actually
 *     dryRun is allowed on DRAFT, but simulation has no status gate at all:
 *     drafts simulate fine.
 *   - dryRun replays the engine's branch logic but reports nothing about
 *     what *would* happen beyond step outputs; simulation produces a
 *     per-node "would do" description with rendered template previews,
 *     a would-be message list, and validation errors/warnings folded in.
 */

export type SimOutcome = "matched" | "skipped" | "would_execute" | "validation_error";

export interface SimStep {
  nodeId: string;
  nodeType: string;
  label: string;
  outcome: SimOutcome;
  detail: string;
}

export interface SimMessage {
  channel: string;
  to: string;
  bodyPreview: string;
}

export interface SimIssue {
  nodeId?: string;
  code: string;
  message: string;
}

export interface SimulationResult {
  workflowId: string;
  workflowName: string;
  matched: boolean;
  path: SimStep[];
  wouldSend: boolean;
  messages: SimMessage[];
  errors: SimIssue[];
  warnings: SimIssue[];
  note: string;
}

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

const MAX_VISITS = 100;

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

/**
 * Trigger matching — mirrors the engine's `triggerMatches` (which lives in
 * a closure inside `processWorkflowJob` and is not exported). Kept identical
 * to the engine so simulation predicts real runs.
 */
function triggerMatchesEvent(type: string, config: Record<string, unknown>, event: Record<string, unknown>): boolean {
  const want = TRIGGER_EVENT_MAP[type];
  if (!want) return false;
  if (want !== getStr(event, "type")) return false;
  const text = getStr(event, "text");
  switch (type) {
    case "trigger.keyword": {
      const kw = String(config.keyword ?? "");
      return kw.length > 0 && text.toLowerCase().includes(kw.toLowerCase());
    }
    case "trigger.tag_added": {
      const wantTag = String(config.tag ?? "");
      const gotTag = getStr(event, "tag");
      return wantTag.length === 0 || gotTag === wantTag;
    }
    case "trigger.commerce_event": {
      const wantName = String(config.eventName ?? "");
      const gotName = getStr(event, "eventName");
      return wantName.length === 0 || gotName === wantName;
    }
    default:
      return true;
  }
}

function providerCapabilities(provider: string): string[] {
  return PROVIDERS.find((p) => p.provider === provider)?.capabilities ?? [];
}

function isSupportedChannel(channel: string): boolean {
  return (SUPPORTED_CHANNELS as readonly string[]).includes(channel);
}

/**
 * Static check for provably contradictory or redundant condition chains:
 * two conditions on the same must-be-true path that cannot both hold
 * (e.g. `channel_is instagram` followed by `channel_is facebook`), or
 * duplicates that add nothing. Only flags pairs with well-defined
 * contradiction semantics.
 */
function detectConflictingConditions(nodes: ParsedNode[], edges: ParsedEdge[]): SimIssue[] {
  const issues: SimIssue[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, ParsedEdge[]>();
  for (const e of edges) {
    if (!outgoing.has(e.sourceId)) outgoing.set(e.sourceId, []);
    outgoing.get(e.sourceId)!.push(e);
  }

  // Collect linear "must be true" condition chains from each trigger.
  const chains: ParsedNode[][] = [];
  const triggers = nodes.filter((n) => n.kind === "trigger");
  for (const t of triggers) {
    const walk = (id: string, chain: ParsedNode[], seen: Set<string>) => {
      if (seen.has(id)) return;
      seen.add(id);
      const node = byId.get(id);
      if (!node) return;
      const next = chain.concat(node.kind === "condition" ? [node] : []);
      const outs = outgoing.get(id) ?? [];
      if (node.type === "flow.if_else") {
        // Both branches are possible — walk each as its own chain.
        for (const e of outs) {
          if (next.length) chains.push(next);
          walk(e.targetId, [], new Set(seen));
        }
        return;
      }
      if (next.length >= 2) chains.push(next);
      for (const e of outs) walk(e.targetId, next, seen);
    };
    walk(t.id, [], new Set());
  }

  for (const chain of chains) {
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      // channel_is with two different channels can never both be true.
      if (a.type === "condition.channel_is" && b.type === "condition.channel_is") {
        const ca = String(a.config.channel ?? "");
        const cb = String(b.config.channel ?? "");
        if (ca && cb && ca !== cb) {
          issues.push({
            nodeId: b.id,
            code: "conflicting_conditions",
            message: `Conflicting conditions: "${b.label}" requires channel "${cb}", but upstream "${a.label}" already requires channel "${ca}" — this branch can never run`,
          });
        }
      }
      // Identical keyword conditions are redundant.
      if (a.type === "condition.keyword_contains" && b.type === "condition.keyword_contains") {
        const ka = String(a.config.keyword ?? "").toLowerCase();
        const kb = String(b.config.keyword ?? "").toLowerCase();
        if (ka && ka === kb) {
          issues.push({
            nodeId: b.id,
            code: "redundant_condition",
            message: `Redundant condition: "${b.label}" repeats the keyword check from "${a.label}" — it adds nothing`,
          });
        }
      }
      // A lower lead-score threshold followed by a higher one makes the first redundant.
      if (a.type === "condition.lead_score_gte" && b.type === "condition.lead_score_gte") {
        const sa = Number(a.config.score ?? 0);
        const sb = Number(b.config.score ?? 0);
        if (sb > sa) {
          issues.push({
            nodeId: a.id,
            code: "redundant_condition",
            message: `Redundant condition: "${a.label}" (score ≥ ${sa}) is implied by the later "${b.label}" (score ≥ ${sb})`,
          });
        }
      }
    }
  }
  return issues;
}

export async function simulateWorkflow(
  workflowId: string,
  workspaceId: string,
  sampleEvent: Record<string, unknown>
): Promise<SimulationResult> {
  const event = sampleEvent ?? {};

  // ── Reads only. No writes anywhere in this function. ───────────────────
  const workflow = await db.workflow.findFirst({
    where: { id: workflowId, workspaceId },
    include: { nodes: true, edges: true },
  });
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

  const nodes: ParsedNode[] = workflow.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    type: n.type,
    label: n.label,
    config: parseJson<Record<string, unknown>>(n.config, {}),
    disabled: n.disabled ?? false,
  }));
  const edges: ParsedEdge[] = workflow.edges.map((e) => ({
    id: e.id,
    sourceId: e.sourceId,
    targetId: e.targetId,
    label: e.label ?? "",
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, ParsedEdge[]>();
  for (const e of edges) {
    if (!outgoing.has(e.sourceId)) outgoing.set(e.sourceId, []);
    outgoing.get(e.sourceId)!.push(e);
  }
  const outOf = (id: string): ParsedEdge[] => outgoing.get(id) ?? [];

  const integrations = await db.integration.findMany({ where: { workspaceId } });
  const connected = new Set(
    integrations.filter((i) => i.status === "CONNECTED").map((i) => i.provider)
  );

  const errors: SimIssue[] = [];
  const warnings: SimIssue[] = [];
  const path: SimStep[] = [];
  const messages: SimMessage[] = [];
  let wouldSend = false;

  // ── Static validation ──────────────────────────────────────────────────
  const validation = validateWorkflow(
    nodes.map((n) => ({ id: n.id, kind: n.kind, type: n.type, label: n.label, config: n.config })),
    edges.map((e) => ({ id: e.id, sourceId: e.sourceId, targetId: e.targetId, label: e.label }))
  );
  const nodeErrorIds = new Set<string>();
  for (const e of validation.errors) {
    errors.push({ nodeId: e.nodeId, code: "validation", message: e.message });
    if (e.nodeId) nodeErrorIds.add(e.nodeId);
  }
  for (const issue of detectConflictingConditions(nodes, edges)) {
    if (issue.code === "conflicting_conditions") errors.push(issue);
    else warnings.push(issue);
  }

  // ── Credential + capability checks (read-only) ─────────────────────────
  const checkChannel = (node: ParsedNode, channel: string) => {
    if (!isSupportedChannel(channel)) {
      warnings.push({
        nodeId: node.id,
        code: "unsupported_channel",
        message: `Node "${node.label}": channel "${channel}" is not a supported channel (use one of: ${SUPPORTED_CHANNELS.join(", ")})`,
      });
      return;
    }
    const caps = providerCapabilities(channel);
    if (!caps.includes("send_text")) {
      warnings.push({
        nodeId: node.id,
        code: "unsupported_capability",
        message: `Node "${node.label}": provider "${channel}" does not support sending text — a real send would fail or be simulated`,
      });
    }
    if (channel === "whatsapp" && caps.includes("templates_required")) {
      warnings.push({
        nodeId: node.id,
        code: "messaging_window",
        message: `Node "${node.label}": WhatsApp free-form messages are only deliverable inside the 24-hour customer-service window — use a template otherwise`,
      });
    }
    if (!connected.has(channel)) {
      warnings.push({
        nodeId: node.id,
        code: "missing_credentials",
        message: `Node "${node.label}": no CONNECTED "${channel}" integration in this workspace — a real send would fall back to an honest mock (no credentials stored)`,
      });
    }
  };

  for (const node of nodes) {
    if (node.kind !== "action") continue;
    switch (node.type) {
      case "action.send_message":
        checkChannel(node, String(node.config.channel ?? "webchat"));
        break;
      case "action.reply_comment": {
        const channel = getStr(event, "channel") || "webchat";
        if (isSupportedChannel(channel)) {
          const caps = providerCapabilities(channel);
          if (!caps.includes("reply_comment")) {
            warnings.push({
              nodeId: node.id,
              code: "unsupported_capability",
              message: `Node "${node.label}": provider "${channel}" cannot post private comment replies — the engine would fall back to a regular message`,
            });
          }
          if (!connected.has(channel)) {
            warnings.push({
              nodeId: node.id,
              code: "missing_credentials",
              message: `Node "${node.label}": no CONNECTED "${channel}" integration in this workspace — a real reply would fall back to an honest mock`,
            });
          }
        }
        break;
      }
      case "action.send_email":
      case "action.send_whatsapp_template": {
        const provider = node.type === "action.send_email" ? "email" : "whatsapp";
        if (!connected.has(provider)) {
          warnings.push({
            nodeId: node.id,
            code: "missing_credentials",
            message: `Node "${node.label}": "${provider}" is not connected — the engine would request human approval instead of sending`,
          });
        }
        break;
      }
      case "action.ai_reply":
        warnings.push({
          nodeId: node.id,
          code: "ai_not_invoked",
          message: `Node "${node.label}": simulation never calls the AI — the reply text and confidence cannot be previewed`,
        });
        break;
      default:
        break;
    }
  }

  // ── Graph walk (pure — mirrors engine branch logic) ────────────────────
  const visited = new Set<string>();
  const dedupeKeys = new Set<string>();
  let visits = 0;
  let cycleReported = false;

  function pushStep(step: SimStep) {
    path.push(step);
  }

  function markBranchSkipped(startId: string, reason: string): void {
    const stack = [startId];
    while (stack.length) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      const node = byId.get(id);
      if (!node) continue;
      visited.add(id);
      pushStep({
        nodeId: node.id,
        nodeType: node.type,
        label: node.label,
        outcome: "skipped",
        detail: reason,
      });
      for (const e of outOf(id)) stack.push(e.targetId);
    }
  }

  function invalidStep(node: ParsedNode): SimStep | null {
    if (!nodeErrorIds.has(node.id)) return null;
    return {
      nodeId: node.id,
      nodeType: node.type,
      label: node.label,
      outcome: "validation_error",
      detail: "node has validation errors — fix them before relying on this path",
    };
  }

  function describeAction(node: ParsedNode): { detail: string; halt?: boolean } {
    const cfg = node.config;
    switch (node.type) {
      case "action.send_message": {
        const channel = String(cfg.channel ?? "webchat");
        const to = getStr(event, "from") || "unknown";
        const body = renderTemplate(String(cfg.body ?? ""), event);
        messages.push({ channel, to, bodyPreview: body });
        wouldSend = true;
        return { detail: `would send_message via ${channel} to ${to}: "${truncate(body, 140)}"` };
      }
      case "action.reply_comment": {
        const channel = getStr(event, "channel") || "webchat";
        const commentId = getStr(event, "commentId");
        const eligible = event.commentEligible !== false;
        const body = renderTemplate(String(cfg.body ?? ""), event);
        const to = getStr(event, "from") || "unknown";
        messages.push({ channel, to, bodyPreview: body });
        wouldSend = true;
        const fallback = !commentId
          ? "no commentId on event — would fall back to a regular message"
          : !eligible
            ? "comment not eligible for private reply — would fall back to a regular message"
            : null;
        return {
          detail: `would reply to comment ${commentId || "(unknown)"} on ${channel} to ${to}: "${truncate(body, 140)}"${fallback ? ` — ${fallback}` : ""}`,
        };
      }
      case "action.ai_reply": {
        const threshold = Number(cfg.confidenceThreshold ?? 0.7);
        wouldSend = true;
        return {
          detail: `would generate an AI reply (confidence threshold ${threshold}) — AI is not invoked in simulation, so no text can be previewed; would send only if confidence ≥ threshold`,
        };
      }
      case "action.add_tag": {
        const tag = String(cfg.tag ?? "");
        const contactId = getStr(event, "contactId");
        return {
          detail: contactId
            ? `would add tag "${tag}" to contact ${contactId}`
            : `would add tag "${tag}" — but no contact on the event, so the engine would skip this`,
        };
      }
      case "action.create_lead": {
        const name = renderTemplate(String(cfg.name ?? "New Lead"), event);
        return { detail: `would create lead "${name}"` };
      }
      case "action.internal_note": {
        const conversationId = getStr(event, "conversationId");
        return {
          detail: conversationId
            ? `would add an internal note to conversation ${conversationId}`
            : `would add an internal note — but no conversation on the event, so the engine would skip this`,
        };
      }
      case "action.assign_conversation": {
        const assignee = String(cfg.assignee ?? "");
        const conversationId = getStr(event, "conversationId");
        return { detail: `would assign conversation ${conversationId || "(unknown)"} to "${assignee}"` };
      }
      case "action.update_crm_field": {
        const field = String(cfg.field ?? "");
        const value = renderTemplate(String(cfg.value ?? ""), event);
        const contactId = getStr(event, "contactId");
        return {
          detail: contactId
            ? `would set CRM field "${field}" = "${truncate(value, 80)}" on contact ${contactId}`
            : `would set CRM field "${field}" — but no contact on the event, so the engine would skip this`,
        };
      }
      case "action.wait": {
        const seconds = Number(cfg.seconds ?? 0);
        return { detail: `would wait ${seconds} seconds before continuing` };
      }
      case "action.send_email": {
        const to = renderTemplate(String(cfg.to ?? ""), event);
        const subject = renderTemplate(String(cfg.subject ?? ""), event);
        const body = renderTemplate(String(cfg.body ?? ""), event);
        if (!connected.has("email")) {
          return { detail: `would request approval — the "email" provider is not connected, so no email would be sent` };
        }
        messages.push({ channel: "email", to, bodyPreview: `Subject: ${subject}\n\n${body}` });
        wouldSend = true;
        return { detail: `would send email to ${to || "(unknown)"}: "${truncate(subject, 80)}"` };
      }
      case "action.send_whatsapp_template": {
        const templateName = String(cfg.templateName ?? "");
        const params = (Array.isArray(cfg.params) ? cfg.params : []).map((p) => renderTemplate(String(p), event));
        const to = getStr(event, "from") || "unknown";
        if (!connected.has("whatsapp")) {
          return { detail: `would request approval — the "whatsapp" provider is not connected, so no template would be sent` };
        }
        messages.push({ channel: "whatsapp", to, bodyPreview: `[template:${templateName}] ${params.join(" | ")}` });
        wouldSend = true;
        return { detail: `would send WhatsApp template "${templateName}" to ${to}` };
      }
      case "action.call_webhook": {
        const url = String(cfg.url ?? "");
        return { detail: `would call webhook ${url} — simulated, no external request is made` };
      }
      case "action.notify_team": {
        const message = renderTemplate(String(cfg.message ?? ""), event);
        return { detail: `would notify the team: "${truncate(message, 140)}" (audit entry — not written during simulation)` };
      }
      case "action.request_approval": {
        return { detail: "would request human approval and halt the run", halt: true };
      }
      case "action.end":
        return { detail: "branch ends" };
      default:
        return { detail: `unknown action "${node.type}" — the engine would treat it as an end` };
    }
  }

  function visit(nodeId: string): void {
    if (++visits > MAX_VISITS) {
      if (!cycleReported) {
        cycleReported = true;
        errors.push({
          code: "possible_cycle",
          message: `Simulation stopped after ${MAX_VISITS} node visits — the graph may contain a cycle`,
        });
      }
      return;
    }
    const node = byId.get(nodeId);
    if (!node || visited.has(nodeId)) return;

    // Disabled nodes: honest skip, flow continues past them.
    if (node.disabled) {
      visited.add(nodeId);
      pushStep({
        nodeId: node.id,
        nodeType: node.type,
        label: node.label,
        outcome: "skipped",
        detail: "node disabled in the builder — skipped, flow continues",
      });
      for (const e of outOf(nodeId)) visit(e.targetId);
      return;
    }

    const invalid = invalidStep(node);
    if (invalid) {
      visited.add(nodeId);
      pushStep(invalid);
      for (const e of outOf(nodeId)) visit(e.targetId);
      return;
    }

    if (node.kind === "condition" || node.type === "flow.if_else") {
      visited.add(nodeId);
      if (node.type === "flow.if_else") {
        const { result, note } = evaluateIfElseExpression(String(node.config.expression ?? ""), event);
        const want = result ? "true" : "false";
        const outs = outOf(nodeId);
        const branch = outs.find((e) => e.label.trim().toLowerCase() === want) ?? outs[0];
        const otherBranches = outs.filter((e) => e !== branch);
        pushStep({
          nodeId: node.id,
          nodeType: node.type,
          label: node.label,
          outcome: "matched",
          detail: `expression "${String(node.config.expression ?? "")}" → ${result} (branch "${branch?.label ?? "?"})"${note ? ` — ${note}` : ""}`,
        });
        for (const e of otherBranches) markBranchSkipped(e.targetId, `if/else branch "${e.label || "?"}" not taken`);
        if (branch) visit(branch.targetId);
        return;
      }
      const result = evaluateCondition(node.type, node.config, event);
      pushStep({
        nodeId: node.id,
        nodeType: node.type,
        label: node.label,
        outcome: result ? "matched" : "skipped",
        detail: result ? "condition evaluated true" : "condition evaluated false — downstream branch skipped",
      });
      if (!result) {
        for (const e of outOf(nodeId)) markBranchSkipped(e.targetId, "upstream condition evaluated false");
        return;
      }
      for (const e of outOf(nodeId)) visit(e.targetId);
      return;
    }

    if (node.kind === "flow") {
      visited.add(nodeId);
      switch (node.type) {
        case "flow.delay": {
          const seconds = Number(node.config.seconds ?? 0);
          pushStep({ nodeId: node.id, nodeType: node.type, label: node.label, outcome: "would_execute", detail: `would delay ${seconds} seconds (scheduled, no busy-wait)` });
          break;
        }
        case "flow.retry": {
          const maxAttempts = Number(node.config.maxAttempts ?? 3);
          pushStep({ nodeId: node.id, nodeType: node.type, label: node.label, outcome: "would_execute", detail: `would mark following steps retryable (max ${maxAttempts} attempts)` });
          break;
        }
        case "flow.timeout": {
          const seconds = Number(node.config.seconds ?? 0);
          pushStep({ nodeId: node.id, nodeType: node.type, label: node.label, outcome: "would_execute", detail: `would bound the following steps to ${seconds} seconds` });
          break;
        }
        case "flow.dedupe": {
          const key = renderTemplate(String(node.config.key ?? ""), event);
          if (dedupeKeys.has(key)) {
            pushStep({ nodeId: node.id, nodeType: node.type, label: node.label, outcome: "skipped", detail: `dedupe key "${truncate(key, 80)}" already seen in this run — branch skipped` });
            return;
          }
          dedupeKeys.add(key);
          pushStep({ nodeId: node.id, nodeType: node.type, label: node.label, outcome: "would_execute", detail: `dedupe key "${truncate(key, 80)}" is new — continuing` });
          break;
        }
        case "flow.error_branch":
          pushStep({ nodeId: node.id, nodeType: node.type, label: node.label, outcome: "would_execute", detail: "error-branch marker — pass-through in this build" });
          break;
        case "flow.end":
          pushStep({ nodeId: node.id, nodeType: node.type, label: node.label, outcome: "would_execute", detail: "branch ends" });
          return;
        default:
          pushStep({ nodeId: node.id, nodeType: node.type, label: node.label, outcome: "validation_error", detail: `unknown flow node "${node.type}" — treated as end` });
          return;
      }
      for (const e of outOf(nodeId)) visit(e.targetId);
      return;
    }

    // Actions (kind === "action"; trigger nodes are entered via the loop below).
    visited.add(nodeId);
    const { detail, halt } = describeAction(node);
    pushStep({ nodeId: node.id, nodeType: node.type, label: node.label, outcome: "would_execute", detail });
    if (halt) return;
    for (const e of outOf(nodeId)) visit(e.targetId);
  }

  const triggers = nodes.filter((n) => n.kind === "trigger");
  const matchedTriggers = triggers.filter((t) => triggerMatchesEvent(t.type, t.config, event));
  const matched = matchedTriggers.length > 0;

  for (const t of triggers) {
    if (matchedTriggers.includes(t)) {
      visited.add(t.id);
      const invalid = invalidStep(t);
      if (invalid) {
        pushStep(invalid);
      } else {
        pushStep({
          nodeId: t.id,
          nodeType: t.type,
          label: t.label,
          outcome: "matched",
          detail: `trigger matched — event.type "${getStr(event, "type")}"`,
        });
      }
      for (const e of outOf(t.id)) visit(e.targetId);
    } else {
      const want = TRIGGER_EVENT_MAP[t.type] ?? "(unknown)";
      markBranchSkipped(t.id, `trigger did not match — expected event.type "${want}", got "${getStr(event, "type") || "(missing)"}"`);
    }
  }

  if (!matched) {
    warnings.push({
      code: "no_trigger_match",
      message: `No trigger matched this event (event.type "${getStr(event, "type") || "(missing)"}") — a real run would do nothing`,
    });
  }

  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    matched,
    path,
    wouldSend,
    messages,
    errors,
    warnings,
    note: "SIMULATION — no messages were sent. Nothing was written to the database: no executions, no steps, no sends, no AI calls, no queue jobs.",
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
