"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/i18n/client";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "@/i18n/config";
import { en as builderEn, ar as builderAr } from "@/i18n/fragments/builder";

type BuilderStrings = typeof builderEn;

/**
 * Builder locale resolution. The /app tree is not wrapped in I18nProvider
 * today, so useLocale() returns the default — we fall back to the fp_locale
 * cookie (set by the locale switcher). If the i18n workstream later wraps
 * /app in a provider, useLocale() wins automatically.
 */
export function useBuilderLocale(): { locale: Locale; t: BuilderStrings; rtl: boolean } {
  const ctxLocale = useLocale();
  const [cookieLocale, setCookieLocale] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const m = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
    const v = m ? decodeURIComponent(m[1]) : null;
    if (isLocale(v)) setCookieLocale(v);
  }, []);

  const locale: Locale = ctxLocale !== DEFAULT_LOCALE ? ctxLocale : cookieLocale;
  return { locale, t: locale === "ar" ? builderAr : builderEn, rtl: locale === "ar" };
}

/** Simple {n}/{s} template interpolation for fragment strings. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}
