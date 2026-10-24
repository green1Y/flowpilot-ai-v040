/**
 * Server-side i18n helpers. Use in Server Components / Route Handlers:
 *
 *   import { getLocale, getDictionary } from "@/i18n/server";
 *   const locale = getLocale();            // from x-locale header (middleware) or cookie
 *   const t = getDictionary(locale);       // typed Dictionary
 *   t.nav.overview
 */
import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  type Locale,
} from "./config";
import en, { type Dictionary } from "./dictionaries/en";
import ar from "./dictionaries/ar";

// Client-safe formatters live in ./format (server.ts pulls in next/headers,
// so client components must import from "@/i18n/format" instead).
export {
  formatDate,
  formatDateTime,
  formatNumber,
  formatInt,
  formatPct,
  formatCurrency,
  formatDuration,
  formatRelativeTime,
} from "./format";

const DICTS: Record<Locale, Dictionary> = { en, ar };

/** Resolve the current request locale (middleware header wins, then cookie). */
export async function getLocale(): Promise<Locale> {
  try {
    const h = (await headers()).get("x-locale");
    if (isLocale(h)) return h;
  } catch {
    /* headers() unavailable (e.g. some test contexts) */
  }
  try {
    const c = (await cookies()).get(LOCALE_COOKIE)?.value;
    if (isLocale(c)) return c;
  } catch {
    /* ignore */
  }
  return DEFAULT_LOCALE;
}

export function getDictionary(locale: Locale): Dictionary {
  return DICTS[locale] ?? DICTS[DEFAULT_LOCALE];
}
