"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useLocale } from "@/i18n/client";
import { seoAr, seoEn } from "@/i18n/fragments/seo";

export default function FaqAccordion() {
  const locale = useLocale();
  const seo = (locale === "ar" ? seoAr : seoEn).seo;
  const p = seo.pages.faq;
  const l = seo.landing;
  const items = [
    { q: l.faq1q, a: l.faq1a },
    { q: l.faq2q, a: l.faq2a },
    { q: l.faq3q, a: l.faq3a },
    { q: l.faq4q, a: l.faq4a },
    { q: l.faq5q, a: l.faq5a },
    { q: l.faq6q, a: l.faq6a },
    { q: p.q7, a: p.a7 },
    { q: p.q8, a: p.a8 },
    { q: p.q9, a: p.a9 },
    { q: p.q10, a: p.a10 },
  ];
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="border-t border-[var(--fp-border)] py-14 sm:py-20">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <div className="space-y-3">
          {items.map((f, i) => {
            const isOpen = open === i;
            return (
              <div
                key={f.q}
                className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] overflow-hidden"
              >
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left"
                >
                  <span className="text-sm sm:text-base font-medium text-[var(--fp-text)]">
                    <span className="sr-only">{`Q${i + 1}: `}</span>
                    {f.q}
                  </span>
                  <ChevronDown
                    className={`h-5 w-5 shrink-0 text-[var(--fp-text-2)] transition-transform ${isOpen ? "rotate-180" : ""}`}
                    aria-hidden
                  />
                </button>
                {isOpen && (
                  <p className="px-6 pb-5 text-sm text-[var(--fp-text-2)] leading-relaxed">{f.a}</p>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-12 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-8 text-center">
          <h2 className="text-lg font-semibold text-[var(--fp-text)]">{p.moreT}</h2>
          <p className="mt-2 text-sm text-[var(--fp-text-2)]">{p.moreD}</p>
          <div className="mt-5 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/docs"
              className="rounded-xl border border-[var(--fp-border)] px-6 py-2.5 text-sm font-semibold text-[var(--fp-text)] hover:border-[var(--fp-accent)] transition-colors"
            >
              {seo.common.navDocs}
            </Link>
            <Link
              href="/signup"
              className="btn-gradient rounded-xl px-6 py-2.5 text-sm font-semibold text-white shadow-glow"
            >
              {seo.common.startAutomating}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
