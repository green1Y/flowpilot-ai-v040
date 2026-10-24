"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { useDict, useLocale } from "@/i18n/client";
import { formatRelativeTime, formatInt, formatDateTime } from "@/i18n/format";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  Users,
  Plus,
  Download,
  Upload,
  X,
  Search,
  Tag as TagIcon,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

/* ------------------------------------------------------------------ */

interface Contact {
  id: string;
  name: string;
  channel: string;
  email?: string | null;
  phone?: string | null;
  tags: string[];
  leadStatus: string;
  leadScore: number;
  lastSeenAt: string;
  notes?: string;
  customFields?: Record<string, string> | string;
  assignedTo?: string | null;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

interface ContactSegment {
  id: string;
  name: string;
  filters: {
    channel?: string;
    tag?: string;
    leadStatus?: string;
    search?: string;
    from?: string;
    to?: string;
  };
  createdAt: string;
}

interface TimelineItem {
  type: "message" | "comment" | "workflow" | "lead_stage";
  at: string;
  channel?: string;
  summary: string;
  real: boolean;
}

const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "INTERESTED", "CONVERTED", "LOST"];
const CHANNELS = ["web", "instagram", "facebook", "whatsapp", "telegram", "email", "webchat"];

function leadTone(s: string): "gray" | "blue" | "cyan" | "violet" | "green" | "red" {
  switch (s) {
    case "NEW":
      return "gray";
    case "CONTACTED":
      return "blue";
    case "QUALIFIED":
      return "cyan";
    case "INTERESTED":
      return "violet";
    case "CONVERTED":
      return "green";
    case "LOST":
      return "red";
    default:
      return "gray";
  }
}

function normalizeCustomFields(cf: Contact["customFields"]): Record<string, string> {
  if (!cf) return {};
  if (typeof cf === "object") return cf;
  try {
    const parsed = JSON.parse(cf) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function itemTypeTone(t: TimelineItem["type"]): "gray" | "blue" | "cyan" | "violet" | "green" | "red" {
  switch (t) {
    case "message":
      return "blue";
    case "comment":
      return "cyan";
    case "workflow":
      return "violet";
    case "lead_stage":
      return "green";
    default:
      return "gray";
  }
}

const emptyForm = {
  name: "",
  channel: "web",
  email: "",
  phone: "",
  tags: "",
  leadStatus: "NEW",
  leadScore: 0,
  notes: "",
};

/* ------------------------------------------------------------------ */

export default function ContactsPage() {
  const t = useDict();
  const locale = useLocale();
  const [items, setItems] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [tag, setTag] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Saved segments (server-side filter sets).
  const [segments, setSegments] = useState<ContactSegment[]>([]);
  const [segmentId, setSegmentId] = useState("");
  const [segmentName, setSegmentName] = useState("");
  const [savingSegment, setSavingSegment] = useState(false);
  const [segmentMsg, setSegmentMsg] = useState<string | null>(null);

  // Drawer tabs: details | timeline.
  const [drawerTab, setDrawerTab] = useState<"details" | "timeline">("details");
  const [timeline, setTimeline] = useState<TimelineItem[] | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTag, setBulkTag] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ message: string; force: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const [drawer, setDrawer] = useState<Contact | null>(null);
  const [drawerForm, setDrawerForm] = useState({
    name: "",
    email: "",
    phone: "",
    channel: "web",
    leadStatus: "NEW",
    leadScore: 0,
    tags: "",
    notes: "",
    customFields: "{}",
  });
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [drawerMsg, setDrawerMsg] = useState<string | null>(null);
  const [drawerSaving, setDrawerSaving] = useState(false);
  // Stage 4e — linked e-commerce orders for the contact in the drawer.
  const [orderLinks, setOrderLinks] = useState<
    { link: { orderId: string; linkedAt: string; verified: boolean; source: string }; order: { orderId: string; status: string; total: number; currency: string; verified: boolean; source: string } | null }[]
  >([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderInput, setOrderInput] = useState("");
  const [orderLinking, setOrderLinking] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const timeAgo = useCallback(
    (iso: string) => formatRelativeTime(locale, iso, { justNow: "—" }),
    [locale]
  );

  const itemTypeLabel = useCallback(
    (ty: TimelineItem["type"]): string => {
      switch (ty) {
        case "message":
          return t.contacts.timelineMessage;
        case "comment":
          return t.contacts.timelineComment;
        case "workflow":
          return t.contacts.timelineWorkflow;
        case "lead_stage":
          return t.contacts.timelineLeadStage;
        default:
          return ty;
      }
    },
    [t]
  );
  const [csv, setCsv] = useState("name,email,phone,tags\nJane Doe,jane@example.com,+15551234567,vip");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Wave 2B (additive): import batches — list only; the full preview /
  // confirm flow lives on /app/contacts/import. The legacy import modal
  // above is untouched.
  const [importBatches, setImportBatches] = useState<
    { id: string; filename: string; status: string; totalRows: number; importedCount: number; skippedCount: number; failedCount: number }[]
  >([]);
  useEffect(() => {
    api<{ items: typeof importBatches }>("/api/contacts/imports")
      .then((d) => setImportBatches(d.items ?? []))
      .catch(() => { /* batch list is a convenience — never break the page */ });
  }, []);

  /* ------------------------------- fetch ------------------------------ */
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 400);
    return () => clearTimeout(t);
  }, [q]);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ items: Contact[]; total: number }>("/api/contacts", {
        params: {
          ...(debouncedQ ? { search: debouncedQ } : {}),
          ...(status ? { status } : {}),
          ...(channel ? { channel } : {}),
          ...(tag ? { tag } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(segmentId ? { segmentId } : {}),
          page: String(page),
        },
      });
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.contacts.failedToLoadContacts);
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, status, channel, tag, from, to, segmentId, page, t]);

  useEffect(() => {
    void fetchContacts();
  }, [fetchContacts]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, status, channel, tag, from, to, segmentId]);

  /* ----------------------------- segments ------------------------------ */
  const fetchSegments = useCallback(async () => {
    try {
      const data = await api<{ items: ContactSegment[] }>("/api/contact-segments");
      setSegments(data.items ?? []);
    } catch {
      // Segments are a convenience — never break the page if they fail.
    }
  }, []);

  useEffect(() => {
    void fetchSegments();
  }, [fetchSegments]);

  const applySegment = (id: string) => {
    setSegmentId(id);
    if (!id) return;
    const seg = segments.find((s) => s.id === id);
    if (!seg) return;
    const f = seg.filters ?? {};
    if (f.channel !== undefined) setChannel(f.channel);
    if (f.tag !== undefined) setTag(f.tag);
    if (f.leadStatus !== undefined) setStatus(f.leadStatus);
    if (f.search !== undefined) setQ(f.search);
    if (f.from !== undefined) setFrom(f.from);
    if (f.to !== undefined) setTo(f.to);
  };

  const saveSegment = async () => {
    const name = segmentName.trim();
    if (!name) return;
    setSavingSegment(true);
    setSegmentMsg(null);
    try {
      await api("/api/contact-segments", {
        method: "POST",
        body: {
          name,
          filters: {
            ...(channel ? { channel } : {}),
            ...(tag ? { tag } : {}),
            ...(status ? { leadStatus: status } : {}),
            ...(debouncedQ ? { search: debouncedQ } : {}),
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          },
        },
      });
      setSegmentName("");
      setSegmentMsg(t.contacts.segmentSaved.replace("{name}", name));
      await fetchSegments();
    } catch (e) {
      setSegmentMsg(e instanceof ApiError ? e.message : t.contacts.failedToSaveSegment);
    } finally {
      setSavingSegment(false);
    }
  };

  const deleteSegment = async (id: string) => {
    try {
      await api(`/api/contact-segments/${id}`, { method: "DELETE" });
      if (segmentId === id) setSegmentId("");
      await fetchSegments();
    } catch {
      setSegmentMsg(t.contacts.failedToDeleteSegment);
    }
  };

  const clearFilters = () => {
    setQ("");
    setStatus("");
    setChannel("");
    setTag("");
    setFrom("");
    setTo("");
    setSegmentId("");
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleSelectAll = () => {
    if (selected.size === items.length && items.length > 0) setSelected(new Set());
    else setSelected(new Set(items.map((c) => c.id)));
  };

  /* -------------------------------- add ------------------------------- */
  const buildPayload = (force: boolean) => ({
    name: form.name.trim(),
    channel: form.channel,
    ...(form.email.trim() ? { email: form.email.trim() } : {}),
    ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
    tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
    leadStatus: form.leadStatus,
    leadScore: Number(form.leadScore),
    notes: form.notes,
    ...(force ? { force: true } : {}),
  });

  const submitAdd = async (force = false) => {
    setFormError(null);
    setDuplicate(null);
    if (!form.name.trim()) {
      setFormError(t.contacts.nameRequired);
      return;
    }
    // Client-side possible-duplicate check on email.
    if (!force && form.email.trim()) {
      const match = items.find(
        (c) => c.email?.toLowerCase() === form.email.trim().toLowerCase(),
      );
      if (match) {
        setDuplicate({
          message: t.contacts.duplicateClient
            .replace("{name}", match.name)
            .replace("{email}", match.email ?? ""),
          force: false,
        });
        return;
      }
    }
    setSaving(true);
    try {
      await api("/api/contacts", { method: "POST", body: buildPayload(force) });
      setAddOpen(false);
      setForm(emptyForm);
      setDuplicate(null);
      void fetchContacts();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setDuplicate({
          message: t.contacts.duplicateServer,
          force: false,
        });
      } else {
        setFormError(e instanceof ApiError ? e.message : t.contacts.failedToCreateContact);
      }
    } finally {
      setSaving(false);
    }
  };

  /* ------------------------------- drawer ------------------------------ */
  const fetchTimeline = useCallback(async (contactId: string) => {
    setTimelineLoading(true);
    setTimelineError(null);
    setTimeline(null);
    try {
      const data = await api<{ items: TimelineItem[] }>(
        `/api/contacts/${contactId}/timeline`
      );
      setTimeline(data.items ?? []);
    } catch (e) {
      setTimelineError(e instanceof ApiError ? e.message : t.contacts.failedToLoadTimeline);
    } finally {
      setTimelineLoading(false);
    }
  }, [t]);

  const openDrawer = (c: Contact) => {
    setDrawer(c);
    setDrawerTab("details");
    setDrawerError(null);
    setDrawerMsg(null);
    setOrderLinks([]);
    setOrderInput("");
    setOrderError(null);
    void fetchOrders(c.id);
    setDrawerForm({
      name: c.name,
      email: c.email ?? "",
      phone: c.phone ?? "",
      channel: c.channel,
      leadStatus: c.leadStatus,
      leadScore: c.leadScore,
      tags: (c.tags ?? []).join(", "),
      notes: c.notes ?? "",
      customFields: JSON.stringify(normalizeCustomFields(c.customFields), null, 2),
    });
  };

  const switchDrawerTab = (tab: "details" | "timeline") => {
    setDrawerTab(tab);
    if (tab === "timeline" && drawer) void fetchTimeline(drawer.id);
  };

  // Stage 4e — linked orders for the drawer contact.
  const fetchOrders = useCallback(async (contactId: string) => {
    setOrdersLoading(true);
    setOrderError(null);
    try {
      const res = await api<{ orders: typeof orderLinks }>(
        `/api/ecommerce/orders?contactId=${encodeURIComponent(contactId)}`
      );
      setOrderLinks(res.orders ?? []);
    } catch (e) {
      setOrderError(e instanceof ApiError ? e.message : t.contacts.failedToLoadOrders);
    } finally {
      setOrdersLoading(false);
    }
  }, [t]);

  const linkOrder = async () => {
    if (!drawer || !orderInput.trim()) return;
    setOrderLinking(true);
    setOrderError(null);
    try {
      await api(`/api/contacts/${drawer.id}/orders`, {
        method: "POST",
        body: { orderId: orderInput.trim() },
      });
      setOrderInput("");
      await fetchOrders(drawer.id);
    } catch (e) {
      setOrderError(e instanceof ApiError ? e.message : t.contacts.failedToLinkOrder);
    } finally {
      setOrderLinking(false);
    }
  };

  const saveDrawer = async () => {
    if (!drawer) return;
    setDrawerError(null);
    setDrawerMsg(null);
    let customFields: Record<string, string> = {};
    try {
      const parsed = JSON.parse(drawerForm.customFields || "{}") as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(t.contacts.customFieldsJson);
      }
      customFields = parsed as Record<string, string>;
    } catch (e) {
      setDrawerError(e instanceof Error ? t.contacts.invalidJson.replace("{message}", e.message) : t.contacts.invalidJson.replace("{message}", ""));
      return;
    }
    setDrawerSaving(true);
    try {
      const updated = await api<Contact>(`/api/contacts/${drawer.id}`, {
        method: "PATCH",
        body: {
          name: drawerForm.name.trim(),
          email: drawerForm.email.trim() || undefined,
          phone: drawerForm.phone.trim() || undefined,
          channel: drawerForm.channel,
          leadStatus: drawerForm.leadStatus,
          leadScore: Number(drawerForm.leadScore),
          tags: drawerForm.tags.split(",").map((t) => t.trim()).filter(Boolean),
          notes: drawerForm.notes,
          customFields,
        },
      });
      setDrawer(updated);
      setDrawerMsg(t.contacts.contactSaved);
      void fetchContacts();
    } catch (e) {
      setDrawerError(e instanceof ApiError ? e.message : t.contacts.failedToSaveContact);
    } finally {
      setDrawerSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/contacts/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      setDrawer(null);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.id);
        return next;
      });
      void fetchContacts();
    } catch (e) {
      setDrawerError(e instanceof ApiError ? e.message : t.contacts.failedToDeleteContact);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  /* ------------------------------ bulk tag ----------------------------- */
  const applyBulkTag = async () => {
    const tagName = bulkTag.trim();
    if (!tagName || selected.size === 0) return;
    setBulkBusy(true);
    setBulkMsg(null);
    let ok = 0;
    let failed = 0;
    for (const id of selected) {
      const c = items.find((x) => x.id === id);
      const tags = Array.from(new Set([...(c?.tags ?? []), tagName]));
      try {
        await api(`/api/contacts/${id}`, { method: "PATCH", body: { tags } });
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setBulkMsg(
      failed === 0
        ? t.contacts.bulkApplied.replace("{tag}", tagName).replace("{count}", String(ok)).replace("{s}", ok === 1 ? "" : "s")
        : t.contacts.bulkPartial.replace("{ok}", String(ok)).replace("{failed}", String(failed)),
    );
    setBulkTag("");
    setSelected(new Set());
    setBulkBusy(false);
    void fetchContacts();
  };

  /* ------------------------------- import ------------------------------ */
  const runImport = async () => {
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const res = await api<ImportResult>("/api/contacts/import", {
        method: "POST",
        body: { csv },
      });
      setImportResult(res);
      void fetchContacts();
    } catch (e) {
      setImportError(e instanceof ApiError ? e.message : t.contacts.importFailed);
    } finally {
      setImporting(false);
    }
  };

  const runExport = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/contacts/export", { credentials: "include" });
      if (!res.ok) throw new Error(t.contacts.exportFailed.replace("{status}", String(res.status)));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "contacts.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.errorTitle);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={t.contacts.title}
        description={t.contacts.description}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" aria-hidden /> {t.contacts.import}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void runExport()} loading={exporting}>
              <Download className="h-4 w-4" aria-hidden /> {t.contacts.export}
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden /> {t.contacts.addContact}
            </Button>
          </>
        }
      />

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fp-text-2)]" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.contacts.searchPlaceholder} className="ps-9" aria-label={t.contacts.searchAria} />
        </div>
        <div className="w-40">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} options={LEAD_STATUSES.map((s) => ({ value: s, label: s }))} placeholder={t.contacts.allStatuses} aria-label={t.contacts.statusAria} />
        </div>
        <div className="w-40">
          <Select value={channel} onChange={(e) => setChannel(e.target.value)} options={CHANNELS.map((c) => ({ value: c, label: c }))} placeholder={t.contacts.allChannels} aria-label={t.contacts.channelAria} />
        </div>
        <div className="w-40">
          <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder={t.contacts.tagPlaceholder} aria-label={t.contacts.tagAria} />
        </div>
        <div className="w-36">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t.contacts.fromDate} title={t.contacts.fromDate} />
        </div>
        <div className="w-36">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t.contacts.toDate} title={t.contacts.toDate} />
        </div>
        <Button size="sm" variant="ghost" onClick={clearFilters}>{t.contacts.clear}</Button>
      </div>

      {/* Segments */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="w-52">
          <Select
            value={segmentId}
            onChange={(e) => applySegment(e.target.value)}
            options={segments.map((s) => ({ value: s.id, label: s.name }))}
            placeholder={t.contacts.savedSegments}
            aria-label={t.contacts.applySegmentAria}
          />
        </div>
        {segmentId && (
          <Button size="sm" variant="ghost" onClick={() => void deleteSegment(segmentId)} aria-label={t.contacts.deleteSegmentAria}>
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        )}
        <div className="flex items-center gap-2">
          <Input
            value={segmentName}
            onChange={(e) => setSegmentName(e.target.value)}
            placeholder={t.contacts.segmentNamePlaceholder}
            className="w-44"
            aria-label={t.contacts.segmentNameAria}
          />
          <Button size="sm" variant="secondary" onClick={() => void saveSegment()} loading={savingSegment} disabled={!segmentName.trim()}>
            {t.contacts.saveFilters}
          </Button>
        </div>
        {segmentMsg && <span className="text-xs text-[var(--fp-text-2)]">{segmentMsg}</span>}
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-[#8B5CF6]/30 bg-[#8B5CF6]/10 px-4 py-2.5">
          <span className="text-sm text-[var(--fp-text)]">{t.contacts.selectedCount.replace("{count}", String(selected.size))}</span>
          <Input value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} placeholder={t.contacts.bulkTagPlaceholder} className="w-48" aria-label={t.contacts.bulkTagAria} />
          <Button size="sm" variant="secondary" onClick={() => void applyBulkTag()} loading={bulkBusy} disabled={!bulkTag.trim()}>
            <TagIcon className="h-4 w-4" aria-hidden /> {t.contacts.applyTag}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{t.contacts.clear}</Button>
          {bulkMsg && <span className="text-xs text-[var(--fp-text-2)]">{bulkMsg}</span>}
        </div>
      )}

      {error && <p className="mb-4 rounded-lg border border-[#FB7185]/30 bg-[#FB7185]/10 px-4 py-2 text-sm text-[#FB7185]" role="alert">{error}</p>}

      {/* Table */}
      <div className="overflow-x-auto rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)]">
        {loading ? (
          <Spinner label={t.contacts.loadingContacts} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Users}
            title={t.contacts.noContacts}
            description={t.contacts.noContactsHint}
            action={<Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" aria-hidden /> {t.contacts.addContact}</Button>}
          />
        ) : (
          <table className="w-full min-w-[760px] text-start text-sm">
            <thead>
              <tr className="border-b border-[var(--fp-border)] text-xs uppercase tracking-wide text-[var(--fp-text-2)]">
                <th className="px-4 py-3">
                  <input type="checkbox" checked={selected.size === items.length && items.length > 0} onChange={toggleSelectAll} className="h-4 w-4 accent-[#8B5CF6]" aria-label={t.contacts.selectAll} />
                </th>
                <th className="px-4 py-3">{t.contacts.colName}</th>
                <th className="px-4 py-3">{t.contacts.colChannel}</th>
                <th className="px-4 py-3">{t.contacts.colStatus}</th>
                <th className="px-4 py-3">{t.contacts.colScore}</th>
                <th className="px-4 py-3">{t.contacts.colTags}</th>
                <th className="px-4 py-3">{t.contacts.colLastSeen}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className="cursor-pointer border-b border-[var(--fp-border)] last:border-0 hover:bg-[var(--fp-bg-2)]" onClick={() => openDrawer(c)}>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} className="h-4 w-4 accent-[#8B5CF6]" aria-label={t.contacts.selectContact.replace("{name}", c.name)} />
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-[var(--fp-text)]">{c.name}</p>
                    {c.email && <p className="text-xs text-[var(--fp-text-2)]">{c.email}</p>}
                  </td>
                  <td className="px-4 py-3"><Badge tone="cyan">{c.channel}</Badge></td>
                  <td className="px-4 py-3"><Badge tone={leadTone(c.leadStatus)}>{c.leadStatus}</Badge></td>
                  <td className="px-4 py-3">
                    <div className="flex w-24 items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--fp-bg-2)]">
                        <div className="h-full rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]" style={{ width: `${c.leadScore}%` }} />
                      </div>
                      <span className="text-xs text-[var(--fp-text-2)]">{c.leadScore}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex max-w-[180px] flex-wrap gap-1">
                      {(c.tags ?? []).slice(0, 3).map((t) => (
                        <span key={t} className="rounded-full bg-[var(--fp-bg-2)] px-2 py-0.5 text-[11px] text-[var(--fp-text-2)]">{t}</span>
                      ))}
                      {(c.tags ?? []).length > 3 && <span className="text-[11px] text-[var(--fp-text-2)]">+{(c.tags ?? []).length - 3}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--fp-text-2)]">{timeAgo(c.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between text-sm text-[var(--fp-text-2)]">
        <span>{total === 1 ? t.contacts.totalContactsOne : t.contacts.totalContacts.replace("{count}", formatInt(locale, total))}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden /> {t.contacts.prev}
          </Button>
          <span>{t.contacts.page.replace("{page}", String(page))}</span>
          <Button size="sm" variant="secondary" onClick={() => setPage((p) => p + 1)} disabled={items.length === 0}>
            {t.contacts.next} <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
          </Button>
        </div>
      </div>

      {/* ------------------------------ Import batches (Wave 2B, additive) ------------------------------ */}
      <section className="mt-6 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--fp-text)]">Import batches</h2>
          <a href="/app/contacts/import" className="text-sm font-medium text-[#8B5CF6] hover:underline">Open import batches →</a>
        </div>
        <p className="mb-3 text-xs text-[var(--fp-text-2)]">
          Preview → resolve duplicates explicitly → confirm. Duplicates are never silently merged, and
          suppressions survive re-import.
        </p>
        {importBatches.length === 0 ? (
          <p className="text-sm text-[var(--fp-text-2)]">No batches yet.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {importBatches.slice(0, 5).map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2">
                <a href="/app/contacts/import" className="font-medium text-[var(--fp-text)] hover:underline">{b.filename}</a>
                <Badge tone={b.status === "CONFIRMED" ? "green" : "cyan"}>{b.status}</Badge>
                <span className="text-xs text-[var(--fp-text-2)]">
                  {b.totalRows} rows · {b.importedCount} imported · {b.skippedCount} skipped · {b.failedCount} failed
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------ Add modal ------------------------------ */}
      <Modal open={addOpen} onClose={() => { setAddOpen(false); setDuplicate(null); setFormError(null); }} title={t.contacts.addContactTitle}>
        <div className="space-y-3">
          <Input label={t.contacts.nameLabel} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t.contacts.namePlaceholder} />
          <div className="grid grid-cols-2 gap-3">
            <Select label={t.contacts.channelLabel} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} options={CHANNELS.map((c) => ({ value: c, label: c }))} />
            <Select label={t.contacts.leadStatusLabel} value={form.leadStatus} onChange={(e) => setForm({ ...form, leadStatus: e.target.value })} options={LEAD_STATUSES.map((s) => ({ value: s, label: s }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label={t.auth.emailLabel} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={t.contacts.emailPlaceholder} />
            <Input label={t.auth.phoneLabel} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={t.contacts.phonePlaceholder} />
          </div>
          <Input label={t.contacts.tagsLabel} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder={t.contacts.tagsPlaceholder} />
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--fp-text)]">{t.contacts.leadScoreLabel}: {form.leadScore}</label>
            <input type="range" min={0} max={100} value={form.leadScore} onChange={(e) => setForm({ ...form, leadScore: Number(e.target.value) })} className="w-full accent-[#8B5CF6]" aria-label={t.contacts.leadScoreLabel} />
          </div>
          <Textarea label={t.inbox.notes} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} />

          {duplicate && (
            <div className="rounded-lg border border-[#FBBF24]/30 bg-[#FBBF24]/10 p-3 text-sm" role="alert">
              <p className="font-semibold text-[#FBBF24]">{t.contacts.duplicateTitle}</p>
              <p className="mt-1 text-[var(--fp-text-2)]">{duplicate.message}</p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => void submitAdd(true)} loading={saving}>{t.contacts.saveAnyway}</Button>
                <Button size="sm" variant="ghost" onClick={() => setDuplicate(null)}>{t.contacts.back}</Button>
              </div>
            </div>
          )}
          {formError && <p className="text-sm text-[#FB7185]" role="alert">{formError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setAddOpen(false)}>{t.common.cancel}</Button>
            <Button onClick={() => void submitAdd(false)} loading={saving} disabled={!!duplicate}>{t.contacts.createContact}</Button>
          </div>
        </div>
      </Modal>

      {/* ------------------------------ Detail drawer ------------------------------ */}
      {drawer && (
        <div className="fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrawer(null)} />
          <aside className="absolute end-0 top-0 flex h-full w-full max-w-md flex-col overflow-y-auto border-s border-[var(--fp-border)] bg-[var(--fp-card)] p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--fp-text)]">{drawer.name}</h2>
              <button onClick={() => setDrawer(null)} aria-label={t.contacts.closeDetails} className="rounded-lg p-1.5 text-[var(--fp-text-2)] hover:bg-[var(--fp-bg-2)]">
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            {/* Tabs */}
            <div className="mb-4 flex gap-1 rounded-xl bg-[var(--fp-bg-2)] p-1" role="tablist" aria-label={t.contacts.closeDetails}>
              {(["details", "timeline"] as const).map((tb) => (
                <button
                  key={tb}
                  role="tab"
                  aria-selected={drawerTab === tb}
                  onClick={() => switchDrawerTab(tb)}
                  className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    drawerTab === tb
                      ? "bg-[var(--fp-card)] text-[var(--fp-text)] shadow"
                      : "text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
                  }`}
                >
                  {tb === "details" ? t.contacts.details : t.contacts.timeline}
                </button>
              ))}
            </div>
            {drawerTab === "details" ? (
            <div className="space-y-3">
              <Input label={t.auth.nameLabel} value={drawerForm.name} onChange={(e) => setDrawerForm({ ...drawerForm, name: e.target.value })} />
              <div className="grid grid-cols-2 gap-3">
                <Input label={t.auth.emailLabel} value={drawerForm.email} onChange={(e) => setDrawerForm({ ...drawerForm, email: e.target.value })} />
                <Input label={t.auth.phoneLabel} value={drawerForm.phone} onChange={(e) => setDrawerForm({ ...drawerForm, phone: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Select label={t.contacts.channelLabel} value={drawerForm.channel} onChange={(e) => setDrawerForm({ ...drawerForm, channel: e.target.value })} options={CHANNELS.map((c) => ({ value: c, label: c }))} />
                <Select label={t.contacts.leadStatusLabel} value={drawerForm.leadStatus} onChange={(e) => setDrawerForm({ ...drawerForm, leadStatus: e.target.value })} options={LEAD_STATUSES.map((s) => ({ value: s, label: s }))} />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--fp-text)]">{t.contacts.leadScoreLabel}: {drawerForm.leadScore}</label>
                <input type="range" min={0} max={100} value={drawerForm.leadScore} onChange={(e) => setDrawerForm({ ...drawerForm, leadScore: Number(e.target.value) })} className="w-full accent-[#8B5CF6]" aria-label={t.contacts.leadScoreLabel} />
              </div>
              <Input label={t.contacts.tagsLabel} value={drawerForm.tags} onChange={(e) => setDrawerForm({ ...drawerForm, tags: e.target.value })} />
              <Textarea label={t.inbox.notes} value={drawerForm.notes} onChange={(e) => setDrawerForm({ ...drawerForm, notes: e.target.value })} rows={3} />
              <Textarea label={t.contacts.customFieldsLabel} value={drawerForm.customFields} onChange={(e) => setDrawerForm({ ...drawerForm, customFields: e.target.value })} rows={4} hint={t.contacts.customFieldsHint} />
              {drawerError && <p className="text-sm text-[#FB7185]" role="alert">{drawerError}</p>}
              {drawerMsg && <p className="text-sm text-[#34D399]">{drawerMsg}</p>}
              <div className="flex gap-2">
                <Button onClick={() => void saveDrawer()} loading={drawerSaving} className="flex-1">{t.contacts.saveChanges}</Button>
                <Button variant="danger" onClick={() => setDeleteTarget(drawer)} aria-label={t.contacts.deleteContact}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <p className="rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3 text-xs text-[var(--fp-text-2)]">
                {t.contacts.inboxHint}
              </p>

              {/* Stage 4e — linked e-commerce orders */}
              <div className="rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)]">
                <div className="border-b border-[var(--fp-border)] px-4 py-2.5">
                  <h3 className="text-sm font-semibold text-[var(--fp-text)]">{t.contacts.orders}</h3>
                  <p className="text-xs text-[var(--fp-text-2)]">{t.contacts.ordersHint}</p>
                </div>
                <div className="space-y-3 px-4 py-3">
                  {ordersLoading ? (
                    <Spinner label={t.contacts.loadingOrders} />
                  ) : orderError ? (
                    <p className="text-sm text-[#FB7185]" role="alert">{orderError}</p>
                  ) : orderLinks.length === 0 ? (
                    <p className="text-sm text-[var(--fp-text-2)]">{t.contacts.noOrders}</p>
                  ) : (
                    <ul className="space-y-2">
                      {orderLinks.map(({ link, order }) => (
                        <li key={link.orderId} className="rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium text-[var(--fp-text)]">{link.orderId}</span>
                            {order?.verified ? (
                              <Badge tone="green">{t.contacts.verified}</Badge>
                            ) : (
                              <Badge tone="amber">DEMO</Badge>
                            )}
                            {order && <Badge tone="cyan">{order.status}</Badge>}
                          </div>
                          {order && (
                            <p className="mt-1 text-xs text-[var(--fp-text-2)]">
                              {order.total.toLocaleString(undefined, { style: "currency", currency: order.currency })}
                              {" · "}{t.contacts.linkedAt.replace("{date}", new Date(link.linkedAt).toLocaleDateString(locale === "ar" ? "ar-EG" : "en-US"))}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <Input
                      placeholder={t.contacts.orderPlaceholder}
                      value={orderInput}
                      onChange={(e) => setOrderInput(e.target.value)}
                      aria-label={t.contacts.orderAria}
                    />
                    <Button size="sm" onClick={() => void linkOrder()} loading={orderLinking} disabled={!orderInput.trim()}>
                      {t.contacts.link}
                    </Button>
                  </div>
                  <p className="text-xs text-[var(--fp-text-2)]">
                    {t.contacts.demoOrderNote}
                  </p>
                </div>
              </div>
            </div>
            ) : (
            <div>
              {timelineLoading ? (
                <Spinner label={t.contacts.loadingTimeline} />
              ) : timelineError ? (
                <p className="rounded-lg border border-[#FB7185]/30 bg-[#FB7185]/10 px-4 py-2 text-sm text-[#FB7185]" role="alert">{timelineError}</p>
              ) : !timeline || timeline.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title={t.contacts.noActivity}
                  description={t.contacts.noActivityHint}
                />
              ) : (
                <ol className="relative space-y-4 border-s border-[var(--fp-border)] ps-5">
                  {timeline.map((item, i) => (
                    <li key={i} className="relative">
                      <span className="absolute -start-[26px] top-1 h-2.5 w-2.5 rounded-full bg-[#8B5CF6]" aria-hidden />
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={itemTypeTone(item.type)}>{itemTypeLabel(item.type)}</Badge>
                        {item.channel && <Badge tone="cyan">{item.channel}</Badge>}
                        {item.real ? (
                          <Badge tone="green">real</Badge>
                        ) : (
                          <Badge tone="amber">demo / mock</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-[var(--fp-text)]">{item.summary}</p>
                      <p className="text-xs text-[var(--fp-text-2)]">
                        {formatDateTime(locale, item.at)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            )}
          </aside>
        </div>
      )}

      {/* ------------------------------ Delete confirm ------------------------------ */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title={t.contacts.deleteContactTitle}>
        <p className="text-sm text-[var(--fp-text-2)]">
          {t.contacts.deleteConfirm.replace("{name}", deleteTarget?.name ?? "")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleteTarget(null)}>{t.common.cancel}</Button>
          <Button variant="danger" onClick={() => void confirmDelete()} loading={deleting}>{t.common.delete}</Button>
        </div>
      </Modal>

      {/* ------------------------------ Import modal ------------------------------ */}
      <Modal open={importOpen} onClose={() => { setImportOpen(false); setImportResult(null); setImportError(null); }} title={t.contacts.importTitle}>
        <div className="space-y-3">
          <Textarea label={t.contacts.csvData} value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} hint={t.contacts.csvHint} />
          {importError && <p className="text-sm text-[#FB7185]" role="alert">{importError}</p>}
          {importResult && (
            <div className="rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-3 text-sm">
              <p className="text-[var(--fp-text)]">{t.contacts.imported} <span className="font-bold text-[#34D399]">{importResult.imported}</span> · {t.contacts.skipped} <span className="font-bold text-[#FBBF24]">{importResult.skipped}</span></p>
              {importResult.errors.length > 0 && (
                <ul className="mt-2 list-disc ps-5 text-xs text-[#FB7185]">
                  {importResult.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setImportOpen(false)}>{t.contacts.close}</Button>
            <Button onClick={() => void runImport()} loading={importing}><Upload className="h-4 w-4" aria-hidden /> {t.contacts.import}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
