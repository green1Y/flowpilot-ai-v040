"use client";

/**
 * Chart barrel with code-split recharts components (perf).
 *
 * The four recharts-backed charts are wrapped in next/dynamic so the recharts
 * bundle ships in its own async chunks, loaded only by routes that render
 * charts (analytics, overview). Routes that never render charts (inbox,
 * contacts, …) no longer pay for recharts in their first-load JS.
 *
 * SSR stays enabled (the next/dynamic default), so server rendering and SEO
 * behavior are unchanged — this only affects client chunk granularity.
 *
 * Note: this file is intentionally index.ts (not .tsx) — the loading fallback
 * is built with React.createElement to keep the barrel extension unchanged.
 */
import dynamic from "next/dynamic";
import { createElement, type ComponentType } from "react";
import { ChartSkeleton } from "./ChartSkeleton";

export * from "./palette";
export { MetricCard, RealBadge, EstimatedBadge } from "./MetricCard";
export { DataTable } from "./DataTable";
export { ChartEmptyState } from "./ChartEmptyState";
export { ChartSkeleton } from "./ChartSkeleton";

// Type-only re-exports stay static: erased at compile time, zero bundle cost.
export type { LineChartProps, ChartSeries } from "./LineChart";
export type { BarChartProps } from "./BarChart";
export type { DonutSlice } from "./DonutChart";
export type { FunnelStage } from "./FunnelChart";

function lazyChart<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): T {
  const loader = load as () => Promise<{ default: ComponentType<any> }>;
  return dynamic(loader, {
    loading: () => createElement(ChartSkeleton, { metrics: 0, chart: true }),
  }) as unknown as T;
}

export const LineChart = lazyChart(() =>
  import("./LineChart").then((m) => ({ default: m.LineChart })),
);
export const BarChart = lazyChart(() =>
  import("./BarChart").then((m) => ({ default: m.BarChart })),
);
export const DonutChart = lazyChart(() =>
  import("./DonutChart").then((m) => ({ default: m.DonutChart })),
);
export const FunnelChart = lazyChart(() =>
  import("./FunnelChart").then((m) => ({ default: m.FunnelChart })),
);
