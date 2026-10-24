import { getDictionary, getLocale } from "@/i18n/server";
import { I18nProvider } from "@/i18n/client";
import { PublicShell } from "./PublicShell";

/** Server wrapper: locale provider + public nav/footer around page content. */
export async function PublicPage({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale} dict={getDictionary(locale)}>
      <PublicShell>{children}</PublicShell>
    </I18nProvider>
  );
}
