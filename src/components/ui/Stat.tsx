"use client";

import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "./Badge";
import { Card } from "./Card";

export type StatDeltaTone = "up" | "down" | "neutral";

export interface StatProps {
  /** Small caption above the value. */
  label: string;
  /** The headline metric — number, string, or node. */
  value: ReactNode;
  /** Optional delta text, e.g. "+12.4% vs last week". */
  delta?: string;
  /** Colors the delta badge; "up" = green, "down" = red, "neutral" = gray. */
  deltaTone?: StatDeltaTone;
  /** Optional icon shown in the label row. */
  icon?: LucideIcon;
  /** Tiny caption under the value. */
  hint?: string;
  className?: string;
}

const deltaTones: Record<StatDeltaTone, "green" | "red" | "gray"> = {
  up: "green",
  down: "red",
  neutral: "gray",
};

const deltaIcons: Record<StatDeltaTone, LucideIcon> = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  neutral: Minus,
};

/** Metric card for dashboards and analytics — consistent with Card. */
export function Stat({
  label,
  value,
  delta,
  deltaTone = "neutral",
  icon: Icon,
  hint,
  className = "",
}: StatProps) {
  const DeltaIcon = deltaIcons[deltaTone];
  return (
    <Card className={`p-5 ${className}`}>
      <div className="flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-[var(--fp-text-2)]" aria-hidden />}
        <p className="text-xs font-medium uppercase tracking-wider text-[var(--fp-text-2)]">
          {label}
        </p>
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight text-[var(--fp-text)]">
        {value}
      </p>
      {(delta || hint) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {delta && (
            <Badge tone={deltaTones[deltaTone]}>
              <DeltaIcon className="h-3 w-3" aria-hidden />
              {delta}
            </Badge>
          )}
          {hint && <p className="text-xs text-faint">{hint}</p>}
        </div>
      )}
    </Card>
  );
}
