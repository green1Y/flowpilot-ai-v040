import type { Metadata } from "next";
import Link from "next/link";
import { Check, Workflow } from "lucide-react";
import { getLocale } from "@/i18n/server";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import { PublicPage } from "@/components/public/PublicPage";
import { PageHero } from "@/components/public/PublicShell";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.useCases;
  return pageMeta("/use-cases", locale, m.title, m.description);
}

export default async function UseCasesPage() {
  const p = seoT(await getLocale()).pages.useCases;
  const cases = [
    {
      t: p.ecT,
      d: p.ecD,
      points: [p.ec1, p.ec2, p.ec3],
      flow: p.ecFlow,
    },
    {
      t: p.agT,
      d: p.agD,
      points: [p.ag1, p.ag2, p.ag3],
      flow: p.agFlow,
    },
    {
      t: p.smT,
      d: p.smD,
      points: [p.sm1, p.sm2, p.sm3],
      flow: p.smFlow,
    },
  ];
  return (
    <PublicPage>
      <PageHero eyebrow={p.eyebrow} title={p.title} lede={p.lede} />
      <section className="border-t border-[var(--fp-border)] py-14 sm:py-20">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 space-y-8">
          {cases.map((c) => (
            <article
              key={c.t}
              className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-8 shadow-card"
            >
              <h2 className="text-2xl font-bold text-[var(--fp-text)]">{c.t}</h2>
              <p className="mt-3 text-sm leading-relaxed text-[var(--fp-text-2)]">{c.d}</p>
              <ul className="mt-5 space-y-3">
                {c.points.map((pt) => (
                  <li key={pt} className="flex items-start gap-3 text-sm text-[var(--fp-text-2)]">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#34D399]/15">
                      <Check className="h-3 w-3 text-[#34D399]" aria-hidden />
                    </span>
                    {pt}
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex items-start gap-3 rounded-xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-4">
                <Workflow className="h-5 w-5 shrink-0 text-[var(--fp-accent-2)]" aria-hidden />
                <p className="text-sm text-[var(--fp-text-2)]">
                  <span className="font-semibold text-[var(--fp-text)]">{p.flowLabel}: </span>
                  {c.flow}
                </p>
              </div>
            </article>
          ))}
          <div className="text-center pt-4">
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
