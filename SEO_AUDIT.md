# SEO Audit — FlowPilot AI (Phase 4 workstream)

Audited 2026-10-19 against `~/workspace/flowpilot`. Scope: public pages only.
`/app/*` must never be indexable. All claims below were verified by the
assistant (typecheck, vitest, dev-server curl); nothing is asserted from
training data.

## Summary

| Area | Before | After |
|---|---|---|
| robots.txt | did not exist | `src/app/robots.ts`: allow `/`, disallow `/app/` + `/api/`, sitemap ref |
| sitemap.xml | did not exist | `src/app/sitemap.ts`: 24 URLs (12 paths × en/ar), hreflang alternates, no `/app` or `/api` |
| Per-page metadata | generic root title only; privacy/terms had static titles | unique title + description + canonical + OG + hreflang on all 12 public pages |
| OG image | none | `src/app/opengraph-image.tsx` serving a locally-generated 1200×630 branded PNG |
| 404 | Next.js default | `src/app/not-found.tsx`: branded, bilingual, noindex |
| `/app/*` indexing | nothing prevented it | robots metadata `noindex,nofollow` in `src/app/app/layout.tsx` + `X-Robots-Tag: noindex, nofollow` in middleware |
| i18n SEO | landing page English-only, no hreflang | `src/i18n/fragments/seo.ts` (en/ar, key parity enforced), hreflang en↔ar on every public page |
| Landing honesty | pricing teaser used unverified claims ("1 workspace, 2 channels", "Unlimited channels"); hero implied Telegram parity | teaser now shows real plan limits from `src/db/seed-plans.ts`; hero/channels copy distinguishes real OAuth from simulated connectors |

## Issues found and fixed

### 1. No robots.txt / sitemap.xml — severity: HIGH → FIXED
Public pages were undiscoverable in any structured way. Added
`src/app/robots.ts` and `src/app/sitemap.ts`. Verified via dev server:
`curl /robots.txt` shows `Allow: /`, `Disallow: /app/`, `Disallow: /api/`,
and the sitemap URL; `curl /sitemap.xml` lists exactly the 12 public paths
in en + ar variants (24 `<url>` entries), each with `<xhtml:link
rel="alternate" hreflang="en|ar">`. No `/app/*`, no `/api/*`.

### 2. `/app/*` was crawlable — severity: HIGH → FIXED
The authenticated product shell had no indexing safeguards. Two independent
layers now: (a) `robots: { index: false, follow: false }` metadata exported
from `src/app/app/layout.tsx` (server layout), rendering
`<meta name="robots" content="noindex, nofollow">`; (b) middleware sets
`X-Robots-Tag: noindex, nofollow` on every `/app/*` response, including
`/ar/app/*` rewrites. Verified: `curl -I /app/overview` returns the header;
`/api/*` is untouched by middleware as before (matcher excludes it) and is
covered by robots.txt disallow.

### 3. Missing per-page metadata — severity: HIGH → FIXED
Root layout had a single generic title/description; login/signup had none.
Every public page now exports `generateMetadata()` via the shared
`pageMeta()` helper: unique title + description, self-referencing canonical,
`og:*` + `twitter:*`, and `alternates.languages` {en, ar} built with
`localizedPath()` from `src/i18n/config`. Verified in rendered HTML for `/`,
`/features`, `/pricing`, `/ar/`.

### 4. No Open Graph image — severity: MEDIUM → FIXED
`src/app/opengraph-image.tsx` serves a 1200×630 PNG generated locally with
PIL (`src/app/opengraph-base.png`): brand background `#0B1020`, violet/cyan
glows, "FlowPilot AI" wordmark, honest tagline. No external assets, no font
downloads (uses system DejaVu at generation time, baked into the PNG).
Verified: `curl /opengraph-image` returns `200 image/png`.

### 5. Default Next.js 404 — severity: MEDIUM → FIXED
`src/app/not-found.tsx`: on-brand 404 with bilingual copy from the SEO
fragment, links home + signup, `robots: noindex` metadata. Verified:
`curl /no-such-page-xyz` returns 404 with the custom page.

### 6. English-only landing, no hreflang — severity: MEDIUM → FIXED
New `src/i18n/fragments/seo.ts` holds all public-site strings (`en`, and
`ar: typeof en` so missing Arabic keys fail the build). Landing page,
auth headings, 404, and all new pages render both locales; middleware's
`/ar/*` rewrite path verified (`curl /ar/` renders Arabic hero + `<html
lang="ar" dir="rtl">`).

### 7. Unverified marketing claims on landing — severity: MEDIUM → FIXED
The pricing teaser advertised limits that don't exist in the product
("1 workspace, 2 channels", "Unlimited channels"). Replaced with the real
plan limits from `src/db/seed-plans.ts` (Starter 500 msgs/5 workflows/3
seats; Growth 5,000/25/10; Agency 25,000/200/25). Hero and integrations
sections now distinguish real OAuth channels from simulated connectors.
`/pricing` states prices are confirmed during onboarding — no invented
prices.

### 8. Weak heading/landmark structure — severity: LOW → FIXED
Landing page converted to server `page.tsx` (metadata) + `LandingClient`
(interactive). One `h1` per page, section `h2`s, footer columns use `nav`
+ `h2` (was `h4`), tablist has `aria-label`, decorative mock is
`aria-hidden`. New pages share `PageHero` (single `h1`).

## Open issues / recommendations (not fixed — needs owner decision)

1. **Canonical domain is a placeholder.** `seoSiteUrl()` falls back to
   `https://flowpilot.ai`; set `NEXT_PUBLIC_SITE_URL` to the real production
   origin before launch, or every canonical/OG URL is wrong. Severity: HIGH
   (pre-launch).
2. **`tsc` is not clean repo-wide.** All SEO-workstream files pass, but
   `src/components/charts/index.ts` (another workstream's WIP — JSX in a
   `.ts` file) has 11 syntax errors. Do not treat `npm run typecheck` as
   green until that file is fixed by its owner. Severity: HIGH (blocks CI).
3. **No production build verification in this workstream.** `npm run build`
   was intentionally not run (dev server on :3100 was up; per AGENTS.md,
   building while dev runs corrupts the cache). `opengraph-image.tsx` and
   `generateMetadata` paths were verified on the dev server instead. Run a
   clean production build before release. Severity: MEDIUM.
4. **`/docs` and `/changelog` are new pages with no inbound links yet**
   except nav/footer — fine for now; add contextual links as docs grow.
   Severity: LOW.
5. **Keyword strategy is hypothesis-only** (see KEYWORD_STRATEGY.md) —
   validate with Search Console + a keyword tool post-launch. No fake
   volume data was introduced. Severity: LOW (process).
6. **Auth form labels/placeholders remain English** (only headings
   translated) — full auth i18n belongs to the i18n workstream that owns
   the dictionaries. Severity: LOW.

## Verification log

- `npm run typecheck`: all SEO-workstream files clean; 11 errors remain in
  `src/components/charts/index.ts` (another workstream's WIP — JSX in a
  `.ts` file; not touched by this workstream).
- `npx vitest run src/i18n/fragments/seo.test.ts`: 10/10 pass (fragment
  parity, robots rules, sitemap URLs/hreflang, pageMeta canonical/OG).
- Full `npm test`: **41 files, 481 tests, all pass** — no regressions.
- `curl http://localhost:3100/robots.txt` → allow `/`, disallow `/app/`
  + `/api/`, sitemap line present.
- `curl http://localhost:3100/sitemap.xml` → 24 URLs (12 paths × en/ar),
  hreflang alternates, zero `/app` or `/api` entries.
- `curl /` → unique title, canonical, hreflang en/ar, description, OG tags.
- `curl /features`, `/pricing`, `/login` ("Sign in — FlowPilot AI"),
  `/signup` ("Create your account — FlowPilot AI") → 200, unique titles.
  (Login/signup page wrappers were concurrently rewritten by the i18n
  workstream; `generateMetadata` was added to their versions, and my
  interim LoginClient/SignupClient were removed as orphaned.)
- `curl /ar` → 200, `<html lang="ar" dir="rtl">`, Arabic title;
  `curl /ar/faq` → 200, Arabic title, correct hreflang pair.
- `curl -I /app/overview` and `/ar/app/overview` → `X-Robots-Tag: noindex,
  nofollow`; rendered HTML contains `<meta name="robots"
  content="noindex, nofollow">`.
- `curl /opengraph-image` → 200 `image/png` (1200×630 branded PNG).
- `curl /nope-not-here` → 404 with the custom bilingual 404 page.
- Fixed during verification: `FaqClient` (client) imported the server-only
  `PublicPage` → split into server `page.tsx` + client `FaqAccordion`.
- Note: at ~03:55–04:02 the shared dev server returned 500s on several
  routes due to other workstreams' concurrent edits (unrelated files);
  all SEO routes re-verified green after their edits settled. A dev-server
  restart will clear any remaining stale module cache.
