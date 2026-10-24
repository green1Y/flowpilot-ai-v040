import type { Metadata } from "next";
import Link from "next/link";
import { getLocale } from "@/i18n/server";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import { PublicPage } from "@/components/public/PublicPage";
import { PageHero } from "@/components/public/PublicShell";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.features;
  return pageMeta("/features", locale, m.title, m.description);
}

export default async function FeaturesPage() {
  const p = seoT(await getLocale()).pages.features;
  const items = [
    { t: p.f1t, d: p.f1d },
    { t: p.f2t, d: p.f2d },
    { t: p.f3t, d: p.f3d },
    { t: p.f4t, d: p.f4d },
    { t: p.f5t, d: p.f5d },
    { t: p.f6t, d: p.f6d },
    { t: p.f7t, d: p.f7d },
    { t: p.f8t, d: p.f8d },
  ];
  return (
    <PublicPage>
      <PageHero eyebrow={p.eyebrow} title={p.title} lede={p.lede} />
      <section className="border-t border-[var(--fp-border)] py-14 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="grid gap-5 md:grid-cols-2">
            {items.map((f, i) => (
              <article
                key={f.t}
                className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-7 shadow-card"
              >
                <p className="text-xs font-semibold uppercase tracking-widest text-[var(--fp-accent-2)]">
                  {String(i + 1).padStart(2, "0")}
                </p>
                <h2 className="mt-2 text-xl font-semibold text-[var(--fp-text)]">{f.t}</h2>
                <p className="mt-3 text-sm leading-relaxed text-[var(--fp-text-2)]">{f.d}</p>
              </article>
            ))}
          </div>
          <div className="mt-12 text-center">
            <Link
              href="/signup"
              className="btn-gradient inline-flex items-center gap-2 rounded-xl px-8 py-3.5 text-base font-semibold text-white shadow-glow"
            >
              {p.cta}
            </Link>
          </div>
        </div>
      </section>
    </PublicPage>
  );
}
