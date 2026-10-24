"use client";

/**
 * Phase 4 — Settings · Integrations tab (read-only status).
 * GET /api/integrations — status, granted scopes, token state, last sync,
 * last error + troubleshooting hint. Actions live on /app/integrations.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ArrowUpRight } from "lucide-react";
import type { SettingsDict } from "../ui";

interface IntegrationInfo {
  provider: string;
  displayName: string;
  category: string;
  simulated: boolean;
  status: string;
  capabilities: string[];
  limitations: string[];
  requiredPermissions: string[];
  lastSyncAt: string | null;
  verifiedAt: string | null;
  accountName?: string | null;
  accountAvatarUrl?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
}

function statusTone(status: string): "green" | "amber" | "red" | "gray" {
  switch (status) {
    case "CONNECTED":
      return "green";
    case "NEEDS_ATTENTION":
    case "EXPIRED":
      return "amber";
    case "DISCONNECTED":
      return "red";
    default:
      return "gray";
  }
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function IntegrationsTab({ t }: { t: SettingsDict }) {
  const i = t.integrations;
  const [rows, setRows] = useState<IntegrationInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await api<{ integrations: IntegrationInfo[] }>("/api/integrations");
      setRows(raw.integrations ?? []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const hintFor = (status: string) =>
    i.hints[status as keyof typeof i.hints] ?? i.hints.DISCONNECTED;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{i.title}</CardTitle>
        <Link href="/app/integrations" className="ml-auto">
          <Button size="sm" variant="secondary">
            {i.manage} <ArrowUpRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-xs text-[var(--fp-text-2)]">{i.hint}</p>
        {loading ? (
          <Spinner label={t.common.loading} className="py-8" />
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => {
              const tokenState =
                r.status === "CONNECTED" ? i.tokenOk : r.status === "NEEDS_ATTENTION" || r.status === "EXPIRED" ? i.tokenReauth : i.tokenNone;
              return (
                <li key={r.provider} className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {r.accountAvatarUrl && (
                      <img src={r.accountAvatarUrl} alt="" className="h-8 w-8 rounded-full" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-[var(--fp-text)]">
                        {r.displayName}
                        {r.accountName && <span className="ml-2 font-normal text-[var(--fp-text-2)]">{r.accountName}</span>}
                      </p>
                      <p className="text-xs text-[var(--fp-text-2)]">{r.category}</p>
                    </div>
                    <Badge tone={statusTone(r.status)}>{r.status.replace(/_/g, " ")}</Badge>
                    {r.simulated && <Badge tone="gray">Simulated</Badge>}
                  </div>

                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-[var(--fp-text-2)]">{i.token}</dt>
                      <dd className="font-medium text-[var(--fp-text)]">{tokenState}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--fp-text-2)]">{i.lastSync}</dt>
                      <dd className="font-medium text-[var(--fp-text)]">{fmtDate(r.lastSyncAt) ?? i.neverSynced}</dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-[var(--fp-text-2)]">{i.scopes}</dt>
                      <dd className="mt-1 flex flex-wrap gap-1">
                        {r.requiredPermissions.length > 0 ? (
                          r.requiredPermissions.map((s) => (
                            <code key={s} className="rounded bg-[var(--fp-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--fp-text-2)]">
                              {s}
                            </code>
                          ))
                        ) : (
                          <span className="text-[var(--fp-text-2)]">—</span>
                        )}
                      </dd>
                    </div>
                    {r.lastError && (
                      <div className="sm:col-span-2">
                        <dt className="text-[#FB7185]">{i.lastError} · {fmtDate(r.lastErrorAt)}</dt>
                        <dd className="mt-0.5 text-[var(--fp-text-2)]">{r.lastError}</dd>
                      </div>
                    )}
                    <div className="sm:col-span-2 rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg)] p-2.5">
                      <dt className="mb-0.5 font-medium text-[var(--fp-text-2)]">{i.hintFor}</dt>
                      <dd className="text-[var(--fp-text-2)]">{hintFor(r.status)}</dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
