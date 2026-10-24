"use client";

import { useMemo, useState } from "react";
import { Search, type LucideIcon } from "lucide-react";
import { NODE_TYPES, type NodeDef } from "@/lib/workflows/nodeRegistry";

// Re-exported icon map (shared with canvas) — resolved locally to keep
// this component self-contained.
import {
  MessageSquare, MessageCircle, MessagesSquare, UserPlus, Hash, Tag, Tags, Clock,
  Webhook, ShoppingCart, Play, Quote, Sparkles, Gauge, Filter, CalendarClock,
  Brain, BadgeCheck, Send, Reply, Bot, PenLine, UserCheck, StickyNote, Timer, Mail,
  MessageSquareText, Bell, ShieldCheck, Ban, GitBranch, Hourglass, RotateCcw,
  AlarmClock, Fingerprint, TriangleAlert, Flag, Box,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  MessageSquare, MessageCircle, MessagesSquare, UserPlus, Hash, Tag, Tags, Clock,
  Webhook, ShoppingCart, Play, Quote, Sparkles, Gauge, Filter, CalendarClock,
  Brain, BadgeCheck, Send, Reply, Bot, PenLine, UserCheck, StickyNote, Timer, Mail,
  MessageSquareText, Bell, ShieldCheck, Ban, GitBranch, Hourglass, RotateCcw,
  AlarmClock, Fingerprint, TriangleAlert, Flag, Box,
};

function iconFor(name: string): LucideIcon {
  return ICONS[name] ?? Box;
}

/** Display order for palette categories. */
const CATEGORY_ORDER = [
  "Triggers",
  "Conditions",
  "Messaging",
  "CRM",
  "Team",
  "Flow control",
  "Integrations",
];

interface PaletteProps {
  searchPlaceholder: string;
  hint: string;
  onAdd: (type: string) => void;
}

export function NodePalette({ searchPlaceholder, hint, onAdd }: PaletteProps) {
  const [filter, setFilter] = useState("");

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = Object.values(NODE_TYPES).filter(
      (d) => !q || `${d.label} ${d.type} ${d.description} ${d.category}`.toLowerCase().includes(q)
    );
    const byCat = new Map<string, NodeDef[]>();
    for (const d of all) {
      if (!byCat.has(d.category)) byCat.set(d.category, []);
      byCat.get(d.category)!.push(d);
    }
    return CATEGORY_ORDER.filter((c) => byCat.has(c)).map((c) => ({
      category: c,
      defs: byCat.get(c)!,
    }));
  }, [filter]);

  return (
    <aside
      className="flex w-60 shrink-0 flex-col overflow-hidden border-e border-[var(--fp-border)] bg-[var(--fp-card)]"
      aria-label="Node library"
    >
      <div className="p-3 pb-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-[var(--fp-text-2)]" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="w-full rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg)] py-1.5 pe-2.5 ps-8 text-sm outline-none placeholder:text-[var(--fp-text-2)] focus:border-[var(--fp-accent)]"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 pt-1">
        {groups.map(({ category, defs }) => (
          <div key={category} className="mb-4">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--fp-text-2)]">
              {category}
            </p>
            <div className="space-y-1.5">
              {defs.map((d) => {
                const Icon = iconFor(d.icon);
                return (
                  <div
                    key={d.type}
                    role="button"
                    tabIndex={0}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/flowpilot-node", d.type);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => onAdd(d.type)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onAdd(d.type);
                      }
                    }}
                    title={d.description}
                    aria-label={`Add ${d.label}`}
                    className="flex cursor-grab items-center gap-2 rounded-lg border border-[var(--fp-border)] bg-[var(--fp-bg)] px-2.5 py-2 text-sm hover:border-[var(--fp-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--fp-accent)] active:cursor-grabbing"
                  >
                    <Icon size={15} className="shrink-0 opacity-70" aria-hidden />
                    <span className="truncate">{d.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <p className="text-sm text-[var(--fp-text-2)]">No nodes match.</p>
        )}
        <p className="mt-2 text-xs text-[var(--fp-text-2)]">{hint}</p>
      </div>
    </aside>
  );
}
