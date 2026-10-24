import type { Metadata } from "next";
import { getLocale, getDictionary } from "@/i18n/server";
import { I18nProvider } from "@/i18n/client";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import LandingClient from "./LandingClient";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.home;
  return pageMeta("/", locale, m.title, m.description);
}

export default async function HomePage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <LandingClient />
    </I18nProvider>
  );
}
