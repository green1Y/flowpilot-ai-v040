"use client";

import type { HTMLAttributes } from "react";

export type BadgeTone = "violet" | "cyan" | "green" | "amber" | "red" | "gray" | "blue";

const tones: Record<BadgeTone, string> = {
  violet:
    "bg-[var(--fp-tone-violet-bg)] text-[var(--fp-tone-violet-text)] border-[var(--fp-tone-violet-border)]",
  cyan: "bg-[var(--fp-tone-cyan-bg)] text-[var(--fp-tone-cyan-text)] border-[var(--fp-tone-cyan-border)]",
  green:
    "bg-[var(--fp-tone-green-bg)] text-[var(--fp-tone-green-text)] border-[var(--fp-tone-green-border)]",
  amber:
    "bg-[var(--fp-tone-amber-bg)] text-[var(--fp-tone-amber-text)] border-[var(--fp-tone-amber-border)]",
  red: "bg-[var(--fp-tone-red-bg)] text-[var(--fp-tone-red-text)] border-[var(--fp-tone-red-border)]",
  blue: "bg-[var(--fp-tone-blue-bg)] text-[var(--fp-tone-blue-text)] border-[var(--fp-tone-blue-border)]",
  gray: "bg-[var(--fp-bg-2)] text-[var(--fp-text-2)] border-[var(--fp-border)]",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "gray", className = "", children, ...rest }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${tones[tone]} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
