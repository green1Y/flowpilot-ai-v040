"use client";

/**
 * Settings · Plan & Usage section — SUMMARY ONLY (Batch C de-duplication).
 *
 * The full plan + usage implementation lives on /app/billing (plan limits,
 * usage bars, upgrade modal, invoices empty state). This tab previously
 * re-implemented the same GET /api/billing data with its own bars — and
 * mapped execution counters against the defined-workflow limit, which is
 * misleading now that workflowLimit means "defined workflows". It now
 * shows just the current plan + the honest assignment note and defers to
 * the Billing page for everything else. One implementation, one truth.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { api, useWorkspaces } from "@/lib/api-client";
import { Spinner } from "@/components/ui/Spinner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { roleAtLeast, type SettingsDict } from "../ui";

interface BillingSummary {
  plan: {
    name: string;
    features: string[];
  };
  assignment?: { source: "demo" | "manual"; note: string } | null;
  note: string;
}

export function PlanTab({ t }: { t: SettingsDict }) {
  const b = t.billing;
  const { current } = useWorkspaces();
  const canView = roleAtLeast(current?.role, "MANAGER");

  const [data, setData] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const fetchBilling = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const raw = await api<BillingSummary>("/api/billing");
      setData(raw);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canView) void fetchBilling();
    else setLoading(false);
  }, [canView, fetchBilling]);

  if (!canView) {
    return (
      <Card>
        <CardContent>
          <p className="py-6 text-sm text-[var(--fp-text-2)]">{b.restricted}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{b.plan}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-[var(--fp-text-2)]">{b.hint}</p>
        {loading ? (
          <Spinner label={t.common.loading} className="py-6" />
        ) : failed || !data ? (
          <p className="py-4 text-sm text-[var(--fp-text-2)]">{t.common.retry}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="violet" className="text-sm">{data.plan.name}</Badge>
              <div className="flex flex-wrap gap-2 text-xs text-[var(--fp-text-2)]">
                {data.plan.features.map((f) => (
                  <span key={f} className="rounded-full border border-[var(--fp-border)] px-2.5 py-1">
                    {f}
                  </span>
                ))}
              </div>
            </div>
            {data.assignment?.note && (
              <p className="text-xs text-[var(--fp-text-2)]">{data.assignment.note}</p>
            )}
            <p className="rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3 text-xs text-[var(--fp-text-2)]">
              {b.upgradeHint}
            </p>
            <p className="text-xs text-[var(--fp-text-2)]">{data.note}</p>
            <div>
              <Link href="/app/billing">
                <Button variant="secondary" size="sm">
                  {b.openBilling} <ArrowUpRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
