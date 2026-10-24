"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, useAccountSelection } from "@/lib/api-client";
import { useDict, useLocale } from "@/i18n/client";
import { formatRelativeTime } from "@/i18n/format";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  Search,
  Send,
  Sparkles,
  Inbox as InboxIcon,
  Bot,
  RefreshCw,
  ChevronLeft,
  StickyNote,
  Wand2,
  X,
  Plus,
  UserRound,
  MessageSquareText,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface ContactRef {
  id: string;
  name: string;
  channel: string;
}

interface ConversationItem {
  id: string;
  integrationId?: string | null;
  channel: string;
  status: string;
  aiHandled: boolean;
  priority: string;
  assignedTo?: string | null;
  humanTakeover?: boolean;
  composingBy?: string | null;
  composingAt?: string | null;
  demo?: boolean;
  tags: string[];
  updatedAt: string;
  contact: ContactRef;
  lastMessage?: { body: string; direction: string; createdAt: string } | null;
}

interface MessageItem {
  id: string;
  direction: string; // INBOUND | OUTBOUND | INTERNAL_NOTE
  body: string;
  aiGenerated: boolean;
  mocked: boolean;
  internalNote: boolean;
  createdAt: string;
}

interface TeamMember {
  id: string;
  role: string;
  user: { id: string; name: string; email: string };
}

interface ContactDetail {
  id: string;
  name: string;
  channel: string;
  email?: string | null;
  phone?: string | null;
  tags: string[];
  leadStatus: string;
  leadScore: number;
  notes: string;
}

interface ConversationDetail {
  id: string;
  channel: string;
  status: string;
  aiHandled: boolean;
  priority: string;
  assignedTo?: string | null;
  humanTakeover?: boolean;
  composingBy?: string | null;
  composingAt?: string | null;
  demo?: boolean;
  contact?: { id: string; name: string };
}

const READ_KEY = "fp_inbox_read";

const CHANNELS = ["instagram", "facebook", "whatsapp", "telegram", "email", "webchat", "web"];
const STATUSES = ["OPEN", "PENDING", "RESOLVED"];
const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "INTERESTED", "CONVERTED", "LOST"];

const SAVED_REPLY_KEYS = ["savedReply1", "savedReply2", "savedReply3"] as const;

const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];

/** Typing presence counts as live for 90s (matches the server-side lazy expiry). */
const TYPING_TTL_MS = 90_000;

function isTypingFresh(composingAt?: string | null): boolean {
  if (!composingAt) return false;
  const t = new Date(composingAt).getTime();
  return !Number.isNaN(t) && Date.now() - t < TYPING_TTL_MS;
}

function priorityTone(priority: string): "red" | "amber" | "green" | "gray" {
  if (priority === "URGENT") return "red";
  if (priority === "HIGH") return "amber";
  if (priority === "LOW") return "green";
  return "gray";
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function loadReadMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function statusTone(status: string): "violet" | "amber" | "green" | "gray" {
  if (status === "OPEN") return "violet";
  if (status === "PENDING") return "amber";
  if (status === "RESOLVED") return "green";
  return "gray";
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function InboxPage() {
  const t = useDict();
  const locale = useLocale();
  const { accountId } = useAccountSelection();
  const [convs, setConvs] = useState<ConversationItem[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [convError, setConvError] = useState<string | null>(null);

  /** Locale-aware relative timestamps ("5m ago" / "منذ ٥ دقائق"). */
  const timeAgo = useCallback(
    (iso: string) => formatRelativeTime(locale, iso, { justNow: t.inbox.justNow }),
    [locale, t]
  );

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [aiOnly, setAiOnly] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [readMap, setReadMap] = useState<Record<string, string>>({});

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [sendBanner, setSendBanner] = useState<string | null>(null);

  const [contactForm, setContactForm] = useState({
    tags: [] as string[],
    leadStatus: "NEW",
    leadScore: 0,
    notes: "",
  });
  const [newTag, setNewTag] = useState("");
  const [savingContact, setSavingContact] = useState(false);
  const [contactMsg, setContactMsg] = useState<string | null>(null);

  const [aiInfo, setAiInfo] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [mockNote, setMockNote] = useState<string | null>(null);

  const [mobileView, setMobileView] = useState<"list" | "thread" | "profile">("list");
  const threadEndRef = useRef<HTMLDivElement>(null);

  /* Stage 4a: team, conversation management, internal notes, typing */
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [mgmtMsg, setMgmtMsg] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteBody, setNoteBody] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const lastTypingPing = useRef(0);

  useEffect(() => {
    api<{ members: TeamMember[] }>("/api/team")
      .then((d) => setTeamMembers(d.members ?? []))
      .catch(() => {
        /* team list is best-effort */
      });
  }, []);

  const typerName = useCallback(
    (composingBy?: string | null) => {
      const m = teamMembers.find((t) => t.user.id === composingBy);
      return m ? m.user.name.split(" ")[0] : "Someone";
    },
    [teamMembers],
  );

  /** Persist assignment / priority / takeover changes (audit-logged server-side). */
  const patchConversation = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!selectedId) return;
      setMgmtMsg(null);
      try {
        const res = await api<{ conversation: ConversationDetail }>(
          `/api/conversations/${selectedId}`,
          { method: "PATCH", body: patch },
        );
        const conv = res.conversation;
        setDetail((d) => (d ? { ...d, ...conv } : d));
        setConvs((prev) =>
          prev.map((c) =>
            c.id === selectedId
              ? {
                  ...c,
                  assignedTo: conv.assignedTo,
                  priority: conv.priority ?? c.priority,
                  humanTakeover: conv.humanTakeover,
                }
              : c,
          ),
        );
        setMgmtMsg(t.inbox.saved);
      } catch (e) {
        setMgmtMsg(e instanceof ApiError ? `${t.inbox.updateFailed}: ${e.message}` : t.inbox.updateFailed);
      }
    },
    [selectedId, t],
  );

  /** Typing presence: ping on composer focus/input, clear on blur/send. */
  const postTyping = useCallback(
    async (active: boolean) => {
      if (!selectedId) return;
      try {
        await api(`/api/conversations/${selectedId}/typing`, {
          method: "POST",
          body: { active },
        });
      } catch {
        /* best-effort presence */
      }
    },
    [selectedId],
  );

  const pingTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingPing.current > 15000) {
      lastTypingPing.current = now;
      void postTyping(true);
    }
  }, [postTyping]);

  const saveNote = async () => {
    if (!selectedId || !noteBody.trim() || savingNote) return;
    setSavingNote(true);
    try {
      const res = await api<{ note: MessageItem }>(`/api/conversations/${selectedId}/notes`, {
        method: "POST",
        body: { body: noteBody.trim() },
      });
      setMessages((prev) => [...prev, res.note]);
      setNoteBody("");
      setNoteOpen(false);
    } catch (e) {
      setMgmtMsg(e instanceof ApiError ? `${t.inbox.noteFailed}: ${e.message}` : t.inbox.noteFailed);
    } finally {
      setSavingNote(false);
    }
  };

  /* Debounce search */
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 400);
    return () => clearTimeout(t);
  }, [q]);

  /* Seed read-state from localStorage (read state is tracked locally) */
  useEffect(() => {
    setReadMap(loadReadMap());
  }, []);

  const fetchConversations = useCallback(async () => {
    setLoadingConvs(true);
    setConvError(null);
    try {
      const data = await api<{ items: ConversationItem[]; total: number }>(
        "/api/conversations",
        {
          params: {
            ...(debouncedQ ? { search: debouncedQ } : {}),
            ...(channel ? { channel } : {}),
            ...(status ? { status } : {}),
            ...(aiOnly ? { aiHandled: "true" } : {}),
            ...(accountId ? { integrationId: accountId } : {}),
          },
        },
      );
      const items = data.items ?? [];
      setConvs(items);
      // Seed read-state for newly seen conversations (keeps existing entries).
      setReadMap((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const c of items) {
          if (!(c.id in next)) {
            next[c.id] = c.updatedAt;
            changed = true;
          }
        }
        if (changed) {
          try {
            localStorage.setItem(READ_KEY, JSON.stringify(next));
          } catch {
            /* storage unavailable */
          }
        }
        return changed ? next : prev;
      });
    } catch (e) {
      setConvError(e instanceof ApiError ? e.message : t.inbox.failedToLoadConversations);
    } finally {
      setLoadingConvs(false);
    }
  }, [debouncedQ, channel, status, aiOnly, accountId, t]);

  useEffect(() => {
    void fetchConversations();
  }, [fetchConversations]);

  const isUnread = useCallback(
    (c: ConversationItem) =>
      new Date(c.updatedAt).getTime() > new Date(readMap[c.id] ?? c.updatedAt).getTime(),
    [readMap],
  );

  const visibleConvs = unreadOnly ? convs.filter(isUnread) : convs;

  const markRead = useCallback((id: string, updatedAt: string) => {
    setReadMap((prev) => {
      const next = { ...prev, [id]: updatedAt };
      try {
        localStorage.setItem(READ_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const selectConversation = useCallback(
    async (c: ConversationItem) => {
      setSelectedId(c.id);
      setMobileView("thread");
      setSendBanner(null);
      setAiInfo(null);
      setMockNote(null);
      setNoteOpen(false);
      setNoteBody("");
      setMgmtMsg(null);
      lastTypingPing.current = 0;
      markRead(c.id, c.updatedAt);
      setLoadingThread(true);
      setThreadError(null);
      try {
        const [d, m] = await Promise.all([
          api<{ conversation: ConversationDetail; contact: ContactDetail }>(
            `/api/conversations/${c.id}`,
          ),
          api<{ messages: MessageItem[] }>(`/api/conversations/${c.id}/messages`),
        ]);
        setDetail(d.conversation);
        setDetail((prev) => (prev ? { ...prev, demo: c.demo } : prev));
        setContact(d.contact);
        setContactForm({
          tags: d.contact.tags ?? [],
          leadStatus: d.contact.leadStatus ?? "NEW",
          leadScore: d.contact.leadScore ?? 0,
          notes: d.contact.notes ?? "",
        });
        setMessages(m.messages ?? []);
      } catch (e) {
        setThreadError(e instanceof ApiError ? e.message : t.inbox.failedToLoadThread);
      } finally {
        setLoadingThread(false);
      }
    },
    [markRead, t],
  );

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, selectedId]);

  /* ------------------------------ send ------------------------------ */
  const sendMessage = async () => {
    if (!selectedId || !composer.trim() || sending) return;
    setSending(true);
    setSendBanner(null);
    try {
      const res = await api<{ message: MessageItem; mocked: boolean; note?: string }>(
        `/api/conversations/${selectedId}/messages`,
        { method: "POST", body: { body: composer.trim() } },
      );
      setMessages((prev) => [...prev, res.message]);
      setComposer("");
      void postTyping(false); // clear typing presence after sending
      if (res.mocked) {
        setSendBanner(res.note ?? t.inbox.mockSendNote);
      }
      void fetchConversations();
    } catch (e) {
      setSendBanner(e instanceof ApiError ? `${t.inbox.sendFailed}: ${e.message}` : t.inbox.sendFailed);
    } finally {
      setSending(false);
    }
  };

  /* --------------------------- contact edit -------------------------- */
  const saveContact = async () => {
    if (!contact) return;
    setSavingContact(true);
    setContactMsg(null);
    try {
      const updated = await api<ContactDetail>(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        body: {
          tags: contactForm.tags,
          leadStatus: contactForm.leadStatus,
          leadScore: contactForm.leadScore,
          notes: contactForm.notes,
        },
      });
      setContact(updated);
      setContactMsg(t.inbox.contactSaved);
    } catch (e) {
      setContactMsg(e instanceof ApiError ? `${t.inbox.saveFailed}: ${e.message}` : t.inbox.saveFailed);
    } finally {
      setSavingContact(false);
    }
  };

  const addTag = () => {
    const t = newTag.trim();
    if (!t || contactForm.tags.includes(t)) return;
    setContactForm((f) => ({ ...f, tags: [...f.tags, t] }));
    setNewTag("");
  };

  const removeTag = (t: string) =>
    setContactForm((f) => ({ ...f, tags: f.tags.filter((x) => x !== t) }));

  /* ----------------------------- AI assist --------------------------- */
  const lastInbound = [...messages].reverse().find((m) => m.direction === "INBOUND");

  const generateReply = async () => {
    if (!lastInbound || aiBusy) return;
    setAiBusy(true);
    setAiInfo(null);
    try {
      const res = await api<{ reply: string; mocked: boolean; confidence: number }>(
        "/api/ai-config/test",
        { method: "POST", body: { question: lastInbound.body } },
      );
      setComposer(res.reply);
      setAiInfo(
        t.inbox.aiDraftInserted.replace("{pct}", String(Math.round((res.confidence ?? 0) * 100))) +
          (res.mocked ? t.inbox.mockResponseSuffix : "")
      );
    } catch (e) {
      setAiInfo(e instanceof ApiError ? `${t.inbox.aiAssistFailed}: ${e.message}` : t.inbox.aiAssistFailed);
    } finally {
      setAiBusy(false);
    }
  };

  const mockRewrite = (kind: "shorter" | "friendlier" | "professional") => {
    if (!composer.trim()) {
      setMockNote(t.inbox.mockRewriteFirst);
      return;
    }
    let out = composer.trim();
    if (kind === "shorter") {
      out = out.split(/(?<=[.!?])\s+/)[0] ?? out;
    } else if (kind === "friendlier") {
      const name = contact?.name?.split(" ")[0] ?? "there";
      out = `Hi ${name}! ${out} Just let me know if you need anything else — happy to help.`;
    } else {
      out = out
        .replace(/\bhi\b/i, "Hello")
        .replace(/\bthanks\b/i, "Thank you")
        .replace(/\bcan't\b/i, "cannot")
        .replace(/\bwon't\b/i, "will not");
      if (!/^(hello|hi|dear)/i.test(out)) out = `Hello, ${out}`;
    }
    setComposer(out);
    setMockNote(t.inbox.mockRewriteApplied.replace("{kind}", kind));
  };

  const mockSummarize = () => {
    if (messages.length === 0) {
      setMockNote(t.inbox.mockSummarizeEmpty);
      return;
    }
    const first = messages.slice(0, 2).map((m) => m.body);
    setMockNote(`${t.inbox.mockSummaryPrefix}${first.join(" ").slice(0, 280)}…`);
  };

  const selected = convs.find((c) => c.id === selectedId) ?? null;

  return (
    <div>
      <PageHeader
        title={t.inbox.title}
        description={t.inbox.description}
        actions={
          <Button variant="secondary" size="sm" onClick={() => void fetchConversations()} disabled={loadingConvs}>
            <RefreshCw className={`h-4 w-4 ${loadingConvs ? "animate-spin" : ""}`} />
            {t.inbox.refresh}
          </Button>
        }
      />

      <div className="grid gap-4 lg:h-[calc(100vh-13rem)] lg:grid-cols-[300px_minmax(0,1fr)_320px]">
        {/* ------------------------- Conversation list ------------------------- */}
        <section
          aria-label={t.inbox.conversationsSection}
          className={`${
            mobileView === "list" ? "flex" : "hidden"
          } min-h-0 flex-col rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] lg:flex`}
        >
          <div className="space-y-3 border-b border-[var(--fp-border)] p-4">
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fp-text-2)]" aria-hidden />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t.inbox.searchPlaceholder}
                className="ps-9"
                aria-label={t.inbox.searchAria}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                options={CHANNELS.map((c) => ({ value: c, label: c }))}
                placeholder={t.inbox.allChannels}
                aria-label={t.inbox.filterByChannel}
              />
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                options={STATUSES.map((s) => ({ value: s, label: s }))}
                placeholder={t.inbox.allStatuses}
                aria-label={t.inbox.filterByStatus}
              />
            </div>
            <div className="flex items-center gap-4 text-sm text-[var(--fp-text-2)]">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={aiOnly}
                  onChange={(e) => setAiOnly(e.target.checked)}
                  className="h-4 w-4 accent-[#8B5CF6]"
                />
                {t.inbox.aiHandled}
              </label>
              <label
                className="flex cursor-pointer items-center gap-2"
                title={t.inbox.readStateNote}
              >
                <input
                  type="checkbox"
                  checked={unreadOnly}
                  onChange={(e) => setUnreadOnly(e.target.checked)}
                  className="h-4 w-4 accent-[#8B5CF6]"
                />
                {t.inbox.unreadOnly}
              </label>
            </div>
          </div>

          <div className="max-h-[60vh] min-h-0 flex-1 overflow-y-auto lg:max-h-none">
            {loadingConvs ? (
              <Spinner label={t.inbox.loadingConversations} className="py-8" />
            ) : convError ? (
              <div className="p-4 text-sm text-[#FB7185]" role="alert">{convError}</div>
            ) : visibleConvs.length === 0 ? (
              <EmptyState
                icon={InboxIcon}
                title={t.inbox.noConversations}
                description={t.inbox.noConversationsHint}
              />
            ) : (
              <ul>
                {visibleConvs.map((c) => {
                  const active = c.id === selectedId;
                  const unread = isUnread(c);
                  return (
                    <li key={c.id}>
                      <button
                        onClick={() => void selectConversation(c)}
                        className={`flex w-full items-start gap-3 border-b border-[var(--fp-border)] px-4 py-3 text-start transition-colors hover:bg-[var(--fp-bg-2)] ${
                          active ? "bg-[var(--fp-bg-2)]" : ""
                        }`}
                      >
                        <div className="relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#8B5CF6] to-[#22D3EE] text-sm font-bold text-white">
                          {initials(c.contact?.name ?? "?")}
                          {unread && (
                            <span className="absolute -end-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-[var(--fp-card)] bg-[#22D3EE]" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-semibold text-[var(--fp-text)]">
                              {c.contact?.name ?? t.inbox.unknownContact}
                            </p>
                            <span className="shrink-0 text-[11px] text-[var(--fp-text-2)]">
                              {timeAgo(c.updatedAt)}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <Badge tone="cyan">{c.channel}</Badge>
                            <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                            {c.priority && c.priority !== "NORMAL" && (
                              <Badge tone={priorityTone(c.priority)}>{c.priority}</Badge>
                            )}
                            {c.aiHandled && <Bot className="h-3.5 w-3.5 text-[#8B5CF6]" aria-label={t.inbox.aiHandled} />}
                            {c.humanTakeover && (
                              <span className="rounded-full border border-[#FB7185]/30 bg-[#FB7185]/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-[#FDA4AF]">
                                {t.inbox.takeover}
                              </span>
                            )}
                            {c.demo && (
                              <span className="rounded-full border border-[#FBBF24]/30 bg-[#FBBF24]/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-[#FCD34D]">
                                {t.inbox.demoBadge}
                              </span>
                            )}
                          </div>
                          {isTypingFresh(c.composingAt) && c.composingBy ? (
                            <p className="mt-1 truncate text-xs font-medium text-[#22D3EE]">
                              {t.inbox.isReplying.replace("{name}", typerName(c.composingBy))}
                            </p>
                          ) : (
                            <p className="mt-1 truncate text-xs text-[var(--fp-text-2)]">
                              {c.lastMessage?.body ?? t.inbox.noMessagesYet}
                            </p>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* ------------------------------ Thread ------------------------------ */}
        <section
          aria-label={t.inbox.messageThreadSection}
          className={`${
            mobileView === "thread" ? "flex" : "hidden"
          } min-h-0 flex-col rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] lg:flex`}
        >
          {!selected ? (
            <EmptyState
              icon={MessageSquareText}
              title={t.inbox.selectConversation}
              description={t.inbox.selectConversationHint}
            />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-[var(--fp-border)] p-4">
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="lg:hidden"
                    onClick={() => setMobileView("list")}
                    aria-label={t.inbox.backToList}
                  >
                    <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
                  </Button>
                  <div>
                    <p className="text-sm font-semibold text-[var(--fp-text)]">
                      {selected.contact?.name}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone="cyan">{selected.channel}</Badge>
                      <Badge tone={statusTone(selected.status)}>{selected.status}</Badge>
                      {detail?.aiHandled && <Badge tone="violet">{t.inbox.aiHandled}</Badge>}
                      {detail?.humanTakeover && <Badge tone="red">{t.inbox.takeover}</Badge>}
                      {selected.demo && <Badge tone="amber">{t.inbox.demoBadge}</Badge>}
                      {isTypingFresh(detail?.composingAt) && detail?.composingBy && (
                        <span className="text-[11px] font-medium text-[#22D3EE]">
                          {t.inbox.isReplying.replace("{name}", typerName(detail.composingBy))}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant={noteOpen ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => setNoteOpen((v) => !v)}
                    title={t.inbox.noteTitle}
                  >
                    <StickyNote className="h-4 w-4" aria-hidden />
                    <span className="hidden sm:inline">{t.inbox.note}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="lg:hidden"
                    onClick={() => setMobileView("profile")}
                    aria-label={t.inbox.profile}
                  >
                    <UserRound className="h-4 w-4" aria-hidden />
                    {t.inbox.profile}
                  </Button>
                </div>
              </div>

              {noteOpen && (
                <div className="border-b border-[var(--fp-border)] bg-[#FBBF24]/5 p-3">
                  <Textarea
                    value={noteBody}
                    onChange={(e) => setNoteBody(e.target.value)}
                    placeholder={t.inbox.notePlaceholder}
                    rows={2}
                    aria-label={t.inbox.noteAria}
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => { setNoteOpen(false); setNoteBody(""); }}>
                      {t.common.cancel}
                    </Button>
                    <Button size="sm" onClick={() => void saveNote()} loading={savingNote} disabled={!noteBody.trim()}>
                      {t.inbox.saveNote}
                    </Button>
                  </div>
                </div>
              )}

              <div className="max-h-[45vh] min-h-0 flex-1 space-y-3 overflow-y-auto p-4 lg:max-h-none">
                {loadingThread ? (
                  <Spinner label={t.inbox.loadingThread} />
                ) : threadError ? (
                  <p className="text-sm text-[#FB7185]" role="alert">{threadError}</p>
                ) : messages.length === 0 ? (
                  <EmptyState icon={MessageSquareText} title={t.inbox.noMessagesYet} />
                ) : (
                  messages.map((m) => {
                    const isNote = m.internalNote || m.direction === "INTERNAL_NOTE";
                    if (isNote) {
                      return (
                        <div
                          key={m.id}
                          className="mx-auto flex max-w-md items-start gap-2 rounded-lg border border-[#FBBF24]/30 bg-[#FBBF24]/10 px-3 py-2"
                        >
                          <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-[#FBBF24]" />
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-[#FBBF24]">
                              {t.inbox.internalNoteNeverSent}
                            </p>
                            <p className="text-sm text-[var(--fp-text)]">{m.body}</p>
                            <p className="mt-1 text-[10px] text-[var(--fp-text-2)]">
                              {timeAgo(m.createdAt)}
                            </p>
                          </div>
                        </div>
                      );
                    }
                    const outbound = m.direction === "OUTBOUND";
                    // Honest real-vs-demo: mock-adapter output is Demo; seeded
                    // demo threads are Demo too; everything else is Real.
                    const isDemo = m.mocked || selected?.demo;
                    return (
                      <div key={m.id} className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                            outbound
                              ? "btn-gradient text-white ltr:rounded-br-md rtl:rounded-bl-md"
                              : "border border-[var(--fp-border)] bg-[var(--fp-bg-2)] text-[var(--fp-text)] ltr:rounded-bl-md rtl:rounded-br-md"
                          }`}
                        >
                          <div className="mb-1 flex flex-wrap gap-1.5">
                            {m.aiGenerated && (
                              <span className="rounded-full bg-black/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                                AI
                              </span>
                            )}
                            {isDemo ? (
                              <span
                                className="rounded-full bg-black/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                                title={t.inbox.demoBadgeTitle}
                              >
                                {t.inbox.demoBadge}
                              </span>
                            ) : (
                              <span
                                className="rounded-full bg-black/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                                title={t.inbox.realBadgeTitle}
                              >
                                {t.inbox.realBadge}
                              </span>
                            )}
                          </div>
                          <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                          <p
                            className={`mt-1 text-[10px] ${outbound ? "text-white/70" : "text-[var(--fp-text-2)]"}`}
                          >
                            {timeAgo(m.createdAt)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={threadEndRef} />
              </div>

              {/* AI assist bar */}
              <div className="space-y-2 border-t border-[var(--fp-border)] p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 flex items-center gap-1 text-xs font-semibold text-[var(--fp-text-2)]">
                    <Sparkles className="h-3.5 w-3.5 text-[#8B5CF6]" aria-hidden /> {t.inbox.aiAssist}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => void generateReply()} loading={aiBusy} disabled={!lastInbound}>
                    {t.inbox.generateReply}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => mockRewrite("shorter")}>
                    <Wand2 className="h-3.5 w-3.5" aria-hidden /> {t.inbox.shorter}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => mockRewrite("friendlier")}>
                    <Wand2 className="h-3.5 w-3.5" aria-hidden /> {t.inbox.friendlier}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => mockRewrite("professional")}>
                    <Wand2 className="h-3.5 w-3.5" aria-hidden /> {t.inbox.professional}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={mockSummarize}>
                    {t.inbox.summarize}
                  </Button>
                </div>
                {aiInfo && <p className="text-xs text-[#8B5CF6]">{aiInfo}</p>}
                {mockNote && (
                  <p className="rounded-lg bg-[var(--fp-bg-2)] px-3 py-2 text-xs text-[var(--fp-text-2)]">
                    {mockNote}
                  </p>
                )}
                <details className="text-xs">
                  <summary className="cursor-pointer text-[var(--fp-text-2)] hover:text-[var(--fp-text)]">
                    {t.inbox.savedReplies}
                  </summary>
                  <div className="mt-1.5 space-y-1.5">
                    {SAVED_REPLY_KEYS.map((k) => {
                      const r = t.inbox[k];
                      return (
                        <button
                          key={k}
                          onClick={() => setComposer((c) => (c ? `${c}\n${r}` : r))}
                          className="block w-full rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-3 py-2 text-start text-[var(--fp-text-2)] hover:border-[#8B5CF6] hover:text-[var(--fp-text)]"
                        >
                          {r}
                        </button>
                      );
                    })}
                  </div>
                </details>
              </div>

              {/* Composer */}
              <div className="border-t border-[var(--fp-border)] p-3">
                {sendBanner && (
                  <p className="mb-2 rounded-lg border border-[#22D3EE]/30 bg-[#22D3EE]/10 px-3 py-2 text-xs text-[#67E8F9]">
                    {sendBanner}
                  </p>
                )}
                <div className="flex gap-2">
                  <Textarea
                    value={composer}
                    onChange={(e) => {
                      setComposer(e.target.value);
                      pingTyping();
                    }}
                    onFocus={pingTyping}
                    onBlur={() => void postTyping(false)}
                    placeholder={t.inbox.replyPlaceholder}
                    rows={2}
                    aria-label={t.inbox.replyAria}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void sendMessage();
                    }}
                  />
                  <Button onClick={() => void sendMessage()} loading={sending} disabled={!composer.trim()} aria-label={t.inbox.sendAria}>
                    <Send className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
                <p className="mt-1 text-[11px] text-[var(--fp-text-2)]">
                  {t.inbox.mockAdapterNote}
                </p>
              </div>
            </>
          )}
        </section>

        {/* --------------------------- Contact profile --------------------------- */}
        <aside
          aria-label={t.inbox.contactProfileSection}
          className={`${
            mobileView === "profile" ? "block" : "hidden"
          } min-h-0 overflow-y-auto rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-4 lg:block`}
        >
          {!contact ? (
            <EmptyState icon={UserRound} title={t.inbox.noContactSelected} description={t.inbox.noContactSelectedHint} />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--fp-text)]">{t.inbox.contactProfile}</h3>
                <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => setMobileView("thread")} aria-label={t.inbox.backToThread}>
                  <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
                </Button>
              </div>

              {/* --------------------- Conversation management --------------------- */}
              <div className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">
                  {t.inbox.conversationGroup}
                </p>
                <div className="space-y-2.5">
                  <Select
                    label={t.inbox.assignee}
                    value={detail?.assignedTo ?? ""}
                    onChange={(e) =>
                      void patchConversation({ assignedTo: e.target.value || null })
                    }
                    options={[
                      { value: "", label: t.inbox.unassigned },
                      ...teamMembers.map((m) => ({
                        value: m.user.id,
                        label: `${m.user.name} (${m.role})`,
                      })),
                    ]}
                    aria-label={t.inbox.assignAria}
                  />
                  <Select
                    label={t.inbox.priority}
                    value={detail?.priority ?? "NORMAL"}
                    onChange={(e) => void patchConversation({ priority: e.target.value.toLowerCase() })}
                    options={PRIORITIES.map((p) => ({ value: p, label: p }))}
                    aria-label={t.inbox.priorityAria}
                  />
                  <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-[var(--fp-border)] bg-[var(--fp-card)] p-2.5">
                    <span>
                      <span className="block text-sm font-medium text-[var(--fp-text)]">
                        {t.inbox.takeOver}
                      </span>
                      <span className="block text-xs text-[var(--fp-text-2)]">
                        {t.inbox.takeOverHint}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={detail?.humanTakeover ?? false}
                      onChange={(e) => void patchConversation({ humanTakeover: e.target.checked })}
                      className="mt-0.5 h-5 w-5 shrink-0 accent-[#8B5CF6]"
                      aria-label={t.inbox.takeOverAria}
                    />
                  </label>
                  {mgmtMsg && <p className="text-xs text-[var(--fp-text-2)]">{mgmtMsg}</p>}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-[#8B5CF6] to-[#22D3EE] text-base font-bold text-white">
                  {initials(contact.name)}
                </div>
                <div>
                  <p className="font-semibold text-[var(--fp-text)]">{contact.name}</p>
                  <Badge tone="cyan">{contact.channel}</Badge>
                </div>
              </div>
              {contact.email && <p className="text-xs text-[var(--fp-text-2)]">{contact.email}</p>}
              {contact.phone && <p className="text-xs text-[var(--fp-text-2)]">{contact.phone}</p>}

              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">{t.inbox.tags}</p>
                <div className="flex flex-wrap gap-1.5">
                  {contactForm.tags.map((tg) => (
                    <span key={tg} className="inline-flex items-center gap-1 rounded-full bg-[var(--fp-bg-2)] px-2.5 py-1 text-xs text-[var(--fp-text)]">
                      {tg}
                      <button onClick={() => removeTag(tg)} aria-label={`${t.inbox.tags}: ${tg}`} className="text-[var(--fp-text-2)] hover:text-[#FB7185]">
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex gap-1.5">
                  <Input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder={t.inbox.addTagPlaceholder} aria-label={t.inbox.newTagAria} onKeyDown={(e) => e.key === "Enter" && addTag()} />
                  <Button size="sm" variant="secondary" onClick={addTag} aria-label={t.inbox.addTagAria}>
                    <Plus className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </div>

              <Select
                label={t.inbox.leadStatus}
                value={contactForm.leadStatus}
                onChange={(e) => setContactForm((f) => ({ ...f, leadStatus: e.target.value }))}
                options={LEAD_STATUSES.map((s) => ({ value: s, label: s }))}
              />

              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--fp-text)]">
                  {t.inbox.leadScore}: <span className="text-gradient font-bold">{contactForm.leadScore}</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={contactForm.leadScore}
                  onChange={(e) => setContactForm((f) => ({ ...f, leadScore: Number(e.target.value) }))}
                  className="w-full accent-[#8B5CF6]"
                  aria-label={t.inbox.leadScoreAria}
                />
              </div>

              <Textarea
                label={t.inbox.notes}
                value={contactForm.notes}
                onChange={(e) => setContactForm((f) => ({ ...f, notes: e.target.value }))}
                rows={3}
                placeholder={t.inbox.notesPlaceholder}
              />

              {contactMsg && <p className="text-xs text-[var(--fp-text-2)]">{contactMsg}</p>}
              <Button onClick={() => void saveContact()} loading={savingContact} className="w-full">
                {t.inbox.saveContact}
              </Button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
