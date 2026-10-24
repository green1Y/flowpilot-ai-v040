"use client";

import type { Node, Edge } from "@xyflow/react";

export interface BuilderNodeData extends Record<string, unknown> {
  label: string;
  kind: string;
  nodeType: string;
  config: Record<string, unknown>;
  icon: string;
  description: string;
  disabled?: boolean;
}

export type BuilderNode = Node<BuilderNodeData>;

export interface Snapshot {
  nodes: BuilderNode[];
  edges: Edge[];
}

export interface WorkflowMeta {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  updatedAt: string | null;
}

export interface ApiNode {
  id: string;
  kind: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
  disabled?: boolean;
}

export interface ApiEdge {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  condition: Record<string, unknown>;
}

export type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

/** Per-node run overlay state from the last execution (run inspector). */
export type NodeRunState = "running" | "success" | "failed";

export interface IntegrationRef {
  id?: string;
  provider: string;
  displayName: string;
  connectionState: string;
}
