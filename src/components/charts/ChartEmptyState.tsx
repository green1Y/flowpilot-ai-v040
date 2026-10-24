"use client";

import type { ReactNode } from "react";
import { BarChart3 } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";

export interface ChartEmptyStateProps {
  title?: string;
  description?: string;
  action?: ReactNode;
}

/** Honest empty state for charts with no rows in range. */
export function ChartEmptyState({
  title = "No data yet",
  description = "Nothing to show for this range — connect a channel or run a campaign and metrics will appear here.",
  action,
}: ChartEmptyStateProps) {
  return <EmptyState icon={BarChart3} title={title} description={description} action={action} />;
}
