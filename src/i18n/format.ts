/**
 * Client-safe locale formatting helpers. The same implementations back
 * src/i18n/server.ts (server.ts re-exports these so there is one source of
 * truth); import from here in Client Components since server.ts pulls in
 * next/headers.
 */
import type { Locale } from "./config";

function bcp47(locale: Locale): string {
  return locale === "ar" ? "ar-EG" : "en-US";
}

/** Locale-aware relative time ("5m ago" / "منذ ٥ دقائق"). Falls back to "now". */
export function formatRelativeTime(
  locale: Locale,
  iso: string,
  opts?: { justNow?: string }
): string {
  const diff = Date.now() - new Date(iso).getTime();
  const justNow = opts?.justNow ?? (locale === "ar" ? "الآن" : "just now");
  if (Number.isNaN(diff) || diff < 0) return justNow;
  const rtf = new Intl.RelativeTimeFormat(bcp47(locale), { numeric: "auto" });
  const m = Math.floor(diff / 60000);
  if (m < 1) return justNow;
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  const d = Math.floor(h / 24);
  if (d < 7) return rtf.format(-d, "day");
  return formatDate(locale, iso);
}

export function formatDate(
  locale: Locale,
  d: Date | string | number,
  opts?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat(bcp47(locale), {
    dateStyle: "medium",
    ...opts,
  }).format(new Date(d));
}

export function formatDateTime(locale: Locale, d: Date | string | number): string {
  return new Intl.DateTimeFormat(bcp47(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(d));
}

export function formatNumber(
  locale: Locale,
  n: number,
  opts?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(bcp47(locale), opts).format(n);
}

export function formatInt(locale: Locale, n: number | null | undefined): string {
  return n == null || !Number.isFinite(n)
    ? "—"
    : new Intl.NumberFormat(bcp47(locale), { maximumFractionDigits: 0 }).format(n);
}

export function formatPct(
  locale: Locale,
  v: number | null | undefined,
  digits = 1
): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${new Intl.NumberFormat(bcp47(locale), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v)}%`;
}

export function formatCurrency(
  locale: Locale,
  n: number,
  currency = "USD"
): string {
  return new Intl.NumberFormat(bcp47(locale), {
    style: "currency",
    currency,
  }).format(n);
}

/** Compact duration ("45s" / "2.5m" / "3.0h") — units stay Latin by design. */
export function formatDuration(
  locale: Locale,
  sec: number | null | undefined
): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const f = (n: number, digits: number) =>
    new Intl.NumberFormat(bcp47(locale), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n);
  if (sec < 60) return `${f(Math.round(sec), 0)}s`;
  if (sec < 3600) return `${f(sec / 60, 1)}m`;
  return `${f(sec / 3600, 1)}h`;
}
