"use client";

import {
  ResponsiveContainer,
  BarChart as RBarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { TOOLTIP_STYLE, AXIS_TICK, SERIES_COLORS, shortDate } from "./palette";

export interface BarChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  bars: { key: string; name: string; color?: string }[];
  height?: number;
  /** Color each bar from the series palette by index (single-bar charts). */
  colorByIndex?: boolean;
  formatX?: (v: string) => string;
  layout?: "horizontal" | "vertical";
}

export function BarChart({
  data,
  xKey,
  bars,
  height = 280,
  colorByIndex = false,
  formatX,
  layout = "horizontal",
}: BarChartProps) {
  const fmt = formatX ?? ((v: string) => (v.match(/^\d{4}-\d{2}-\d{2}$/) ? shortDate(v) : v));
  const vertical = layout === "vertical";
  return (
    <div style={{ height }} role="img" aria-label="Bar chart">
      <ResponsiveContainer width="100%" height="100%">
        <RBarChart
          data={data}
          layout={vertical ? "vertical" : "horizontal"}
          margin={{ top: 8, right: 8, bottom: 8, left: vertical ? 8 : -12 }}
        >
          <CartesianGrid stroke="var(--fp-border)" strokeDasharray="3 3" />
          {vertical ? (
            <>
              <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis
                type="category"
                dataKey={xKey}
                tick={{ ...AXIS_TICK, width: 110 }}
                tickLine={false}
                axisLine={false}
                width={120}
                tickFormatter={(v: string) => fmt(String(v))}
              />
            </>
          ) : (
            <>
              <XAxis
                dataKey={xKey}
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: string) => fmt(String(v))}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
            </>
          )}
          <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(v) => fmt(String(v))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {bars.map((b) => (
            <Bar key={b.key} dataKey={b.key} name={b.name} fill={b.color ?? SERIES_COLORS[0]} radius={[6, 6, 0, 0]}>
              {colorByIndex &&
                data.map((_, i) => <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />)}
            </Bar>
          ))}
        </RBarChart>
      </ResponsiveContainer>
    </div>
  );
}
