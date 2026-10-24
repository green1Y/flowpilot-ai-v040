import type { MetadataRoute } from "next";
import { seoSiteUrl } from "@/i18n/fragments/seo";

/**
 * robots.txt — public marketing pages are crawlable; the authenticated
 * product shell (/app/*) and all API routes are never indexed.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/app/", "/api/"],
      },
    ],
    sitemap: `${seoSiteUrl()}/sitemap.xml`,
  };
}
