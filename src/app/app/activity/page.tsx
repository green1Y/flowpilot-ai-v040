"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Activity, AlertCircle, Plug, Send, Workflow, type LucideIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { useDict, useLocale } from "@/i18n/client";
import { formatDateTime, formatRelativeTime } from "@/i18n/format";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Spinner";
import type { Dictionary } from "@/i18n/dictionaries/en";

/* ------------------------------------------------------------------ */

type ActivityKind = "workflow_execution" | "outbound_send" | "integration";

interface ActivityItem {
  kind: ActivityKind;
  title: string;
  detail: string;
  at: string;
  href: string;
}

interface ActivityData {
  items: ActivityItem[];
}

const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  workflow_execution: Workflow,
  outbound_send: Send,
  integration: Plug,
};

function kindLabel(t: Dictionary, kind: ActivityKind): string {
  switch (kind) {
    case "workflow_execution":
      return t.activity.kindWorkflow;
    case "outbound_send":
      return t.activity.kindSend;
    case "integration":
      return t.activity.kindIntegration;
  }
}

/* ------------------------------------------------------------------ */

export default function ActivityPage() {
  const t = useDict();
  const locale = useLocale();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchActivity = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The api client unwraps the { ok, data } envelope; fall back to the
      // top-level items field defensively if the shape ever differs.
      const res = await api<ActivityData & { items?: ActivityItem[] }>("/api/activity");
      setItems(res.items ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.activity.couldntLoad);
    } finally {
      setLoading(false);
    }
  }, [t.activity.couldntLoad]);

  useEffect(() => {
    void fetchActivity();
  }, [fetchActivity]);

  return (
    <div>
      <PageHeader title={t.activity.title} description={t.activity.description} />

      {loading ? (
        <Spinner label={t.activity.loading} />
      ) : error ? (
        <EmptyState icon={AlertCircle} title={t.activity.couldntLoad} description={error} />
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)]">
          <EmptyState
            icon={Activity}
            title={t.activity.emptyTitle}
            description={t.activity.emptyHint}
          />
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-[var(--fp-border)]">
              {items.map((item, i) => {
                const Icon = KIND_ICON[item.kind] ?? AlertCircle;
                return (
                  <li key={`${item.kind}-${item.at}-${i}`}>
                    <Link
                      href={item.href}
                      className="flex items-start gap-3 px-5 py-4 transition-colors hover:bg-[var(--fp-bg-2)]"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#FB7185]/30 bg-[#FB7185]/10">
                        <Icon className="h-4 w-4 text-[#FB7185]" aria-hidden />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-[var(--fp-text)]">{item.title}</p>
                          <Badge tone="red">{kindLabel(t, item.kind)}</Badge>
                        </div>
                        {item.detail && (
                          <p className="mt-0.5 line-clamp-2 text-sm text-[var(--fp-text-2)]">
                            {item.detail}
                          </p>
                        )}
                      </div>
                      <time
                        dateTime={item.at}
                        title={formatDateTime(locale, item.at)}
                        className="shrink-0 text-xs text-[var(--fp-text-2)]"
                      >
                        {formatRelativeTime(locale, item.at)}
                      </time>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
