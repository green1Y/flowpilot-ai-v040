import { z } from "zod";
import { NODE_TYPES, type NodeKind } from "@/lib/workflows/nodeRegistry";

/**
 * Server-side validation + repair of AI-generated workflow specs.
 *
 * The model must emit ONLY registered node types with valid configs.
 * Unknown node types are dropped (repair); if nothing valid remains the
 * spec is rejected. Edges referencing dropped/missing nodes are dropped too.
 * This is the same trust boundary templates go through.
 */

const specNodeSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(["trigger", "condition", "action", "flow"]),
  type: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  config: z.record(z.unknown()).default({}),
  x: z.number().finite().default(80),
  y: z.number().finite().default(120),
});

const specEdgeSchema = z.object({
  sourceId: z.string().min(1).max(64),
  targetId: z.string().min(1).max(64),
  label: z.string().max(20).default(""),
});

export const workflowSpecSchema = z.object({
  nodes: z.array(specNodeSchema).min(1).max(40),
  edges: z.array(specEdgeSchema).max(80).default([]),
});

export type WorkflowSpec = z.infer<typeof workflowSpecSchema>;
export type SpecNode = z.infer<typeof specNodeSchema>;

export interface SpecValidation {
  ok: boolean;
  spec: WorkflowSpec | null;
  /** Human-readable notes about repairs the validator applied. */
  repaired: string[];
  errors: string[];
}

const KINDS: NodeKind[] = ["trigger", "condition", "action", "flow"];

/**
 * Validate + repair a raw model output. Never throws on model-shaped input;
 * returns { ok: false, errors } when the spec is unusable.
 */
export function validateAndRepairSpec(raw: unknown): SpecValidation {
  return validateCore(raw, { requireTrigger: true });
}

function validateCore(raw: unknown, opts: { requireTrigger: boolean }): SpecValidation {
  const repaired: string[] = [];
  const errors: string[] = [];

  const parsed = workflowSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    errors.push(`Spec shape invalid: ${first.path.join(".") || "(root)"}: ${first.message}`);
    return { ok: false, spec: null, repaired, errors };
  }

  const keptNodes: SpecNode[] = [];
  const droppedIds = new Set<string>();
  const seenIds = new Set<string>();

  for (const n of parsed.data.nodes) {
    if (seenIds.has(n.id)) {
      droppedIds.add(n.id);
      repaired.push(`duplicate node id "${n.id}" removed`);
      continue;
    }
    seenIds.add(n.id);
    const def = NODE_TYPES[n.type];
    if (!def) {
      droppedIds.add(n.id);
      repaired.push(`unknown node type "${n.type}" removed`);
      continue;
    }
    if (def.kind !== (n.kind as NodeKind)) {
      repaired.push(`node "${n.id}" kind fixed "${n.kind}" → "${def.kind}"`);
      n.kind = def.kind;
    }
    // Validate config against the registered schema; merge over defaults
    // so missing optional fields don't fail.
    const cfgParsed = def.configSchema.safeParse({ ...def.defaults, ...n.config });
    if (!cfgParsed.success) {
      const issue = cfgParsed.error.issues[0];
      droppedIds.add(n.id);
      repaired.push(
        `node "${n.label}" removed: invalid config (${issue.path.join(".") || "config"}: ${issue.message})`
      );
      continue;
    }
    keptNodes.push({ ...n, kind: def.kind as NodeKind, config: cfgParsed.data as Record<string, unknown> });
  }

  if (keptNodes.length === 0) {
    errors.push("No valid nodes remained after repair — the model produced only unknown node types.");
    return { ok: false, spec: null, repaired, errors };
  }

  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptEdges = parsed.data.edges.filter((e) => {
    if (!keptIds.has(e.sourceId) || !keptIds.has(e.targetId)) {
      repaired.push(`edge ${e.sourceId}→${e.targetId} removed (endpoint dropped)`);
      return false;
    }
    if (e.sourceId === e.targetId) {
      repaired.push(`self-loop on "${e.sourceId}" removed`);
      return false;
    }
    return true;
  });

  const triggers = keptNodes.filter((n) => n.kind === "trigger");
  if (opts.requireTrigger && triggers.length === 0) {
    errors.push("Spec has no trigger node — every workflow must start with a trigger.");
    return { ok: false, spec: null, repaired, errors };
  }

  // Normalize: exactly one primary trigger keeps the graph sane.
  // (Multiple triggers are allowed by the engine, but the copilot keeps it simple.)
  void KINDS;

  return { ok: true, spec: { nodes: keptNodes, edges: keptEdges }, repaired, errors };
}

/** Parse a raw JSON string from the model, then validate + repair. */
export function parseModelSpec(rawText: string): SpecValidation {
  let raw: unknown;
  try {
    // Strip accidental code fences.
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    raw = JSON.parse(cleaned);
  } catch {
    return { ok: false, spec: null, repaired: [], errors: ["Model output was not valid JSON"] };
  }
  return validateAndRepairSpec(raw);
}

/**
 * Validate a "fragment" spec (add-step mode): same node rules, but no
 * trigger requirement, and new node ids must not collide with existingIds.
 */
export function validateAndRepairFragment(
  raw: unknown,
  existingIds: Set<string>
): SpecValidation {
  const base = validateCore(raw, { requireTrigger: false });
  if (!base.ok || !base.spec) return base;
  for (const n of base.spec.nodes) {
    if (existingIds.has(n.id)) {
      base.repaired.push(`new node id "${n.id}" collides with existing graph — renamed`);
      n.id = `n_new_${Math.random().toString(36).slice(2, 8)}`;
    }
  }
  const keptIds = new Set(base.spec.nodes.map((n) => n.id));
  const edges = base.spec.edges.filter(
    (e) =>
      (keptIds.has(e.sourceId) || existingIds.has(e.sourceId)) &&
      (keptIds.has(e.targetId) || existingIds.has(e.targetId)) &&
      e.sourceId !== e.targetId
  );
  const kept = base.spec.nodes;
  return { ok: kept.length > 0, spec: { nodes: kept, edges }, repaired: base.repaired, errors: base.errors };
}

/** Parse a raw fragment JSON string, then validate + repair against existing ids. */
export function parseModelFragment(rawText: string, existingIds: Set<string>): SpecValidation {
  let raw: unknown;
  try {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    raw = JSON.parse(cleaned);
  } catch {
    return { ok: false, spec: null, repaired: [], errors: ["Model output was not valid JSON"] };
  }
  return validateAndRepairFragment(raw, existingIds);
}
