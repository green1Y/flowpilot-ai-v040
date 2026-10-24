"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import {
  Send,
  CalendarClock,
  CheckCircle2,
  XCircle,
  Ban,
  Eye,
  UserSearch,
  X,
} from "lucide-react";

/* ------------------------------------------------------------------ */

interface ContactOption {
  id: string;
  name: string;
  channel: string;
  leadStatus: string;
}

interface Template {
  id: string;
  name: string;
  channel: string;
  body: string;
}

interface Verdict {
  eligible: boolean;
  reasons: string[];
  ineligibleReasons: string[];
  windowEndsAt: string | null;
  suppressed: boolean;
  contactName: string;
}

interface FollowUpItem {
  id: string;
  contactId: string;
  contactName: string | null;
  channel: string;
  messageType: string;
  body: string;
  scheduledAt: string;
  status: string;
  sentAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

interface SuppressionRow {
  id: string;
  contactId: string;
  channel: string | null;
}

const CHANNELS = [
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook Messenger" },
  { value: "whatsapp", label: "WhatsApp" },
];

const MESSAGE_TYPES = [
  { value: "freeform", label: "Freeform (24h window)" },
  { value: "template", label: "Template (WhatsApp)" },
  { value: "private_reply", label: "Private reply (comment)" },
];

const VARIABLES = ["{{name}}", "{{firstName}}", "{{channel}}"];

/** Client-side mirror of renderTemplate() in src/lib/messaging/send.ts. */
function renderPreview(body: string, name: string, channel: string): string {
  const firstName = name.trim().split(/\s+/)[0] ?? "";
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, v: string) => {
    if (v === "name") return name;
    if (v === "firstName") return firstName;
    if (v === "channel") return channel;
    return m;
  });
}

function statusTone(s: string): "gray" | "cyan" | "amber" | "green" | "red" {
  switch (s) {
    case "SCHEDULED": return "cyan";
    case "SENT": return "green";
    case "FAILED": return "red";
    case "CANCELLED": return "gray";
    default: return "gray";
  }
}

/* ------------------------------------------------------------------ */

export default function FollowUpsPage() {
  /* --- composer state --- */
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<ContactOption[]>([]);
  const [contactSearching, setContactSearching] = useState(false);
  const [contact, setContact] = useState<ContactOption | null>(null);
  const [channel, setChannel] = useState("instagram");
  const [messageType, setMessageType] = useState("freeform");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [body, setBody] = useState("");
  const [commentId, setCommentId] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [verdictLoading, setVerdictLoading] = useState(false);
  const [verdictError, setVerdictError] = useState<string | null>(null);
  const [scheduledAt, setScheduledAt] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  /* --- suppression --- */
  const [suppressions, setSuppressions] = useState<SuppressionRow[]>([]);
  const allChannelSuppression = useMemo(
    () => suppressions.find((s) => s.channel === null) ?? null,
    [suppressions]
  );

  /* --- list state --- */
  const [items, setItems] = useState<FollowUpItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");

  /* --- contact search (debounced) --- */
  useEffect(() => {
    if (!contactQuery.trim()) {
      setContactResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setContactSearching(true);
      try {
        const data = await api<{ items: ContactOption[] }>("/api/contacts", {
          params: { search: contactQuery.trim(), pageSize: "8" },
        });
        setContactResults(data.items);
      } catch {
        setContactResults([]);
      } finally {
        setContactSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [contactQuery]);

  /* --- templates for channel --- */
  useEffect(() => {
    (async () => {
      try {
        const data = await api<{ items: Template[] }>("/api/message-templates", {
          params: { channel },
        });
        setTemplates(data.items);
      } catch {
        setTemplates([]);
      }
    })();
  }, [channel]);

  /* --- suppressions for selected contact --- */
  const fetchSuppressions = useCallback(async (contactId: string) => {
    try {
      const data = await api<{ items: SuppressionRow[] }>("/api/suppressions", {
        params: { contactId },
      });
      setSuppressions(data.items);
    } catch {
      setSuppressions([]);
    }
  }, []);

  const pickContact = (c: ContactOption) => {
    setContact(c);
    setContactQuery("");
    setContactResults([]);
    setVerdict(null);
    fetchSuppressions(c.id);
  };

  /* --- eligibility verdict (on every input change, debounced) --- */
  useEffect(() => {
    if (!contact) {
      setVerdict(null);
      return;
    }
    setVerdictLoading(true);
    setVerdictError(null);
    const t = setTimeout(async () => {
      try {
        const data = await api<Verdict>("/api/follow-ups/eligibility", {
          params: {
            contactId: contact.id,
            channel,
            messageType,
            ...(messageType === "private_reply" && commentId.trim()
              ? { commentId: commentId.trim() }
              : {}),
          },
        });
        setVerdict(data);
      } catch (e) {
        setVerdict(null);
        setVerdictError(
          e instanceof ApiError ? e.message : "Could not check eligibility"
        );
      } finally {
        setVerdictLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [contact, channel, messageType, commentId]);

  /* --- follow-ups list --- */
  const fetchList = useCallback(async () => {
    setListLoading(true);
    try {
      const data = await api<{ items: FollowUpItem[] }>("/api/follow-ups", {
        params: { ...(statusFilter ? { status: statusFilter } : {}), pageSize: "50" },
      });
      setItems(data.items);
    } catch {
      setItems([]);
    } finally {
      setListLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  /* --- template fill --- */
  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) setBody(t.body);
  };

  const insertVariable = (v: string) => {
    setBody((b) => (b ? `${b} ${v}` : v));
  };

  const preview = useMemo(
    () => (contact ? renderPreview(body, contact.name, channel) : renderPreview(body, "Name", channel)),
    [body, contact, channel]
  );

  const canSend =
    contact &&
    body.trim() &&
    (messageType !== "private_reply" || commentId.trim()) &&
    (messageType !== "template" || templateId);

  const doSend = async (schedule: boolean) => {
    if (!canSend || !contact) return;
    setSending(true);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = {
        contactId: contact.id,
        channel,
        messageType,
        ...(templateId ? { templateId } : {}),
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(messageType === "private_reply" ? { commentId: commentId.trim() } : {}),
      };
      if (schedule) {
        if (!scheduledAt) {
          setNotice({ tone: "red", text: "Pick a date/time to schedule." });
          setSending(false);
          return;
        }
        const when = new Date(scheduledAt);
        if (when.getTime() <= Date.now()) {
          setNotice({ tone: "red", text: "Scheduled time must be in the future." });
          setSending(false);
          return;
        }
        payload.scheduledAt = when.toISOString();
      }
      const data = await api<{
        followUp: FollowUpItem;
        send?: { mocked: boolean; status: string };
        duplicate: boolean;
      }>("/api/follow-ups", { method: "POST", body: payload });
      const mocked = data.send?.mocked;
      setNotice({
        tone: "green",
        text: schedule
          ? `Follow-up scheduled for ${new Date(data.followUp.scheduledAt).toLocaleString()}.`
          : data.send?.status === "SENT"
            ? mocked
              ? "Sent (demo — no real message left the server)."
              : "Sent."
            : `Send finished with status ${data.send?.status ?? "unknown"}.`,
      });
      setBody("");
      setCommentId("");
      setTemplateId("");
      fetchList();
    } catch (e) {
      setNotice({
        tone: "red",
        text: e instanceof ApiError ? `Send blocked: ${e.message}` : "Send failed.",
      });
    } finally {
      setSending(false);
    }
  };

  const cancelFollowUp = async (id: string) => {
    try {
      await api(`/api/follow-ups/${id}/cancel`, { method: "POST" });
      fetchList();
    } catch (e) {
      setNotice({
        tone: "red",
        text: e instanceof ApiError ? e.message : "Cancel failed.",
      });
    }
  };

  const toggleSuppression = async () => {
    if (!contact) return;
    try {
      if (allChannelSuppression) {
        await api(`/api/suppressions/${allChannelSuppression.id}`, { method: "DELETE" });
      } else {
        await api("/api/suppressions", {
          method: "POST",
          body: { contactId: contact.id, reason: "opt-out via follow-ups composer" },
        });
      }
      fetchSuppressions(contact.id);
    } catch (e) {
      setNotice({
        tone: "red",
        text: e instanceof ApiError ? e.message : "Suppression update failed.",
      });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Follow-ups"
        description="Send or schedule one-off messages with eligibility checks, templates, and suppression — never sends when the window has lapsed."
      />

      {notice && (
        <div
          role="alert"
          className={`rounded-xl border px-4 py-3 text-sm ${
            notice.tone === "green"
              ? "border-[#34D399]/40 bg-[#34D399]/10 text-[var(--fp-text)]"
              : "border-[#FB7185]/40 bg-[#FB7185]/10 text-[var(--fp-text)]"
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        {/* ---------------- composer ---------------- */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Composer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* contact picker */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[var(--fp-text)]">
                Contact
              </label>
              {contact ? (
                <div className="flex items-center justify-between rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-3.5 py-2.5">
                  <div>
                    <p className="text-sm font-medium text-[var(--fp-text)]">{contact.name}</p>
                    <p className="text-xs text-[var(--fp-text-2)]">
                      {contact.channel} · {contact.leadStatus}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={toggleSuppression}
                      title={allChannelSuppression ? "Remove suppression" : "Suppress all channels"}
                    >
                      <Ban className="h-4 w-4" aria-hidden />
                      {allChannelSuppression ? "Unsuppress" : "Suppress"}
                    </Button>
                    <button
                      onClick={() => {
                        setContact(null);
                        setVerdict(null);
                        setSuppressions([]);
                      }}
                      aria-label="Clear contact"
                      className="rounded-lg p-1.5 text-[var(--fp-text-2)] hover:bg-[var(--fp-card)] hover:text-[var(--fp-text)]"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="relative">
                  <div className="flex items-center gap-2">
                    <UserSearch className="h-4 w-4 shrink-0 text-[var(--fp-text-2)]" aria-hidden />
                    <Input
                      placeholder="Search contacts by name…"
                      value={contactQuery}
                      onChange={(e) => setContactQuery(e.target.value)}
                      aria-label="Search contacts"
                    />
                    {contactSearching && <Spinner />}
                  </div>
                  {contactResults.length > 0 && (
                    <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] shadow-lg">
                      {contactResults.map((c) => (
                        <li key={c.id}>
                          <button
                            onClick={() => pickContact(c)}
                            className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-sm hover:bg-[var(--fp-card)]"
                          >
                            <span className="font-medium text-[var(--fp-text)]">{c.name}</span>
                            <span className="text-xs text-[var(--fp-text-2)]">{c.channel}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {allChannelSuppression && contact && (
                <p className="mt-1.5 text-xs text-[#FB7185]">
                  This contact is suppressed (all channels) — sends will be blocked.
                </p>
              )}
            </div>

            {/* channel + message type */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label="Channel"
                options={
                  messageType === "template"
                    ? CHANNELS.filter((c) => c.value === "whatsapp")
                    : messageType === "private_reply"
                      ? CHANNELS.filter((c) => c.value !== "whatsapp")
                      : CHANNELS
                }
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              />
              <Select
                label="Message type"
                options={MESSAGE_TYPES}
                value={messageType}
                onChange={(e) => {
                  const mt = e.target.value;
                  setMessageType(mt);
                  if (mt === "template") setChannel("whatsapp");
                  if (mt === "private_reply" && channel === "whatsapp") setChannel("instagram");
                }}
              />
            </div>

            {/* template selector */}
            <Select
              label={messageType === "template" ? "Template (required)" : "Template (optional — fills the editor)"}
              placeholder="No template"
              options={templates.map((t) => ({ value: t.id, label: `${t.name} (${t.channel})` }))}
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
            />

            {/* comment id for private reply */}
            {messageType === "private_reply" && (
              <Input
                label="Comment ID (Meta comment id from the inbox/timeline)"
                placeholder="e.g. 1789…"
                value={commentId}
                onChange={(e) => setCommentId(e.target.value)}
              />
            )}

            {/* message editor */}
            <div>
              <Textarea
                label="Message"
                rows={4}
                placeholder="Hi {{firstName}}, just checking in…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {VARIABLES.map((v) => (
                  <button
                    key={v}
                    onClick={() => insertVariable(v)}
                    className="rounded-lg border border-[var(--fp-border)] bg-[var(--fp-card)] px-2 py-1 font-mono text-xs text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {/* eligibility verdict */}
            <div
              aria-live="polite"
              className={`rounded-xl border px-4 py-3 text-sm ${
                verdictLoading
                  ? "border-[var(--fp-border)]"
                  : verdict?.eligible
                    ? "border-[#34D399]/40 bg-[#34D399]/10"
                    : "border-[#FB7185]/40 bg-[#FB7185]/10"
              }`}
            >
              <div className="flex items-center gap-2 font-medium text-[var(--fp-text)]">
                {verdictLoading ? (
                  <>
                    <Spinner /> Checking eligibility…
                  </>
                ) : verdict ? (
                  verdict.eligible ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-[#34D399]" aria-hidden />
                      Eligible to send
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-[#FB7185]" aria-hidden />
                      Not eligible — will not send
                    </>
                  )
                ) : verdictError ? (
                  <>
                    <XCircle className="h-4 w-4 text-[#FB7185]" aria-hidden />
                    {verdictError}
                  </>
                ) : (
                  "Select a contact to check eligibility."
                )}
              </div>
              {verdict && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-[var(--fp-text-2)]">
                  {(verdict.eligible ? verdict.reasons : verdict.ineligibleReasons).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              {verdict?.windowEndsAt && (
                <p className="mt-2 text-xs text-[var(--fp-text-2)]">
                  Window ends: {new Date(verdict.windowEndsAt).toLocaleString()}
                </p>
              )}
            </div>

            {/* preview */}
            <div className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-4 py-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--fp-text-2)]">
                <Eye className="h-3.5 w-3.5" aria-hidden /> Exact preview
              </div>
              <p className="whitespace-pre-wrap text-sm text-[var(--fp-text)]">
                {preview || <span className="text-[var(--fp-text-2)]">Nothing to preview yet.</span>}
              </p>
            </div>

            {/* schedule */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-52 flex-1">
                <Input
                  label="Schedule for (optional)"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => doSend(false)} disabled={!canSend || sending}>
                <Send className="h-4 w-4" aria-hidden />
                {sending ? "Sending…" : "Send now"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => doSend(true)}
                disabled={!canSend || sending || !scheduledAt}
              >
                <CalendarClock className="h-4 w-4" aria-hidden />
                Schedule
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ---------------- follow-ups list ---------------- */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Follow-ups</CardTitle>
              <Select
                aria-label="Filter by status"
                options={[
                  { value: "", label: "All statuses" },
                  { value: "SCHEDULED", label: "Scheduled" },
                  { value: "SENT", label: "Sent" },
                  { value: "FAILED", label: "Failed" },
                  { value: "CANCELLED", label: "Cancelled" },
                ]}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-36"
              />
            </div>
          </CardHeader>
          <CardContent>
            {listLoading ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                title="No follow-ups yet"
                description="Compose a message on the left to send or schedule one."
              />
            ) : (
              <ul className="space-y-3">
                {items.map((f) => (
                  <li
                    key={f.id}
                    className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-[var(--fp-text)]">
                          {f.contactName ?? f.contactId}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-[var(--fp-text-2)]">
                          {f.body || "(template)"}
                        </p>
                        <p className="mt-1 text-xs text-[var(--fp-text-2)]">
                          {f.channel} · {f.messageType} ·{" "}
                          {new Date(f.scheduledAt).toLocaleString()}
                        </p>
                        {f.status === "CANCELLED" && f.cancelReason && (
                          <p className="mt-0.5 text-xs text-[var(--fp-text-2)]">
                            Reason: {f.cancelReason}
                          </p>
                        )}
                      </div>
                      <Badge tone={statusTone(f.status)}>{f.status}</Badge>
                    </div>
                    {f.status === "SCHEDULED" && (
                      <div className="mt-2 flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => cancelFollowUp(f.id)}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
