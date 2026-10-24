/**
 * i18n configuration — FlowPilot AI ships English + Arabic.
 *
 * Locale resolution order (see src/middleware.ts):
 *   1. URL prefix: /ar/... or /en/... (also used for hreflang variants)
 *   2. Cookie: fp_locale
 *   3. Default: en
 *
 * When logged in, the preference is also persisted to the user record
 * (users.locale) so it follows the user across devices.
 */

export const LOCALES = ["en", "ar"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "fp_locale";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export const RTL_LOCALES: readonly Locale[] = ["ar"];

export function isRtl(locale: Locale): boolean {
  return (RTL_LOCALES as readonly string[]).includes(locale);
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Strip a locale prefix (/ar, /en) from a pathname. Returns [locale|null, strippedPath]. */
export function stripLocalePrefix(pathname: string): [Locale | null, string] {
  for (const l of LOCALES) {
    if (pathname === `/${l}`) return [l, "/"];
    if (pathname.startsWith(`/${l}/`)) return [l, pathname.slice(l.length + 1)];
  }
  return [null, pathname];
}

/** Build the locale-prefixed variant of a public path (for hreflang). */
export function localizedPath(path: string, locale: Locale): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (locale === DEFAULT_LOCALE) return clean;
  return `/${locale}${clean}`;
}
