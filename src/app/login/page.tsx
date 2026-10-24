import type { Metadata } from "next";
import { getLocale, getDictionary } from "@/i18n/server";
import { I18nProvider } from "@/i18n/client";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import { LoginForm } from "./LoginForm";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.login;
  return pageMeta("/login", locale, m.title, m.description);
}

/** Server wrapper: provides locale + dictionary so the login form is translated. */
export default async function LoginPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <LoginForm />
    </I18nProvider>
  );
}
