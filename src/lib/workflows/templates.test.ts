/**
 * Template tests: all 15 templates must pass server-side validation and
 * produce a ready (error-free) readiness report, so inserting any of them
 * yields a real, activatable workflow.
 */
import { describe, it, expect } from "vitest";
import { TEMPLATES, templateToSpec } from "./templates";
import { validateAndRepairSpec } from "@/lib/copilot/spec";
import { validateWorkflow } from "./validate";
import { readinessReport } from "./readiness";

describe("workflow templates", () => {
  it("ships exactly 15 templates", () => {
    expect(TEMPLATES).toHaveLength(15);
  });

  for (const tpl of TEMPLATES) {
    it(`"${tpl.id}" passes spec validation`, () => {
      const spec = templateToSpec(tpl);
      const v = validateAndRepairSpec(spec);
      expect(v.ok).toBe(true);
      expect(v.errors).toHaveLength(0);
    });

    it(`"${tpl.id}" passes validateWorkflow()`, () => {
      const spec = templateToSpec(tpl);
      const { valid, errors } = validateWorkflow(
        spec.nodes.map((n) => ({ id: n.id, kind: n.kind, type: n.type, label: n.label, config: n.config })),
        spec.edges.map((e, i) => ({ id: `e${i}`, sourceId: e.sourceId, targetId: e.targetId, label: e.label }))
      );
      expect(errors).toHaveLength(0);
      expect(valid).toBe(true);
    });

    it(`"${tpl.id}" has no readiness errors`, () => {
      const spec = templateToSpec(tpl);
      const r = readinessReport(
        spec.nodes.map((n) => ({ id: n.id, kind: n.kind, type: n.type, label: n.label, config: n.config })),
        spec.edges.map((e, i) => ({ id: `e${i}`, sourceId: e.sourceId, targetId: e.targetId, label: e.label }))
      );
      expect(r.errors).toHaveLength(0);
    });
  }
});
