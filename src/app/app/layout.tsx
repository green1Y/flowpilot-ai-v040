import type { Metadata } from "next";
import { getLocale, getDictionary } from "@/i18n/server";
import { I18nProvider } from "@/i18n/client";
import AppShell from "./AppShell";

/**
 * The authenticated product shell is never indexed: robots metadata here
 * plus the X-Robots-Tag header set in middleware for /app/* responses.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Server wrapper: resolves the request locale (middleware x-locale header /
 * cookie) and provides it — plus the typed dictionary — to the whole client
 * app shell, so useDict()/useLocale() work in Sidebar, Topbar, and pages.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  return (
    <I18nProvider locale={locale} dict={dict}>
      <AppShell>{children}</AppShell>
    </I18nProvider>
  );
}
