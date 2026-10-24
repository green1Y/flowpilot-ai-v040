/**
 * Copilot spec validation tests: the server-side trust boundary that
 * guarantees the model can only produce registered node types.
 */
import { describe, it, expect } from "vitest";
import {
  validateAndRepairSpec,
  validateAndRepairFragment,
  parseModelSpec,
} from "./spec";

const GOOD_SPEC = {
  nodes: [
    { id: "t1", kind: "trigger", type: "trigger.new_message", label: "New message", config: {}, x: 80, y: 120 },
    { id: "a1", kind: "action", type: "action.send_message", label: "Reply", config: { channel: "instagram", body: "Hi!" }, x: 340, y: 120 },
  ],
  edges: [{ sourceId: "t1", targetId: "a1", label: "" }],
};

describe("validateAndRepairSpec", () => {
  it("accepts a valid spec unchanged", () => {
    const v = validateAndRepairSpec(GOOD_SPEC);
    expect(v.ok).toBe(true);
    expect(v.spec!.nodes).toHaveLength(2);
    expect(v.repaired).toHaveLength(0);
  });

  it("rejects unknown node types and drops their edges", () => {
    const v = validateAndRepairSpec({
      nodes: [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "T", config: {}, x: 80, y: 120 },
        { id: "x1", kind: "action", type: "action.teleport", label: "Fake", config: {}, x: 340, y: 120 },
      ],
      edges: [{ sourceId: "t1", targetId: "x1", label: "" }],
    });
    expect(v.ok).toBe(true); // repaired, not rejected outright
    expect(v.spec!.nodes.map((n) => n.id)).toEqual(["t1"]);
    expect(v.spec!.edges).toHaveLength(0);
    expect(v.repaired.join(" ")).toContain("action.teleport");
  });

  it("rejects the spec when nothing valid remains", () => {
    const v = validateAndRepairSpec({
      nodes: [{ id: "x1", kind: "action", type: "nope.nope", label: "Fake", config: {}, x: 0, y: 0 }],
      edges: [],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it("rejects a spec with no trigger", () => {
    const v = validateAndRepairSpec({
      nodes: [{ id: "a1", kind: "action", type: "action.send_message", label: "R", config: { channel: "instagram", body: "Hi" }, x: 80, y: 120 }],
      edges: [],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain("trigger");
  });

  it("fixes kind mismatches against the registry", () => {
    const v = validateAndRepairSpec({
      nodes: [
        { id: "t1", kind: "action", type: "trigger.new_message", label: "T", config: {}, x: 80, y: 120 },
      ],
      edges: [],
    });
    expect(v.ok).toBe(true);
    expect(v.spec!.nodes[0].kind).toBe("trigger");
    expect(v.repaired.join(" ")).toContain("kind fixed");
  });

  it("drops nodes with invalid config", () => {
    const v = validateAndRepairSpec({
      nodes: [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "T", config: {}, x: 80, y: 120 },
        // keyword is required for trigger.keyword
        { id: "k1", kind: "trigger", type: "trigger.keyword", label: "K", config: {}, x: 340, y: 120 },
      ],
      edges: [],
    });
    expect(v.ok).toBe(true);
    expect(v.spec!.nodes.map((n) => n.id)).toEqual(["t1"]);
  });

  it("removes self-loops and duplicate node ids", () => {
    const v = validateAndRepairSpec({
      nodes: [
        { id: "t1", kind: "trigger", type: "trigger.new_message", label: "T", config: {}, x: 80, y: 120 },
        { id: "t1", kind: "action", type: "action.send_message", label: "Dup", config: { channel: "instagram", body: "Hi" }, x: 340, y: 120 },
      ],
      edges: [{ sourceId: "t1", targetId: "t1", label: "" }],
    });
    expect(v.ok).toBe(true);
    expect(v.spec!.nodes).toHaveLength(1);
    expect(v.spec!.edges).toHaveLength(0);
  });

  it("rejects non-JSON model output", () => {
    const v = parseModelSpec("not json at all {{{");
    expect(v.ok).toBe(false);
  });

  it("strips code fences from model output", () => {
    const v = parseModelSpec("```json\n" + JSON.stringify(GOOD_SPEC) + "\n```");
    expect(v.ok).toBe(true);
  });
});

describe("validateAndRepairFragment", () => {
  it("accepts fragments without their own trigger", () => {
    const v = validateAndRepairFragment(
      {
        nodes: [
          { id: "n_new_1", kind: "flow", type: "flow.delay", label: "Wait", config: { seconds: 60 }, x: 600, y: 120 },
        ],
        edges: [{ sourceId: "a1", targetId: "n_new_1", label: "" }],
      },
      new Set(["t1", "a1"])
    );
    expect(v.ok).toBe(true);
    expect(v.spec!.nodes).toHaveLength(1);
  });

  it("renames fragment node ids that collide with the existing graph", () => {
    const v = validateAndRepairFragment(
      {
        nodes: [
          { id: "a1", kind: "flow", type: "flow.delay", label: "Wait", config: { seconds: 60 }, x: 600, y: 120 },
        ],
        edges: [],
      },
      new Set(["t1", "a1"])
    );
    expect(v.ok).toBe(true);
    expect(v.spec!.nodes[0].id).not.toBe("a1");
  });
});
