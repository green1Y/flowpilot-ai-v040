"use client";

import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from "recharts";
import { TOOLTIP_STYLE, SERIES_COLORS } from "./palette";

export interface DonutSlice {
  name: string;
  value: number;
  color?: string;
}

export function DonutChart({ data, height = 280 }: { data: DonutSlice[]; height?: number }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <div style={{ height }} role="img" aria-label="Donut chart">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value, name) => [
              `${Number(value ?? 0)}${total > 0 ? ` (${((Number(value ?? 0) / total) * 100).toFixed(1)}%)` : ""}`,
              name,
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="58%"
            outerRadius="85%"
            paddingAngle={2}
            strokeWidth={0}
          >
            {data.map((d, i) => (
              <Cell key={d.name} fill={d.color ?? SERIES_COLORS[i % SERIES_COLORS.length]} />
            ))}
          </Pie>
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="central"
            fill="var(--fp-text)"
            fontSize={20}
            fontWeight={700}
          >
            {total.toLocaleString()}
          </text>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
