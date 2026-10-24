"use client";

import { useEffect } from "react";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-slate-500/15 text-slate-300 border-slate-400/30",
  PUBLISHED: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
  PAUSED: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  QUEUED: "bg-sky-500/15 text-sky-300 border-sky-400/30",
  RUNNING: "bg-sky-500/15 text-sky-300 border-sky-400/30",
  SUCCEEDED: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
  DRY_RUN: "bg-violet-500/15 text-violet-300 border-violet-400/30",
  FAILED: "bg-red-500/15 text-red-300 border-red-400/30",
  DEAD_LETTER: "bg-red-500/20 text-red-200 border-red-400/40",
  SKIPPED: "bg-slate-500/15 text-slate-400 border-slate-400/30",
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.DRAFT;
  const label = status.replace(/_/g, " ");
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {label}
    </span>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-[var(--fp-text-2)] hover:bg-white/5 hover:text-[var(--fp-text)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-red-400">{message}</p>;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}
