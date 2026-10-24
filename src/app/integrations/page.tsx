import type { Metadata } from "next";
import { CheckCircle2, FlaskConical, ShieldCheck } from "lucide-react";
import { getLocale } from "@/i18n/server";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import { PublicPage } from "@/components/public/PublicPage";
import { PageHero } from "@/components/public/PublicShell";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.integrations;
  return pageMeta("/integrations", locale, m.title, m.description);
}

export default async function IntegrationsPage() {
  const p = seoT(await getLocale()).pages.integrations;
  const real = [
    { t: p.igT, d: p.igD },
    { t: p.fbT, d: p.fbD },
    { t: p.waT, d: p.waD },
    { t: p.ttT, d: p.ttD },
  ];
  const sim = [
    { t: p.tgT, d: p.tgD },
    { t: p.ytT, d: p.ytD },
    { t: p.liT, d: p.liD },
    { t: p.xT, d: p.xD },
    { t: p.emT, d: p.emD },
    { t: p.wcT, d: p.wcD },
    { t: p.shT, d: p.shD },
    { t: p.zaT, d: p.zaD },
  ];
  return (
    <PublicPage>
      <PageHero eyebrow={p.eyebrow} title={p.title} lede={p.lede} />
      <section className="border-t border-[var(--fp-border)] py-14 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <h2 className="text-2xl font-bold text-[var(--fp-text)]">{p.realTitle}</h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2">
            {real.map((r) => (
              <article
                key={r.t}
                className="rounded-2xl border border-[#8B5CF6]/40 bg-[var(--fp-card)] p-7 shadow-card"
              >
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#34D399]/15 px-3 py-1 text-xs font-semibold text-[#34D399]">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  {p.realBadge}
                </span>
                <h3 className="mt-3 text-lg font-semibold text-[var(--fp-text)]">{r.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--fp-text-2)]">{r.d}</p>
              </article>
            ))}
          </div>

          <h2 className="mt-16 text-2xl font-bold text-[var(--fp-text)]">{p.simTitle}</h2>
          <p className="mt-3 max-w-3xl text-sm text-[var(--fp-text-2)]">{p.simNote}</p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {sim.map((s) => (
              <article
                key={s.t}
                className="rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-card)] p-5"
              >
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FBBF24]/15 px-2.5 py-0.5 text-xs font-semibold text-[#FBBF24]">
                  <FlaskConical className="h-3 w-3" aria-hidden />
                  {p.simBadge}
                </span>
                <h3 className="mt-2.5 text-base font-semibold text-[var(--fp-text)]">{s.t}</h3>
                <p className="mt-1 text-sm text-[var(--fp-text-2)]">{s.d}</p>
              </article>
            ))}
          </div>

          <div className="mt-16 rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-8">
            <div className="flex items-start gap-4">
              <ShieldCheck className="h-8 w-8 shrink-0 text-[#22D3EE]" aria-hidden />
              <div>
                <h2 className="text-xl font-semibold text-[var(--fp-text)]">{p.verifyT}</h2>
                <p className="mt-2 text-sm leading-relaxed text-[var(--fp-text-2)]">{p.verifyD}</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </PublicPage>
  );
}
