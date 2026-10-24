import { NODE_TYPES, SUPPORTED_CHANNELS, type NodeKind } from "./nodeRegistry";

/**
 * Static workflow validation — pure function, safe to run on the server
 * (publish / test routes) and in the browser (builder "Validate" button).
 */

export interface NodeInput {
  id: string;
  kind: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  /** Builder toggle: disabled nodes skip config validation (they never run). */
  disabled?: boolean;
}

export interface EdgeInput {
  id: string;
  sourceId: string;
  targetId: string;
  label?: string;
}

export interface ValidationError {
  nodeId?: string;
  message: string;
}

export function validateWorkflow(
  nodes: NodeInput[],
  edges: EdgeInput[]
): { valid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, EdgeInput[]>();
  for (const e of edges) {
    if (!outgoing.has(e.sourceId)) outgoing.set(e.sourceId, []);
    outgoing.get(e.sourceId)!.push(e);
  }
  const outOf = (id: string): EdgeInput[] => outgoing.get(id) ?? [];

  const known = new Set<string>();
  for (const node of nodes) {
    const def = NODE_TYPES[node.type];
    if (!def) {
      errors.push({ nodeId: node.id, message: `Node "${node.label}": unknown node type "${node.type}"` });
      continue;
    }
    known.add(node.id);
    if (def.kind !== (node.kind as NodeKind)) {
      errors.push({
        nodeId: node.id,
        message: `Node "${node.label}": kind "${node.kind}" does not match type "${node.type}" (expected "${def.kind}")`,
      });
    }
    // Config schema check — report the first issue.
    // Disabled nodes are skipped by the engine, so their config is not validated.
    if (!node.disabled) {
      const parsed = def.configSchema.safeParse(node.config ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue.path.length ? `config.${issue.path.join(".")}` : "config";
        errors.push({ nodeId: node.id, message: `Node "${node.label}": ${path}: ${issue.message}` });
        continue;
      }
    }
    // Channel allow-list checks.
    if (node.type === "action.send_message") {
      const channel = String((node.config as Record<string, unknown>).channel ?? "");
      if (!(SUPPORTED_CHANNELS as readonly string[]).includes(channel)) {
        errors.push({
          nodeId: node.id,
          message: `Node "${node.label}": channel "${channel}" is not supported (use one of: ${SUPPORTED_CHANNELS.join(", ")})`,
        });
      }
    }
  }

  // At least one trigger.
  const triggers = nodes.filter((n) => n.kind === "trigger" && NODE_TYPES[n.type]);
  if (triggers.length === 0) {
    errors.push({ message: "Workflow needs at least one trigger node" });
  }

  // Edge sanity: endpoints exist, no self-loops.
  for (const edge of edges) {
    if (!byId.has(edge.sourceId) || !byId.has(edge.targetId)) {
      errors.push({ message: `Edge "${edge.id}" references a missing node` });
      continue;
    }
    if (edge.sourceId === edge.targetId) {
      errors.push({ nodeId: edge.sourceId, message: `Node "${byId.get(edge.sourceId)?.label}": self-loops are not allowed` });
    }
  }

  // Every trigger needs at least one outgoing edge.
  for (const t of triggers) {
    if (outOf(t.id).length === 0) {
      errors.push({ nodeId: t.id, message: `Trigger "${t.label}" has no outgoing edge — connect it to the next step` });
    }
  }

  // Reachability: every non-trigger node must be reachable from a trigger.
  const reachable = new Set<string>();
  const stack = triggers.map((t) => t.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const e of outOf(id)) stack.push(e.targetId);
  }
  for (const node of nodes) {
    if (node.kind !== "trigger" && known.has(node.id) && !reachable.has(node.id)) {
      errors.push({ nodeId: node.id, message: `Node "${node.label}" is unreachable — connect it downstream of a trigger` });
    }
  }

  // flow.if_else needs true/false labeled branches.
  for (const node of nodes) {
    if (node.type !== "flow.if_else" || !known.has(node.id)) continue;
    const outs = outOf(node.id);
    const labels = new Set(outs.map((e) => (e.label ?? "").trim().toLowerCase()));
    if (outs.length < 2 || !labels.has("true") || !labels.has("false")) {
      errors.push({
        nodeId: node.id,
        message: `If/Else "${node.label}" needs at least two outgoing edges labeled "true" and "false"`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
