/**
 * Canonical public site origin (used for SEO canonicals, Open Graph URLs,
 * sitemap entries, and anywhere the app needs its own public base URL).
 *
 * Canonical variable: NEXT_PUBLIC_SITE_URL.
 * Legacy fallback: NEXT_PUBLIC_APP_URL (kept so existing .env files keep
 * working — both were documented at different times).
 *
 * NOTE: this is the PUBLIC SITE origin (marketing pages, canonicals), not
 * the OAuth tunnel URL. OAuth callbacks use APP_PUBLIC_URL, which may differ
 * (e.g. an ngrok URL during local development).
 */
export function siteUrl(): string {
  const raw = (
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000"
  ).trim();
  return raw.replace(/\/+$/, "");
}
