import type { Metadata } from "next";
import Link from "next/link";
import { Compass } from "lucide-react";
import { getLocale } from "@/i18n/server";
import { seoT } from "@/i18n/fragments/seo";

export const metadata: Metadata = {
  title: "Page not found — FlowPilot AI",
  robots: { index: false, follow: false },
};

export default async function NotFound() {
  const t = seoT(await getLocale()).notFound;
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--fp-bg)] px-4 text-[var(--fp-text)]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(600px_circle_at_50%_30%,rgba(139,92,246,0.18),transparent_60%),radial-gradient(500px_circle_at_80%_80%,rgba(34,211,238,0.10),transparent_60%)]"
      />
      <div className="relative mx-auto max-w-md text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl btn-gradient shadow-glow">
          <Compass className="h-8 w-8 text-white" aria-hidden />
        </div>
        <p className="mt-8 text-7xl font-bold text-gradient" aria-hidden>
          404
        </p>
        <h1 className="mt-4 text-2xl font-bold">{t.heading}</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--fp-text-2)]">{t.body}</p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/"
            className="btn-gradient inline-flex w-full sm:w-auto items-center justify-center rounded-xl px-6 py-3 text-sm font-semibold text-white shadow-glow"
          >
            {t.ctaHome}
          </Link>
          <Link
            href="/signup"
            className="inline-flex w-full sm:w-auto items-center justify-center rounded-xl border border-[var(--fp-border)] bg-[var(--fp-card)] px-6 py-3 text-sm font-semibold text-[var(--fp-text)] hover:border-[var(--fp-accent)] transition-colors"
          >
            {t.ctaSignup}
          </Link>
        </div>
      </div>
    </main>
  );
}
