/**
 * Graph-model unit tests: canvas data model, connections, layout,
 * duplication, history, and save-conflict detection (all pure functions).
 */
import { describe, it, expect } from "vitest";
import {
  nodeFromType,
  specToGraph,
  validateConnection,
  duplicateSubgraph,
  layoutLayered,
  linearizeGraph,
  isNodeUnconfigured,
  HistoryStack,
  detectSaveConflict,
  type GraphNode,
  type GraphEdge,
} from "./graphModel";

function gnode(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    kind: "action",
    type: "action.send_message",
    label: partial.id,
    config: {},
    position: { x: 0, y: 0 },
    ...partial,
  };
}

describe("nodeFromType", () => {
  it("builds a node from a registered type with defaults", () => {
    const n = nodeFromType("trigger.keyword");
    expect(n).not.toBeNull();
    expect(n!.kind).toBe("trigger");
    expect(n!.type).toBe("trigger.keyword");
  });

  it("returns null for unknown types", () => {
    expect(nodeFromType("action.teleport")).toBeNull();
  });
});

describe("specToGraph", () => {
  it("remaps ids so inserts never collide", () => {
    const { nodes, edges } = specToGraph({
      nodes: [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "T", config: {}, x: 80, y: 120 },
        { id: "a1", kind: "action", type: "action.send_message", label: "A", config: {}, x: 340, y: 120 },
      ],
      edges: [{ sourceId: "t1", targetId: "a1", label: "" }],
    });
    expect(nodes.map((n) => n.id)).not.toContain("t1");
    expect(nodes.map((n) => n.id)).not.toContain("a1");
    // Edge endpoints follow the remap.
    expect(edges[0].source).toBe(nodes[0].id);
    expect(edges[0].target).toBe(nodes[1].id);
  });

  it("applies the position offset", () => {
    const { nodes } = specToGraph(
      {
        nodes: [{ id: "t1", kind: "trigger", type: "trigger.new_message", label: "T", config: {}, x: 80, y: 120 }],
        edges: [],
      },
      { x: 100, y: 200 }
    );
    expect(nodes[0].position).toEqual({ x: 180, y: 320 });
  });
});

describe("validateConnection", () => {
  const trigger = gnode({ id: "t", kind: "trigger", type: "trigger.new_message" });
  const action = gnode({ id: "a", kind: "action", type: "action.send_message" });
  const ifElse = gnode({ id: "f", kind: "flow", type: "flow.if_else" });

  it("rejects self-loops", () => {
    expect(validateConnection(trigger, trigger, []).ok).toBe(false);
  });

  it("rejects incoming connections to triggers", () => {
    expect(validateConnection(action, trigger, []).ok).toBe(false);
  });

  it("rejects duplicate connections", () => {
    const edges: GraphEdge[] = [{ id: "e1", source: "t", target: "a" }];
    const v = validateConnection(trigger, action, edges);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/already connected/);
  });

  it("rejects cycles", () => {
    const edges: GraphEdge[] = [{ id: "e1", source: "a", target: "t2" }];
    const t2 = gnode({ id: "t2", kind: "action", type: "action.add_tag" });
    const v = validateConnection(t2, trigger, edges);
    // t2 -> trigger is already rejected (trigger incoming); build a real cycle:
    const a2 = gnode({ id: "a2", kind: "action", type: "action.add_tag" });
    const cycle = validateConnection(a2, action, [{ id: "e1", source: "a", target: "a2" }]);
    expect(cycle.ok).toBe(false);
    expect(cycle.reason).toMatch(/cycle/);
  });

  it("suggests true/false labels for if_else branches", () => {
    expect(validateConnection(ifElse, action, []).suggestedLabel).toBe("true");
    const one: GraphEdge[] = [{ id: "e1", source: "f", target: "a", label: "true" }];
    expect(validateConnection(ifElse, gnode({ id: "b", kind: "action", type: "action.add_tag" }), one).suggestedLabel).toBe("false");
  });

  it("rejects connections from disabled nodes", () => {
    const disabled = gnode({ id: "d", disabled: true });
    expect(validateConnection(disabled, action, []).ok).toBe(false);
  });

  it("accepts a normal connection", () => {
    expect(validateConnection(trigger, action, []).ok).toBe(true);
  });
});

describe("duplicateSubgraph", () => {
  it("copies nodes with fresh ids and internal edges only", () => {
    const nodes = [gnode({ id: "a" }), gnode({ id: "b" }), gnode({ id: "c" })];
    const edges: GraphEdge[] = [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "c" },
    ];
    const { nodes: nn, edges: ne } = duplicateSubgraph(nodes, edges, new Set(["a", "b"]));
    expect(nn).toHaveLength(2);
    expect(nn.map((n) => n.id)).not.toContain("a");
    expect(ne).toHaveLength(1); // only a→b is internal
    expect(ne[0].source).toBe(nn[0].id);
  });
});

describe("layoutLayered", () => {
  it("places triggers in the first column", () => {
    const nodes = [
      gnode({ id: "t", kind: "trigger", type: "trigger.new_message", position: { x: 999, y: 999 } }),
      gnode({ id: "a", position: { x: 5, y: 5 } }),
    ];
    const edges: GraphEdge[] = [{ id: "e1", source: "t", target: "a" }];
    const laid = layoutLayered(nodes, edges);
    const t = laid.find((n) => n.id === "t")!;
    const a = laid.find((n) => n.id === "a")!;
    expect(t.position.x).toBe(80);
    expect(a.position.x).toBeGreaterThan(t.position.x);
  });

  it("handles empty graphs", () => {
    expect(layoutLayered([], [])).toEqual([]);
  });
});

describe("linearizeGraph", () => {
  it("orders steps breadth-first from the trigger", () => {
    const nodes = [
      gnode({ id: "t", kind: "trigger", type: "trigger.new_message" }),
      gnode({ id: "a" }),
      gnode({ id: "b" }),
    ];
    const edges: GraphEdge[] = [
      { id: "e1", source: "t", target: "a" },
      { id: "e2", source: "a", target: "b" },
    ];
    const steps = linearizeGraph(nodes, edges);
    expect(steps.map((s) => s.node.id)).toEqual(["t", "a", "b"]);
  });
});

describe("isNodeUnconfigured", () => {
  it("flags missing required config", () => {
    expect(isNodeUnconfigured("trigger.keyword", {})).toBe(true);
    expect(isNodeUnconfigured("trigger.keyword", { keyword: "price" })).toBe(false);
  });

  it("treats unknown types as unconfigured", () => {
    expect(isNodeUnconfigured("nope.nope", {})).toBe(true);
  });
});

describe("HistoryStack", () => {
  it("undo/redo round-trips state", () => {
    const h = new HistoryStack<{ v: number }>();
    expect(h.canUndo).toBe(false);
    h.commit({ v: 1 });
    expect(h.canUndo).toBe(true);
    expect(h.undo({ v: 2 })).toEqual({ v: 1 });
    expect(h.canRedo).toBe(true);
    expect(h.redo({ v: 1 })).toEqual({ v: 2 });
    expect(h.canRedo).toBe(false);
  });

  it("a new commit clears the redo future", () => {
    const h = new HistoryStack<{ v: number }>();
    h.commit({ v: 1 });
    h.undo({ v: 2 });
    h.commit({ v: 3 });
    expect(h.canRedo).toBe(false);
  });

  it("undo on empty history returns null", () => {
    expect(new HistoryStack().undo({})).toBeNull();
  });
});

describe("detectSaveConflict", () => {
  it("detects a newer server version", () => {
    expect(detectSaveConflict("2026-10-19T05:00:00.000Z", "2026-10-19T06:00:00.000Z")).toBe(true);
    expect(detectSaveConflict("2026-10-19T06:00:00.000Z", "2026-10-19T06:00:00.000Z")).toBe(false);
    expect(detectSaveConflict(null, "2026-10-19T06:00:00.000Z")).toBe(false);
  });
});
