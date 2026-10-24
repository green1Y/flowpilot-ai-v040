"use client";

import { ResponsiveContainer, FunnelChart as RFunnelChart, Funnel, LabelList, Tooltip } from "recharts";
import { TOOLTIP_STYLE, SERIES_COLORS } from "./palette";

export interface FunnelStage {
  name: string;
  value: number;
  color?: string;
}

/** Conversion funnel: each stage rendered as a trapezoid sized by value. */
export function FunnelChart({ data, height = 320 }: { data: FunnelStage[]; height?: number }) {
  const first = data[0]?.value ?? 0;
  const withConv = data.map((d, i) => ({
    ...d,
    fill: d.color ?? SERIES_COLORS[i % SERIES_COLORS.length],
    conv: i === 0 ? 100 : first > 0 ? (d.value / first) * 100 : 0,
  }));
  return (
    <div style={{ height }} role="img" aria-label="Funnel chart">
      <ResponsiveContainer width="100%" height="100%">
        <RFunnelChart>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value, _name, props) => {
              const conv = (props?.payload as { conv?: number } | undefined)?.conv;
              return [`${Number(value ?? 0)}${conv != null ? ` · ${conv.toFixed(1)}% of top` : ""}`, _name];
            }}
          />
          <Funnel dataKey="value" data={withConv} isAnimationActive={false}>
            <LabelList
              position="right"
              fill="var(--fp-text)"
              stroke="none"
              fontSize={12}
              dataKey="name"
              formatter={(name: string, entry: unknown) => {
                const p = entry as { payload?: { value?: number; conv?: number } };
                const v = p?.payload?.value ?? 0;
                const c = p?.payload?.conv ?? 0;
                return `${name}: ${v.toLocaleString()} (${c.toFixed(1)}%)`;
              }}
            />
          </Funnel>
        </RFunnelChart>
      </ResponsiveContainer>
    </div>
  );
}
