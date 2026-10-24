"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import {
  Plus, Users, Play, Pause, XCircle, RefreshCw, Target, AlertTriangle,
} from "lucide-react";

interface Campaign {
  id: string;
  name: string;
  type: string;
  status: string;
  channel: string | null;
  objective: string;
  dryRun: boolean;
  recipientCount: number;
  segmentName: string | null;
  createdAt: string;
  startedAt: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  dm_reengagement: "DM Re-engagement",
  email: "Email (simulated)",
  paid_ad: "Paid Ad (export only)",
  comment_to_dm: "Comment → DM",
  crm_sequence: "CRM Sequence",
};

const STATUS_TONES: Record<string, BadgeTone> = {
  draft: "gray",
  scheduled: "blue",
  running: "green",
  paused: "amber",
  completed: "cyan",
  cancelled: "red",
};

export default function RetargetingPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ campaigns: Campaign[] }>("/api/retargeting/campaigns");
      setCampaigns(res.campaigns);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: string, action: "pause" | "resume" | "stop") => {
    setActing(`${action}:${id}`);
    try {
      await api(`/api/retargeting/campaigns/${id}/${action}`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `Failed to ${action}`);
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Retargeting"
        description="Win back quiet contacts, re-engage commenters, and build paid-ad audiences from your own first-party data."
        actions={
          <>
            <Link href="/app/retargeting/segments">
              <Button variant="secondary">
                <Users className="h-4 w-4 mr-2" /> Audiences
              </Button>
            </Link>
            <Link href="/app/retargeting/new">
              <Button>
                <Plus className="h-4 w-4 mr-2" /> New campaign
              </Button>
            </Link>
          </>
        }
      />

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-[#FB7185]/40 bg-[#FB7185]/10 px-4 py-3 text-sm text-[var(--fp-text)]">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-[#FB7185]" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : campaigns.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No retargeting campaigns yet"
          description="Build an audience segment, pick a win-back play, review every recipient's eligibility, then launch with an explicit confirmation."
          action={
            <Link href="/app/retargeting/new">
              <Button><Plus className="h-4 w-4 mr-2" /> Create your first campaign</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4">
          {campaigns.map((c) => (
            <Card key={c.id}>
              <CardContent className="flex flex-wrap items-center gap-4 p-4 sm:p-5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/app/retargeting/${c.id}`}
                      className="text-base font-semibold text-[var(--fp-text)] hover:underline truncate"
                    >
                      {c.name}
                    </Link>
                    <Badge tone={STATUS_TONES[c.status] ?? "gray"}>{c.status}</Badge>
                    <Badge tone="blue">{TYPE_LABELS[c.type] ?? c.type}</Badge>
                    {c.dryRun && <Badge tone="amber">DRY RUN</Badge>}
                    {(c.type === "email" || c.type === "crm_sequence") && (
                      <Badge tone="gray">SIMULATED</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-[var(--fp-text-2)] truncate">
                    {c.channel ? `${c.channel} · ` : ""}
                    {c.segmentName ? `Audience: ${c.segmentName} · ` : "No audience yet · "}
                    {c.recipientCount} recipient{c.recipientCount === 1 ? "" : "s"}
                    {c.objective ? ` · ${c.objective}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {c.status === "running" && (
                    <Button
                      variant="secondary" size="sm"
                      disabled={acting === `pause:${c.id}`}
                      onClick={() => act(c.id, "pause")}
                    >
                      <Pause className="h-3.5 w-3.5 mr-1.5" /> Pause
                    </Button>
                  )}
                  {c.status === "paused" && (
                    <Button
                      variant="secondary" size="sm"
                      disabled={acting === `resume:${c.id}`}
                      onClick={() => act(c.id, "resume")}
                    >
                      <Play className="h-3.5 w-3.5 mr-1.5" /> Resume
                    </Button>
                  )}
                  {(c.status === "draft" || c.status === "scheduled") && (
                    <Link href={`/app/retargeting/new?from=${c.id}`}>
                      <Button variant="secondary" size="sm">
                        <Play className="h-3.5 w-3.5 mr-1.5" /> Review & launch
                      </Button>
                    </Link>
                  )}
                  {["running", "paused"].includes(c.status) && (
                    <Button
                      variant="danger" size="sm"
                      disabled={acting === `stop:${c.id}`}
                      onClick={() => act(c.id, "stop")}
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1.5" /> Stop
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={load} title="Refresh">
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
