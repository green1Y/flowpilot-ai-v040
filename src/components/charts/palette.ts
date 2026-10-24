/** Shared chart palette — coordinates with the FlowPilot dark-first brand. */
export const PALETTE = {
  primary: "#8B5CF6", // violet
  secondary: "#22D3EE", // cyan
  teal: "#2DD4BF",
  amber: "#FBBF24",
  rose: "#FB7185",
  indigo: "#818CF8",
  emerald: "#34D399",
  slate: "#94A3B8",
  success: "#34D399",
  warning: "#FBBF24",
  error: "#FB7185",
} as const;

export const SERIES_COLORS = [
  PALETTE.primary,
  PALETTE.secondary,
  PALETTE.teal,
  PALETTE.amber,
  PALETTE.rose,
  PALETTE.indigo,
  PALETTE.emerald,
  PALETTE.slate,
];

export const TOOLTIP_STYLE: React.CSSProperties = {
  background: "var(--fp-card)",
  border: "1px solid var(--fp-border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--fp-text)",
};

export const AXIS_TICK = { fill: "var(--fp-text-2)", fontSize: 11 } as const;

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatPct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}%`;
}

export function shortDate(key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? key
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
