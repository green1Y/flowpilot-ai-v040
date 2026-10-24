/**
 * Readiness-report tests: errors block activation, warnings don't.
 */
import { describe, it, expect } from "vitest";
import { readinessReport } from "./readiness";
import type { NodeInput, EdgeInput } from "./validate";

function node(partial: Partial<NodeInput> & { id: string }): NodeInput {
  return {
    kind: "action",
    type: "action.send_message",
    label: partial.id,
    config: { channel: "instagram", body: "Hi" },
    ...partial,
  };
}

const TRIGGER: NodeInput = {
  id: "t1",
  kind: "trigger",
  type: "trigger.new_message",
  label: "New message",
  config: {},
};

function edge(sourceId: string, targetId: string, label = ""): EdgeInput {
  return { id: `e-${sourceId}-${targetId}`, sourceId, targetId, label };
}

describe("readinessReport", () => {
  it("reports ready for a valid workflow", () => {
    const r = readinessReport(
      [TRIGGER, node({ id: "a1" })],
      [edge("t1", "a1")]
    );
    expect(r.ready).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("errors when there is no trigger", () => {
    const r = readinessReport([node({ id: "a1" })], []);
    expect(r.ready).toBe(false);
    expect(r.errors.some((e) => e.message.includes("trigger"))).toBe(true);
  });

  it("errors on cycles", () => {
    const r = readinessReport(
      [TRIGGER, node({ id: "a1" }), node({ id: "a2", type: "action.add_tag", config: { tag: "x" } })],
      [edge("t1", "a1"), edge("a1", "a2"), edge("a2", "a1")]
    );
    expect(r.errors.some((e) => e.message.includes("Cycle"))).toBe(true);
  });

  it("flags disconnected nodes (base validation errors + warning)", () => {
    const r = readinessReport(
      [TRIGGER, node({ id: "a1" }), node({ id: "a2" })],
      [edge("t1", "a1")]
    );
    expect(r.ready).toBe(false); // unreachable nodes are errors in validateWorkflow
    expect(r.warnings.some((w) => w.message.includes("never run"))).toBe(true);
  });

  it("errors when if_else lacks true/false branch labels", () => {
    const r = readinessReport(
      [
        TRIGGER,
        { id: "f1", kind: "flow", type: "flow.if_else", label: "Branch", config: { expression: "leadScore >= 50" } },
        node({ id: "a1" }),
      ],
      [edge("t1", "f1"), edge("f1", "a1", "true")]
    );
    expect(r.errors.some((e) => e.message.includes('"true" and "false"'))).toBe(true);
  });

  it("warns about WhatsApp freeform outside the 24h window", () => {
    const r = readinessReport(
      [TRIGGER, node({ id: "a1", config: { channel: "whatsapp", body: "Hi" } })],
      [edge("t1", "a1")]
    );
    expect(r.warnings.some((w) => w.message.includes("24h"))).toBe(true);
  });

  it("warns on unknown {{variables}}", () => {
    const r = readinessReport(
      [TRIGGER, node({ id: "a1", config: { channel: "instagram", body: "Hi {{unicorn}}" } })],
      [edge("t1", "a1")]
    );
    expect(r.warnings.some((w) => w.message.includes("{{unicorn}}"))).toBe(true);
  });

  it("accepts known {{variables}} without warnings", () => {
    const r = readinessReport(
      [TRIGGER, node({ id: "a1", config: { channel: "instagram", body: "Hi {{name}}, {{text}}" } })],
      [edge("t1", "a1")]
    );
    expect(r.warnings.filter((w) => w.message.includes("{{"))).toHaveLength(0);
  });

  it("warns when messaging credentials are missing", () => {
    const r = readinessReport(
      [TRIGGER, node({ id: "a1" })],
      [edge("t1", "a1")],
      { connectedProviders: [] }
    );
    expect(r.warnings.some((w) => w.message.includes("messages:send"))).toBe(true);
  });

  it("does not warn when a messaging provider is connected", () => {
    const r = readinessReport(
      [TRIGGER, node({ id: "a1" })],
      [edge("t1", "a1")],
      { connectedProviders: ["instagram"] }
    );
    expect(r.warnings.filter((w) => w.message.includes("messages:send"))).toHaveLength(0);
  });

  it("skips config errors for disabled nodes", () => {
    const r = readinessReport(
      [TRIGGER, node({ id: "a1", type: "trigger.keyword", kind: "trigger", config: {}, disabled: true })],
      [edge("t1", "a1")]
    );
    expect(r.errors.filter((e) => e.nodeId === "a1" && e.message.includes("config"))).toHaveLength(0);
    expect(r.warnings.some((w) => w.message.includes("disabled"))).toBe(true);
  });
});
