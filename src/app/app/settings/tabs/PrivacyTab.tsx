"use client";

/**
 * Settings · Privacy & Security section.
 * JSON data export (GET /api/workspace/export), deletion request
 * (POST /api/workspace/deletion-request, OWNER only), retention note,
 * links to the working /privacy and /terms pages, and recent
 * security-relevant audit events (GET /api/audit).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError, useWorkspaces } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { ArrowUpRight, Download, ShieldAlert } from "lucide-react";
import { Msg, type SettingsDict } from "../ui";

interface AuditEvent {
  id: string;
  action: string;
  actor: { id: string; name: string; email: string } | null;
  createdAt: string;
}

const SECURITY_PREFIXES = ["auth", "team", "integration", "workspace", "user"];

function isSecurityEvent(action: string) {
  return SECURITY_PREFIXES.some((p) => action === p || action.startsWith(`${p}.`));
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function PrivacyTab({ t }: { t: SettingsDict }) {
  const s = t.security;
  const { current } = useWorkspaces();
  const isOwner = current?.role === "OWNER";
  const canExport = current && ["OWNER", "ADMIN", "MANAGER"].includes(current.role ?? "");

  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await api<{ events: AuditEvent[] }>("/api/audit?limit=50");
      setEvents((raw.events ?? []).filter((e) => isSecurityEvent(e.action)));
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  const downloadExport = async () => {
    setExporting(true);
    setExportMsg(null);
    try {
      const res = await fetch("/api/workspace/export", { credentials: "include" });
      if (!res.ok) throw new Error(`Export failed (status ${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `flowpilot-workspace-export.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportMsg(s.exported);
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : t.common.retry);
    } finally {
      setExporting(false);
    }
  };

  const requestDeletion = async () => {
    setDeleting(true);
    setDeleteMsg(null);
    try {
      const raw = await api<{ message: string }>("/api/workspace/deletion-request", {
        method: "POST",
        body: { reason: reason.trim() || undefined },
      });
      setDeleteMsg(raw.message ?? s.deletionDone);
      setConfirm("");
      setReason("");
    } catch (e) {
      setDeleteMsg(e instanceof ApiError ? e.message : t.common.retry);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{s.export}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-[var(--fp-text-2)]">{s.exportHint}</p>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="secondary" onClick={() => void downloadExport()} loading={exporting} disabled={!canExport}>
              <Download className="h-4 w-4" /> {s.exportBtn}
            </Button>
            <Msg text={exportMsg} tone="info" />
            {!canExport && <span className="text-xs text-[var(--fp-text-2)]">{t.common.noAccess}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{s.retention}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-[var(--fp-text-2)]">{s.retentionText}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{s.policies}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="mb-1 text-sm text-[var(--fp-text-2)]">{s.policiesHint}</p>
          {[
            { href: "/privacy", label: s.privacyPolicy },
            { href: "/terms", label: s.termsOfService },
          ].map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="flex items-center justify-between gap-2 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] px-4 py-3 text-sm font-medium text-[var(--fp-text)] transition-colors hover:border-[var(--fp-accent)]"
            >
              {l.label}
              <ArrowUpRight className="h-4 w-4 text-[var(--fp-text-2)]" aria-hidden />
            </Link>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{s.recentSecurity}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-[var(--fp-text-2)]">{s.recentSecurityHint}</p>
          {loading ? (
            <Spinner label={t.common.loading} className="py-4" />
          ) : events.length === 0 ? (
            <p className="text-sm text-[var(--fp-text-2)]">{s.noSecurity}</p>
          ) : (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {events.map((e) => (
                <li key={e.id} className="flex items-baseline gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--fp-bg-2)]">
                  <span className="shrink-0 font-mono text-xs text-[var(--fp-text-2)]">{fmtDate(e.createdAt)}</span>
                  <span className="font-medium text-[var(--fp-text)]">{e.action}</span>
                  <span className="truncate text-xs text-[var(--fp-text-2)]">
                    {e.actor ? `${e.actor.name} <${e.actor.email}>` : "system"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="border-[#FB7185]/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[#FB7185]">
            <ShieldAlert className="h-4 w-4" /> {s.deletion}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-[var(--fp-text-2)]">{s.deletionHint}</p>
          {isOwner ? (
            <>
              <Input
                label={s.deletionReason}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="…"
              />
              <Input
                label={s.deletionConfirm}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="DELETE"
              />
              <p className="text-xs text-[var(--fp-text-2)]">{s.deletionConfirmHint}</p>
              <div className="flex items-center gap-3">
                <Button variant="danger" size="sm" onClick={() => void requestDeletion()} loading={deleting} disabled={confirm.trim() !== "DELETE"}>
                  {s.deletionBtn}
                </Button>
                <Msg text={deleteMsg} tone="info" />
              </div>
            </>
          ) : (
            <p className="text-xs text-[var(--fp-text-2)]">{t.common.noAccess}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
