# Translation Coverage — FlowPilot AI (EN / AR)

**Workstream:** i18n Completion + RTL + Accessibility (Phase 4)
**Date:** 2026-10-19
**Locales shipped:** `en` (LTR), `ar` (RTL). Key parity between `src/i18n/dictionaries/en.ts`
and `src/i18n/dictionaries/ar.ts` is enforced at compile time (`const ar: Dictionary`).

## How switching works (verified by code path)

1. `LanguageSelector` (`src/components/i18n/LanguageSelector.tsx`) calls `setLocaleClient(locale)`
   → sets the `fp_locale` cookie (1 year, `SameSite=Lax`) → best-effort `PUT /api/account/locale`
   (persists to `users.locale` when logged in) → `window.location.reload()`.
2. `src/middleware.ts` resolves locale from `/ar|/en` URL prefix → cookie → default `en`,
   sets the `x-locale` header, and keeps the cookie in sync with an explicit prefix.
3. `src/app/layout.tsx` (root, server) calls `getLocale()` and renders
   `<html lang={locale} dir={isRtl(locale) ? "rtl" : "ltr"}>`.
4. `src/app/app/layout.tsx` (server wrapper) + `/login` + `/signup` pages provide
   `<I18nProvider locale dict>` so `useDict()` / `useLocale()` work in all client subtrees.
   New client-safe formatters live in `src/i18n/format.ts`
   (`formatRelativeTime`, `formatDate/Time`, `formatNumber/Int/Pct/Currency`, `formatDuration`);
   `src/i18n/server.ts` re-exports them (single source of truth).

Selector placements: app **sidebar footer**, **topbar** (sm+ screens), **login** and **signup**
pages (below the card).

## Fully translated (EN + AR)

| Area | Notes |
|---|---|
| Sidebar | All 13 nav labels, collapse/expand, primary-nav landmark label, account fallback. Active indicator + border use logical properties; collapse chevrons flip in RTL. |
| Topbar | Search placeholder/aria + no-results, workspace switcher (loading/empty/aria), notifications (aria with unread count, empty, Demo badge), theme toggle aria, account menu, settings/logout/signing-out, "Create Automation". Dropdowns + badge use logical `start`/`end`. |
| Login | Title, subtitle, labels, placeholders, validation messages (role=alert), server errors, submit, "New to FlowPilot AI?" link, password show/hide aria. |
| Signup | Title, subtitle, all labels incl. work email / workspace name, password hint, validation, server errors, submit, "Already have an account?" link. |
| Overview page | Header, demo badge, range tabs, channel filter, date inputs, all 8 KPI labels, delta lines, chart titles + series names, all 6 card titles, all empty states + actions, pending-tasks cards, locale-aware numbers/dates. |
| Inbox page | Header + refresh, filters (search/channels/status/AI-handled/unread-only + read-state note), list (loading/error/empty, unread dots, badges, typing presence, locale-aware relative times), thread (empty state, back buttons, note composer, internal-note labels, AI-assist bar, saved replies, reply composer, send, mock-adapter note), Demo/Real message badges + tooltips, contact profile panel (assignee/priority/takeover/tags/lead score/notes/save + all status messages). |
| Contacts page | Header + Import/Export/Add, all filters, segments UI, bulk bar, table headers + row aria labels, pagination, Add modal (labels, duplicate flow, errors), detail drawer (tabs, all form labels incl. custom-fields JSON, orders section, timeline with type labels + relative dates), delete + import modals. |
| Analytics page | Header, range select, channel filter, custom-range inputs, compare checkbox, all 8 tab labels, all empty states, all section titles, all chart/card titles, all table headers, all ~35 metric labels **and** their `?` definitions, export-CSV buttons, deltas note, footer honesty note, locale-aware numbers/percents/durations. Advertising "Unavailable" translated; honesty definitions translated. |
| Breadcrumbs | Chevron separator flips in RTL (`rtl:rotate-180`). |

## Translated chrome, page bodies still English (honest gaps)

These pages get the translated sidebar/topbar/language selector, but their own
content strings were **not** translated in this pass (other agents own some of these files):

- `/app/automations/**` (incl. workflow builder), `/app/campaigns/**`, `/app/follow-ups/**`,
  `/app/ai-assistant/**`, `/app/billing/**`, `/app/team/**`
- `/app/settings/**` — settings agent owns (has its own dictionary namespace already)
- `/app/integrations/**` — integrations agent owns (namespace exists)
- `/app/onboarding/**`, `/app/docs/**` — onboarding agent owns (namespaces/fragments exist)
- Public marketing pages (`/`, `/login` and `/signup` are done; landing/pricing/etc. via SEO agent + fragments)

## Intentionally not translated (by design)

- **Server/API-provided strings**: API error messages, notification titles/bodies,
  advertising `note` text, `previousPeriod.label` values, timeline `summary` text, saved
  segment names, contact/channel names, workspace names — these are data, not UI chrome.
- **Enum/status codes** rendered as badges (`OPEN`, `CONNECTED`, `NEEDS_ATTENTION`, …),
  channel slugs (`instagram`, `whatsapp`, …), lead stages — kept as canonical identifiers.
- **Mock-rewrite text transforms** in the inbox ("Hello", "Thank you", …): the mock
  itself only operates on English text; noted in the UI as a local transform.
- **Brand**: "FlowPilot AI" and the logo are never translated or mirrored.
- **Icons that must not flip**: logo mark, media/play-style icons, the notification bell,
  theme icons — no RTL transform applied. Directional icons (chevrons, back arrows,
  breadcrumb separators, sidebar collapse) flip via `rtl:rotate-180` / logical properties.

## RTL audit findings

- Sidebar: `border-r` → `border-e`; active pill `left-0`/`rounded-r-full` → `start-0`/`rounded-e-full`;
  collapse chevrons `rtl:rotate-180`. With `dir=rtl`, flex ordering mirrors automatically —
  sidebar docks right, content flows correctly.
- Topbar: search icon `start-3` + input `ps-9`/`pe-3`; dropdown panels `start-0`/`end-0`;
  action cluster `ms-auto`; unread badge `-end-1`; selected-workspace dot `ms-2`.
- Inbox: search `start-3`/`ps-9`; list buttons `text-start`; unread dot `-end-0.5`;
  message bubbles use `ltr:`/`rtl:` corner variants so the "tail" corner mirrors;
  back/profile chevrons flip; saved-reply buttons `text-start`.
- Contacts: search `start-3`/`ps-9`; table `text-start`; pagination chevrons flip;
  drawer `end-0` + `border-s`; timeline rail `border-s`/`ps-5`, dot `-start-[26px]`;
  import error list `ps-5`.
- No `[dir="rtl"]` overrides were needed in `globals.css` — logical utilities +
  `rtl:`/`ltr:` variants covered every case found. (Recharts charts themselves are
  canvas/SVG and were left as-is; axis labels are locale-formatted numbers.)

## Accessibility pass (files touched)

- **Keyboard**: Tabs component already roving-tabindex with arrow keys; drawer tabs given
  `role=tablist/tab` + `aria-selected`; modal keeps focus-on-open + Escape; dropdowns keep
  Escape/outside-click dismissal; all icon-only buttons have `aria-label`s (now translated).
- **Focus**: global `:focus-visible` 2px outline already in `globals.css` (violet, light-mode
  variant) — verified present, untouched.
- **Form validation**: `Input` renders errors with `role="alert"` + `aria-invalid` +
  `aria-describedby`; server errors on auth pages use `role="alert"`; added `role="alert"`
  to inbox conv/thread errors, contacts error banners, duplicate-warning and import errors.
- **Contrast**: primary actions use white text on the violet→cyan gradient; body text uses
  `var(--fp-text)` / `var(--fp-text-2)` tokens on dark `--fp-bg` — unchanged from the
  verified brand palette. Amber/red/green status badges keep their existing pairings.
- **Known limitation (deliberate, unchanged)**: the password show/hide toggle uses
  `tabIndex={-1}` (mouse-only convenience; the password field itself is fully keyboard
  operable). Language names are exposed in their own language ("EN"/"العربية") with a
  translated `role="group"` label.

## Verification

- `tsc --noEmit`: no errors in any file touched by this workstream. (Repo has errors in
  `src/i18n/fragments/*` and two API routes from other in-flight workstream agents —
  untouched here.)
- `vitest run`: all suites pass (see workstream report).
- Dictionaries: `ar` satisfies the `Dictionary` type — any missing key is a compile error.
- Live end-to-end check (cookie → reload → `<html lang="ar" dir="rtl">`, visual RTL mirror)
  still needs a real browser session; the full code path is wired and the render path is
  server-driven, but this environment cannot operate the live browser.
