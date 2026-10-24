import type { Metadata } from "next";
import Link from "next/link";
import { Check, Info } from "lucide-react";
import { getLocale } from "@/i18n/server";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import { PublicPage } from "@/components/public/PublicPage";
import { PageHero } from "@/components/public/PublicShell";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.pricing;
  return pageMeta("/pricing", locale, m.title, m.description);
}

export default async function PricingPage() {
  const seo = seoT(await getLocale());
  const p = seo.pages.pricing;
  const l = seo.landing;
  const tiers = [
    {
      name: l.pricingStarterName,
      tag: l.pricingStarterTag,
      cta: p.ctaStart,
      features: [l.pricingStarter1, l.pricingStarter2, l.pricingStarter3, l.pricingStarter4, l.pricingStarter5],
    },
    {
      name: l.pricingGrowthName,
      tag: l.pricingGrowthTag,
      cta: p.ctaStart,
      popular: true,
      features: [l.pricingGrowth1, l.pricingGrowth2, l.pricingGrowth3, l.pricingGrowth4, l.pricingGrowth5],
    },
    {
      name: l.pricingAgencyName,
      tag: l.pricingAgencyTag,
      cta: p.ctaTalk,
      features: [l.pricingAgency1, l.pricingAgency2, l.pricingAgency3, l.pricingAgency4, l.pricingAgency5],
    },
  ];
  return (
    <PublicPage>
      <PageHero eyebrow={p.eyebrow} title={p.title} lede={p.lede} />
      <section className="border-t border-[var(--fp-border)] py-14 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="grid gap-5 md:grid-cols-3 max-w-5xl mx-auto">
            {tiers.map((t) => (
              <article
                key={t.name}
                className={`relative rounded-2xl border p-7 shadow-card ${
                  t.popular ? "border-[#8B5CF6] bg-[var(--fp-card)]" : "border-[var(--fp-border)] bg-[var(--fp-card)]"
                }`}
              >
                {t.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full btn-gradient px-3 py-1 text-xs font-semibold text-white">
                    {p.popular}
                  </span>
                )}
                <h2 className="text-lg font-semibold text-[var(--fp-text)]">{t.name}</h2>
                <p className="mt-1 text-sm text-[var(--fp-text-2)]">{t.tag}</p>
                <ul className="mt-6 space-y-3">
                  {t.features.map((f) => (
                    <li key={f} className="flex items-start gap-3 text-sm text-[var(--fp-text-2)]">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#22D3EE]" aria-hidden />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/signup"
                  className={`mt-8 block rounded-xl px-4 py-2.5 text-center text-sm font-semibold transition-all ${
                    t.popular
                      ? "btn-gradient text-white shadow-glow"
                      : "border border-[var(--fp-border)] text-[var(--fp-text)] hover:border-[var(--fp-accent)]"
                  }`}
                >
                  {t.cta}
                </Link>
              </article>
            ))}
          </div>

          <div className="mx-auto mt-12 max-w-3xl rounded-2xl border border-[var(--fp-border)] bg-[var(--fp-bg-2)] p-8">
            <div className="flex items-start gap-4">
              <Info className="h-6 w-6 shrink-0 text-[#22D3EE]" aria-hidden />
              <div>
                <h2 className="text-lg font-semibold text-[var(--fp-text)]">{p.limitsT}</h2>
                <p className="mt-2 text-sm leading-relaxed text-[var(--fp-text-2)]">{p.limitsD}</p>
                <p className="mt-3 text-sm leading-relaxed text-[var(--fp-text-2)]">{p.priceNote}</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </PublicPage>
  );
}
