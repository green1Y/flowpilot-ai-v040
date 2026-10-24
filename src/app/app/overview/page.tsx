"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  MessagesSquare,
  Plug,
  Send,
  Target,
  Timer,
  TrendingUp,
  UserPlus,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, useWorkspaces } from "@/lib/api-client";
import { useDict, useLocale } from "@/i18n/client";
import {
  formatDateTime,
  formatInt,
} from "@/i18n/format";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Spinner";
import { Tabs } from "@/components/ui/Tabs";

/* ---------------- defensive parsing helpers ---------------- */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asNum(v: unknown, d = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function asStr(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/* ---------------- types ---------------- */

interface KpiRaw {
  value: number | string;
  delta?: number;
}

interface OverviewPayload {
  demo?: boolean;
  kpis?: Record<string, KpiRaw | number | string>;
  series?: { date?: string; label?: string; conversations?: number; messages?: number }[];
  leadsByChannel?: { channel?: string; leads?: number }[];
  topAutomations?: { id?: string; name?: string; runs?: number; status?: string }[];
  recentConversations?: {
    id?: string;
    contactName?: string;
    channel?: string;
    lastMessage?: string;
    status?: string;
    updatedAt?: string;
  }[];
  unresolvedConversations?: number;
  draftWorkflows?: number;
}

interface NotificationItem {
  id: string;
  title: string;
  message?: string;
  createdAt?: string;
}

interface IntegrationItem {
  provider: string;
  status: string;
  lastSyncAt?: string;
}

type KpiFormat = "int" | "time" | "pct";

interface KpiDef {
  key: string;
  label: string;
  icon: LucideIcon;
  format: KpiFormat;
  invertDelta?: boolean;
}

/* Range tabs / channel options / KPI defs are built inside the component
   from the dictionary so labels are translated. */

function formatKpi(raw: number | string | undefined, format: KpiFormat, locale: "en" | "ar"): string {
  if (raw === undefined) return "—";
  if (typeof raw === "string") return raw;
  if (format === "pct") return `${raw.toFixed(1)}%`;
  if (format === "time") {
    if (raw < 60) return `${Math.round(raw)}s`;
    if (raw < 3600) return `${(raw / 60).toFixed(1)}m`;
    return `${(raw / 3600).toFixed(1)}h`;
  }
  return formatInt(locale, Math.round(raw));
}

function normalizeKpi(v: KpiRaw | number | string | undefined): { value: number | string; delta?: number } {
  if (v === undefined) return { value: "—" };
  if (typeof v === "number" || typeof v === "string") return { value: v };
  const r = asRecord(v);
  return {
    value: (r && (r.value as number | string)) ?? "—",
    delta: r && typeof r.delta === "number" ? r.delta : undefined,
  };
}

function statusTone(status: string): BadgeTone {
  const s = status.toUpperCase();
  if (s === "CONNECTED" || s === "PUBLISHED" || s === "ACTIVE" || s === "OPEN") return "green";
  if (s === "DEMO") return "amber";
  if (s === "NEEDS_ATTENTION" || s === "PAUSED") return "amber";
  if (s === "EXPIRED" || s === "FAILED") return "red";
  if (s === "DRAFT") return "gray";
  if (s === "RESOLVED") return "cyan";
  return "gray";
}

const BAR_COLORS = ["#8B5CF6", "#22D3EE", "#34D399", "#FBBF24", "#FB7185", "#60A5FA", "#A78BFA", "#67E8F9"];

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name?: string; value?: number | string; color?: string }[]; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] px-3 py-2 shadow-card">
      <p className="text-xs font-medium text-[var(--fp-text-2)]">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="text-sm font-semibold text-[var(--fp-text)]">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />
          {p.name}: {typeof p.value === "number" ? p.value.toLocaleString() : p.value}
        </p>
      ))}
    </div>
  );
}

/* ---------------- page ---------------- */

export default function OverviewPage() {
  const t = useDict();
  const locale = useLocale();
  const { current } = useWorkspaces();

  /* Translated option lists (were module-level constants). */
  const RANGE_TABS = [
    { id: "today", label: t.overview.rangeToday },
    { id: "7d", label: t.overview.range7d },
    { id: "30d", label: t.overview.range30d },
    { id: "90d", label: t.overview.range90d },
    { id: "custom", label: t.overview.rangeCustom },
  ];

  const CHANNELS = [
    { value: "all", label: t.overview.allChannels },
    { value: "instagram", label: "Instagram" },
    { value: "facebook", label: "Facebook" },
    { value: "whatsapp", label: "WhatsApp" },
    { value: "telegram", label: "Telegram" },
    { value: "webchat", label: "Webchat" },
    { value: "email", label: "Email" },
    { value: "tiktok", label: "TikTok" },
    { value: "youtube", label: "YouTube" },
    { value: "linkedin", label: "LinkedIn" },
    { value: "x", label: "X" },
  ];

  const KPI_DEFS: KpiDef[] = [
    { key: "totalConversations", label: t.overview.kpiTotalConversations, icon: MessagesSquare, format: "int" },
    { key: "aiHandled", label: t.overview.kpiAiHandled, icon: Bot, format: "int" },
    { key: "newLeads", label: t.overview.kpiNewLeads, icon: UserPlus, format: "int" },
    { key: "qualifiedLeads", label: t.overview.kpiQualifiedLeads, icon: Target, format: "int" },
    { key: "automationRuns", label: t.overview.kpiAutomationRuns, icon: Workflow, format: "int" },
    { key: "messagesSent", label: t.overview.kpiMessagesSent, icon: Send, format: "int" },
    { key: "avgResponseTime", label: t.overview.kpiAvgResponseTime, icon: Timer, format: "time", invertDelta: true },
    { key: "conversionRate", label: t.overview.kpiConversionRate, icon: TrendingUp, format: "pct" },
  ];
  const [range, setRange] = useState("7d");
  const [customStart, setCustomStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [customEnd, setCustomEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [channel, setChannel] = useState("all");
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [activity, setActivity] = useState<NotificationItem[]>([]);
  const [health, setHealth] = useState<IntegrationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = { range };
      // "all" is a UI-only value — omit it so the API applies no channel filter.
      if (channel !== "all") params.channel = channel;
      if (range === "custom") {
        // The API's custom-range bounds are named from/to (not start/end).
        if (customStart) params.from = customStart;
        if (customEnd) params.to = customEnd;
      }

      const [ovRes, notifRes, integRes] = await Promise.allSettled([
        api<OverviewPayload>("/api/analytics/overview", { params }),
        api<unknown>("/api/notifications"),
        api<unknown>("/api/integrations"),
      ]);

      if (ovRes.status === "fulfilled") {
        setData(ovRes.value ?? null);
      } else {
        throw ovRes.reason instanceof Error ? ovRes.reason : new Error("Failed to load analytics");
      }

      if (notifRes.status === "fulfilled") {
        const raw = notifRes.value as { notifications?: unknown[] } | unknown[] | null;
        const list = Array.isArray(raw) ? raw : asArr(asRecord(raw)?.notifications);
        setActivity(
          list
            .map((n) => asRecord(n))
            .filter((n): n is Record<string, unknown> => n !== null)
            .map((n) => ({
              id: asStr(n.id, Math.random().toString(36).slice(2)),
              title: asStr(n.title, "Update"),
              message: typeof n.message === "string" ? n.message : undefined,
              createdAt: typeof n.createdAt === "string" ? n.createdAt : undefined,
            }))
            .slice(0, 8)
        );
      }

      if (integRes.status === "fulfilled") {
        const raw = integRes.value as { integrations?: unknown[] } | unknown[] | null;
        const list = Array.isArray(raw) ? raw : asArr(asRecord(raw)?.integrations);
        setHealth(
          list
            .map((i) => asRecord(i))
            .filter((i): i is Record<string, unknown> => i !== null)
            .map((i) => ({
              provider: asStr(i.provider, "unknown"),
              status: asStr(i.status, "UNKNOWN"),
              lastSyncAt: typeof i.lastSyncAt === "string" ? i.lastSyncAt : undefined,
            }))
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard data.");
    } finally {
      setLoading(false);
    }
  }, [range, channel, customStart, customEnd, current?.id]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const kpis = useMemo(
    () =>
      KPI_DEFS.map((def) => {
        const n = normalizeKpi(data?.kpis?.[def.key]);
        return { ...def, value: n.value, delta: n.delta };
      }),
    [data]
  );

  const series = useMemo(
    () =>
      (data?.series ?? []).map((s) => ({
        label: s.label ?? s.date ?? "",
        conversations: asNum(s.conversations),
        messages: asNum(s.messages),
      })),
    [data]
  );

  const leadsByChannel = useMemo(
    () =>
      (data?.leadsByChannel ?? []).map((l) => ({
        channel: l.channel ?? "unknown",
        leads: asNum(l.leads),
      })),
    [data]
  );

  const topAutomations = data?.topAutomations ?? [];
  const recentConversations = data?.recentConversations ?? [];
  const unresolved = asNum(data?.unresolvedConversations);
  const drafts = asNum(data?.draftWorkflows);

  return (
    <div>
      <PageHeader
        title={t.overview.title}
        description={current ? t.overview.workspaceName.replace("{name}", current.name) : t.overview.description}
        actions={
          data?.demo ? (
            <span title={t.overview.demoDataTitle}>
              <Badge tone="amber">{t.overview.demoData}</Badge>
            </span>
          ) : undefined
        }
      />

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs tabs={RANGE_TABS} value={range} onChange={setRange} />
            <div className="w-48">
              <Select
                aria-label={t.overview.channelFilter}
                options={CHANNELS}
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              />
            </div>
            {range === "custom" && (
              <>
                <div className="w-44">
                  <Input
                    type="date"
                    aria-label={t.overview.startDate}
                    value={customStart}
                    max={customEnd || undefined}
                    onChange={(e) => setCustomStart(e.target.value)}
                  />
                </div>
                <div className="w-44">
                  <Input
                    type="date"
                    aria-label={t.overview.endDate}
                    value={customEnd}
                    min={customStart || undefined}
                    onChange={(e) => setCustomEnd(e.target.value)}
                  />
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {loading && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-80" />
        </div>
      )}

      {!loading && error && (
        <Card>
          <EmptyState
            icon={TrendingUp}
            title={t.overview.couldntLoad}
            description={error}
            action={<Button onClick={fetchAll}>{t.overview.tryAgain}</Button>}
          />
        </Card>
      )}

      {!loading && !error && (
        <div className="space-y-6">
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {kpis.map((k) => {
              const Icon = k.icon;
              const good = k.delta !== undefined && (k.invertDelta ? k.delta < 0 : k.delta > 0);
              const bad = k.delta !== undefined && (k.invertDelta ? k.delta > 0 : k.delta < 0);
              return (
                <Card key={k.key}>
                  <CardContent className="pt-5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-[var(--fp-text-2)]">{k.label}</p>
                      <Icon className="h-4 w-4 text-[var(--fp-text-2)]" aria-hidden />
                    </div>
                    <p className="mt-2 text-2xl font-bold text-[var(--fp-text)]">
                      {formatKpi(k.value, k.format, locale)}
                    </p>
                    {k.delta !== undefined ? (
                      <p
                        className={`mt-1.5 flex items-center gap-1 text-xs font-medium ${
                          good ? "text-[#34D399]" : bad ? "text-[#FB7185]" : "text-[var(--fp-text-2)]"
                        }`}
                      >
                        {k.delta > 0 ? (
                          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                        ) : k.delta < 0 ? (
                          <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />
                        ) : null}
                        {k.delta > 0 ? "+" : ""}
                        {k.delta.toFixed(1)}% {t.overview.vsPrevious}
                      </p>
                    ) : (
                      <p className="mt-1.5 text-xs text-[var(--fp-text-2)]">{t.overview.vsPreviousPeriod}</p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Charts */}
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>{t.overview.conversationsOverTime}</CardTitle>
              </CardHeader>
              <CardContent>
                {series.length === 0 ? (
                  <EmptyState
                    icon={MessagesSquare}
                    title={t.overview.noConversationData}
                    description={t.overview.noConversationDataHint}
                    action={
                      <Link href="/app/integrations">
                        <Button variant="secondary" size="sm">
                          {t.overview.connectChannel}
                        </Button>
                      </Link>
                    }
                  />
                ) : (
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={series} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                        <defs>
                          <linearGradient id="fpConv" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.45} />
                            <stop offset="100%" stopColor="#8B5CF6" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="fpMsg" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#22D3EE" stopOpacity={0.45} />
                            <stop offset="100%" stopColor="#22D3EE" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="var(--fp-border)" strokeDasharray="3 3" vertical={false} />
                        <XAxis
                          dataKey="label"
                          tick={{ fill: "var(--fp-text-2)", fontSize: 11 }}
                          tickLine={false}
                          axisLine={{ stroke: "var(--fp-border)" }}
                          minTickGap={24}
                        />
                        <YAxis
                          tick={{ fill: "var(--fp-text-2)", fontSize: 11 }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--fp-border)" }} />
                        <Area
                          type="monotone"
                          dataKey="conversations"
                          name={t.overview.seriesConversations}
                          stroke="#8B5CF6"
                          strokeWidth={2}
                          fill="url(#fpConv)"
                        />
                        <Area
                          type="monotone"
                          dataKey="messages"
                          name={t.overview.seriesMessages}
                          stroke="#22D3EE"
                          strokeWidth={2}
                          fill="url(#fpMsg)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t.overview.leadsByChannel}</CardTitle>
              </CardHeader>
              <CardContent>
                {leadsByChannel.length === 0 ? (
                  <EmptyState
                    icon={UserPlus}
                    title={t.overview.noLeads}
                    description={t.overview.noLeadsHint}
                  />
                ) : (
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={leadsByChannel} layout="vertical" margin={{ top: 0, right: 10, left: 10, bottom: 0 }}>
                        <CartesianGrid stroke="var(--fp-border)" strokeDasharray="3 3" horizontal={false} />
                        <XAxis
                          type="number"
                          tick={{ fill: "var(--fp-text-2)", fontSize: 11 }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          type="category"
                          dataKey="channel"
                          width={84}
                          tick={{ fill: "var(--fp-text-2)", fontSize: 11 }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--fp-bg-2)" }} />
                        <Bar dataKey="leads" name="Leads" radius={[0, 6, 6, 0]}>
                          {leadsByChannel.map((_, i) => (
                            <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Lists row */}
          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>{t.overview.topAutomations}</CardTitle>
                <Link
                  href="/app/automations"
                  className="text-xs font-medium text-[var(--fp-accent-2)] hover:underline"
                >
                  {t.overview.viewAll}
                </Link>
              </CardHeader>
              <CardContent>
                {topAutomations.length === 0 ? (
                  <EmptyState
                    icon={Workflow}
                    title={t.overview.noAutomations}
                    description={t.overview.noAutomationsHint}
                    action={
                      <Link href="/app/automations/new">
                        <Button size="sm">{t.overview.createAutomation}</Button>
                      </Link>
                    }
                  />
                ) : (
                  <ul className="space-y-3">
                    {topAutomations.slice(0, 5).map((a) => (
                      <li
                        key={asStr(a.id, asStr(a.name))}
                        className="flex items-center justify-between gap-3 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-3.5 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-[var(--fp-text)]">
                            {asStr(a.name, t.overview.untitled)}
                          </p>
                          <p className="text-xs text-[var(--fp-text-2)]">
                            {formatInt(locale, asNum(a.runs))} {t.overview.runs}
                          </p>
                        </div>
                        <Badge tone={statusTone(asStr(a.status))}>{asStr(a.status, "—")}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>{t.overview.recentConversations}</CardTitle>
                <Link
                  href="/app/inbox"
                  className="text-xs font-medium text-[var(--fp-accent-2)] hover:underline"
                >
                  {t.overview.openInbox}
                </Link>
              </CardHeader>
              <CardContent>
                {recentConversations.length === 0 ? (
                  <EmptyState
                    icon={MessagesSquare}
                    title={t.overview.noConversations}
                    description={t.overview.noConversationsHint}
                  />
                ) : (
                  <ul className="space-y-3">
                    {recentConversations.slice(0, 5).map((c) => (
                      <li key={asStr(c.id)}>
                        <Link
                          href="/app/inbox"
                          className="block rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-3.5 py-2.5 hover:border-[var(--fp-accent)] transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-medium text-[var(--fp-text)]">
                              {asStr(c.contactName, t.overview.unknownContact)}
                            </p>
                            <Badge tone={statusTone(asStr(c.status))}>
                              {asStr(c.channel, "—")}
                            </Badge>
                          </div>
                          {c.lastMessage && (
                            <p className="mt-1 truncate text-xs text-[var(--fp-text-2)]">
                              {c.lastMessage}
                            </p>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t.overview.activity}</CardTitle>
              </CardHeader>
              <CardContent>
                {activity.length === 0 ? (
                  <EmptyState
                    icon={Send}
                    title={t.overview.noActivity}
                    description={t.overview.noActivityHint}
                  />
                ) : (
                  <ul className="space-y-3">
                    {activity.map((n) => (
                      <li key={n.id} className="flex gap-3">
                        <span
                          aria-hidden
                          className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]"
                        />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[var(--fp-text)]">{n.title}</p>
                          {n.message && (
                            <p className="truncate text-xs text-[var(--fp-text-2)]">{n.message}</p>
                          )}
                          {n.createdAt && (
                            <p className="mt-0.5 text-[11px] text-[var(--fp-text-2)]">
                              {formatDateTime(locale, n.createdAt)}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Health + pending row */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>{t.overview.integrationHealth}</CardTitle>
                <Link
                  href="/app/integrations"
                  className="text-xs font-medium text-[var(--fp-accent-2)] hover:underline"
                >
                  {t.overview.manage}
                </Link>
              </CardHeader>
              <CardContent>
                {health.length === 0 ? (
                  <EmptyState
                    icon={Plug}
                    title={t.overview.noIntegrations}
                    description={t.overview.noIntegrationsHint}
                    action={
                      <Link href="/app/integrations">
                        <Button size="sm" variant="secondary">
                          {t.overview.browseIntegrations}
                        </Button>
                      </Link>
                    }
                  />
                ) : (
                  <ul className="grid gap-2.5 sm:grid-cols-2">
                    {health.map((h) => (
                      <li
                        key={h.provider}
                        className="flex items-center justify-between gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-3.5 py-2.5"
                      >
                        <span className="text-sm font-medium text-[var(--fp-text)] capitalize">
                          {h.provider}
                        </span>
                        <Badge tone={statusTone(h.status)}>{h.status.replace(/_/g, " ")}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t.overview.pendingTasks}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Link
                    href="/app/inbox"
                    className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-4 hover:border-[var(--fp-accent)] transition-colors"
                  >
                    <p className="text-2xl font-bold text-[var(--fp-text)]">
                      {formatInt(locale, unresolved)}
                    </p>
                    <p className="mt-1 text-xs text-[var(--fp-text-2)]">{t.overview.unresolvedConversations}</p>
                  </Link>
                  <Link
                    href="/app/automations"
                    className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-4 hover:border-[var(--fp-accent)] transition-colors"
                  >
                    <p className="text-2xl font-bold text-[var(--fp-text)]">
                      {formatInt(locale, drafts)}
                    </p>
                    <p className="mt-1 text-xs text-[var(--fp-text-2)]">{t.overview.draftWorkflows}</p>
                  </Link>
                </div>
                <p className="mt-4 text-xs text-[var(--fp-text-2)]">
                  {t.overview.pendingHint}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
