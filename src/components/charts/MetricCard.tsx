"use client";

import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

export interface MetricCardProps {
  label: string;
  value: string;
  sub?: string;
  /** Percent change vs previous period. null/undefined hides the delta. */
  delta?: number | null;
  /** Absolute point change (e.g. +4.2pp) shown instead of % when set. */
  deltaPoints?: number | null;
  /** Small "?" explanation of how the metric is computed. */
  definition?: string;
  badge?: ReactNode;
}

function Delta({ delta, points }: { delta?: number | null; points?: number | null }) {
  const v = points ?? delta;
  if (v == null || !Number.isFinite(v)) return null;
  const up = v >= 0;
  const text = points != null ? `${up ? "+" : ""}${v.toFixed(1)}pp` : `${up ? "+" : ""}${v.toFixed(1)}%`;
  return (
    <span
      className={`ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
        up ? "bg-[rgba(52,211,153,0.12)] text-[#34D399]" : "bg-[rgba(251,113,133,0.12)] text-[#FB7185]"
      }`}
      aria-label={`change ${text}`}
    >
      {up ? "▲" : "▼"} {text}
    </span>
  );
}

export function MetricCard({ label, value, sub, delta, deltaPoints, definition, badge }: MetricCardProps) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--fp-text-2)]">
          {label}
          {definition && (
            <span
              role="img"
              aria-label={`Definition: ${definition}`}
              title={definition}
              className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--fp-border)] text-[10px] text-[var(--fp-text-2)]"
            >
              ?
            </span>
          )}
          {badge}
        </p>
        <p className="text-gradient mt-1 text-3xl font-bold">
          {value}
          <Delta delta={delta} points={deltaPoints} />
        </p>
        {sub && <p className="mt-1 text-xs text-[var(--fp-text-2)]">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export function RealBadge() {
  return (
    <Badge tone="green" title="Computed from real workspace rows in the selected range">
      Real
    </Badge>
  );
}

export function EstimatedBadge({ title }: { title: string }) {
  return (
    <Badge tone="amber" title={title}>
      Estimated
    </Badge>
  );
}
