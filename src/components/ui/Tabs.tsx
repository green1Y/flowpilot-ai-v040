"use client";

import type { LucideIcon } from "lucide-react";
import { useRef } from "react";

export interface TabItem {
  id: string;
  label: string;
  icon?: LucideIcon;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name for the tablist. Defaults to "Sections". */
  ariaLabel?: string;
}

export function Tabs({ tabs, value, onChange, ariaLabel = "Sections" }: TabsProps) {
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTab = (index: number) => {
    const btn = btnRefs.current[index];
    btn?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = tabs.findIndex((t) => t.id === value);
    if (idx === -1) return;
    // In RTL, ArrowLeft advances and ArrowRight goes back (mirrors visual order).
    const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
    const fwd = rtl ? "ArrowLeft" : "ArrowRight";
    const back = rtl ? "ArrowRight" : "ArrowLeft";
    let next: number | null = null;
    if (e.key === fwd) next = (idx + 1) % tabs.length;
    else if (e.key === back) next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next !== null) {
      e.preventDefault();
      onChange(tabs[next].id);
      focusTab(next);
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-xl bg-[var(--fp-bg-2)] border border-[var(--fp-border)] p-1"
    >
      {tabs.map((t, i) => {
        const active = t.id === value;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-all ${
              active
                ? "btn-gradient text-white shadow-glow"
                : "text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
            }`}
          >
            {Icon && <Icon className="h-4 w-4" aria-hidden />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
