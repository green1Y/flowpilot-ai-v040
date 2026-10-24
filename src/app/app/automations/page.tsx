"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge, Modal, formatDateTime } from "./components";

interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  updatedAt: string;
  runCount: number;
  nodeCount: number;
}

const TABS = ["All", "Draft", "Published", "Paused"] as const;

export default function AutomationsPage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<(typeof TABS)[number]>("All");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<WorkflowSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (tab !== "All") params.set("status", tab.toUpperCase());
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/workflows?${params.toString()}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Failed to load workflows");
      setWorkflows(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load workflows");
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function mutate(id: string, action: "publish" | "pause" | "duplicate") {
    setBusy(`${action}:${id}`);
    setError("");
    try {
      const res = await fetch(`/api/workflows/${id}/${action}`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) {
        const detail = json.errors ? `: ${json.errors.map((e: { message: string }) => e.message).join("; ")}` : "";
        throw new Error(`${json.error ?? "Action failed"}${detail}`);
      }
      if (action === "duplicate") {
        router.push(`/app/automations/${json.data.id}`);
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(`delete:${deleting.id}`);
    try {
      const res = await fetch(`/api/workflows/${deleting.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Delete failed");
      setDeleting(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <nav className="mb-4 text-sm text-[var(--fp-text-2)]">
        <span className="text-[var(--fp-text)] font-medium">Automations</span>
      </nav>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Workflows</h1>
          <p className="text-sm text-[var(--fp-text-2)]">Automate conversations, leads and follow-ups across channels.</p>
        </div>
        <Link
          href="/app/automations/new"
          className="btn-gradient rounded-xl px-4 py-2 text-sm font-semibold text-white"
        >
          + New workflow
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                tab === t ? "bg-[var(--fp-accent)] text-white" : "text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search workflows…"
          className="w-64 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] px-3 py-2 text-sm outline-none placeholder:text-[var(--fp-text-2)] focus:border-[var(--fp-accent)]"
        />
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[var(--fp-text-2)]">Loading workflows…</p>
      ) : workflows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--fp-border)] bg-[var(--fp-card)] p-12 text-center">
          <p className="text-lg font-medium">No workflows yet</p>
          <p className="mt-1 text-sm text-[var(--fp-text-2)]">Start from a template and publish your first automation in minutes.</p>
          <Link href="/app/automations/new" className="btn-gradient mt-4 inline-block rounded-xl px-4 py-2 text-sm font-semibold text-white">
            Browse templates
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {workflows.map((w) => (
            <div key={w.id} className="flex flex-col rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-5">
              <div className="mb-2 flex items-start justify-between gap-2">
                <Link href={`/app/automations/${w.id}`} className="font-semibold hover:text-[var(--fp-accent-2)]">
                  {w.name}
                </Link>
                <StatusBadge status={w.status} />
              </div>
              {w.description && <p className="mb-3 line-clamp-2 text-sm text-[var(--fp-text-2)]">{w.description}</p>}
              <div className="mb-4 flex gap-4 text-xs text-[var(--fp-text-2)]">
                <span>{w.runCount} run{w.runCount === 1 ? "" : "s"}</span>
                <span>{w.nodeCount} nodes</span>
                <span>v{w.version}</span>
                <span>Updated {formatDateTime(w.updatedAt)}</span>
              </div>
              <div className="mt-auto flex flex-wrap gap-2 border-t border-[var(--fp-border)] pt-3">
                <Link href={`/app/automations/${w.id}`} className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10">
                  Open builder
                </Link>
                <Link href={`/app/automations/${w.id}/executions`} className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10">
                  Runs
                </Link>
                {w.status !== "PUBLISHED" && (
                  <button
                    disabled={busy === `publish:${w.id}`}
                    onClick={() => mutate(w.id, "publish")}
                    className="rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
                  >
                    Publish
                  </button>
                )}
                {w.status === "PUBLISHED" && (
                  <button
                    disabled={busy === `pause:${w.id}`}
                    onClick={() => mutate(w.id, "pause")}
                    className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
                  >
                    Pause
                  </button>
                )}
                <button
                  disabled={busy === `duplicate:${w.id}`}
                  onClick={() => mutate(w.id, "duplicate")}
                  className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10 disabled:opacity-50"
                >
                  Duplicate
                </button>
                <button
                  onClick={() => setDeleting(w)}
                  className="rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleting && (
        <Modal title="Delete workflow" onClose={() => setDeleting(null)}>
          <p className="text-sm text-[var(--fp-text-2)]">
            Delete <span className="font-semibold text-[var(--fp-text)]">{deleting.name}</span>? Its nodes,
            edges and run history will be removed. This cannot be undone.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <button onClick={() => setDeleting(null)} className="rounded-xl bg-white/5 px-4 py-2 text-sm font-medium hover:bg-white/10">
              Cancel
            </button>
            <button
              onClick={confirmDelete}
              disabled={busy === `delete:${deleting.id}`}
              className="rounded-xl bg-red-500/80 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            >
              Delete workflow
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
