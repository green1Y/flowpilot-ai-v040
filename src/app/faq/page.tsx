import type { Metadata } from "next";
import { getLocale, getDictionary } from "@/i18n/server";
import { I18nProvider } from "@/i18n/client";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import { PublicPage } from "@/components/public/PublicPage";
import { PageHero } from "@/components/public/PublicShell";
import FaqAccordion from "./FaqAccordion";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.faq;
  return pageMeta("/faq", locale, m.title, m.description);
}

export default async function FaqPage() {
  const locale = await getLocale();
  const p = seoT(locale).pages.faq;
  return (
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <PublicPage>
        <PageHero eyebrow={p.eyebrow} title={p.title} lede={p.lede} />
        <FaqAccordion />
      </PublicPage>
    </I18nProvider>
  );
}
