"use client";

import { Badge, type BadgeTone } from "./Badge";

export type ConnectionStatusKind =
  | "CONNECTED"
  | "NEEDS_ATTENTION"
  | "DEMO"
  | "DISCONNECTED"
  | "SIMULATED"
  | "EXPIRED";

const meta: Record<ConnectionStatusKind, { label: string; tone: BadgeTone; dot: string; pulse: boolean }> = {
  CONNECTED: { label: "Connected", tone: "green", dot: "bg-success", pulse: false },
  NEEDS_ATTENTION: { label: "Needs attention", tone: "amber", dot: "bg-warning", pulse: true },
  DEMO: { label: "Demo", tone: "violet", dot: "bg-violet", pulse: false },
  DISCONNECTED: { label: "Disconnected", tone: "gray", dot: "bg-[var(--fp-text-3)]", pulse: false },
  SIMULATED: { label: "Simulated", tone: "cyan", dot: "bg-cyan", pulse: false },
  EXPIRED: { label: "Expired", tone: "red", dot: "bg-danger", pulse: true },
};

export interface ConnectionStatusProps {
  status: ConnectionStatusKind;
  /** Shows the status dot before the label. */
  showDot?: boolean;
  className?: string;
}

/**
 * Professional connection-status indicator built on the Badge pattern.
 * Covers every integration connection state: Connected, Needs attention,
 * Demo, Disconnected, Simulated, Expired.
 */
export function ConnectionStatus({ status, showDot = true, className = "" }: ConnectionStatusProps) {
  const m = meta[status] ?? meta.DISCONNECTED;
  return (
    <Badge tone={m.tone} className={className} title={m.label}>
      {showDot && (
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${m.dot} ${m.pulse ? "animate-pulse" : ""}`}
        />
      )}
      {m.label}
    </Badge>
  );
}
