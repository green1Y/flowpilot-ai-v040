import type { MetadataRoute } from "next";
import { localizedPath, type Locale } from "@/i18n/config";
import { seoSiteUrl } from "@/i18n/fragments/seo";

/** Public canonical paths. /app/* and API routes are NEVER listed. */
export const PUBLIC_PATHS = [
  "/",
  "/features",
  "/integrations",
  "/use-cases",
  "/pricing",
  "/faq",
  "/changelog",
  "/docs",
  "/privacy",
  "/terms",
  "/login",
  "/signup",
] as const;

const SITEMAP_LOCALES: Locale[] = ["en", "ar"];

export default function sitemap(): MetadataRoute.Sitemap {
  const url = seoSiteUrl();
  const lastModified = new Date();
  const entries: MetadataRoute.Sitemap = [];
  for (const path of PUBLIC_PATHS) {
    for (const locale of SITEMAP_LOCALES) {
      const loc = `${url}${localizedPath(path, locale)}`;
      entries.push({
        url: loc,
        lastModified,
        changeFrequency: path === "/" ? "weekly" : "monthly",
        priority: path === "/" ? 1 : 0.8,
        alternates: {
          languages: {
            en: `${url}${localizedPath(path, "en")}`,
            ar: `${url}${localizedPath(path, "ar")}`,
          },
        },
      });
    }
  }
  return entries;
}
