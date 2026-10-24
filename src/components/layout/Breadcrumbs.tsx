"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${item.label}-${i}`} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-[var(--fp-text-2)] rtl:rotate-180" aria-hidden />}
            {item.href && !last ? (
              <Link
                href={item.href}
                className="text-[var(--fp-text-2)] hover:text-[var(--fp-text)] transition-colors"
              >
                {item.label}
              </Link>
            ) : (
              <span className={last ? "text-[var(--fp-text)] font-medium" : "text-[var(--fp-text-2)]"}>
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
