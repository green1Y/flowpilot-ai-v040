"use client";

/**
 * Workflow Builder Pro — n8n-inspired visual editor.
 *
 * - Toolbar: editable name/description, autosave indicator, readiness badge,
 *   undo/redo, Test + Simulate, activate/deactivate (blocked on errors),
 *   settings menu, Simple/Advanced toggle, AI copilot toggle
 * - Canvas: React Flow, drag-drop palette, keyboard shortcuts, context menu,
 *   auto-layout, minimap, empty state, memoized nodes, run overlay
 * - Config panel: schema form, credential picker, {{variable}} mapping,
 *   upstream preview, Test Step, permission warnings
 * - Copilot: ghost preview with Accept/Reject (undoable)
 * - Run inspector: history, per-node status/duration/IO, safe retry
 *
 * All state mutations go through commit() → undoable. Saves are debounced,
 * conflict-safe (expectedUpdatedAt), and flushed on unload.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ReactFlowProvider,
  useReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
  type Edge,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { NODE_TYPES } from "@/lib/workflows/nodeRegistry";
import { readinessReport, type ReadinessReport } from "@/lib/workflows/readiness";
import {
  HistoryStack,
  nodeFromType,
  specToGraph,
  duplicateSubgraph,
  validateConnection,
  layoutLayered,
  isNodeUnconfigured,
  type GraphNode,
  type GraphEdge,
} from "@/lib/workflows/graphModel";
import { validateAndRepairSpec } from "@/lib/copilot/spec";
import { templateToSpec, type WorkflowTemplate } from "@/lib/workflows/templates";
import type {
  BuilderNode,
  BuilderNodeData,
  WorkflowMeta,
  SaveState,
  IntegrationRef,
  ApiNode,
  ApiEdge,
  NodeRunState,
} from "./types";
import { useBuilderLocale } from "./i18n";
import { BuilderToolbar } from "./toolbar";
import { NodePalette } from "./palette";
import { BuilderCanvas, type ContextMenuState } from "./canvas";
import { NodeConfigPanel, EdgeConfigPanel } from "./configPanel";
import { CopilotPanel, type CopilotPreview } from "./copilotPanel";
import { RunInspector } from "./runInspector";
import { SimpleMode } from "./simpleMode";
import {
  TemplateGallery,
  DescriptionEditor,
  DeleteConfirm,
  ShortcutsDialog,
  TestModal,
  SimulateModal,
} from "./dialogs";

// ── API mapping ──────────────────────────────────────────────────────────

function apiToFlow(nodes: ApiNode[], edges: ApiEdge[]): { nodes: BuilderNode[]; edges: Edge[] } {
  return {
    nodes: nodes.map((n) => {
      const def = NODE_TYPES[n.type];
      return {
        id: n.id,
        type: "flowNode",
        position: n.position ?? { x: 0, y: 0 },
        data: {
          label: n.label,
          kind: n.kind,
          nodeType: n.type,
          config: n.config ?? {},
          icon: def?.icon ?? "Box",
          description: def?.description ?? "",
          disabled: n.disabled ?? false,
        } as BuilderNodeData,
      };
    }),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      label: e.label || "",
    })),
  };
}

function flowToApi(nodes: BuilderNode[], edges: Edge[]): { nodes: ApiNode[]; edges: ApiEdge[] } {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: String(n.data.kind),
      type: String(n.data.nodeType),
      label: String(n.data.label),
      config: (n.data.config ?? {}) as Record<string, unknown>,
      position: { x: n.position.x, y: n.position.y },
      disabled: !!n.data.disabled,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sourceId: e.source,
      targetId: e.target,
      label: typeof e.label === "string" ? e.label : "",
      condition: {},
    })),
  };
}

function toGraphNode(n: BuilderNode): GraphNode {
  return {
    id: n.id,
    kind: String(n.data.kind),
    type: String(n.data.nodeType),
    label: String(n.data.label),
    config: (n.data.config ?? {}) as Record<string, unknown>,
    position: n.position,
    disabled: !!n.data.disabled,
  };
}

function toGraphEdge(e: Edge): GraphEdge {
  return { id: e.id, source: e.source, target: e.target, label: typeof e.label === "string" ? e.label : "" };
}

// ── Builder ──────────────────────────────────────────────────────────────

const EMPTY_READINESS: ReadinessReport = { errors: [], warnings: [], ready: true };

function BuilderInner({ workflowId }: { workflowId: string }) {
  const router = useRouter();
  const { t, rtl } = useBuilderLocale();
  const b = t.builder;
  const { screenToFlowPosition, setCenter, fitView } = useReactFlow();

  const [meta, setMeta] = useState<WorkflowMeta | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<BuilderNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [serverUpdatedAt, setServerUpdatedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [simpleMode, setSimpleMode] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [preview, setPreview] = useState<CopilotPreview | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationRef[]>([]);
  const [runOverlay, setRunOverlay] = useState<Record<string, NodeRunState>>({});

  // Dialogs
  const [testOpen, setTestOpen] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const nodesRef = useRef<BuilderNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const metaRef = useRef<WorkflowMeta | null>(null);
  const dirtyRef = useRef(false);
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const histRef = useRef(new HistoryStack<{ nodes: BuilderNode[]; edges: Edge[] }>());
  const [, setHistTick] = useState(0);
  const clipboardRef = useRef<{ nodes: BuilderNode[]; edges: Edge[] } | null>(null);
  const dragStartRef = useRef<{ nodes: BuilderNode[]; edges: Edge[] } | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);
  useEffect(() => {
    metaRef.current = meta;
  }, [meta]);

  // ── History ──
  const commit = useCallback(
    (n: BuilderNode[], e: Edge[]) => {
      histRef.current.commit({ nodes: nodesRef.current, edges: edgesRef.current });
      setNodes(n);
      setEdges(e);
      dirtyRef.current = true;
      scheduleAutosave();
      setHistTick((x) => x + 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setNodes, setEdges]
  );

  const undo = useCallback(() => {
    const prev = histRef.current.undo({ nodes: nodesRef.current, edges: edgesRef.current });
    if (!prev) return;
    setNodes(prev.nodes);
    setEdges(prev.edges);
    dirtyRef.current = true;
    scheduleAutosave();
    setHistTick((x) => x + 1);
  }, [setNodes, setEdges]); // eslint-disable-line react-hooks/exhaustive-deps

  const redo = useCallback(() => {
    const next = histRef.current.redo({ nodes: nodesRef.current, edges: edgesRef.current });
    if (!next) return;
    setNodes(next.nodes);
    setEdges(next.edges);
    dirtyRef.current = true;
    scheduleAutosave();
    setHistTick((x) => x + 1);
  }, [setNodes, setEdges]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Autosave (debounced, conflict-safe, flushed on unload) ──
  const doSave = useCallback(
    async (isUnload = false) => {
      const m = metaRef.current;
      if (!m || !dirtyRef.current) return;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (!isUnload) setSaveState("saving");
      try {
        const payload = flowToApi(nodesRef.current, edgesRef.current);
        const res = await fetch(`/api/workflows/${workflowId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: m.name,
            description: m.description,
            nodes: payload.nodes,
            edges: payload.edges,
            expectedUpdatedAt: m.updatedAt,
          }),
          ...(isUnload ? { keepalive: true } : {}),
        });
        const json = await res.json();
        if (res.status === 409) {
          setSaveState("conflict");
          setServerUpdatedAt(json.serverUpdatedAt ?? null);
          return;
        }
        if (!json.ok) throw new Error(json.error ?? "Save failed");
        dirtyRef.current = false;
        setMeta((prev) =>
          prev ? { ...prev, version: json.data.version, updatedAt: json.data.updatedAt } : prev
        );
        if (!isUnload) {
          setSaveState("saved");
          setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500);
        }
      } catch (e) {
        if (!isUnload) {
          setSaveState("error");
          setNotice(e instanceof Error ? e.message : "Save failed");
        }
      }
    },
    [workflowId]
  );

  function scheduleAutosave() {
    if (!loadedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveState((s) => (s === "conflict" ? s : "idle"));
    saveTimerRef.current = setTimeout(() => doSave(false), 1200);
  }

  // Flush on unload.
  useEffect(() => {
    const onUnload = () => {
      if (dirtyRef.current) void doSave(true);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [doSave]);

  async function resolveConflict(keepMine: boolean) {
    if (keepMine) {
      // Force-save over the server version with the fresh timestamp.
      setMeta((m) => (m ? { ...m, updatedAt: serverUpdatedAt } : m));
      metaRef.current = metaRef.current ? { ...metaRef.current, updatedAt: serverUpdatedAt } : metaRef.current;
      setSaveState("idle");
      dirtyRef.current = true;
      await doSave(false);
    } else {
      await reloadWorkflow();
      setSaveState("idle");
    }
    setServerUpdatedAt(null);
  }

  // ── Load ──
  const reloadWorkflow = useCallback(async () => {
    const res = await fetch(`/api/workflows/${workflowId}`);
    const json = await res.json();
    if (!json.ok) {
      setNotice(json.error ?? "Failed to load workflow");
      return;
    }
    setMeta({
      id: json.data.id,
      name: json.data.name,
      description: json.data.description ?? "",
      status: json.data.status,
      version: json.data.version,
      updatedAt: json.data.updatedAt ?? null,
    });
    const { nodes: n, edges: e } = apiToFlow(json.data.nodes, json.data.edges);
    histRef.current.clear();
    setNodes(n);
    setEdges(e);
    dirtyRef.current = false;
    loadedRef.current = true;
    setHistTick((x) => x + 1);
  }, [workflowId, setNodes, setEdges]);

  useEffect(() => {
    void reloadWorkflow();
  }, [reloadWorkflow]);

  // Integrations (names/ids only — the API never returns secrets).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/integrations");
        const json = await res.json();
        if (json.ok) {
          setIntegrations(
            (json.data.integrations as IntegrationRef[]).map((i) => ({
              id: i.id,
              provider: i.provider,
              displayName: i.displayName,
              connectionState: i.connectionState,
            }))
          );
        }
      } catch {
        /* non-fatal */
      }
    })();
  }, []);

  const connectedProviders = useMemo(
    () =>
      integrations
        .filter((i) => i.connectionState === "CONNECTED" || i.connectionState === "connected")
        .map((i) => i.provider),
    [integrations]
  );

  // ── Readiness ──
  const readiness: ReadinessReport = useMemo(() => {
    if (!loadedRef.current) return EMPTY_READINESS;
    const payload = flowToApi(nodesRef.current, edgesRef.current);
    return readinessReport(payload.nodes, payload.edges, { connectedProviders });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, connectedProviders]);

  const fixIssue = useCallback(
    (nodeId?: string) => {
      if (!nodeId) return;
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (!n) return;
      setSelectedNodeId(nodeId);
      setSelectedEdgeId(null);
      setSimpleMode(false);
      setCenter(n.position.x + 100, n.position.y + 40, { zoom: 1, duration: 300 });
    },
    [setCenter]
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null;

  // ── Canvas interactions ────────────────────────────────────────────

  const addNodeAt = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      const g = nodeFromType(type);
      if (!g) return;
      const def = NODE_TYPES[type];
      const pos = position ?? {
        x: 120 + Math.random() * 240,
        y: 120 + Math.random() * 240,
      };
      const node: BuilderNode = {
        id: g.id,
        type: "flowNode",
        position: pos,
        data: {
          label: g.label,
          kind: g.kind,
          nodeType: g.type,
          config: g.config,
          icon: def?.icon ?? "Box",
          description: def?.description ?? "",
          disabled: false,
        },
      };
      commit([...nodesRef.current, node], edgesRef.current);
      setSelectedNodeId(node.id);
      setSelectedEdgeId(null);
    },
    [commit]
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/flowpilot-node");
      if (!type) return;
      addNodeAt(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [addNodeAt, screenToFlowPosition]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const source = nodesRef.current.find((n) => n.id === connection.source);
      const target = nodesRef.current.find((n) => n.id === connection.target);
      if (!source || !target) return;
      const verdict = validateConnection(toGraphNode(source), toGraphNode(target), edgesRef.current.map(toGraphEdge));
      if (!verdict.ok) {
        setNotice(verdict.reason ?? "Connection not allowed");
        return;
      }
      commit(
        nodesRef.current,
        addEdge({ ...connection, label: verdict.suggestedLabel ?? "" }, edgesRef.current)
      );
    },
    [commit]
  );

  const deleteNodes = useCallback(
    (toDelete: BuilderNode[]) => {
      const ids = new Set(toDelete.map((n) => n.id));
      commit(
        nodesRef.current.filter((n) => !ids.has(n.id)),
        edgesRef.current.filter((e) => !ids.has(e.source) && !ids.has(e.target))
      );
      setSelectedNodeId(null);
    },
    [commit]
  );

  const deleteEdges = useCallback(
    (toDelete: Edge[]) => {
      const ids = new Set(toDelete.map((e) => e.id));
      commit(
        nodesRef.current,
        edgesRef.current.filter((e) => !ids.has(e.id))
      );
      setSelectedEdgeId(null);
    },
    [commit]
  );

  // Keyboard actions: duplicate / copy / paste.
  const onKeyAction = useCallback(
    (action: "undo" | "redo" | "duplicate" | "copy" | "paste" | "delete") => {
      if (action === "undo") return undo();
      if (action === "redo") return redo();
      const selected = nodesRef.current.filter((n) => n.selected);
      if (action === "copy") {
        if (selected.length === 0) return;
        const ids = new Set(selected.map((n) => n.id));
        clipboardRef.current = {
          nodes: selected,
          edges: edgesRef.current.filter((e) => ids.has(e.source) && ids.has(e.target)),
        };
        setNotice(`${selected.length} node${selected.length === 1 ? "" : "s"} copied.`);
        return;
      }
      if (action === "paste") {
        const clip = clipboardRef.current;
        if (!clip || clip.nodes.length === 0) return;
        const ids = new Set(clip.nodes.map((n) => n.id));
        const srcByLabel = new Map(clip.nodes.map((n) => [n.data.label, n]));
        const { nodes: nn, edges: ne } = duplicateSubgraph(
          clip.nodes.map(toGraphNode),
          clip.edges.map(toGraphEdge),
          ids,
          { x: 60, y: 60 }
        );
        const newNodes: BuilderNode[] = nn.map((g) => {
          const src = srcByLabel.get(g.label.replace(/ \(copy\)$/, ""));
          const d = src ? NODE_TYPES[String(src.data.nodeType)] : undefined;
          return {
            id: g.id,
            type: "flowNode",
            position: g.position,
            data: {
              label: g.label,
              kind: g.kind,
              nodeType: g.type,
              config: g.config,
              icon: d?.icon ?? "Box",
              description: d?.description ?? "",
              disabled: g.disabled ?? false,
            } as BuilderNodeData,
          };
        });
        commit([...nodesRef.current, ...newNodes], [...edgesRef.current, ...ne.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label ?? "" } as Edge))]);
        return;
      }
      if (action === "duplicate") {
        if (selected.length === 0) return;
        const ids = new Set(selected.map((n) => n.id));
        const { nodes: nn, edges: ne } = duplicateSubgraph(
          selected.map(toGraphNode),
          edgesRef.current.map(toGraphEdge),
          ids
        );
        const newNodes: BuilderNode[] = nn.map((g) => {
          const d = NODE_TYPES[g.type];
          return {
            id: g.id,
            type: "flowNode",
            position: g.position,
            selected: true,
            data: {
              label: g.label,
              kind: g.kind,
              nodeType: g.type,
              config: g.config,
              icon: d?.icon ?? "Box",
              description: d?.description ?? "",
              disabled: g.disabled ?? false,
            } as BuilderNodeData,
          };
        });
        const newEdges: Edge[] = ne.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label ?? "" }));
        commit(
          [...nodesRef.current.map((n) => ({ ...n, selected: false })), ...newNodes],
          [...edgesRef.current, ...newEdges]
        );
        return;
      }
      if (action === "delete") {
        const selNodes = nodesRef.current.filter((n) => n.selected);
        const selEdges = edgesRef.current.filter((e) => e.selected);
        if (selNodes.length) deleteNodes(selNodes);
        else if (selEdges.length) deleteEdges(selEdges);
      }
    },
    [undo, redo, commit, deleteNodes, deleteEdges]
  );

  // Context menu actions.
  function contextAction(action: "configure" | "duplicate" | "toggleDisable" | "delete") {
    const m = contextMenu;
    setContextMenu(null);
    if (!m) return;
    const node = nodesRef.current.find((n) => n.id === m.nodeId);
    if (!node) return;
    if (action === "configure") {
      setSelectedNodeId(node.id);
      setSelectedEdgeId(null);
    } else if (action === "delete") {
      deleteNodes([node]);
    } else if (action === "toggleDisable") {
      commit(
        nodesRef.current.map((n) =>
          n.id === node.id ? { ...n, data: { ...n.data, disabled: !n.data.disabled } } : n
        ),
        edgesRef.current
      );
      setNotice(`"${node.data.label}" ${node.data.disabled ? "enabled" : "disabled"}.`);
    } else if (action === "duplicate") {
      const { nodes: nn } = duplicateSubgraph([toGraphNode(node)], [], new Set([node.id]));
      const g = nn[0];
      const d = NODE_TYPES[g.type];
      commit(
        [
          ...nodesRef.current,
          {
            id: g.id,
            type: "flowNode",
            position: g.position,
            data: {
              label: g.label,
              kind: g.kind,
              nodeType: g.type,
              config: g.config,
              icon: d?.icon ?? "Box",
              description: d?.description ?? "",
              disabled: g.disabled ?? false,
            } as BuilderNodeData,
          },
        ],
        edgesRef.current
      );
    }
  }

  function applyAutoLayout() {
    const laid = layoutLayered(
      nodesRef.current.map(toGraphNode),
      edgesRef.current.map(toGraphEdge)
    );
    const pos = new Map(laid.map((n) => [n.id, n.position]));
    commit(
      nodesRef.current.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })),
      edgesRef.current
    );
    setNotice("Auto-layout applied.");
    fitView({ padding: 0.2, duration: 200 });
  }

  // ── Template insert (same spec path as copilot output) ──
  function insertTemplate(tpl: WorkflowTemplate) {
    const spec = templateToSpec(tpl);
    const v = validateAndRepairSpec(spec);
    if (!v.ok || !v.spec) {
      setNotice(`Template "${tpl.name}" failed validation: ${v.errors.join("; ")}`);
      return;
    }
    const { nodes: nn, edges: ne } = specToGraph(v.spec, { x: 60, y: 320 });
    const newNodes: BuilderNode[] = nn.map((g) => {
      const d = NODE_TYPES[g.type];
      return {
        id: g.id,
        type: "flowNode",
        position: g.position,
        data: {
          label: g.label,
          kind: g.kind,
          nodeType: g.type,
          config: g.config,
          icon: d?.icon ?? "Box",
          description: d?.description ?? "",
          disabled: false,
        } as BuilderNodeData,
      };
    });
    const newEdges: Edge[] = ne.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label ?? "" }));
    commit([...nodesRef.current, ...newNodes], [...edgesRef.current, ...newEdges]);
    setTemplatesOpen(false);
    setNotice(`Inserted template "${tpl.name}" — ${newNodes.length} nodes.`);
  }

  // ── Copilot preview ──
  function acceptPreview(p: CopilotPreview) {
    if (p.labelUpdates) {
      const updates = p.labelUpdates;
      commit(
        nodesRef.current.map((n) =>
          updates[n.id] ? { ...n, data: { ...n.data, label: updates[n.id] } } : n
        ),
        edgesRef.current
      );
      setNotice(`Translated ${Object.keys(updates).length} labels.`);
    } else {
      const real: BuilderNode[] = p.nodes.map((n) => {
        const d = NODE_TYPES[String(n.data.nodeType)];
        const { preview: _pv, ...rest } = n.data;
        void _pv;
        return {
          ...n,
          data: { ...rest, icon: d?.icon ?? "Sparkles", description: d?.description ?? "" },
        };
      });
      const realEdges: Edge[] = p.edges.map((e) => ({ ...e, style: undefined, data: undefined }));
      commit([...nodesRef.current, ...real], [...edgesRef.current, ...realEdges]);
      setNotice(`Copilot added ${real.length} node${real.length === 1 ? "" : "s"} (undoable).`);
    }
    setPreview(null);
  }

  // ── Actions: save / activate / deactivate / duplicate / delete ──

  async function saveDraft() {
    setBusy("save");
    setNotice("");
    await doSave(false);
    setBusy(null);
  }

  async function toggleActive() {
    const active = meta?.status === "PUBLISHED";
    if (!active && readiness.errors.length > 0) {
      setNotice(b.activateBlocked);
      return;
    }
    setBusy(active ? "pause" : "publish");
    try {
      // Flush pending edits first so activation reflects the canvas.
      await doSave(false);
      const res = await fetch(
        `/api/workflows/${workflowId}/${active ? "pause" : "publish"}`,
        { method: "POST" }
      );
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Failed");
      setMeta((m) => (m ? { ...m, status: active ? "PAUSED" : "PUBLISHED" } : m));
      setNotice(active ? "Workflow deactivated." : "Workflow activated.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function duplicateWorkflow() {
    setBusy("duplicate");
    try {
      const res = await fetch(`/api/workflows/${workflowId}/duplicate`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Duplicate failed");
      router.push(`/app/automations/${json.data.id}`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Duplicate failed");
      setBusy(null);
    }
  }

  async function deleteWorkflow() {
    setBusy("delete");
    try {
      const res = await fetch(`/api/workflows/${workflowId}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Delete failed");
      router.push("/app/automations");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Delete failed");
      setBusy(null);
      setDeleteOpen(false);
    }
  }

  // ── Display nodes (visual states + run overlay + copilot preview) ──
  const displayNodes: BuilderNode[] = useMemo(() => {
    const base = nodes.map((n) => {
      const unconfigured = isNodeUnconfigured(String(n.data.nodeType), (n.data.config ?? {}) as Record<string, unknown>);
      return {
        ...n,
        data: {
          ...n.data,
          visualState: n.data.disabled ? "disabled" : unconfigured ? "unconfigured" : "configured",
          visualStateLabel: b.nodeStates.unconfigured,
          runState: runOverlay[n.id],
        },
      };
    });
    if (!preview) return base;
    return [...base, ...preview.nodes];
  }, [nodes, preview, runOverlay, b.nodeStates.unconfigured]);

  const displayEdges: Edge[] = useMemo(
    () => (preview ? [...edges, ...preview.edges] : edges),
    [edges, preview]
  );

  const contextNode = contextMenu ? nodes.find((n) => n.id === contextMenu.nodeId) ?? null : null;

  // ── Render ──
  return (
    <div className="flex h-screen flex-col" dir={rtl ? "rtl" : "ltr"}>
      <BuilderToolbar
        meta={meta}
        saveState={saveState}
        onRename={(name) => {
          setMeta((m) => (m ? { ...m, name } : m));
          dirtyRef.current = true;
          scheduleAutosave();
        }}
        canUndo={histRef.current.canUndo}
        canRedo={histRef.current.canRedo}
        onUndo={undo}
        onRedo={redo}
        readiness={readiness}
        onFixIssue={fixIssue}
        onValidate={() => {
          if (readiness.errors.length === 0 && readiness.warnings.length === 0) {
            setNotice(b.readiness.noIssues);
          } else {
            setNotice(
              `${readiness.errors.length} error(s), ${readiness.warnings.length} warning(s) — see the indicator above.`
            );
          }
        }}
        onTest={() => setTestOpen(true)}
        onSimulate={() => setSimOpen(true)}
        onRuns={() => setRunsOpen(true)}
        copilotOpen={copilotOpen}
        onToggleCopilot={() => setCopilotOpen(!copilotOpen)}
        simpleMode={simpleMode}
        onToggleSimple={() => setSimpleMode(!simpleMode)}
        busy={busy}
        onSaveDraft={saveDraft}
        onToggleActive={toggleActive}
        onOpenTemplates={() => setTemplatesOpen(true)}
        onOpenDescription={() => setDescOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onAutoLayout={applyAutoLayout}
        onFitView={() => fitView({ padding: 0.2, duration: 200 })}
        onDuplicate={duplicateWorkflow}
        onDelete={() => setDeleteOpen(true)}
      />

      {notice && (
        <div className="border-b border-[var(--fp-border)] bg-[var(--fp-card)] px-4 py-2 text-sm text-[var(--fp-text-2)]" role="status">
          {notice}
        </div>
      )}

      {saveState === "conflict" && (
        <div className="flex items-center gap-3 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">
          <span>{b.autosave.conflict}</span>
          <button onClick={() => resolveConflict(false)} className="rounded-lg bg-white/10 px-3 py-1 text-xs font-medium hover:bg-white/20">
            {b.conflictReload}
          </button>
          <button onClick={() => resolveConflict(true)} className="rounded-lg bg-white/10 px-3 py-1 text-xs font-medium hover:bg-white/20">
            {b.conflictKeep}
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <NodePalette
          searchPlaceholder={b.palette.search}
          hint={b.palette.hint}
          onAdd={(type) => addNodeAt(type)}
        />

        <div className="relative min-w-0 flex-1">
          {simpleMode ? (
            <SimpleMode
              nodes={nodes}
              edges={edges}
              selectedNodeId={selectedNodeId}
              onSelectNode={(id) => {
                setSelectedNodeId(id);
                setSelectedEdgeId(null);
              }}
            />
          ) : (
            <BuilderCanvas
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={handleConnect}
              onNodesDelete={deleteNodes}
              onEdgesDelete={deleteEdges}
              onNodeClick={(node) => {
                if ((node.data as Record<string, unknown>).preview) return;
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
              }}
              onEdgeClick={(edge) => {
                if ((edge.data as Record<string, unknown> | undefined)?.preview) return;
                setSelectedEdgeId(edge.id);
                setSelectedNodeId(null);
              }}
              onPaneClick={() => {
                setSelectedNodeId(null);
                setSelectedEdgeId(null);
                setContextMenu(null);
              }}
              onDrop={onDrop}
              onNodeDragStart={() => {
                dragStartRef.current = { nodes: nodesRef.current, edges: edgesRef.current };
              }}
              onNodeDragStop={() => {
                const s = dragStartRef.current;
                dragStartRef.current = null;
                if (s) {
                  histRef.current.commit(s);
                  dirtyRef.current = true;
                  scheduleAutosave();
                  setHistTick((x) => x + 1);
                }
              }}
              onKeyAction={onKeyAction}
              setContextMenu={setContextMenu}
              emptyStateHint={b.palette.empty}
              rtl={rtl}
            />
          )}

          {/* Contextual node menu */}
          {contextMenu && contextNode && (
            <div
              className="absolute z-40 w-48 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-1.5 shadow-2xl"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              role="menu"
            >
              <CtxItem label={b.nodeMenu.configure} onClick={() => contextAction("configure")} />
              <CtxItem label={b.nodeMenu.duplicate} onClick={() => contextAction("duplicate")} />
              <CtxItem
                label={contextNode.data.disabled ? b.nodeMenu.enable : b.nodeMenu.disable}
                onClick={() => contextAction("toggleDisable")}
              />
              <div className="my-1 border-t border-[var(--fp-border)]" />
              <CtxItem label={b.nodeMenu.delete} danger onClick={() => contextAction("delete")} />
            </div>
          )}
        </div>

        {/* Config panel */}
        {(selectedNode || selectedEdge) && (
          <aside className="w-80 shrink-0 overflow-y-auto border-s border-[var(--fp-border)] bg-[var(--fp-card)] p-4" aria-label="Configuration panel">
            {selectedNode && (
              <NodeConfigPanel
                key={selectedNode.id}
                node={selectedNode}
                allNodes={nodes}
                edges={edges}
                integrations={integrations}
                workflowId={workflowId}
                onJumpToNode={fixIssue}
                onApply={(label, config, disabled) => {
                  commit(
                    nodesRef.current.map((n) =>
                      n.id === selectedNode.id
                        ? { ...n, data: { ...n.data, label, config, disabled: !!disabled } }
                        : n
                    ),
                    edgesRef.current
                  );
                  setNotice(`Updated "${label}".`);
                }}
                onDelete={() => deleteNodes([selectedNode])}
                onClose={() => setSelectedNodeId(null)}
              />
            )}
            {selectedEdge && !selectedNode && (
              <EdgeConfigPanel
                key={selectedEdge.id}
                edge={selectedEdge}
                onApply={(label) => {
                  commit(
                    nodesRef.current,
                    edgesRef.current.map((e) => (e.id === selectedEdge.id ? { ...e, label } : e))
                  );
                }}
                onDelete={() => deleteEdges([selectedEdge])}
                onClose={() => setSelectedEdgeId(null)}
              />
            )}
          </aside>
        )}

        {/* Copilot panel */}
        {copilotOpen && (
          <CopilotPanel
            workflowId={workflowId}
            onPreview={setPreview}
            onAcceptPreview={acceptPreview}
            onClose={() => {
              setCopilotOpen(false);
              setPreview(null);
            }}
          />
        )}
      </div>

      {/* Dialogs */}
      {testOpen && <TestModal workflowId={workflowId} onClose={() => setTestOpen(false)} />}
      {simOpen && <SimulateModal workflowId={workflowId} onClose={() => setSimOpen(false)} />}
      {runsOpen && (
        <RunInspector
          workflowId={workflowId}
          onClose={() => {
            setRunsOpen(false);
            setRunOverlay({});
          }}
          onOverlayRun={(run) => {
            if (!run) {
              setRunOverlay({});
              return;
            }
            const overlay: Record<string, NodeRunState> = {};
            for (const s of run.steps) {
              if (s.status === "SUCCEEDED") overlay[s.nodeId] = "success";
              else if (s.status === "FAILED") overlay[s.nodeId] = "failed";
              else if (s.status === "RUNNING") overlay[s.nodeId] = "running";
            }
            setRunOverlay(overlay);
          }}
        />
      )}
      {templatesOpen && (
        <TemplateGallery onClose={() => setTemplatesOpen(false)} onInsert={insertTemplate} />
      )}
      {descOpen && (
        <DescriptionEditor
          initial={meta?.description ?? ""}
          onClose={() => setDescOpen(false)}
          onSave={(v) => {
            setMeta((m) => (m ? { ...m, description: v } : m));
            dirtyRef.current = true;
            scheduleAutosave();
          }}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {deleteOpen && (
        <DeleteConfirm
          name={meta?.name ?? ""}
          busy={busy === "delete"}
          onClose={() => setDeleteOpen(false)}
          onConfirm={deleteWorkflow}
        />
      )}
    </div>
  );
}

function CtxItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      role="menuitem"
      className={`w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)] ${
        danger ? "text-red-300" : ""
      }`}
    >
      {label}
    </button>
  );
}

export default function Builder({ workflowId }: { workflowId: string }) {
  return (
    <ReactFlowProvider>
      <BuilderInner workflowId={workflowId} />
    </ReactFlowProvider>
  );
}
