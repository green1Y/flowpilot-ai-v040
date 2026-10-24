"use client";

import { ChevronDown, Zap } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useLocale } from "@/i18n/client";
import { seoAr, seoEn } from "@/i18n/fragments/seo";

export function PublicLogo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl btn-gradient shadow-glow">
        <Zap className="h-5 w-5 text-white" aria-hidden />
      </div>
      <span className="text-lg font-bold text-[var(--fp-text)]">
        FlowPilot <span className="text-gradient">AI</span>
      </span>
    </Link>
  );
}

export function PublicNav() {
  const locale = useLocale();
  const t = (locale === "ar" ? seoAr : seoEn).seo.common;
  const [open, setOpen] = useState(false);
  const links = [
    { label: t.navFeatures, href: "/features" },
    { label: t.navIntegrations, href: "/integrations" },
    { label: t.navUseCases, href: "/use-cases" },
    { label: t.navPricing, href: "/pricing" },
    { label: t.navFaq, href: "/faq" },
    { label: t.navDocs, href: "/docs" },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--fp-border)] bg-[var(--fp-bg)]/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <PublicLogo />
        <nav className="hidden lg:flex items-center gap-7" aria-label="Primary">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-[var(--fp-text-2)] hover:text-[var(--fp-text)] transition-colors"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="hidden lg:flex items-center gap-3">
          <Link
            href="/login"
            className="text-sm font-medium text-[var(--fp-text-2)] hover:text-[var(--fp-text)] transition-colors"
          >
            {t.signIn}
          </Link>
          <Link
            href="/signup"
            className="btn-gradient inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-white shadow-glow"
          >
            {t.startAutomating}
          </Link>
        </div>
        <button
          className="lg:hidden p-2 text-[var(--fp-text)]"
          aria-label={open ? t.closeMenu : t.openMenu}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown className={`h-5 w-5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && (
        <div className="lg:hidden border-t border-[var(--fp-border)] px-4 py-3 space-y-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 text-sm text-[var(--fp-text-2)] hover:text-[var(--fp-text)] hover:bg-[var(--fp-bg-2)]"
            >
              {l.label}
            </Link>
          ))}
          <div className="flex gap-3 pt-2">
            <Link
              href="/login"
              className="flex-1 rounded-xl border border-[var(--fp-border)] px-4 py-2 text-center text-sm font-medium text-[var(--fp-text)]"
            >
              {t.signIn}
            </Link>
            <Link
              href="/signup"
              className="btn-gradient flex-1 rounded-xl px-4 py-2 text-center text-sm font-medium text-white"
            >
              {t.startAutomating}
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

export function PublicFooter() {
  const locale = useLocale();
  const t = (locale === "ar" ? seoAr : seoEn).seo.common;
  const cols = [
    {
      title: t.footerProduct,
      links: [
        { label: t.navFeatures, href: "/features" },
        { label: t.navIntegrations, href: "/integrations" },
        { label: t.navUseCases, href: "/use-cases" },
        { label: t.navPricing, href: "/pricing" },
        { label: t.navChangelog, href: "/changelog" },
      ],
    },
    {
      title: t.footerGetStarted,
      links: [
        { label: t.startAutomating, href: "/signup" },
        { label: t.signIn, href: "/login" },
        { label: t.navDocs, href: "/docs" },
      ],
    },
    {
      title: t.footerLegal,
      links: [
        { label: t.footerPrivacy, href: "/privacy" },
        { label: t.footerTerms, href: "/terms" },
      ],
    },
  ];
  return (
    <footer className="border-t border-[var(--fp-border)] bg-[var(--fp-bg-2)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-12">
        <div className="grid gap-8 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div>
            <PublicLogo />
            <p className="mt-4 max-w-xs text-sm text-[var(--fp-text-2)]">{t.footerTagline}</p>
          </div>
          {cols.map((c) => (
            <nav key={c.title} aria-label={c.title}>
              <h2 className="text-sm font-semibold text-[var(--fp-text)]">{c.title}</h2>
              <ul className="mt-3 space-y-2">
                {c.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-[var(--fp-text-2)] hover:text-[var(--fp-text)] transition-colors"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-[var(--fp-border)] pt-6">
          <p className="text-xs text-[var(--fp-text-2)]">{t.footerCopyright}</p>
          <p className="text-xs text-[var(--fp-text-2)]">{t.footerHonest}</p>
        </div>
      </div>
    </footer>
  );
}

/** Page wrapper for public marketing pages: nav + main + footer. */
export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--fp-bg)] text-[var(--fp-text)]">
      <PublicNav />
      <main>{children}</main>
      <PublicFooter />
    </div>
  );
}

/** Centered page-hero used by public pages: eyebrow + h1 + lede. */
export function PageHero({
  eyebrow,
  title,
  lede,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  lede?: string;
}) {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(600px_circle_at_20%_10%,rgba(139,92,246,0.18),transparent_60%),radial-gradient(500px_circle_at_80%_20%,rgba(34,211,238,0.12),transparent_60%)]"
      />
      <div className="relative mx-auto max-w-4xl px-4 sm:px-6 pt-16 pb-10 sm:pt-24 sm:pb-14 text-center">
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--fp-accent-2)]">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-4 text-4xl sm:text-5xl font-bold tracking-tight text-[var(--fp-text)] leading-tight">
          {title}
        </h1>
        {lede && (
          <p className="mx-auto mt-5 max-w-2xl text-base sm:text-lg text-[var(--fp-text-2)]">
            {lede}
          </p>
        )}
      </div>
    </section>
  );
}
