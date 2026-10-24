import { describe, it, expect } from "vitest";
import { validateWorkflow } from "./validate";

function node(id: string, type: string, config: Record<string, unknown> = {}) {
  return { id, kind: type.split(".")[0], type, label: `Node ${id}`, config };
}

function edge(id: string, sourceId: string, targetId: string, label = "") {
  return { id, sourceId, targetId, label };
}

describe("validateWorkflow", () => {
  it("rejects a workflow with no trigger", () => {
    const { valid, errors } = validateWorkflow(
      [node("a1", "action.send_message", { channel: "instagram", body: "hi" })],
      []
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.message.includes("at least one trigger"))).toBe(true);
  });

  it("rejects unreachable nodes", () => {
    const { valid, errors } = validateWorkflow(
      [
        node("t1", "trigger.new_message"),
        node("a1", "action.send_message", { channel: "instagram", body: "hi" }),
        node("a2", "action.add_tag", { tag: "x" }),
      ],
      [edge("e1", "t1", "a1")]
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.nodeId === "a2" && e.message.includes("unreachable"))).toBe(true);
  });

  it("rejects missing required config", () => {
    const { valid, errors } = validateWorkflow(
      [
        node("t1", "trigger.new_message"),
        node("a1", "action.send_message", { channel: "instagram" }), // body missing
      ],
      [edge("e1", "t1", "a1")]
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.nodeId === "a1" && e.message.includes("body"))).toBe(true);
  });

  it("rejects an unsupported channel on send_message", () => {
    const { valid, errors } = validateWorkflow(
      [
        node("t1", "trigger.new_message"),
        node("a1", "action.send_message", { channel: "carrier-pigeon", body: "hi" }),
      ],
      [edge("e1", "t1", "a1")]
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.nodeId === "a1" && e.message.includes("not supported"))).toBe(true);
  });

  it("rejects unknown node types", () => {
    const { valid, errors } = validateWorkflow(
      [node("t1", "trigger.new_message"), node("x1", "action.teleport", {})],
      [edge("e1", "t1", "x1")]
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.message.includes("unknown node type"))).toBe(true);
  });

  it("rejects self-loops", () => {
    const { valid, errors } = validateWorkflow(
      [node("t1", "trigger.new_message")],
      [edge("e1", "t1", "t1")]
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.message.includes("self-loop"))).toBe(true);
  });

  it("rejects triggers with no outgoing edge", () => {
    const { valid, errors } = validateWorkflow([node("t1", "trigger.new_message")], []);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.nodeId === "t1" && e.message.includes("no outgoing edge"))).toBe(true);
  });

  it("rejects flow.if_else without true/false labeled edges", () => {
    const { valid, errors } = validateWorkflow(
      [
        node("t1", "trigger.new_message"),
        node("f1", "flow.if_else", { expression: "leadScore >= 50" }),
        node("a1", "action.end"),
      ],
      [edge("e1", "t1", "f1"), edge("e2", "f1", "a1")]
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.nodeId === "f1" && e.message.includes('"true" and "false"'))).toBe(true);
  });

  it("accepts a valid template-like graph", () => {
    const { valid, errors } = validateWorkflow(
      [
        node("t1", "trigger.new_message"),
        node("c1", "condition.keyword_contains", { keyword: "price" }),
        node("a1", "action.send_message", { channel: "instagram", body: "Here is our pricing!" }),
        node("a2", "action.add_tag", { tag: "pricing-interest" }),
      ],
      [edge("e1", "t1", "c1"), edge("e2", "c1", "a1"), edge("e3", "a1", "a2")]
    );
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("accepts a valid if_else graph with true/false branches", () => {
    const { valid, errors } = validateWorkflow(
      [
        node("t1", "trigger.new_lead"),
        node("f1", "flow.if_else", { expression: "leadScore >= 70" }),
        node("a1", "action.assign_conversation", { assignee: "sales" }),
        node("a2", "action.add_tag", { tag: "nurture" }),
      ],
      [
        edge("e1", "t1", "f1"),
        edge("e2", "f1", "a1", "true"),
        edge("e3", "f1", "a2", "false"),
      ]
    );
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });
});
