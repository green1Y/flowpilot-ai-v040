"use client";

/**
 * Simple mode: a linear step list of the same graph.
 * Same data, same selection/config path — switching never loses data.
 */
import type { Edge } from "@xyflow/react";
import { ArrowDown, CircleAlert } from "lucide-react";
import type { BuilderNode } from "./types";
import { linearizeGraph } from "@/lib/workflows/graphModel";
import { isNodeUnconfigured } from "@/lib/workflows/graphModel";
import { useBuilderLocale } from "./i18n";

const KIND_DOT: Record<string, string> = {
  trigger: "bg-emerald-400",
  condition: "bg-amber-400",
  action: "bg-violet-400",
  flow: "bg-sky-400",
};

interface SimpleModeProps {
  nodes: BuilderNode[];
  edges: Edge[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

export function SimpleMode({ nodes, edges, selectedNodeId, onSelectNode }: SimpleModeProps) {
  const { t, rtl } = useBuilderLocale();
  const s = t.builder.simple;
  const steps = linearizeGraph(
    nodes.map((n) => ({
      id: n.id,
      kind: n.data.kind,
      type: n.data.nodeType,
      label: n.data.label,
      config: n.data.config,
      position: n.position,
    })),
    edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: typeof e.label === "string" ? e.label : "" }))
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div className="h-full overflow-y-auto p-6" dir={rtl ? "rtl" : "ltr"}>
      <div className="mx-auto max-w-2xl">
        <h2 className="mb-1 text-lg font-semibold">{s.title}</h2>
        <p className="mb-6 text-sm text-[var(--fp-text-2)]">{s.hint}</p>
        {steps.length === 0 && <p className="text-sm text-[var(--fp-text-2)]">{s.empty}</p>}
        <ol className="space-y-0">
          {steps.map(({ node }, i) => {
            const full = byId.get(node.id);
            const unconfigured = full ? isNodeUnconfigured(full.data.nodeType, full.data.config) : false;
            const selected = selectedNodeId === node.id;
            return (
              <li key={node.id}>
                <button
                  onClick={() => onSelectNode(node.id)}
                  aria-current={selected}
                  className={`flex w-full items-center gap-3 rounded-2xl border p-4 text-start transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)] ${
                    selected
                      ? "border-[var(--fp-accent)] bg-[var(--fp-accent)]/10"
                      : "border-[var(--fp-border)] bg-[var(--fp-card)] hover:border-[var(--fp-accent)]/50"
                  }`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/5 font-mono text-xs font-bold">
                    {i + 1}
                  </span>
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${KIND_DOT[node.kind] ?? "bg-white/20"}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{node.label}</span>
                    <span className="block font-mono text-xs text-[var(--fp-text-2)]">
                      {node.type} · {node.kind}
                    </span>
                  </span>
                  {full?.data.disabled && (
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-[var(--fp-text-2)]">
                      {t.builder.nodeStates.disabled}
                    </span>
                  )}
                  {unconfigured && (
                    <span className="flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                      <CircleAlert size={10} /> {t.builder.nodeStates.unconfigured}
                    </span>
                  )}
                </button>
                {i < steps.length - 1 && (
                  <div className="flex justify-center py-1" aria-hidden>
                    <ArrowDown size={16} className="text-[var(--fp-text-2)]" />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
