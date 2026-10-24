import Link from "next/link";
import { Zap, BookOpen, ArrowLeft } from "lucide-react";
import { getLocale } from "@/i18n/server";
import { en, ar } from "@/i18n/fragments/docs";
import { GUIDE_ORDER, GUIDE_FRAGMENT_KEY } from "./guides";

/**
 * Chrome for the Phase 4 guide pages (/docs/guides, /docs/<slug>).
 * NOT used by the /docs landing page (SEO workstream owns that).
 */
export async function DocsChrome({ children, activeSlug }: { children: React.ReactNode; activeSlug?: string }) {
  const locale = await getLocale();
  const t = locale === "ar" ? ar : en;
  const guides = t.guides as Record<string, { title: string; desc: string }>;

  return (
    <div className="min-h-screen bg-[var(--fp-bg)] text-[var(--fp-text)]">
      <header className="sticky top-0 z-10 border-b border-[var(--fp-border)] bg-[var(--fp-bg)]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg btn-gradient shadow-glow">
              <Zap className="h-4 w-4 text-white" aria-hidden />
            </div>
            <span className="font-bold">
              {t.brand} <span className="text-gradient">{t.docsHome}</span>
            </span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/docs" className="text-[var(--fp-text-2)] hover:text-[var(--fp-text)]">
              {t.docsHome}
            </Link>
            <Link href="/login" className="text-[var(--fp-text-2)] hover:text-[var(--fp-text)]">
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-lg btn-gradient px-3.5 py-1.5 font-medium text-white shadow-glow"
            >
              Sign up
            </Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-8 sm:px-6">
        <aside className="hidden w-64 shrink-0 lg:block">
          <nav className="sticky top-20 space-y-1">
            <Link
              href="/docs/guides"
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-[var(--fp-card)] ${
                !activeSlug ? "bg-[var(--fp-card)] text-[var(--fp-text)]" : "text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
              }`}
            >
              <BookOpen className="h-4 w-4" aria-hidden />
              {t.docsHome}
            </Link>
            {GUIDE_ORDER.map((slug) => {
              const g = guides[GUIDE_FRAGMENT_KEY[slug]];
              const active = slug === activeSlug;
              return (
                <Link
                  key={slug}
                  href={`/docs/${slug}`}
                  className={`block rounded-lg px-3 py-2 text-sm hover:bg-[var(--fp-card)] ${
                    active ? "bg-[var(--fp-card)] font-medium text-[var(--fp-text)]" : "text-[var(--fp-text-2)] hover:text-[var(--fp-text)]"
                  }`}
                >
                  {g.title}
                </Link>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 pb-16">
          <Link
            href="/docs/guides"
            className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--fp-text-2)] hover:text-[var(--fp-text)] lg:hidden"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {t.backToDocs}
          </Link>
          {children}
        </main>
      </div>

      <footer className="border-t border-[var(--fp-border)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-[var(--fp-text-2)] sm:px-6">
          <span>
            {t.brand} {t.docsHome} — {t.tagline}
          </span>
          <span className="flex gap-4">
            <Link href="/privacy" className="hover:text-[var(--fp-text)]">Privacy</Link>
            <Link href="/terms" className="hover:text-[var(--fp-text)]">Terms</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
