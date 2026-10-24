import { validateWorkflow, type NodeInput, type EdgeInput } from "./validate";
import { NODE_TYPES } from "./nodeRegistry";

/**
 * Builder readiness report: validateWorkflow() errors plus builder-level
 * checks — cycles, disconnected nodes, unknown {{variables}}, WhatsApp
 * 24h-window rules, if_else branch labels, and missing-credential hints.
 *
 * Pure and client-safe. Credential presence uses the caller-supplied
 * connected-providers list (the server route fetches integrations; the
 * builder passes provider names only — never secrets).
 */

export interface ReadinessIssue {
  severity: "error" | "warning";
  nodeId?: string;
  message: string;
  /** Node to jump to when the user clicks "fix". */
  fixNodeId?: string;
}

export interface ReadinessReport {
  errors: ReadinessIssue[];
  warnings: ReadinessIssue[];
  ready: boolean;
}

export interface ReadinessOpts {
  /** Provider names with CONNECTED status, e.g. ["instagram", "whatsapp"]. */
  connectedProviders?: string[];
}

/** Event fields a trigger exposes for {{variable}} interpolation. */
const TRIGGER_VARIABLES: Record<string, string[]> = {
  "trigger.new_message": ["type", "channel", "from", "name", "text", "email"],
  "trigger.new_comment": ["type", "channel", "from", "name", "text", "commentId", "postId"],
  "trigger.new_conversation": ["type", "channel", "from", "name"],
  "trigger.new_lead": ["type", "name", "email", "phone", "leadScore"],
  "trigger.keyword": ["type", "channel", "from", "name", "text"],
  "trigger.tag_added": ["type", "name", "tag"],
  "trigger.scheduled": ["type"],
  "trigger.webhook": ["type"],
  "trigger.commerce_event": ["type", "eventName", "orderId", "amount"],
  "trigger.manual": ["type"],
};

const KNOWN_VARS = new Set([
  ...Object.values(TRIGGER_VARIABLES).flat(),
  "leadScore",
  "intent",
  "comment",
  "message",
]);

/** Map node permission → provider name for credential hints. */
const PERMISSION_PROVIDER: Array<[RegExp, string]> = [
  [/messages:send/, "messaging provider (Instagram / Messenger / WhatsApp)"],
  [/ai:generate/, "AI provider"],
  [/crm:write/, "CRM"],
  [/integrations:invoke/, "webhook target"],
];

export function readinessReport(
  nodes: NodeInput[],
  edges: EdgeInput[],
  opts: ReadinessOpts = {}
): ReadinessReport {
  const errors: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];

  // Base structural/config validation.
  const base = validateWorkflow(nodes, edges);
  for (const e of base.errors) {
    errors.push({ severity: "error", nodeId: e.nodeId, message: e.message, fixNodeId: e.nodeId });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, EdgeInput[]>();
  const incoming = new Map<string, EdgeInput[]>();
  for (const e of edges) {
    if (!outgoing.has(e.sourceId)) outgoing.set(e.sourceId, []);
    outgoing.get(e.sourceId)!.push(e);
    if (!incoming.has(e.targetId)) incoming.set(e.targetId, []);
    incoming.get(e.targetId)!.push(e);
  }

  // ── Cycle detection (validateWorkflow doesn't check this) ──
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  let cycleFound = false;
  const visit = (id: string): void => {
    if (cycleFound) return;
    color.set(id, GRAY);
    for (const e of outgoing.get(id) ?? []) {
      const c = color.get(e.targetId) ?? WHITE;
      if (c === GRAY) {
        cycleFound = true;
        errors.push({
          severity: "error",
          nodeId: id,
          message: `Cycle detected involving "${byId.get(id)?.label ?? id}" — workflows must be acyclic`,
          fixNodeId: id,
        });
        return;
      }
      if (c === WHITE) visit(e.targetId);
    }
    color.set(id, BLACK);
  };
  for (const n of nodes) if ((color.get(n.id) ?? WHITE) === WHITE) visit(n.id);

  // ── Disabled nodes: informational warning (they never run) ──
  for (const n of nodes) {
    if (n.disabled && NODE_TYPES[n.type]) {
      warnings.push({
        severity: "warning",
        nodeId: n.id,
        message: `"${n.label}" is disabled — it will be skipped at runtime`,
        fixNodeId: n.id,
      });
    }
  }

  // ── Disconnected nodes (warning, not error) ──
  for (const n of nodes) {
    if (!NODE_TYPES[n.type]) continue;
    const hasIn = (incoming.get(n.id) ?? []).length > 0;
    const hasOut = (outgoing.get(n.id) ?? []).length > 0;
    if (n.kind !== "trigger" && !hasIn) {
      warnings.push({
        severity: "warning",
        nodeId: n.id,
        message: `"${n.label}" is not connected to anything — it will never run`,
        fixNodeId: n.id,
      });
    } else if (!hasOut && n.kind !== "trigger" && n.type !== "action.end" && n.type !== "flow.end") {
      warnings.push({
        severity: "warning",
        nodeId: n.id,
        message: `"${n.label}" has no outgoing connection — the branch ends here`,
        fixNodeId: n.id,
      });
    }
  }

  // ── if_else branch labels ──
  for (const n of nodes) {
    if (n.type !== "flow.if_else") continue;
    const labels = new Set((outgoing.get(n.id) ?? []).map((e) => (e.label ?? "").toLowerCase()));
    if (!labels.has("true") || !labels.has("false")) {
      errors.push({
        severity: "error",
        nodeId: n.id,
        message: `"${n.label}" needs two outgoing connections labeled "true" and "false"`,
        fixNodeId: n.id,
      });
    }
  }

  // ── Unknown {{variables}} ──
  const triggerTypes = new Set(nodes.filter((n) => n.kind === "trigger").map((n) => n.type));
  const available = new Set<string>();
  for (const t of triggerTypes) for (const v of TRIGGER_VARIABLES[t] ?? []) available.add(v);
  for (const v of KNOWN_VARS) available.add(v);
  const scanVars = (text: string): string[] => {
    const out: string[] = [];
    for (const m of text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) out.push(m[1].split(".")[0]);
    return out;
  };
  for (const n of nodes) {
    if (!NODE_TYPES[n.type]) continue;
    for (const [k, v] of Object.entries(n.config ?? {})) {
      if (typeof v !== "string") continue;
      for (const varName of scanVars(v)) {
        if (!available.has(varName)) {
          warnings.push({
            severity: "warning",
            nodeId: n.id,
            message: `"${n.label}": {{${varName}}} in "${k}" may be empty — no trigger exposes this field`,
            fixNodeId: n.id,
          });
        }
      }
    }
  }

  // ── WhatsApp 24h window rule ──
  for (const n of nodes) {
    if (n.type === "action.send_message" && String((n.config as Record<string, unknown>).channel) === "whatsapp") {
      warnings.push({
        severity: "warning",
        nodeId: n.id,
        message: `"${n.label}": freeform WhatsApp messages only deliver inside the 24h customer-service window — use "Send WhatsApp template" outside it`,
        fixNodeId: n.id,
      });
    }
    if (n.type === "action.send_email") {
      warnings.push({
        severity: "warning",
        nodeId: n.id,
        message: `"${n.label}": email delivery requires a CONNECTED email integration — otherwise an approval is requested at runtime`,
        fixNodeId: n.id,
      });
    }
  }

  // ── Credential / permission hints ──
  if (opts.connectedProviders) {
    const connected = new Set(opts.connectedProviders.map((p) => p.toLowerCase()));
    const messagingConnected = ["instagram", "facebook", "whatsapp", "telegram"].some((p) =>
      connected.has(p)
    );
    for (const n of nodes) {
      const def = NODE_TYPES[n.type];
      if (!def) continue;
      for (const perm of def.requiredPermissions) {
        for (const [re, providerHint] of PERMISSION_PROVIDER) {
          if (!re.test(perm)) continue;
          const satisfied =
            perm === "messages:send"
              ? messagingConnected
              : perm === "ai:generate"
                ? true // AI provider status is checked at runtime; not an integration row
                : connected.size > 0;
          if (!satisfied) {
            warnings.push({
              severity: "warning",
              nodeId: n.id,
              message: `"${n.label}" needs ${perm} — connect a ${providerHint} before activating`,
              fixNodeId: n.id,
            });
          }
          break;
        }
      }
    }
  }

  return { errors, warnings, ready: errors.length === 0 };
}
