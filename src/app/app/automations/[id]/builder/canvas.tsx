"use client";

/**
 * Builder canvas: React Flow with memoized node views, keyboard shortcuts,
 * a contextual node menu, empty state, minimap, and auto-layout.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  useReactFlow,
  type NodeProps,
  type Edge,
  type Connection,
  type NodeMouseHandler,
} from "@xyflow/react";
import {
  MessageSquare, MessageCircle, MessagesSquare, UserPlus, Hash, Tag, Tags, Clock,
  Webhook, ShoppingCart, Play, Search, Quote, Sparkles, Gauge, Filter, CalendarClock,
  Brain, BadgeCheck, Send, Reply, Bot, PenLine, UserCheck, StickyNote, Timer, Mail,
  MessageSquareText, Bell, ShieldCheck, Ban, GitBranch, Hourglass, RotateCcw,
  AlarmClock, Fingerprint, TriangleAlert, Flag, Box,
  type LucideIcon,
} from "lucide-react";
import type { BuilderNode, BuilderNodeData } from "./types";
import type { NodeRunState } from "./types";

const ICONS: Record<string, LucideIcon> = {
  MessageSquare, MessageCircle, MessagesSquare, UserPlus, Hash, Tag, Tags, Clock,
  Webhook, ShoppingCart, Play, Search, Quote, Sparkles, Gauge, Filter, CalendarClock,
  Brain, BadgeCheck, Send, Reply, Bot, PenLine, UserCheck, StickyNote, Timer, Mail,
  MessageSquareText, Bell, ShieldCheck, Ban, GitBranch, Hourglass, RotateCcw,
  AlarmClock, Fingerprint, TriangleAlert, Flag, Box,
};

function iconFor(name: string): LucideIcon {
  return ICONS[name] ?? Box;
}

const KIND_STYLES: Record<string, string> = {
  trigger: "border-emerald-400/50 bg-emerald-500/10",
  condition: "border-amber-400/50 bg-amber-500/10",
  action: "border-violet-400/50 bg-violet-500/10",
  flow: "border-sky-400/50 bg-sky-500/10",
};

const KIND_BADGE: Record<string, string> = {
  trigger: "bg-emerald-500/20 text-emerald-300",
  condition: "bg-amber-500/20 text-amber-300",
  action: "bg-violet-500/20 text-violet-300",
  flow: "bg-sky-500/20 text-sky-300",
};

const RUN_RING: Record<string, string> = {
  running: "ring-2 ring-sky-400 animate-pulse",
  success: "ring-2 ring-emerald-400",
  failed: "ring-2 ring-red-400",
};

export type NodeVisualState = "configured" | "unconfigured" | "disabled";

interface FlowNodeViewProps extends NodeProps {
  data: BuilderNodeData & { visualState?: NodeVisualState; runState?: NodeRunState };
  visualStateLabel?: string;
}

/** Memoized: re-renders only when this node's props change (perf on large graphs). */
export const FlowNodeView = memo(function FlowNodeView(props: FlowNodeViewProps) {
  const data = props.data;
  const Icon = iconFor(data.icon);
  const vs = data.visualState ?? "configured";
  const rs = data.runState;
  return (
    <div
      className={`min-w-48 rounded-xl border-2 bg-[var(--fp-card)] px-3 py-2 shadow-lg ${
        KIND_STYLES[data.kind] ?? KIND_STYLES.action
      } ${props.selected ? "ring-2 ring-[var(--fp-accent-2)]" : ""} ${rs ? RUN_RING[rs] ?? "" : ""} ${
        vs === "disabled" ? "opacity-50 saturate-50" : ""
      } ${props.dragging ? "shadow-2xl" : ""}`}
      data-preview={data.preview ? "true" : undefined}
      style={data.preview ? { borderStyle: "dashed", opacity: 0.75 } : undefined}
    >
      <Handle type="target" position={Position.Top} className="!bg-[var(--fp-accent-2)]" />
      <div className="flex items-center gap-2">
        <Icon size={16} className="shrink-0 opacity-80" aria-hidden />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{data.label}</div>
          <div className="text-[11px] text-[var(--fp-text-2)]">{data.nodeType}</div>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1">
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${KIND_BADGE[data.kind] ?? KIND_BADGE.action}`}>
          {data.kind}
        </span>
        {vs === "unconfigured" && (
          <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
            {props.visualStateLabel ?? "needs config"}
          </span>
        )}
        {vs === "disabled" && (
          <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--fp-text-2)]">
            disabled
          </span>
        )}
        {rs && (
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
              rs === "success"
                ? "bg-emerald-500/20 text-emerald-300"
                : rs === "failed"
                  ? "bg-red-500/20 text-red-300"
                  : "bg-sky-500/20 text-sky-300"
            }`}
          >
            {rs}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-[var(--fp-accent)]" />
    </div>
  );
});

export const canvasNodeTypes = { flowNode: FlowNodeView };

export interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
}

interface CanvasProps {
  nodes: BuilderNode[];
  edges: Edge[];
  onNodesChange: (changes: never[]) => void;
  onEdgesChange: (changes: never[]) => void;
  onConnect: (connection: Connection) => void;
  onNodesDelete: (nodes: BuilderNode[]) => void;
  onEdgesDelete: (edges: Edge[]) => void;
  onNodeClick: (node: BuilderNode) => void;
  onEdgeClick: (edge: Edge) => void;
  onPaneClick: () => void;
  onDrop: (e: React.DragEvent) => void;
  onNodeDragStart: () => void;
  onNodeDragStop: () => void;
  onKeyAction: (action: "undo" | "redo" | "duplicate" | "copy" | "paste" | "delete") => void;
  setContextMenu: (m: ContextMenuState | null) => void;
  emptyStateHint: string;
  rtl: boolean;
}

export function BuilderCanvas(props: CanvasProps) {
  const { setContextMenu, onKeyAction } = props;
  const wrapRef = useRef<HTMLDivElement>(null);

  const onNodeContextMenu: NodeMouseHandler = useCallback(
    (event, node) => {
      event.preventDefault();
      const rect = wrapRef.current?.getBoundingClientRect();
      setContextMenu({
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
        nodeId: node.id,
      });
    },
    [setContextMenu]
  );

  // Keyboard shortcuts — ignored while typing in inputs/textareas/selects.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || t?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        onKeyAction("undo");
      } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        onKeyAction("redo");
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        onKeyAction("duplicate");
      } else if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        onKeyAction("copy");
      } else if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        onKeyAction("paste");
      } else if (e.key === "Delete" || e.key === "Backspace") {
        // Let React Flow's own deleteKeyCode handle in-canvas deletion when
        // nodes/edges are selected; otherwise ignore.
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [onKeyAction]);

  return (
    <div ref={wrapRef} className="relative h-full w-full" tabIndex={0} aria-label="Workflow canvas">
      <ReactFlow
        nodes={props.nodes}
        edges={props.edges}
        onNodesChange={props.onNodesChange as never}
        onEdgesChange={props.onEdgesChange as never}
        onConnect={props.onConnect as never}
        onNodesDelete={props.onNodesDelete as never}
        onEdgesDelete={props.onEdgesDelete as never}
        onNodeClick={(_, node) => props.onNodeClick(node as BuilderNode)}
        onEdgeClick={(_, edge) => props.onEdgeClick(edge)}
        onPaneClick={props.onPaneClick}
        onNodeContextMenu={onNodeContextMenu}
        onDrop={props.onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onNodeDragStart={props.onNodeDragStart}
        onNodeDragStop={props.onNodeDragStop}
        nodeTypes={canvasNodeTypes}
        fitView
        colorMode="dark"
        deleteKeyCode={["Backspace", "Delete"]}
        multiSelectionKeyCode={["Shift", "Meta"]}
        minZoom={0.2}
        maxZoom={2}
      >
        <MiniMap pannable zoomable aria-label="Minimap" />
        <Controls showInteractive={false} />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      </ReactFlow>
      {props.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="max-w-xs rounded-2xl border border-dashed border-[var(--fp-border)] bg-[var(--fp-card)]/80 p-6 text-center">
            <p className="text-sm text-[var(--fp-text-2)]">{props.emptyStateHint}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Fit the canvas to the graph (used by the fit-to-screen button). */
export function useFitView() {
  const { fitView } = useReactFlow();
  return useCallback(() => fitView({ padding: 0.2, duration: 200 }), [fitView]);
}
