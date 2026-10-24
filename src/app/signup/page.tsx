import type { Metadata } from "next";
import { getLocale, getDictionary } from "@/i18n/server";
import { I18nProvider } from "@/i18n/client";
import { pageMeta, seoT } from "@/i18n/fragments/seo";
import { SignupForm } from "./SignupForm";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const m = seoT(locale).meta.signup;
  return pageMeta("/signup", locale, m.title, m.description);
}

/** Server wrapper: provides locale + dictionary so the signup form is translated. */
export default async function SignupPage() {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <SignupForm />
    </I18nProvider>
  );
}
