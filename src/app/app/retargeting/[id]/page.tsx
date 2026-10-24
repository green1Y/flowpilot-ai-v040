"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import {
  ArrowLeft, Play, Pause, XCircle, Send, AlertTriangle, RefreshCw, Download,
} from "lucide-react";

interface Campaign {
  id: string; name: string; type: string; status: string;
  channel: string | null; objective: string; dryRun: boolean;
  message: Record<string, any>; schedule: Record<string, any>; budget: Record<string, any>;
  createdAt: string; startedAt: string | null; completedAt: string | null;
}
interface Recipient {
  id: string; contactId: string; contactName: string | null;
  contactEmail: string | null; status: string;
  eligibility: Record<string, any>; attempts: number; lastError: string | null;
  sentAt: string | null;
}
interface Metric { value: number | null; source: "measured" | "estimated" | "not_tracked"; note?: string }
interface Report {
  campaignId: string; status: string; type: string; dryRun: boolean;
  recipients: Record<string, number>;
  attempted: Metric; delivered: Metric; failed: Metric; replies: Metric;
  clicks: Metric; conversions: Metric; spend: Metric; roas: Metric;
  simulatedSends: number; mockedSends: number;
}

const TYPE_LABELS: Record<string, string> = {
  dm_reengagement: "DM Re-engagement",
  email: "Email (simulated)",
  paid_ad: "Paid Ad (export only)",
  comment_to_dm: "Comment → DM",
  crm_sequence: "CRM Sequence",
};
const STATUS_TONES: Record<string, BadgeTone> = {
  draft: "gray", scheduled: "blue", running: "green", paused: "amber", completed: "cyan", cancelled: "red",
};
const RECIPIENT_TONES: Record<string, BadgeTone> = {
  pending: "gray", sent: "green", delivered: "cyan", failed: "red", skipped: "amber", replied: "blue",
};
const SOURCE_LABELS: Record<Metric["source"], string> = {
  measured: "measured", estimated: "estimated", not_tracked: "not tracked",
};
const SOURCE_TONES: Record<Metric["source"], BadgeTone> = {
  measured: "green", estimated: "amber", not_tracked: "gray",
};

function MetricRow({ label, metric, suffix }: { label: string; metric: Metric; suffix?: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--fp-border)] px-3 py-2.5">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {metric.note && <p className="text-xs text-[var(--fp-text-2)] mt-0.5 max-w-md">{metric.note}</p>}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-lg font-bold">
          {metric.value === null ? "—" : `${metric.value}${suffix ?? ""}`}
        </span>
        <Badge tone={SOURCE_TONES[metric.source]}>{SOURCE_LABELS[metric.source]}</Badge>
      </div>
    </div>
  );
}

export default function RetargetingDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [totalRecipients, setTotalRecipients] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detail, rep] = await Promise.all([
        api<{ campaign: Campaign; recipients: Recipient[]; totalRecipients: number }>(
          `/api/retargeting/campaigns/${id}`
        ),
        api<{ report: Report }>(`/api/retargeting/campaigns/${id}/report`).catch(() => null),
      ]);
      setCampaign(detail.campaign);
      setRecipients(detail.recipients);
      setTotalRecipients(detail.totalRecipients);
      if (rep) setReport(rep.report);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load campaign");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const act = async (action: string, method: "POST" = "POST") => {
    setActing(true);
    setError(null);
    try {
      await api(`/api/retargeting/campaigns/${id}/${action}`, { method });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `Failed to ${action}`);
    } finally {
      setActing(false);
    }
  };

  const filtered = statusFilter === "all" ? recipients : recipients.filter((r) => r.status === statusFilter);

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (!campaign) {
    return (
      <div className="space-y-4">
        <Link href="/app/retargeting"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1.5" /> Back</Button></Link>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    );
  }

  const schedule = campaign.schedule ?? {};
  const budget = campaign.budget ?? {};

  return (
    <div className="space-y-6">
      <PageHeader
        title={campaign.name}
        description={`${TYPE_LABELS[campaign.type] ?? campaign.type}${campaign.channel ? ` · ${campaign.channel}` : ""}`}
        actions={
          <>
            <Link href="/app/retargeting">
              <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1.5" /> Back</Button>
            </Link>
            {campaign.status === "draft" && (
              <Link href={`/app/retargeting/new?from=${campaign.id}`}>
                <Button size="sm"><Play className="h-3.5 w-3.5 mr-1.5" /> Review & launch</Button>
              </Link>
            )}
            {campaign.status === "running" && (
              <>
                <Button variant="secondary" size="sm" disabled={acting} onClick={() => act("process")}>
                  <Send className="h-3.5 w-3.5 mr-1.5" /> Process batch
                </Button>
                <Button variant="secondary" size="sm" disabled={acting} onClick={() => act("pause")}>
                  <Pause className="h-3.5 w-3.5 mr-1.5" /> Pause
                </Button>
                <Button variant="danger" size="sm" disabled={acting} onClick={() => act("stop")}>
                  <XCircle className="h-3.5 w-3.5 mr-1.5" /> Stop
                </Button>
              </>
            )}
            {campaign.status === "paused" && (
              <>
                <Button variant="secondary" size="sm" disabled={acting} onClick={() => act("resume")}>
                  <Play className="h-3.5 w-3.5 mr-1.5" /> Resume
                </Button>
                <Button variant="danger" size="sm" disabled={acting} onClick={() => act("stop")}>
                  <XCircle className="h-3.5 w-3.5 mr-1.5" /> Stop
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={load} title="Refresh"><RefreshCw className="h-3.5 w-3.5" /></Button>
          </>
        }
      />

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-[#FB7185]/40 bg-[#FB7185]/10 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-[#FB7185]" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Badge tone={STATUS_TONES[campaign.status] ?? "gray"}>{campaign.status}</Badge>
        <Badge tone="blue">{TYPE_LABELS[campaign.type] ?? campaign.type}</Badge>
        {campaign.dryRun && <Badge tone="amber">DRY RUN</Badge>}
        {(campaign.type === "email" || campaign.type === "crm_sequence") && <Badge tone="gray">SIMULATED</Badge>}
        {report && report.mockedSends > 0 && <Badge tone="amber">{report.mockedSends} mock-backed send{report.mockedSends === 1 ? "" : "s"}</Badge>}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Setup</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {campaign.objective && <p><span className="text-[var(--fp-text-2)]">Objective: </span>{campaign.objective}</p>}
            {campaign.message?.body && (
              <p><span className="text-[var(--fp-text-2)]">Message: </span><span className="whitespace-pre-wrap">{campaign.message.body}</span></p>
            )}
            {schedule.startsAt && <p><span className="text-[var(--fp-text-2)]">Starts: </span>{new Date(schedule.startsAt).toLocaleString()}</p>}
            {schedule.endsAt && <p><span className="text-[var(--fp-text-2)]">Ends: </span>{new Date(schedule.endsAt).toLocaleString()}</p>}
            {schedule.timezone && <p><span className="text-[var(--fp-text-2)]">Timezone: </span>{schedule.timezone}</p>}
            {schedule.frequencyCap?.maxPerContactPerDay && (
              <p><span className="text-[var(--fp-text-2)]">Frequency cap: </span>{schedule.frequencyCap.maxPerContactPerDay}/contact/day</p>
            )}
            {budget.amount != null && <p><span className="text-[var(--fp-text-2)]">Planned budget: </span>{budget.amount} {budget.currency ?? ""}</p>}
            {campaign.startedAt && <p><span className="text-[var(--fp-text-2)]">Started: </span>{new Date(campaign.startedAt).toLocaleString()}</p>}
            {campaign.completedAt && <p><span className="text-[var(--fp-text-2)]">Completed: </span>{new Date(campaign.completedAt).toLocaleString()}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Report</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {report ? (
              <>
                <MetricRow label="Attempted" metric={report.attempted} />
                <MetricRow label="Delivered" metric={report.delivered} />
                <MetricRow label="Failed" metric={report.failed} />
                <MetricRow label="Replies (approx.)" metric={report.replies} />
                <MetricRow label="Clicks" metric={report.clicks} />
                <MetricRow label="Conversions" metric={report.conversions} />
                <MetricRow label="Spend" metric={report.spend} />
                <MetricRow label="ROAS" metric={report.roas} />
                {report.simulatedSends > 0 && (
                  <p className="text-xs text-[var(--fp-text-2)]">{report.simulatedSends} simulated send(s) — logged, not delivered through a live provider.</p>
                )}
              </>
            ) : (
              <p className="text-sm text-[var(--fp-text-2)]">No report yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recipients ({totalRecipients})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {["all", "pending", "sent", "delivered", "skipped", "failed", "replied"].map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${statusFilter === s ? "bg-[var(--fp-accent)] text-white" : "bg-[var(--fp-bg-2)] text-[var(--fp-text-2)]"}`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-[var(--fp-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--fp-bg-2)]">
                <tr className="text-left text-[var(--fp-text-2)] text-xs">
                  <th className="px-3 py-2">Contact</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Eligibility</th>
                  <th className="px-3 py-2">Attempts</th>
                  <th className="px-3 py-2">Sent at</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-t border-[var(--fp-border)]">
                    <td className="px-3 py-2">
                      {r.contactName ?? r.contactId}
                      {r.contactEmail && <span className="block text-xs text-[var(--fp-text-2)]">{r.contactEmail}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={RECIPIENT_TONES[r.status] ?? "gray"}>{r.status}</Badge>
                      {r.lastError && <span className="block text-xs text-red-400 mt-1 max-w-xs truncate" title={r.lastError}>{r.lastError}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--fp-text-2)] max-w-xs">
                      {r.eligibility?.ineligibleReasons?.length > 0 ? (
                        <span className="text-amber-500">{(r.eligibility.ineligibleReasons as string[]).join("; ")}</span>
                      ) : (
                        <span>{(r.eligibility?.reasons as string[] | undefined)?.[0] ?? "—"}</span>
                      )}
                      {r.eligibility?.mocked && <Badge tone="amber" className="ml-1">mocked</Badge>}
                      {r.eligibility?.simulated && <Badge tone="gray" className="ml-1">simulated</Badge>}
                    </td>
                    <td className="px-3 py-2">{r.attempts}</td>
                    <td className="px-3 py-2 text-xs">{r.sentAt ? new Date(r.sentAt).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && <p className="p-4 text-sm text-[var(--fp-text-2)]">No recipients with this status.</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
