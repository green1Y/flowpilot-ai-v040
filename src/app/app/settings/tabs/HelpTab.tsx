"use client";

/**
 * Settings · Help & Support section.
 * - Searchable help: in-product docs guides (from the docs registry) + FAQ,
 *   filtered client-side.
 * - Support form: subject + message with validation, POST /api/support/tickets.
 *   The success confirmation shows ONLY on HTTP 201 with a stored ticket in
 *   the response; every other outcome shows an explicit error state.
 * - My tickets: GET /api/support/tickets (own workspace), with refresh.
 *
 * Support-ticket API contract (parallel workstream):
 *   POST /api/support/tickets {subject, message} → 201 with ticket
 *   GET  /api/support/tickets → own workspace tickets
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Spinner } from "@/components/ui/Spinner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ArrowUpRight, ChevronDown, RefreshCw, Search } from "lucide-react";
import { GUIDE_ORDER, GUIDE_FRAGMENT_KEY, type GuideSlug } from "@/app/docs/guides";
import { en as docsEn, ar as docsAr } from "@/i18n/fragments/docs";
import type { Locale } from "@/i18n/config";
import { Msg, type SettingsDict } from "../ui";

interface Faq {
  q: string;
  a: string;
}

interface Guide {
  slug: string;
  title: string;
  desc: string;
}

interface Ticket {
  id: string;
  subject?: string;
  message?: string;
  status?: string;
  createdAt?: string;
}

function workspaceHeader(): Record<string, string> {
  try {
    const ws = localStorage.getItem("fp_workspace_id");
    if (ws) return { "x-workspace-id": ws };
  } catch {
    /* ignore */
  }
  return {};
}

function isTicket(v: unknown): v is Ticket {
  return !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string";
}

export function HelpTab({ t, locale }: { t: SettingsDict; locale: Locale }) {
  const s = t.support;
  const docsGuides = locale === "ar" ? docsAr.guides : docsEn.guides;

  const [query, setQuery] = useState("");
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  // --- support form ---
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [subjectErr, setSubjectErr] = useState<string | null>(null);
  const [messageErr, setMessageErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [formTone, setFormTone] = useState<"ok" | "err">("ok");
  const [createdTicket, setCreatedTicket] = useState<Ticket | null>(null);

  // --- tickets ---
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [ticketsError, setTicketsError] = useState<string | null>(null);

  const guides: Guide[] = useMemo(
    () =>
      GUIDE_ORDER.map((slug: GuideSlug) => {
        const key = GUIDE_FRAGMENT_KEY[slug] as keyof typeof docsGuides;
        const g = docsGuides[key];
        return { slug, title: g.title, desc: g.desc };
      }),
    [docsGuides]
  );

  const faqs = useMemo(() => s.faqs as Faq[], [s]);

  const q = query.trim().toLowerCase();
  const matchedGuides = q
    ? guides.filter((g) => `${g.title} ${g.desc}`.toLowerCase().includes(q))
    : guides;
  const matchedFaqs = q
    ? faqs.filter((f) => `${f.q} ${f.a}`.toLowerCase().includes(q))
    : faqs;

  const fetchTickets = useCallback(async () => {
    setTicketsLoading(true);
    setTicketsError(null);
    try {
      // Raw fetch: the parallel workstream's response shape is contract-only
      // ({tickets} or the standard {ok,data} envelope), so unwrap defensively.
      const res = await fetch("/api/support/tickets", {
        credentials: "include",
        headers: workspaceHeader(),
      });
      if (res.status === 404) {
        setTicketsError(s.endpointMissing);
        setTickets([]);
        return;
      }
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      const body = (await res.json()) as unknown;
      const list =
        (body as { tickets?: unknown })?.tickets ??
        (body as { data?: unknown })?.data ??
        body;
      setTickets(Array.isArray(list) ? list.filter(isTicket) : []);
    } catch {
      setTicketsError(t.common.retry);
    } finally {
      setTicketsLoading(false);
    }
  }, [s, t]);

  useEffect(() => {
    void fetchTickets();
  }, [fetchTickets]);

  const submitTicket = async () => {
    const sub = subject.trim();
    const msg = message.trim();
    const subErr = sub.length >= 3 ? null : s.subjectRequired;
    const msgErr = msg.length >= 10 ? null : s.messageRequired;
    setSubjectErr(subErr);
    setMessageErr(msgErr);
    if (subErr || msgErr) return;

    setSubmitting(true);
    setFormMsg(null);
    setCreatedTicket(null);
    try {
      const res = await fetch("/api/support/tickets", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...workspaceHeader() },
        body: JSON.stringify({ subject: sub, message: msg }),
      });
      if (res.status === 404) {
        setFormTone("err");
        setFormMsg(s.endpointMissing);
        return;
      }
      const body = (await res.json().catch(() => null)) as unknown;
      const ticket =
        (body as { ticket?: unknown } | null)?.ticket ??
        (body as { data?: { ticket?: unknown } } | null)?.data?.ticket;
      // Success confirmation ONLY on 201 with a stored ticket.
      if (res.status === 201 && isTicket(ticket)) {
        setFormTone("ok");
        setFormMsg(s.ticketCreated);
        setCreatedTicket(ticket);
        setSubject("");
        setMessage("");
        void fetchTickets();
      } else {
        setFormTone("err");
        const errMsg =
          (body as { error?: string; message?: string } | null)?.error ??
          (body as { error?: string; message?: string } | null)?.message;
        setFormMsg(errMsg || `${s.submitError} (status ${res.status})`);
      }
    } catch {
      setFormTone("err");
      setFormMsg(s.submitError);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{s.searchTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search
              className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fp-text-2)]"
              aria-hidden
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={s.searchPlaceholder}
              aria-label={s.searchTitle}
              className="w-full rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] py-2.5 pe-3 ps-9 text-sm text-[var(--fp-text)] placeholder:text-[var(--fp-text-2)] focus:border-[var(--fp-accent)] focus:outline-none"
            />
          </div>
          <p className="text-xs text-[var(--fp-text-2)]">{s.searchHint}</p>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-[var(--fp-text)]">{s.guidesTitle}</h3>
            {matchedGuides.length === 0 && q ? (
              <p className="text-sm text-[var(--fp-text-2)]">{s.noResults}</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {matchedGuides.map((g) => (
                  <li key={g.slug}>
                    <Link
                      href={`/docs/${g.slug}`}
                      className="flex h-full items-start justify-between gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-4 py-3 transition-colors hover:border-[var(--fp-accent)]"
                    >
                      <span>
                        <span className="block text-sm font-medium text-[var(--fp-text)]">{g.title}</span>
                        <span className="mt-0.5 block text-xs text-[var(--fp-text-2)]">{g.desc}</span>
                      </span>
                      <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--fp-text-2)]" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{s.faqTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          {matchedFaqs.length === 0 && q ? (
            <p className="text-sm text-[var(--fp-text-2)]">{s.noResults}</p>
          ) : (
            <div className="divide-y divide-[var(--fp-border)]">
              {matchedFaqs.map((f, i) => {
                const open = openFaq === i;
                return (
                  <div key={f.q} className="py-2">
                    <button
                      type="button"
                      onClick={() => setOpenFaq(open ? null : i)}
                      aria-expanded={open}
                      className="flex w-full items-center justify-between gap-3 py-1.5 text-start"
                    >
                      <span className="text-sm font-medium text-[var(--fp-text)]">{f.q}</span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-[var(--fp-text-2)] transition-transform ${open ? "rotate-180" : ""}`}
                        aria-hidden
                      />
                    </button>
                    {open && <p className="pb-2 text-sm leading-relaxed text-[var(--fp-text-2)]">{f.a}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{s.contactTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-[var(--fp-text-2)]">{s.contactHint}</p>
          <Input
            label={s.subject}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={s.subjectPlaceholder}
            error={subjectErr ?? undefined}
            maxLength={140}
          />
          <Textarea
            label={s.message}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={s.messagePlaceholder}
            error={messageErr ?? undefined}
            rows={5}
            maxLength={4000}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => void submitTicket()} loading={submitting}>
              {submitting ? s.submitting : s.submit}
            </Button>
            <Msg text={formMsg} tone={formTone} />
          </div>
          {createdTicket && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm">
              <span className="text-[var(--fp-text-2)]">{s.ticketId}:</span>
              <code className="font-mono text-[var(--fp-text)]" dir="ltr">{createdTicket.id}</code>
              {createdTicket.status && (
                <>
                  <span className="text-[var(--fp-text-2)]">{s.status}:</span>
                  <Badge tone="green">{createdTicket.status}</Badge>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{s.myTickets}</CardTitle>
            <Button size="sm" variant="secondary" onClick={() => void fetchTickets()} loading={ticketsLoading}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              {s.refresh}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {ticketsLoading ? (
            <Spinner label={t.common.loading} className="py-4" />
          ) : ticketsError ? (
            <p className="text-sm text-[var(--fp-text-2)]">{ticketsError}</p>
          ) : tickets.length === 0 ? (
            <p className="text-sm text-[var(--fp-text-2)]">{s.noTickets}</p>
          ) : (
            <ul className="space-y-2">
              {tickets.map((tk) => (
                <li
                  key={tk.id}
                  className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-medium text-[var(--fp-text)]">
                      {tk.subject || tk.id}
                    </p>
                    {tk.status && <Badge tone="gray">{tk.status}</Badge>}
                  </div>
                  {tk.message && (
                    <p className="mt-1 line-clamp-2 text-xs text-[var(--fp-text-2)]">{tk.message}</p>
                  )}
                  <p className="mt-1 font-mono text-[11px] text-[var(--fp-text-2)]" dir="ltr">
                    {tk.id}
                    {tk.createdAt ? ` · ${new Date(tk.createdAt).toLocaleString()}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
