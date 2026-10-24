"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import {
  Megaphone, Plus, Pencil, Trash2, CalendarClock, AlertTriangle,
  Play, Pause, XCircle, Users, RefreshCw, Zap, BarChart3, ListChecks,
} from "lucide-react";
import type { BadgeTone } from "@/components/ui/Badge";

/* ------------------------------------------------------------------ */

interface Campaign {
  id: string;
  name: string;
  objective: string;
  channel: string;
  status: string;
  messageType: string;
  ratePerSecond: number;
  pauseOnReply: boolean;
  templateId?: string | null;
  segmentId?: string | null;
  audience: unknown;
  message: unknown;
  scheduledAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

interface Segment { id: string; name: string; filters: Record<string, unknown> }
interface Template { id: string; name: string; channel: string }

interface RecipientRow {
  contactId: string;
  name: string;
  channel: string;
  status: string;
  skipReason?: string | null;
  error?: string | null;
  sentAt?: string | null;
  repliedAt?: string | null;
  providerMessageId?: string | null;
  mocked?: boolean | null;
}

interface Report {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  replied: number;
  pending: number;
  total: number;
  perRecipient: RecipientRow[];
}

interface BuildResult {
  campaignId: string;
  total: number;
  pending: number;
  skipped: number;
  created: number;
  skippedSample: { contactId: string; name: string; reasons: string[] }[];
}

const CHANNELS = ["whatsapp", "instagram", "facebook"];
const MESSAGE_TYPES = ["freeform", "template", "private_reply"];

function parseJson(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  try {
    let p: unknown = JSON.parse(String(raw));
    if (typeof p === "string") p = JSON.parse(p); // legacy double-encode
    return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function messageText(c: Campaign): string {
  const m = parseJson(c.message);
  return typeof m.text === "string" ? m.text : "";
}

function audienceLabel(c: Campaign): string {
  if (c.segmentId) return "Saved segment";
  const a = parseJson(c.audience);
  if (a.type === "tag" && typeof a.tag === "string" && a.tag) return `Tag: ${a.tag}`;
  return "All contacts";
}

function statusTone(s: string): BadgeTone {
  switch (s) {
    case "DRAFT": return "gray";
    case "SCHEDULED": return "cyan";
    case "RUNNING": return "amber";
    case "PAUSED": return "violet";
    case "COMPLETED": return "green";
    case "CANCELLED": return "red";
    case "FAILED": return "red";
    case "SENDING": return "amber";
    case "SENT": return "green";
    default: return "gray";
  }
}

function recipientTone(s: string): BadgeTone {
  switch (s) {
    case "PENDING": return "gray";
    case "SENT": return "green";
    case "FAILED": return "red";
    case "SKIPPED": return "amber";
    case "REPLIED": return "cyan";
    default: return "gray";
  }
}

function fmtDate(v?: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

const STEPS = ["Name & objective", "Channel & audience", "Message & sending", "Review & schedule"];

/* ------------------------------------------------------------------ */

export default function CampaignsPage() {
  const [items, setItems] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [wiz, setWiz] = useState({
    name: "",
    objective: "",
    channel: "whatsapp",
    audienceType: "all" as "all" | "tag",
    audienceTag: "",
    segmentId: "",
    messageType: "freeform",
    templateId: "",
    message: "",
    ratePerSecond: 1,
    pauseOnReply: true,
    scheduledAt: "",
  });
  const [wizError, setWizError] = useState<string | null>(null);
  const [wizSaving, setWizSaving] = useState(false);

  const [editTarget, setEditTarget] = useState<Campaign | null>(null);
  const [editForm, setEditForm] = useState({ name: "", objective: "", message: "", scheduledAt: "", ratePerSecond: 1, pauseOnReply: true });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Campaign | null>(null);
  const [deleting, setDeleting] = useState(false);

  /* ------------------------------ detail ------------------------------ */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailCampaign, setDetailCampaign] = useState<Campaign | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [buildSegmentId, setBuildSegmentId] = useState("");
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);
  const [detailTab, setDetailTab] = useState<"recipients" | "report">("recipients");

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ campaigns: Campaign[] }>("/api/campaigns");
      setItems(data.campaigns ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCampaigns();
  }, [fetchCampaigns]);

  const fetchDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const data = await api<{ campaign: Campaign; report: Report }>(`/api/campaigns/${id}/report`);
      setDetailCampaign(data.campaign);
      setReport(data.report);
    } catch (e) {
      setDetailError(e instanceof ApiError ? e.message : "Failed to load campaign");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadPickers = useCallback(async () => {
    try {
      const [segs, tmps] = await Promise.all([
        api<{ items: Segment[] }>("/api/contact-segments").catch(() => ({ items: [] })),
        api<{ items: Template[] }>("/api/message-templates").catch(() => ({ items: [] })),
      ]);
      setSegments(segs.items ?? []);
      setTemplates(tmps.items ?? []);
    } catch {
      // Pickers are optional; the page still works without them.
    }
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setDetailId(id);
    setDetailCampaign(null);
    setReport(null);
    setBuildResult(null);
    setActionError(null);
    setDetailTab("recipients");
    await loadPickers();
    await fetchDetail(id);
  }, [fetchDetail, loadPickers]);

  // Live progress while the detail view is open: re-fetch the report every
  // 5s so a running wave (driven by the scheduler) is visible.
  useEffect(() => {
    if (!detailId) return;
    const t = setInterval(() => {
      if (detailCampaign?.status === "RUNNING") void fetchDetail(detailId);
    }, 5000);
    return () => clearInterval(t);
  }, [detailId, detailCampaign?.status, fetchDetail]);

  const runAction = useCallback(async (
    label: string,
    path: string,
    body?: unknown,
    method = "POST",
  ) => {
    if (!detailId) return;
    setActionLoading(label);
    setActionError(null);
    try {
      await api(`/api/campaigns/${detailId}/${path}`, { method, body });
      setBuildResult(null);
      await fetchDetail(detailId);
      await fetchCampaigns();
    } catch (e) {
      setActionError(e instanceof ApiError ? `${label}: ${e.message}` : `${label} failed`);
    } finally {
      setActionLoading(null);
    }
  }, [detailId, fetchDetail, fetchCampaigns]);

  const buildList = async () => {
    if (!detailId) return;
    setActionLoading("build");
    setActionError(null);
    try {
      const data = await api<{ build: BuildResult }>(`/api/campaigns/${detailId}/recipients/build`, {
        method: "POST",
        body: { ...(buildSegmentId ? { segmentId: buildSegmentId } : {}) },
      });
      setBuildResult(data.build);
      await fetchDetail(detailId);
      await fetchCampaigns();
    } catch (e) {
      setActionError(e instanceof ApiError ? `Build list: ${e.message}` : "Build list failed");
    } finally {
      setActionLoading(null);
    }
  };

  /* ------------------------------- wizard ------------------------------ */
  const openWizard = () => {
    setWiz({ name: "", objective: "", channel: "whatsapp", audienceType: "all", audienceTag: "", segmentId: "", messageType: "freeform", templateId: "", message: "", ratePerSecond: 1, pauseOnReply: true, scheduledAt: "" });
    setStep(0);
    setWizError(null);
    setWizardOpen(true);
    void loadPickers();
  };

  const wizValid = (): boolean => {
    if (step === 0) return wiz.name.trim().length >= 2;
    if (step === 1) return wiz.channel.length > 0 && (wiz.audienceType === "all" || wiz.audienceTag.trim().length > 0 || wiz.segmentId.length > 0);
    if (step === 2) return wiz.messageType === "template" ? wiz.templateId.length > 0 : wiz.message.trim().length > 0;
    return true;
  };

  const submitWizard = async () => {
    setWizError(null);
    setWizSaving(true);
    try {
      await api("/api/campaigns", {
        method: "POST",
        body: {
          name: wiz.name.trim(),
          objective: wiz.objective.trim(),
          channel: wiz.channel,
          // NOTE: audience/message are sent as objects (the API JSON-encodes them).
          audience: wiz.segmentId
            ? { type: "segment", segmentId: wiz.segmentId }
            : wiz.audienceType === "tag"
              ? { type: "tag", tag: wiz.audienceTag.trim() }
              : { type: "all" },
          message: { text: wiz.message.trim() },
          ...(wiz.segmentId ? { segmentId: wiz.segmentId } : {}),
          ...(wiz.templateId ? { templateId: wiz.templateId } : {}),
          messageType: wiz.messageType,
          ratePerSecond: Number(wiz.ratePerSecond) || 1,
          pauseOnReply: wiz.pauseOnReply,
          ...(wiz.scheduledAt ? { scheduledAt: new Date(wiz.scheduledAt).toISOString() } : {}),
        },
      });
      setWizardOpen(false);
      void fetchCampaigns();
    } catch (e) {
      setWizError(e instanceof ApiError ? e.message : "Failed to create campaign");
    } finally {
      setWizSaving(false);
    }
  };

  /* -------------------------------- edit ------------------------------- */
  const openEdit = (c: Campaign) => {
    setEditTarget(c);
    setEditError(null);
    setEditForm({
      name: c.name,
      objective: c.objective ?? "",
      message: messageText(c),
      scheduledAt: c.scheduledAt ? new Date(c.scheduledAt).toISOString().slice(0, 16) : "",
      ratePerSecond: c.ratePerSecond ?? 1,
      pauseOnReply: c.pauseOnReply ?? true,
    });
  };

  const submitEdit = async () => {
    if (!editTarget) return;
    setEditError(null);
    setEditSaving(true);
    try {
      await api(`/api/campaigns/${editTarget.id}`, {
        method: "PATCH",
        body: {
          name: editForm.name.trim(),
          objective: editForm.objective.trim(),
          message: { text: editForm.message.trim() },
          ratePerSecond: Number(editForm.ratePerSecond) || 1,
          pauseOnReply: editForm.pauseOnReply,
          scheduledAt: editForm.scheduledAt ? new Date(editForm.scheduledAt).toISOString() : null,
        },
      });
      setEditTarget(null);
      void fetchCampaigns();
    } catch (e) {
      setEditError(e instanceof ApiError ? e.message : "Failed to update campaign");
    } finally {
      setEditSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/campaigns/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      void fetchCampaigns();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to delete campaign");
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  /* ------------------------------ detail bits ---------------------------- */
  const canStart = detailCampaign && (detailCampaign.status === "DRAFT" || detailCampaign.status === "PAUSED");
  const isRunning = detailCampaign?.status === "RUNNING";
  const isActive = detailCampaign && !["COMPLETED", "CANCELLED", "FAILED"].includes(detailCampaign.status);

  const progressPct = report && report.total > 0
    ? Math.round(((report.sent + report.failed + report.skipped + report.replied) / report.total) * 100)
    : 0;

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="Broadcasts and drip sequences to your audiences — with eligibility checks, rate control, and honest delivery reports."
        actions={
          <Button size="sm" onClick={openWizard}>
            <Plus className="h-4 w-4" /> New campaign
          </Button>
        }
      />

      <div className="mb-4 flex items-start gap-3 rounded-xl border border-[#FBBF24]/30 bg-[#FBBF24]/10 px-4 py-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#FBBF24]" />
        <p className="text-sm text-[var(--fp-text-2)]">
          Sending respects Meta messaging windows: contacts outside the 24-hour window (or without an
          approved template / comment to reply to) are skipped with a reason — never sent. Rows labeled
          <span className="font-semibold text-[var(--fp-text)]"> mocked</span> went through the demo adapter, never a real provider.
        </p>
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-[#FB7185]/30 bg-[#FB7185]/10 px-4 py-2 text-sm text-[#FB7185]">
          {error}
        </p>
      )}

      {loading ? (
        <Spinner label="Loading campaigns…" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          description="Create your first campaign — it will be saved as a draft until you build a recipient list and start it."
          action={<Button size="sm" onClick={openWizard}><Plus className="h-4 w-4" /> New campaign</Button>}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((c) => (
            <Card key={c.id}>
              <CardHeader>
                <CardTitle className="truncate">{c.name}</CardTitle>
                <Badge tone={statusTone(c.status)}>{c.status}</Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                {c.objective && <p className="text-sm text-[var(--fp-text-2)]">{c.objective}</p>}
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone="cyan">{c.channel}</Badge>
                  <Badge tone="gray">{c.messageType}</Badge>
                  <Badge tone="gray">{audienceLabel(c)}</Badge>
                </div>
                <p className="line-clamp-2 text-sm text-[var(--fp-text-2)]">{messageText(c)}</p>
                <p className="flex items-center gap-1.5 text-xs text-[var(--fp-text-2)]">
                  <CalendarClock className="h-3.5 w-3.5" />
                  {c.status === "SCHEDULED" && c.scheduledAt ? `Scheduled ${fmtDate(c.scheduledAt)}` : `Status: ${c.status}`}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="secondary" onClick={() => void openDetail(c.id)}>
                    <ListChecks className="h-3.5 w-3.5" /> Manage
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleteTarget(c)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ------------------------------- Wizard ------------------------------- */}
      <Modal open={wizardOpen} onClose={() => setWizardOpen(false)} title="New campaign" maxWidth="max-w-2xl">
        <ol className="mb-5 flex gap-1">
          {STEPS.map((s, i) => (
            <li key={s} className="flex-1">
              <div className={`h-1.5 rounded-full ${i <= step ? "bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]" : "bg-[var(--fp-bg-2)]"}`} />
              <p className={`mt-1 hidden text-[11px] sm:block ${i === step ? "text-[var(--fp-text)] font-semibold" : "text-[var(--fp-text-2)]"}`}>{s}</p>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="space-y-3">
            <Input label="Campaign name *" value={wiz.name} onChange={(e) => setWiz({ ...wiz, name: e.target.value })} placeholder="October promo" />
            <Textarea label="Objective" value={wiz.objective} onChange={(e) => setWiz({ ...wiz, objective: e.target.value })} rows={3} placeholder="Win back lapsed customers with a 15% discount…" />
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <Select label="Channel" value={wiz.channel} onChange={(e) => setWiz({ ...wiz, channel: e.target.value })} options={CHANNELS.map((c) => ({ value: c, label: c }))} />
            <div>
              <p className="mb-2 text-sm font-medium text-[var(--fp-text)]">Audience</p>
              <div className="flex gap-2">
                {(["all", "tag"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setWiz({ ...wiz, audienceType: t, segmentId: "" })}
                    aria-pressed={wiz.audienceType === t && !wiz.segmentId}
                    className={`rounded-xl border px-4 py-2 text-sm font-medium ${
                      wiz.audienceType === t && !wiz.segmentId
                        ? "border-[#8B5CF6] bg-[#8B5CF6]/15 text-[#A78BFA]"
                        : "border-[var(--fp-border)] text-[var(--fp-text-2)]"
                    }`}
                  >
                    {t === "all" ? "All contacts" : "By tag"}
                  </button>
                ))}
              </div>
              {wiz.audienceType === "tag" && (
                <div className="mt-3">
                  <Input label="Tag" value={wiz.audienceTag} onChange={(e) => setWiz({ ...wiz, audienceTag: e.target.value })} placeholder="vip" />
                </div>
              )}
              <div className="mt-3">
                <Select
                  label="Or pick a saved segment"
                  value={wiz.segmentId}
                  onChange={(e) => setWiz({ ...wiz, segmentId: e.target.value })}
                  options={[
                    { value: "", label: "— none —" },
                    ...segments.map((s) => ({ value: s.id, label: s.name })),
                  ]}
                />
              </div>
              <p className="mt-2 text-xs text-[var(--fp-text-2)]">A saved segment overrides the all/tag choice when building the recipient list.</p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <Select label="Message type" value={wiz.messageType} onChange={(e) => setWiz({ ...wiz, messageType: e.target.value })} options={MESSAGE_TYPES.map((m) => ({ value: m, label: m }))} />
            {wiz.messageType === "template" ? (
              <Select
                label="Approved template *"
                value={wiz.templateId}
                onChange={(e) => setWiz({ ...wiz, templateId: e.target.value })}
                options={[
                  { value: "", label: "— select a template —" },
                  ...templates.filter((t) => t.channel === wiz.channel).map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
            ) : (
              <Textarea
                label="Message *"
                value={wiz.message}
                onChange={(e) => setWiz({ ...wiz, message: e.target.value })}
                rows={6}
                placeholder={wiz.messageType === "private_reply" ? "Thanks for your comment, {{name}}! …" : "Hi {{name}}, we've got 15% off for you this week…"}
                hint="Use {{name}} to personalize with the contact's name."
              />
            )}
            <div className="grid grid-cols-2 gap-3">
              <Input label="Rate (messages/sec)" type="number" min={0.1} max={50} step={0.1} value={String(wiz.ratePerSecond)} onChange={(e) => setWiz({ ...wiz, ratePerSecond: Number(e.target.value) })} />
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-[var(--fp-text)]">
                <input type="checkbox" checked={wiz.pauseOnReply} onChange={(e) => setWiz({ ...wiz, pauseOnReply: e.target.checked })} className="h-4 w-4 accent-[#8B5CF6]" />
                Pause wave when a recipient replies
              </label>
            </div>
            {wiz.messageType === "private_reply" && (
              <p className="text-xs text-[var(--fp-text-2)]">Private replies go to each contact&apos;s latest comment (one per comment, within 7 days). Contacts with no comment are skipped.</p>
            )}
            {wiz.messageType !== "template" && wiz.message && (
              <div className="rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">Preview</p>
                <p className="whitespace-pre-wrap text-sm text-[var(--fp-text)]">
                  {wiz.message.replace(/\{\{name\}\}/g, "Jane").replace(/\{\{firstName\}\}/g, "Jane")}
                </p>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <div className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-4 text-sm">
              <p className="font-semibold text-[var(--fp-text)]">{wiz.name}</p>
              <p className="text-[var(--fp-text-2)]">{wiz.objective || "No objective"}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone="cyan">{wiz.channel}</Badge>
                <Badge tone="gray">{wiz.messageType}</Badge>
                <Badge tone="gray">{wiz.segmentId ? "Saved segment" : wiz.audienceType === "tag" ? `Tag: ${wiz.audienceTag}` : "All contacts"}</Badge>
                <Badge tone="gray">{wiz.ratePerSecond}/sec</Badge>
              </div>
              {wiz.messageType !== "template" && <p className="mt-2 whitespace-pre-wrap text-[var(--fp-text-2)]">{wiz.message}</p>}
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[var(--fp-text)]">Schedule (optional)</label>
              <Input type="datetime-local" value={wiz.scheduledAt} onChange={(e) => setWiz({ ...wiz, scheduledAt: e.target.value })} />
              <p className="mt-1 text-xs text-[var(--fp-text-2)]">Leave empty to keep the campaign as a draft. A scheduled campaign flips to RUNNING at its time via the process-due worker.</p>
            </div>
          </div>
        )}

        {wizError && <p className="mt-3 text-sm text-[#FB7185]">{wizError}</p>}

        <div className="mt-5 flex justify-between">
          <Button variant="ghost" onClick={() => (step === 0 ? setWizardOpen(false) : setStep(step - 1))}>
            {step === 0 ? "Cancel" : "Back"}
          </Button>
          {step < 3 ? (
            <Button onClick={() => setStep(step + 1)} disabled={!wizValid()}>Continue</Button>
          ) : (
            <Button onClick={() => void submitWizard()} loading={wizSaving}>Create campaign</Button>
          )}
        </div>
      </Modal>

      {/* ------------------------------- Detail ------------------------------- */}
      <Modal open={!!detailId} onClose={() => { setDetailId(null); setDetailCampaign(null); }} title={detailCampaign ? detailCampaign.name : "Campaign"} maxWidth="max-w-4xl">
        {detailLoading || !detailCampaign ? (
          <Spinner label="Loading campaign…" />
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(detailCampaign.status)}>{detailCampaign.status}</Badge>
              <Badge tone="cyan">{detailCampaign.channel}</Badge>
              <Badge tone="gray">{detailCampaign.messageType}</Badge>
              <Badge tone="gray">{detailCampaign.ratePerSecond}/sec</Badge>
              {detailCampaign.pauseOnReply && <Badge tone="blue">pause-on-reply</Badge>}
              <span className="ml-auto text-xs text-[var(--fp-text-2)]">Started {fmtDate(detailCampaign.startedAt)}{detailCampaign.completedAt ? ` · Completed ${fmtDate(detailCampaign.completedAt)}` : ""}</span>
            </div>

            {detailError && <p className="text-sm text-[#FB7185]">{detailError}</p>}
            {actionError && <p className="text-sm text-[#FB7185]">{actionError}</p>}

            {/* Progress */}
            {report && (
              <div className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-4">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="font-medium text-[var(--fp-text)]">Progress</span>
                  <span className="text-[var(--fp-text-2)]">{progressPct}% · {report.total} recipients</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--fp-border)]">
                  <div className="h-full rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]" style={{ width: `${progressPct}%` }} />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
                  {[
                    ["Pending", report.pending, "gray"],
                    ["Sent", report.sent, "green"],
                    ["Failed", report.failed, "red"],
                    ["Skipped", report.skipped, "amber"],
                    ["Replied", report.replied, "cyan"],
                    ["Attempted", report.attempted, "gray"],
                  ].map(([label, value, tone]) => (
                    <div key={label as string} className="rounded-lg border border-[var(--fp-border)] px-2 py-1.5">
                      <p className="text-lg font-semibold text-[var(--fp-text)]">{value}</p>
                      <p className="text-[11px] text-[var(--fp-text-2)]">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              {canStart && (
                <Button size="sm" onClick={() => void runAction("Start", "start")} loading={actionLoading === "Start"}>
                  <Play className="h-3.5 w-3.5" /> {detailCampaign.status === "PAUSED" ? "Resume" : "Start"}
                </Button>
              )}
              {isRunning && (
                <>
                  <Button size="sm" variant="secondary" onClick={() => void runAction("Pause", "pause")} loading={actionLoading === "Pause"}>
                    <Pause className="h-3.5 w-3.5" /> Pause
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void runAction("Process batch", "process", {})} loading={actionLoading === "Process batch"}>
                    <Zap className="h-3.5 w-3.5" /> Process batch
                  </Button>
                </>
              )}
              {isActive && (report?.failed ?? 0) > 0 && (
                <Button size="sm" variant="secondary" onClick={() => void runAction("Retry failed", "retry-failed", {})} loading={actionLoading === "Retry failed"}>
                  <RefreshCw className="h-3.5 w-3.5" /> Retry failed ({report?.failed})
                </Button>
              )}
              {detailCampaign.status === "DRAFT" && (
                <Button size="sm" variant="secondary" onClick={() => setShowSchedule((v) => !v)}>
                  <CalendarClock className="h-3.5 w-3.5" /> Schedule
                </Button>
              )}
              {isActive && detailCampaign.status !== "RUNNING" && (
                <Button size="sm" variant="danger" onClick={() => setConfirmCancel(true)}>
                  <XCircle className="h-3.5 w-3.5" /> Cancel campaign
                </Button>
              )}
            </div>

            {showSchedule && detailCampaign.status === "DRAFT" && (
              <div className="flex items-end gap-2 rounded-xl border border-[var(--fp-border)] p-3">
                <Input label="Schedule for" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
                <Button size="sm" loading={actionLoading === "Schedule"} onClick={() => { setShowSchedule(false); void runAction("Schedule", "schedule", { ...(scheduleAt ? { scheduledAt: new Date(scheduleAt).toISOString() } : {}) }); }}>
                  Schedule
                </Button>
              </div>
            )}

            {/* Recipient builder */}
            {["DRAFT", "PAUSED", "SCHEDULED"].includes(detailCampaign.status) && (
              <div className="rounded-xl border border-[var(--fp-border)] p-4">
                <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--fp-text)]">
                  <Users className="h-4 w-4" /> Recipient list
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[220px] flex-1">
                    <Select
                      label="Segment (optional)"
                      value={buildSegmentId}
                      onChange={(e) => setBuildSegmentId(e.target.value)}
                      options={[
                        { value: "", label: "Use campaign audience" },
                        ...segments.map((s) => ({ value: s.id, label: s.name })),
                      ]}
                    />
                  </div>
                  <Button size="sm" onClick={() => void buildList()} loading={actionLoading === "build"}>
                    <Users className="h-3.5 w-3.5" /> Build list
                  </Button>
                </div>
                <p className="mt-2 text-xs text-[var(--fp-text-2)]">
                  Contacts are pre-checked against suppression lists and Meta messaging windows. Ineligible contacts
                  become SKIPPED with a reason — they are never sent to. Rebuilding is idempotent: existing rows are kept.
                </p>
                {buildResult && (
                  <div className="mt-3 rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3">
                    <p className="text-sm text-[var(--fp-text)]">
                      <span className="font-semibold">{buildResult.pending}</span> eligible ·{" "}
                      <span className="font-semibold">{buildResult.skipped}</span> skipped ·{" "}
                      <span className="text-[var(--fp-text-2)]">{buildResult.created} new rows · {buildResult.total} total</span>
                    </p>
                    {buildResult.skippedSample.length > 0 && (
                      <table className="mt-2 w-full text-left text-xs">
                        <thead>
                          <tr className="text-[var(--fp-text-2)]">
                            <th className="py-1 pr-2 font-medium">Contact</th>
                            <th className="py-1 font-medium">Skip reasons</th>
                          </tr>
                        </thead>
                        <tbody>
                          {buildResult.skippedSample.map((s) => (
                            <tr key={s.contactId} className="border-t border-[var(--fp-border)] align-top">
                              <td className="py-1 pr-2 text-[var(--fp-text)]">{s.name}</td>
                              <td className="py-1 text-[var(--fp-text-2)]">
                                <ul className="list-disc pl-4">
                                  {s.reasons.map((r, i) => <li key={i}>{r}</li>)}
                                </ul>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Tabs */}
            <div className="flex gap-2 border-b border-[var(--fp-border)]">
              {([["recipients", "Recipients"], ["report", "Report"]] as const).map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setDetailTab(tab)}
                  className={`pb-2 text-sm font-medium ${detailTab === tab ? "border-b-2 border-[#8B5CF6] text-[var(--fp-text)]" : "text-[var(--fp-text-2)]"}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {detailTab === "recipients" && report && (
              <div className="max-h-96 overflow-auto rounded-xl border border-[var(--fp-border)]">
                {report.perRecipient.length === 0 ? (
                  <p className="p-4 text-sm text-[var(--fp-text-2)]">No recipients yet — build the list above.</p>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-[var(--fp-bg-2)]">
                      <tr className="text-xs text-[var(--fp-text-2)]">
                        <th className="px-3 py-2 font-medium">Contact</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Reason / error</th>
                        <th className="px-3 py-2 font-medium">Sent</th>
                        <th className="px-3 py-2 font-medium">Mocked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.perRecipient.map((r) => (
                        <tr key={r.contactId} className="border-t border-[var(--fp-border)] align-top">
                          <td className="px-3 py-2 text-[var(--fp-text)]">{r.name}</td>
                          <td className="px-3 py-2"><Badge tone={recipientTone(r.status)}>{r.status}</Badge></td>
                          <td className="max-w-xs px-3 py-2 text-xs text-[var(--fp-text-2)]">
                            {r.status === "SKIPPED" ? r.skipReason : r.status === "FAILED" ? r.error : r.status === "REPLIED" ? `Replied ${fmtDate(r.repliedAt)}` : "—"}
                          </td>
                          <td className="px-3 py-2 text-xs text-[var(--fp-text-2)]">{r.sentAt ? fmtDate(r.sentAt) : "—"}</td>
                          <td className="px-3 py-2 text-xs text-[var(--fp-text-2)]">{r.status === "SENT" ? (r.mocked ? "yes (demo)" : "no") : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {detailTab === "report" && report && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-[var(--fp-text-2)]">
                  <BarChart3 className="h-4 w-4" />
                  Delivery report — “Replied” counts recipients whose inbound reply was actually received (never estimated).
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {[
                    ["Attempted", report.attempted],
                    ["Sent", report.sent],
                    ["Failed", report.failed],
                    ["Skipped", report.skipped],
                    ["Replied", report.replied],
                    ["Pending", report.pending],
                  ].map(([label, value]) => (
                    <div key={label as string} className="rounded-xl border border-[var(--fp-border)] p-3 text-center">
                      <p className="text-2xl font-semibold text-[var(--fp-text)]">{value}</p>
                      <p className="text-xs text-[var(--fp-text-2)]">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ------------------------------- Edit -------------------------------- */}
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit campaign">
        <div className="space-y-3">
          <Input label="Name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
          <Textarea label="Objective" value={editForm.objective} onChange={(e) => setEditForm({ ...editForm, objective: e.target.value })} rows={2} />
          <Textarea label="Message" value={editForm.message} onChange={(e) => setEditForm({ ...editForm, message: e.target.value })} rows={4} hint="Use {{name}} to personalize." />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Rate (messages/sec)" type="number" min={0.1} max={50} step={0.1} value={String(editForm.ratePerSecond)} onChange={(e) => setEditForm({ ...editForm, ratePerSecond: Number(e.target.value) })} />
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-[var(--fp-text)]">
              <input type="checkbox" checked={editForm.pauseOnReply} onChange={(e) => setEditForm({ ...editForm, pauseOnReply: e.target.checked })} className="h-4 w-4 accent-[#8B5CF6]" />
              Pause on reply
            </label>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--fp-text)]">Schedule</label>
            <Input type="datetime-local" value={editForm.scheduledAt} onChange={(e) => setEditForm({ ...editForm, scheduledAt: e.target.value })} />
          </div>
          {editError && <p className="text-sm text-[#FB7185]">{editError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={() => void submitEdit()} loading={editSaving}>Save changes</Button>
          </div>
        </div>
      </Modal>

      {/* ------------------------------- Delete ------------------------------- */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete campaign">
        <p className="text-sm text-[var(--fp-text-2)]">
          Delete <span className="font-semibold text-[var(--fp-text)]">“{deleteTarget?.name}”</span>? Recipient rows and delivery history are removed with it. This cannot be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirmDelete()} loading={deleting}>Delete</Button>
        </div>
      </Modal>

      {/* --------------------------- Cancel confirm --------------------------- */}
      <Modal open={confirmCancel} onClose={() => setConfirmCancel(false)} title="Cancel campaign">
        <p className="text-sm text-[var(--fp-text-2)]">
          Cancel <span className="font-semibold text-[var(--fp-text)]">“{detailCampaign?.name}”</span>? Remaining PENDING
          recipients will never be sent.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmCancel(false)}>Keep campaign</Button>
          <Button variant="danger" loading={actionLoading === "Cancel"} onClick={() => { setConfirmCancel(false); void runAction("Cancel", "cancel", {}); }}>
            Cancel campaign
          </Button>
        </div>
      </Modal>
    </div>
  );
}
