"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import {
  ArrowLeft, ArrowRight, Check, AlertTriangle, ListChecks, Megaphone,
  Download, ShieldCheck,
} from "lucide-react";

const STEPS = [
  "Campaign",
  "Audience",
  "Message",
  "Schedule",
  "Review",
  "Confirm",
] as const;

const TYPE_OPTIONS = [
  { value: "dm_reengagement", label: "DM Re-engagement — win back quiet contacts via Instagram / Facebook / WhatsApp DM" },
  { value: "comment_to_dm", label: "Comment → DM — private-reply recent commenters (Instagram / Facebook, 7-day window)" },
  { value: "email", label: "Email — simulated sends (no delivery provider wired yet)" },
  { value: "crm_sequence", label: "CRM Sequence — log follow-up tasks for owners, no automatic send" },
  { value: "paid_ad", label: "Paid Ad — export a consent-flagged audience CSV for Meta Ads Manager (no ads created here)" },
];

const TYPE_CHANNELS: Record<string, string[]> = {
  dm_reengagement: ["instagram", "facebook", "whatsapp"],
  comment_to_dm: ["instagram", "facebook"],
  email: ["email"],
  crm_sequence: [],
  paid_ad: [],
};

interface Segment { id: string; name: string; description: string }
interface Verdict {
  contactId: string; name: string; eligible: boolean; channel: string | null;
  simulated: boolean; reasons: string[]; ineligibleReasons: string[];
}
interface ReviewData {
  eligible: number; skipped: number;
  segmentSummary: string; availabilityWarnings: string[];
  skippedSample: Array<{ contactId: string; name: string; reasons: string[] }>;
  verdicts: Verdict[];
  type: string; dryRun: boolean;
}
interface ChecklistItem { id: string; title: string; description: string; required: boolean }
interface LaunchResult {
  status: string; dryRun: boolean; eligible: number; skipped: number;
  paidAd?: { checklist: ChecklistItem[]; audienceCsv: string; exported: number; excluded: number; note: string };
}

function NewRetargetingWizard() {
  const searchParams = useSearchParams();
  const fromId = searchParams.get("from");

  const [step, setStep] = useState(0);
  const [campaignId, setCampaignId] = useState<string | null>(fromId);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // form state
  const [name, setName] = useState("");
  const [type, setType] = useState("dm_reengagement");
  const [objective, setObjective] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [segmentId, setSegmentId] = useState("");
  const [channel, setChannel] = useState("instagram");
  const [body, setBody] = useState("");
  const [messageType, setMessageType] = useState("freeform");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [timezone, setTimezone] = useState(
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"
  );
  const [capPerDay, setCapPerDay] = useState("1");
  const [budgetAmount, setBudgetAmount] = useState("");
  const [budgetCurrency, setBudgetCurrency] = useState("USD");

  const [review, setReview] = useState<ReviewData | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null);

  const channels = useMemo(() => TYPE_CHANNELS[type] ?? [], [type]);

  useEffect(() => {
    api<{ segments: Segment[] }>("/api/retargeting/segments")
      .then((r) => setSegments(r.segments))
      .catch(() => {});
  }, []);

  // Prefill when continuing an existing draft (?from=).
  useEffect(() => {
    if (!fromId) return;
    (async () => {
      try {
        const res = await api<{ campaign: any }>(`/api/retargeting/campaigns/${fromId}`);
        const c = res.campaign;
        setName(c.name ?? "");
        setType(c.type ?? "dm_reengagement");
        setObjective(c.objective ?? "");
        setDryRun(!!c.dryRun);
        setSegmentId(c.segmentId ?? "");
        setChannel(c.channel ?? "instagram");
        setBody((c.message as any)?.body ?? "");
        setMessageType((c.message as any)?.messageType ?? "freeform");
        setStartsAt((c.schedule as any)?.startsAt ?? "");
        setEndsAt((c.schedule as any)?.endsAt ?? "");
        setTimezone((c.schedule as any)?.timezone ?? timezone);
        setStep(4); // jump straight to review
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to load campaign");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromId]);

  useEffect(() => {
    if (channels.length > 0 && !channels.includes(channel)) setChannel(channels[0]);
  }, [channels, channel]);

  const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

  const createCampaign = async () => {
    setError(null);
    if (!name.trim()) { setError("Give the campaign a name first."); return; }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        type,
        objective,
        dryRun,
        segmentId: segmentId || null,
        message: {
          body: body.trim() || undefined,
          messageType: type === "dm_reengagement" ? messageType : undefined,
        },
        schedule: {
          startsAt: toIso(startsAt),
          endsAt: toIso(endsAt),
          timezone,
          frequencyCap: { maxPerContactPerDay: Math.max(1, parseInt(capPerDay || "1", 10)) },
        },
        budget: budgetAmount
          ? { amount: parseFloat(budgetAmount), currency: budgetCurrency || "USD" }
          : {},
      };
      if (channels.length > 0) payload.channel = channel;
      if (fromId && campaignId) {
        // Continuing an existing draft: update it in place instead of duplicating.
        await api(`/api/retargeting/campaigns/${campaignId}`, {
          method: "PATCH",
          body: payload,
        });
      } else {
        const res = await api<{ campaign: { id: string } }>("/api/retargeting/campaigns", {
          method: "POST",
          body: payload,
        });
        setCampaignId(res.campaign.id);
      }
      setStep(4);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to create campaign");
    } finally {
      setBusy(false);
    }
  };

  const loadReview = useCallback(async () => {
    if (!campaignId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<ReviewData>(`/api/retargeting/campaigns/${campaignId}/review`);
      setReview(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load review");
    } finally {
      setBusy(false);
    }
  }, [campaignId]);

  useEffect(() => {
    if (step === 4 && campaignId) loadReview();
  }, [step, campaignId, loadReview]);

  const doLaunch = async () => {
    if (!campaignId || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<LaunchResult>(`/api/retargeting/campaigns/${campaignId}/launch`, {
        method: "POST",
        body: { confirmed: true },
      });
      setLaunchResult(res);
      setStep(5);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Launch failed");
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = () => {
    if (!launchResult?.paidAd) return;
    const blob = new Blob([launchResult.paidAd.audienceCsv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `retargeting-audience-${campaignId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const nextDisabled =
    (step === 0 && !name.trim()) ||
    (step === 1 && !segmentId) ||
    (step === 2 && type !== "paid_ad" && type !== "crm_sequence" && !body.trim());

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={fromId ? "Review & launch" : "New retargeting campaign"}
        description="Six steps. Nothing sends until the final explicit confirmation."
        actions={
          <Link href="/app/retargeting">
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1.5" /> Back</Button>
          </Link>
        }
      />

      {/* stepper */}
      <div className="flex items-center gap-1 overflow-x-auto">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => i < step && setStep(i)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                i === step
                  ? "bg-[var(--fp-accent)] text-white"
                  : i < step
                    ? "bg-[var(--fp-card)] text-[var(--fp-text)]"
                    : "text-[var(--fp-text-2)]"
              }`}
            >
              {i < step && <Check className="h-3 w-3" />}
              {s}
            </button>
            {i < STEPS.length - 1 && <span className="text-[var(--fp-text-2)]">→</span>}
          </div>
        ))}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-[#FB7185]/40 bg-[#FB7185]/10 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-[#FB7185]" />
          <span>{error}</span>
        </div>
      )}

      {/* STEP 0 — campaign */}
      {step === 0 && (
        <Card>
          <CardHeader><CardTitle>Campaign basics</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Input label="Campaign name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Win back quiet Instagram followers" />
            <Select label="Campaign type" value={type} onChange={(e) => setType(e.target.value)} options={TYPE_OPTIONS} />
            <Textarea label="Objective" value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="e.g. Re-engage contacts silent for 30+ days with a 10% win-back offer" rows={3} />
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="mt-1" />
              <span>
                <span className="font-medium">Dry run (recommended for the first launch)</span>
                <br />
                <span className="text-[var(--fp-text-2)]">Rehearse the full flow — eligibility, scheduling, reporting — without touching any adapter.</span>
              </span>
            </label>
          </CardContent>
        </Card>
      )}

      {/* STEP 1 — audience */}
      {step === 1 && (
        <Card>
          <CardHeader><CardTitle>Audience</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Select
              label="Audience segment"
              value={segmentId}
              onChange={(e) => setSegmentId(e.target.value)}
              placeholder="Choose a segment…"
              options={segments.map((s) => ({ value: s.id, label: s.name }))}
            />
            <p className="text-sm text-[var(--fp-text-2)]">
              No segment yet?{" "}
              <Link href="/app/retargeting/segments" className="underline">Build one in the audience manager</Link>{" "}
              — conditions like “tag contains vip AND last inbound older than 30 days”.
            </p>
          </CardContent>
        </Card>
      )}

      {/* STEP 2 — message */}
      {step === 2 && (
        <Card>
          <CardHeader><CardTitle>Channel & message</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {channels.length > 0 ? (
              <Select label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)} options={channels.map((c) => ({ value: c, label: c }))} />
            ) : (
              <p className="text-sm text-[var(--fp-text-2)]">
                {type === "paid_ad"
                  ? "Paid-ad campaigns export an audience CSV — no message channel applies."
                  : "CRM sequences are worked manually — no send channel applies."}
              </p>
            )}
            {type === "dm_reengagement" && channel === "whatsapp" && (
              <Select
                label="WhatsApp message type"
                value={messageType}
                onChange={(e) => setMessageType(e.target.value)}
                options={[
                  { value: "freeform", label: "Freeform (only inside the 24h window)" },
                  { value: "template", label: "Approved template (works outside the 24h window)" },
                ]}
              />
            )}
            {type !== "paid_ad" && type !== "crm_sequence" && (
              <Textarea
                label="Message body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder="Hi {{firstName}} — we haven't heard from you in a while…"
              />
            )}
            {type === "crm_sequence" && (
              <p className="text-sm text-[var(--fp-text-2)]">Each recipient becomes a CRM task (call / manual message). Define the steps after launch from the campaign detail page.</p>
            )}
            {type === "email" && (
              <Badge tone="amber">SIMULATED — no email delivery provider is connected; sends are logged, not delivered.</Badge>
            )}
            <p className="text-xs text-[var(--fp-text-2)]">Variables: {"{{name}}, {{firstName}}, {{channel}}"}. Per-recipient eligibility (24h window, suppression, frequency cap) is checked before anything sends.</p>
          </CardContent>
        </Card>
      )}

      {/* STEP 3 — schedule */}
      {step === 3 && (
        <Card>
          <CardHeader><CardTitle>Schedule & budget</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Starts at (optional)" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
              <Input label="Ends at (optional)" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
            <Input label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/Helsinki" />
            <Input label="Frequency cap — max sends per contact per day" type="number" min={1} max={10} value={capPerDay} onChange={(e) => setCapPerDay(e.target.value)} />
            {type === "paid_ad" && (
              <div className="grid grid-cols-2 gap-4">
                <Input label="Planned budget (optional)" type="number" min={0} value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} placeholder="500" />
                <Input label="Currency" value={budgetCurrency} onChange={(e) => setBudgetCurrency(e.target.value)} placeholder="USD" />
              </div>
            )}
            <p className="text-xs text-[var(--fp-text-2)]">Dates are interpreted in the timezone above. Sends are processed in rate-capped batches.</p>
          </CardContent>
        </Card>
      )}

      {/* STEP 4 — review */}
      {step === 4 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ListChecks className="h-5 w-5" /> Pre-flight review</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {busy && !review ? (
              <div className="flex justify-center py-8"><Spinner /></div>
            ) : review ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="green">{review.eligible} eligible</Badge>
                  <Badge tone={review.skipped > 0 ? "amber" : "gray"}>{review.skipped} excluded</Badge>
                  {review.dryRun && <Badge tone="amber">DRY RUN</Badge>}
                </div>
                <p className="text-sm text-[var(--fp-text-2)]">Audience: {review.segmentSummary}</p>
                {review.availabilityWarnings.map((w) => (
                  <div key={w} className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-500" />
                    <span>{w}</span>
                  </div>
                ))}
                {review.skippedSample.length > 0 && (
                  <div>
                    <p className="text-sm font-medium mb-2">Why recipients are excluded</p>
                    <div className="space-y-2 max-h-56 overflow-y-auto">
                      {review.skippedSample.map((s) => (
                        <div key={s.contactId} className="rounded-lg bg-[var(--fp-bg-2)] border border-[var(--fp-border)] px-3 py-2 text-xs">
                          <span className="font-medium">{s.name}</span>
                          <ul className="list-disc ml-4 mt-1 text-[var(--fp-text-2)]">
                            {s.reasons.map((r, i) => <li key={i}>{r}</li>)}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <p className="text-sm font-medium mb-2">Per-recipient verdicts ({review.verdicts.length})</p>
                  <div className="max-h-64 overflow-y-auto rounded-xl border border-[var(--fp-border)]">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-[var(--fp-bg-2)]">
                        <tr className="text-left text-[var(--fp-text-2)]">
                          <th className="px-3 py-2">Contact</th>
                          <th className="px-3 py-2">Channel</th>
                          <th className="px-3 py-2">Verdict</th>
                        </tr>
                      </thead>
                      <tbody>
                        {review.verdicts.slice(0, 100).map((v) => (
                          <tr key={v.contactId} className="border-t border-[var(--fp-border)]">
                            <td className="px-3 py-2">{v.name}</td>
                            <td className="px-3 py-2">{v.channel ?? "—"}</td>
                            <td className="px-3 py-2">
                              <Badge tone={v.eligible ? "green" : "red"}>
                                {v.eligible ? (v.simulated ? "eligible (simulated)" : "eligible") : "excluded"}
                              </Badge>
                              {!v.eligible && v.ineligibleReasons[0] && (
                                <span className="ml-2 text-[var(--fp-text-2)]">{v.ineligibleReasons[0]}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-[var(--fp-text-2)]">No review data.</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* STEP 5 — confirm / launched */}
      {step === 5 && (
        <Card>
          <CardHeader><CardTitle>Confirm launch</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {!launchResult ? (
              <>
                <div className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-4 text-sm space-y-2">
                  <p className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4" /> Explicit confirmation required</p>
                  <p className="text-[var(--fp-text-2)]">
                    Launching starts real sends through the messaging pipeline
                    {review?.dryRun ? " (dry run — nothing will actually send)" : ""}.
                    {type === "paid_ad" && " For paid ads, launch produces the setup checklist and audience CSV — no ads are created."}
                    {type === "email" && " Email sends are simulated — they are logged, not delivered."}
                  </p>
                </div>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
                  <span>I have reviewed the audience, the message, and the exclusions above, and I confirm this launch.</span>
                </label>
                <Button disabled={!confirmed || busy} onClick={doLaunch}>
                  <Megaphone className="h-4 w-4 mr-2" /> {busy ? "Launching…" : "Launch campaign"}
                </Button>
              </>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-green-500 font-medium">
                  <Check className="h-5 w-5" />
                  {launchResult.paidAd ? "Audience export ready" : `Campaign ${launchResult.status}`}
                  {launchResult.dryRun && <Badge tone="amber">DRY RUN</Badge>}
                </div>
                <p className="text-sm text-[var(--fp-text-2)]">
                  {launchResult.eligible} eligible · {launchResult.skipped} excluded.
                </p>
                {launchResult.paidAd && (
                  <div className="space-y-3">
                    <div className="rounded-xl border border-[var(--fp-border)] p-4">
                      <p className="font-medium text-sm mb-2">Meta setup checklist</p>
                      <ul className="space-y-2 text-sm">
                        {launchResult.paidAd.checklist.map((c) => (
                          <li key={c.id} className="flex items-start gap-2">
                            <Badge tone={c.required ? "red" : "gray"}>{c.required ? "required" : "optional"}</Badge>
                            <span><span className="font-medium">{c.title}.</span> <span className="text-[var(--fp-text-2)]">{c.description}</span></span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <p className="text-xs text-[var(--fp-text-2)]">{launchResult.paidAd.note}</p>
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" onClick={downloadCsv}>
                        <Download className="h-4 w-4 mr-2" />
                        Download audience CSV ({launchResult.paidAd.exported} contacts)
                      </Button>
                      {launchResult.paidAd.excluded > 0 && (
                        <span className="text-xs text-[var(--fp-text-2)]">{launchResult.paidAd.excluded} excluded (no consent/identifier)</span>
                      )}
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <Link href={`/app/retargeting/${campaignId}`}>
                    <Button variant="secondary">Open campaign detail</Button>
                  </Link>
                  <Link href="/app/retargeting">
                    <Button variant="ghost">Back to list</Button>
                  </Link>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* nav */}
      {step < 4 && (
        <div className="flex justify-between">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back
          </Button>
          {step < 3 ? (
            <Button disabled={nextDisabled} onClick={() => setStep((s) => s + 1)}>
              Continue <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          ) : (
            <Button disabled={nextDisabled || busy} onClick={createCampaign}>
              {busy ? "Creating…" : campaignId ? "Save & review" : "Create & review"} <ArrowRight className="h-4 w-4 ml-1.5" />
            </Button>
          )}
        </div>
      )}
      {step === 4 && (
        <div className="flex justify-between">
          <Button variant="ghost" onClick={() => setStep(3)}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to schedule
          </Button>
          <Button
            disabled={!review || (review.eligible === 0 && !review.dryRun && type !== "paid_ad")}
            onClick={() => setStep(5)}
          >
            Continue to confirmation <ArrowRight className="h-4 w-4 ml-1.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

export default function NewRetargetingPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
      <NewRetargetingWizard />
    </Suspense>
  );
}
