"use client";

import { Card, CardContent } from "@/components/ui/Card";

/** Loading skeletons for analytics tabs: KPI cards + a chart placeholder. */
export function ChartSkeleton({ metrics = 4, chart = true }: { metrics?: number; chart?: boolean }) {
  return (
    <div className="space-y-4" aria-label="Loading analytics" aria-busy="true">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: metrics }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-2 pt-5">
              <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--fp-bg-2)]" />
              <div className="h-8 w-1/2 animate-pulse rounded bg-[var(--fp-bg-2)]" />
            </CardContent>
          </Card>
        ))}
      </div>
      {chart && (
        <Card>
          <CardContent className="pt-5">
            <div className="h-72 animate-pulse rounded-xl bg-[var(--fp-bg-2)]" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
