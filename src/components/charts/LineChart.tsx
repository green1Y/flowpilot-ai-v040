"use client";

import {
  ResponsiveContainer,
  LineChart as RLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { TOOLTIP_STYLE, AXIS_TICK, shortDate } from "./palette";

export interface ChartSeries {
  key: string;
  name: string;
  color: string;
}

export interface LineChartProps {
  data: Record<string, unknown>[];
  series: ChartSeries[];
  xKey?: string;
  height?: number;
  yLabel?: string;
}

export function LineChart({ data, series, xKey = "date", height = 280, yLabel }: LineChartProps) {
  return (
    <div style={{ height }} role="img" aria-label={yLabel ?? "Line chart"}>
      <ResponsiveContainer width="100%" height="100%">
        <RLineChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: -12 }}>
          <CartesianGrid stroke="var(--fp-border)" strokeDasharray="3 3" />
          <XAxis
            dataKey={xKey}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: string) => shortDate(String(v))}
            minTickGap={28}
          />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(v) => shortDate(String(v))}
            formatter={(value, name) => [value, name]}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </RLineChart>
      </ResponsiveContainer>
    </div>
  );
}
