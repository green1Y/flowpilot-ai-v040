"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { api, ApiError, useAccountSelection } from "@/lib/api-client";
import { useDict, useLocale } from "@/i18n/client";
import { formatInt, formatPct as formatPctLocale, formatDuration } from "@/i18n/format";
import type { Locale } from "@/i18n/config";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Tabs } from "@/components/ui/Tabs";
import {
  BarChart3,
  LayoutDashboard,
  Workflow as WorkflowIcon,
  MessageCircle,
  Inbox as InboxIcon,
  Users,
  Target,
  Radio,
  Megaphone,
} from "lucide-react";
import {
  MetricCard,
  RealBadge,
  LineChart,
  BarChart,
  DonutChart,
  FunnelChart,
  DataTable,
  ChartEmptyState,
  ChartSkeleton,
  PALETTE,
  SERIES_COLORS,
} from "@/components/charts";

/* ------------------------------------------------------------------ */
/* Helpers (locale-aware via the useFmt hook below)                    */
/* ------------------------------------------------------------------ */

/** Locale-bound number/duration/percent formatters for this page. */
function useFmt() {
  const locale: Locale = useLocale();
  return {
    locale,
    num: (n: number | null | undefined) => formatInt(locale, n),
    dur: (sec: number | null | undefined) => formatDuration(locale, sec),
    pct: (v: number | null | undefined, digits = 1) => formatPctLocale(locale, v, digits),
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface PrevBlock {
  label: string;
  metrics: Record<string, number | null>;
}

/** Fetch wrapper for one analytics endpoint. */
function TabPanel({
  endpoint,
  query,
  children,
}: {
  endpoint: string;
  query: Record<string, string>;
  children: (data: { metrics: Record<string, any>; series: any[]; previousPeriod?: PrevBlock } & Record<string, any>) => ReactNode;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(query);
  const t = useDict();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<any>(`/api/analytics/${endpoint}`, { params: JSON.parse(key) })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : "Failed to load analytics");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, key]);

  if (loading) return <ChartSkeleton />;
  if (error)
    return <EmptyState icon={BarChart3} title={t.analytics.couldntLoad} description={error} action={null} />;
  if (!data) return <ChartEmptyState title={t.analytics.couldntLoad} />;
  return (
    <>
      {/* Batch C: honest labeling — only shown when the API says this
          response opted into test data (?includeTestData). */}
      {data.testDataIncluded ? (
        <div className="mb-4">
          <Badge tone="amber">{t.analytics.testDataIncluded}</Badge>
        </div>
      ) : null}
      {children(data)}
    </>
  );
}

function SectionTitle({ children, drill }: { children: ReactNode; drill?: { href: string; label: string } }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--fp-text)]">
        {children} <RealBadge />
      </h2>
      {drill && (
        <Link href={drill.href} className="text-xs font-medium text-[#8B5CF6] hover:underline">
          {drill.label} →
        </Link>
      )}
    </div>
  );
}

function KpiGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 md:grid-cols-4">{children}</div>;
}

function PrevNote({ prev }: { prev?: PrevBlock }) {
  const t = useDict();
  if (!prev) return null;
  return <p className="text-xs text-[var(--fp-text-2)]">{t.analytics.deltasNote.replace("{label}", prev.label.replace(/^vs /, ""))}</p>;
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function OverviewTab({ query }: { query: Record<string, string> }) {
  const t = useDict();
  const { num, dur, pct } = useFmt();
  const exportUrl = (metric: "messages" | "campaigns" | "leads") => {
    const { from, to, channel } = queryParams(query);
    const params = new URLSearchParams({ metric, from, to, ...(channel ? { channel } : {}) });
    return `/api/analytics/export?${params.toString()}`;
  };
  return (
    <TabPanel endpoint="overview" query={query}>
      {(d) => {
        const m = d.metrics;
        const prev = d.previousPeriod as PrevBlock | undefined;
        const active = m.conversations > 0 || m.messagesIn > 0 || m.messagesOut > 0;
        if (!active)
          return (
            <ChartEmptyState
              title={t.analytics.noActivity}
              description={t.analytics.noActivityHint}
            />
          );
        const pd = prev?.metrics ?? {};
        const tm = t.analytics.metrics;
        const ts = t.analytics.series;
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle>{t.analytics.sectionOverview}</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {(["messages", "campaigns", "leads"] as const).map((metric) => (
                  <a
                    key={metric}
                    href={exportUrl(metric)}
                    className="rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-3 py-1.5 text-xs font-medium text-[var(--fp-text)] hover:border-[#8B5CF6]"
                  >
                    {t.analytics.exportCsv.replace("{metric}", metric)}
                  </a>
                ))}
              </div>
            </div>
            <KpiGrid>
              <MetricCard label={tm.conversations.label} value={num(m.conversations)} delta={pd.conversationsDelta} definition={tm.conversations.def} />
              <MetricCard label={tm.messagesIn.label} value={num(m.messagesIn)} delta={pd.messagesInDelta} definition={tm.messagesIn.def} />
              <MetricCard label={tm.messagesOut.label} value={num(m.messagesOut)} delta={pd.messagesOutDelta} definition={tm.messagesOut.def} />
              <MetricCard label={tm.newLeads.label} value={num(m.newLeads)} delta={pd.newLeadsDelta} definition={tm.newLeads.def} />
              <MetricCard label={tm.aiHandled.label} value={pct(m.aiHandledPct)} definition={tm.aiHandled.def} />
              <MetricCard label={tm.workflowRuns.label} value={num(m.workflowRuns)} delta={pd.workflowRunsDelta} definition={tm.workflowRuns.def} />
              <MetricCard label={tm.conversionRate.label} value={pct(m.conversionRate)} definition={tm.conversionRate.def} />
              <MetricCard label={tm.medianFirstResponse.label} value={dur(m.medianFirstResponseSec)} definition={tm.medianFirstResponse.def} />
            </KpiGrid>
            <PrevNote prev={prev} />
            <Card>
              <CardHeader>
                <CardTitle>{t.analytics.activityOverTime}</CardTitle>
              </CardHeader>
              <CardContent>
                <LineChart
                  data={d.series}
                  series={[
                    { key: "conversations", name: ts.conversations, color: PALETTE.primary },
                    { key: "leads", name: ts.newLeads, color: PALETTE.secondary },
                    { key: "inbound", name: ts.inboundMsgs, color: PALETTE.teal },
                    { key: "outbound", name: ts.outboundMsgs, color: PALETTE.indigo },
                  ]}
                />
              </CardContent>
            </Card>
          </div>
        );
      }}
    </TabPanel>
  );
}

function AutomationsTab({ query }: { query: Record<string, string> }) {
  const t = useDict();
  const { num, dur, pct } = useFmt();
  return (
    <TabPanel endpoint="workflows" query={query}>
      {(d) => {
        const m = d.metrics;
        const prev = d.previousPeriod as PrevBlock | undefined;
        const pd = prev?.metrics ?? {};
        if (m.runs === 0 && (d.perWorkflow ?? []).length === 0)
          return (
            <ChartEmptyState
              title={t.analytics.noWorkflowRuns}
              description={t.analytics.noWorkflowRunsHint}
            />
          );
        const tm = t.analytics.metrics;
        const ts = t.analytics.series;
        const tt = t.analytics.table;
        return (
          <div className="space-y-4">
            <SectionTitle drill={{ href: "/app/automations", label: t.analytics.viewWorkflows }}>{t.analytics.sectionAutomations}</SectionTitle>
            <KpiGrid>
              <MetricCard label={tm.totalRuns.label} value={num(m.runs)} delta={pd.runsDelta} definition={tm.totalRuns.def} />
              <MetricCard label={tm.successRate.label} value={pct(m.successRate)} deltaPoints={pd.successRateDeltaPp} definition={tm.successRate.def} />
              <MetricCard label={tm.avgDuration.label} value={dur(m.avgDurationMs != null ? m.avgDurationMs / 1000 : null)} definition={tm.avgDuration.def} />
              <MetricCard label={tm.activeWorkflows.label} value={num(m.workflowsActive)} definition={tm.activeWorkflows.def} />
            </KpiGrid>
            <PrevNote prev={prev} />
            <Card>
              <CardHeader>
                <CardTitle>{t.analytics.runsOverTime}</CardTitle>
              </CardHeader>
              <CardContent>
                <LineChart
                  data={d.series}
                  series={[
                    { key: "runs", name: ts.runs, color: PALETTE.primary },
                    { key: "succeeded", name: ts.succeeded, color: PALETTE.success },
                    { key: "failed", name: ts.failed, color: PALETTE.error },
                  ]}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t.analytics.workflowPerformance}</CardTitle>
              </CardHeader>
              <CardContent>
                <DataTable
                  rowKey={(r: any) => r.id}
                  rows={d.perWorkflow}
                  emptyMessage={t.analytics.noWorkflowRuns}
                  columns={[
                    { key: "name", header: tt.workflow, render: (r: any) => <span className="font-medium">{r.name}</span> },
                    { key: "status", header: tt.status, render: (r: any) => <Badge tone={r.status === "PUBLISHED" ? "green" : "gray"}>{r.status}</Badge> },
                    { key: "runs", header: tt.runs, align: "right", render: (r: any) => num(r.runs) },
                    { key: "successRate", header: tt.success, align: "right", render: (r: any) => pct(r.successRate) },
                    { key: "avgDurationMs", header: tt.avgDuration, align: "right", render: (r: any) => dur(r.avgDurationMs != null ? r.avgDurationMs / 1000 : null) },
                  ]}
                />
              </CardContent>
            </Card>
          </div>
        );
      }}
    </TabPanel>
  );
}

function CommentToDmTab({ query }: { query: Record<string, string> }) {
  const t = useDict();
  const { num, pct } = useFmt();
  return (
    <TabPanel endpoint="comment-to-dm" query={query}>
      {(d) => {
        const m = d.metrics;
        const prev = d.previousPeriod as PrevBlock | undefined;
        const pd = prev?.metrics ?? {};
        if (m.comments === 0)
          return (
            <ChartEmptyState
              title={t.analytics.noComments}
              description={t.analytics.noCommentsHint}
            />
          );
        const tm = t.analytics.metrics;
        const ts = t.analytics.series;
        const tt = t.analytics.table;
        return (
          <div className="space-y-4">
            <SectionTitle drill={{ href: "/app/follow-ups", label: t.analytics.viewFollowUps }}>{t.analytics.sectionCommentToDm}</SectionTitle>
            <KpiGrid>
              <MetricCard label={tm.comments.label} value={num(m.comments)} delta={pd.commentsDelta} definition={tm.comments.def} />
              <MetricCard label={tm.privateReplies.label} value={num(m.privateReplies)} delta={pd.privateRepliesDelta} definition={tm.privateReplies.def} />
              <MetricCard label={tm.replyRate.label} value={pct(m.replyRate)} deltaPoints={pd.replyRateDeltaPp} definition={tm.replyRate.def} />
              <MetricCard label={tm.avgReplyDelay.label} value={m.avgReplyDelayMinutes != null ? `${num(Math.round(m.avgReplyDelayMinutes))} min` : "—"} definition={tm.avgReplyDelay.def} />
            </KpiGrid>
            {m.windowExpired > 0 && (
              <p className="text-xs text-[var(--fp-text-2)]">
                {t.analytics.windowExpired.replace("{count}", num(m.windowExpired))}
              </p>
            )}
            <PrevNote prev={prev} />
            <Card>
              <CardHeader>
                <CardTitle>{t.analytics.commentsRepliesOverTime}</CardTitle>
              </CardHeader>
              <CardContent>
                <LineChart
                  data={d.series}
                  series={[
                    { key: "comments", name: ts.comments, color: PALETTE.primary },
                    { key: "replies", name: ts.privateReplies, color: PALETTE.secondary },
                  ]}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t.analytics.topPosts}</CardTitle>
              </CardHeader>
              <CardContent>
                <DataTable
                  rowKey={(r: any) => r.mediaId}
                  rows={d.topMedia}
                  emptyMessage={t.analytics.noComments}
                  columns={[
                    { key: "mediaId", header: tt.post, render: (r: any) => <span className="font-mono text-xs">{r.mediaId.slice(0, 24)}…</span> },
                    { key: "mediaType", header: tt.type, render: (r: any) => r.mediaType ?? "—" },
                    { key: "comments", header: tt.comments, align: "right", render: (r: any) => num(r.comments) },
                    { key: "replies", header: tt.replies, align: "right", render: (r: any) => num(r.replies) },
                    { key: "rate", header: tt.replyRate, align: "right", render: (r: any) => pct(r.comments > 0 ? (r.replies / r.comments) * 100 : null) },
                  ]}
                />
              </CardContent>
            </Card>
          </div>
        );
      }}
    </TabPanel>
  );
}

function InboxTab({ query }: { query: Record<string, string> }) {
  const t = useDict();
  const { num, dur, pct } = useFmt();
  return (
    <TabPanel endpoint="inbox" query={query}>
      {(d) => {
        const m = d.metrics;
        const prev = d.previousPeriod as PrevBlock | undefined;
        const pd = prev?.metrics ?? {};
        if (m.conversations === 0)
          return (
            <ChartEmptyState
              title={t.analytics.noInboxConversations}
              description={t.analytics.noInboxConversationsHint}
            />
          );
        const tm = t.analytics.metrics;
        const ts = t.analytics.series;
        const statusDonut = Object.entries(m.byStatus ?? {}).map(([name, value], i) => ({
          name,
          value: value as number,
          color: [PALETTE.warning, PALETTE.secondary, PALETTE.success, PALETTE.slate][i % 4],
        }));
        return (
          <div className="space-y-4">
            <SectionTitle drill={{ href: "/app/inbox", label: t.analytics.openInbox }}>{t.analytics.sectionInbox}</SectionTitle>
            <KpiGrid>
              <MetricCard label={tm.conversations.label} value={num(m.conversations)} delta={pd.conversationsDelta} definition={tm.conversations.def} />
              <MetricCard label={tm.messagesIn.label} value={num(m.messagesIn)} delta={pd.messagesInDelta} definition={tm.messagesIn.def} />
              <MetricCard label={tm.messagesOut.label} value={num(m.messagesOut)} delta={pd.messagesOutDelta} definition={tm.messagesOut.def} />
              <MetricCard label={tm.aiHandled.label} value={pct(m.aiHandledPct)} definition={tm.aiHandled.def} />
              <MetricCard label={tm.medianFirstResponse.label} value={dur(m.medianFirstResponseSec)} definition={tm.medianFirstResponse.def} />
              <MetricCard label={tm.resolved.label} value={num(m.resolved)} delta={pd.resolvedDelta} definition={tm.resolved.def} />
              <MetricCard label={tm.openNow.label} value={num(m.open)} definition={tm.openNow.def} />
              <MetricCard label={tm.humanTakeovers.label} value={num(m.humanTakeover)} definition={tm.humanTakeovers.def} />
            </KpiGrid>
            <PrevNote prev={prev} />
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{t.analytics.messagesOverTime}</CardTitle>
                </CardHeader>
                <CardContent>
                  <LineChart
                    data={d.series}
                    series={[
                      { key: "inbound", name: ts.inbound, color: PALETTE.secondary },
                      { key: "outbound", name: ts.outbound, color: PALETTE.primary },
                    ]}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t.analytics.conversationsByStatus}</CardTitle>
                </CardHeader>
                <CardContent>
                  <DonutChart data={statusDonut} />
                </CardContent>
              </Card>
            </div>
            <Card>
              <CardHeader>
                <CardTitle>{t.analytics.conversationsByChannel}</CardTitle>
              </CardHeader>
              <CardContent>
                <BarChart
                  data={(d.byChannel ?? []).map((c: any) => ({ channel: c.channel, count: c.count }))}
                  xKey="channel"
                  bars={[{ key: "count", name: ts.conversations }]}
                  colorByIndex
                  formatX={(v) => v}
                />
              </CardContent>
            </Card>
          </div>
        );
      }}
    </TabPanel>
  );
}

const STAGE_COLORS: Record<string, string> = {
  NEW: PALETTE.slate,
  CONTACTED: PALETTE.secondary,
  QUALIFIED: PALETTE.indigo,
  INTERESTED: PALETTE.primary,
  CONVERTED: PALETTE.emerald,
  LOST: PALETTE.rose,
};

function CrmTab({ query }: { query: Record<string, string> }) {
  const t = useDict();
  const { num, pct } = useFmt();
  return (
    <TabPanel endpoint="crm" query={query}>
      {(d) => {
        const m = d.metrics;
        const prev = d.previousPeriod as PrevBlock | undefined;
        const pd = prev?.metrics ?? {};
        if (m.total === 0)
          return (
            <ChartEmptyState
              title={t.analytics.noContacts}
              description={t.analytics.noContactsHint}
            />
          );
        const tm = t.analytics.metrics;
        const ts = t.analytics.series;
        return (
          <div className="space-y-4">
            <SectionTitle drill={{ href: "/app/contacts", label: t.analytics.viewContacts }}>{t.analytics.sectionCrm}</SectionTitle>
            <KpiGrid>
              <MetricCard label={tm.totalContacts.label} value={num(m.total)} definition={tm.totalContacts.def} />
              <MetricCard label={tm.newContacts.label} value={num(m.newContacts)} delta={pd.newContactsDelta} definition={tm.newContacts.def} />
              <MetricCard label={tm.converted.label} value={num(m.converted)} definition={tm.converted.def} />
              <MetricCard label={tm.conversionRate.label} value={pct(m.conversionRate)} definition={tm.conversionRate.def} />
              <MetricCard label={tm.optedOut.label} value={num(m.optedOut)} delta={pd.optedOutDelta} definition={tm.optedOut.def} />
              <MetricCard label={tm.avgLeadScore.label} value={m.avgLeadScore != null ? String(m.avgLeadScore) : "—"} definition={tm.avgLeadScore.def} />
            </KpiGrid>
            <PrevNote prev={prev} />
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{t.analytics.lifecycleFunnel}</CardTitle>
                </CardHeader>
                <CardContent>
                  <FunnelChart
                    data={(m.byStage ?? []).map((s: any) => ({
                      name: s.stage,
                      value: s.count,
                      color: STAGE_COLORS[s.stage] ?? PALETTE.slate,
                    }))}
                  />
                  <p className="mt-2 text-xs text-[var(--fp-text-2)]">
                    {t.analytics.funnelNote}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t.analytics.newContactsOverTime}</CardTitle>
                </CardHeader>
                <CardContent>
                  <BarChart
                    data={d.series}
                    xKey="date"
                    bars={[{ key: "count", name: ts.newContacts, color: PALETTE.primary }]}
                  />
                </CardContent>
              </Card>
            </div>
          </div>
        );
      }}
    </TabPanel>
  );
}

function RetargetingTab({ query }: { query: Record<string, string> }) {
  const t = useDict();
  const { num, pct } = useFmt();
  return (
    <TabPanel endpoint="retargeting" query={query}>
      {(d) => {
        const m = d.metrics;
        const prev = d.previousPeriod as PrevBlock | undefined;
        const pd = prev?.metrics ?? {};
        if (m.campaigns === 0)
          return (
            <ChartEmptyState
              title={t.analytics.noRetargeting}
              description={t.analytics.noRetargetingHint}
            />
          );
        const tm = t.analytics.metrics;
        const ts = t.analytics.series;
        const tt = t.analytics.table;
        return (
          <div className="space-y-4">
            <SectionTitle drill={{ href: "/app/campaigns", label: t.analytics.viewCampaigns }}>{t.analytics.sectionRetargeting}</SectionTitle>
            <KpiGrid>
              <MetricCard label={tm.campaigns.label} value={num(m.campaigns)} definition={tm.campaigns.def} />
              <MetricCard label={tm.sent.label} value={num(m.sent)} delta={pd.sentDelta} definition={tm.sent.def} />
              <MetricCard label={tm.delivered.label} value={num(m.delivered)} delta={pd.deliveredDelta} definition={tm.delivered.def} />
              <MetricCard label={tm.replied.label} value={num(m.replied)} delta={pd.repliedDelta} definition={tm.replied.def} />
              <MetricCard label={tm.replyRate.label} value={pct(m.replyRate)} definition={tm.replyRate.def} />
              <MetricCard label={tm.failed.label} value={num(m.failed)} definition={tm.failed.def} />
              <MetricCard label={tm.skipped.label} value={num(m.skipped)} definition={tm.skipped.def} />
            </KpiGrid>
            <PrevNote prev={prev} />
            <Card>
              <CardHeader>
                <CardTitle>{t.analytics.sendsRepliesOverTime}</CardTitle>
              </CardHeader>
              <CardContent>
                <LineChart
                  data={d.series}
                  series={[
                    { key: "sent", name: ts.sent, color: PALETTE.primary },
                    { key: "replied", name: ts.replied, color: PALETTE.success },
                  ]}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t.analytics.campaignPerformance}</CardTitle>
              </CardHeader>
              <CardContent>
                <DataTable
                  rowKey={(r: any) => r.id}
                  rows={d.perCampaign}
                  emptyMessage={t.analytics.noRetargeting}
                  columns={[
                    { key: "name", header: tt.campaign, render: (r: any) => <span className="font-medium">{r.name}</span> },
                    { key: "type", header: tt.type, render: (r: any) => <Badge tone="violet">{r.type}</Badge> },
                    { key: "status", header: tt.status, render: (r: any) => <span className="text-[var(--fp-text-2)]">{r.status}</span> },
                    { key: "sent", header: tt.sent, align: "right", render: (r: any) => num(r.sent) },
                    { key: "delivered", header: tt.delivered, align: "right", render: (r: any) => num(r.delivered) },
                    { key: "failed", header: tt.failed, align: "right", render: (r: any) => num(r.failed) },
                    { key: "skipped", header: tt.skipped, align: "right", render: (r: any) => num(r.skipped) },
                    { key: "replied", header: tt.replies, align: "right", render: (r: any) => num(r.replied) },
                    { key: "replyRate", header: tt.replyRate, align: "right", render: (r: any) => pct(r.replyRate) },
                  ]}
                />
              </CardContent>
            </Card>
          </div>
        );
      }}
    </TabPanel>
  );
}

function integrationTone(status: string | null): "green" | "amber" | "gray" {
  if (status === "CONNECTED") return "green";
  if (status === "NEEDS_ATTENTION") return "amber";
  return "gray";
}

function ChannelsTab({ query }: { query: Record<string, string> }) {
  const t = useDict();
  const { num } = useFmt();
  return (
    <TabPanel endpoint="channels" query={query}>
      {(d) => {
        const tt = t.analytics.table;
        const tm = t.analytics.metrics;
        const ts = t.analytics.series;
        const metrics = d.metrics.totals;
        const rows = d.metrics.channels ?? [];
        const active = rows.some((r: any) => r.conversations > 0 || r.messagesIn > 0 || r.messagesOut > 0);
        if (!active)
          return (
            <ChartEmptyState
              title={t.analytics.noChannelActivity}
              description={t.analytics.noChannelActivityHint}
            />
          );
        const prev = d.previousPeriod as PrevBlock | undefined;
        const pd = prev?.metrics ?? {};
        // Batch B: per-account rows carry integrationId/accountName —
        // label them by account so two accounts of one provider stay
        // distinguishable; plain per-channel rows keep the channel name.
        const rowLabel = (r: any): string =>
          r.integrationId && r.accountName ? `${r.channel} · ${r.accountName}` : r.channel;
        const inDonut = rows
          .filter((r: any) => r.messagesIn > 0)
          .map((r: any, i: number) => ({ name: rowLabel(r), value: r.messagesIn, color: SERIES_COLORS[i % SERIES_COLORS.length] }));
        return (
          <div className="space-y-4">
            <SectionTitle drill={{ href: "/app/integrations", label: t.analytics.manageIntegrations }}>{t.analytics.sectionChannels}</SectionTitle>
            <KpiGrid>
              <MetricCard label={tm.messagesIn.label} value={num(metrics.messagesIn)} delta={pd.messagesInDelta} definition={tm.messagesIn.def} />
              <MetricCard label={tm.messagesOut.label} value={num(metrics.messagesOut)} delta={pd.messagesOutDelta} definition={tm.messagesOut.def} />
              <MetricCard label={tm.outboundSent.label} value={num(metrics.outboundSent)} definition={tm.outboundSent.def} />
              <MetricCard label={tm.outboundFailed.label} value={num(metrics.outboundFailed)} definition={tm.outboundFailed.def} />
            </KpiGrid>
            <PrevNote prev={prev} />
            <Card>
              <CardHeader>
                <CardTitle>{t.analytics.channelBreakdown}</CardTitle>
              </CardHeader>
              <CardContent>
                <DataTable
                  rowKey={(r: any) => r.integrationId ?? r.channel}
                  rows={rows}
                  columns={[
                    {
                      key: "channel",
                      header: tt.channel,
                      render: (r: any) => (
                        <span className="font-medium">
                          <span className="capitalize">{r.channel}</span>
                          {r.integrationId && r.accountName && (
                            <span className="block text-xs font-normal text-[var(--fp-text-2)]">{r.accountName}</span>
                          )}
                        </span>
                      ),
                    },
                    { key: "integrationStatus", header: tt.connection, render: (r: any) => <Badge tone={integrationTone(r.integrationStatus)}>{r.integrationStatus ?? "DISCONNECTED"}</Badge> },
                    { key: "conversations", header: tt.conversations, align: "right", render: (r: any) => num(r.conversations) },
                    { key: "messagesIn", header: tt.inbound, align: "right", render: (r: any) => num(r.messagesIn) },
                    { key: "messagesOut", header: tt.outbound, align: "right", render: (r: any) => num(r.messagesOut) },
                    { key: "outboundSent", header: tt.sent, align: "right", render: (r: any) => num(r.outboundSent) },
                    { key: "outboundFailed", header: tt.failed, align: "right", render: (r: any) => num(r.outboundFailed) },
                  ]}
                />
                <p className="mt-2 text-xs text-[var(--fp-text-2)]">
                  {t.analytics.channelNote}
                </p>
              </CardContent>
            </Card>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{t.analytics.inboundShare}</CardTitle>
                </CardHeader>
                <CardContent>
                  {inDonut.length > 0 ? <DonutChart data={inDonut} /> : <p className="text-sm text-[var(--fp-text-2)]">{t.analytics.noInbound}</p>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t.analytics.conversationsByChannel}</CardTitle>
                </CardHeader>
                <CardContent>
                  <BarChart
                    data={rows.map((r: any) => ({ channel: rowLabel(r), count: r.conversations }))}
                    xKey="channel"
                    bars={[{ key: "count", name: ts.conversations }]}
                    colorByIndex
                    formatX={(v) => v}
                  />
                </CardContent>
              </Card>
            </div>
          </div>
        );
      }}
    </TabPanel>
  );
}

function AdvertisingTab({ query }: { query: Record<string, string> }) {
  const t = useDict();
  const { num } = useFmt();
  return (
    <TabPanel endpoint="advertising" query={query}>
      {(d) => {
        const m = d.metrics;
        const tm = t.analytics.metrics;
        const tt = t.analytics.table;
        if (!m.available) {
          return (
            <div className="space-y-4">
              <SectionTitle>{t.analytics.sectionAdvertising}</SectionTitle>
              <ChartEmptyState
                title={t.analytics.noAdData}
                description={m.note}
              />
            </div>
          );
        }
        return (
          <div className="space-y-4">
            <SectionTitle>{t.analytics.sectionAdvertising}</SectionTitle>
            <KpiGrid>
              <MetricCard label={tm.paidAdCampaigns.label} value={num(m.campaigns)} definition={tm.paidAdCampaigns.def} />
              <MetricCard
                label={tm.plannedBudget.label}
                value={m.plannedBudgetTotal != null ? `${num(m.plannedBudgetTotal)}${m.plannedBudgetCurrency ? ` ${m.plannedBudgetCurrency}` : ""}` : "—"}
                definition={tm.plannedBudget.def}
              />
              <MetricCard label={tm.adSpend.label} value={t.analytics.unavailable} definition={tm.adSpend.def} />
              <MetricCard label={tm.roas.label} value={t.analytics.unavailable} definition={tm.roas.def} />
            </KpiGrid>
            <Card>
              <CardHeader>
                <CardTitle>{t.analytics.campaignPerformance}</CardTitle>
              </CardHeader>
              <CardContent>
                <DataTable
                  rowKey={(r: any) => r.id}
                  rows={d.campaigns ?? []}
                  columns={[
                    { key: "name", header: tt.campaign, render: (r: any) => <span className="font-medium">{r.name}</span> },
                    { key: "status", header: tt.status, render: (r: any) => <span className="text-[var(--fp-text-2)]">{r.status}</span> },
                    { key: "plannedBudget", header: tt.plannedBudget, align: "right", render: (r: any) => (r.plannedBudget != null ? `${num(r.plannedBudget)}${r.currency ? ` ${r.currency}` : ""}` : "—") },
                  ]}
                />
                <p className="mt-2 text-xs text-[var(--fp-text-2)]">{m.note}</p>
              </CardContent>
            </Card>
          </div>
        );
      }}
    </TabPanel>
  );
}

/* ------------------------------------------------------------------ */
/* Query-string helpers for the page                                   */
/* ------------------------------------------------------------------ */

function queryParams(query: Record<string, string>): { from: string; to: string; channel?: string } {
  if (query.range === "custom") return { from: query.from, to: query.to, channel: query.channel };
  const days = query.range === "30d" ? 30 : query.range === "90d" ? 90 : 7;
  const to = new Date();
  return { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString(), channel: query.channel };
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const CHANNEL_FILTER_TABS = new Set(["overview", "inbox"]);

const CHANNELS = ["instagram", "facebook", "whatsapp", "telegram", "email", "webchat", "web"];

export default function AnalyticsPage() {
  const t = useDict();
  const [tab, setTab] = useState("overview");
  const [range, setRange] = useState("30d");
  const [compareOn, setCompareOn] = useState(true);
  const [channel, setChannel] = useState("");
  const [customFrom, setCustomFrom] = useState(() => isoDay(new Date(Date.now() - 30 * 86_400_000)));
  const [customTo, setCustomTo] = useState(() => isoDay(new Date()));

  const RANGES = [
    { value: "7d", label: t.analytics.range7d },
    { value: "30d", label: t.analytics.range30d },
    { value: "90d", label: t.analytics.range90d },
    { value: "custom", label: t.analytics.rangeCustom },
  ];

  const TABS = [
    { id: "overview", label: t.analytics.tabOverview, icon: LayoutDashboard },
    { id: "workflows", label: t.analytics.tabAutomations, icon: WorkflowIcon },
    { id: "comment-to-dm", label: t.analytics.tabCommentToDm, icon: MessageCircle },
    { id: "inbox", label: t.analytics.tabInbox, icon: InboxIcon },
    { id: "crm", label: t.analytics.tabCrm, icon: Users },
    { id: "retargeting", label: t.analytics.tabRetargeting, icon: Target },
    { id: "channels", label: t.analytics.tabChannels, icon: Radio },
    { id: "advertising", label: t.analytics.tabAdvertising, icon: Megaphone },
  ];

  const { accountId } = useAccountSelection();

  const query = useMemo(() => {
    const p: Record<string, string> = { range, compare: compareOn ? "on" : "off" };
    if (range === "custom") {
      p.from = customFrom;
      p.to = customTo;
    }
    if (channel && CHANNEL_FILTER_TABS.has(tab)) p.channel = channel;
    // Batch B: send the globally selected connected account with every
    // tab's request. Endpoints with account scoping (overview, channels,
    // detail) validate it against the workspace (403 on a foreign id) and
    // filter the metrics that carry an account dimension.
    if (accountId) p.integrationId = accountId;
    return p;
  }, [range, compareOn, channel, tab, customFrom, customTo, accountId]);

  const showChannelFilter = CHANNEL_FILTER_TABS.has(tab);

  return (
    <div>
      <PageHeader
        title={t.analytics.title}
        description={t.analytics.description}
        actions={
          <>
            <div className="w-40">
              <Select value={range} onChange={(e) => setRange(e.target.value)} options={RANGES} aria-label={t.analytics.dateRange} />
            </div>
            {showChannelFilter && (
              <div className="w-44">
                <Select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  options={CHANNELS.map((c) => ({ value: c, label: c }))}
                  placeholder={t.analytics.allChannels}
                  aria-label={t.analytics.filterByChannel}
                />
              </div>
            )}
          </>
        }
      />

      {/* Batch C: production-view label — the analytics APIs exclude
          mocked messages and DRY_RUN executions by default. */}
      <p className="mb-4 text-xs text-[var(--fp-text-2)]">{t.analytics.productionNote}</p>

      {range === "custom" && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="w-44">
            <Input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} aria-label={t.analytics.customStart} />
          </div>
          <div className="w-44">
            <Input type="date" value={customTo} min={customFrom} max={isoDay(new Date())} onChange={(e) => setCustomTo(e.target.value)} aria-label={t.analytics.customEnd} />
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="overflow-x-auto">
          <Tabs tabs={TABS} value={tab} onChange={setTab} />
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--fp-text-2)]">
          <input
            type="checkbox"
            checked={compareOn}
            onChange={(e) => setCompareOn(e.target.checked)}
            className="h-4 w-4 rounded accent-[#8B5CF6]"
          />
          {t.analytics.compare}
        </label>
      </div>

      <div key={`${tab}-${JSON.stringify(query)}`}>
        {tab === "overview" && <OverviewTab query={query} />}
        {tab === "workflows" && <AutomationsTab query={query} />}
        {tab === "comment-to-dm" && <CommentToDmTab query={query} />}
        {tab === "inbox" && <InboxTab query={query} />}
        {tab === "crm" && <CrmTab query={query} />}
        {tab === "retargeting" && <RetargetingTab query={query} />}
        {tab === "channels" && <ChannelsTab query={query} />}
        {tab === "advertising" && <AdvertisingTab query={query} />}
      </div>

      <p className="mt-6 text-xs text-[var(--fp-text-2)]">
        {t.analytics.footerNote}
      </p>
    </div>
  );
}
