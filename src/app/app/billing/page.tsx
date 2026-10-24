"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { CreditCard, Check, Receipt } from "lucide-react";

/* ------------------------------------------------------------------ */

interface PlanInfo {
  id: string;
  name: string;
  monthlyMessageLimit: number;
  workflowLimit: number;
  seatLimit: number;
  features: string[];
}

interface UsageInfo {
  month: string;
  messagesSent: number;
  messagesReceived: number;
  workflowsRun: number;
  automationsRun: number;
  apiCalls: number;
  seatsUsed: number;
  workflowsTotal: number;
}

interface BillingData {
  plan: PlanInfo;
  usage: UsageInfo;
  note: string;
  /**
   * Plan-assignment provenance (Batch C §7.22), added by the billing API in
   * a parallel workstream. Optional + defensively read: when the field is
   * absent from the response, nothing extra renders.
   */
  assignment?: {
    source?: string;
    note?: string | null;
  } | null;
}

const TIERS: {
  name: string;
  tagline: string;
  features: string[];
}[] = [
  {
    name: "Starter",
    tagline: "For trying FlowPilot on one brand.",
    features: ["500 messages / month", "5 workflows", "3 seats", "Core automations", "Community support"],
  },
  {
    name: "Growth",
    tagline: "For teams scaling AI conversations.",
    features: ["5,000 messages / month", "25 workflows", "10 seats", "Advanced workflows + approvals", "Priority support"],
  },
  {
    name: "Agency",
    tagline: "For agencies and high volume.",
    features: ["25,000 messages / month", "200 workflows", "25 seats", "White-label + API access", "Dedicated success manager"],
  },
];

function UsageBar({ label, used, limit, suffix }: { label: string; used: number; limit: number; suffix?: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const over = used >= limit;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium text-[var(--fp-text)]">
          {label}
          {over && <Badge tone="red" className="ml-2">limit reached</Badge>}
        </span>
        <span className="text-[var(--fp-text-2)]">
          {used.toLocaleString()} / {limit.toLocaleString()}
          {suffix ? <span className="text-xs"> · {suffix}</span> : null}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--fp-bg-2)]">
        <div
          className={`h-full rounded-full ${over ? "bg-[#FB7185]" : pct >= 90 ? "bg-[#FBBF24]" : "bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function BillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeTier, setUpgradeTier] = useState<string | null>(null);

  const fetchBilling = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<BillingData>("/api/billing");
      setData(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBilling();
  }, [fetchBilling]);

  const openUpgrade = (tier: string) => {
    setUpgradeTier(tier);
    setUpgradeOpen(true);
  };

  return (
    <div>
      <PageHeader title="Billing" description="Your plan, usage and invoices." />

      {loading ? (
        <Spinner label="Loading billing…" />
      ) : error ? (
        <EmptyState icon={CreditCard} title="Couldn't load billing" description={error} />
      ) : !data ? (
        <EmptyState icon={CreditCard} title="No billing data" description="Billing info isn't available yet." />
      ) : (
        <div className="space-y-6">
          {/* Current plan + usage */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Current plan <Badge tone="violet">{data.plan.name}</Badge>
                <Badge tone="green">Live data</Badge>
                {data.assignment?.source === "demo" && (
                  <Badge tone="amber">Demo workspace</Badge>
                )}
              </CardTitle>
              {data.assignment?.source === "manual" && data.assignment?.note && (
                <p className="mt-1 text-xs text-[var(--fp-text-2)]">{data.assignment.note}</p>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <UsageBar
                label="Messages sent"
                used={data.usage.messagesSent}
                limit={data.plan.monthlyMessageLimit}
                suffix={data.usage.month}
              />
              <UsageBar
                label="Workflow runs"
                used={data.usage.workflowsRun}
                limit={data.plan.workflowLimit}
                suffix={data.usage.month}
              />
              <UsageBar label="Seats" used={data.usage.seatsUsed} limit={data.plan.seatLimit} />
              <div className="flex flex-wrap gap-4 border-t border-[var(--fp-border)] pt-3 text-sm text-[var(--fp-text-2)]">
                <span>Messages received: <strong className="text-[var(--fp-text)]">{data.usage.messagesReceived.toLocaleString()}</strong></span>
                <span>Workflows defined: <strong className="text-[var(--fp-text)]">{data.usage.workflowsTotal}</strong></span>
                <span>API calls: <strong className="text-[var(--fp-text)]">{data.usage.apiCalls.toLocaleString()}</strong></span>
              </div>
              <p className="text-xs text-[var(--fp-text-2)]">{data.note}</p>
            </CardContent>
          </Card>

          {/* Tiers */}
          <div>
            <h2 className="mb-3 text-lg font-semibold text-[var(--fp-text)]">Plans</h2>
            <div className="grid gap-4 md:grid-cols-3">
              {TIERS.map((t) => {
                const isCurrent = t.name === data.plan.name;
                return (
                  <Card key={t.name} className={isCurrent ? "border-[#8B5CF6] shadow-glow" : ""}>
                    <CardHeader>
                      <CardTitle>{t.name}</CardTitle>
                      {isCurrent && <Badge tone="violet">Current plan</Badge>}
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-[var(--fp-text-2)]">{t.tagline}</p>
                      <ul className="space-y-2">
                        {t.features.map((f) => (
                          <li key={f} className="flex items-start gap-2 text-sm text-[var(--fp-text-2)]">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#34D399]" />
                            {f}
                          </li>
                        ))}
                      </ul>
                      {isCurrent ? (
                        <Button variant="secondary" disabled className="w-full">Current plan</Button>
                      ) : (
                        <Button variant="secondary" className="w-full" onClick={() => openUpgrade(t.name)}>
                          Upgrade to {t.name}
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-[var(--fp-text-2)]">
              Plans are managed by your administrator — no payment is collected here and nothing is charged automatically.
            </p>
          </div>

          {/* History */}
          <div>
            <h2 className="mb-3 text-lg font-semibold text-[var(--fp-text)]">Billing history</h2>
            <div className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)]">
              <EmptyState
                icon={Receipt}
                title="No invoices yet"
                description="Invoices will appear here once billing is enabled for your workspace."
              />
            </div>
          </div>
        </div>
      )}

      <Modal open={upgradeOpen} onClose={() => setUpgradeOpen(false)} title={upgradeTier ? `Upgrade to ${upgradeTier}` : "Upgrade plan"}>
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-xl border border-[#FBBF24]/30 bg-[#FBBF24]/10 px-4 py-3">
            <CreditCard className="mt-0.5 h-5 w-5 shrink-0 text-[#FBBF24]" />
            <p className="text-sm text-[var(--fp-text-2)]">
              Plans are managed by your FlowPilot administrator. There is no self-serve checkout in
              this build — no payment was processed and your plan was not changed. Contact your
              administrator to request a plan change.
            </p>
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setUpgradeOpen(false)}>Understood</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
