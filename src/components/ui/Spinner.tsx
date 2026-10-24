"use client";

import { Loader2 } from "lucide-react";

export function Spinner({ label, className = "" }: { label?: string; className?: string }) {
  return (
    <div
      className={`flex items-center justify-center gap-2 text-[var(--fp-text-2)] ${className}`}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-5 w-5 animate-spin text-[var(--fp-accent)]" aria-hidden />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

/** Full-page loading state used by the app shell. */
export function PageSpinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[var(--fp-bg)]">
      <Spinner label={label} />
    </div>
  );
}

/** Skeleton card used while dashboard sections load. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-2xl bg-[var(--fp-card)] border border-[var(--fp-border)] ${className}`} aria-hidden />;
}
