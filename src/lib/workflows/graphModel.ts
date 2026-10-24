import { NODE_TYPES } from "./nodeRegistry";
import type { WorkflowSpec, SpecNode } from "@/lib/copilot/spec";

/**
 * Pure graph-model helpers shared by the builder UI and unit tests.
 * No React, no DOM — safe to import anywhere.
 */

export interface GraphNode {
  id: string;
  kind: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
  disabled?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export function freshNodeId(): string {
  return `n_${Math.random().toString(36).slice(2, 10)}`;
}

export function freshEdgeId(): string {
  return `e_${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a GraphNode from a registered type (palette add / click-to-add). */
export function nodeFromType(type: string): GraphNode | null {
  const def = NODE_TYPES[type];
  if (!def) return null;
  return {
    id: freshNodeId(),
    kind: def.kind,
    type: def.type,
    label: def.label,
    config: structuredClone(def.defaults),
    position: { x: 80, y: 80 },
  };
}

/**
 * Convert a validated copilot/template spec into graph nodes/edges with
 * fresh ids (so inserts never collide with the existing canvas).
 * `offset` shifts positions so inserted graphs don't sit on top of old ones.
 */
export function specToGraph(
  spec: WorkflowSpec,
  offset: { x: number; y: number } = { x: 0, y: 0 }
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const idMap = new Map<string, string>();
  const nodes: GraphNode[] = spec.nodes.map((n: SpecNode) => {
    const newId = freshNodeId();
    idMap.set(n.id, newId);
    const def = NODE_TYPES[n.type];
    return {
      id: newId,
      kind: n.kind,
      type: n.type,
      label: n.label,
      config: structuredClone(n.config ?? def?.defaults ?? {}),
      position: { x: (n.x ?? 80) + offset.x, y: (n.y ?? 120) + offset.y },
    };
  });
  const edges: GraphEdge[] = spec.edges.map((e) => ({
    id: freshEdgeId(),
    source: idMap.get(e.sourceId) ?? e.sourceId,
    target: idMap.get(e.targetId) ?? e.targetId,
    label: e.label ?? "",
  }));
  return { nodes, edges };
}

/** True when `config` fails the node's registered schema (needs configuration). */
export function isNodeUnconfigured(type: string, config: Record<string, unknown>): boolean {
  const def = NODE_TYPES[type];
  if (!def) return true;
  const parsed = def.configSchema.safeParse({ ...def.defaults, ...config });
  if (!parsed.success) return true;
  // A schema-valid but empty required string still counts as unconfigured.
  const data = parsed.data as Record<string, unknown>;
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string" && v.trim() === "") {
      // Only flag fields the schema requires (non-optional).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shape = (def.configSchema as any)?._def?.typeName === "ZodObject" ? (def.configSchema as any).shape : null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const field = shape?.[k] as any;
      const tn = field?._def?.typeName;
      if (tn !== "ZodOptional" && tn !== "ZodDefault") return true;
    }
  }
  return false;
}

// ── Connection rules ────────────────────────────────────────────────────

export interface ConnectionVerdict {
  ok: boolean;
  reason?: string;
  /** Suggested edge label (e.g. true/false for if_else). */
  suggestedLabel?: string;
}

/** Validate a proposed connection before it is committed. */
export function validateConnection(
  source: GraphNode,
  target: GraphNode,
  existingEdges: GraphEdge[]
): ConnectionVerdict {
  if (source.id === target.id) return { ok: false, reason: "Self-loops are not allowed" };
  if (source.disabled) return { ok: false, reason: "Source node is disabled" };
  if (target.kind === "trigger") return { ok: false, reason: "Triggers cannot have incoming connections" };
  if (existingEdges.some((e) => e.source === source.id && e.target === target.id)) {
    return { ok: false, reason: "These nodes are already connected" };
  }
  // Cycle check: would source become reachable from target?
  const adj = new Map<string, string[]>();
  for (const e of existingEdges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const stack = [target.id];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === source.id) return { ok: false, reason: "This connection would create a cycle" };
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
  }
  let suggestedLabel: string | undefined;
  if (source.type === "flow.if_else") {
    const used = new Set(
      existingEdges.filter((e) => e.source === source.id).map((e) => (e.label ?? "").toLowerCase())
    );
    if (!used.has("true")) suggestedLabel = "true";
    else if (!used.has("false")) suggestedLabel = "false";
  }
  return { ok: true, suggestedLabel };
}

/** Find nodes/edges affected by deleting (or duplicating) a set of node ids. */
export function duplicateSubgraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  ids: Set<string>,
  offset: { x: number; y: number } = { x: 40, y: 40 }
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const idMap = new Map<string, string>();
  const newNodes = nodes
    .filter((n) => ids.has(n.id))
    .map((n) => {
      const newId = freshNodeId();
      idMap.set(n.id, newId);
      return {
        ...structuredClone(n),
        id: newId,
        label: `${n.label} (copy)`,
        position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      };
    });
  const newEdges = edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      id: freshEdgeId(),
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
      label: e.label,
    }));
  return { nodes: newNodes, edges: newEdges };
}

// ── Auto-layout (layered, no external deps) ─────────────────────────────

/**
 * Simple layered layout: BFS depth from trigger nodes → columns,
 * nodes stacked vertically within a column. Deterministic and cheap.
 */
export function layoutLayered(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  if (nodes.length === 0) return nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source)!.push(e.target);
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e.source);
  }
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if (n.kind === "trigger" || (incoming.get(n.id) ?? []).length === 0) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }
  if (queue.length === 0) {
    queue.push(nodes[0].id);
    depth.set(nodes[0].id, 0);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const nxt of outgoing.get(cur) ?? []) {
      if (!depth.has(nxt) || depth.get(nxt)! < d + 1) {
        depth.set(nxt, d + 1);
        queue.push(nxt);
      }
    }
  }
  // Unvisited (disconnected) nodes go in their own trailing column.
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  const columns = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? maxDepth + 1;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(n);
  }
  const COL_X = 300;
  const ROW_Y = 140;
  const out: GraphNode[] = [];
  for (const [d, col] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    col.forEach((n, i) => {
      out.push({ ...n, position: { x: 80 + d * COL_X, y: 80 + i * ROW_Y } });
    });
  }
  // Preserve original node order for stable rendering.
  const pos = new Map(out.map((n) => [n.id, n.position]));
  return nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position }));
}

// ── Linearization (simple mode) ─────────────────────────────────────────

export interface LinearStep {
  node: GraphNode;
  depth: number;
}

/** BFS order from triggers — the same graph as a linear step list. */
export function linearizeGraph(nodes: GraphNode[], edges: GraphEdge[]): LinearStep[] {
  if (nodes.length === 0) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source)!.push(e.target);
  }
  const visited = new Set<string>();
  const steps: LinearStep[] = [];
  const queue: Array<{ id: string; depth: number }> = [];
  const starts = nodes.filter((n) => n.kind === "trigger");
  for (const s of (starts.length ? starts : [nodes[0]])) queue.push({ id: s.id, depth: 0 });
  while (queue.length) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const n = byId.get(id);
    if (n) steps.push({ node: n, depth });
    for (const nxt of outgoing.get(id) ?? []) {
      if (!visited.has(nxt)) queue.push({ id: nxt, depth: depth + 1 });
    }
  }
  // Append disconnected leftovers.
  for (const n of nodes) {
    if (!visited.has(n.id)) steps.push({ node: n, depth: 0 });
  }
  return steps;
}

// ── Undo/redo history (pure, UI-agnostic) ────────────────────────────────

export class HistoryStack<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(private readonly limit = 100) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Record the state BEFORE a change. */
  commit(current: T): void {
    this.past.push(structuredClone(current));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: T): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.unshift(structuredClone(current));
    return prev;
  }

  redo(current: T): T | null {
    const next = this.future.shift();
    if (next === undefined) return null;
    this.past.push(structuredClone(current));
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}

// ── Autosave conflict detection ─────────────────────────────────────────

/**
 * Conflict-safe save: the server row changed since we loaded it
 * (another tab / user). Returns true when the caller must resolve
 * the conflict instead of overwriting.
 */
export function detectSaveConflict(localUpdatedAt: string | null, serverUpdatedAt: string): boolean {
  if (!localUpdatedAt) return false;
  return new Date(serverUpdatedAt).getTime() > new Date(localUpdatedAt).getTime();
}
