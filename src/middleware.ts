/**
 * Locale middleware. Public language variants use a URL prefix:
 *   /ar/features  → locale=ar, rewrite to /features
 *   /en/features  → locale=en, rewrite to /features
 * Without a prefix, locale comes from the fp_locale cookie (default en).
 *
 * The resolved locale is exposed as the x-locale request header so Server
 * Components can read it via getLocale() (@/i18n/server). API routes,
 * _next internals, and static assets are never rewritten.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  stripLocalePrefix,
} from "./i18n/config";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Never touch API routes, Next internals, or files with extensions.
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  const [prefixLocale, stripped] = stripLocalePrefix(pathname);
  const cookieLocale = req.cookies.get(LOCALE_COOKIE)?.value;
  const locale = prefixLocale ?? (isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE);

  const res = prefixLocale
    ? NextResponse.rewrite(new URL(stripped || "/", req.url))
    : NextResponse.next();
  res.headers.set("x-locale", locale);
  // The authenticated product shell must never be indexed: send an explicit
  // noindex on every /app/* response (locale-prefixed or not). Backs up the
  // robots metadata exported by src/app/app/layout.tsx.
  const targetPath = prefixLocale ? stripped || "/" : pathname;
  if (targetPath === "/app" || targetPath.startsWith("/app/")) {
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  // Keep the cookie in sync when the prefix was explicit.
  if (prefixLocale) {
    res.cookies.set(LOCALE_COOKIE, prefixLocale, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
  }
  return res;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
