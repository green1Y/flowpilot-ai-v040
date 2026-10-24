import { describe, expect, it } from "vitest";
import { ar, en, pageMeta, seoSiteUrl, seoT } from "./seo";
import robots from "@/app/robots";
import sitemap, { PUBLIC_PATHS } from "@/app/sitemap";

function keysDeep(o: unknown, prefix = ""): string[] {
  if (typeof o !== "object" || o === null) return [prefix];
  return Object.keys(o as Record<string, unknown>).flatMap((k) =>
    keysDeep((o as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k),
  );
}

function valuesDeep(o: unknown, prefix = ""): [string, unknown][] {
  if (typeof o !== "object" || o === null) return [[prefix, o]];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    valuesDeep(v, prefix ? `${prefix}.${k}` : k),
  );
}

// Keys allowed to be intentionally empty (language-specific title structure).
const ALLOW_EMPTY = new Set(["seo.landing.useCasesEyebrowEnd"]);

describe("seo fragment parity", () => {
  it("en and ar expose identical key sets", () => {
    // typeof en enforces this at compile time; this is the runtime backstop.
    expect(keysDeep(ar).sort()).toEqual(keysDeep(en).sort());
  });

  it("has no empty strings", () => {
    for (const [key, v] of valuesDeep(en)) {
      if (typeof v === "string" && !ALLOW_EMPTY.has(key))
        expect(v.trim().length, key).toBeGreaterThan(0);
    }
    for (const [key, v] of valuesDeep(ar)) {
      if (typeof v === "string" && !ALLOW_EMPTY.has(key))
        expect(v.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("every public page has a unique title and a usable description", () => {
    const metas = Object.values(en.seo.meta);
    const titles = metas.map((m) => m.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const m of metas) {
      expect(m.description.length).toBeGreaterThanOrEqual(50);
      expect(m.description.length).toBeLessThanOrEqual(320);
    }
  });

  it("seoT picks the right dictionary", () => {
    expect(seoT("en").meta.home.title).toContain("FlowPilot AI");
    expect(seoT("ar").meta.home.title).toContain("FlowPilot AI");
    expect(seoT("ar").landing.heroTitleB).not.toBe(seoT("en").landing.heroTitleB);
  });
});

describe("robots.txt", () => {
  type Rules = { rules: { userAgent: string; allow: string; disallow: string | string[] }[]; sitemap: string };
  it("allows public crawling but disallows /app/ and /api/", () => {
    const r = robots() as unknown as Rules;
    const rule = r.rules[0];
    expect(rule.userAgent).toBe("*");
    expect(rule.allow).toBe("/");
    const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    expect(disallow).toContain("/app/");
    expect(disallow).toContain("/api/");
  });

  it("points at the sitemap", () => {
    expect(robots().sitemap).toBe(`${seoSiteUrl()}/sitemap.xml`);
  });
});

describe("sitemap.xml", () => {
  it("lists exactly the public paths × en/ar, nothing else", () => {
    const entries = sitemap();
    expect(entries).toHaveLength(PUBLIC_PATHS.length * 2);
    const urls = entries.map((e) => e.url);
    for (const u of urls) {
      expect(u.startsWith(seoSiteUrl())).toBe(true);
      expect(u).not.toMatch(/\/app(\/|$)/);
      expect(u).not.toContain("/api/");
    }
    // Every public path appears in both locales.
    for (const p of PUBLIC_PATHS) {
      const suffix = p === "/" ? "/" : p;
      expect(urls.some((u) => u === `${seoSiteUrl()}${suffix}`)).toBe(true);
      expect(urls.some((u) => u === `${seoSiteUrl()}/ar${suffix}`)).toBe(true);
    }
  });

  it("carries hreflang alternates for en + ar", () => {
    for (const e of sitemap()) {
      const langs = (e as unknown as { alternates: { languages: Record<string, string> } })
        .alternates.languages;
      expect(Object.keys(langs).sort()).toEqual(["ar", "en"]);
    }
  });
});

describe("pageMeta", () => {
  it("sets canonical + hreflang + OG for both locales", () => {
    for (const locale of ["en", "ar"] as const) {
      const meta = pageMeta("/pricing", locale, "T", "D") as unknown as {
        alternates: { canonical: string; languages: Record<string, string> };
        openGraph: { images: { url: string }[] };
      };
      expect(meta.alternates.canonical).toBe(locale === "ar" ? "/ar/pricing" : "/pricing");
      expect(meta.alternates.languages.en).toBe("/pricing");
      expect(meta.alternates.languages.ar).toBe("/ar/pricing");
      expect(meta.openGraph.images[0].url).toBe(`${seoSiteUrl()}/opengraph-image`);
    }
  });

  it("seoSiteUrl never has a trailing slash", () => {
    expect(seoSiteUrl().endsWith("/")).toBe(false);
  });
});
