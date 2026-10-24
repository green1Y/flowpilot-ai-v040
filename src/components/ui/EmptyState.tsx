"use client";

import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-6">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--fp-bg-2)] border border-[var(--fp-border)] mb-4">
        <Icon className="h-6 w-6 text-[var(--fp-text-2)]" aria-hidden />
      </div>
      <h3 className="text-sm font-semibold text-[var(--fp-text)]">{title}</h3>
      {description && <p className="mt-1.5 text-sm text-[var(--fp-text-2)] max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
