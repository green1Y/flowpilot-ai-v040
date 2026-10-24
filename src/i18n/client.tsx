"use client";

/**
 * Client-side i18n. Wrap client subtrees that need translations:
 *
 *   import { I18nProvider, useDict, useLocale } from "@/i18n/client";
 *   // server component:
 *   <I18nProvider locale={locale} dict={getDictionary(locale)}>
 *     <ClientBits />
 *   </I18nProvider>
 *   // client component:
 *   const t = useDict(); t.nav.overview
 *
 * setLocaleClient("ar") persists the cookie and reloads the page so the
 * server renders with the new locale (html lang/dir included).
 */
import { createContext, useCallback, useContext } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  isLocale,
  type Locale,
} from "./config";
import type { Dictionary } from "./dictionaries/en";

const LocaleCtx = createContext<Locale>(DEFAULT_LOCALE);
const DictCtx = createContext<Dictionary | null>(null);

export function I18nProvider({
  locale,
  dict,
  children,
}: {
  locale: Locale;
  dict: Dictionary;
  children: React.ReactNode;
}) {
  return (
    <LocaleCtx.Provider value={locale}>
      <DictCtx.Provider value={dict}>{children}</DictCtx.Provider>
    </LocaleCtx.Provider>
  );
}

export function useLocale(): Locale {
  return useContext(LocaleCtx);
}

export function useDict(): Dictionary {
  const d = useContext(DictCtx);
  if (!d) throw new Error("useDict must be used inside <I18nProvider>");
  return d;
}

/** Persist locale choice (cookie + user record when logged in), then reload. */
export function setLocaleClient(locale: Locale): void {
  if (!isLocale(locale)) return;
  document.cookie =
    `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
  // Best-effort: persist to the user record so it follows across devices.
  fetch("/api/account/locale", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale }),
  }).catch(() => {});
  window.location.reload();
}

/** Language selector control (client). Drop into navs/headers. */
export function useSetLocale(): (locale: Locale) => void {
  return useCallback((locale: Locale) => setLocaleClient(locale), []);
}
