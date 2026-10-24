import type { Metadata } from "next";
import { BookOpen, LifeBuoy } from "lucide-react";
import { getLocale } from "@/i18n/server";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import { PublicPage } from "@/components/public/PublicPage";
import { PageHero } from "@/components/public/PublicShell";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.docs;
  return pageMeta("/docs", locale, m.title, m.description);
}

export default async function DocsPage() {
  const p = seoT(await getLocale()).pages.docs;
  const steps = [
    { t: p.s1t, d: p.s1d },
    { t: p.s2t, d: p.s2d },
    { t: p.s3t, d: p.s3d },
    { t: p.s4t, d: p.s4d },
    { t: p.s5t, d: p.s5d },
  ];
  const concepts = [
    { t: p.c1t, d: p.c1d },
    { t: p.c2t, d: p.c2d },
    { t: p.c3t, d: p.c3d },
    { t: p.c4t, d: p.c4d },
    { t: p.c5t, d: p.c5d },
    { t: p.c6t, d: p.c6d },
  ];
  const guides = [
    { t: p.g1t, d: p.g1d },
    { t: p.g2t, d: p.g2d },
    { t: p.g3t, d: p.g3d },
  ];
  return (
    <PublicPage>
      <PageHero eyebrow={p.eyebrow} title={p.title} lede={p.lede} />
      <section className="border-t border-[var(--fp-border)] py-14 sm:py-20">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <h2 className="text-2xl font-bold text-[var(--fp-text)]">{p.quickT}</h2>
          <ol className="mt-8 space-y-4">
            {steps.map((s, i) => (
              <li
                key={s.t}
                className="flex gap-4 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-5"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg btn-gradient text-sm font-bold text-white">
                  {i + 1}
                </span>
                <div>
                  <h3 className="text-base font-semibold text-[var(--fp-text)]">{s.t}</h3>
                  <p className="mt-1 font-mono text-sm text-[var(--fp-text-2)]" dir="ltr">{s.d}</p>
                </div>
              </li>
            ))}
          </ol>

          <h2 className="mt-16 text-2xl font-bold text-[var(--fp-text)]">{p.conceptsT}</h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {concepts.map((c) => (
              <article
                key={c.t}
                className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-6"
              >
                <h3 className="text-base font-semibold text-[var(--fp-text)]">{c.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--fp-text-2)]">{c.d}</p>
              </article>
            ))}
          </div>

          <h2 className="mt-16 text-2xl font-bold text-[var(--fp-text)]">{p.guidesT}</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {guides.map((g) => (
              <article
                key={g.t}
                className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-6"
              >
                <BookOpen className="h-5 w-5 text-[#22D3EE]" aria-hidden />
                <h3 className="mt-3 text-base font-semibold text-[var(--fp-text)]">{g.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--fp-text-2)]">{g.d}</p>
              </article>
            ))}
          </div>

          <div className="mt-12 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-8">
            <div className="flex items-start gap-4">
              <LifeBuoy className="h-6 w-6 shrink-0 text-[#8B5CF6]" aria-hidden />
              <div>
                <h2 className="text-lg font-semibold text-[var(--fp-text)]">{p.supportT}</h2>
                <p className="mt-2 text-sm leading-relaxed text-[var(--fp-text-2)]">{p.supportD}</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </PublicPage>
  );
}
